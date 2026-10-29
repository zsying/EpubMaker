// Package webassets serves the built frontend (web/dist) to whichever host is
// asking for it — the Wails v2 desktop shell or the v3 Android WebView.
//
// Both entry points embed the same bundle as `all:frontend/dist` and hand it
// here, so a deep link behaves identically on both. That matters more than it
// looks: a URL like /llm is not a file on disk, and the two hosts fail
// differently when it is answered with a 404.
package webassets

import (
	"io/fs"
	"net/http"
	"path"
	"path/filepath"
	"strings"

	"epubmaker-desktop/internal/app"
)

// distDir is where `//go:embed all:frontend/dist` puts the bundle inside either
// binary. Both hosts embed from their own directory, so the prefix is the same.
const distDir = "frontend/dist"

// Handler returns a handler for the embedded bundle. It exists instead of the
// stock file server because of one rule: **a document request for a path that
// is not a file must answer with index.html**.
//
// The Android WebView cannot show a 404 for these paths. Its asset loader hands
// the request to Go, Go answers 404 for /llm, and WailsPathHandler maps that to
// `null` — which does not mean "404 page" to Chromium, it means "not mine, ask
// the network". The network address is https://wails.localhost, i.e. loopback
// port 443, where nothing listens: the reader gets
//
//	net::ERR_CONNECTION_REFUSED
//
// as a full error page, reachable only by pressing back. Any hard navigation to
// a route (a tap delivered while the WebView was still frozen, a restored
// renderer, a reload) used to land there. The desktop has the same shape of
// bug: the v2 asset server falls through to this handler, which used to answer
// 500 because the embedded index.html sits under frontend/dist.
//
// Missing *assets* still 404: dressing a missing .js up as index.html would
// turn a build mistake into "Unexpected token '<'" in the console.
func Handler(assets fs.FS) http.Handler {
	dist, err := fs.Sub(assets, distDir)
	if err != nil {
		// The embed did not survive the build; every page load fails loudly
		// rather than serving a blank shell.
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "frontend not embedded (expected "+distDir+"/index.html)", http.StatusInternalServerError)
		})
	}

	fileServer := http.FileServer(http.FS(dist))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		clean := path.Clean("/" + r.URL.Path)

		// Downloaded reading fonts live on disk, outside the embed. The name is
		// validated by the same rule the downloader used, so the join below
		// cannot be walked out of the data directory.
		if strings.HasPrefix(clean, "/fonts/") {
			name := path.Base(clean)
			if !app.IsFontFileName(name) {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			http.ServeFile(w, r, filepath.Join(app.FontsDir(), name))
			return
		}

		// index.html by name, not through http.FileServer: that one answers a
		// request for ".../index.html" with a 301 to "./" — and both hosts
		// request exactly this path for the first page of a session (the
		// Android bridge rewrites "" and "/" to it), so a redirect here is a
		// dead app.
		if clean == "/" || clean == "/index.html" {
			serveIndex(w, r, dist)
			return
		}

		if isFile(dist, clean) {
			fileServer.ServeHTTP(w, r)
			return
		}

		if !wantsDocument(clean, r) {
			http.NotFound(w, r)
			return
		}
		serveIndex(w, r, dist)
	})
}

// isFile reports whether the request path is a real file in the bundle.
// fs.FS rejects anything that escapes the root, so an unclean path simply
// looks like a missing file.
func isFile(dist fs.FS, clean string) bool {
	name := strings.TrimPrefix(clean, "/")
	if name == "" {
		return false
	}
	st, err := fs.Stat(dist, name)
	return err == nil && !st.IsDir()
}

// wantsDocument decides whether a miss is a client-side route (answer with the
// shell) or a missing file (answer 404).
//
// The Accept header is what the browser sends for a top-level navigation, and
// it wins: a page load is a page load, extension or not. A subresource — script,
// image, fetch — never asks for HTML, so a missing file still 404s.
//
// A path without an extension is treated as a route too, because that is the
// only thing the app ever generates without one (`/books/<id>/read`,
// `/ai/<id>`); the bundle's own output all lives under /assets/ with an
// extension. This catches loads that do not carry a document header, such as a
// programmatic fetch of a route.
func wantsDocument(clean string, r *http.Request) bool {
	if clean == "/" || clean == "/index.html" {
		return true
	}
	if strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/html") {
		return true
	}
	return path.Ext(clean) == ""
}

func serveIndex(w http.ResponseWriter, r *http.Request, dist fs.FS) {
	data, err := fs.ReadFile(dist, "index.html")
	if err != nil {
		http.Error(w, "frontend not built (index.html missing)", http.StatusInternalServerError)
		return
	}
	// The shell is what every route boots from, so a stale copy would keep
	// serving an old bundle after an upgrade.
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}
