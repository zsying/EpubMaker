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

	dir := t.TempDir()
	mustWrite(t, dir, "index.html", "<html>app</html>")
	mustWrite(t, dir, "app.js", "console.log(1)")
	mustWrite(t, dir, "assets/style.css", "body{}")

	h := NewMux(Config{Assets: os.DirFS(dir)})
	srv := httptest.NewServer(h)
	return srv, func() { srv.Close() }
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

// TestAPIRoutesServed reports that /api/* is owned by the Go backend, not a
// proxy: an unregistered API path falls through to the SPA (index.html).
func TestAPIRoutesServed(t *testing.T) {
	srv, done := newTestServer(t)
	defer done()

	// No API route is mounted on this bare mux, so /api/health falls back to
	// the SPA index (the real binary mounts the Go API via api.Register).
	code, body := get(t, srv.URL+"/api/health")
	if code != 200 || body != "<html>app</html>" {
		t.Fatalf("api fallback: code=%d body=%q (expected SPA index)", code, body)
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

	// Encoded traversal must not escape the asset root; expect SPA fallback.
	code, body := get(t, srv.URL+"/%2e%2e/%2e%2e/etc/passwd")
	if code != 200 || body != "<html>app</html>" {
		t.Fatalf("traversal: code=%d body=%q (expected fallback to index)", code, body)
	}
}
