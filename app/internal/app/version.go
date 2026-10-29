package app

// AppVersion is the version string surfaced by the 关于 page. build-windows.ps1
// and build-android.ps1 inject it from build/config.yml (info.version), so the
// About page, the Windows version resource and the installer cannot drift apart;
// the literal below is only what a bare `go run`/`go build` reports.
var AppVersion = "0.4.0"

// BuildTimeUnix is the link timestamp injected by the build scripts as plain
// unix seconds (no spaces, so the flag survives the PowerShell -> wails -> go
// quoting chain untouched). "0" means a plain `go build` — a dev run — and the
// UI hides the line then.
var BuildTimeUnix = "0"

// AppVersion reports the running build's version for the frontend's about page.
func (b *Backend) AppVersion() string { return AppVersion }

// BuildTime reports the link timestamp as raw unix seconds so the frontend can
// format it with the device's own timezone — Go's time.Local is unreliable
// inside the Android c-shared runtime, which is why the phone showed UTC.
// "0" (a plain `go build`, i.e. a dev run) formats to "" and the UI hides it.
func (b *Backend) BuildTime() string {
	return BuildTimeUnix
}
