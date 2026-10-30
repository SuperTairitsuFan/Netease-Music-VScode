param(
  [Parameter(Mandatory = $true)]
  [string]$Version
)

# One-command release:
#   1. bump package.json + package-lock.json
#   2. typecheck / test / build / package Windows x64 VSIX
#   3. push source + GitHub release
#   4. publish the same VSIX to the VS Code Marketplace (if PAT exists)
#
# Usage:
#   .\scripts\release.ps1 0.3.11

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

npm version $Version --no-git-tag-version
if ($LASTEXITCODE -ne 0) { throw "npm version failed" }

npm run typecheck
if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }

npm test
if ($LASTEXITCODE -ne 0) { throw "tests failed" }

npm run build
if ($LASTEXITCODE -ne 0) { throw "build failed" }

node scripts/package.mjs win32-x64 --skip-build
if ($LASTEXITCODE -ne 0) { throw "packaging failed" }

$gh = "C:\Program Files\GitHub CLI\gh.exe"
if (-not (Test-Path $gh)) { throw "GitHub CLI not found at $gh" }

$pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
$env:GITHUB_REPO = "Netease-Music-VScode"
$env:GITHUB_VISIBILITY = "public"
$env:GITHUB_DESCRIPTION = "网易云音乐 for VS Code：EAPI 直连、PC 风侧边栏、歌单/歌手/搜索/评论与原生音频输出"
$env:GITHUB_TOKEN = (& $gh auth token).Trim()
node scripts/publish-github.mjs
if ($LASTEXITCODE -ne 0) { throw "GitHub publish failed" }

$tokenFile = Join-Path $env:USERPROFILE ".vsce-token"
if (Test-Path $tokenFile) {
  $pat = (Get-Content $tokenFile -Raw).Trim()
  if ($pat) {
    $vsix = Join-Path $root "dist-vsix/netease-music-$($pkg.version)-win32-x64.vsix"
    npx vsce publish --packagePath $vsix --target win32-x64 --pat $pat
    if ($LASTEXITCODE -ne 0) { throw "Marketplace publish failed" }
  }
}

Write-Host "Release v$($pkg.version) complete."
