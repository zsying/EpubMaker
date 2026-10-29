# EpubMaker for Android

One host, two platforms. `app/main.go` is the only entry point: it opens the
database, binds `Backend` and `App`, and hands both to Wails v3. The desktop
binary and the Android `libwails.so` are two builds of that same `main.go`,
differing only in the `//go:build` files next to it:

```
app/
  main.go                  the host: window, services, .epub args, file drop
  platform_android.go      //go:build android   -> EPUBMAKER_HOME + trace()
  platform_desktop.go      //go:build !android   -> no-ops
  build-windows.ps1        desktop: web bundle -> version resource -> go build (+ NSIS)
  dev-windows.ps1          desktop dev loop: vite + proxy + rebuild on Go change
  build/config.yml         version / product metadata, shared by both scripts
  frontend/dist/           the web bundle, staged for go:embed (one copy for both)
  cmd/mobile/
    build-android.ps1      android: web bundle -> libwails.so -> APK
    install-and-check.ps1  install + launch + trace.log + screenshot + crash scan
    build/android/         Gradle project + Java host (from the wails v3 template)
```

`internal/app.Backend` and `internal/webassets` have no host branch in them, and
the same `web/dist` bundle runs in both WebViews. That is what makes the single
`main.go` possible: everything platform-specific is either a Wails v3 API
(`Dialogs`, `FileAssociations`, dropped files) or one of the two `platform_*.go`
files.

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
.\run.ps1 mobile                     # from the repo root (forwards everything below)
cd app && .\cmd\mobile\build-android.ps1          # arm64, full: web bundle -> .so -> APK
cd app && .\cmd\mobile\build-android.ps1 -Arch x86_64    # see the caveat below
cd app && .\cmd\mobile\build-android.ps1 -SkipFrontend   # reuse app/frontend/dist
cd app && .\cmd\mobile\build-android.ps1 -ApkOnly        # Gradle only, after a Java-side tweak
```

APK lands in `app/build/mobile/bin/EpubMaker-<abi>.apk` (the shared output
area for all generated files; diag screenshots from install-and-check.ps1
land in `app/build/mobile/diag/`).

`wails3 build|dev|package|task` do **not** work here: they drive Taskfiles
through go-task/`gosh`, which cannot execute the wrappers on Windows
(`gradlew` has no extension, and `gradlew.bat` is rejected too). The PowerShell
scripts drive the same steps directly, and the wails3 CLI keeps exactly two
jobs: `generate syso` (desktop icon/manifest/version resource) and
`android overlay:gen` (which writes `main_android.gen.go`, the file whose
`init()` calls `application.RegisterAndroidMain(main)`; it is injected with
`-overlay`, so `go build` must run with cwd = `app/`).

The first Gradle run downloads the 9.2.1 distribution. If
`services.gradle.org` times out, drop the zip into
`~/.gradle/wrapper/dists/gradle-9.2.1-bin/<hash>/` by hand from
`https://mirrors.cloud.tencent.com/gradle/` — the wrapper reuses it.

## Verifying on a device

```powershell
cd app\cmd\mobile
.\install-and-check.ps1          # install + launch + trace.log + screenshot + crash scan
```

or by hand:

```bash
adb install -r app/build/mobile/bin/EpubMaker-arm64-v8a.apk
adb shell monkey -p com.wails.app -c android.intent.category.LAUNCHER 1
adb shell run-as com.wails.app cat files/trace.log    # startup breadcrumbs
```

`platform_android.go` appends a line per startup step (and the DB error, if
`db.Open` fails) to `files/trace.log`. This exists because **`log` output does
not reach logcat from a c-shared Go process** — without it, a startup crash is
silent. The desktop build compiles the same `trace()` call into a no-op.

Debug builds expose the WebView over CDP, which is how the two bugs below were
found (neither leaves a trace in logcat):

```bash
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.wails.app)
curl http://127.0.0.1:9222/json/list    # grab the page id, then drive
                                        # Runtime.evaluate over the ws endpoint
```

The desktop has the same capability behind `EPUBMAKER_DEBUG_PORT` (it becomes
`--remote-debugging-port` in `application.WindowsOptions.AdditionalBrowserArgs`,
and dev builds keep devtools enabled by not setting the `production` tag).

### Bugs that only a real device reveals

- **The Java side owned `/wails/` and served everything as json.**
  `MainActivity.shouldInterceptRequest` routes `/wails/...` to a branch that
  hardcodes `Content-Type: application/json` — right for the runtime's JSON
  call envelopes, fatal for `/wails/runtime.js`, which the WebView refuses to
  import as a module when served as json. It now derives the type from the
  path via `bridge.getAssetMimeType`.
- **v3 binding names are fully qualified.** `Call.ByName("Backend.ListBooks")`
  fails with `unknown bound method name`; the registered name is
  `epubmaker-desktop/internal/app.Backend.ListBooks` —
  `<module path>.<package>.<type>.<method>`, per the FQN rule in
  `bindings.go`. The frontend keeps the prefix in `api.ts`'s `V3_BACKEND_FQN`;
  update it if the Go module path ever changes. The long-term fix would be
  `wails3 generate bindings` to pin names at build time.
- **The page must import the runtime itself.** v3 never injects a script tag;
  the module lives at `/wails/runtime.js` and loading it installs
  `window._wails`. api.ts imports it lazily on the first call.
- **Deep links used to land on an error page.** A hard navigation to
  `/books/<id>/read` was answered by the Java asset branch before
  `internal/webassets` learned to fall back to `index.html`; the main frame's
  MIME is now forced to `text/html` too. Without both halves the WebView shows
  `net::ERR_CONNECTION_REFUSED` and the document is dead.

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

- **Cross-compiling from Windows works.** `go build -buildmode=c-shared` execs
  the NDK's `aarch64-linux-android21-clang.cmd` directly; no MSYS shell needed.
- **No open ports.** v3 serves assets through `WebViewAssetLoader` backed by
  the embedded `frontend/dist`, exactly like the desktop's `go:embed` — the
  "no HTTP, no port" rule holds on Android too.
- **Data directory.** Android gives a process no usable `HOME`, so
  `platform_android.go` pins `EPUBMAKER_HOME` to
  `/data/data/<pkg>/files/.epubmaker`, deriving the package name from
  `/proc/self/cmdline`. This keeps `internal/config` untouched, and the desktop
  build compiles the call away.
- **Transport.** One shape for both platforms: `Call.ByName` on the host's own
  `/wails/runtime.js` module. There is no npm runtime dependency — the host
  serves its own, transport and all. `web/src/api.ts` still honours an injected
  `window.go` when a test harness puts one there; that is a test seam for the
  offline Playwright suite, not a second transport.
- **Native dialogs are shared.** `App.SelectEpubFiles` / `SelectCoverFile` /
  `SelectDictFile` call `application.App.Dialog.OpenFile()`, so they exist on
  both platforms; only the phone's path goes through the same call.

## Not done yet

- Only `Backend` is bound; EPUB import on the phone (Storage Access Framework)
  is not wired up.
- The dictionary (97 MB) has to be shipped or imported; nothing does either yet.
- Editor / Split / WebDAV / Trash are desktop-only by design.
- `wails3 doctor` may block waiting on stdin in Git Bash; verify the toolchain
  by building instead.
