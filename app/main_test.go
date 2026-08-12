package main

import (
	"io"
	"io/fs"
	"testing"
)

// TestEmbeddedFrontend ensures the production binary embeds a built frontend
// under frontend/dist. Wails (and our SPA handler) strips that prefix at runtime.
func TestEmbeddedFrontend(t *testing.T) {
	assetRoot, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		t.Fatalf("embedded frontend/dist not found: %v", err)
	}

	f, err := assetRoot.Open("index.html")
	if err != nil {
		t.Fatalf("embedded index.html not found: %v", err)
	}
	defer f.Close()
	b, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) == 0 {
		t.Fatal("embedded index.html is empty")
	}
}
