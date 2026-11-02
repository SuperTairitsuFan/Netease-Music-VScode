# 网易云音乐 for VS Code v0.3.76

对比上一个 GitHub 发布版本 **v0.3.75** 的修改。

## 音量弹窗

- 修复音量弹窗拉伸成巨大圆角框。
- 原因是旧 CSS 同时设置了 `left` 和 `right`，弹窗被横向拉满。
- 现在恢复为紧凑的竖向音量条，固定靠右。

## 账号资源目录

- “打开目录”改为直接调用系统文件管理器：
  - Windows：`explorer.exe`
  - macOS：`open`
  - Linux：`xdg-open`
- 不再依赖 `vscode.env.openExternal`，避免 `Failed to open: 0x2`。
- 每次点击实时读取当前设置目录，不再使用旧路径。
- 打开前自动创建不存在的目录。

## 快捷键

- 快捷键输入改为**按键捕获**：
  - 点击输入框后直接按组合键；
  - 不再需要手动输入 `Ctrl+P` 这种文本；
  - Backspace / Delete 清空。
- 默认快捷键改为不易与 VS Code 冲突的组合：

```text
播放/暂停       Alt+Shift+P        Ctrl+Alt+Shift+P
上一首          Alt+Shift+Left     Ctrl+Alt+Shift+Left
下一首          Alt+Shift+Right    Ctrl+Alt+Shift+Right
音量加          Alt+Shift+Up       Ctrl+Alt+Shift+Up
音量减          Alt+Shift+Down     Ctrl+Alt+Shift+Down
最小化窗口      Alt+Shift+M        Ctrl+Alt+Shift+M
喜欢歌曲        Alt+Shift+L        Ctrl+Alt+Shift+L
```

- 修改后立即写入用户 `keybindings.json`，无需重启。
- 新增“恢复默认快捷键”按钮。
- “最小化窗口”快捷键会放大/最大化 VS Code 窗口。

## 平台

```text
linux-x64
linux-arm64
win32-x64
win32-arm64
```
