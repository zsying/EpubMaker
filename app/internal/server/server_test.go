package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func newTestServer(t *testing.T) (*httptest.Server, func()) {
	t.Helper()

	// Fake "Express" upstream.
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/health":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"ok":true,"data":{"status":"ok"}}`))
		case "/api/books":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"ok":true,"data":[]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))

	dir := t.TempDir()
	mustWrite(t, dir, "index.html", "<html>app</html>")
	mustWrite(t, dir, "app.js", "console.log(1)")
	mustWrite(t, dir, "assets/style.css", "body{}")

	h := NewHandler(Config{WebDist: dir, APIUpstream: up.URL})
	srv := httptest.NewServer(h)
	return srv, func() { srv.Close(); up.Close() }
}

func mustWrite(t *testing.T, dir, name, content string) {
	t.Helper()
	fp := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(fp), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fp, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func get(t *testing.T, url string) (int, string) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestStaticIndex(t *testing.T) {
	srv, done := newTestServer(t)
	defer done()

	code, body := get(t, srv.URL+"/")
	if code != 200 || body != "<html>app</html>" {
		t.Fatalf("index: code=%d body=%q", code, body)
	}
}

func TestStaticAsset(t *testing.T) {
	srv, done := newTestServer(t)
	defer done()

	code, body := get(t, srv.URL+"/app.js")
	if code != 200 || body != "console.log(1)" {
		t.Fatalf("app.js: code=%d body=%q", code, body)
	}

	code, body = get(t, srv.URL+"/assets/style.css")
	if code != 200 || body != "body{}" {
		t.Fatalf("style.css: code=%d body=%q", code, body)
	}
}

func TestAPIProxy(t *testing.T) {
	srv, done := newTestServer(t)
	defer done()

	code, body := get(t, srv.URL+"/api/health")
	if code != 200 || body == "" {
		t.Fatalf("api/health: code=%d body=%q", code, body)
	}

	code, body = get(t, srv.URL+"/api/books")
	if code != 200 || body == "" {
		t.Fatalf("api/books: code=%d body=%q", code, body)
	}
}

func TestSPAFallback(t *testing.T) {
	srv, done := newTestServer(t)
	defer done()

	// A client-side route with no matching file must return index.html.
	code, body := get(t, srv.URL+"/books/abc-123")
	if code != 200 || body != "<html>app</html>" {
		t.Fatalf("spa fallback: code=%d body=%q", code, body)
	}
}

func TestTraversalBlocked(t *testing.T) {
	srv, done := newTestServer(t)
	defer done()

	// Encoded traversal must not escape webDist; expect SPA fallback (200, index).
	code, body := get(t, srv.URL+"/%2e%2e/%2e%2e/etc/passwd")
	if code != 200 || body != "<html>app</html>" {
		t.Fatalf("traversal: code=%d body=%q (expected fallback to index)", code, body)
	}
}
