package app

import (
	"os"
	"path/filepath"
	"time"

	"epubmaker-desktop/internal/config"
	"epubmaker-desktop/internal/library"
	"epubmaker-desktop/internal/logx"
)

// ExportBookFile builds a book's EPUB into the app's export staging directory
// and answers with the absolute path plus the file name. The desktop keeps
// ExportBook (a base64 data URL the browser downloads); the phone has no
// download to trigger, so its 导出 hands the file to the system share sheet —
// and an ACTION_SEND intent needs a real file on disk behind a FileProvider.
//
// The staging directory is not a library: every file in it is a copy the
// receiving app has either copied or abandoned, so anything older than a day
// is swept on the way in.
func (b *Backend) ExportBookFile(bookID string) (map[string]any, error) {
	dir := filepath.Join(config.Get().AppHome, "tmp", "export")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	cutoff := time.Now().Add(-24 * time.Hour)
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if info, err := e.Info(); err == nil && info.ModTime().Before(cutoff) {
				_ = os.Remove(filepath.Join(dir, e.Name()))
			}
		}
	}

	tmp, err := os.CreateTemp(dir, "build-*")
	if err != nil {
		return nil, err
	}
	tmpPath := tmp.Name()
	fn, buildErr := library.ExportBook(bookID, tmp)
	closeErr := tmp.Close()
	if buildErr != nil || closeErr != nil {
		_ = os.Remove(tmpPath)
		if buildErr != nil {
			return nil, buildErr
		}
		return nil, closeErr
	}

	// The staged name is the book's sanitized title; an export of the same
	// book replaces its predecessor rather than piling up copies.
	path := filepath.Join(dir, fn)
	_ = os.Remove(path)
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return nil, err
	}
	logx.Event(logx.LevelInfo, "export", "EPUB 已生成待分享", "path", path)
	return map[string]any{"path": path, "filename": fn}, nil
}
