// Command EpubMaker is the Wails v3 host for both the desktop app and the
// Android app.
//
// One entry point serves both: `go build` produces the windowed .exe, and
// `go build -buildmode=c-shared` (with the generated main_android.gen.go from
// `wails3 android overlay:gen`) produces the libwails.so the APK loads. The
// only platform-specific code sits behind platformInit(), in
// platform_android.go / platform_desktop.go.
//
// There is no HTTP server and no port: the whole data surface is exposed as
// in-process Wails bindings, and binary payloads (covers, rendered chapters,
// exports) travel inline as base64. Two things are served over the host's
// built-in asset URL — the frontend bundle, and the fonts the reader
// downloaded — both through internal/webassets.
package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"epubmaker-desktop/internal/app"
	"epubmaker-desktop/internal/db"
	"epubmaker-desktop/internal/webassets"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	trace("main: enter")

	// Android has no usable HOME; desktops need nothing here.
	platformInit()
	trace("home: " + os.Getenv("EPUBMAKER_HOME"))

	// Open + migrate the database before the window exists: a schema problem
	// should fail loudly, not surface as an empty bookshelf.
	if _, err := db.Open(); err != nil {
		trace("db.Open failed: " + err.Error())
		log.Fatalf("[app] open database: %v", err)
	}
	trace("db.Open done")

	appObj := app.NewApp()
	// .epub files passed on the command line (double-click / file
	// association) are imported before the window is shown.
	appObj.QueueOpen(epubArgs(os.Args[1:]))

	wailsApp := application.New(application.Options{
		Name:        "EpubMaker",
		Description: "EPUB reader and English learning",
		// App: native OS integrations (file dialogs, command-line opens).
		// Backend: every data operation, called in-process.
		Services: []application.Service{
			application.NewService(appObj),
			application.NewService(&app.Backend{}),
		},
		Assets: application.AssetOptions{
			// Not the stock file server: a route like /llm or /books/<id>/read
			// is not a file, and answering it with 404 is fatal on Android
			// (Chromium reads "no bytes" as "ask the network" and lands on
			// ERR_CONNECTION_REFUSED). See internal/webassets.
			Handler: serveFrontend(assets),
		},
		// Lets the OS hand a double-clicked book to this process instead of
		// launching a second copy that cannot find the file.
		FileAssociations: []string{".epub"},
		Windows: application.WindowsOptions{
			// WebView2 only listens for a debugger when the app asks it to, and
			// an env var keeps that out of ordinary launches. This is the
			// desktop counterpart of `adb forward ... webview_devtools_remote`
			// on a phone: EPUBMAKER_DEBUG_PORT=9222 + chrome://inspect.
			AdditionalBrowserArgs: debugArgs(),
		},
	})

	appObj.Attach(wailsApp)

	window := wailsApp.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "EpubMaker",
		Width:  1180,
		Height: 820,
		URL:    "/",
		// A webview drop only carries File objects with no path, and books are
		// imported from disk, never uploaded. This is what turns a drop into
		// absolute paths — and what stops the webview from navigating to the
		// dropped file instead.
		EnableFileDrop: true,
	})

	// The drop arrives as a native event; the frontend only needs the paths.
	window.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
		paths := e.Context().DroppedFiles()
		if len(paths) > 0 {
			window.EmitEvent("epub:dropped", paths)
		}
	})

	imported, importErrs := appObj.ImportPending()
	if imported > 0 || len(importErrs) > 0 {
		log.Printf("[app] command-line import: %d ok, %d failed %v", imported, len(importErrs), importErrs)
	}

	trace("window created")
	log.Printf("[app] EpubMaker ready")
	if err := wailsApp.Run(); err != nil {
		log.Fatal(err)
	}
	trace("run returned")
}

// serveFrontend returns the handler for everything that is not the Wails
// runtime itself.
//
// In production that is the embedded bundle (internal/webassets). With
// EPUBMAKER_DEV_URL set — what dev-windows.ps1 does — it proxies to the vite
// dev server instead, so the page origin, and with it every binding call,
// stays exactly what it is in production: a page served from the host, not
// from a dev server that knows nothing about /wails.
//
// The one thing the proxy cannot carry is vite's HMR websocket: the asset
// server answers upgrade requests with 501 before they get this far. Vite
// falls back to a full page reload on change, which is the behaviour to
// expect from a dev session here.
func serveFrontend(assets fs.FS) http.Handler {
	dev := strings.TrimSpace(os.Getenv("EPUBMAKER_DEV_URL"))
	if dev == "" {
		return webassets.Handler(assets)
	}
	u, err := url.Parse(dev)
	if err != nil || u.Host == "" {
		log.Printf("[app] ignoring EPUBMAKER_DEV_URL=%q: %v", dev, err)
		return webassets.Handler(assets)
	}
	log.Printf("[app] dev server: %s", dev)
	return httputil.NewSingleHostReverseProxy(u)
}

// debugArgs maps EPUBMAKER_DEBUG_PORT to WebView2's remote debugging switch.
func debugArgs() []string {
	port := strings.TrimSpace(os.Getenv("EPUBMAKER_DEBUG_PORT"))
	if port == "" {
		return nil
	}
	log.Printf("[app] webview debugging on port %s", port)
	return []string{"--remote-debugging-port=" + port}
}

// epubArgs returns the command-line arguments that look like .epub file paths,
// supporting double-click-to-open / Windows file association.
func epubArgs(args []string) []string {
	out := make([]string, 0, len(args))
	for _, a := range args {
		if strings.EqualFold(filepath.Ext(a), ".epub") {
			out = append(out, a)
		}
	}
	return out
}
