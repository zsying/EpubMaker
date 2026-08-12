// Package storage maps EPUB-internal relative paths to disk and manages the
// trash (soft-delete) model. Port of server/src/services/storage.ts.
//
// Red line: resource primary key = the original zip-internal path. We store it
// verbatim (no decoding), and contentPath() guards against path traversal.
package storage

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"epubmaker-desktop/internal/config"
)

// BookDir is <books>/<id>.
func BookDir(bookID string) string {
	return filepath.Join(config.Get().Paths.Books, bookID)
}

// ContentDir is <books>/<id>/content.
func ContentDir(bookID string) string {
	return filepath.Join(BookDir(bookID), "content")
}

// NormalizeHref cleans a forward-slash href WITHOUT decoding it, so the zip
// path key is preserved exactly.
func NormalizeHref(href string) string {
	h := strings.ReplaceAll(href, "\\", "/")
	return path.Clean(h)
}

// ContentPath resolves a content-relative href to an absolute disk path,
// refusing traversal outside the content directory.
func ContentPath(bookID, href string) (string, error) {
	base := ContentDir(bookID)
	norm := NormalizeHref(href)
	joined := filepath.Join(base, filepath.FromSlash(norm))
	rel, err := filepath.Rel(base, joined)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("illegal resource path: %s", href)
	}
	return joined, nil
}

// WriteContent writes (creating parent dirs) a content file.
func WriteContent(bookID, href string, data []byte) error {
	p, err := ContentPath(bookID, href)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o644)
}

// ReadContent reads a content file.
func ReadContent(bookID, href string) ([]byte, error) {
	p, err := ContentPath(bookID, href)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(p)
}

// ReadContentText reads a content file as UTF-8 text.
func ReadContentText(bookID, href string) (string, error) {
	b, err := ReadContent(bookID, href)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// ContentExists reports whether a content file exists.
func ContentExists(bookID, href string) bool {
	p, err := ContentPath(bookID, href)
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

// ContentSize returns the byte size of a content file (0 if missing).
func ContentSize(bookID, href string) int64 {
	p, err := ContentPath(bookID, href)
	if err != nil {
		return 0
	}
	info, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return info.Size()
}

// TrashRoot is <data>/trash.
func TrashRoot() string {
	return filepath.Join(config.Get().Paths.Data, "trash")
}

// MoveBookDirToTrash renames the book directory into the trash (rename, not
// delete, so it stays recoverable and avoids bulk-delete guards).
func MoveBookDirToTrash(bookID string) bool {
	dir := BookDir(bookID)
	if _, err := os.Stat(dir); err != nil {
		return false
	}
	trash := filepath.Join(TrashRoot(), fmt.Sprintf("%s-%d", bookID, time.Now().UnixMilli()))
	if err := os.MkdirAll(filepath.Dir(trash), 0o755); err != nil {
		return false
	}
	if err := os.Rename(dir, trash); err != nil {
		return false
	}
	return true
}

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

// FindTrashDir locates the trashed directory for a book id (matches <id>-<ts>).
func FindTrashDir(bookID string) string {
	root := TrashRoot()
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if uuidRe.FindString(e.Name()) == bookID {
			full := filepath.Join(root, e.Name())
			if info, err := os.Stat(full); err == nil && info.IsDir() {
				return full
			}
		}
	}
	return ""
}

// RemoveBookDir physically deletes the trashed (or, as a fallback, live)
// directory. If removal is blocked (sandbox), it is moved into trash/_purged
// so data is retained rather than silently lost.
func RemoveBookDir(bookID string) {
	dir := FindTrashDir(bookID)
	if dir == "" {
		dir = BookDir(bookID)
	}
	if dir == "" {
		return
	}
	if _, err := os.Stat(dir); err != nil {
		return
	}
	if err := os.RemoveAll(dir); err != nil {
		purged := filepath.Join(TrashRoot(), "_purged")
		_ = os.MkdirAll(purged, 0o755)
		_ = os.Rename(dir, filepath.Join(purged, filepath.Base(dir)))
	}
}

// SanitizeFileName makes a string safe for use as a filename.
func SanitizeFileName(name string) string {
	repl := strings.NewReplacer("\\", "_", "/", "_", ":", "_", "*", "_", "?", "_", "\"", "_", "<", "_", ">", "_", "|", "_")
	out := repl.Replace(name)
	out = regexp.MustCompile(`[\x00-\x1f]`).ReplaceAllString(out, "_")
	out = regexp.MustCompile(`\s+`).ReplaceAllString(out, " ")
	out = strings.TrimSpace(out)
	if len([]rune(out)) > 120 {
		out = string([]rune(out)[:120])
	}
	if out == "" {
		out = "book"
	}
	return out
}

// TempPath returns a temp file path under the configured tmp dir for a
// downloaded/uploaded file named name. Callers are responsible for cleanup.
func TempPath(name string) string {
	base := SanitizeFileName(name)
	if base == "" {
		base = "download.tmp"
	}
	return filepath.Join(config.Get().Paths.Tmp,
		fmt.Sprintf("%d-%s", time.Now().UnixNano(), base))
}
