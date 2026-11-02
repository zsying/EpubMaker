// Package aiconfig stores the BYOK provider settings on the device.
//
// The settings live in <AppHome>/ai.json with 0600 permissions, deliberately
// NOT in config.json: that file is written 0644 and is meant to be copied
// around with backups, and an API key must not travel with it. The file is
// plain JSON so a user can hand-edit it.
//
// The file holds a LIST of profiles and which one is in force (ADR-50). A
// reader keeps a cheap model for vocabulary lookups and an expensive one for
// reading a chapter, or a local Ollama on the train and a hosted API at home;
// switching between them is a tap on the LLM page, not a re-paste of three
// fields. Load() still answers "the settings in force" as one ai.Config, so
// every caller that only asks that question — the request path, the
// test-connection button, the chapter guide's confirmation — need not know
// that profiles exist.
//
// The key never leaves the device through the app's own APIs: the settings
// page reads View (masked), and a save with a blank key keeps the stored one,
// so changing the model never forces a re-paste.
package aiconfig

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"epubmaker-desktop/internal/ai"
	"epubmaker-desktop/internal/config"
)

// FileName is the sidecar file under AppHome holding the settings.
const FileName = "ai.json"

// filePerms keeps the key out of other users' hands.
const filePerms = 0o600

// Preset is an endpoint the settings page offers in its dropdown.
type Preset struct {
	Name    string `json:"name"`
	BaseURL string `json:"baseUrl"`
	Model   string `json:"model"`
	Note    string `json:"note,omitempty"`
}

// Presets are the providers the app suggests. Anything OpenAI-compatible
// works when typed in by hand; these are the ones worth a dropdown.
func Presets() []Preset {
	return []Preset{
		{Name: "OpenAI", BaseURL: "https://api.openai.com/v1", Model: "gpt-4o-mini"},
		{Name: "DeepSeek", BaseURL: "https://api.deepseek.com/v1", Model: "deepseek-chat"},
		{Name: "Moonshot Kimi", BaseURL: "https://api.moonshot.cn/v1", Model: "moonshot-v1-8k"},
		{Name: "智谱 GLM", BaseURL: "https://open.bigmodel.cn/api/paas/v4", Model: "glm-4-flash"},
		{Name: "阿里通义", BaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", Model: "qwen-turbo"},
		{Name: "Ollama（本地）", BaseURL: "http://localhost:11434/v1", Model: "qwen2.5:7b", Note: "本地运行，密钥可留空"},
	}
}

// Profile is one saved provider configuration: everything a call needs, so
// switching profiles never has to mix two of them.
type Profile struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey,omitempty"`
	Model   string `json:"model"`
}

// Store is the file's shape. ChatSystem sits beside the profiles rather than
// inside one: it is about the reader's voice, not about who answers, and a
// prompt that vanished when the model changed would be a trap.
type Store struct {
	Profiles   []Profile `json:"profiles"`
	ActiveID   string    `json:"activeId,omitempty"`
	ChatSystem string    `json:"chatSystem,omitempty"`
}

// Active returns the profile in force, nil when nothing is configured.
func (s Store) Active() *Profile { return s.Profile(s.ActiveID) }

// Profile returns the profile with this id, nil when there is none.
func (s Store) Profile(id string) *Profile {
	if strings.TrimSpace(id) == "" {
		return nil
	}
	for i := range s.Profiles {
		if s.Profiles[i].ID == id {
			return &s.Profiles[i]
		}
	}
	return nil
}

// activeIndex is Active() as an index, -1 when nothing is in force.
func (s Store) activeIndex() int {
	if s.ActiveID == "" {
		return -1
	}
	for i := range s.Profiles {
		if s.Profiles[i].ID == s.ActiveID {
			return i
		}
	}
	return -1
}

// View is the settings-page shape: one entry per profile, keys masked (only
// whether one is stored and its last four characters, enough to recognize).
//
// BaseURL / Model / KeySet / KeyHint are the ACTIVE profile's, denormalised.
// Half the app only ever asks "what is in force" — the reader's chapter guide,
// the 我的 row, the request path — and making each of them walk the list to
// find the active entry would spread one loop across five call sites.
type View struct {
	BaseURL string `json:"baseUrl"`
	Model   string `json:"model"`
	KeySet  bool   `json:"keySet"`
	KeyHint string `json:"keyHint"`
	// Profiles is every saved configuration, in its own order.
	Profiles []ProfileView `json:"profiles"`
	// ActiveID names the one in force; empty when none is.
	ActiveID string   `json:"activeId"`
	Presets  []Preset `json:"presets"`
	// Configured lets a caller check readiness up front (the reader's chapter
	// guide asks before it offers to send anything) instead of starting a call
	// that can only fail with "not configured".
	Configured bool `json:"configured"`
	// ChatSystem is the reader's standing prompt for hand-made conversations,
	// empty when the default is in force. ChatSystemDefault is that default,
	// sent along so the form can show it as the placeholder and the 恢复默认
	// button can say what it would restore to.
	ChatSystem        string `json:"chatSystem"`
	ChatSystemDefault string `json:"chatSystemDefault"`
}

// ProfileView is one row of the settings list.
type ProfileView struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	BaseURL string `json:"baseUrl"`
	Model   string `json:"model"`
	KeySet  bool   `json:"keySet"`
	KeyHint string `json:"keyHint"`
}

// DefaultChatSystem is the standing prompt for conversations the reader starts
// by hand. It is the text a new conversation gets when no custom one is
// configured and none is picked from the library; changing it here changes
// every future chat, and never a transcript that already exists.
const DefaultChatSystem = `你是 EpubMaker 的英语阅读助手。用户正在阅读英文原版书，会问你词汇、句子和阅读相关的问题。
回答用中文，简洁清晰；英文例句和术语保留英文。`

// ChatSystemFor resolves the standing prompt: the reader's custom text when
// one is set, the built-in default otherwise.
func ChatSystemFor(cfg ai.Config) string {
	if s := strings.TrimSpace(cfg.ChatSystem); s != "" {
		return s
	}
	return DefaultChatSystem
}

// Path is the absolute path of the settings file.
func Path() string {
	return filepath.Join(config.Get().AppHome, FileName)
}

// LoadStore reads the whole file. A missing or corrupt file is not an error:
// the app runs with AI unconfigured and every entry point says so.
//
// A file written before profiles existed ({baseUrl, apiKey, model,
// chatSystem}) reads as a single profile named after its provider. That
// migration happens in memory — a read must not write — and the file takes
// the new shape on the next save, which is a reader action rather than
// something sprung on them at startup.
func LoadStore() (Store, error) {
	var s Store
	raw, err := os.ReadFile(Path())
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return Store{}, err
	}
	// Embedding Store pulls `profiles` / `activeId` / `chatSystem` into the
	// probe while the three legacy keys stay at the top level, so one unmarshal
	// reads both shapes and the old one is easy to spot: no profiles, a URL.
	var probe struct {
		Store
		BaseURL string `json:"baseUrl"`
		APIKey  string `json:"apiKey"`
		Model   string `json:"model"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return Store{}, nil
	}
	s = probe.Store
	if len(s.Profiles) == 0 && strings.TrimSpace(probe.BaseURL) != "" {
		s.Profiles = []Profile{{
			BaseURL: probe.BaseURL,
			APIKey:  probe.APIKey,
			Model:   probe.Model,
		}}
	}
	normalize(&s)
	return s, nil
}

// Load returns the settings IN FORCE as one config: the active profile plus
// the standing chat prompt. Callers that predate profiles need nothing else,
// and keeping this signature is what left the request path untouched.
func Load() (ai.Config, error) {
	s, err := LoadStore()
	if err != nil {
		return ai.Config{}, err
	}
	cfg := ai.Config{ChatSystem: s.ChatSystem}
	if p := s.Active(); p != nil {
		cfg.BaseURL = p.BaseURL
		cfg.APIKey = p.APIKey
		cfg.Model = p.Model
	}
	return cfg, nil
}

// Save writes one config into the ACTIVE profile, keeping the other profiles
// as they are. The incoming ChatSystem is written through, blank included — a
// blank one means "back to the built-in".
//
// It exists so the pre-profile save path — AISaveChatSystem, and the tests
// that seed a provider — keeps working without knowing about profiles. With
// no profile at all it creates one, which is exactly what a reader filling in
// the form for the first time is doing.
func Save(cfg ai.Config) error {
	if err := Validate(cfg); err != nil {
		return err
	}
	s, err := LoadStore()
	if err != nil {
		return err
	}
	idx := s.activeIndex()
	if idx < 0 {
		s.Profiles = append(s.Profiles, Profile{})
		idx = len(s.Profiles) - 1
	}
	p := &s.Profiles[idx]
	if p.ID == "" {
		p.ID = newID()
	}
	p.BaseURL = strings.TrimSpace(cfg.BaseURL)
	p.Model = strings.TrimSpace(cfg.Model)
	if p.Name == "" {
		p.Name = nameFor(p.BaseURL)
	}
	// A blank key keeps the stored one: the settings page never receives the
	// key, so a model-only change sends a blank one back.
	if k := strings.TrimSpace(cfg.APIKey); k != "" {
		p.APIKey = k
	}
	s.ActiveID = p.ID
	s.ChatSystem = strings.TrimSpace(cfg.ChatSystem)
	return write(s)
}

// SaveProfile creates (blank ID) or updates one profile and returns what was
// stored — the caller needs the id, and the name a blank name resolved to.
// A blank key on an existing profile keeps the stored one, same rule as Save.
func SaveProfile(p Profile) (Profile, error) {
	p.Name = strings.TrimSpace(p.Name)
	p.BaseURL = strings.TrimSpace(p.BaseURL)
	p.Model = strings.TrimSpace(p.Model)
	p.APIKey = strings.TrimSpace(p.APIKey)
	if err := Validate(ai.Config{BaseURL: p.BaseURL, Model: p.Model}); err != nil {
		return Profile{}, err
	}
	if p.Name == "" {
		p.Name = nameFor(p.BaseURL)
	}
	s, err := LoadStore()
	if err != nil {
		return Profile{}, err
	}
	if p.ID == "" {
		p.ID = newID()
		s.Profiles = append(s.Profiles, p)
		// The first profile a reader adds is the one they mean to use: leaving
		// nothing in force would need a second tap to say "yes, that one".
		if s.ActiveID == "" {
			s.ActiveID = p.ID
		}
	} else {
		idx := -1
		for i := range s.Profiles {
			if s.Profiles[i].ID == p.ID {
				idx = i
				break
			}
		}
		if idx < 0 {
			return Profile{}, fmt.Errorf("配置不存在，可能已被删除")
		}
		if p.APIKey == "" {
			p.APIKey = s.Profiles[idx].APIKey
		}
		s.Profiles[idx] = p
	}
	if err := write(s); err != nil {
		return Profile{}, err
	}
	return p, nil
}

// DeleteProfile removes one configuration. Deleting the active one hands the
// role to whatever is left (first in the list): "nothing selected" while a
// working profile sits right there is a state that only confuses. A missing
// id is not an error — the row may be gone already.
func DeleteProfile(id string) error {
	s, err := LoadStore()
	if err != nil {
		return err
	}
	idx := -1
	for i := range s.Profiles {
		if s.Profiles[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return nil
	}
	s.Profiles = append(s.Profiles[:idx], s.Profiles[idx+1:]...)
	if s.ActiveID == id || s.activeIndex() < 0 {
		s.ActiveID = ""
		if len(s.Profiles) > 0 {
			s.ActiveID = s.Profiles[0].ID
		}
	}
	return write(s)
}

// Activate switches the profile in force. An unknown id is an error rather
// than a silent no-op: switching is the whole point of the page, and a row
// that stopped existing mid-tap should say so.
func Activate(id string) error {
	s, err := LoadStore()
	if err != nil {
		return err
	}
	if s.Profile(id) == nil {
		return fmt.Errorf("配置不存在，可能已被删除")
	}
	s.ActiveID = id
	return write(s)
}

// Validate checks the fields the settings page can get wrong: a URL without a
// scheme is the classic paste error, and a missing model would only surface
// as a confusing provider error later.
func Validate(cfg ai.Config) error {
	base := strings.TrimSpace(cfg.BaseURL)
	if base == "" {
		return fmt.Errorf("请填写接口地址")
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		return fmt.Errorf("接口地址必须以 http:// 或 https:// 开头")
	}
	if strings.TrimSpace(cfg.Model) == "" {
		return fmt.Errorf("请填写模型名称")
	}
	return nil
}

// NewView builds the masked view for the settings page.
func NewView(s Store) View {
	v := View{
		ActiveID:          s.ActiveID,
		Presets:           Presets(),
		ChatSystem:        strings.TrimSpace(s.ChatSystem),
		ChatSystemDefault: DefaultChatSystem,
		Profiles:          make([]ProfileView, 0, len(s.Profiles)),
	}
	activeKey := ""
	if p := s.Active(); p != nil {
		v.BaseURL = p.BaseURL
		v.Model = p.Model
		v.Configured = (ai.Config{BaseURL: p.BaseURL, Model: p.Model}).Configured()
		activeKey = p.APIKey
	}
	for i := range s.Profiles {
		v.Profiles = append(v.Profiles, ProfileViewOf(s.Profiles[i]))
	}
	v.KeySet, v.KeyHint = mask(activeKey)
	return v
}

// ProfileViewOf masks one profile — the shape a row of the settings list takes.
func ProfileViewOf(p Profile) ProfileView {
	set, hint := mask(p.APIKey)
	return ProfileView{
		ID: p.ID, Name: p.Name, BaseURL: p.BaseURL, Model: p.Model, KeySet: set, KeyHint: hint,
	}
}

// mask reports whether a key is stored, plus its last four characters — the
// most a screen may show, since the key must never reach a screenshot.
func mask(key string) (bool, string) {
	key = strings.TrimSpace(key)
	if key == "" {
		return false, ""
	}
	if len(key) > 4 {
		return true, "…" + key[len(key)-4:]
	}
	return true, "…" + key
}

// normalize makes a hand-edited or legacy file safe to read: every profile
// gets an id, blank rows are dropped (they would draw as an empty row and
// answer nothing), and something is in force whenever anything can be.
func normalize(s *Store) {
	kept := make([]Profile, 0, len(s.Profiles))
	for _, p := range s.Profiles {
		p.BaseURL = strings.TrimSpace(p.BaseURL)
		p.Model = strings.TrimSpace(p.Model)
		p.APIKey = strings.TrimSpace(p.APIKey)
		p.Name = strings.TrimSpace(p.Name)
		if p.BaseURL == "" && p.Model == "" {
			continue
		}
		if p.ID == "" {
			p.ID = newID()
		}
		if p.Name == "" {
			p.Name = nameFor(p.BaseURL)
		}
		kept = append(kept, p)
	}
	s.Profiles = kept
	s.ChatSystem = strings.TrimSpace(s.ChatSystem)
	if len(s.Profiles) == 0 {
		s.ActiveID = ""
		return
	}
	if s.ActiveID == "" || s.Profile(s.ActiveID) == nil {
		s.ActiveID = s.Profiles[0].ID
	}
}

// write is the one place that touches the disk: normalize, marshal, then
// write-then-rename so a crash mid-write cannot leave a truncated file
// holding half a key.
func write(s Store) error {
	normalize(&s)
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := Path() + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), filePerms); err != nil {
		return err
	}
	return os.Rename(tmp, Path())
}

// newID names a profile. Random rather than derived from the name, because
// the name is editable and an id that changed under the reader's hands would
// detach the "in force" mark from the row they just renamed.
func newID() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "p-" + time.Now().Format("150405.000000")
	}
	return hex.EncodeToString(b[:])
}

// nameFor labels a profile the reader did not name: the provider's name when
// the address matches a preset, its host otherwise. "我的接口" is the last
// resort for a half-typed address.
func nameFor(baseURL string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base != "" {
		for _, p := range Presets() {
			if strings.TrimRight(p.BaseURL, "/") == base {
				return p.Name
			}
		}
		host := base
		if i := strings.Index(host, "://"); i >= 0 {
			host = host[i+3:]
		}
		if i := strings.IndexByte(host, '/'); i >= 0 {
			host = host[:i]
		}
		if host != "" {
			return host
		}
	}
	return "我的接口"
}
