<#
.SYNOPSIS
  Install the mobile build on a real device and collect the first thing that
  goes wrong, if anything does.

.DESCRIPTION
  A c-shared Go process on Android cannot write to logcat, so a crash during
  startup is completely silent (see README-mobile.md). This script therefore
  installs, launches, and then pulls files/trace.log -- the breadcrumbs main.go
  appends -- plus a screenshot and any crash line logcat did record.

  Run it with the phone plugged in and USB debugging authorised.

.EXAMPLE
  .\install-and-check.ps1
  .\install-and-check.ps1 -Arch x86_64
#>
[CmdletBinding()]
param(
  [string]$Serial = '',
  [ValidateSet('arm64', 'x86_64')]
  [string]$Arch = 'arm64',
  [int]$WaitSeconds = 60
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# Build artifacts (APK, diag screenshots) live in app/build/mobile/.
$AppDir = Split-Path (Split-Path $here -Parent) -Parent
$OutDir = Join-Path $AppDir 'build\mobile'

# adb: honour the SDK env vars if set, then the D:\dev location this project's
# README pins, then whatever is on PATH.
function Resolve-Adb {
  foreach ($sdk in @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME, 'D:\dev\android-sdk')) {
    if (-not $sdk) { continue }
    $p = Join-Path $sdk 'platform-tools\adb.exe'
    if (Test-Path $p) { return $p }
  }
  $cmd = Get-Command adb -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw 'adb not found. Set ANDROID_SDK_ROOT or install platform-tools.'
}
$adb = Resolve-Adb

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }

function Invoke-Adb {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$AdbArgs)
  $target = @()
  if ($Serial) { $target = @('-s', $Serial) }
  # adb writes ordinary progress text ("daemon not running, starting now") and
  # device warnings to stderr. Under ErrorActionPreference=Stop PowerShell turns
  # those into terminating errors, so relax it for the call only.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    return @(& $adb @target @AdbArgs 2>&1 | ForEach-Object { "$_" })
  } finally {
    $ErrorActionPreference = $prev
  }
}

# --- locate a real device (the emulator cannot run this build, so skip it) ----
Write-Step 'Looking for a device'
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$device = $null
while ((Get-Date) -lt $deadline) {
  $rows = (Invoke-Adb 'devices') | Where-Object { $_ -match '\tdevice$' }
  foreach ($r in $rows) {
    $candidate = ($r -split "`t")[0]
    if ($candidate -match '^emulator-') { continue }
    if ($Serial -and $candidate -ne $Serial) { continue }
    $device = $candidate
    break
  }
  if ($device) { break }
  Start-Sleep -Seconds 2
}

if (-not $device) {
  Write-Host 'No phone found. adb currently reports:' -ForegroundColor Red
  (Invoke-Adb 'devices') | ForEach-Object { Write-Host "    $_" }
  Write-Host ''
  Write-Host 'Checklist on the phone:' -ForegroundColor Yellow
  Write-Host '  1. Settings > About phone > tap "Version number" 7 times (developer options).'
  Write-Host '  2. Settings > System & updates > Developer options > enable "USB debugging".'
  Write-Host '  3. Pull down the notification shade and set USB mode to "File transfer" (MTP).'
  Write-Host '     Huawei does not expose the ADB interface in charge-only mode.'
  Write-Host '  4. Accept the "Allow USB debugging?" dialog, tick "Always allow".'
  Write-Host '  5. Still nothing? "adb kill-server" then replug the cable.'
  exit 1
}

$Serial = $device
Write-Step "Using device $Serial"

function Get-Prop($name) { ((Invoke-Adb 'shell' 'getprop' $name) -join ' ').Trim() }
$model = Get-Prop 'ro.product.model'
$abi = Get-Prop 'ro.product.cpu.abi'
$rel = Get-Prop 'ro.build.version.release'
$sdk = Get-Prop 'ro.build.version.sdk'
$emui = Get-Prop 'ro.build.version.emui'
$harmony = Get-Prop 'hw_sc.build.platform.version'
Write-Host "    model=$model  abi=$abi  android=$rel (sdk $sdk)  emui=$emui  harmony=$harmony"

if ($abi -notmatch 'arm64') {
  Write-Warning "Device abi is '$abi', not arm64-v8a"
}

# --- install -----------------------------------------------------------------
$apkName = if ($Arch -eq 'arm64') { 'EpubMaker-arm64-v8a.apk' } else { 'EpubMaker-x86_64.apk' }
$apk = Join-Path $OutDir "bin\$apkName"
if (-not (Test-Path $apk)) { throw "APK not built yet: $apk  (run .\build-android.ps1 -Arch $Arch)" }
Write-Step "Installing $apkName ($([math]::Round((Get-Item $apk).Length / 1MB, 1)) MB)"
$install = (Invoke-Adb 'install' '-r' $apk) -join "`n"
Write-Host $install
if ($install -notmatch 'Success') {
  if ($install -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match|INSTALL_FAILED_DEPRECATED_SDK') {
    Write-Warning 'Existing install conflicts with this one. Uninstall it first:'
    Write-Host "  & '$adb' -s $Serial uninstall com.wails.app"
  }
  throw 'install failed'
}

# --- launch and observe ------------------------------------------------------
Write-Step 'Clearing logcat and launching'
$null = Invoke-Adb 'logcat' '-c'
# A stale process would just be brought to front by monkey and tell us nothing.
$null = Invoke-Adb 'shell' 'am' 'force-stop' 'com.wails.app'
$null = Invoke-Adb 'shell' 'monkey' '-p' 'com.wails.app' '-c' 'android.intent.category.LAUNCHER' '1'
Start-Sleep -Seconds 8

$appPid = ((Invoke-Adb 'shell' 'pidof' 'com.wails.app') -join ' ').Trim()
if ($appPid) {
  Write-Host "    process alive, pid $appPid" -ForegroundColor Green
} else {
  Write-Host '    process is GONE after 8s -- it crashed' -ForegroundColor Red
}

Write-Step 'trace.log (startup breadcrumbs)'
$trace = (Invoke-Adb 'shell' 'run-as' 'com.wails.app' 'cat' 'files/trace.log') -join "`n"
if ($trace -match 'No such file|not debuggable|Exception') {
  Write-Host '    (none -- crashed before the first breadcrumb, or the build is not debuggable)'
} else {
  Write-Host $trace
}

Write-Step 'Crash evidence'
$crash = (Invoke-Adb 'logcat' '-d') | Select-String -Pattern 'Fatal signal|FATAL EXCEPTION|Go panic|signal 31|seccomp|has died|Process com.wails.app'
if ($crash) { $crash | Select-Object -First 25 | ForEach-Object { Write-Host "    $_" } }
else { Write-Host '    (nothing alarming in logcat)' }

Write-Step 'Relevant log lines'
$lines = (Invoke-Adb 'logcat' '-d') | Select-String -Pattern 'wails|GoLog|WebView|chromium|sqlite|epubmaker' -CaseSensitive:$false
if ($lines) { $lines | Select-Object -Last 25 | ForEach-Object { Write-Host "    $_" } }

# --- artifacts ---------------------------------------------------------------
$diagDir = Join-Path $OutDir 'diag'
if (-not (Test-Path $diagDir)) { New-Item -ItemType Directory -Path $diagDir | Out-Null }
Write-Step 'Screenshot'
$null = Invoke-Adb 'shell' 'screencap' '-p' '/sdcard/epub-shot.png'
$shot = Join-Path $diagDir 'device.png'
$pull = (Invoke-Adb 'pull' '/sdcard/epub-shot.png' $shot) -join "`n"
if (Test-Path $shot) { Write-Host "    saved $shot" } else { Write-Host "    pull failed: $pull" }

Write-Host ''
if (-not $appPid) {
  Write-Host 'App died. The last breadcrumb in trace.log names the failing step.' -ForegroundColor Yellow
} elseif ($trace -and $trace -notmatch 'window created') {
  Write-Host 'Process is alive but never reached "window created" -- the WebView is probably stuck before first paint.' -ForegroundColor Yellow
} else {
  Write-Host 'App is up. To watch the JS side while poking the UI:' -ForegroundColor Green
  Write-Host "  & '$adb' -s $Serial logcat | Select-String 'wails|chromium|Console'"
}
