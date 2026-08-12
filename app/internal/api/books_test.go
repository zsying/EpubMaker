package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"epubmaker-desktop/internal/config"
	"epubmaker-desktop/internal/db"
	"epubmaker-desktop/internal/server"
	"epubmaker-desktop/internal/storage"
)

func TestBooksRoutes(t *testing.T) {
	// Isolate data dir and force a fresh config/db (the packages cache globals).
	t.Setenv("EPUBMAKER_HOME", t.TempDir())
	_ = db.Close()
	if _, err := config.Load(true); err != nil {
		t.Fatal(err)
	}

	d, err := db.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	bookID := "11111111-1111-1111-1111-111111111111"
	chID := "22222222-2222-2222-2222-222222222222"
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := d.Exec(
		`INSERT INTO books (id,title,author,language,publisher,description,identifier,created_at,updated_at)
		 VALUES (?,?,?,?,?,?,?,?,?)`,
		bookID, "测试书", "作者甲", "zh", "", "", "", now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(
		`INSERT INTO chapters (id,book_id,idx,title,href,created_at,updated_at)
		 VALUES (?,?,?,?,?,?,?)`,
		chID, bookID, 0, "第一章", "OEBPS/ch1.xhtml", now, now); err != nil {
		t.Fatal(err)
	}
	// Create the book directory on disk so the soft-delete can move it to trash.
	if err := os.MkdirAll(storage.BookDir(bookID), 0o755); err != nil {
		t.Fatal(err)
	}

	mux := server.NewMux(server.Config{WebDist: t.TempDir()})
	Register(mux, "")
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// GET /api/books -> lists the seeded book
	var list []map[string]any
	getJSON(t, srv.URL+"/api/books", &list)
	if len(list) != 1 || list[0]["id"] != bookID {
		t.Fatalf("listBooks unexpected: %#v", list)
	}
	if int(list[0]["chapterCount"].(float64)) != 1 {
		t.Fatalf("chapterCount should be 1, got %v", list[0]["chapterCount"])
	}

	// GET /api/books/:id
	var book map[string]any
	getJSON(t, srv.URL+"/api/books/"+bookID, &book)
	if book["title"] != "测试书" {
		t.Fatalf("getBook title unexpected: %v", book["title"])
	}

	// PATCH /api/books/:id
	var patched map[string]any
	patchJSON(t, srv.URL+"/api/books/"+bookID, `{"title":"改名书"}`, &patched)
	if patched["title"] != "改名书" {
		t.Fatalf("updateBook title unexpected: %v", patched["title"])
	}

	// GET /api/books/:id/chapters
	var chs []map[string]any
	getJSON(t, srv.URL+"/api/books/"+bookID+"/chapters", &chs)
	if len(chs) != 1 || chs[0]["title"] != "第一章" {
		t.Fatalf("listChapters unexpected: %#v", chs)
	}

	// GET /api/books/:id/chapters/:cid/source (no body file -> empty html, 200)
	var src map[string]any
	getJSON(t, srv.URL+"/api/books/"+bookID+"/chapters/"+chID+"/source", &src)
	if _, ok := src["title"]; !ok {
		t.Fatalf("getChapterSource unexpected: %#v", src)
	}

	// DELETE /api/books/:id -> soft delete
	var del map[string]any
	deleteJSON(t, srv.URL+"/api/books/"+bookID, &del)
	if del["deleted"] != true {
		t.Fatalf("deleteBook deleted unexpected: %#v", del)
	}

	// GET /api/trash -> shows the soft-deleted book
	var trash []map[string]any
	getJSON(t, srv.URL+"/api/trash", &trash)
	if len(trash) != 1 || trash[0]["id"] != bookID {
		t.Fatalf("listTrash unexpected: %#v", trash)
	}

	// POST /api/trash/:id/restore
	var restored map[string]any
	postJSON(t, srv.URL+"/api/trash/"+bookID+"/restore", "", &restored)
	if restored["id"] != bookID {
		t.Fatalf("restoreBook unexpected: %#v", restored)
	}

	// After restore, book is back in the list again.
	getJSON(t, srv.URL+"/api/books", &list)
	if len(list) != 1 {
		t.Fatalf("expected 1 book after restore, got %d", len(list))
	}
}

/* ----------------------------- test helpers ----------------------------- */

func doReq(t *testing.T, method, url, body string, dst any) int {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	// The API wraps every response as {"ok":bool,"data":...}. Unwrap data.
	var env struct {
		Ok    bool            `json:"ok"`
		Data  json.RawMessage `json:"data"`
		Error string          `json:"error"`
	}
	if err := json.Unmarshal(b, &env); err != nil {
		t.Fatalf("%s %s: decode envelope %s: %v", method, url, b, err)
	}
	if !env.Ok {
		t.Fatalf("%s %s: api error: %s", method, url, env.Error)
	}
	if dst != nil {
		if err := json.Unmarshal(env.Data, dst); err != nil {
			t.Fatalf("%s %s: decode data %s: %v", method, url, env.Data, err)
		}
	}
	return resp.StatusCode
}

func getJSON(t *testing.T, url string, dst any)   { if c := doReq(t, http.MethodGet, url, "", dst); c != 200 { t.Fatalf("GET %s status %d", url, c) } }
func deleteJSON(t *testing.T, url string, dst any) { if c := doReq(t, http.MethodDelete, url, "", dst); c != 200 { t.Fatalf("DELETE %s status %d", url, c) } }
func postJSON(t *testing.T, url, body string, dst any) {
	if c := doReq(t, http.MethodPost, url, body, dst); c != 200 {
		t.Fatalf("POST %s status %d", url, c)
	}
}
func patchJSON(t *testing.T, url, body string, dst any) {
	if c := doReq(t, http.MethodPatch, url, body, dst); c != 200 {
		t.Fatalf("PATCH %s status %d", url, c)
	}
}
