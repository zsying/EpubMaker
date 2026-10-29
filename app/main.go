package main

import (
	"context"
	"embed"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"

	"epubmaker-desktop/internal/app"
	"epubmaker-desktop/internal/db"
	"epubmaker-desktop/internal/webassets"
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
		// then falls back to webassets.Handler for client-side routes (deep
		// links / refresh on a non-root path). The Android host uses the very
		// same handler.
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: webassets.Handler(assets),
		},
		// File drops are resolved natively: a webview drop only carries File
		// objects with no path, and books are imported from disk, never uploaded.
		// EnableFileDrop is what turns a drop into absolute paths (and what stops
		// the webview from navigating to the dropped file instead).
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop: true,
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
