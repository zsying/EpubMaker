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
	"epubmaker-desktop/internal/db"
	"epubmaker-desktop/internal/server"
)

func main() {
	webDist := resolveWebDist()
	apiUpstream := os.Getenv("EPUBMAKER_API_UPSTREAM")
	if apiUpstream == "" {
		// During migration the not-yet-ported /api routes still live in Express.
		apiUpstream = "http://127.0.0.1:7802"
	}

	// Open + migrate the database up front so schema issues fail fast.
	if _, err := db.Open(); err != nil {
		log.Fatalf("[desktop] open database: %v", err)
	}

	mux := server.NewMux(server.Config{
		WebDist:     webDist,
		APIUpstream: apiUpstream,
	})
	// Mount Go-handled routes; they take precedence over the /api proxy.
	api.Register(mux)

	err := wails.Run(&options.App{
		Title:  "EpubMaker",
		Width:  1180,
		Height: 820,
		// Wails serves our handler (static frontend + /api proxy) directly to the
		// webview. The frontend calls /api same-origin, which we proxy to Express
		// until each route is ported to Go. Single-binary embedding of web/dist is
		// deferred to Phase 5.
		AssetServer: &assetserver.Options{
			Handler: mux,
		},
		OnStartup: func(ctx context.Context) {
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
