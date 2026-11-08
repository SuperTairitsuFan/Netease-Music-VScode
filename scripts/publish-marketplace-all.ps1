param(
  [string]$TokenFile = (Join-Path $env:USERPROFILE ".vsce-token")
)

# Publish the current package version to the VS Code Marketplace for all
# architecture-specific VSIX files. The PAT is read from a local file and is
# never printed. Run this only after the user explicitly asks to publish.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$version = $pkg.version
$targets = @("win32-x64", "win32-arm64", "linux-x64", "linux-arm64")

if (-not (Test-Path $TokenFile)) {
  throw "Missing Marketplace PAT file: $TokenFile"
}

$pat = (Get-Content $TokenFile -Raw).Trim()
if (-not $pat) {
  throw "Marketplace PAT file is empty: $TokenFile"
}

$vsce = Join-Path $root "node_modules/@vscode/vsce/vsce"
if (-not (Test-Path $vsce)) {
  throw "vsce not installed. Run: npm install"
}

Push-Location $root
try {
  foreach ($target in $targets) {
    $vsix = Join-Path $root "dist-vsix/netease-music-vscode-$version-$target.vsix"
    if (-not (Test-Path $vsix)) {
      throw "Missing $vsix. Run: node scripts/package.mjs --all --skip-build"
    }
    Write-Host "[marketplace] publishing $version $target"
    & node $vsce publish --packagePath $vsix --target $target --pat $pat
    if ($LASTEXITCODE -ne 0) {
      throw "Marketplace publish failed for $target (exit $LASTEXITCODE)"
    }
  }
  Write-Host "[marketplace] published $($pkg.publisher).$($pkg.name)@$version for all targets."
} finally {
  Pop-Location
}
