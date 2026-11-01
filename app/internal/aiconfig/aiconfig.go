// Package aiconfig stores the BYOK provider settings on the device.
//
// The settings live in <AppHome>/ai.json with 0600 permissions, deliberately
// NOT in config.json: that file is written 0644 and is meant to be copied
// around with backups, and an API key must not travel with it. The file is
// plain JSON so a user can hand-edit it.
//
// The key never leaves the device through the app's own APIs: the settings
// page reads View (masked), and Save treats a blank key as "keep the stored
// one" so changing the model never forces a re-paste.
package aiconfig

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

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

// View is the settings-page shape. The key itself is never included — only
// whether one is stored and its last four characters, enough to recognize.
type View struct {
	BaseURL string   `json:"baseUrl"`
	Model   string   `json:"model"`
	KeySet  bool     `json:"keySet"`
	KeyHint string   `json:"keyHint"`
	Presets []Preset `json:"presets"`
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

// Load reads the settings file. A missing or corrupt file is not an error:
// the app runs with AI unconfigured and every entry point says so.
func Load() (ai.Config, error) {
	var cfg ai.Config
	raw, err := os.ReadFile(Path())
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return ai.Config{}, err
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return ai.Config{}, nil
	}
	cfg.BaseURL = strings.TrimSpace(cfg.BaseURL)
	cfg.APIKey = strings.TrimSpace(cfg.APIKey)
	cfg.Model = strings.TrimSpace(cfg.Model)
	cfg.ChatSystem = strings.TrimSpace(cfg.ChatSystem)
	return cfg, nil
}

// Save writes the settings, keeping any stored key when the incoming one is
// blank (the settings page never receives the key, so a model-only change
// sends a blank one).
func Save(cfg ai.Config) error {
	if err := Validate(cfg); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.APIKey) == "" {
		if existing, err := Load(); err == nil {
			cfg.APIKey = existing.APIKey
		}
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	// Write-then-rename so a crash mid-write cannot leave a truncated file
	// holding half a key.
	tmp := Path() + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), filePerms); err != nil {
		return err
	}
	return os.Rename(tmp, Path())
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
func NewView(cfg ai.Config) View {
	v := View{
		BaseURL:           cfg.BaseURL,
		Model:             cfg.Model,
		Presets:           Presets(),
		Configured:        cfg.Configured(),
		ChatSystem:        strings.TrimSpace(cfg.ChatSystem),
		ChatSystemDefault: DefaultChatSystem,
	}
	if key := strings.TrimSpace(cfg.APIKey); key != "" {
		v.KeySet = true
		if len(key) > 4 {
			v.KeyHint = "…" + key[len(key)-4:]
		} else {
			v.KeyHint = "…" + key
		}
	}
	return v
}
