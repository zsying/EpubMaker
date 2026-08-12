// Package config reads (and on first run creates) ~/.epubmaker/config.json,
// resolves all paths relative to APP_HOME, and ensures directories exist.
// This is a port of server/src/config.ts.
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
)

// AppConfig is the persisted config shape (config.json).
type AppConfig struct {
	Port             int    `json:"port"`
	Host             string `json:"host"`
	DataDir          string `json:"dataDir"`
	ExportDir        string `json:"exportDir"`
	LogDir           string `json:"logDir"`
	TmpDir           string `json:"tmpDir"`
	LogLevel         string `json:"logLevel"`
	MaxUploadSizeMb  int    `json:"maxUploadSizeMb"`
	KeepOriginalEpub bool   `json:"keepOriginalEpub"`
}

// Paths holds absolute resolved paths.
type Paths struct {
	Data    string `json:"data"`
	Exports string `json:"exports"`
	Logs    string `json:"logs"`
	Tmp     string `json:"tmp"`
	Books   string `json:"books"`
	DbFile  string `json:"dbFile"`
}

// Resolved is the full config with absolute paths filled in.
type Resolved struct {
	AppConfig
	AppHome    string `json:"appHome"`
	ConfigFile string `json:"configFile"`
	Paths      Paths  `json:"paths"`
}

var defaults = AppConfig{
	Port: 7801, Host: "127.0.0.1",
	DataDir: "data", ExportDir: "exports", LogDir: "logs", TmpDir: "tmp",
	LogLevel: "info", MaxUploadSizeMb: 300, KeepOriginalEpub: true,
}

var cached *Resolved

func appHome() string {
	if v := os.Getenv("EPUBMAKER_HOME"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".epubmaker")
}

// Load reads (creating if needed) the config and caches it. Pass force=true to
// re-read from disk.
func Load(force bool) (*Resolved, error) {
	if cached != nil && !force {
		return cached, nil
	}
	ah := appHome()
	if err := os.MkdirAll(ah, 0o755); err != nil {
		return nil, err
	}
	cfgFile := filepath.Join(ah, "config.json")

	raw := map[string]interface{}{}
	if b, err := os.ReadFile(cfgFile); err == nil {
		_ = json.Unmarshal(b, &raw)
	}

	merged := defaults
	overlayString := func(key, dst string) string {
		if v, ok := raw[key].(string); ok {
			return v
		}
		return dst
	}
	overlayInt := func(key string, dst int) int {
		if v, ok := raw[key].(float64); ok {
			return int(v)
		}
		return dst
	}
	merged.Host = overlayString("host", merged.Host)
	merged.DataDir = overlayString("dataDir", merged.DataDir)
	merged.ExportDir = overlayString("exportDir", merged.ExportDir)
	merged.LogDir = overlayString("logDir", merged.LogDir)
	merged.TmpDir = overlayString("tmpDir", merged.TmpDir)
	merged.LogLevel = overlayString("logLevel", merged.LogLevel)
	merged.Port = overlayInt("port", merged.Port)
	merged.MaxUploadSizeMb = overlayInt("maxUploadSizeMb", merged.MaxUploadSizeMb)
	if v, ok := raw["keepOriginalEpub"].(bool); ok {
		merged.KeepOriginalEpub = v
	}

	if p := os.Getenv("EPUBMAKER_PORT"); p != "" {
		if n, err := strconv.Atoi(p); err == nil {
			merged.Port = n
		}
	}
	if h := os.Getenv("EPUBMAKER_HOST"); h != "" {
		merged.Host = h
	}

	// Write back on first run, or when new default fields are absent.
	needWrite := true
	if _, err := os.Stat(cfgFile); err == nil {
		needWrite = false
		for _, k := range []string{"port", "host", "dataDir", "exportDir", "logDir", "tmpDir", "logLevel", "maxUploadSizeMb", "keepOriginalEpub"} {
			if _, ok := raw[k]; !ok {
				needWrite = true
				break
			}
		}
	}
	if needWrite {
		if jb, err := json.MarshalIndent(merged, "", "  "); err == nil {
			_ = os.WriteFile(cfgFile, append(jb, '\n'), 0o644)
		}
	}

	resolve := func(v string) string {
		if filepath.IsAbs(v) {
			return v
		}
		return filepath.Join(ah, v)
	}
	dataDir := resolve(merged.DataDir)
	r := &Resolved{
		AppConfig:  merged,
		AppHome:    ah,
		ConfigFile: cfgFile,
		Paths: Paths{
			Data:    dataDir,
			Exports: resolve(merged.ExportDir),
			Logs:    resolve(merged.LogDir),
			Tmp:     resolve(merged.TmpDir),
			Books:   filepath.Join(dataDir, "books"),
			DbFile:  filepath.Join(dataDir, "epubmaker.db"),
		},
	}
	for _, d := range []string{r.Paths.Data, r.Paths.Exports, r.Paths.Logs, r.Paths.Tmp, r.Paths.Books} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}
	cached = r
	return r, nil
}

// Get returns the cached (or loaded) config.
func Get() *Resolved {
	r, _ := Load(false)
	return r
}
