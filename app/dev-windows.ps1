<#
.SYNOPSIS
  Desktop dev loop: the vite dev server plus an app window pointed at it.

.DESCRIPTION
  Wails' own `dev` command runs a Taskfile through go-task, which cannot drive
  this repo on Windows (see build-windows.ps1). This is the replacement, and it
  stays deliberately small:

    1. start `npm run dev` (vite, :7800) and wait for it to answer;
    2. build a dev binary (no `production` tag, so devtools and the Go console
       stay) and launch it with EPUBMAKER_DEV_URL set;
    3. poll for changed .go files, and rebuild + relaunch when they change.

  The app still loads from the host's own origin: main.go proxies every
  non-/wails request to vite when EPUBMAKER_DEV_URL is set, so the bindings keep
  working and the page is the same one production serves. Vite's HMR websocket
  cannot cross that proxy (the asset server rejects upgrades), so a frontend
  edit reloads the page instead of hot-swapping the module.

.PARAMETER NoWatch
  Build and launch once, then wait. Go changes need a restart by hand.

.PARAMETER Port
  Vite's port. web/vite.config.ts pins 7800 with strictPort; only change this
  if you change that too.

.EXAMPLE
  .\dev-windows.ps1
  .\dev-windows.ps1 -NoWatch
#>
[CmdletBinding()]
param(
  [switch]$NoWatch,
  [int]$Port = 7800
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$AppDir = $PSScriptRoot
$RepoDir = Split-Path $AppDir -Parent
$WebDir = Join-Path $RepoDir 'web'
$BuildScript = Join-Path $AppDir 'build-windows.ps1'
$Exe = Join-Path $AppDir 'build\bin\EpubMaker.exe'
$ViteLog = Join-Path $AppDir 'build\vite.log'
$ViteErr = Join-Path $AppDir 'build\vite.err.log'

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor DarkGray }

function Stop-Tree([int]$ProcessId) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & taskkill /PID $ProcessId /T /F *> $null
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Wait-DevServer([int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $res = Invoke-WebRequest -Uri "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 2
      if ($res.StatusCode -eq 200) { return $true }
    } catch {
      # not up yet
    }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

# Newest write time under app/ for the files a rebuild cares about. Polling
# beats a file-system watcher here: one number, no handles held on the tree.
function Get-GoStamp {
  $newest = [datetime]::MinValue
  Get-ChildItem $AppDir -Recurse -Filter *.go -File |
    Where-Object { $_.FullName -notmatch '\\build\\|\\frontend\\' } |
    ForEach-Object { if ($_.LastWriteTime -gt $newest) { $newest = $_.LastWriteTime } }
  return $newest
}

# ---------------------------------------------------------------- vite ----
$busy = $null
try { $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop } catch { }
if ($busy) {
  throw "port $Port is already in use (a vite from an earlier session?). Stop it first: taskkill /F /IM node.exe"
}

New-Item -ItemType Directory -Path (Split-Path $ViteLog -Parent) -Force | Out-Null
Write-Step "Starting vite on :$Port"
$vite = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev' -WorkingDirectory $WebDir `
  -RedirectStandardOutput $ViteLog -RedirectStandardError $ViteErr -WindowStyle Hidden -PassThru

$app = $null
try {
  if (-not (Wait-DevServer 60)) {
    throw "vite did not answer on :$Port within 60s — see $ViteLog and $ViteErr"
  }
  Write-Ok "dev server ready"

  $stamp = Get-GoStamp
  $env:EPUBMAKER_DEV_URL = "http://localhost:$Port"

  & $BuildScript -SkipFrontend -Dev
  if ($LASTEXITCODE -ne 0) { throw 'dev build failed' }
  Write-Step 'Launching EpubMaker'
  $app = Start-Process -FilePath $Exe -PassThru

  if ($NoWatch) {
    Write-Ok 'no watch: press Ctrl+C here to stop (vite and the app close with it)'
    Wait-Process -Id $app.Id
  } else {
    Write-Ok 'watching *.go under app/ — edit, save, and the window restarts'
    while ($true) {
      Start-Sleep -Milliseconds 800
      if ($app.HasExited) {
        # Closing the window on purpose ends the session, not just the window.
        Write-Ok 'window closed'
        break
      }
      $now = Get-GoStamp
      if ($now -gt $stamp) {
        $stamp = $now
        Write-Step 'Go changed — rebuilding'
        Stop-Tree $app.Id
        & $BuildScript -SkipFrontend -Dev
        if ($LASTEXITCODE -ne 0) {
          # Keep the loop alive so the next save can fix it.
          Write-Host '    build failed; waiting for the next edit' -ForegroundColor Yellow
          continue
        }
        $app = Start-Process -FilePath $Exe -PassThru
      }
    }
  }
} finally {
  Remove-Item Env:\EPUBMAKER_DEV_URL -ErrorAction SilentlyContinue
  if ($app -and -not $app.HasExited) { Stop-Tree $app.Id }
  if ($vite -and -not $vite.HasExited) { Stop-Tree $vite.Id }
}
