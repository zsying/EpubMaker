package aicache

import (
	"os"
	"testing"

	"epubmaker-desktop/internal/db"
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "epubmaker-aicache-test")
	if err != nil {
		panic(err)
	}
	os.Setenv("EPUBMAKER_HOME", dir)
	code := m.Run()
	_ = db.Close()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func TestGetMiss(t *testing.T) {
	e, err := Get(Key("explain", "never asked before"))
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if e != nil {
		t.Fatalf("Get = %+v, want nil for a miss", e)
	}
}

func TestPutGetRoundTrip(t *testing.T) {
	key := Key("parse", "She turned the page.")
	want := Entry{Key: key, Kind: "parse", Response: `{"translation":"她翻过这一页。"}`}
	if err := Put(want); err != nil {
		t.Fatalf("Put: %v", err)
	}

	got, err := Get(key)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got == nil {
		t.Fatal("Get = nil, want the stored entry")
	}
	if got.Response != want.Response {
		t.Errorf("response = %q, want %q", got.Response, want.Response)
	}
	if got.Kind != "parse" {
		t.Errorf("kind = %q, want parse", got.Kind)
	}
	if got.CreatedAt == "" {
		t.Error("created_at should be filled in by Put")
	}
}

func TestPutOverwrites(t *testing.T) {
	key := Key("summarize", "chapter one")
	if err := Put(Entry{Key: key, Kind: "summarize", Response: "first answer"}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := Put(Entry{Key: key, Kind: "summarize", Response: "better answer"}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, err := Get(key)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Response != "better answer" {
		t.Errorf("response = %q, want the second write to win", got.Response)
	}
}

// A tombstone is an entry whose response is empty. Get must return it — the
// caller needs to see "asked, nothing to say", which is different from a miss.
func TestTombstoneIsReturnedNotSkipped(t *testing.T) {
	key := Key("explain", "an untranslatable word")
	if err := Put(Entry{Key: key, Kind: "explain", Response: ""}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, err := Get(key)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got == nil {
		t.Fatal("Get = nil, want the tombstone entry")
	}
	if got.Response != "" {
		t.Errorf("response = %q, want empty", got.Response)
	}
}

func TestPutEmptyKeyIgnored(t *testing.T) {
	// Mirrors dictcache: an empty key is a caller bug, not a row.
	if err := Put(Entry{Key: "", Kind: "explain", Response: "x"}); err != nil {
		t.Fatalf("Put: %v", err)
	}
}

func TestKeyStability(t *testing.T) {
	a := Key("explain", "turn")
	b := Key("explain", "turn")
	if a != b {
		t.Fatalf("same input gave different keys: %q vs %q", a, b)
	}
	if c := Key("explain", "page"); c == a {
		t.Error("different input gave the same key")
	}
	if c := Key("parse", "turn"); c == a {
		t.Error("different kind gave the same key")
	}
	// Shape: "<kind>:<64 hex chars>".
	if len(a) != len("explain")+1+64 {
		t.Fatalf("key shape wrong: %q", a)
	}
	for _, r := range a[len("explain")+1:] {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			t.Fatalf("key digest is not lowercase hex: %q", a)
		}
	}
}
