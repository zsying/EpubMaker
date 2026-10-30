package app

import (
	"strings"
	"time"

	"epubmaker-desktop/internal/logx"
)

// The diagnostic log, exposed to the settings page.
//
// This is the only window the reader has into what the app did: the AI
// features depend on a provider that neither they nor the developer can
// inspect afterwards, so "it said 没有返回内容" is otherwise unfalsifiable. The
// log is local, switchable, and clearable (see internal/logx).

// GetLogState reports whether logging is on, where the file lives and how much
// is in the buffer.
func (b *Backend) GetLogState() (*logx.Status, error) {
	s := logx.State()
	return &s, nil
}

// ListLogEntries returns the newest entries, oldest first. cat and level are
// optional filters ("ai", "ui", "nav"; level is a minimum: "warn" keeps warnings
// and errors). limit<=0 means the whole buffer.
func (b *Backend) ListLogEntries(limit int, cat, level string) ([]logx.Entry, error) {
	if limit <= 0 || limit > logx.RingSize {
		limit = logx.RingSize
	}
	return logx.Entries(limit, strings.TrimSpace(cat), strings.TrimSpace(level)), nil
}

// SetLogEnabled turns the diagnostic log on or off. The choice is persisted.
func (b *Backend) SetLogEnabled(enabled bool) error {
	return logx.SetEnabled(enabled)
}

// ClearLog empties the buffer and truncates the file.
func (b *Backend) ClearLog() error {
	return logx.Clear()
}

// LogClient records something the frontend saw — a JS error, an unhandled
// promise rejection, a route change. The WebView's own console dies with the
// process, and the failures that leave a blank screen are exactly the ones
// that never reach Go any other way.
func (b *Backend) LogClient(level, cat, message, detail string) error {
	level = normalizeLevel(level)
	if strings.TrimSpace(cat) == "" {
		cat = "ui"
	}
	if d := strings.TrimSpace(detail); d != "" {
		logx.Event(level, cat, message, "detail", d)
		return nil
	}
	logx.Event(level, cat, message)
	return nil
}

// SetTimezone tells the process what wall clock to log in. Android sandboxes
// the app away from any zoneinfo database, so Go's time.Local falls back to
// UTC there and every log line reads eight hours off the phone's clock. The
// frontend hands over what the WebView already knows — the IANA zone id plus
// its offset in seconds east of UTC — and time.FixedZone needs no database
// files, so this works where time.LoadLocation would fail.
func (b *Backend) SetTimezone(name string, offsetSeconds int) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	time.Local = time.FixedZone(name, offsetSeconds)
	return nil
}

// normalizeLevel keeps a bad argument from making an entry invisible to the
// level filter (rank() returns -1 for anything unknown).
func normalizeLevel(level string) string {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case logx.LevelDebug:
		return logx.LevelDebug
	case logx.LevelWarn:
		return logx.LevelWarn
	case logx.LevelError:
		return logx.LevelError
	}
	return logx.LevelInfo
}
