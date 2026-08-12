package api

import (
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"

	"epubmaker-desktop/internal/config"
	"epubmaker-desktop/internal/library"
	"epubmaker-desktop/internal/storage"
)

/* ------------------------- import ------------------------- */

// importHandler handles POST /api/books/import (multipart, field "files").
func importHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	if err := r.ParseMultipartForm(int64(config.Get().MaxUploadSizeMb) * 1024 * 1024); err != nil {
		fail(w, http.StatusBadRequest, "解析上传失败: "+err.Error())
		return
	}
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		fail(w, http.StatusBadRequest, "未收到文件")
		return
	}

	created := []library.BookDTO{}
	errorsOut := []string{}
	for _, fh := range files {
		name := fh.Filename
		tmp := storage.TempPath(name)
		if err := saveUploadTo(fh, tmp); err != nil {
			errorsOut = append(errorsOut, fmt.Sprintf("%s: %s", name, err.Error()))
			continue
		}
		book, err := library.ImportEpub(tmp, name)
		_ = os.Remove(tmp)
		if err != nil {
			errorsOut = append(errorsOut, fmt.Sprintf("%s: %s", name, err.Error()))
			continue
		}
		created = append(created, *book)
	}
	if len(created) == 0 {
		fail(w, http.StatusBadRequest, joinErrors(errorsOut))
		return
	}
	ok(w, map[string]any{"books": created, "errors": errorsOut})
}

// importPathsHandler handles POST /api/books/import-paths (JSON {paths:[]}) for
// the desktop native file dialog — imports directly from local filesystem paths.
func importPathsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	var body struct {
		Paths []string `json:"paths"`
	}
	if !decode(w, r, &body) {
		return
	}
	if len(body.Paths) == 0 {
		fail(w, http.StatusBadRequest, "未选择要导入的文件")
		return
	}
	created := []library.BookDTO{}
	errorsOut := []string{}
	for _, p := range body.Paths {
		if !stringsHasSuffixFold(p, ".epub") {
			errorsOut = append(errorsOut, fmt.Sprintf("%s: 不是 EPUB 文件", p))
			continue
		}
		name := filepath.Base(p)
		book, err := library.ImportEpub(p, name)
		if err != nil {
			errorsOut = append(errorsOut, fmt.Sprintf("%s: %s", name, err.Error()))
			continue
		}
		created = append(created, *book)
	}
	if len(created) == 0 {
		fail(w, http.StatusBadRequest, joinErrors(errorsOut))
		return
	}
	ok(w, map[string]any{"books": created, "errors": errorsOut})
}

func saveUploadTo(fh *multipart.FileHeader, dest string) error {
	src, err := fh.Open()
	if err != nil {
		return err
	}
	defer src.Close()
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	dst, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer dst.Close()
	_, err = io.Copy(dst, src)
	return err
}

func readMultipartBytes(fh *multipart.FileHeader) ([]byte, error) {
	src, err := fh.Open()
	if err != nil {
		return nil, err
	}
	defer src.Close()
	return io.ReadAll(src)
}

/* ------------------------- covers ------------------------- */

// coversHandler handles POST /api/books/<id>/covers (multipart, field "cover").
func coversHandler(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	if err := r.ParseMultipartForm(64 * 1024 * 1024); err != nil {
		fail(w, http.StatusBadRequest, "解析上传失败: "+err.Error())
		return
	}
	files := r.MultipartForm.File["cover"]
	if len(files) == 0 {
		fail(w, http.StatusBadRequest, "未收到封面文件")
		return
	}
	fh := files[0]
	name := fh.Filename
	buf, err := readMultipartBytes(fh)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	out, err := library.UploadCover(id, name, buf)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	ok(w, out)
}

/* ------------------------- split ------------------------- */

// splitHandler handles POST /api/books/<id>/split.
func splitHandler(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	var body struct {
		Parts        []library.SplitPart `json:"parts"`
		DeleteSource bool                `json:"deleteSource"`
	}
	if !decode(w, r, &body) {
		return
	}
	if len(body.Parts) == 0 {
		fail(w, http.StatusBadRequest, "请至少提供一个分卷")
		return
	}
	books, err := library.SplitBook(id, body.Parts, body.DeleteSource)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, books)
}

/* ------------------------- export ------------------------- */

// exportHandler handles GET /api/books/<id>/export, streaming the built EPUB.
func exportHandler(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		fail(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	fileName, err := library.ExportBookFileName(id)
	if err != nil {
		fail(w, http.StatusNotFound, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/epub+zip")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, fileName, url.PathEscape(fileName)))
	if _, err := library.ExportBook(id, w); err != nil {
		// Headers are already sent; log and stop.
		fmt.Fprintf(os.Stderr, "[api] export %s failed: %v\n", id, err)
		return
	}
}

/* ------------------------- render ------------------------- */

// renderHandler handles GET /api/books/<id>/chapters/<cid>/render.
func renderHandler(w http.ResponseWriter, r *http.Request, id, cid string) {
	if r.Method != http.MethodGet {
		fail(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	out, err := library.RenderChapter(id, cid)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if out == nil {
		fail(w, http.StatusNotFound, "章节不存在")
		return
	}
	ok(w, out)
}

/* ------------------------- helpers ------------------------- */

func joinErrors(errs []string) string {
	out := ""
	for i, e := range errs {
		if i > 0 {
			out += "\n"
		}
		out += e
	}
	if out == "" {
		return "导入失败"
	}
	return out
}

func stringsHasSuffixFold(s, suffix string) bool {
	return len(s) >= len(suffix) && equalFold(s[len(s)-len(suffix):], suffix)
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if 'A' <= ca && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if 'A' <= cb && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}
