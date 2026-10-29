<#
.SYNOPSIS
  Builds the EpubMaker desktop executable, and optionally the NSIS installer.

.DESCRIPTION
  One host, two platforms: this builds the Windows half of app/main.go, the
  same package build-android.ps1 cross-compiles into libwails.so.

  The Wails CLI is used for exactly one thing here — `wails3 generate syso`,
  which packs the icon, the manifest and the version resource into a .syso Go
  links in. The build itself is plain `go build`, because `wails3 build` drives
  a Taskfile through go-task, and go-task cannot run the shell wrappers this
  repo needs on Windows (the Android build has its own script for the same
  reason).

  Steps: web bundle -> app/frontend/dist -> version resource -> go build ->
  build/bin/EpubMaker.exe (+ optional NSIS installer).

.PARAMETER SkipFrontend
  Reuse app/frontend/dist instead of rebuilding web/ (~20s saved).

.PARAMETER Installer
  Also build the NSIS installer into build/bin.

.PARAMETER Dev
  Build without the `production` tag, so devtools stay enabled, and keep a
  console for the Go log. Used by dev-windows.ps1 — not for shipping.

.EXAMPLE
  .\build-windows.ps1
  .\build-windows.ps1 -Installer
  .\build-windows.ps1 -SkipFrontend -Dev
#>
[CmdletBinding()]
param(
  [switch]$SkipFrontend,
  [switch]$Installer,
  [switch]$Dev
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$AppDir = $PSScriptRoot
$RepoDir = Split-Path $AppDir -Parent
$WebDir = Join-Path $RepoDir 'web'
$BinDir = Join-Path $AppDir 'build\bin'
$ExeName = 'EpubMaker.exe'
$Arch = 'amd64'
$Tag = if ($Dev) { 'dev' } else { 'release' }

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor DarkGray }

function Resolve-Tool([string]$name, [string]$fallback, [string]$hint) {
  $found = Get-Command $name -ErrorAction SilentlyContinue
  if ($found) { return $found.Source }
  if ($fallback -and (Test-Path $fallback)) { return $fallback }
  throw "$name not found. $hint"
}

# The version lives in build/config.yml — the same file the Android build and
# `wails3 android overlay:gen` read. Only the quoted `version:` key under
# `info:` counts; the unquoted `version: '3'` at the top is the schema version,
# and the lines under `ios:` are commented out.
function Get-ProductVersion {
  $config = Join-Path $AppDir 'build\config.yml'
  $match = Get-Content $config | Select-String -Pattern '^\s+version:\s*"([^"]+)"' |
    Select-Object -First 1
  if (-not $match) { throw "no quoted info.version in $config" }
  return $match.Matches.Groups[1].Value
}

$GoExe = Resolve-Tool 'go' 'D:\Program Files\Go\bin\go.exe' 'Install Go 1.21+ from https://go.dev/dl'
$Wails3 = Resolve-Tool 'wails3' 'E:\go\bin\wails3.exe' 'go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.34'
$Version = Get-ProductVersion

Write-Host "EpubMaker desktop build ($Tag)" -ForegroundColor White
Write-Ok "version   $Version"

# --------------------------------------------------------------- frontend ---
if (-not $SkipFrontend) {
  Write-Step 'Building the web bundle'
  Push-Location $WebDir
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
    # Mirrors dist/ into app/frontend/dist (and prunes stale hashed chunks).
    # go:embed cannot reach outside the package directory.
    & node ../scripts/sync-frontend-dist.js
    if ($LASTEXITCODE -ne 0) { throw 'sync-frontend-dist failed' }
  } finally { Pop-Location }
} elseif (-not (Test-Path (Join-Path $AppDir 'frontend\dist\index.html'))) {
  throw 'app/frontend/dist is missing; run without -SkipFrontend first.'
}

# ------------------------------------------------------- version resource ---
# info.json is a template: the Wails tools fill {{.Info.*}} from the project
# config. Rendering it here keeps build/config.yml the only place a version
# number is written.
Write-Step 'Rendering the Windows version resource'
$infoTemplate = Get-Content (Join-Path $AppDir 'build\windows\info.json') -Raw
$infoFields = @{
  '{{.Info.ProductVersion}}' = $Version
  '{{.Info.CompanyName}}'    = 'EpubMaker'
  '{{.Info.ProductName}}'    = 'EpubMaker'
  '{{.Info.Copyright}}'      = 'Copyright (c) 2026 john'
  '{{.Info.Comments}}'       = 'EPUB ebook editor and reader (local desktop app)'
}
$infoJson = $infoTemplate
foreach ($key in $infoFields.Keys) { $infoJson = $infoJson.Replace($key, $infoFields[$key]) }

$infoPath = Join-Path $AppDir 'build\windows\info.rendered.json'
# No BOM: the syso generator unmarshals this file as JSON.
[System.IO.File]::WriteAllText($infoPath, $infoJson, (New-Object System.Text.UTF8Encoding $false))

$syso = Join-Path $AppDir "wails_windows_$Arch.syso"
& $Wails3 generate syso -arch $Arch `
  -icon (Join-Path $AppDir 'build\windows\icon.ico') `
  -manifest (Join-Path $AppDir 'build\windows\wails.exe.manifest') `
  -info $infoPath -out $syso
if ($LASTEXITCODE -ne 0) { throw 'wails3 generate syso failed' }

# ------------------------------------------------------------------- Go ----
Write-Step "Compiling $ExeName"
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
$out = Join-Path $BinDir $ExeName

# The About page shows the version and when this binary was linked. Both come
# from here so they cannot drift from build/config.yml; unix seconds keep the
# -X flag free of spaces and quoting hazards.
$buildUnix = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$ldflags = "-X epubmaker-desktop/internal/app.AppVersion=$Version -X epubmaker-desktop/internal/app.BuildTimeUnix=$buildUnix"
if (-not $Dev) {
  # -H windowsgui: no console window behind the app.
  $ldflags = "-w -s -H windowsgui $ldflags"
}
$goArgs = @('build', '-trimpath', '-buildvcs=false')
if (-not $Dev) {
  # `production` is what disables the WebView devtools (see wails v3's
  # application_production.go); a dev build keeps them.
  $goArgs += @('-tags', 'production')
}
$goArgs += @('-ldflags', $ldflags, '-o', $out, '.')

Push-Location $AppDir
try {
  & $GoExe @goArgs
  if ($LASTEXITCODE -ne 0) { throw 'go build failed' }
} finally {
  Pop-Location
  # A stale .syso would be linked into the next build with this build's icon
  # and version; the Wails task removes it for the same reason.
  Remove-Item $syso -ErrorAction SilentlyContinue
}

$exeSize = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host "`nEXE: $out (${exeSize} MB)" -ForegroundColor Green

# ------------------------------------------------------------- installer ---
if ($Installer) {
  Write-Step 'Building the NSIS installer'
  $Makensis = Resolve-Tool 'makensis' 'C:\Program Files (x86)\NSIS\makensis.exe' `
    'Install NSIS from https://nsis.sourceforge.io'

  # wails_tools.nsh fills every INFO_* it does not receive, and its fallbacks
  # are stale (they were generated once, by the v2 CLI). Passing the version on
  # the command line is what keeps the installer in step with build/config.yml.
  Push-Location (Join-Path $AppDir 'build\windows\installer')
  try {
    # makensis writes progress to stderr; under 'Stop' that reads as a failure.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & $Makensis -V2 "-DARG_WAILS_AMD64_BINARY=$out" "-DINFO_PRODUCTVERSION=$Version" project.nsi
    } finally {
      $ErrorActionPreference = $previous
    }
    if ($LASTEXITCODE -ne 0) { throw 'makensis failed' }
  } finally { Pop-Location }

  # Not $installer: PowerShell variable names are case-insensitive, so that
  # would be the [switch]$Installer parameter (string -> SwitchParameter).
  $installerPath = Join-Path $BinDir "EpubMaker-$Arch-installer.exe"
  if (Test-Path $installerPath) {
    Write-Host "Installer: $installerPath" -ForegroundColor Green
  } else {
    throw "installer not produced (expected $installerPath)"
  }
}
