package webassets

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

// dist builds the smallest bundle that has the same shape as web/dist.
func dist() fs.FS {
	return fstest.MapFS{
		"frontend/dist/index.html":    {Data: []byte("<!doctype html><div id=root></div>")},
		"frontend/dist/assets/app.js": {Data: []byte("console.log(1)")},
	}
}

func serve(t *testing.T, target, accept, method string) (int, string, string) {
	t.Helper()
	r := httptest.NewRequest(method, target, nil)
	if accept != "" {
		r.Header.Set("Accept", accept)
	}
	w := httptest.NewRecorder()
	Handler(dist()).ServeHTTP(w, r)
	return w.Code, w.Body.String(), w.Header().Get("Content-Type")
}

// A deep link is not a file. Answering it with a 404 is what turned every hard
// navigation to /llm into net::ERR_CONNECTION_REFUSED on Android, because the
// host maps "no asset" to "ask the network" and wails.localhost is loopback.
func TestDeepLinkServesShell(t *testing.T) {
	for _, target := range []string{"/llm", "/settings", "/books/abc/read", "/ai/39e9df2a882c"} {
		// A navigation carries the document Accept header; the fetch() in a
		// test does not, and the bundle only emits extension-less paths for
		// routes, so both have to work.
		for _, accept := range []string{"text/html,application/xhtml+xml", "*/*"} {
			code, body, ctype := serve(t, target, accept, http.MethodGet)
			if code != http.StatusOK {
				t.Errorf("%s (accept %q): code = %d, want 200", target, accept, code)
			}
			if !strings.Contains(body, `id=root`) {
				t.Errorf("%s (accept %q): body is not the shell: %q", target, accept, body)
			}
			if !strings.HasPrefix(ctype, "text/html") {
				t.Errorf("%s (accept %q): content-type = %q", target, accept, ctype)
			}
		}
	}
}

func TestRootAndRealFiles(t *testing.T) {
	// Both spellings of the first page of a session: http.FileServer would
	// answer /index.html with a 301 to "./", and the Android bridge requests
	// exactly that path on a cold start.
	for _, target := range []string{"/", "/index.html"} {
		if code, body, _ := serve(t, target, "text/html", http.MethodGet); code != 200 || !strings.Contains(body, "id=root") {
			t.Errorf("GET %s = %d %q", target, code, body)
		}
	}
	code, body, _ := serve(t, "/assets/app.js", "*/*", http.MethodGet)
	if code != 200 || body != "console.log(1)" {
		t.Errorf("GET /assets/app.js = %d %q", code, body)
	}
}

// A missing file stays a 404 when nothing asked for a document: dressing it up
// as the shell turns a build mistake into "Unexpected token '<'" in the
// console. A subresource never sends a text/html Accept header, so the rule
// costs nothing.
func TestMissingAssetIs404(t *testing.T) {
	if code, _, _ := serve(t, "/assets/gone.js", "*/*", http.MethodGet); code != http.StatusNotFound {
		t.Errorf("missing asset: code = %d, want 404", code)
	}
	if code, _, _ := serve(t, "/assets/gone.js", "application/javascript", http.MethodGet); code != http.StatusNotFound {
		t.Errorf("missing script: code = %d, want 404", code)
	}
}

func TestNonGetIsRejected(t *testing.T) {
	if code, _, _ := serve(t, "/llm", "text/html", http.MethodPost); code != http.StatusMethodNotAllowed {
		t.Errorf("POST /llm: code = %d, want 405", code)
	}
}

// The font route joins a path component onto the data directory, so the name
// has to pass the downloader's own rule before it is used.
func TestFontRouteRejectsForeignNames(t *testing.T) {
	if code, _, _ := serve(t, "/fonts/.env", "*/*", http.MethodGet); code != http.StatusNotFound {
		t.Errorf("/fonts/.env: code = %d, want 404", code)
	}
	if code, _, _ := serve(t, "/fonts/passwd.txt", "*/*", http.MethodGet); code != http.StatusNotFound {
		t.Errorf("/fonts/passwd.txt: code = %d, want 404", code)
	}
}
