// Package app holds the Wails bindings — the data surface (Backend) and the
// native OS integrations (App: file dialogs, command-line / file-association
// imports) exposed to the frontend.
package app

import (
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"epubmaker-desktop/internal/library"
)

// App is the native-integration service. It is bound next to Backend, so the
// frontend reaches it as <module>/internal/app.App.<Method> — the same
// fully-qualified name shape Backend uses (see V3_APP_FQN in web/src/api.ts).
type App struct {
	// wails is the host this service was created for. It cannot be a package
	// global: tests construct an App without a running application, and the
	// dialogs below must degrade to "cancelled" instead of panicking.
	wails *application.App

	// pending holds .epub paths passed on the command line (double-click on a
	// file, or the Windows file association). They are imported before the
	// window is shown, so the shelf lists them on first paint.
	pending []string
}

// NewApp constructs the application object.
func NewApp() *App { return &App{} }

// Attach hands the service the host it will open dialogs on. Kept out of the
// constructor so internal/app stays importable by tests and by the mobile
// build, neither of which has a window.
func (a *App) Attach(wails *application.App) { a.wails = wails }

// QueueOpen records .epub paths supplied on the command line so ImportPending
// can import them.
func (a *App) QueueOpen(paths []string) {
	a.pending = append(a.pending, paths...)
}

// ImportPending imports every queued .epub and returns how many succeeded and
// any error messages. Called by the entry point before the window exists, so
// there is no event to emit: the first ListBooks already returns them.
func (a *App) ImportPending() (int, []string) {
	paths := a.pending
	a.pending = nil

	ok := 0
	errs := []string{}
	for _, p := range paths {
		if !strings.EqualFold(filepath.Ext(p), ".epub") {
			continue
		}
		name := filepath.Base(p)
		if _, err := library.ImportEpub(p, name, ""); err != nil {
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
	if a.wails == nil {
		return nil
	}
	paths, err := a.wails.Dialog.OpenFile().
		CanChooseFiles(true).
		SetTitle("选择 EPUB 文件").
		AddFilter("EPUB 电子书", "*.epub").
		PromptForMultipleSelection()
	if err != nil {
		// Cancelling a dialog is not an error the UI can act on.
		return nil
	}
	return paths
}

// SelectCoverFile opens a native single-select image dialog and returns the
// chosen path (empty if cancelled). The path is read on the Go side, so no
// binary upload is required.
func (a *App) SelectCoverFile() string {
	if a.wails == nil {
		return ""
	}
	path, err := a.wails.Dialog.OpenFile().
		CanChooseFiles(true).
		SetTitle("选择封面图片").
		AddFilter("图片文件", "*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp").
		PromptForSingleSelection()
	if err != nil {
		return ""
	}
	return path
}

// SelectDictFile opens a native dialog for an ECDICT-format csv. The file is
// read and imported on the Go side, so the 60 MB+ dictionary never passes
// through the WebView.
func (a *App) SelectDictFile() string {
	if a.wails == nil {
		return ""
	}
	path, err := a.wails.Dialog.OpenFile().
		CanChooseFiles(true).
		SetTitle("选择词库文件 (ECDICT csv)").
		AddFilter("ECDICT 词库 (*.csv)", "*.csv").
		PromptForSingleSelection()
	if err != nil {
		return ""
	}
	return path
}

// ExportBookTo asks for a destination with the native save dialog and builds the
// book's EPUB straight into it.
//
// This replaces the round trip the desktop used to make: BuildEpub into a
// bytes.Buffer, base64 that, hand it to the WebView, let the browser download
// it. Three copies of the book in memory at once, and nowhere for the result to
// go except the download folder — no 另存为, which is what a reader exporting a
// book usually wants. Now the bytes go from the builder to the file.
//
// A cancelled dialog is an answer, not an error: {"cancelled": true}, so the UI
// says nothing rather than showing a toast about a thing the reader chose to
// stop. The phone has no save dialog; it keeps using ExportBookFile + the share
// sheet, where a real file on disk is what the intent needs.
func (a *App) ExportBookTo(bookID string) (map[string]any, error) {
	name, err := library.ExportBookFileName(bookID)
	if err != nil {
		return nil, err
	}
	if a.wails == nil {
		return map[string]any{"cancelled": true}, nil
	}
	path, err := a.wails.Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
		Title:    "导出 EPUB",
		Filename: name,
		Filters:  []application.FileFilter{{DisplayName: "EPUB 电子书", Pattern: "*.epub"}},
	}).PromptForSingleSelection()
	if err != nil {
		return nil, err
	}
	if path == "" {
		return map[string]any{"cancelled": true}, nil
	}
	if err := library.ExportBookToFile(bookID, path); err != nil {
		return nil, err
	}
	return map[string]any{"path": path, "filename": filepath.Base(path)}, nil
}
