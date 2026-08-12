// Package server builds the desktop app's HTTP surface:
//   - static hosting of the built frontend with SPA fallback
//   - /api/* routes are mounted by the api package before the mux is handed to Wails
//
// In production the frontend assets come from an embedded FS (see main.go).
// In tests a temp dir wrapped with os.DirFS can be substituted.
package server

import (
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// Config configures the desktop HTTP handler.
type Config struct {
	// Assets is the fs.FS containing the built frontend (e.g. embed.FS or os.DirFS).
	Assets fs.FS
}

// NewMux builds the desktop HTTP mux: static frontend hosting plus whatever
// /api routes the caller mounts on it before passing it to Wails.
func NewMux(c Config) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/", spaHandler(c.Assets))
	return mux
}

// spaHandler serves static files from assets and falls back to index.html for
// client-side routes. fs.FS itself prevents escaping the root.
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
