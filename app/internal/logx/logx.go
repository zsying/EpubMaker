// Package logx is the app's on-device diagnostic log.
//
// The app has no telemetry and never phones home (ADR-1), which makes a bug
// report a one-way street: the reader sees "AI 没有返回内容" and the developer
// sees nothing. This package closes that gap with a small, local record of what
// the app did — most importantly every AI request and answer, because those
// failures depend on a provider the developer cannot reach.
//
// Two sinks, on purpose:
//
//   - A ring buffer in memory (RingSize entries) that the settings page reads
//     back. Bounded, so a long session cannot grow the process.
//   - A JSONL file next to the other app data (RotateBytes, one generation
//     kept). This is the one that survives a crash or a WebView restart, which
//     is exactly when the in-memory copy is gone.
//
// Logging is switchable and defaults to ON: a diagnostic log that is off when
// the bug happens is worth nothing. It stays on the device, the settings page
// says so, and one switch turns it off.
package logx

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"epubmaker-desktop/internal/config"
)

// Levels, ordered by how loud they are. The UI filters on the error/warn pair.
const (
	LevelDebug = "debug"
	LevelInfo  = "info"
	LevelWarn  = "warn"
	LevelError = "error"
)

const (
	// RingSize is how many entries the settings page can scroll back through.
	// Big enough for a reading session with a dozen AI calls, small enough that
	// the whole buffer is a few hundred KB with the longest prompts in it.
	RingSize = 300
	// RotateBytes bounds the file. At ~1 KB an entry this is a few thousand
	// lines — several sessions — before the older generation is dropped.
	RotateBytes = 512 << 10
	// valueLimit caps one field. A chapter prompt is 6,000 characters; keeping
	// all of it in every copy would make the log useless to read and expensive
	// to keep. The head is what identifies the request, so that is what stays.
	valueLimit = 4000
	// tailBytes is how much of an existing file is parsed back into the ring at
	// startup — enough for the last few sessions, never the whole file.
	tailBytes = 128 << 10

	logFileName  = "app.log"
	rotateSuffix = ".1"
	// settingsFile keeps the on/off choice. It lives beside the log rather than
	// in config.json so that turning logging off never rewrites a file meant to
	// travel with backups.
	settingsFile = "logging.json"
)

// Entry is one line: what happened, where, and whatever detail the caller had.
// Data is a flat string map so the UI can render it without knowing the shape
// of any particular event.
type Entry struct {
	Time  string            `json:"time"`
	Level string            `json:"level"`
	Cat   string            `json:"cat"`
	Msg   string            `json:"msg"`
	Data  map[string]string `json:"data,omitempty"`
}

// Status is what the settings page needs to draw the switch and the file info.
type Status struct {
	Enabled bool   `json:"enabled"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Count   int    `json:"count"`
}

type settings struct {
	Enabled bool `json:"enabled"`
}

var (
	mu      sync.Mutex
	dir     string
	enabled = true
	started bool
	entries = make([]Entry, 0, RingSize)
)

// SetDir overrides where the log lives. Tests use it; the app resolves the
// directory from config on first use.
func SetDir(d string) {
	mu.Lock()
	defer mu.Unlock()
	dir = d
	started = false
	enabled = true // a new directory has no settings file yet
	entries = entries[:0]
}

// ensureLocked resolves the directory and loads the previous session's tail.
// Called with mu held, once per process.
func ensureLocked() {
	if started {
		return
	}
	started = true
	if dir == "" {
		if c := config.Get(); c != nil {
			dir = c.Paths.Logs
		}
	}
	if dir == "" {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	if raw, err := os.ReadFile(filepath.Join(dir, settingsFile)); err == nil {
		var s settings
		if json.Unmarshal(raw, &s) == nil {
			enabled = s.Enabled
		}
	}
	loadTailLocked()
}

// loadTailLocked reads the last chunk of the file into the ring, so opening the
// log after a restart shows the session that failed rather than an empty list.
func loadTailLocked() {
	p := filepath.Join(dir, logFileName)
	f, err := os.Open(p)
	if err != nil {
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() == 0 {
		return
	}
	off := int64(0)
	if st.Size() > tailBytes {
		off = st.Size() - tailBytes
	}
	buf := make([]byte, st.Size()-off)
	if _, err := f.ReadAt(buf, off); err != nil {
		return
	}
	lines := strings.Split(string(buf), "\n")
	for _, ln := range lines {
		ln = strings.TrimSpace(ln)
		if ln == "" || !strings.HasPrefix(ln, "{") {
			continue // a partial first line from the seek, or a torn write
		}
		var e Entry
		if json.Unmarshal([]byte(ln), &e) != nil {
			continue
		}
		appendRingLocked(e)
	}
}

func appendRingLocked(e Entry) {
	if len(entries) >= RingSize {
		copy(entries, entries[1:])
		entries = entries[:len(entries)-1]
	}
	entries = append(entries, e)
}

// Enabled reports whether events are being kept.
func Enabled() bool {
	mu.Lock()
	defer mu.Unlock()
	ensureLocked()
	return enabled
}

// SetEnabled flips logging. Turning it off keeps what is already there; the
// reader can clear it with Clear when they want it gone.
func SetEnabled(on bool) error {
	mu.Lock()
	defer mu.Unlock()
	ensureLocked()
	enabled = on
	if dir == "" {
		return nil
	}
	raw, err := json.Marshal(settings{Enabled: on})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, settingsFile), append(raw, '\n'), 0o600)
}

// Event records one entry. kv is a flat key/value list; an odd trailing key is
// ignored rather than panicking, because a log call must never break a feature.
func Event(level, cat, msg string, kv ...string) {
	mu.Lock()
	defer mu.Unlock()
	ensureLocked()
	if !enabled {
		return
	}
	e := Entry{
		Time:  time.Now().Format("2006-01-02 15:04:05.000"),
		Level: level,
		Cat:   cat,
		Msg:   clip(msg, valueLimit),
	}
	if len(kv) > 0 {
		e.Data = make(map[string]string, len(kv)/2+1)
		for i := 0; i+1 < len(kv); i += 2 {
			e.Data[kv[i]] = clip(kv[i+1], valueLimit)
		}
	}
	if len(entries) == 0 {
		e.Data = withEnv(e.Data)
	}
	appendRingLocked(e)
	writeLocked(e)
}

// withEnv stamps the first entry of a session with the facts a bug report
// always needs: which host, where its data lives.
func withEnv(d map[string]string) map[string]string {
	if d == nil {
		d = map[string]string{}
	}
	d["os"] = runtime.GOOS + "/" + runtime.GOARCH
	if dir != "" {
		d["logDir"] = dir
	}
	if c := config.Get(); c != nil {
		d["appHome"] = c.AppHome
	}
	return d
}

func writeLocked(e Entry) {
	if dir == "" {
		return
	}
	p := filepath.Join(dir, logFileName)
	if st, err := os.Stat(p); err == nil && st.Size() > RotateBytes {
		_ = os.Remove(p + rotateSuffix)
		_ = os.Rename(p, p+rotateSuffix)
	}
	raw, err := json.Marshal(e)
	if err != nil {
		return
	}
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(raw, '\n'))
}

// Entries returns the newest entries, oldest first. cat filters by category
// ("ai", "app", "ui", "nav") and level filters to one level or louder
// ("warn" keeps warn+error); both empty means everything.
func Entries(limit int, cat, level string) []Entry {
	mu.Lock()
	defer mu.Unlock()
	ensureLocked()
	minRank := rank(level)
	out := make([]Entry, 0, len(entries))
	for _, e := range entries {
		if cat != "" && e.Cat != cat {
			continue
		}
		if level != "" && rank(e.Level) < minRank {
			continue
		}
		out = append(out, e)
	}
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}

// State describes the log for the settings page.
func State() Status {
	mu.Lock()
	defer mu.Unlock()
	ensureLocked()
	s := Status{Enabled: enabled, Count: len(entries)}
	if dir == "" {
		return s
	}
	s.Path = filepath.Join(dir, logFileName)
	if st, err := os.Stat(s.Path); err == nil {
		s.Size = st.Size()
	}
	return s
}

// Clear empties both sinks. The file is truncated rather than removed so the
// path shown in the settings page stays valid.
func Clear() error {
	mu.Lock()
	defer mu.Unlock()
	ensureLocked()
	entries = entries[:0]
	if dir == "" {
		return nil
	}
	p := filepath.Join(dir, logFileName)
	_ = os.Remove(p + rotateSuffix)
	if err := os.Truncate(p, 0); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// clip shortens a value, saying how long it was: "…(已截断，原长 8123 字)"
// tells the reader the log is not showing everything, which matters when the
// text being clipped is the prompt that produced a bad answer.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…(已截断，原长 " + itoa(len(r)) + " 字)"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func rank(level string) int {
	switch level {
	case LevelDebug:
		return 0
	case LevelInfo:
		return 1
	case LevelWarn:
		return 2
	case LevelError:
		return 3
	}
	return -1
}
