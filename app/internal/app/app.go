// Package app holds the Wails application bindings — native OS integrations
// exposed to the frontend (e.g. the file-open dialog used for local EPUB
// import). It is bound via wails.Run's Bind slice.
package app

import (
	"context"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the Wails application object. Wails calls Startup with the app context
// automatically; the context is needed for native dialogs.
type App struct {
	ctx context.Context
}

// NewApp constructs the application object.
func NewApp() *App { return &App{} }

// Startup captures the application context (called by Wails).
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
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
