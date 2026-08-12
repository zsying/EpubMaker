// Package api registers Go-handled /api routes on the desktop mux.
// In Phase 1 it owns /api/health and /api/config; later phases add more and
// the proxy in server.NewMux only catches the remaining un-migrated routes.
package api

import (
	"encoding/json"
	"net/http"
	"time"

	"epubmaker-desktop/internal/config"
)

// Register mounts the Go-handled API routes on mux. Must be called before the
// mux is served; these exact patterns take precedence over the /api/ proxy.
func Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/health", healthHandler)
	mux.HandleFunc("/api/config", configHandler)
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
