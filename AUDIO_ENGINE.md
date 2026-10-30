# 原生音频引擎技术说明

本文只说明音频链路与底层实现，不涉及 UI。对应版本：0.3.38。

## 1. 总体链路

```text
EAPI 取歌 → 缓存为本地文件
  ├─ WebAudio：Webview <audio> 直接流式播放
  └─ Native：native-audio-output.exe
        ├─ WASAPI（Shared / Exclusive / 事件驱动）
        ├─ ASIO（TOPPING/Thesycon COM 驱动）
        └─ 流式解码（dr_flac / dr_mp3）或 Webview 解码后 PCM 送入
```

宿主不直接接触音频设备；设备操作全部在独立原生进程内，进程通过 stdin/stdout 的二进制帧协议通信。

## 2. 原生进程协议

帧格式：

```text
1 字节 type + 4 字节小端长度 + payload
type 1 = JSON control
type 2 = float32 PCM
type 3 = end
type 4 = 整数 PCM（s16/s24/s32）
```

事件以 JSON 行输出：`ready`、`configured`、`started`、`progress`、`drained`、`error`。

## 3. WASAPI 独占

### 3.1 格式协商

独占模式不做静默降级：

```c
IAudioClient_IsFormatSupported(EXCLUSIVE, &wfx, &closest);
```

只有返回 `S_OK` 才 `Initialize`。失败时把设备支持格式列表回传宿主，便于选择正确采样率/位深。

### 3.2 0x8889000a 的真实含义

`AUDCLNT_E_UNSUPPORTED_FORMAT`。设备宣称支持 192k/32，只代表独占能力；共享混音器并不接受该格式。

实测 TOPPING USB DAC：

```text
48000 / 16 / Shared        OK
48000 / 32 / Shared        0x8889000a
192000 / 32 / Shared       0x8889000a
192000 / 32 / Exclusive    OK
```

因此策略是：

- `> 48 kHz` 强制 Exclusive；
- Shared 固定 16-bit s16le，避免共享混音器拒绝 32-bit WAVEFORMATEXTENSIBLE。

### 3.3 事件驱动

独占模式使用：

```c
AUDCLNT_STREAMFLAGS_EVENTCALLBACK
IAudioClient_SetEventHandle
WaitForSingleObject
```

缓冲满时等待事件，而不是 1ms 轮询，降低 underrun。

共享模式不使用事件回调：`AUTOCONVERTPCM + EVENTCALLBACK` 在部分设备上初始化失败。

### 3.4 MMCSS

WASAPI 渲染线程注册为 Pro Audio：

```c
AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
AvSetMmThreadPriority(handle, AVRT_PRIORITY_CRITICAL);
```

整数直写路径在首次写入时同样注册，避免系统调度造成周期性爆音。

### 3.5 缓冲

- 独占缓冲按用户设置（最低 40ms，推荐 80–100ms）；
- 设备返回的 `bufferFrames` 可能远大于请求值（192k 下曾出现 122880 帧）；
- 写入必须按 `GetCurrentPadding` 计算空闲帧，不能假设缓冲大小。

## 4. ASIO

### 4.1 为什么普通 ASIO 方式不行

TOPPING 的 `toppingusbaudioasio_x64.dll` 只导出：

```text
DllGetClassObject
DllCanUnloadNow
DllRegisterServer
DllUnregisterServer
```

没有 `ASIOInit` 等导出函数，必须走 COM。

### 4.2 COM 约定

关键点：

1. 必须 STA 线程 `CoInitializeEx(COINIT_APARTMENTTHREADED)`；
2. **CLSID 同时作为接口 IID**：

```c
CoCreateInstance(&clsid, NULL, CLSCTX_INPROC_SERVER, &clsid, &obj);
```

3. 返回对象 vtable 第 3 项才是 `init()`。

### 4.3 独立 STA 消息泵线程

ASIO 回调依赖该 STA 线程的消息循环。引擎主线程会阻塞在读 stdin，因此：

- 创建独立线程完成 `CoInitialize`、`CoCreateInstance`、`init`、`createBuffers`；
- 线程循环 `PeekMessage / DispatchMessage / WaitMessage`；
- `ASIOStart/Stop`、`outputReady` 都通过 `PostThreadMessage` 交给该线程执行；
- 引擎线程只负责向环形缓冲写入。

### 4.4 缓冲区类型

按驱动 `getChannelInfo` 返回的真实类型写入：

```text
ASIOSTInt16LSB / Int24LSB / Int32LSB / Float32LSB
```

TOPPING 返回 18（Int32LSB），因此内部统一用 int32 环形缓冲，16-bit 源左移 16 位，24-bit 源左移 8 位。

### 4.5 交织数据必须按帧分发

ASIO 每个声道有独立缓冲，而环形缓冲是交织的 `[L0,R0,L1,R1,...]`。

错误写法：

```text
左声道 ← 连续取 2048 个交织样本
右声道 ← 再连续取 2048 个
```

会把左右声道按时间拼接，产生“声音变粗/怪声/规律底噪”。

正确写法：

```text
for each frame:
  for each channel:
    value = ring.pop()
    channelBuffer[i] = value
```

### 4.6 软暂停

暂停时不调用 `ASIOStop`。停止驱动会导致 Webview 继续送 PCM、环形缓冲写满、stdin 背压、最终 PCM 超时。

软暂停：

- 驱动继续运行；
- 清空环形缓冲；
- 回调输出静音；
- Webview 发送循环同时暂停。

## 5. Bit-perfect 整数 PCM

### 5.1 量化

Webview 侧按源位深输出：

```text
s16：round(v * 32767)
s24：round(v * 8388607) << 8   // 32 位容器，左对齐
s32：round(v * 2147483647)
```

原生侧使用 `PCM_INT` 帧直接写设备，不再经过 float 转换。

### 5.2 16/32 位错位的教训

曾出现“持续白噪声”：宿主请求丢失了整数标记，Webview 按 16-bit 发送，而 ASIO 按 32-bit 解释，导致采样错位。

修复：

- 请求显式携带 `integerPcm` 与 `sourceBits`；
- ASIO 统一使用 32-bit 容器；
- 原生 `PCM_INT` 的字节宽度必须与 `engine.format.bits` 一致。

### 5.3 音量

Bit-perfect 下音量固定 100%，不做软件增益；音量由 DAC 物理旋钮控制。

## 6. 流式解码

### 6.1 为什么需要

Webview 的 `decodeAudioData` 必须拿到完整文件才能解码，192k FLAC 首播会等待整首解码。

### 6.2 原生模式

```text
native-audio-output.exe --play-file <path> --start-ms <ms> --backend asio
```

使用 dr_flac / dr_mp3 逐帧解码：

- FLAC：`drflac_read_pcm_frames_s32`，24-bit 左对齐；
- MP3：`drmp3_read_pcm_frames_f32` 后量化为 int32；
- 每 4096 帧写入后端；
- 每 120ms 输出 `progress`；
- EOF 后 `drain` 并输出 `drained`。

### 6.3 宿主

```text
ensureAudioFile() → 本地路径
→ NativeEngineSession.startFile()
→ progress / drained 驱动 UI 与自动下一首
```

失败时回退旧的 Webview 解码路径。

### 6.4 暂停与 seek

流式模式下暂停是停止流，恢复时从当前位置用 `--start-ms` 重新打开；seek 同理。代价是几十毫秒重启，但避免了驱动状态机复杂度。

## 7. 故障与修复记录

### 7.1 原生 PCM 写入超时

现象：`PCM 数据写入超时`，随后回退 WebAudio。

原因与修复：

- 暂停时 `ASIOStop` 但 Webview 继续发送 → 软暂停；
- 切歌时新旧会话并发 → `nativeBegin` 串行化 + 过期 token 丢弃；
- 旧进程未释放驱动 → dispose 等待子进程真正退出；
- ASIOStart 失败 → 自动重试并回退 WASAPI 后端；
- stdin 背压 → `writeWithBackpressure` 监听 drain，8 秒超时。

### 7.2 打点计时器式断续

WASAPI 轮询等待 + 看门狗误重启原生会话。修复：

- 事件驱动；
- 原生播放不计入 WebAudio 看门狗；
- 提高缓冲，禁止 5ms 级缓冲。

### 7.3 声音变粗 / 规律底噪

ASIO 交织数据按声道连续读取。修复为按帧分发（见 4.5）。

### 7.4 自动播放被浏览器拦截

Webview 音频元素必须由用户手势启动。原生路径不受影响；回退 WebAudio 时由主界面 Webview 持有音频元素。

### 7.5 采样率不一致

原生引擎不做重采样。Bit-perfect 时强制使用音源采样率；手动设置不一致会明确报错，而不是静默变调。

## 8. 诊断

日志终端会输出：

```text
native configure { backend, device, rate, bits, sampleFormat, exclusive, bufferMs, volume }
native stderr [asio] rate asked ..., driver reports ...
native stderr [asio] sample type ..., buffer ... frames
native stderr [asio] first buffer ch0: ... ch1: ...
native stderr [asio] underrun frames=N
native pcm int { seq, bytes, bits, frames }
```

`first buffer` 的十六进制可直接判断采样格式、字节序与声道交织是否正确。

## 9. 已知限制

- ASIO 驱动同一时间只能被一个进程占用；
- 流式模式 seek/暂停通过重启实现，不是采样级无缝；
- DSD 未实现；
- 32-bit 源在 Webview 解码路径中会经过 float32，流式路径不受影响；
- ASIO COM 驱动行为依赖厂商实现，代码已按 Thesycon 常见约定处理。
