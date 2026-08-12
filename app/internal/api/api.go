// Package api registers Go-handled /api routes on the desktop mux.
// Each phase adds more routes here; anything not yet ported falls through to
// the legacy Express backend via the reverse proxy passed to Register.
package api

import (
	"encoding/json"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"

	"epubmaker-desktop/internal/config"
)

// Register mounts the Go-handled API routes on mux. Exact/more-specific
// patterns win over the /api proxy, so ported routes take precedence and the
// rest are forwarded to apiUpstream (Express).
func Register(mux *http.ServeMux, apiUpstream string) {
	mux.HandleFunc("/api/health", healthHandler)
	mux.HandleFunc("/api/config", configHandler)

	rp := buildProxy(apiUpstream)

	mux.HandleFunc("/api/books", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			listBooksHandler(w, r)
			return
		}
		if rp != nil {
			rp.ServeHTTP(w, r)
			return
		}
		fail(w, http.StatusBadGateway, "api upstream unavailable")
	})
	// Import via multipart upload (browser file picker).
	mux.HandleFunc("/api/books/import", func(w http.ResponseWriter, r *http.Request) {
		importHandler(w, r, rp)
	})
	// Import by local filesystem paths (desktop native file dialog).
	mux.HandleFunc("/api/books/import-paths", func(w http.ResponseWriter, r *http.Request) {
		importPathsHandler(w, r, rp)
	})
	// /api/books/<id> and all its sub-resources (chapters, assets, render,
	// covers, split, export). Exact patterns above win over this subtree.
	mux.HandleFunc("/api/books/", func(w http.ResponseWriter, r *http.Request) {
		booksSubHandler(w, r, rp)
	})

	mux.HandleFunc("/api/trash", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			trashListHandler(w, r)
			return
		}
		if rp != nil {
			rp.ServeHTTP(w, r)
			return
		}
		fail(w, http.StatusBadGateway, "api upstream unavailable")
	})
	mux.HandleFunc("/api/trash/", func(w http.ResponseWriter, r *http.Request) {
		trashSubHandler(w, r, rp)
	})

	// WebDAV (ported from Express).
	mux.HandleFunc("/api/webdav/test", func(w http.ResponseWriter, r *http.Request) {
		webdavTestHandler(w, r, rp)
	})
	mux.HandleFunc("/api/webdav/list", func(w http.ResponseWriter, r *http.Request) {
		webdavListHandler(w, r, rp)
	})
	mux.HandleFunc("/api/webdav/import", func(w http.ResponseWriter, r *http.Request) {
		webdavImportHandler(w, r, rp)
	})
}

func buildProxy(upstream string) http.Handler {
	if upstream == "" {
		return nil
	}
	u, err := url.Parse(upstream)
	if err != nil {
		return nil
	}
	rp := httputil.NewSingleHostReverseProxy(u)
	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		fail(w, http.StatusBadGateway, "api upstream unavailable: "+err.Error())
	}
	return rp
}

func ok(w http.ResponseWriter, data any) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "data": data})
}

func fail(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": msg})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
	ok(w, map[string]any{
		"status": "ok",
		"time":   time.Now().UTC().Format(time.RFC3339),
	})
}

func configHandler(w http.ResponseWriter, _ *http.Request) {
	c := config.Get()
	ok(w, map[string]any{
		"appHome":    c.AppHome,
		"configFile": c.ConfigFile,
		"dataDir":    c.Paths.Data,
		"exportDir":  c.Paths.Exports,
		"logDir":     c.Paths.Logs,
		"dbFile":     c.Paths.DbFile,
	})
}
