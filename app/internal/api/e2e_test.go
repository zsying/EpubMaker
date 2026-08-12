package api_test

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"epubmaker-desktop/internal/api"
	"epubmaker-desktop/internal/db"
	"epubmaker-desktop/internal/epub"
	"epubmaker-desktop/internal/server"
)

// pngBytes is a placeholder image payload; validity is not required for the test.
var pngBytes = []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52}

func buildSampleEpub(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	input := epub.BuildInput{
		Title:       "测试书",
		Author:      "作者A",
		Language:    "zh",
		CoverHref:   "images/cover.png",
		Chapters: []epub.BuildChapter{
			{
				Title: "第一章",
				Href:  "OEBPS/ch1.xhtml",
				Content: []byte(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1>第一章</h1><p>正文一</p><img src="../images/cover.png" alt="封面"/></body></html>`),
			},
			{
				Title: "第二章",
				Href:  "OEBPS/ch2.xhtml",
				Content: []byte(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head><body><h1>第二章</h1><p>正文二</p></body></html>`),
			},
		},
		Assets: []epub.BuildAsset{
			{Href: "images/cover.png", MediaType: "image/png", Content: bytes.NewReader(pngBytes)},
			{Href: "style.css", MediaType: "text/css", Content: bytes.NewReader([]byte("body{color:#000}"))},
		},
	}
	if err := epub.BuildEpub(input, &buf); err != nil {
		t.Fatalf("build sample epub: %v", err)
	}
	return buf.Bytes()
}

type envelope struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data"`
	Error string          `json:"error"`
}

func doJSON(t *testing.T, mux http.Handler, method, url string, body io.Reader, contentType string) (int, envelope) {
	t.Helper()
	req := httptest.NewRequest(method, url, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var env envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("%s %s: decode %q: %v", method, url, rec.Body.String(), err)
	}
	return rec.Code, env
}

func TestE2ELifecycle(t *testing.T) {
	t.Setenv("EPUBMAKER_HOME", t.TempDir())
	if _, err := db.Open(); err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	mux := server.NewMux(server.Config{})
	api.Register(mux)

	epubBytes := buildSampleEpub(t)

	// --- import (multipart) ---
	var mp bytes.Buffer
	mw := multipart.NewWriter(&mp)
	fw, err := mw.CreateFormFile("files", "sample.epub")
	if err != nil {
		t.Fatal(err)
	}
	fw.Write(epubBytes)
	mw.Close()

	code, env := doJSON(t, mux, http.MethodPost, "/api/books/import", &mp, mw.FormDataContentType())
	if code != http.StatusOK || !env.OK {
		t.Fatalf("import: status=%d env=%+v", code, env)
	}
	var imported struct {
		Books []struct {
			ID           string `json:"id"`
			Title        string `json:"title"`
			ChapterCount int    `json:"chapterCount"`
			CoverURL     string `json:"coverUrl"`
		} `json:"books"`
	}
	if err := json.Unmarshal(env.Data, &imported); err != nil {
		t.Fatal(err)
	}
	if len(imported.Books) != 1 {
		t.Fatalf("expected 1 imported book, got %d", len(imported.Books))
	}
	book := imported.Books[0]
	if book.Title != "测试书" || book.ChapterCount != 2 {
		t.Fatalf("imported book mismatch: %+v", book)
	}
	if book.CoverURL == "" {
		t.Fatalf("cover url should be set for the sample epub")
	}

	// --- list chapters ---
	_, chEnv := doJSON(t, mux, http.MethodGet, "/api/books/"+book.ID+"/chapters", nil, "")
	var chapters []struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := json.Unmarshal(chEnv.Data, &chapters); err != nil {
		t.Fatal(err)
	}
	if len(chapters) != 2 {
		t.Fatalf("expected 2 chapters, got %d", len(chapters))
	}

	// --- render chapter 1: image URL must be rewritten to a served asset URL ---
	_, rEnv := doJSON(t, mux, http.MethodGet, "/api/books/"+book.ID+"/chapters/"+chapters[0].ID+"/render", nil, "")
	var rendered struct {
		Title string `json:"title"`
		HTML  string `json:"html"`
	}
	if err := json.Unmarshal(rEnv.Data, &rendered); err != nil {
		t.Fatal(err)
	}
	wantURL := "/api/books/" + book.ID + "/assets/images/cover.png"
	if !strings.Contains(rendered.HTML, wantURL) {
		t.Fatalf("rendered html missing rewritten image url %q: %s", wantURL, rendered.HTML)
	}

	// --- export: stream the built EPUB and re-parse it to verify roundtrip ---
	req := httptest.NewRequest(http.MethodGet, "/api/books/"+book.ID+"/export", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("export: status=%d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/epub+zip" {
		t.Fatalf("export content-type=%q", ct)
	}
	exported, err := epub.ParseEpub(rec.Body.Bytes())
	if err != nil {
		t.Fatalf("re-parse exported epub: %v", err)
	}
	if len(exported.Spine) != 2 {
		t.Fatalf("exported epub spine=%d, want 2", len(exported.Spine))
	}
	if exported.CoverHref != "images/cover.png" {
		t.Fatalf("exported cover href=%q", exported.CoverHref)
	}

	// --- split into two single-chapter volumes ---
	splitBody, _ := json.Marshal(map[string]any{
		"parts": []map[string]any{
			{"title": "分卷一", "chapterIds": []string{chapters[0].ID}},
			{"title": "分卷二", "chapterIds": []string{chapters[1].ID}},
		},
		"deleteSource": false,
	})
	_, sEnv := doJSON(t, mux, http.MethodPost, "/api/books/"+book.ID+"/split", bytes.NewReader(splitBody), "application/json")
	var splitBooks []struct {
		ID  string `json:"id"`
		Title string `json:"title"`
	}
	if err := json.Unmarshal(sEnv.Data, &splitBooks); err != nil {
		t.Fatal(err)
	}
	if len(splitBooks) != 2 {
		t.Fatalf("expected 2 split books, got %d", len(splitBooks))
	}
	if splitBooks[0].Title != "分卷一" || splitBooks[1].Title != "分卷二" {
		t.Fatalf("split titles mismatch: %+v", splitBooks)
	}

	// --- covers: upload a cover image ---
	var cmp bytes.Buffer
	cmw := multipart.NewWriter(&cmp)
	cfw, _ := cmw.CreateFormFile("cover", "newcover.png")
	cfw.Write(pngBytes)
	cmw.Close()
	code, cEnv := doJSON(t, mux, http.MethodPost, "/api/books/"+book.ID+"/covers", &cmp, cmw.FormDataContentType())
	if code != http.StatusOK || !cEnv.OK {
		t.Fatalf("cover upload: status=%d env=%+v", code, cEnv)
	}
	var cover struct {
		Href string `json:"href"`
		URL  string `json:"url"`
	}
	if err := json.Unmarshal(cEnv.Data, &cover); err != nil {
		t.Fatal(err)
	}
	if cover.Href == "" || !strings.Contains(cover.URL, "/assets/"+cover.Href) {
		t.Fatalf("cover upload result mismatch: %+v", cover)
	}

	// --- trash: delete, list, restore, purge ---
	_, dEnv := doJSON(t, mux, http.MethodDelete, "/api/books/"+book.ID, nil, "")
	var del struct {
		Deleted     bool `json:"deleted"`
		MovedToTrash bool `json:"movedToTrash"`
	}
	if err := json.Unmarshal(dEnv.Data, &del); err != nil {
		t.Fatal(err)
	}
	if !del.Deleted || !del.MovedToTrash {
		t.Fatalf("delete result: %+v", del)
	}

	_, trEnv := doJSON(t, mux, http.MethodGet, "/api/trash", nil, "")
	var trash []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(trEnv.Data, &trash); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, it := range trash {
		if it.ID == book.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("book %s not found in trash", book.ID)
	}

	_, rEnv2 := doJSON(t, mux, http.MethodPost, "/api/trash/"+book.ID+"/restore", nil, "")
	var restored struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rEnv2.Data, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.ID != book.ID {
		t.Fatalf("restore mismatch: %+v", restored)
	}

	_, pEnv := doJSON(t, mux, http.MethodDelete, "/api/trash/"+book.ID, nil, "")
	var purged struct {
		Purged bool `json:"purged"`
	}
	if err := json.Unmarshal(pEnv.Data, &purged); err != nil {
		t.Fatal(err)
	}
	if !purged.Purged {
		t.Fatalf("purge failed: %+v", purged)
	}
}
