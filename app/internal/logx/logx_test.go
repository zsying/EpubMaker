package logx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMain pins AppHome at a temp dir: the first entry of a session records it,
// and a test run must never write into the developer's real profile.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "epubmaker-logx-")
	if err != nil {
		panic(err)
	}
	os.Setenv("EPUBMAKER_HOME", dir)
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func reset(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	SetDir(dir)
	t.Cleanup(func() { SetDir("") })
	return dir
}

func TestEventReachesRingAndFile(t *testing.T) {
	dir := reset(t)
	Event(LevelInfo, "ai", "request", "kind", "parse", "chars", "42")

	got := Entries(0, "", "")
	if len(got) != 1 {
		t.Fatalf("entries = %d, want 1", len(got))
	}
	e := got[0]
	if e.Level != LevelInfo || e.Cat != "ai" || e.Msg != "request" {
		t.Errorf("entry = %+v", e)
	}
	if e.Data["kind"] != "parse" || e.Data["chars"] != "42" {
		t.Errorf("data = %v", e.Data)
	}
	if e.Time == "" {
		t.Error("entry has no timestamp")
	}
	// The file is what survives a crash, so the same event must be in it.
	raw, err := os.ReadFile(filepath.Join(dir, logFileName))
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	if !strings.Contains(string(raw), `"kind":"parse"`) {
		t.Errorf("file = %s", raw)
	}
}

func TestRingStaysBounded(t *testing.T) {
	reset(t)
	for i := 0; i < RingSize+40; i++ {
		Event(LevelInfo, "app", "tick", "i", "x")
	}
	got := Entries(0, "", "")
	if len(got) != RingSize {
		t.Fatalf("len = %d, want %d", len(got), RingSize)
	}
}

func TestFilters(t *testing.T) {
	reset(t)
	Event(LevelInfo, "ai", "a")
	Event(LevelWarn, "ai", "b")
	Event(LevelError, "ui", "c")
	Event(LevelError, "ai", "d")

	if n := len(Entries(0, "ai", "")); n != 3 {
		t.Errorf("cat=ai -> %d, want 3", n)
	}
	if n := len(Entries(0, "", LevelWarn)); n != 3 {
		t.Errorf("level>=warn -> %d, want 3", n)
	}
	if n := len(Entries(0, "ai", LevelError)); n != 1 {
		t.Errorf("ai+error -> %d, want 1", n)
	}
	last := Entries(2, "", "")
	if len(last) != 2 || last[1].Msg != "d" {
		t.Errorf("limit keeps the newest: %+v", last)
	}
}

func TestSwitchOffAndOn(t *testing.T) {
	dir := reset(t)
	if err := SetEnabled(false); err != nil {
		t.Fatalf("SetEnabled: %v", err)
	}
	Event(LevelInfo, "ai", "dropped")
	if n := len(Entries(0, "", "")); n != 0 {
		t.Fatalf("entries = %d, want 0 while off", n)
	}
	// The choice must survive a restart, or the switch means nothing.
	SetDir(dir)
	if Enabled() {
		t.Fatal("disabled logging came back on after a restart")
	}
	if err := SetEnabled(true); err != nil {
		t.Fatalf("SetEnabled: %v", err)
	}
	Event(LevelInfo, "ai", "kept")
	if n := len(Entries(0, "", "")); n != 1 {
		t.Fatalf("entries = %d, want 1", n)
	}
}

func TestClearEmptiesBothSinks(t *testing.T) {
	dir := reset(t)
	Event(LevelError, "app", "boom")
	if err := Clear(); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if n := len(Entries(0, "", "")); n != 0 {
		t.Errorf("ring still holds %d", n)
	}
	st, err := os.Stat(filepath.Join(dir, logFileName))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if st.Size() != 0 {
		t.Errorf("file size = %d, want 0", st.Size())
	}
	// Clearing must not disable: the next event is exactly when it matters.
	Event(LevelInfo, "app", "after clear")
	if n := len(Entries(0, "", "")); n != 1 {
		t.Errorf("entries after clear = %d, want 1", n)
	}
}

func TestTailLoadsOnRestart(t *testing.T) {
	dir := reset(t)
	Event(LevelError, "app", "before restart", "why", "crash")
	// Same directory, fresh process state.
	SetDir(dir)
	got := Entries(0, "", "")
	if len(got) != 1 || got[0].Msg != "before restart" {
		t.Fatalf("entries = %+v", got)
	}
	if got[0].Data["why"] != "crash" {
		t.Errorf("data = %v", got[0].Data)
	}
}

func TestLongValuesAreClippedAndSaySo(t *testing.T) {
	reset(t)
	long := strings.Repeat("字", valueLimit+50)
	Event(LevelInfo, "ai", "request", "user", long)
	e := Entries(0, "", "")[0]
	if !strings.Contains(e.Data["user"], "已截断") {
		t.Errorf("a %d-rune value should be marked as clipped", len([]rune(long)))
	}
	if len([]rune(e.Data["user"])) > valueLimit+40 {
		t.Errorf("clip did not shorten enough: %d", len([]rune(e.Data["user"])))
	}
}

func TestFirstEntryCarriesEnvironment(t *testing.T) {
	reset(t)
	Event(LevelInfo, "app", "会话开始")
	e := Entries(0, "", "")[0]
	if e.Data["os"] == "" {
		t.Errorf("the first entry should name the host OS: %v", e.Data)
	}
}
