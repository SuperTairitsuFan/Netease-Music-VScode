# 网易云音乐 for VS Code v0.3.77

对比上一个 GitHub 发布版本 **v0.3.76** 的修改。

## 快捷键冲突

- 0.3.76 的默认本地快捷键包含 `Alt+Shift+Left / Right`，会与 VS Code 编辑器的“扩展/收缩选择”冲突。
- 0.3.77 给本地快捷键加上生效条件：

```text
activeWebviewPanelId == 'neteaseMusic.main'
```

- 即本地快捷键只在网易云音乐主界面获得焦点时生效。
- 在编辑器里按 `Alt+Shift+方向键` 恢复为 VS Code 原本行为。
- 全局快捷键仍使用 `Ctrl+Alt+Shift+...`，不限制焦点。

## 默认快捷键

```text
功能          本地（播放器聚焦）   全局
播放/暂停      Alt+Shift+P         Ctrl+Alt+Shift+P
上一首         Alt+Shift+Left      Ctrl+Alt+Shift+Left
下一首         Alt+Shift+Right     Ctrl+Alt+Shift+Right
音量加         Alt+Shift+Up        Ctrl+Alt+Shift+Up
音量减         Alt+Shift+Down      Ctrl+Alt+Shift+Down
最小化窗口     Alt+Shift+M         Ctrl+Alt+Shift+M
喜欢歌曲       Alt+Shift+L         Ctrl+Alt+Shift+L
```

## 其他

- 保留 0.3.76 的音量弹窗修复、账号目录直接调用系统文件管理器、快捷键按键捕获、恢复默认快捷键。
- 平台：linux-x64 / linux-arm64 / win32-x64 / win32-arm64。
