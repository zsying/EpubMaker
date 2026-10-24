package app

import (
	"strconv"
	"time"
)

// AppVersion is the version string surfaced by the 关于 page. Keep it in sync
// with app/wails.json (info.productVersion); either side may override it at
// build time with -ldflags "-X epubmaker-desktop/internal/app.AppVersion=x.y.z".
var AppVersion = "0.3.0"

// BuildTimeUnix is the link timestamp injected by the build scripts as plain
// unix seconds (no spaces, so the flag survives the PowerShell -> wails -> go
// quoting chain untouched). "0" means a plain `go build` — a dev run — and the
// UI hides the line then.
var BuildTimeUnix = "0"

// AppVersion reports the running build's version for the frontend's about page.
func (b *Backend) AppVersion() string { return AppVersion }

// BuildTime reports when this binary was linked, formatted for the about page.
// Empty on dev builds where no timestamp was injected.
func (b *Backend) BuildTime() string {
	if n, err := strconv.ParseInt(BuildTimeUnix, 10, 64); err == nil && n > 0 {
		return time.Unix(n, 0).Local().Format("2006-01-02 15:04")
	}
	return ""
}
