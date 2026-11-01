package app

import (
	"strings"
	"testing"

	"epubmaker-desktop/internal/logx"
)

// The log is the only evidence a reader can hand over, so the bindings around
// it are part of the contract: a message must arrive, be filterable, and be
// clearable.
func TestLogBindings(t *testing.T) {
	b := &Backend{}
	if err := b.ClearLog(); err != nil {
		t.Fatalf("ClearLog: %v", err)
	}
	if err := b.LogClient("error", "ui", "Cannot read properties of null", "at Reader.tsx:1234"); err != nil {
		t.Fatalf("LogClient: %v", err)
	}
	if err := b.LogClient("info", "nav", "/books/b1/read", ""); err != nil {
		t.Fatalf("LogClient: %v", err)
	}

	all, err := b.ListLogEntries(0, "", "")
	if err != nil {
		t.Fatalf("ListLogEntries: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("entries = %d, want 2", len(all))
	}
	if all[0].Cat != "ui" || all[0].Level != logx.LevelError {
		t.Errorf("first entry = %+v", all[0])
	}
	if !strings.Contains(all[0].Data["detail"], "Reader.tsx") {
		t.Errorf("detail did not survive: %v", all[0].Data)
	}

	// The filters are what make a 300-entry buffer usable.
	warn, _ := b.ListLogEntries(0, "", logx.LevelWarn)
	if len(warn) != 1 || warn[0].Cat != "ui" {
		t.Errorf("warn+ = %+v", warn)
	}
	nav, _ := b.ListLogEntries(0, "nav", "")
	if len(nav) != 1 || nav[0].Msg != "/books/b1/read" {
		t.Errorf("cat=nav = %+v", nav)
	}

	st, err := b.GetLogState()
	if err != nil {
		t.Fatalf("GetLogState: %v", err)
	}
	if !st.Enabled || st.Count != 2 || st.Path == "" {
		t.Errorf("state = %+v", st)
	}

	if err := b.SetLogEnabled(false); err != nil {
		t.Fatalf("SetLogEnabled: %v", err)
	}
	_ = b.LogClient("info", "ui", "while off", "")
	if got, _ := b.ListLogEntries(0, "", ""); len(got) != 2 {
		t.Errorf("entries while off = %d, want 2 (nothing new)", len(got))
	}
	if err := b.SetLogEnabled(true); err != nil {
		t.Fatalf("SetLogEnabled: %v", err)
	}

	// An unknown level must not become invisible to the level filter.
	_ = b.LogClient("verbose", "ui", "odd level", "")
	got, _ := b.ListLogEntries(0, "ui", logx.LevelInfo)
	if len(got) != 2 {
		t.Errorf("ui+info = %d, want 2 (the odd level should read as info)", len(got))
	}

	if err := b.ClearLog(); err != nil {
		t.Fatalf("ClearLog: %v", err)
	}
	if got, _ := b.ListLogEntries(0, "", ""); len(got) != 0 {
		t.Errorf("entries after clear = %d, want 0", len(got))
	}
}
