package api

import (
	"net/http"
	"os"

	"epubmaker-desktop/internal/library"
	"epubmaker-desktop/internal/webdav"
)

// webdavTestHandler handles POST /api/webdav/test.
func webdavTestHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	var body map[string]any
	_ = decode(w, r, &body)
	conn, err := webdav.NormalizeConn(body)
	if err != nil {
		ok(w, map[string]any{"connected": false, "error": err.Error()})
		return
	}
	res, err := webdav.TestWebDav(conn)
	if err != nil {
		ok(w, map[string]any{"connected": false, "error": err.Error()})
		return
	}
	ok(w, res)
}

// webdavListHandler handles POST /api/webdav/list.
func webdavListHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	var body map[string]any
	if !decode(w, r, &body) {
		return
	}
	conn, err := webdav.NormalizeConn(body)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	dirPath, _ := body["path"].(string)
	entries, err := webdav.ListWebDav(conn, dirPath)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, entries)
}

// webdavImportHandler handles POST /api/webdav/import.
func webdavImportHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	var body map[string]any
	if !decode(w, r, &body) {
		return
	}
	conn, err := webdav.NormalizeConn(body)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	rawItems, _ := body["items"].([]any)
	if len(rawItems) == 0 {
		fail(w, http.StatusBadRequest, "未选择要导入的文件")
		return
	}
	created := []library.BookDTO{}
	errorsOut := []string{}
	for _, it := range rawItems {
		m, ok := it.(map[string]any)
		if !ok {
			continue
		}
		filePath, _ := m["path"].(string)
		name, _ := m["name"].(string)
		if name == "" {
			name = baseNameOf(filePath)
		}
		if !stringsHasSuffixFold(filePath, ".epub") && !stringsHasSuffixFold(name, ".epub") {
			errorsOut = append(errorsOut, name+": 不是 EPUB 文件")
			continue
		}
		tmp := webdav.TempPath(name)
		if err := webdav.DownloadWebDavFile(conn, filePath, tmp); err != nil {
			errorsOut = append(errorsOut, name+": "+err.Error())
			continue
		}
		book, err := library.ImportEpub(tmp, name)
		_ = os.Remove(tmp)
		if err != nil {
			errorsOut = append(errorsOut, name+": "+err.Error())
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

func baseNameOf(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' || p[i] == '\\' {
			return p[i+1:]
		}
	}
	return p
}
