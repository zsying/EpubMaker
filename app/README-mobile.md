# EpubMaker for Android

The desktop app builds with Wails **v2** from `app/`. The Android app builds
with Wails **v3** from `app/cmd/mobile/`. They are two hosts over one module:
`internal/app.Backend` has no Wails dependency, so the same struct is bound by
both, and the same `web/dist` bundle runs in both WebViews.

This is deliberate. Migrating the desktop build to v3 would mean rewriting
`run.ps1`, the NSIS installer and the file-association registration — work that
has nothing to do with running on a phone. Adding a second entry point keeps the
desktop build untouched.

```
app/
  main.go                  wails v2 host (desktop, unchanged)
  cmd/mobile/
    main.go                wails v3 host (Android)
    frontend/dist/         the web bundle, staged for go:embed
    Taskfile.yml           android tasks
    build/
      Taskfile.yml         shared tasks (frontend staging, go mod tidy)
      config.yml           product metadata
      android/             Gradle project + Java host (from the wails v3 template)
```

## Toolchain

| Requirement | Version used | Why |
| --- | --- | --- |
| Go | 1.25+ (1.27 here) | v3 minimum; `GOOS=android` + cgo |
| JDK | 17 (Temurin) | Gradle 9.2.1 needs 17+ |
| Android SDK platform | `platforms;android-35` | `compileSdk` / `targetSdk` in `build.gradle` |
| Android build-tools | `build-tools;35.0.0` | |
| Android NDK | `26.3.11579264` | v3 pins this; the Windows host toolchain lives at `toolchains/llvm/prebuilt/windows-x86_64` |
| wails3 CLI | v3.0.0-beta.34 | `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.34` |

Install the SDK pieces (no proxy flag — `dl.google.com` is reachable directly,
and `--proxy` made `sdkmanager` hang):

```bash
sdkmanager --sdk_root='D:\dev\android-sdk' \
  "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;26.3.11579264"
```

Environment:

```bash
export JAVA_HOME='D:\dev\jdk-17.0.20.1+1'
export ANDROID_HOME='D:\dev\android-sdk'
```

## Build

```powershell
cd app\cmd\mobile
.\build-android.ps1                 # arm64, full: web bundle -> .so -> APK
.\build-android.ps1 -Arch x86_64    # x86_64 (emulator — see the caveat below)
.\build-android.ps1 -SkipFrontend   # reuse the staged frontend/dist
.\build-android.ps1 -ApkOnly        # Gradle only, after a Java-side tweak
```

APK lands in `bin/EpubMaker-<abi>.apk`.

`wails3 task apk` does **not** work here: go-task runs Taskfiles through `gosh`,
which cannot execute the wrapper on Windows (`gradlew` has no extension, and
`gradlew.bat` is rejected too). The PowerShell script drives the same steps
directly — `wails3 android overlay:gen`, `go build -buildmode=c-shared`, then
`gradlew.bat assembleDebug`.

The first Gradle run downloads the 9.2.1 distribution. If
`services.gradle.org` times out, drop the zip into
`~/.gradle/wrapper/dists/gradle-9.2.1-bin/<hash>/` by hand from
`https://mirrors.cloud.tencent.com/gradle/` — the wrapper reuses it.

## Verifying on a device

```bash
adb install -r bin/EpubMaker-arm64-v8a.apk
adb shell monkey -p com.wails.app -c android.intent.category.LAUNCHER 1
adb shell run-as com.wails.app cat files/trace.log    # startup breadcrumbs
```

`main.go` appends a line per startup step (and the DB error, if `db.Open`
fails) to `files/trace.log`. This exists because **`log` output does not reach
logcat from a c-shared Go process** — without it, a startup crash is silent.

### x86_64 emulator: known dead end

The app **cannot run on an x86_64 Android emulator**, and it is not our bug.
`modernc.org/sqlite` reaches the kernel through `modernc.org/libc`, whose
amd64 `fstatat` follows musl: it first tries the deprecated `stat`/`lstat`
syscalls and only falls back to `newfstatat` when they return `ENOSYS`. Android
x86_64's seccomp policy answers those two with `SECCOMP_RET_TRAP`, so the
process is killed with `SIGSYS` the first time SQLite touches a file:

```
Cause: seccomp prevented call to disallowed x86_64 system call 6
  #00 pc ... libwails.so (internal/runtime/syscall/linux.Syscall6+14)
```

Verified against `modernc.org/libc` v1.74.4 and v1.79.0 (both still do it).
arm64 is unaffected — there is no `lstat`/`stat` syscall on arm64, so the same
shim emits `fstatat`(79)/`fstat`(80), both whitelisted. **Test on an arm64
phone, not the emulator.** A userdebug x86_64 image can still be used for
frontend-only checks (assets load, the window opens) as long as nothing hits
SQLite.


## Notes on the port

- **Cross-compiling from Windows works.** `build/android/Taskfile.yml` maps
  `uname -s` to `MINGW*|MSYS*|CYGWIN*` → `windows-x86_64`, and Go execs the
  NDK's `aarch64-linux-android21-clang.cmd` directly.
- **No open ports.** v3 serves assets through `WebViewAssetLoader` backed by
  the embedded `frontend/dist`, exactly like the desktop's `go:embed` — the
  "no HTTP, no port" rule holds on Android too.
- **Data directory.** Android gives a process no usable `HOME`, so `main.go`
  pins `EPUBMAKER_HOME` to `/data/data/<pkg>/files/.epubmaker`, deriving the
  package name from `/proc/self/cmdline`. This keeps `internal/config`
  untouched.
- **Transport.** `web/src/api.ts` picks v2 (`window.go.app.Backend.*`) or v3
  (`Call.ByName('Backend.*')`) per call. The desktop bundle never loads the
  `@wailsio/runtime` chunk.
- **Desktop-only bindings.** `App` (native dialogs, file association) is built
  on the v2 runtime and is not bound in the v3 host. Mobile callers get a clear
  error instead of a silent `undefined`.

## Not done yet

- Only `Backend` is bound; EPUB import on the phone (Storage Access Framework)
  is not wired up.
- The dictionary (97 MB) has to be shipped or imported; nothing does either yet.
- Editor / Split / WebDAV / Trash are desktop-only by design.
- `wails3 doctor` may block waiting on stdin in Git Bash; verify the toolchain
  by building instead.
