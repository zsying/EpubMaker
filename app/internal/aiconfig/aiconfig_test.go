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
	v := NewView(ai.Config{BaseURL: "https://x/v1", APIKey: "sk-abcdef9999", Model: "m"})
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
}

func TestViewNoKey(t *testing.T) {
	v := NewView(ai.Config{BaseURL: "http://localhost:11434/v1", Model: "qwen2.5"})
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

// The file is JSON on disk so a user can hand-edit it.
func TestSavedFileIsJSON(t *testing.T) {
	if err := Save(ai.Config{BaseURL: "https://x/v1", APIKey: "k", Model: "m"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	raw, err := os.ReadFile(Path())
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var probe map[string]any
	if err := json.Unmarshal(raw, &probe); err != nil {
		t.Fatalf("file is not JSON: %v", err)
	}
	for _, k := range []string{"baseUrl", "apiKey", "model"} {
		if _, ok := probe[k]; !ok {
			t.Errorf("key %q missing from the file", k)
		}
	}
}
