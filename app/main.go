package main

import (
	"context"
	"embed"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"

	"epubmaker-desktop/internal/app"
	"epubmaker-desktop/internal/db"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// Open + migrate the database up front so schema issues fail fast.
	if _, err := db.Open(); err != nil {
		log.Fatalf("[desktop] open database: %v", err)
	}

	appObj := app.NewApp()
	// .epub files passed on the command line (e.g. double-click / file
	// association) are queued for import on startup.
	appObj.QueueOpen(epubArgs(os.Args[1:]))

	// The entire data surface is exposed to the frontend as direct, in-process
	// Wails bindings (window.go.app.Backend.*). There is no HTTP server and no
	// port: dev and production behave identically.
	err := wails.Run(&options.App{
		Title:  "EpubMaker",
		Width:  1180,
		Height: 820,
		// Wails serves static assets from the embedded frontend/dist first,
		// then falls back to spaHandler for client-side routes (deep links /
		// refresh on a non-root path).
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: spaHandler(assets),
		},
		// App: native OS integrations (file dialogs, startup, file association).
		// Backend: every data operation, called in-process with no HTTP layer.
		Bind: []any{appObj, &app.Backend{}},
		OnStartup: func(ctx context.Context) {
			appObj.Startup(ctx)
			log.Printf("[desktop] EpubMaker ready")
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}

// spaHandler serves static files from the embedded assets and falls back to
// index.html for client-side routes. fs.FS itself prevents escaping the root.
func spaHandler(assets fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(assets))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		clean := path.Clean(r.URL.Path)
		if clean == "/" || clean == "." {
			serveIndex(w, assets)
			return
		}

		// fs.FS paths have no leading slash.
		fp := strings.TrimPrefix(clean, "/")
		if hasTraversal(fp) {
			serveIndex(w, assets)
			return
		}

		f, err := assets.Open(fp)
		if err != nil {
			serveIndex(w, assets)
			return
		}
		stat, err := f.Stat()
		_ = f.Close()
		if err != nil || stat.IsDir() {
			serveIndex(w, assets)
			return
		}

		fileServer.ServeHTTP(w, r)
	})
}

func serveIndex(w http.ResponseWriter, assets fs.FS) {
	f, err := assets.Open("index.html")
	if err != nil {
		http.Error(w, "frontend not built (index.html missing)", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	io.Copy(w, f)
}

func hasTraversal(p string) bool {
	for _, part := range strings.Split(p, "/") {
		if part == ".." {
			return true
		}
	}
	return false
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
