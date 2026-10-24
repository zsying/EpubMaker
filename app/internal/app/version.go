package app

// AppVersion is the version string surfaced by the 关于 page. Keep it in sync
// with app/wails.json (info.productVersion); either side may override it at
// build time with -ldflags "-X epubmaker-desktop/internal/app.AppVersion=x.y.z".
var AppVersion = "0.3.0"

// AppVersion reports the running build's version for the frontend's about page.
func (b *Backend) AppVersion() string { return AppVersion }
