# 网易云音乐 for VS Code v0.3.84

对比上一个 GitHub 发布版本 **v0.3.83** 的修改。

## 登录

- 修复手机号登录、邮箱登录界面反复刷新、无法聚焦输入框的问题。
- 原因：登录弹窗打开后，二维码轮询每 2.5 秒返回一次状态，之前无论当前是哪个登录页都会重建整个弹窗。
- 现在：
  - 只有扫码页会因二维码状态重绘；
  - 切换到手机或邮箱登录时停止二维码轮询；
  - 关闭登录弹窗时停止轮询。
- 手机号、验证码、密码、邮箱输入框可以正常聚焦和输入。

## 版本记录

完整记录见 Release 附件 `VERSION_CHANGES.md`：

https://github.com/SuperTairitsuFan/Netease-Music-VScode/blob/main/VERSION_CHANGES.md

## 平台

```text
linux-x64
linux-arm64
win32-x64
win32-arm64
```

四个平台 VSIX 均已上传。
