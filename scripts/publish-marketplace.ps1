# Publish the current Windows x64 VSIX to the VS Code Marketplace.
# The PAT is read from %USERPROFILE%\.vsce-token and is never printed.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$version = $pkg.version
$vsix = Join-Path $root "dist-vsix/netease-music-$version-win32-x64.vsix"
$tokenFile = Join-Path $env:USERPROFILE ".vsce-token"

if (-not (Test-Path $vsix)) {
  throw "Missing $vsix. Run: node scripts/package.mjs win32-x64 --skip-build"
}
if (-not (Test-Path $tokenFile)) {
  throw "Missing $tokenFile. Create a Marketplace PAT and save it there."
}

$pat = (Get-Content $tokenFile -Raw).Trim()
if (-not $pat) {
  throw "The Marketplace PAT file is empty."
}

Push-Location $root
try {
  npx vsce publish --packagePath $vsix --target win32-x64 --pat $pat
  if ($LASTEXITCODE -ne 0) { throw "vsce publish failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}
