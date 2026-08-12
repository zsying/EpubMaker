package main

import (
	"context"
	"embed"
	"io/fs"
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

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// Open + migrate the database up front so schema issues fail fast.
	if _, err := db.Open(); err != nil {
		log.Fatalf("[desktop] open database: %v", err)
	}

	// The embedded tree is rooted at frontend/dist; expose that subtree to the
	// HTTP handlers so static paths resolve to index.html, assets/, etc.
	assetRoot, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		log.Fatalf("[desktop] embedded frontend subdir: %v", err)
	}

	mux := server.NewMux(server.Config{Assets: assetRoot})
	// Mount Go-handled routes. The desktop backend serves every /api route
	// directly, so no external Express backend is required.
	api.Register(mux)

	appObj := app.NewApp()
	// .epub files passed on the command line (e.g. double-click / file
	// association) are queued for import on startup.
	appObj.QueueOpen(epubArgs(os.Args[1:]))

	err = wails.Run(&options.App{
		Title:  "EpubMaker",
		Width:  1180,
		Height: 820,
		// Wails serves static assets from the embedded frontend/dist first,
		// then falls back to our mux for /api/* and client-side SPA routes.
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: mux,
		},
		// Expose native OS integrations (file dialog, etc.) to the frontend.
		Bind: []any{appObj},
		OnStartup: func(ctx context.Context) {
			appObj.Startup(ctx)
			log.Printf("[desktop] EpubMaker ready")
		},
	})
	if err != nil {
		log.Fatal(err)
	}
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
