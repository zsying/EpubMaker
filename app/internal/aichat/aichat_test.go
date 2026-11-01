package aichat

import (
	"os"
	"strings"
	"testing"

	"epubmaker-desktop/internal/db"
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "epubmaker-aichat-test")
	if err != nil {
		panic(err)
	}
	os.Setenv("EPUBMAKER_HOME", dir)
	code := m.Run()
	_ = db.Close()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// reset empties both tables so every test starts from an empty transcript
// store. Messages go first: a plain DELETE (no cascade reliance) keeps the
// test honest even if the schema ever drops the foreign key.
func reset(t *testing.T) {
	t.Helper()
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	for _, q := range []string{`DELETE FROM ai_messages`, `DELETE FROM ai_conversations`} {
		if _, err := d.Exec(q); err != nil {
			t.Fatalf("clear %s: %v", q, err)
		}
	}
}

func mkConv(t *testing.T, title, origin, cacheKey string) *Conversation {
	t.Helper()
	c := &Conversation{Title: title, Origin: origin, CacheKey: cacheKey}
	msgs := []Message{
		{Role: "system", Content: "system prompt"},
		{Role: "user", Content: "user question"},
		{Role: "assistant", Content: "assistant answer"},
	}
	if err := Create(c, msgs); err != nil {
		t.Fatalf("Create: %v", err)
	}
	return c
}

func TestCreateFillsIDsAndTimestamps(t *testing.T) {
	reset(t)
	c := mkConv(t, "turn", "lookup", "lookup:abc")
	if c.ID == "" {
		t.Fatal("Create must fill the conversation id")
	}
	if c.CreatedAt == "" || c.UpdatedAt == "" {
		t.Fatal("Create must fill both timestamps")
	}

	msgs, err := Messages(c.ID)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(msgs) != 3 {
		t.Fatalf("messages = %d, want 3", len(msgs))
	}
	// Transcript order: system first, then the exchange. A conversation view
	// that reorders these is not the conversation that happened.
	wantRoles := []string{"system", "user", "assistant"}
	for i, m := range msgs {
		if m.Role != wantRoles[i] {
			t.Errorf("msg[%d].role = %q, want %q", i, m.Role, wantRoles[i])
		}
		if m.ConversationID != c.ID {
			t.Errorf("msg[%d].conversationId = %q, want %q", i, m.ConversationID, c.ID)
		}
		if m.ID == "" {
			t.Errorf("msg[%d] has no id", i)
		}
	}
}

func TestListIsOrderedByRecency(t *testing.T) {
	reset(t)
	first := mkConv(t, "第一", "lookup", "k1")
	second := mkConv(t, "第二", "manual", "k2")
	// Touch the first one later: a continuation bumps it to the top, which is
	// exactly why the list is sorted by updated_at and not by created_at.
	if _, err := Append(first.ID, "user", "还有呢？"); err != nil {
		t.Fatalf("Append: %v", err)
	}

	list, err := List(50)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("List = %d conversations, want 2", len(list))
	}
	if list[0].ID != first.ID || list[1].ID != second.ID {
		t.Errorf("order = [%s %s], want the touched conversation first", list[0].ID, list[1].ID)
	}
	if list[0].Title != "第一" {
		t.Errorf("title = %q", list[0].Title)
	}
}

func TestByCacheKeyDeduplicates(t *testing.T) {
	reset(t)
	mkConv(t, "turn", "lookup", "lookup:same")
	got, err := ByCacheKey("lookup:same")
	if err != nil {
		t.Fatalf("ByCacheKey: %v", err)
	}
	if got == nil {
		t.Fatal("ByCacheKey = nil, want the stored conversation")
	}
	if got.Title != "turn" {
		t.Errorf("title = %q", got.Title)
	}
	if other, err := ByCacheKey("lookup:other"); err != nil || other != nil {
		t.Errorf("ByCacheKey(miss) = %+v, %v; want nil, nil", other, err)
	}
}

func TestAppendBumpsUpdatedAt(t *testing.T) {
	reset(t)
	c := mkConv(t, "聊", "manual", "")
	before := c.UpdatedAt
	m, err := Append(c.ID, "user", "为什么用过去式？")
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	if m.Role != "user" || m.Content != "为什么用过去式？" {
		t.Errorf("appended = %+v", m)
	}
	after, err := Get(c.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	// RFC3339Nano in UTC sorts lexically, so a string compare is the ordering
	// the list query itself will use.
	if after.UpdatedAt <= before {
		t.Errorf("updated_at did not move forward: %q -> %q", before, after.UpdatedAt)
	}
	msgs, _ := Messages(c.ID)
	if len(msgs) != 4 || msgs[3].Role != "user" {
		t.Errorf("messages after append = %+v", msgs)
	}
}

func TestDeleteRemovesMessages(t *testing.T) {
	reset(t)
	c := mkConv(t, "删我", "parse", "k-del")
	if err := Delete(c.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got, _ := Get(c.ID); got != nil {
		t.Error("conversation survived Delete")
	}
	msgs, err := Messages(c.ID)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(msgs) != 0 {
		t.Errorf("%d messages outlived their conversation", len(msgs))
	}
}

func TestGetMissingIsNilNotError(t *testing.T) {
	reset(t)
	c, err := Get("nope")
	if err != nil || c != nil {
		t.Errorf("Get(missing) = %+v, %v; want nil, nil", c, err)
	}
}

func TestTitleClampForLongInput(t *testing.T) {
	reset(t)
	long := strings.Repeat("字", 80)
	got := TitleOf(long)
	if len([]rune(got)) > 40 {
		t.Errorf("TitleOf kept %d runes, want a clamped title", len([]rune(got)))
	}
}

func TestDeleteMessage(t *testing.T) {
	reset(t)
	c := mkConv(t, "回滚", "manual", "")
	msgs, _ := Messages(c.ID)
	last := msgs[len(msgs)-1]
	if err := DeleteMessage(last.ID); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}
	after, _ := Messages(c.ID)
	if len(after) != len(msgs)-1 {
		t.Errorf("messages = %d, want %d after the delete", len(after), len(msgs)-1)
	}
	// Deleting something twice is a no-op, not an error: the rollback path
	// that uses this may race a user deleting the whole conversation.
	if err := DeleteMessage(last.ID); err != nil {
		t.Errorf("second delete = %v, want nil", err)
	}
}

// ListDetailed is the list page's single query: recency order plus, per row,
// how many turns it holds and the last thing said in it (system prompts are
// not preview material — the row should quote the conversation, not the
// boilerplate that shaped it).
func TestListDetailed(t *testing.T) {
	reset(t)
	c := mkConv(t, "turn", "lookup", "k-list")
	if _, err := Append(c.ID, "user", "还有别的用法吗？"); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if _, err := Append(c.ID, "assistant", "有，turn up 表示出现。"); err != nil {
		t.Fatalf("Append: %v", err)
	}
	items, err := ListDetailed(Filter{}, 50, 0)
	if err != nil {
		t.Fatalf("ListDetailed: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	it := items[0]
	if it.Count != 5 {
		t.Errorf("count = %d, want 5", it.Count)
	}
	if it.Preview != "有，turn up 表示出现。" {
		t.Errorf("preview = %q, want the last non-system message", it.Preview)
	}
}

// The list is paged because a year of lookups must not arrive in one payload.
// Pages must tile the whole set exactly: no repeats at a boundary, nothing
// skipped, and the newest activity always on page one.
func TestListDetailedPagesTileTheSet(t *testing.T) {
	reset(t)
	for _, title := range []string{"一", "二", "三", "四", "五"} {
		mkConv(t, title, "lookup", "k-"+title)
	}
	first, err := ListDetailed(Filter{}, 2, 0)
	if err != nil {
		t.Fatalf("ListDetailed page 1: %v", err)
	}
	second, err := ListDetailed(Filter{}, 2, 2)
	if err != nil {
		t.Fatalf("ListDetailed page 2: %v", err)
	}
	last, err := ListDetailed(Filter{}, 2, 4)
	if err != nil {
		t.Fatalf("ListDetailed page 3: %v", err)
	}
	if len(first) != 2 || len(second) != 2 || len(last) != 1 {
		t.Fatalf("page sizes = %d/%d/%d, want 2/2/1", len(first), len(second), len(last))
	}
	seen := map[string]bool{}
	var order []string
	for _, page := range [][]ListItem{first, second, last} {
		for _, it := range page {
			if seen[it.ID] {
				t.Fatalf("conversation %q appeared on two pages", it.Title)
			}
			seen[it.ID] = true
			order = append(order, it.Title)
		}
	}
	if len(order) != 5 {
		t.Fatalf("paged through %d rows, want 5", len(order))
	}
	// Newest activity first: the five were created in order, so the list runs
	// backwards through creation.
	if strings.Join(order, ",") != "五,四,三,二,一" {
		t.Errorf("order = %s", strings.Join(order, ","))
	}

	total, err := CountFiltered(Filter{})
	if err != nil {
		t.Fatalf("Total: %v", err)
	}
	if total != 5 {
		t.Errorf("total = %d, want 5", total)
	}
}

// The list page can be narrowed to one origin and/or a search term, and the
// header count has to agree with the page it labels — they share Filter.where
// for exactly that reason.
//
// The keyword searches message bodies too: what a reader remembers about a
// conversation is usually something that was said in it, not the twelve
// characters the row's title clips to.
func TestFilterNarrowsListAndCount(t *testing.T) {
	reset(t)
	mkConv(t, "harbour", "lookup", "k-h")
	mkConv(t, "虚拟语气怎么用", "manual", "k-v")
	if err := Create(&Conversation{Title: "语法", Origin: "manual", CacheKey: "k-body"},
		[]Message{
			{Role: "system", Content: "system prompt"},
			{Role: "user", Content: "这句什么意思？"},
			{Role: "assistant", Content: "这里用的是 subjunctive mood。"},
		}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	// A title with LIKE's wildcard in it: "10%" must be a literal, or one
	// search would list the whole library.
	mkConv(t, "10% 折扣", "manual", "k-pct")

	for _, tc := range []struct {
		name string
		f    Filter
		want int
	}{
		{"everything", Filter{}, 4},
		{"by origin", Filter{Origin: "lookup"}, 1},
		{"by title", Filter{Keyword: "虚拟"}, 1},
		{"by message body", Filter{Keyword: "SUBJUNCTIVE"}, 1},
		{"wildcard is literal", Filter{Keyword: "10%"}, 1},
		{"origin and keyword together", Filter{Origin: "lookup", Keyword: "虚拟"}, 0},
		{"no match", Filter{Keyword: "无关的词"}, 0},
	} {
		items, err := ListDetailed(tc.f, 50, 0)
		if err != nil {
			t.Fatalf("%s: ListDetailed: %v", tc.name, err)
		}
		n, err := CountFiltered(tc.f)
		if err != nil {
			t.Fatalf("%s: Count: %v", tc.name, err)
		}
		if len(items) != tc.want || n != tc.want {
			t.Errorf("%s: rows = %d, count = %d, want %d", tc.name, len(items), n, tc.want)
		}
	}
}

// A grounded answer is JSON, so a verbatim preview would put `{"summary":"…`
// on the list page instead of the answer. The row quotes the answer; the
// transcript keeps the object.
func TestPreviewKeepsTheAnswerNotThePunctuation(t *testing.T) {
	reset(t)
	c := &Conversation{Title: "第一章", Origin: "summarize", CacheKey: "k-prev"}
	msgs := []Message{
		{Role: "system", Content: "system prompt"},
		{Role: "user", Content: "章节标题：第一章"},
		{Role: "assistant", Content: `{"summary":"爱丽丝犯困。","points":["要点"],"terms":[]}`},
	}
	if err := Create(c, msgs); err != nil {
		t.Fatalf("Create: %v", err)
	}
	items, err := ListDetailed(Filter{}, 10, 0)
	if err != nil {
		t.Fatalf("ListDetailed: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("items = %d", len(items))
	}
	if items[0].Preview != "爱丽丝犯困。" {
		t.Errorf("preview = %q, want the summary without its JSON wrapper", items[0].Preview)
	}

	// A reply that happens to be JSON but says nothing we recognise still
	// gets one readable line, not a wall of braces.
	if got := previewOf(`{"unknown":"一句话\n换了行"}`); got != "一句话 换了行" {
		t.Errorf("previewOf fallback = %q", got)
	}
	// Prose keeps its punctuation, minus the line breaks.
	if got := previewOf("  第一行\n第二行  "); got != "第一行 第二行" {
		t.Errorf("previewOf prose = %q", got)
	}
}
