[CmdletBinding()]
param(
    [switch] $SkipBuild,
    [switch] $Launch
)

$ErrorActionPreference = "Stop"

if ($PSVersionTable.Platform -and $PSVersionTable.Platform -ne "Win32NT") {
    throw "build-portable-windows.ps1 must be run on Windows."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) {
    $env:PATH = "$cargoBin;$env:PATH"
}

Set-Location $repoRoot

$package = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$version = $package.version
$releaseDir = Join-Path $repoRoot "src-tauri\target\release"
$sourceExe = Join-Path $releaseDir "vectorizer-ai-desktop.exe"

if (-not $SkipBuild) {
    & npm.cmd run tauri -- build --no-bundle
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

if (-not (Test-Path $sourceExe)) {
    throw "Portable executable was not found at $sourceExe. Run this script without -SkipBuild first."
}

$portableRoot = Join-Path $repoRoot "dist-portable"
$portableDir = Join-Path $portableRoot "windows-x64\Vectorizer.AI Desktop"
$portableExe = Join-Path $portableDir "Vectorizer.AI Desktop.exe"
$zipPath = Join-Path $portableRoot "Vectorizer.AI.Desktop_$($version)_windows-x64-portable.zip"

if (Test-Path $portableDir) {
    Remove-Item -LiteralPath $portableDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $portableDir | Out-Null

Copy-Item -LiteralPath $sourceExe -Destination $portableExe -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination (Join-Path $portableDir "LICENSE.txt") -Force

$readme = @"
Vectorizer.AI Desktop $version portable build

Run "Vectorizer.AI Desktop.exe" directly. No installer is required.

Notes:
- This build still uses the operating system credential store if you enable API Secret saving.
- Settings are stored in the normal Vectorizer.AI Desktop application config directory.
- On Windows, the Microsoft Edge WebView2 runtime must be available. Current Windows 10/11 systems usually include it already.
- This preview build is unsigned, so Windows may show a SmartScreen warning.
"@

Set-Content -LiteralPath (Join-Path $portableDir "README.txt") -Value $readme -Encoding UTF8

if (Test-Path $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path $portableDir "*") -DestinationPath $zipPath -Force

Write-Host "Portable folder: $portableDir"
Write-Host "Portable ZIP:    $zipPath"

if ($Launch) {
    Start-Process -FilePath $portableExe
}
