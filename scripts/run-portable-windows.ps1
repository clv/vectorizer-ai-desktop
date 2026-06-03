[CmdletBinding()]
param(
    [switch] $Build
)

$ErrorActionPreference = "Stop"

if ($PSVersionTable.Platform -and $PSVersionTable.Platform -ne "Win32NT") {
    throw "run-portable-windows.ps1 must be run on Windows."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$version = $package.version
$portableExe = Join-Path $repoRoot "dist-portable\windows-x64\Vectorizer.AI Desktop\Vectorizer.AI Desktop.exe"
$rawExe = Join-Path $repoRoot "src-tauri\target\release\vectorizer-ai-desktop.exe"

if ($Build -or -not (Test-Path $portableExe)) {
    $skipBuild = Test-Path $rawExe
    $args = @()
    if ($skipBuild -and -not $Build) {
        $args += "-SkipBuild"
    }
    $args += "-Launch"
    & (Join-Path $PSScriptRoot "build-portable-windows.ps1") @args
    exit $LASTEXITCODE
}

Write-Host "Launching Vectorizer.AI Desktop $version portable build..."
Start-Process -FilePath $portableExe
