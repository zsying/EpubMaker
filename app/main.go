package main

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"

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

	// Open + migrate the database up front so schema issues fail fast.
	if _, err := db.Open(); err != nil {
		log.Fatalf("[desktop] open database: %v", err)
	}

	mux := server.NewMux(server.Config{WebDist: webDist})
	// Mount Go-handled routes. The desktop backend serves every /api route
	// directly, so no external Express backend is required.
	api.Register(mux)

	appObj := app.NewApp()
	// .epub files passed on the command line (e.g. double-click / file
	// association) are queued for import on startup.
	appObj.QueueOpen(epubArgs(os.Args[1:]))

	err := wails.Run(&options.App{
		Title:  "EpubMaker",
		Width:  1180,
		Height: 820,
		// Wails serves our handler (static frontend) directly to the webview.
		// The frontend calls /api same-origin and the Go backend answers.
		AssetServer: &assetserver.Options{
			Handler: mux,
		},
		// Expose native OS integrations (file dialog, etc.) to the frontend.
		Bind: []any{appObj},
		OnStartup: func(ctx context.Context) {
			appObj.Startup(ctx)
			log.Printf("[desktop] EpubMaker ready (webDist=%s)", webDist)
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
