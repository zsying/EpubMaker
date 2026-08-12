// Package server builds the desktop app's HTTP surface:
//   - static hosting of the built frontend (web/dist) with SPA fallback
//   - /api/* reverse proxy to the legacy Express backend for not-yet-migrated routes
//
// Go-handled /api routes are mounted on the returned mux (via the api package)
// BEFORE the proxy, so migrated routes take precedence. During Phase 0 every
// /api route is proxied; each phase narrows the proxy as routes are ported.
package server

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Config configures the desktop HTTP handler.
type Config struct {
	// WebDist is the absolute path to the built frontend (web/dist).
	WebDist string
}

// NewMux builds the desktop HTTP mux: static frontend hosting only. All /api
// routes are served by the Go backend (see the api package), so no reverse
// proxy to a legacy Express backend is needed.
func NewMux(c Config) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/", spaHandler(c.WebDist))
	return mux
}

// spaHandler serves static files from webDist and falls back to index.html for
// client-side routes. It blocks path traversal outside webDist.
func spaHandler(webDist string) http.Handler {
	fs := http.FileServer(http.Dir(webDist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		clean := filepath.Clean(r.URL.Path)
		if clean == "/" || clean == "." || clean == string(os.PathSeparator) {
			serveIndex(w, webDist)
			return
		}

		fp := filepath.Join(webDist, clean)
		// Traversal guard: the resolved path must stay inside webDist.
		if rel, err := filepath.Rel(webDist, fp); err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			serveIndex(w, webDist)
			return
		}

		info, err := os.Stat(fp)
		if err != nil || info.IsDir() {
			// Unknown path -> SPA fallback to index.html.
			serveIndex(w, webDist)
			return
		}
		fs.ServeHTTP(w, r)
	})
}

func serveIndex(w http.ResponseWriter, webDist string) {
	fp := filepath.Join(webDist, "index.html")
	f, err := os.Open(fp)
	if err != nil {
		http.Error(w, "frontend not built (web/dist missing)", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	io.Copy(w, f)
}
