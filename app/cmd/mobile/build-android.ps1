<#
.SYNOPSIS
  Builds the EpubMaker Android APK (Wails v3 host).

.DESCRIPTION
  Same host as the desktop build (app/main.go, see build-windows.ps1): this
  cross-compiles that package into libwails.so and wraps it in the APK. What
  lives here is the Android-only half — the Gradle project, the Java host and
  the generated main() registration.

  Steps: web bundle -> app/frontend/dist -> Android main overlay ->
  Go to libwails.so (NDK, c-shared) -> Gradle assembleDebug ->
  app/build/mobile/bin/EpubMaker.apk

.PARAMETER Arch
  Target ABI. arm64 for phones (default), x86_64 for the emulator.

.PARAMETER SkipFrontend
  Reuse the existing app/frontend/dist instead of rebuilding web/ (~30s saved).

.PARAMETER ApkOnly
  Skip the Go step and only re-run Gradle (useful after a Java-side tweak).

.EXAMPLE
  .\build-android.ps1
  .\build-android.ps1 -Arch x86_64
  .\build-android.ps1 -SkipFrontend

.NOTES
  Requires JDK 17, Android SDK (platform 35, build-tools 35.0.0, NDK 26.3.x)
  and the wails3 CLI. See app/README-mobile.md.
#>
[CmdletBinding()]
param(
  [ValidateSet('arm64', 'x86_64')]
  [string]$Arch = 'arm64',

  [switch]$SkipFrontend,

  [switch]$ApkOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$MobileDir = $PSScriptRoot
$AppDir = Split-Path (Split-Path $MobileDir -Parent) -Parent
$RepoDir = Split-Path $AppDir -Parent
$WebDir = Join-Path $RepoDir 'web'
$AndroidDir = Join-Path $MobileDir 'build\android'

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor DarkGray }

# ---------------------------------------------------------------- toolchain ---
# A stale ANDROID_HOME pointing at another user's profile is common on Windows
# boxes that once had Android Studio, and JAVA_HOME is just as often an old 1.8
# left by a legacy installer. Probe both instead of trusting them.
function Resolve-SdkHome([string]$envValue, [string]$probe, [string]$fallback) {
  if ($envValue -and (Test-Path (Join-Path $envValue $probe))) { return $envValue }
  return $fallback
}

function Get-JavaMajor([string]$javaHome) {
  $exe = Join-Path $javaHome 'bin\java.exe'
  if (-not (Test-Path $exe)) { return 0 }
  # java -version writes to stderr; under $ErrorActionPreference = 'Stop' that
  # surfaces as a NativeCommandError, so relax it just for this probe.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $first = (& $exe -version 2>&1 | Select-Object -First 1)
  } finally {
    $ErrorActionPreference = $previous
  }
  if ("$first" -match 'version "(\d+)(?:\.(\d+))?') {
    $major = [int]$Matches[1]
    # 1.8.0_202 and friends report the real major in the second group.
    if ($major -eq 1 -and $Matches[2]) { return [int]$Matches[2] }
    return $major
  }
  return 0
}

$SdkHome = Resolve-SdkHome $env:ANDROID_HOME 'platform-tools' 'D:\dev\android-sdk'
if (-not (Test-Path (Join-Path $SdkHome 'platform-tools'))) {
  throw "Android SDK not found at '$SdkHome' (no platform-tools). Set ANDROID_HOME."
}

# Gradle 9 needs JDK 17+. Prefer a valid JAVA_HOME, then any JDK under D:\dev.
$jdkCandidates = @()
if ($env:JAVA_HOME) { $jdkCandidates += $env:JAVA_HOME }
$jdkCandidates += @(Get-ChildItem 'D:\dev' -Directory -Filter 'jdk*' -ErrorAction SilentlyContinue |
  Sort-Object Name | ForEach-Object { $_.FullName })

$JdkHome = $null
foreach ($candidate in $jdkCandidates) {
  if ((Get-JavaMajor $candidate) -ge 17) { $JdkHome = $candidate; break }
}
if (-not $JdkHome) {
  $found = ($jdkCandidates | ForEach-Object { "$_ (java $((Get-JavaMajor $_)))" }) -join ', '
  throw "No JDK 17+ found. Candidates: $found. Install one and set JAVA_HOME."
}

$NdkRoot = $null
if ($env:ANDROID_NDK_HOME -and (Test-Path $env:ANDROID_NDK_HOME)) {
  $NdkRoot = $env:ANDROID_NDK_HOME
} else {
  $ndkBase = Join-Path $SdkHome 'ndk'
  if (Test-Path $ndkBase) {
    $candidate = Get-ChildItem $ndkBase -Directory | Sort-Object Name | Select-Object -Last 1
    if ($candidate) { $NdkRoot = $candidate.FullName }
  }
}
if (-not $NdkRoot) { throw "Android NDK not found under '$SdkHome\ndk'. Install ndk;26.3.11579264." }

$Wails3 = (Get-Command wails3 -ErrorAction SilentlyContinue)
$Wails3Path = if ($Wails3) { $Wails3.Source } else { Join-Path 'E:\go\bin' 'wails3.exe' }
if (-not (Test-Path $Wails3Path)) {
  throw 'wails3 CLI not found. Run: go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.34'
}

# The About page and the Windows build both take their version from here, so
# there is one number to bump.
$configYml = Join-Path $AppDir 'build\config.yml'
$versionMatch = Get-Content $configYml | Select-String -Pattern '^[ ]+version: *"([^"]+)"' |
  Select-Object -First 1
if (-not $versionMatch) { throw "no quoted info.version in $configYml" }
$Version = $versionMatch.Matches.Groups[1].Value

$MinSdk = 21
$AbiDir = if ($Arch -eq 'arm64') { 'arm64-v8a' } else { 'x86_64' }
$GoArch = if ($Arch -eq 'arm64') { 'arm64' } else { 'amd64' }
$ClangPrefix = if ($Arch -eq 'arm64') { 'aarch64-linux-android' } else { 'x86_64-linux-android' }
$Toolchain = Join-Path $NdkRoot "toolchains\llvm\prebuilt\windows-x86_64"
$CC = Join-Path $Toolchain "bin\$ClangPrefix$MinSdk-clang.cmd"
if (-not (Test-Path $CC)) { throw "NDK compiler not found: $CC" }

Write-Host "EpubMaker Android build" -ForegroundColor White
Write-Ok "JDK       $JdkHome"
Write-Ok "SDK       $SdkHome"
Write-Ok "NDK       $NdkRoot"
Write-Ok "ABI       $AbiDir"
Write-Ok "version   $Version"

$env:JAVA_HOME = $JdkHome
$env:ANDROID_HOME = $SdkHome

# --------------------------------------------------------------- frontend ---
# The desktop build embeds exactly this directory (go:embed in app/main.go), so
# staging once here serves both — there is no per-platform copy of the bundle.
$StageDir = Join-Path $AppDir 'frontend\dist'
if (-not $SkipFrontend) {
  Write-Step 'Building the web bundle'
  Push-Location $WebDir
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
    # Mirrors dist/ into app/frontend/dist and prunes stale hashed chunks
    # (robocopy /MIR under the hood, so it never depends on trash support).
    & node ../scripts/sync-frontend-dist.js
    if ($LASTEXITCODE -ne 0) { throw 'sync-frontend-dist failed' }
  } finally { Pop-Location }
  Write-Ok "staged -> $StageDir"
} elseif (-not (Test-Path (Join-Path $StageDir 'index.html'))) {
  throw 'app/frontend/dist is missing; run without -SkipFrontend first.'
}

if (-not $ApkOnly) {
  # ------------------------------------------------------------------ Go ----
  # The overlay injects a generated main_android.gen.go (its init() registers
  # main() for -buildmode=c-shared) into the app package without touching the
  # source tree. It maps <cwd>/main_android.gen.go, so cwd must be the package.
  Write-Step 'Generating the Android main overlay'
  Push-Location $AppDir
  try {
    & $Wails3Path android overlay:gen -out 'cmd/mobile/build/android/overlay.json' -config 'build/config.yml'
    if ($LASTEXITCODE -ne 0) { throw 'overlay:gen failed' }
  } finally { Pop-Location }

  Write-Step "Compiling libwails.so ($Arch)"
  $JniDir = Join-Path $AndroidDir "app\src\main\jniLibs\$AbiDir"
  New-Item -ItemType Directory -Path $JniDir -Force | Out-Null
  $SoOut = Join-Path $JniDir 'libwails.so'

  $env:CGO_ENABLED = '1'
  $env:GOOS = 'android'
  $env:GOARCH = $GoArch
  $env:CC = $CC

  Push-Location $AppDir
  try {
    # The about page shows when this binary was linked; unix seconds keep the
    # -X flag free of spaces and quoting hazards.
    $buildUnix = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    & go build -buildmode=c-shared -overlay cmd/mobile/build/android/overlay.json `
      -tags android,debug -buildvcs=false '-gcflags=all=-l' `
      -ldflags "-X epubmaker-desktop/internal/app.AppVersion=$Version -X epubmaker-desktop/internal/app.BuildTimeUnix=$buildUnix" -o $SoOut .
    if ($LASTEXITCODE -ne 0) { throw 'go build failed' }

    # Restore whatever host build settings later tooling expects.
    Remove-Item Env:\GOOS -ErrorAction SilentlyContinue
    Remove-Item Env:\GOARCH -ErrorAction SilentlyContinue
    Remove-Item Env:\CGO_ENABLED -ErrorAction SilentlyContinue
    Remove-Item Env:\CC -ErrorAction SilentlyContinue
  } finally { Pop-Location }

  $soSize = [math]::Round((Get-Item $SoOut).Length / 1MB, 1)
  Write-Ok "libwails.so ${soSize} MB"
}

# ---------------------------------------------------------------- Gradle ----
Write-Step 'Assembling the APK'
Push-Location $AndroidDir
try {
  # -PabiDir keeps the other ABI's libwails.so out of the APK: jniLibs is a
  # plain source directory, so it accumulates one subdirectory per build.
  #
  # Gradle writes warnings to stderr (javac's notes are localized, so they read
  # as 「注: 某些文件使用或覆盖了已过时的 API」), and under
  # $ErrorActionPreference = 'Stop' a native command's stderr becomes a
  # terminating error: the build succeeded and the script reported a failure.
  # Same relaxation as Get-JavaMajor above; the exit code is what decides.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & cmd /c "gradlew.bat assembleDebug --no-daemon -PabiDir=$AbiDir"
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -ne 0) { throw 'gradle assembleDebug failed' }
} finally { Pop-Location }

$apkSrc = Join-Path $AndroidDir 'app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path $apkSrc)) { throw "APK not produced at $apkSrc" }

$binDir = Join-Path $AppDir 'build\mobile\bin'
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
$apkOut = Join-Path $binDir "EpubMaker-$AbiDir.apk"
Copy-Item $apkSrc $apkOut -Force

$apkSize = [math]::Round((Get-Item $apkOut).Length / 1MB, 1)
Write-Host "`nAPK: $apkOut (${apkSize} MB)" -ForegroundColor Green
Write-Host "Install with: adb install -r `"$apkOut`"" -ForegroundColor DarkGray
