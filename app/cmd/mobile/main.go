// Command mobile is the Wails v3 entry point for the Android build.
//
// It shares every bit of business logic with the desktop app: the Backend
// struct in internal/app has no Wails dependency at all, so the same type is
// bound by wails v2 (desktop, main.go) and wails v3 (here) without a shim.
// Only the native integration layer (App, file dialogs) stays desktop-only —
// it is built on the v2 runtime and has no meaning inside an Android WebView.
package main

import (
	"embed"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"epubmaker-desktop/internal/app"
	"epubmaker-desktop/internal/config"
	"epubmaker-desktop/internal/db"
	"epubmaker-desktop/internal/webassets"
)

// The frontend bundle is the desktop build, copied into frontend/dist by the
// build task. One bundle serves both hosts; api.ts picks the transport at
// runtime (v2 window.go bindings, or v3 Call.ByName).
//
//go:embed all:frontend/dist
var assets embed.FS

func main() {
	trace("main: enter")

	// Android gives a process no usable HOME, so config.appHome() would fall
	// back to a path derived from an empty string. Pin it into the app's private
	// files directory instead. /proc/self/cmdline holds the package name on
	// Android; it is the one piece of identity a sandboxed process can read
	// about itself without going through the Java layer.
	if os.Getenv("EPUBMAKER_HOME") == "" {
		home := androidAppHome()
		trace("androidAppHome: " + home)
		if home != "" {
			if err := os.MkdirAll(home, 0o755); err == nil {
				os.Setenv("EPUBMAKER_HOME", home)
			}
			trace("MkdirAll done")
		}
	}
	trace("config.Get: " + config.Get().AppHome)

	// Open (and migrate) the database before the window exists, exactly like the
	// desktop entry point: a schema problem should fail loudly, not surface as an
	// empty bookshelf.
	if _, err := db.Open(); err != nil {
		trace("db.Open failed: " + err.Error())
		log.Fatalf("[mobile] open database: %v", err)
	}
	trace("db.Open done")

	wailsApp := application.New(application.Options{
		Name:        "EpubMaker",
		Description: "EPUB reader and English learning",
		Services: []application.Service{
			application.NewService(&app.Backend{}),
		},
		Assets: application.AssetOptions{
			// The same handler the desktop uses. It has to be here, not the
			// stock file server: a deep path (/llm, /books/<id>/read) is not a
			// file, and a 404 on this host is not a 404 — see webassets.
			Handler: webassets.Handler(assets),
		},
	})

	wailsApp.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "EpubMaker",
		URL:   "/",
	})
	trace("window created")

	if err := wailsApp.Run(); err != nil {
		log.Fatal(err)
	}
	trace("run returned")
}

// trace appends a startup breadcrumb to a file inside the app's private
// directory. Android does not route a Go process's stderr into logcat in
// c-shared mode, so when the process dies before the Java layer can report
// anything this file is the only evidence of how far startup got. Read it with
//   adb shell run-as com.wails.app cat files/trace.log
// (or `adb root` + cat on an emulator).
func trace(msg string) {
	dir := androidFilesDir()
	if dir == "" {
		return
	}
	f, err := os.OpenFile(dir+"/trace.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	f.WriteString(msg + "\n")
}

// androidFilesDir returns the app's private files directory as a plain path
// (no filesystem calls, so it works even when stat is unavailable).
func androidFilesDir() string {
	raw, err := os.ReadFile("/proc/self/cmdline")
	if err != nil {
		return ""
	}
	// The first NUL-separated field is the package name; later fields are
	// process arguments that may contain slashes, so stop at the first NUL.
	pkg := string(raw)
	if i := strings.IndexByte(pkg, 0); i >= 0 {
		pkg = pkg[:i]
	}
	if pkg == "" || strings.ContainsAny(pkg, "/\x00") {
		return ""
	}
	return "/data/data/" + pkg + "/files"
}

// androidAppHome is the data root: <app files dir>/.epubmaker, or "" when the
// package name cannot be determined (which means we are not really on Android).
func androidAppHome() string {
	dir := androidFilesDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, ".epubmaker")
}
