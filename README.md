# 网易云音乐 for VS Code（非官方）

> **个人做着玩玩的项目。**
>
> 这不是网易云音乐官方产品，和网易云音乐及其关联公司没有隶属、授权或合作关系。
>
> 如果官方下场、提出异议，或要求停止分发，我会立即下架相关项目文档、GitHub 仓库、Release 和 Marketplace 插件，不继续分发。

在 VS Code 里做一个桌面客户端形态的网易云音乐：侧边栏管理歌单，编辑器区浏览歌曲、歌手、专辑、评论，底部状态条控制播放。数据通过 EAPI 获取，可选 Windows WASAPI / ASIO / Linux ALSA 原生音频输出。

项目只用于个人学习、折腾和自用，不商用，不提供、不托管任何音乐内容。

- [原生音频技术文档](AUDIO_ENGINE.md)
- [免责声明](DISCLAIMER.md)
- [合规与下架机制](COMPLIANCE.md)

## 当前版本

```text
1.0.83
```

作为第一版公开构建发布。

当前主要能力：

- 推荐、每日推荐、歌单、歌手、专辑、搜索、排行榜、播客、本地音乐、云盘
- 歌曲详情、评论、回复、点赞、收藏到歌单
- 原生 WASAPI Shared / Exclusive、ASIO、Linux ALSA
- 1–8 声道源文件按实际声道输出；设备通道不足时明确报错
- 沉浸环绕声（5.1）音质选项
- 双声道 HRTF 空间增强；与 Bit-perfect 互斥
- 沉浸歌词、桌面歌词悬浮窗
- 缓存、下载、封面、播放队列、最近播放
- 首次启动免责声明确认

## 界面

- PC 风 Activity Bar 侧边栏
- 歌曲详细页：左侧封面/功能、中间歌词、右侧评论，三块半透明毛玻璃悬浮窗
- 评论悬浮窗默认常驻，输入框固定
- 沉浸歌词：封面高斯模糊背景、全页歌词、跟随换歌、Esc 返回
- 深色 / 浅色主题跟随 VS Code
- 状态栏播放控制、队列、设置

## 安装

### VS Code Marketplace

在扩展面板搜索 **网易云音乐 for VS Code（非官方）**，选择发布者 `AICis`。

```text
vscode:extension/AICis.netease-music-vscode
```

### VSIX

从 [GitHub Releases](https://github.com/SuperTairitsuFan/Netease-Music-VScode/releases) 下载对应平台：

```text
win32-x64
win32-arm64
linux-x64
linux-arm64
```

安装示例：

```bash
code --install-extension netease-music-vscode-1.0.83-win32-x64.vsix
```

## 首次启动

首次使用会先显示免责声明：

- 同意并继续：才会创建扩展、登录和发起网络请求
- 不同意：扩展不会启动，不进行登录或网络请求

同意状态按声明版本保存在 VS Code `globalState`。

## 音频

- Windows：WASAPI Shared / Exclusive、ASIO
- Linux：ALSA
- WebAudio：默认兼容路径
- 原生输出按源文件声道数打开；设备输出通道不足时拒绝静默降混
- 多声道设备可原样输出；双声道设备可开启 HRTF 下混
- Bit-perfect 固定 100% 软件音量，开启时会提示调整前端音量
- HRTF 与 Bit-perfect 互斥

沉浸环绕声是 5.1 多声道内容：

```text
多声道 DAC / 功放：原样输出
双声道 DAC：需要开启 HRTF 下混
WebAudio：不能原样输出 5.1
```

## 使用

1. 点击 Activity Bar 的音乐图标打开侧边栏。
2. 登录：扫码、手机验证码、手机密码或邮箱密码。
3. 浏览歌单、歌手、搜索。
4. 底栏控制播放；点击歌名打开歌曲详情。
5. 设置：状态栏齿轮，或命令面板 `网易云音乐: 打开设置`。
6. 详细页左侧“沉浸歌词”进入全屏歌词。

## 从源码构建

要求 Node.js ≥ 20、npm。构建原生组件还需要 [zig](https://ziglang.org/) 0.15.x。

```bash
npm install
npm run typecheck
npm run build
npm test
```

打包：

```bash
node scripts/package.mjs --all --skip-build
```

产物位于 `dist-vsix/`。

## 数据与隐私

- 登录 Cookie 保存在 VS Code SecretStorage。
- 不向第三方服务器发送账号信息。
- 播放、搜索、评论请求直接发往网易云音乐接口。
- 本项目不包含音源、歌词、封面或评论数据。
- 缓存和下载只写入用户本机，由用户自己的账号权限决定。
- 首次启动必须同意免责声明，否则不会启动登录或网络请求。

## 版权与下架

- 音乐、歌词、封面、评论版权归网易云音乐及相应权利人所有。
- 请使用本人合法账号与会员权限，遵守网易云音乐用户协议和当地法律。
- 本项目不实现绕过付费、会员、地区限制或 DRM 的功能。
- 若权利人提出可核实的异议，会立即停止分发并下架相关文档、仓库、Release 和插件。
- 下架流程见 [COMPLIANCE.md](COMPLIANCE.md)。

## 反馈

- Issues: https://github.com/SuperTairitsuFan/Netease-Music-VScode/issues
- 仓库: https://github.com/SuperTairitsuFan/Netease-Music-VScode

## License

MIT
