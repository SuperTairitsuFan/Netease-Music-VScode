# 网易云音乐 for VS Code v0.3.83

对比上一个 GitHub 发布版本 **v0.3.82** 的修改。

## 进度条

- 原生流式播放进度改为使用**设备实际已播放帧数**，不再使用解码缓冲帧数。
- 修复一开始播放进度条就显示约 12 秒的问题。
- 原因：ASIO 环形缓冲为 `1,048,576` samples，在 `44.1 kHz / 2 声道` 下约等于 `11.9 秒`；之前上报的是解码帧，解码会提前填满缓冲。
- 修复后进度、剩余时间和切歌判断都以实际播放位置为准。

## 快捷键

- 本地快捷键在网易云音乐侧边栏聚焦时也生效。
- 主界面和侧边栏均支持：

```text
Alt+Shift+P       播放/暂停
Alt+Shift+Left    上一首
Alt+Shift+Right   下一首
Alt+Shift+Up      音量加
Alt+Shift+Down    音量减
Alt+Shift+L       喜欢歌曲
```

- 全局快捷键仍为 `Ctrl+Alt+Shift+...`。
- 最小化窗口快捷键保持删除。

## 版本记录文档

完整版本修改记录已作为 Release 附件上传：

- `VERSION_CHANGES.md`
- 仓库地址：https://github.com/SuperTairitsuFan/Netease-Music-VScode/blob/main/VERSION_CHANGES.md

## 平台

```text
linux-x64
linux-arm64
win32-x64
win32-arm64
```

四个平台 VSIX 均已上传。
