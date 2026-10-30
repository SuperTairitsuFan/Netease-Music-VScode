# 发布说明

## GitHub

仓库：https://github.com/SuperTairitsuFan/Netease-Music-VScode

### 使用 GitHub CLI（推荐）

```powershell
$gh = "C:\Program Files\GitHub CLI\gh.exe"
& $gh auth login --hostname github.com --git-protocol https --web
$env:GITHUB_TOKEN = & $gh auth token
node scripts/publish-github.mjs
```

`scripts/publish-github.mjs` 会：

- 创建或复用仓库；
- 上传源码（忽略 `node_modules`、`dist`、`components`、`tmp` 等）；
- 创建 `v0.3.11` Release；
- 上传 `dist-vsix/netease-music-0.3.11-win32-x64.vsix`。

### 自定义

```powershell
$env:GITHUB_REPO = "Netease-Music-VScode"
$env:GITHUB_VISIBILITY = "public"
$env:GITHUB_DESCRIPTION = "网易云音乐 for VS Code"
node scripts/publish-github.mjs
```

## VS Code Marketplace

### 1. 创建 Publisher

打开 <https://marketplace.visualstudio.com/manage>，使用 Microsoft 账号登录，创建 Publisher：

- Publisher ID：`AICis`
- Display name：`网易云音乐 for VScode`

### 2. 创建 PAT

在 Marketplace 管理页右上角用户设置中创建 Personal Access Token：

- Organization：选择你的 Azure DevOps 组织
- Scopes：**Marketplace → Manage**
- 复制 Token

把 Token 保存到：

```text
C:\Users\Administrator\.vsce-token
```

不要发到聊天中。

### 3. 发布

```powershell
$env:VSCE_PAT = (Get-Content "$env:USERPROFILE\.vsce-token" -Raw).Trim()
npx vsce publish --packagePath dist-vsix/netease-music-0.3.11-win32-x64.vsix --pat $env:VSCE_PAT
```

如果提示 publisher 不存在，先在管理页创建 `AICis`。

### 4. 后续更新

1. 修改 `package.json` 的 `version`，例如 `0.3.11`；
2. 更新 `CHANGELOG.md`；
3. 重新构建和打包：

```powershell
npm run typecheck
npm run build
node scripts/package.mjs win32-x64 --skip-build
```

4. 发布 GitHub Release 和 Marketplace：

```powershell
$env:GITHUB_TOKEN = & "C:\Program Files\GitHub CLI\gh.exe" auth token
node scripts/publish-github.mjs

$env:VSCE_PAT = (Get-Content "$env:USERPROFILE\.vsce-token" -Raw).Trim()
npx vsce publish --packagePath dist-vsix/netease-music-0.3.11-win32-x64.vsix --pat $env:VSCE_PAT
```

Marketplace 会自动把新版本推送给已安装用户；VS Code 会按扩展市场版本提示更新。
