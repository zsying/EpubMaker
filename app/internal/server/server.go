// Package server builds the desktop app's HTTP surface:
//   - static hosting of the built frontend (web/dist) with SPA fallback
//   - /api/* reverse proxy to the legacy Express backend during migration
//
// In Phase 0 EVERY /api route is proxied to Express (default :7802). As routes
// are ported to Go (Phase 1+), they are mounted before the proxy and the proxy
// only catches the not-yet-migrated ones.
package server

import (
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Config configures the desktop HTTP handler.
type Config struct {
	// WebDist is the absolute path to the built frontend (web/dist).
	WebDist string
	// APIUpstream is the base URL the /api proxy forwards to (e.g. http://127.0.0.1:7802).
	// Empty disables the proxy (used once Express is fully removed in Phase 5).
	APIUpstream string
}

// NewHandler returns an http.Handler serving the frontend and proxying /api.
func NewHandler(c Config) http.Handler {
	mux := http.NewServeMux()

	if c.APIUpstream != "" {
		up, err := url.Parse(c.APIUpstream)
		if err != nil {
			log.Printf("[server] invalid API_UPSTREAM %q: %v (proxy disabled)", c.APIUpstream, err)
		} else {
			rp := httputil.NewSingleHostReverseProxy(up)
			rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
				log.Printf("[server] api proxy error %s %s: %v", r.Method, r.URL.Path, err)
				http.Error(w, "api upstream unavailable", http.StatusBadGateway)
			}
			// Mount both "/api" and "/api/" so the proxy owns the whole namespace.
			mux.Handle("/api", rp)
			mux.Handle("/api/", rp)
		}
	}

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
