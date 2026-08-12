package main

import (
	"context"
	"log"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"

	"epubmaker-desktop/internal/api"
	"epubmaker-desktop/internal/app"
	"epubmaker-desktop/internal/db"
	"epubmaker-desktop/internal/server"
)

func main() {
	webDist := resolveWebDist()
	// All /api routes are now served by the Go service. EPUBMAKER_API_UPSTREAM
	// is only used as a safety-net reverse proxy for any route not yet handled
	// by Go (defaults to empty = no proxy).
	apiUpstream := os.Getenv("EPUBMAKER_API_UPSTREAM")

	// Open + migrate the database up front so schema issues fail fast.
	if _, err := db.Open(); err != nil {
		log.Fatalf("[desktop] open database: %v", err)
	}

	mux := server.NewMux(server.Config{
		WebDist:     webDist,
		APIUpstream: apiUpstream,
	})
	// Mount Go-handled routes; they take precedence over the /api proxy.
	api.Register(mux, apiUpstream)

	appObj := app.NewApp()

	err := wails.Run(&options.App{
		Title:  "EpubMaker",
		Width:  1180,
		Height: 820,
		// Wails serves our handler (static frontend + /api proxy) directly to the
		// webview. The frontend calls /api same-origin. Since every route is now
		// implemented in Go, no external Express backend is required.
		AssetServer: &assetserver.Options{
			Handler: mux,
		},
		// Expose native OS integrations (file dialog, etc.) to the frontend.
		Bind: []any{appObj},
		OnStartup: func(ctx context.Context) {
			appObj.Startup(ctx)
			log.Printf("[desktop] EpubMaker ready (webDist=%s, apiUpstream=%s)", webDist, apiUpstream)
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}

// resolveWebDist finds the built frontend. Override with EPUB_WEB_DIST.
func resolveWebDist() string {
	if v := os.Getenv("EPUB_WEB_DIST"); v != "" {
		return v
	}
	for _, cand := range []string{"../web/dist", "web/dist"} {
		if info, err := os.Stat(cand); err == nil && info.IsDir() {
			if abs, err := filepath.Abs(cand); err == nil {
				return abs
			}
			return cand
		}
	}
	return "../web/dist"
}
