package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"

	"epubmaker-desktop/internal/library"
	"epubmaker-desktop/internal/mime"
)

/* ------------------------- /api/books ------------------------- */

// listBooksHandler serves GET /api/books (ported). Other methods fall through
// to the Express proxy.
func listBooksHandler(w http.ResponseWriter, r *http.Request) {
	kw := strings.TrimSpace(r.URL.Query().Get("keyword"))
	books, err := library.ListBooks(kw)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, books)
}

// booksSubHandler dispatches the /api/books/<...> subtree. Everything that is
// part of the library layer is handled in Go; EPUB-engine routes (import,
// render, split, export, covers) are still served by Express and fall through
// to the proxy.
func booksSubHandler(w http.ResponseWriter, r *http.Request, rp http.Handler) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/books/")
	segs := strings.Split(strings.Trim(rest, "/"), "/")
	if len(segs) == 0 || segs[0] == "" {
		rp.ServeHTTP(w, r)
		return
	}
	id := segs[0]
	sub := segs[1:]

	// /api/books/<id>
	if len(sub) == 0 {
		switch r.Method {
		case http.MethodGet:
			book, err := library.GetBook(id)
			if err != nil {
				fail(w, http.StatusInternalServerError, err.Error())
				return
			}
			if book == nil {
				fail(w, http.StatusNotFound, "书籍不存在")
				return
			}
			ok(w, book)
		case http.MethodPatch:
			var patch library.BookPatch
			if !decode(w, r, &patch) {
				return
			}
			book, err := library.UpdateBook(id, patch)
			if err != nil {
				fail(w, http.StatusInternalServerError, err.Error())
				return
			}
			if book == nil {
				fail(w, http.StatusNotFound, "书籍不存在")
				return
			}
			ok(w, book)
		case http.MethodDelete:
			deleted, moved, err := library.DeleteBook(id)
			if err != nil {
				fail(w, http.StatusInternalServerError, err.Error())
				return
			}
			if !deleted {
				fail(w, http.StatusNotFound, "书籍不存在")
				return
			}
			ok(w, map[string]any{"deleted": true, "movedToTrash": moved})
		default:
			rp.ServeHTTP(w, r)
		}
		return
	}

	switch sub[0] {
	case "chapters":
		// /api/books/<id>/chapters
		if len(sub) == 1 {
			switch r.Method {
			case http.MethodGet:
				chs, err := library.ListChapters(id)
				if err != nil {
					fail(w, http.StatusInternalServerError, err.Error())
					return
				}
				ok(w, chs)
			case http.MethodPost:
				var opts library.ChapterCreateOpts
				if !decode(w, r, &opts) {
					return
				}
				ch, err := library.CreateChapter(id, opts)
				if err != nil {
					fail(w, http.StatusInternalServerError, err.Error())
					return
				}
				if ch == nil {
					fail(w, http.StatusNotFound, "书籍不存在")
					return
				}
				ok(w, ch)
			default:
				rp.ServeHTTP(w, r)
			}
			return
		}

		// /api/books/<id>/chapters/reorder | /merge
		if len(sub) == 2 {
			if sub[1] == "reorder" && r.Method == http.MethodPost {
				var body struct {
					ChapterIds []string `json:"chapterIds"`
				}
				if !decode(w, r, &body) {
					return
				}
				chs, err := library.ReorderChapters(id, body.ChapterIds)
				if err != nil {
					fail(w, http.StatusInternalServerError, err.Error())
					return
				}
				ok(w, chs)
				return
			}
			if sub[1] == "merge" && r.Method == http.MethodPost {
				var body struct {
					TargetID  string   `json:"targetId"`
					SourceIds []string `json:"sourceIds"`
				}
				if !decode(w, r, &body) {
					return
				}
				chs, err := library.MergeChapters(id, body.TargetID, body.SourceIds)
				if err != nil {
					fail(w, http.StatusInternalServerError, err.Error())
					return
				}
				if chs == nil {
					fail(w, http.StatusNotFound, "目标章节不存在")
					return
				}
				ok(w, chs)
				return
			}

			// /api/books/<id>/chapters/<cid>
			cid := sub[1]
			switch r.Method {
			case http.MethodPatch:
				var patch library.ChapterPatch
				if !decode(w, r, &patch) {
					return
				}
				ch, err := library.UpdateChapter(id, cid, patch)
				if err != nil {
					fail(w, http.StatusInternalServerError, err.Error())
					return
				}
				if ch == nil {
					fail(w, http.StatusNotFound, "章节不存在")
					return
				}
				ok(w, ch)
			case http.MethodDelete:
				deleted, err := library.DeleteChapter(id, cid)
				if err != nil {
					fail(w, http.StatusInternalServerError, err.Error())
					return
				}
				if !deleted {
					fail(w, http.StatusNotFound, "章节不存在")
					return
				}
				ok(w, map[string]any{"deleted": true})
			default:
				rp.ServeHTTP(w, r)
			}
			return
		}

		// /api/books/<id>/chapters/<cid>/source | /render
		if len(sub) == 3 {
			if sub[2] == "source" && r.Method == http.MethodGet {
				src, err := library.GetChapterSource(id, sub[1])
				if err != nil {
					fail(w, http.StatusInternalServerError, err.Error())
					return
				}
				if src == nil {
					fail(w, http.StatusNotFound, "章节不存在")
					return
				}
				ok(w, src)
				return
			}
			if sub[2] == "render" {
				// renderChapter is part of the EPUB-engine (Phase 3).
				rp.ServeHTTP(w, r)
				return
			}
		}
		rp.ServeHTTP(w, r)
		return

	case "images":
		// /api/books/<id>/images
		if len(sub) == 1 && r.Method == http.MethodGet {
			imgs, err := library.ListImages(id)
			if err != nil {
				fail(w, http.StatusInternalServerError, err.Error())
				return
			}
			ok(w, imgs)
			return
		}
		rp.ServeHTTP(w, r)
		return

	case "assets":
		// /api/books/<id>/assets/<href...>  (EPUB-engine output, served in Go)
		if len(sub) >= 2 && r.Method == http.MethodGet {
			href := strings.Join(sub[1:], "/")
			file, err := library.AssetFilePath(id, href)
			if err != nil {
				fail(w, http.StatusBadRequest, "非法路径")
				return
			}
			info, statErr := os.Stat(file)
			if statErr != nil || info.IsDir() {
				fail(w, http.StatusNotFound, "资源不存在")
				return
			}
			f, ferr := os.Open(file)
			if ferr != nil {
				fail(w, http.StatusInternalServerError, ferr.Error())
				return
			}
			defer f.Close()
			w.Header().Set("Content-Type", mime.GuessMediaType(href))
			w.Header().Set("Cache-Control", "public, max-age=3600")
			io.Copy(w, f)
			return
		}
		rp.ServeHTTP(w, r)
		return

	case "covers":
		// uploadCover is part of the EPUB-engine (Phase 4).
		rp.ServeHTTP(w, r)
		return

	case "split":
		// splitBook is part of the EPUB-engine (Phase 3).
		rp.ServeHTTP(w, r)
		return

	case "export":
		// exportBook is part of the EPUB-engine (Phase 3).
		rp.ServeHTTP(w, r)
		return

	default:
		rp.ServeHTTP(w, r)
	}
}

/* ------------------------- /api/trash ------------------------- */

// trashListHandler serves GET /api/trash (ported). Other methods fall through
// to the Express proxy.
func trashListHandler(w http.ResponseWriter, r *http.Request) {
	items, err := library.ListTrash()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, items)
}

// trashSubHandler dispatches /api/trash/<id>/restore and /api/trash/<id>.
// The restore/purge logic is ported; anything else proxied.
func trashSubHandler(w http.ResponseWriter, r *http.Request, rp http.Handler) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/trash/")
	segs := strings.Split(strings.Trim(rest, "/"), "/")
	if len(segs) == 0 || segs[0] == "" {
		rp.ServeHTTP(w, r)
		return
	}
	id := segs[0]

	if len(segs) == 2 && segs[1] == "restore" && r.Method == http.MethodPost {
		book, err := library.RestoreBook(id)
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		if book == nil {
			fail(w, http.StatusNotFound, "回收站中不存在该书")
			return
		}
		ok(w, book)
		return
	}

	if len(segs) == 1 && r.Method == http.MethodDelete {
		purged, dataKept, err := library.PurgeBook(id)
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !purged {
			fail(w, http.StatusNotFound, "回收站中不存在该书")
			return
		}
		ok(w, map[string]any{"purged": true, "dataKept": dataKept})
		return
	}

	rp.ServeHTTP(w, r)
}

/* ------------------------- helpers ------------------------- */

// decode reads the JSON request body into dst. An absent or empty body is
// treated as the zero value (matching the TS `req.body ?? {}` behaviour).
// Returns false (and writes a 400) when the body is present but malformed.
func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	if r.Body == nil || r.ContentLength == 0 {
		return true
	}
	b, err := io.ReadAll(r.Body)
	if err != nil {
		fail(w, http.StatusBadRequest, "读取请求体失败: "+err.Error())
		return false
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return true
	}
	if err := json.Unmarshal(b, dst); err != nil {
		fail(w, http.StatusBadRequest, "请求体格式错误: "+err.Error())
		return false
	}
	return true
}
