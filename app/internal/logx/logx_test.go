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

// The file is allowed to grow to MaxBytes; past that the oldest TrimBytes go,
// so the log rolls instead of filling the phone.
func TestTrimDropsTheOldestWholeLines(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, logFileName)
	var sb strings.Builder
	for i := 0; i < 200; i++ {
		sb.WriteString(`{"time":"t","level":"info","cat":"app","msg":"line-` + string(rune('a'+i%26)) + `"}` + "\n")
	}
	if err := os.WriteFile(p, []byte(sb.String()), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	before, _ := os.Stat(p)

	dropped, ok := trimOldest(p, 2000)
	if !ok {
		t.Fatal("trim reported no work")
	}
	after, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if after.Size() != before.Size()-dropped {
		t.Errorf("size = %d, want %d", after.Size(), before.Size()-dropped)
	}
	if dropped < 2000 {
		t.Errorf("dropped = %d, want at least the requested 2000", dropped)
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	// Every surviving line must be a whole JSON object: a cut through the middle
	// of one would make the tail loader drop it and hide real history.
	for i, ln := range lines {
		if !strings.HasPrefix(ln, "{") || !strings.HasSuffix(ln, "}") {
			t.Fatalf("line %d is not a whole entry: %q", i, ln)
		}
	}
	if len(lines) < 50 {
		t.Errorf("kept only %d lines, expected most of the file to survive", len(lines))
	}
}

// A log that lost its newlines (a torn write, a hand-edited file) has no whole
// entry to keep past the cut — the file must be emptied rather than left
// holding a fragment that the tail loader silently drops.
func TestTrimWithNoWholeLineLeftEmptiesTheFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, logFileName)
	if err := os.WriteFile(p, []byte(strings.Repeat("x", 200)), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	dropped, ok := trimOldest(p, 50)
	if !ok {
		t.Fatal("trim reported no work on a file with no newline")
	}
	if dropped != 200 {
		t.Errorf("dropped = %d, want the whole 200", dropped)
	}
	st, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if st.Size() != 0 {
		t.Errorf("size = %d, want 0", st.Size())
	}
}

// Asking to drop more than the file holds is a no-op, not a wipe.
func TestTrimDoesNothingWhenAskExceedsTheFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, logFileName)
	body := "{\"msg\":\"one\"}\n{\"msg\":\"two\"}\n"
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, ok := trimOldest(p, 1<<20); ok {
		t.Fatal("trim should decline to drop more than the file holds")
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(raw) != body {
		t.Errorf("file changed: %q", raw)
	}
}

// Status carries the ceiling so the settings page can say what it is.
func TestStatusReportsTheCap(t *testing.T) {
	reset(t)
	s := State()
	if s.Max != MaxBytes || s.Trim != TrimBytes {
		t.Errorf("status = %+v, want max=%d trim=%d", s, MaxBytes, TrimBytes)
	}
}

// Crossing the ceiling must trim the file, keep writing into it, and leave a
// note that history was dropped — end to end, through Event().
func TestCrossingTheCeilingTrimsAndSaysSo(t *testing.T) {
	dir := reset(t)
	limitBytes, dropBytes = 4<<10, 3<<10
	t.Cleanup(func() { limitBytes, dropBytes = int64(MaxBytes), int64(TrimBytes) })

	// ~200 bytes a line, so a few dozen events cross 4 KB.
	pad := strings.Repeat("x", 150)
	for i := 0; i < 60; i++ {
		Event(LevelInfo, "app", "tick", "pad", pad)
	}
	p := filepath.Join(dir, logFileName)
	st, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if st.Size() > limitBytes {
		t.Errorf("file is %d bytes, over the %d ceiling", st.Size(), limitBytes)
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.Contains(string(raw), "已删除最早的部分") {
		t.Error("the trim left no note in the file")
	}
	// The log keeps working afterwards, and the ring carries the note too.
	Event(LevelError, "app", "after the trim")
	last := Entries(1, "", "")
	if len(last) != 1 || last[0].Msg != "after the trim" {
		t.Errorf("writing after a trim: %+v", last)
	}
	found := false
	for _, e := range Entries(0, "", "") {
		if strings.Contains(e.Msg, "已删除最早的部分") {
			found = true
			if e.Data["droppedBytes"] == "" || e.Data["maxBytes"] == "" {
				t.Errorf("the note should carry the sizes: %v", e.Data)
			}
		}
	}
	if !found {
		t.Error("the trim note never reached the ring buffer")
	}
}
