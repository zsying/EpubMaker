<#
.SYNOPSIS
  EpubMaker task runner — the single entry point for build / dev / clean.

.DESCRIPTION
  Wraps the npm scripts and the Wails CLI so you rarely need to remember which
  directory each command lives in.

  Modes:
    help      Show this help (default when no mode is given).
    clean     Remove build artifacts (web/dist, app/frontend/dist, app/build/bin).
    build     Production build of the desktop exe (runs the frontend build first).
    nsis      Production build + Windows NSIS installer.
    dev       Desktop dev loop: vite watcher + Go rebuild + window hot reload.
    web       Frontend only (vite on :7800). No Go backend, no window.go binding.
    install   Install workspace dependencies.
    test      Type-check the frontend, then vet + test the Go backend.

.EXAMPLE
  .\run.ps1                 # same as .\run.ps1 help
  .\run.ps1 dev
  .\run.ps1 build -Verbose
  .\run.ps1 clean

.NOTES
  Short flags: h/c/b/d/w/t/i. Long flags: --help/--clean/--build/--dev/...
  Exit codes: 0 success, 1 failure or unknown mode.
#>

Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---------------------------------------------------------------- helpers ---

function Write-Step {
  param([string]$Message)
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Note {
  param([string]$Message)
  Write-Host "    $Message" -ForegroundColor DarkGray
}

function Write-Warn {
  param([string]$Message)
  Write-Host "!   $Message" -ForegroundColor Yellow
}

function Write-Fail {
  param([string]$Message)
  Write-Host "x   $Message" -ForegroundColor Red
}

function Test-Tool {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Hint
  )
  if (Get-Command $Name -ErrorAction SilentlyContinue) { return $true }
  Write-Fail "required tool not found on PATH: $Name"
  Write-Note $Hint
  return $false
}

# Runs a native command and fails loudly on a non-zero exit code. PowerShell
# does not stop on native failures by default, so every call site must check.
function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [string[]]$Arguments = @(),
    [switch]$IgnoreExitCode
  )
  Write-Step "$File $($Arguments -join ' ')"
  & $File @Arguments
  if (-not $IgnoreExitCode -and $LASTEXITCODE -ne 0) {
    throw "$File exited with code $LASTEXITCODE"
  }
}

function Assert-Prereqs {
  param([string[]]$Tools)
  foreach ($tool in $Tools) {
    switch ($tool) {
      'node' {
        if (-not (Test-Tool 'node' 'Install Node.js 20+ from https://nodejs.org')) { return $false }
      }
      'npm' {
        if (-not (Test-Tool 'npm' 'npm ships with Node.js')) { return $false }
      }
      'go' {
        if (-not (Test-Tool 'go' 'Install Go 1.21+ from https://go.dev/dl')) { return $false }
      }
      'wails' {
        if (-not (Test-Tool 'wails' 'go install github.com/wailsapp/wails/v2/cmd/wails@latest')) { return $false }
      }
    }
  }
  return $true
}

function Test-Workspace {
  if (Test-Path (Join-Path $RepoRoot 'node_modules')) { return $true }
  Write-Warn 'workspace dependencies are missing'
  Write-Note 'run: .\run.ps1 install'
  return $false
}

# Guards against a bad Join-Path escaping the repo before any recursive delete.
function Get-SafePath {
  param([Parameter(Mandatory = $true)][string]$RelativePath)
  $full = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $RelativePath))
  $root = [System.IO.Path]::GetFullPath($RepoRoot)
  if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing to touch '$RelativePath': resolves outside the repository"
  }
  return $full
}

# Port 7800 has strictPort enabled, so a leftover vite child from a previous
# session makes the new one die with a confusing error. Best-effort check.
function Test-PortBusy {
  param([int]$Port = 7800)
  try {
    $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    if ($busy) {
      Write-Warn "port $Port is already in use"
      Write-Note 'a previous vite process is probably still running:'
      Write-Note '  taskkill /F /IM node.exe'
      return $true
    }
  } catch {
    # Get-NetTCPConnection needs a newer Windows / may be blocked; not fatal.
  }
  return $false
}

# ------------------------------------------------------------------ modes ---

function Show-Help {
  Write-Host ''
  Write-Host 'EpubMaker runner' -ForegroundColor Green
  Write-Host 'Usage: .\run.ps1 <mode> [options]' -ForegroundColor Gray
  Write-Host ''
  Write-Host 'Modes:' -ForegroundColor White
  Write-Host '  help      Show this help (default)' -ForegroundColor Gray
  Write-Host '  clean     Remove build artifacts' -ForegroundColor Gray
  Write-Host '  build     Production build (exe)' -ForegroundColor Gray
  Write-Host '  nsis      Production build + NSIS installer' -ForegroundColor Gray
  Write-Host '  dev       Desktop dev loop (vite + Go + hot reload)' -ForegroundColor Gray
  Write-Host '  web       Frontend only, vite on http://localhost:7800' -ForegroundColor Gray
  Write-Host '  install   Install workspace dependencies' -ForegroundColor Gray
  Write-Host '  test      Type-check frontend, then vet + test Go backend' -ForegroundColor Gray
  Write-Host ''
  Write-Host 'Options:' -ForegroundColor White
  Write-Host '  -Verbose  Stream sub-process output (build/dev/test)' -ForegroundColor Gray
  Write-Host ''
  Write-Host 'Examples:' -ForegroundColor White
  Write-Host '  .\run.ps1 dev' -ForegroundColor Gray
  Write-Host '  .\run.ps1 build -Verbose' -ForegroundColor Gray
  Write-Host '  .\run.ps1 web' -ForegroundColor Gray
  Write-Host ''
}

function Invoke-Clean {
  Write-Step 'cleaning build artifacts'

  $targets = @(
    @{ Path = 'web/dist'; Keep = @() },
    @{ Path = 'app/frontend/dist'; Keep = @('.gitkeep') },
    @{ Path = 'app/build/bin'; Keep = @() }
  )

  foreach ($target in $targets) {
    $full = Get-SafePath $target.Path
    if (-not (Test-Path -LiteralPath $full)) {
      Write-Note "$($target.Path): nothing to remove"
      continue
    }
    # Children first so the .gitkeep placeholder survives the mirroring step
    # in scripts/sync-frontend-dist.js.
    $children = Get-ChildItem -LiteralPath $full -Force |
      Where-Object { $target.Keep -notcontains $_.Name }
    if (-not $children) {
      Write-Note "$($target.Path): nothing to remove"
      continue
    }
    $children | Remove-Item -Recurse -Force
    Write-Note "removed $($target.Path)"
  }

  Write-Step 'clean done'
}

function Invoke-Install {
  if (-not (Assert-Prereqs @('node', 'npm'))) { return 1 }
  Push-Location $RepoRoot
  try {
    Invoke-Native 'npm' @('install')
  } finally {
    Pop-Location
  }
  return 0
}

# wails v2.11 loads package types with its own vendored golang.org/x/tools, which
# cannot read the export data emitted by Go 1.27 — `wails build` dies with
# 'internal error: package "fmt" without types was imported from ...' even though
# `go build ./...` succeeds. Pinning the toolchain to the version in app/go.mod
# sidesteps it. Harmless once wails catches up, so the pin stays until then.
function Set-WailsToolchain {
  if ($env:GOTOOLCHAIN) { return }
  $goMod = Join-Path $RepoRoot 'app/go.mod'
  if (-not (Test-Path $goMod)) { return }
  $version = (Get-Content $goMod |
    Select-String -Pattern '^\s*go\s+([0-9]+\.[0-9]+(\.[0-9]+)?)' |
    Select-Object -First 1).Matches.Groups[1].Value
  if (-not $version) { return }
  $env:GOTOOLCHAIN = "go$version"
  Write-Note "pinned GOTOOLCHAIN=go$version for wails compatibility"
}

function Invoke-Build {
  param([switch]$Installer)

  if (-not (Assert-Prereqs @('node', 'npm', 'go', 'wails'))) { return 1 }
  if (-not (Test-Workspace)) { return 1 }
  Set-WailsToolchain

  Push-Location (Join-Path $RepoRoot 'app')
  try {
    # wails build runs frontend:build (npm run build + sync-frontend-dist.js)
    # itself, so the frontend bundle is produced and embedded automatically.
    if ($Installer) {
      Invoke-Native 'wails' @('build', '-nsis')
    } else {
      Invoke-Native 'wails' @('build')
    }
  } finally {
    Pop-Location
  }

  $exe = Join-Path $RepoRoot 'app/build/bin/EpubMaker.exe'
  if (Test-Path $exe) {
    Write-Step "built $exe"
  }
  return 0
}

function Invoke-Dev {
  if (-not (Assert-Prereqs @('node', 'npm', 'go', 'wails'))) { return 1 }
  if (-not (Test-Workspace)) { return 1 }
  Set-WailsToolchain

  Write-Note 'first run compiles Go (incl. modernc.org/sqlite) and can take a minute'
  Write-Note 'wait for the window even after vite reports ready'
  if (Test-PortBusy) { Write-Note 'continuing anyway — vite may fail to bind' }

  Push-Location (Join-Path $RepoRoot 'app')
  try {
    Invoke-Native 'wails' @('dev')
  } finally {
    Pop-Location
  }
  return 0
}

function Invoke-Web {
  if (-not (Assert-Prereqs @('node', 'npm'))) { return 1 }
  if (-not (Test-Workspace)) { return 1 }

  Write-Warn 'frontend only: there is no Go backend and no window.go binding'
  Write-Note 'use this for styling and component work, not for business flows'

  if (Test-PortBusy) { Write-Note 'continuing anyway — vite may fail to bind' }

  Push-Location $RepoRoot
  try {
    Invoke-Native 'npm' @('run', 'dev:web')
  } finally {
    Pop-Location
  }
  return 0
}

function Invoke-Test {
  if (-not (Assert-Prereqs @('node', 'npm', 'go'))) { return 1 }
  if (-not (Test-Workspace)) { return 1 }

  Push-Location (Join-Path $RepoRoot 'web')
  try {
    Invoke-Native 'npm' @('run', 'typecheck')
  } finally {
    Pop-Location
  }

  Push-Location (Join-Path $RepoRoot 'app')
  try {
    Invoke-Native 'go' @('vet', './...')
    Invoke-Native 'go' @('test', './...')
  } finally {
    Pop-Location
  }
  return 0
}

# ---------------------------------------------------------------- dispatch ---

# No param block on purpose: $args lets short flags like -h reach the script
# instead of being rejected as unknown named parameters.
$requested = ''
if ($args.Count -gt 0) { $requested = [string]$args[0] }

$verbose = $false
foreach ($arg in $args) {
  if ($arg -eq '-Verbose' -or $arg -eq '--verbose') { $verbose = $true }
}

switch -Regex ($requested) {
  '^(help|-h|--help|\?)$'          { Show-Help; exit 0 }
  '^(clean|-c|--clean)$'          { exit (Invoke-Clean) }
  '^(install|-i|--install)$'      { exit (Invoke-Install) }
  '^(build|-b|--build)$'          { exit (Invoke-Build) }
  '^(nsis|--nsis)$' {
    if (-not (Assert-Prereqs @('node', 'npm', 'go', 'wails'))) { exit 1 }
    exit (Invoke-Build -Installer)
  }
  '^(dev|-d|--dev)$'              { exit (Invoke-Dev) }
  '^(web|-w|--web)$'              { exit (Invoke-Web) }
  '^(test|-t|--test)$'            { exit (Invoke-Test) }
  '^$'                             { Show-Help; exit 0 }
  default {
    Write-Fail "unknown mode: $requested"
    Write-Host ''
    Show-Help
    exit 1
  }
}
