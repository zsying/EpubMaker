// Package app holds the Wails application bindings. Two structs are bound to
// the frontend, both through the host's own runtime since 0.4:
//
//   - App:     native OS integrations — the file dialogs (SelectEpubFiles,
//     SelectCoverFile, SelectDictFile). Window creation, the file association
//     and command-line parsing live in main.go, not here.
//   - Backend: the entire data surface, exposed as direct in-process calls:
//     Call.ByName('epubmaker-desktop/internal/app.Backend.<Method>') — no
//     HTTP, no ports.
//
// This replaces the old HTTP /api mux. Binary responses (cover images, chapter
// render, exported EPUB) are inlined as base64 data URLs / data strings so the
// WebView never needs a separate asset server.
package app

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"epubmaker-desktop/internal/config"
	"epubmaker-desktop/internal/epub"
	"epubmaker-desktop/internal/library"
	"epubmaker-desktop/internal/webdav"
)

// Backend exposes every data operation to the frontend via Wails bindings.
type Backend struct{}

/* ----------------------------- config / paths ----------------------------- */

// Paths returns the resolved application directories for display in the UI.
func (b *Backend) Paths() (map[string]string, error) {
	c := config.Get()
	return map[string]string{
		"appHome":    c.AppHome,
		"configFile": c.ConfigFile,
		"dataDir":    c.Paths.Data,
		"exportDir":  c.Paths.Exports,
		"logDir":     c.Paths.Logs,
		"dbFile":     c.Paths.DbFile,
	}, nil
}

/* ----------------------------- books ----------------------------- */

func (b *Backend) ListBooks(keyword string) ([]library.BookDTO, error) {
	return library.ListBooks(keyword)
}

func (b *Backend) GetBook(id string) (*library.BookDTO, error) {
	book, err := library.GetBook(id)
	if err != nil {
		return nil, err
	}
	if book == nil {
		return nil, fmt.Errorf("书籍不存在")
	}
	return book, nil
}

func (b *Backend) UpdateBook(id string, patch library.BookPatch) (*library.BookDTO, error) {
	book, err := library.UpdateBook(id, patch)
	if err != nil {
		return nil, err
	}
	if book == nil {
		return nil, fmt.Errorf("书籍不存在")
	}
	return book, nil
}

func (b *Backend) DeleteBook(id string) (map[string]any, error) {
	deleted, moved, err := library.DeleteBook(id)
	if err != nil {
		return nil, err
	}
	if !deleted {
		return nil, fmt.Errorf("书籍不存在")
	}
	return map[string]any{"deleted": true, "movedToTrash": moved}, nil
}

// ImportPaths imports EPUB files directly from local filesystem paths (chosen
// through the native file dialog) — no multipart upload over HTTP. Files whose
// book is already on the shelf (same file bytes, or same epub identifier for
// books imported before hashing) are skipped and reported as duplicates, not
// failures.
func (b *Backend) ImportPaths(paths []string) (map[string]any, error) {
	created := []library.BookDTO{}
	errorsOut := []string{}
	duplicates := []string{}
	for _, p := range paths {
		if !strings.HasSuffix(strings.ToLower(p), ".epub") {
			errorsOut = append(errorsOut, fmt.Sprintf("%s: 不是 EPUB 文件", p))
			continue
		}
		book, err := library.ImportEpub(p, filepath.Base(p))
		if errors.Is(err, library.ErrDuplicate) {
			// "duplicate:已有书名" — surface the shelf copy, skip quietly.
			duplicates = append(duplicates, fmt.Sprintf("%s（已有《%s》）",
				filepath.Base(p), strings.TrimPrefix(err.Error(), "duplicate:")))
			continue
		}
		if err != nil {
			errorsOut = append(errorsOut, fmt.Sprintf("%s: %s", filepath.Base(p), err.Error()))
			continue
		}
		created = append(created, *book)
	}
	if len(created) == 0 && len(duplicates) == 0 {
		return nil, fmt.Errorf("%s", strings.Join(errorsOut, "\n"))
	}
	return map[string]any{"books": created, "errors": errorsOut, "duplicates": duplicates}, nil
}

/* ----------------------------- chapters ----------------------------- */

func (b *Backend) ListChapters(bookID string) ([]library.ChapterDTO, error) {
	return library.ListChapters(bookID)
}

// BookTOC returns the hierarchical table-of-contents tree for a book. Older
// books (imported before hierarchy support) return an empty slice.
func (b *Backend) BookTOC(bookID string) ([]epub.TOCEntry, error) {
	return library.GetBookTOC(bookID)
}

func (b *Backend) CreateChapter(bookID string, opts library.ChapterCreateOpts) (*library.ChapterDTO, error) {
	ch, err := library.CreateChapter(bookID, opts)
	if err != nil {
		return nil, err
	}
	if ch == nil {
		return nil, fmt.Errorf("书籍不存在")
	}
	return ch, nil
}

func (b *Backend) UpdateChapter(bookID, cid string, patch library.ChapterPatch) (*library.ChapterDTO, error) {
	ch, err := library.UpdateChapter(bookID, cid, patch)
	if err != nil {
		return nil, err
	}
	if ch == nil {
		return nil, fmt.Errorf("章节不存在")
	}
	return ch, nil
}

func (b *Backend) DeleteChapter(bookID, cid string) (map[string]any, error) {
	deleted, err := library.DeleteChapter(bookID, cid)
	if err != nil {
		return nil, err
	}
	if !deleted {
		return nil, fmt.Errorf("章节不存在")
	}
	return map[string]any{"deleted": true}, nil
}

func (b *Backend) ReorderChapters(bookID string, orderedIDs []string) ([]library.ChapterDTO, error) {
	return library.ReorderChapters(bookID, orderedIDs)
}

func (b *Backend) MergeChapters(bookID, targetID string, sourceIDs []string) ([]library.ChapterDTO, error) {
	chs, err := library.MergeChapters(bookID, targetID, sourceIDs)
	if err != nil {
		return nil, err
	}
	if chs == nil {
		return nil, fmt.Errorf("目标章节不存在")
	}
	return chs, nil
}

func (b *Backend) ChapterSource(bookID, cid string) (*library.ChapterSource, error) {
	out, err := library.GetChapterSource(bookID, cid)
	if err != nil {
		return nil, err
	}
	if out == nil {
		return nil, fmt.Errorf("章节不存在")
	}
	return out, nil
}

func (b *Backend) RenderChapter(bookID, cid string) (*library.ChapterRender, error) {
	out, err := library.RenderChapter(bookID, cid)
	if err != nil {
		return nil, err
	}
	if out == nil {
		return nil, fmt.Errorf("章节不存在")
	}
	return out, nil
}

/* ----------------------------- reading: progress / bookmarks / annotations ----------------------------- */

func (b *Backend) GetProgress(bookID string) (*library.ReadingProgress, error) {
	return library.GetProgress(bookID)
}

// ListProgress folds each book's saved position into a shelf-level fraction
// (0..1) so the library can show "10%" beside the author without one round
// trip per book.
func (b *Backend) ListProgress() ([]library.BookProgress, error) {
	return library.ListProgress()
}

func (b *Backend) SaveProgress(bookID, chapterID string, positionOffset, pageCount int) (*library.ReadingProgress, error) {
	return library.SaveProgress(bookID, chapterID, positionOffset, pageCount)
}

func (b *Backend) ListBookmarks(bookID string) ([]library.Bookmark, error) {
	return library.ListBookmarks(bookID)
}

func (b *Backend) AddBookmark(bookID, chapterID string, anchor int, label string) (*library.Bookmark, error) {
	return library.AddBookmark(bookID, chapterID, anchor, label)
}

func (b *Backend) DeleteBookmark(id string) error {
	return library.DeleteBookmark(id)
}

func (b *Backend) ListAnnotations(bookID string) ([]library.Annotation, error) {
	return library.ListAnnotations(bookID)
}

func (b *Backend) AddAnnotation(bookID, chapterID string, startOffset, endOffset, pageIndex int, text, color, note string) (*library.Annotation, error) {
	return library.AddAnnotation(bookID, chapterID, startOffset, endOffset, pageIndex, text, color, note)
}

func (b *Backend) UpdateAnnotation(id, color, note string) (*library.Annotation, error) {
	return library.UpdateAnnotation(id, color, note)
}

func (b *Backend) DeleteAnnotation(id string) error {
	return library.DeleteAnnotation(id)
}

func (b *Backend) ListAllBookmarks() ([]library.BookmarkListItem, error) {
	return library.ListAllBookmarks()
}

func (b *Backend) ListAllAnnotations() ([]library.AnnotationListItem, error) {
	return library.ListAllAnnotations()
}

/* ----------------------------- assets / covers / split / export ----------------------------- */

func (b *Backend) ListImages(bookID string) ([]library.ImageAsset, error) {
	return library.ListImages(bookID)
}

// UploadCoverPath stores a cover image chosen through the native file dialog.
func (b *Backend) UploadCoverPath(bookID, path string) (*library.UploadedCover, error) {
	buf, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return library.UploadCover(bookID, filepath.Base(path), buf)
}

func (b *Backend) SplitBook(bookID string, parts []library.SplitPart, deleteSource bool) ([]*library.BookDTO, error) {
	return library.SplitBook(bookID, parts, deleteSource)
}

// ExportBook builds the book's EPUB and returns it inline as a base64 data URL
// so the frontend can trigger a download without an HTTP endpoint.
func (b *Backend) ExportBook(bookID string) (map[string]any, error) {
	var buf bytes.Buffer
	fn, err := library.ExportBook(bookID, &buf)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"filename": fn,
		"dataUrl":  library.DataURL("application/epub+zip", buf.Bytes()),
	}, nil
}

/* ----------------------------- trash ----------------------------- */

func (b *Backend) ListTrash() ([]library.TrashItem, error) {
	return library.ListTrash()
}

func (b *Backend) RestoreBook(id string) (*library.BookDTO, error) {
	book, err := library.RestoreBook(id)
	if err != nil {
		return nil, err
	}
	if book == nil {
		return nil, fmt.Errorf("回收站中不存在该书")
	}
	return book, nil
}

func (b *Backend) PurgeBook(id string) (map[string]any, error) {
	purged, dataKept, err := library.PurgeBook(id)
	if err != nil {
		return nil, err
	}
	if !purged {
		return nil, fmt.Errorf("回收站中不存在该书")
	}
	return map[string]any{"purged": true, "dataKept": dataKept}, nil
}

/* ----------------------------- webdav ----------------------------- */

func (b *Backend) WebdavTest(conn map[string]any) (map[string]any, error) {
	c, err := webdav.NormalizeConn(conn)
	if err != nil {
		return map[string]any{"connected": false, "error": err.Error()}, nil
	}
	res, err := webdav.TestWebDav(c)
	if err != nil {
		return map[string]any{"connected": false, "error": err.Error()}, nil
	}
	return map[string]any{"connected": res.Connected, "server": res.Server, "error": res.Error}, nil
}

func (b *Backend) WebdavList(conn map[string]any, dirPath string) ([]webdav.Entry, error) {
	c, err := webdav.NormalizeConn(conn)
	if err != nil {
		return nil, err
	}
	return webdav.ListWebDav(c, dirPath)
}

func (b *Backend) WebdavImport(conn map[string]any, items []map[string]any) (map[string]any, error) {
	c, err := webdav.NormalizeConn(conn)
	if err != nil {
		return nil, err
	}
	created := []library.BookDTO{}
	errorsOut := []string{}
	for _, it := range items {
		filePath, _ := it["path"].(string)
		name, _ := it["name"].(string)
		if name == "" {
			name = baseNameOf(filePath)
		}
		if !strings.HasSuffix(strings.ToLower(filePath), ".epub") && !strings.HasSuffix(strings.ToLower(name), ".epub") {
			errorsOut = append(errorsOut, name+": 不是 EPUB 文件")
			continue
		}
		tmp := webdav.TempPath(name)
		if e := webdav.DownloadWebDavFile(c, filePath, tmp); e != nil {
			errorsOut = append(errorsOut, name+": "+e.Error())
			continue
		}
		book, e := library.ImportEpub(tmp, name)
		_ = os.Remove(tmp)
		if e != nil {
			errorsOut = append(errorsOut, name+": "+e.Error())
			continue
		}
		created = append(created, *book)
	}
	if len(created) == 0 {
		return nil, fmt.Errorf("%s", strings.Join(errorsOut, "\n"))
	}
	return map[string]any{"books": created, "errors": errorsOut}, nil
}

func baseNameOf(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' || p[i] == '\\' {
			return p[i+1:]
		}
	}
	return p
}
