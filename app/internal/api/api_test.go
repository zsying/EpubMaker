package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"epubmaker-desktop/internal/server"
)

func TestHealthAndConfig(t *testing.T) {
	// Isolate the data dir so the test doesn't touch the real ~/.epubmaker.
	t.Setenv("EPUBMAKER_HOME", t.TempDir())

	mux := server.NewMux(server.Config{Assets: os.DirFS(t.TempDir())})
	Register(mux)

	srv := httptest.NewServer(mux)
	defer srv.Close()

	// /api/health
	resp, err := http.Get(srv.URL + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("health status=%d body=%s", resp.StatusCode, body)
	}
	var h struct {
		Ok   bool `json:"ok"`
		Data struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &h); err != nil {
		t.Fatal(err)
	}
	if !h.Ok || h.Data.Status != "ok" {
		t.Fatalf("health payload unexpected: %s", body)
	}

	// /api/config
	resp2, err := http.Get(srv.URL + "/api/config")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	body2, _ := io.ReadAll(resp2.Body)
	if resp2.StatusCode != 200 {
		t.Fatalf("config status=%d body=%s", resp2.StatusCode, body2)
	}
	var c struct {
		Ok   bool `json:"ok"`
		Data struct {
			AppHome string `json:"appHome"`
			DbFile  string `json:"dbFile"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body2, &c); err != nil {
		t.Fatal(err)
	}
	if !c.Ok || c.Data.AppHome == "" || c.Data.DbFile == "" {
		t.Fatalf("config payload unexpected: %s", body2)
	}
}
