package aiconfig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"epubmaker-desktop/internal/ai"
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "epubmaker-aiconfig-test")
	if err != nil {
		panic(err)
	}
	os.Setenv("EPUBMAKER_HOME", dir)
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func TestLoadMissingFile(t *testing.T) {
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Configured() {
		t.Fatalf("cfg = %+v, want unconfigured when no file exists", cfg)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	want := ai.Config{BaseURL: "https://api.deepseek.com/v1", APIKey: "sk-secret-1234", Model: "deepseek-chat"}
	if err := Save(want); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != want {
		t.Fatalf("Load = %+v, want %+v", got, want)
	}
}

// The key must not be readable by other users of the machine — that is the
// whole reason this is a 0600 sidecar and not config.json. Windows cannot
// express owner-only POSIX bits (its filesystem reports 0666 for anything
// writable), so the assertion is for the platforms where the bit is real;
// on Windows the file still lives alone in the user's own profile dir.
func TestSaveFilePerms(t *testing.T) {
	if err := Save(ai.Config{BaseURL: "https://x/v1", APIKey: "k", Model: "m"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	fi, err := os.Stat(Path())
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if runtime.GOOS == "windows" {
		if fi.Mode().Perm()&0o400 == 0 {
			t.Fatalf("perms = %o, want the file readable", fi.Mode().Perm())
		}
		return
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("perms = %o, want 600", perm)
	}
}

// The settings page never receives the key, so it sends back a blank one when
// only the model changed. A blank key must keep the stored key.
func TestSaveBlankKeyKeepsStored(t *testing.T) {
	if err := Save(ai.Config{BaseURL: "https://x/v1", APIKey: "sk-keep-me", Model: "m1"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := Save(ai.Config{BaseURL: "https://x/v1", APIKey: "", Model: "m2"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.APIKey != "sk-keep-me" {
		t.Errorf("apiKey = %q, want the stored key kept", got.APIKey)
	}
	if got.Model != "m2" {
		t.Errorf("model = %q, want m2", got.Model)
	}
}

// A corrupt file must not break startup: AI reads as unconfigured and the
// user can retype the settings.
func TestLoadCorruptFile(t *testing.T) {
	if err := os.WriteFile(Path(), []byte("{not json"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Configured() {
		t.Fatalf("cfg = %+v, want unconfigured for a corrupt file", cfg)
	}
}

func TestValidate(t *testing.T) {
	cases := []struct {
		name    string
		cfg     ai.Config
		wantErr bool
	}{
		{"valid", ai.Config{BaseURL: "https://api.openai.com/v1", APIKey: "k", Model: "m"}, false},
		{"valid no key", ai.Config{BaseURL: "http://localhost:11434/v1", Model: "m"}, false},
		{"no scheme", ai.Config{BaseURL: "api.openai.com/v1", APIKey: "k", Model: "m"}, true},
		{"ftp scheme", ai.Config{BaseURL: "ftp://x/v1", APIKey: "k", Model: "m"}, true},
		{"missing model", ai.Config{BaseURL: "https://x/v1", APIKey: "k"}, true},
		{"missing base", ai.Config{APIKey: "k", Model: "m"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := Validate(tc.cfg)
			if tc.wantErr && err == nil {
				t.Error("expected an error")
			}
			if !tc.wantErr && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
		})
	}
}

func TestViewMasksKey(t *testing.T) {
	v := NewView(Store{Profiles: []Profile{{
		ID: "p1", Name: "X", BaseURL: "https://x/v1", APIKey: "sk-abcdef9999", Model: "m",
	}}, ActiveID: "p1"})
	if !v.KeySet {
		t.Error("KeySet = false, want true")
	}
	if strings.Contains(v.KeyHint, "abcdef") {
		t.Errorf("KeyHint = %q, must not expose the key", v.KeyHint)
	}
	if v.KeyHint != "…9999" {
		t.Errorf("KeyHint = %q, want …9999", v.KeyHint)
	}
	if v.BaseURL != "https://x/v1" || v.Model != "m" {
		t.Errorf("view = %+v, want base URL and model passed through", v)
	}
	if len(v.Presets) == 0 {
		t.Error("view should carry the presets")
	}
	if len(v.Profiles) != 1 || v.Profiles[0].KeyHint != "…9999" {
		t.Errorf("profiles = %+v, want one masked row", v.Profiles)
	}
}

func TestViewNoKey(t *testing.T) {
	v := NewView(Store{Profiles: []Profile{{
		ID: "p1", BaseURL: "http://localhost:11434/v1", Model: "qwen2.5",
	}}, ActiveID: "p1"})
	if v.KeySet || v.KeyHint != "" {
		t.Errorf("view = %+v, want no key reported", v)
	}
}

func TestPathIsUnderAppHome(t *testing.T) {
	home := os.Getenv("EPUBMAKER_HOME")
	if got, want := Path(), filepath.Join(home, "ai.json"); got != want {
		t.Errorf("Path() = %q, want %q", got, want)
	}
}

// The file is JSON on disk so a user can hand-edit it, and what it holds is a
// list of profiles rather than one flat config.
func TestSavedFileIsJSON(t *testing.T) {
	reset(t)
	if err := Save(ai.Config{BaseURL: "https://x/v1", APIKey: "k", Model: "m"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	raw, err := os.ReadFile(Path())
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var probe struct {
		ActiveID string    `json:"activeId"`
		Profiles []Profile `json:"profiles"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatalf("file is not JSON: %v", err)
	}
	if len(probe.Profiles) != 1 {
		t.Fatalf("profiles = %+v, want the one config as a profile", probe.Profiles)
	}
	p := probe.Profiles[0]
	if p.BaseURL != "https://x/v1" || p.APIKey != "k" || p.Model != "m" {
		t.Errorf("profile = %+v, want the saved values", p)
	}
	if probe.ActiveID != p.ID || p.ID == "" {
		t.Errorf("activeId = %q, profile id = %q, want the new profile in force", probe.ActiveID, p.ID)
	}
}

/* --------------------------------- profiles -------------------------------- */

// reset makes a test start from "nothing configured". Everything in this
// package shares one AppHome, so a test that needs an empty file has to say so.
func reset(t *testing.T) {
	t.Helper()
	if err := os.Remove(Path()); err != nil && !os.IsNotExist(err) {
		t.Fatalf("remove ai.json: %v", err)
	}
}

// The file that shipped before profiles existed must keep working: one config
// in, one profile out, named after the provider it points at (the label the
// list shows without the reader typing one).
func TestLegacyFileReadsAsOneProfile(t *testing.T) {
	reset(t)
	legacy := []byte(`{"baseUrl":"https://api.deepseek.com/v1","apiKey":"sk-legacy","model":"deepseek-chat"}`)
	if err := os.WriteFile(Path(), legacy, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.BaseURL != "https://api.deepseek.com/v1" || cfg.APIKey != "sk-legacy" || cfg.Model != "deepseek-chat" {
		t.Errorf("Load = %+v, want the legacy config in force", cfg)
	}
	s, err := LoadStore()
	if err != nil {
		t.Fatalf("LoadStore: %v", err)
	}
	if len(s.Profiles) != 1 {
		t.Fatalf("profiles = %+v, want exactly one", s.Profiles)
	}
	if got := s.Profiles[0].Name; got != "DeepSeek" {
		t.Errorf("name = %q, want the preset name DeepSeek", got)
	}
	if s.ActiveID != s.Profiles[0].ID || s.Profiles[0].ID == "" {
		t.Errorf("activeId = %q, want the migrated profile in force", s.ActiveID)
	}
}

// Reading never writes: a reader who upgrades and does nothing still has the
// old file, so a downgrade does not lose their key.
func TestLoadDoesNotRewriteLegacyFile(t *testing.T) {
	reset(t)
	legacy := []byte(`{"baseUrl":"https://x/v1","apiKey":"k","model":"m"}`)
	if err := os.WriteFile(Path(), legacy, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if _, err := LoadStore(); err != nil {
		t.Fatalf("LoadStore: %v", err)
	}
	raw, err := os.ReadFile(Path())
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(raw) != string(legacy) {
		t.Errorf("file was rewritten on read:\n%s", raw)
	}
}

func TestSaveProfileCreatesAndActivatesFirst(t *testing.T) {
	reset(t)
	p, err := SaveProfile(Profile{BaseURL: "https://api.openai.com/v1", Model: "gpt-4o-mini", APIKey: "k1"})
	if err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}
	if p.ID == "" {
		t.Error("saved profile has no id")
	}
	if p.Name != "OpenAI" {
		t.Errorf("name = %q, want the preset name", p.Name)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Model != "gpt-4o-mini" {
		t.Errorf("Load model = %q, want the only profile to be in force", cfg.Model)
	}
}

func TestSaveProfileNameFallsBackToHost(t *testing.T) {
	reset(t)
	p, err := SaveProfile(Profile{BaseURL: "https://ai.example.com/v1", Model: "m"})
	if err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}
	if p.Name != "ai.example.com" {
		t.Errorf("name = %q, want the host", p.Name)
	}
}

// A second profile must not become the active one by surprise: adding an
// alternative is not the same as choosing it.
func TestSecondProfileLeavesTheFirstActive(t *testing.T) {
	reset(t)
	first, err := SaveProfile(Profile{Name: "便宜", BaseURL: "https://a/v1", Model: "m1"})
	if err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}
	second, err := SaveProfile(Profile{Name: "贵", BaseURL: "https://b/v1", Model: "m2"})
	if err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}
	s, err := LoadStore()
	if err != nil {
		t.Fatalf("LoadStore: %v", err)
	}
	if s.ActiveID != first.ID {
		t.Errorf("activeId = %q, want the first profile %q", s.ActiveID, first.ID)
	}
	if err := Activate(second.ID); err != nil {
		t.Fatalf("Activate: %v", err)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Model != "m2" {
		t.Errorf("Load model = %q, want the switched profile", cfg.Model)
	}
	// Switch back and nothing was lost on the way.
	if err := Activate(first.ID); err != nil {
		t.Fatalf("Activate: %v", err)
	}
	if cfg, _ := Load(); cfg.Model != "m1" || cfg.BaseURL != "https://a/v1" {
		t.Errorf("Load = %+v, want the first profile intact", cfg)
	}
}

// The settings page never receives a key, so it sends a blank one when only
// the model changed. Blank must keep what is stored — per profile, not
// globally: editing the second one must not borrow the first one's key.
func TestSaveProfileBlankKeyKeepsStoredPerProfile(t *testing.T) {
	reset(t)
	a, _ := SaveProfile(Profile{Name: "A", BaseURL: "https://a/v1", Model: "m", APIKey: "sk-a"})
	b, _ := SaveProfile(Profile{Name: "B", BaseURL: "https://b/v1", Model: "m", APIKey: "sk-b"})
	if _, err := SaveProfile(Profile{ID: a.ID, Name: "A", BaseURL: "https://a/v1", Model: "m2"}); err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}
	s, _ := LoadStore()
	pa, pb := s.Profile(a.ID), s.Profile(b.ID)
	if pa.APIKey != "sk-a" || pa.Model != "m2" {
		t.Errorf("A = %+v, want model changed and key kept", pa)
	}
	if pb.APIKey != "sk-b" {
		t.Errorf("B = %+v, want its own key untouched", pb)
	}
}

// Deleting the profile in force must leave the app working on whatever is
// left, not "configured: false while a usable row sits on screen".
func TestDeleteActiveProfilePromotesTheNext(t *testing.T) {
	reset(t)
	a, _ := SaveProfile(Profile{Name: "A", BaseURL: "https://a/v1", Model: "ma"})
	b, _ := SaveProfile(Profile{Name: "B", BaseURL: "https://b/v1", Model: "mb"})
	if err := DeleteProfile(a.ID); err != nil {
		t.Fatalf("DeleteProfile: %v", err)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Model != "mb" {
		t.Errorf("Load model = %q, want %q to take over", cfg.Model, b.ID)
	}
	if err := DeleteProfile(b.ID); err != nil {
		t.Fatalf("DeleteProfile: %v", err)
	}
	if cfg, _ := Load(); cfg.Configured() {
		t.Errorf("Load = %+v, want unconfigured once the last profile is gone", cfg)
	}
	// Deleting something already gone is not an error: the row may have just
	// been removed by the same double tap.
	if err := DeleteProfile(a.ID); err != nil {
		t.Errorf("second delete of a missing id: %v", err)
	}
}

func TestActivateUnknownIdIsAnError(t *testing.T) {
	reset(t)
	if _, err := SaveProfile(Profile{Name: "A", BaseURL: "https://a/v1", Model: "m"}); err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}
	if err := Activate("nope"); err == nil {
		t.Error("expected an error for an unknown id")
	}
	if err := DeleteProfile("nope"); err != nil {
		t.Errorf("DeleteProfile of an unknown id: %v", err)
	}
}

// Save keeps its old meaning — "write these into the config in force" — which
// is what AISaveChatSystem and the seeded-provider tests rely on. It must not
// flatten the other profiles on the way.
func TestSaveWritesThroughTheActiveProfileOnly(t *testing.T) {
	reset(t)
	a, _ := SaveProfile(Profile{Name: "A", BaseURL: "https://a/v1", Model: "ma", APIKey: "sk-a"})
	b, _ := SaveProfile(Profile{Name: "B", BaseURL: "https://b/v1", Model: "mb", APIKey: "sk-b"})
	if err := Save(ai.Config{BaseURL: "https://a/v1", Model: "ma-2", ChatSystem: "新的开场"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	s, _ := LoadStore()
	if got := s.Profile(a.ID); got.Model != "ma-2" || got.APIKey != "sk-a" {
		t.Errorf("A = %+v, want the model updated and the key kept", got)
	}
	if got := s.Profile(b.ID); got.Model != "mb" {
		t.Errorf("B = %+v, want it untouched", got)
	}
	if s.ChatSystem != "新的开场" {
		t.Errorf("chatSystem = %q, want it written through", s.ChatSystem)
	}
	// The standing prompt is not per profile: switching models keeps it.
	if err := Activate(b.ID); err != nil {
		t.Fatalf("Activate: %v", err)
	}
	if s, _ := LoadStore(); s.ChatSystem != "新的开场" {
		t.Errorf("chatSystem = %q, want it to survive a switch", s.ChatSystem)
	}
}

// A hand-edited file may carry a row with nothing in it; it must not draw as
// an empty line in the list and answer nothing.
func TestBlankRowsAreDropped(t *testing.T) {
	reset(t)
	raw := `{"profiles":[{"id":"a","name":"A","baseUrl":"https://a/v1","model":"m"},
	                   {"id":"b","name":"空","baseUrl":"","model":""}],
	         "activeId":"b"}`
	if err := os.WriteFile(Path(), []byte(raw), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	s, err := LoadStore()
	if err != nil {
		t.Fatalf("LoadStore: %v", err)
	}
	if len(s.Profiles) != 1 || s.Profiles[0].ID != "a" {
		t.Fatalf("profiles = %+v, want only the real one", s.Profiles)
	}
	if s.ActiveID != "a" {
		t.Errorf("activeId = %q, want the surviving profile (the old active was dropped)", s.ActiveID)
	}
}

// The view is the whole list plus the active config denormalised, because the
// rest of the app asks only "what is in force".
func TestViewListsEveryProfile(t *testing.T) {
	reset(t)
	a, _ := SaveProfile(Profile{Name: "便宜", BaseURL: "https://a/v1", Model: "ma", APIKey: "sk-1111"})
	SaveProfile(Profile{Name: "贵", BaseURL: "https://b/v1", Model: "mb"})
	s, _ := LoadStore()
	v := NewView(s)
	if len(v.Profiles) != 2 {
		t.Fatalf("profiles = %+v, want both", v.Profiles)
	}
	if v.ActiveID != a.ID || v.Model != "ma" || v.BaseURL != "https://a/v1" {
		t.Errorf("view = %+v, want the first profile in force", v)
	}
	if !v.Profiles[0].KeySet || v.Profiles[0].KeyHint != "…1111" {
		t.Errorf("row 0 = %+v, want its key reported masked", v.Profiles[0])
	}
	if v.Profiles[1].KeySet {
		t.Errorf("row 1 = %+v, want no key", v.Profiles[1])
	}
	if !v.Configured {
		t.Error("configured = false, want true with an address and a model")
	}
}
