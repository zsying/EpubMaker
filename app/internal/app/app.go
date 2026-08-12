// Package app holds the Wails application bindings — native OS integrations
// exposed to the frontend (e.g. the file-open dialog used for local EPUB
// import) and command-line / file-association handling. It is bound via
// wails.Run's Bind slice.
package app

import (
	"context"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"epubmaker-desktop/internal/library"
)

// App is the Wails application object. Wails calls Startup with the app context
// automatically; the context is needed for native dialogs and events.
type App struct {
	ctx context.Context
	// pending holds .epub paths passed on the command line (e.g. via Windows
	// file association). They are imported during Startup.
	pending []string
}

// NewApp constructs the application object.
func NewApp() *App { return &App{} }

// QueueOpen records .epub paths supplied on the command line so Startup can
// import them (used by the .epub file association on Windows).
func (a *App) QueueOpen(paths []string) {
	a.pending = append(a.pending, paths...)
}

// Startup captures the application context (called by Wails) and imports any
// .epub files opened via command line / file association, emitting an
// "epub:imported" event so the frontend can refresh its library.
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	if len(a.pending) == 0 {
		return
	}
	imported, errors := a.importPending()
	a.pending = nil
	runtime.EventsEmit(a.ctx, "epub:imported", map[string]any{
		"imported": imported,
		"errors":   errors,
	})
}

// importPending imports every queued .epub and returns how many succeeded and
// any error messages.
func (a *App) importPending() (int, []string) {
	ok := 0
	errs := []string{}
	for _, p := range a.pending {
		if !strings.EqualFold(filepath.Ext(p), ".epub") {
			continue
		}
		name := filepath.Base(p)
		if _, err := library.ImportEpub(p, name); err != nil {
			errs = append(errs, name+": "+err.Error())
			continue
		}
		ok++
	}
	return ok, errs
}

// SelectEpubFiles opens a native multi-select file dialog and returns the
// chosen paths (empty if cancelled).
func (a *App) SelectEpubFiles() []string {
	paths, _ := runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择 EPUB 文件",
		Filters: []runtime.FileFilter{
			{DisplayName: "EPUB 电子书", Pattern: "*.epub"},
		},
	})
	return paths
}
