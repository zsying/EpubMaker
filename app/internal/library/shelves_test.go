package library

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"epubmaker-desktop/internal/db"
	"epubmaker-desktop/internal/storage"
)

// resetShelfState wipes the shared test database down to "one empty default
// shelf" and forgets every unlock. The library tests all share one database
// (see TestMain), so anything that reads counts has to start from a known
// shape — and the in-memory lock map is process-wide, so it has to be cleared
// as deliberately as the tables.
func resetShelfState(t *testing.T) {
	t.Helper()
	resetLibraryTables(t)
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if _, err := d.Exec(`DELETE FROM shelves`); err != nil {
		t.Fatalf("clear shelves: %v", err)
	}
	ts := time.Now().UTC().Format(time.RFC3339)
	if _, err := d.Exec(
		`INSERT INTO shelves (id, name, position, created_at, updated_at) VALUES (?,?,?,?,?)`,
		DefaultShelfID, "书架", 0, ts, ts); err != nil {
		t.Fatalf("seed default shelf: %v", err)
	}
	shelfLocks.Lock()
	shelfLocks.unlocked = map[string]bool{}
	shelfLocks.fails = map[string]*unlockFailure{}
	shelfLocks.Unlock()
}

func insertBookOnShelf(t *testing.T, id, title, shelfID string) {
	t.Helper()
	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	ts := time.Now().UTC().Format(time.RFC3339)
	if _, err := d.Exec(
		`INSERT INTO books (id, title, author, language, created_at, updated_at, shelf_id)
		 VALUES (?,?,?,?,?,?,?)`, id, title, "作者", "zh", ts, ts, shelfID); err != nil {
		t.Fatalf("insert book %s: %v", id, err)
	}
}

func shelfCounts(t *testing.T) map[string]int {
	t.Helper()
	list, err := ListShelves()
	if err != nil {
		t.Fatalf("ListShelves: %v", err)
	}
	out := map[string]int{}
	for _, s := range list {
		out[s.Name] = s.BookCount
	}
	return out
}

func mustShelf(t *testing.T, name string) *ShelfDTO {
	t.Helper()
	list, err := ListShelves()
	if err != nil {
		t.Fatalf("ListShelves: %v", err)
	}
	for i := range list {
		if list[i].Name == name {
			return &list[i]
		}
	}
	t.Fatalf("no shelf named %q", name)
	return nil
}

// A fresh database must already have the one shelf every existing book lives
// on, otherwise the shelf page would open on nothing.
func TestFreshDatabaseHasTheDefaultShelf(t *testing.T) {
	resetShelfState(t)
	list, err := ListShelves()
	if err != nil {
		t.Fatalf("ListShelves: %v", err)
	}
	if len(list) != 1 || list[0].ID != DefaultShelfID || list[0].Name != "书架" {
		t.Fatalf("want the single default shelf, got %+v", list)
	}
	if list[0].HasLock || list[0].Locked {
		t.Fatalf("a shelf with no password is never locked: %+v", list[0])
	}
}

func TestShelfNameRules(t *testing.T) {
	resetShelfState(t)
	if _, err := CreateShelf("   "); err == nil {
		t.Fatal("an empty name must be refused")
	}
	if _, err := CreateShelf(strings.Repeat("长", shelfNameMax+1)); err == nil {
		t.Fatal("an over-long name must be refused")
	}
	// The name is trimmed before it is stored: a trailing space would make two
	// shelves that look identical in the switcher.
	s, err := CreateShelf("  小说  ")
	if err != nil {
		t.Fatalf("CreateShelf: %v", err)
	}
	if s.Name != "小说" {
		t.Fatalf("want trimmed name, got %q", s.Name)
	}
	if _, err := CreateShelf("小说"); err == nil {
		t.Fatal("a duplicate name must be refused")
	}
	// The default shelf can be renamed — it is an ordinary shelf.
	if _, err := RenameShelf(DefaultShelfID, "全部"); err != nil {
		t.Fatalf("rename default: %v", err)
	}
	if _, err := RenameShelf(s.ID, "全部"); err == nil {
		t.Fatal("renaming onto an existing name must be refused")
	}
	if _, err := RenameShelf("nope", "x"); !errors.Is(err, ErrShelfNotFound) {
		t.Fatalf("want ErrShelfNotFound, got %v", err)
	}
}

func TestDeleteShelfReturnsItsBooksToTheDefaultShelf(t *testing.T) {
	resetShelfState(t)
	s, err := CreateShelf("小说")
	if err != nil {
		t.Fatalf("CreateShelf: %v", err)
	}
	insertBookOnShelf(t, "b1", "一号", s.ID)
	insertBookOnShelf(t, "b2", "二号", s.ID)

	moved, err := DeleteShelf(s.ID)
	if err != nil {
		t.Fatalf("DeleteShelf: %v", err)
	}
	if moved != 2 {
		t.Fatalf("want 2 books moved back, got %d", moved)
	}
	// The books must survive: removing a label must never remove the books.
	got := shelfCounts(t)
	if got["书架"] != 2 || len(got) != 1 {
		t.Fatalf("books should be back on the default shelf: %+v", got)
	}
	books, err := ListBooks("", DefaultShelfID)
	if err != nil {
		t.Fatalf("ListBooks: %v", err)
	}
	if len(books) != 2 {
		t.Fatalf("want both books listed, got %d", len(books))
	}
	if _, err := DeleteShelf(DefaultShelfID); err == nil {
		t.Fatal("the default shelf must not be deletable")
	}
}

func TestMoveBooksBatch(t *testing.T) {
	resetShelfState(t)
	s, err := CreateShelf("小说")
	if err != nil {
		t.Fatalf("CreateShelf: %v", err)
	}
	insertBookOnShelf(t, "b1", "一号", DefaultShelfID)
	insertBookOnShelf(t, "b2", "二号", DefaultShelfID)
	insertBookOnShelf(t, "b3", "三号", DefaultShelfID)

	// A batch with an id that does not exist moves the rest and reports what it
	// actually moved — a stale selection must not fail the whole request.
	n, err := MoveBooks([]string{"b1", "b3", "gone"}, s.ID)
	if err != nil {
		t.Fatalf("MoveBooks: %v", err)
	}
	if n != 2 {
		t.Fatalf("want 2 moved, got %d", n)
	}
	books, err := ListBooks("", s.ID)
	if err != nil {
		t.Fatalf("ListBooks: %v", err)
	}
	if len(books) != 2 {
		t.Fatalf("shelf 小说 should hold 2 books, got %d", len(books))
	}
	if _, err := MoveBooks([]string{"b1"}, "nope"); !errors.Is(err, ErrShelfNotFound) {
		t.Fatalf("want ErrShelfNotFound, got %v", err)
	}
	// An empty selection is a no-op, not an error: the UI can send it.
	if n, err := MoveBooks(nil, s.ID); err != nil || n != 0 {
		t.Fatalf("empty move: got (%d, %v)", n, err)
	}
}

func TestPasswordLocksTheShelfAndItsBooks(t *testing.T) {
	resetShelfState(t)
	s, err := CreateShelf("日记")
	if err != nil {
		t.Fatalf("CreateShelf: %v", err)
	}
	insertBookOnShelf(t, "b1", "私事", s.ID)
	insertChapterRow(t, "b1", "c1", 0)

	if _, err := SetShelfLock(s.ID, "", "1234"); err != nil {
		t.Fatalf("SetShelfLock: %v", err)
	}
	// Setting the password is proof of knowing it: the shelf stays open.
	open := mustShelf(t, "日记")
	if !open.HasLock || open.Locked {
		t.Fatalf("just-set shelf should be open: %+v", open)
	}
	if err := LockShelf(s.ID); err != nil {
		t.Fatalf("LockShelf: %v", err)
	}
	locked := mustShelf(t, "日记")
	if !locked.Locked {
		t.Fatalf("shelf should be locked: %+v", locked)
	}
	if locked.BookCount != 1 {
		t.Fatalf("the count stays visible (the name is visible anyway): %+v", locked)
	}

	if books, err := ListBooks("", s.ID); err != nil || len(books) != 0 {
		t.Fatalf("a locked shelf lists nothing, got %d (%v)", len(books), err)
	}
	if _, err := GetBook("b1"); !errors.Is(err, ErrShelfLocked) {
		t.Fatalf("GetBook must refuse a locked shelf, got %v", err)
	}
	if _, err := GetChapterRow("b1", "c1"); !errors.Is(err, ErrShelfLocked) {
		t.Fatalf("chapter content must refuse a locked shelf, got %v", err)
	}
	// Every write to a locked shelf is refused, so "moved into an invisible
	// shelf" can never silently happen.
	if _, err := RenameShelf(s.ID, "日记本"); !errors.Is(err, ErrShelfLocked) {
		t.Fatalf("rename should be refused, got %v", err)
	}
	if _, err := DeleteShelf(s.ID); !errors.Is(err, ErrShelfLocked) {
		t.Fatalf("delete should be refused, got %v", err)
	}
	if _, err := MoveBooks([]string{"b1"}, s.ID); !errors.Is(err, ErrShelfLocked) {
		t.Fatalf("moving in should be refused, got %v", err)
	}
	if _, err := SetShelfLock(s.ID, "", "9999"); err == nil {
		t.Fatal("changing the password without the old one must fail")
	}

	// Wrong password: an answer, not an error — the UI has to show the backoff.
	if r, err := UnlockShelf(s.ID, "0000"); err != nil || r.OK {
		t.Fatalf("wrong password: got (%+v, %v)", r, err)
	}
	if r, err := UnlockShelf(s.ID, "1234"); err != nil || !r.OK {
		t.Fatalf("right password: got (%+v, %v)", r, err)
	}
	books, err := ListBooks("", s.ID)
	if err != nil {
		t.Fatalf("ListBooks: %v", err)
	}
	if len(books) != 1 {
		t.Fatalf("unlocked shelf should list its book, got %d", len(books))
	}
	if _, err := GetBook("b1"); err != nil {
		t.Fatalf("unlocked shelf should open its book: %v", err)
	}

	// Clearing needs the current password, and then nothing is locked.
	if _, err := SetShelfLock(s.ID, "1234", ""); err != nil {
		t.Fatalf("clear password: %v", err)
	}
	if s := mustShelf(t, "日记"); s.HasLock || s.Locked {
		t.Fatalf("the shelf should be open again: %+v", s)
	}
}

func TestRepeatedWrongPasswordsBackOff(t *testing.T) {
	resetShelfState(t)
	s, err := CreateShelf("日记")
	if err != nil {
		t.Fatalf("CreateShelf: %v", err)
	}
	if _, err := SetShelfLock(s.ID, "", "1234"); err != nil {
		t.Fatalf("SetShelfLock: %v", err)
	}
	if err := LockShelf(s.ID); err != nil {
		t.Fatalf("LockShelf: %v", err)
	}
	// Four typos are free; the fifth starts a ten second wait.
	for i := 0; i < 4; i++ {
		r, _ := UnlockShelf(s.ID, "0000")
		if r.RetryAfterMS != 0 {
			t.Fatalf("miss %d should not back off yet, got %d ms", i+1, r.RetryAfterMS)
		}
	}
	r, _ := UnlockShelf(s.ID, "0000")
	if r.RetryAfterMS < 9000 {
		t.Fatalf("the fifth miss should back off ~10s, got %d ms", r.RetryAfterMS)
	}
	// During the wait even the right password is refused without being checked:
	// otherwise the backoff would only slow down the wrong guesses.
	if r, _ := UnlockShelf(s.ID, "1234"); r.OK {
		t.Fatal("the correct password must also wait out the backoff")
	}
	// Forgetting the failures restores the immediate path (what a successful
	// unlock does internally).
	resetUnlockFailures(s.ID)
	if r, _ := UnlockShelf(s.ID, "1234"); !r.OK {
		t.Fatal("after the backoff is cleared the right password must work")
	}
}

func TestLockedShelfIsHiddenFromCrossBookLists(t *testing.T) {
	resetShelfState(t)
	s, err := CreateShelf("日记")
	if err != nil {
		t.Fatalf("CreateShelf: %v", err)
	}
	insertBookOnShelf(t, "b1", "私事", s.ID)
	insertBookOnShelf(t, "b2", "公事", DefaultShelfID)
	insertChapterRow(t, "b1", "c1", 0)
	insertChapterRow(t, "b2", "c2", 0)

	d, err := db.Open()
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	ts := time.Now().UTC().Format(time.RFC3339)
	for _, q := range []string{
		`INSERT INTO bookmarks (id, book_id, chapter_id, anchor, label, created_at) VALUES ('m1','b1','c1',10,'私','` + ts + `')`,
		`INSERT INTO bookmarks (id, book_id, chapter_id, anchor, label, created_at) VALUES ('m2','b2','c2',10,'公','` + ts + `')`,
		`INSERT INTO annotations (id, book_id, chapter_id, start_offset, end_offset, text, created_at, updated_at)
		 VALUES ('a1','b1','c1',0,2,'私事','` + ts + `','` + ts + `')`,
		`INSERT INTO annotations (id, book_id, chapter_id, start_offset, end_offset, text, created_at, updated_at)
		 VALUES ('a2','b2','c2',0,2,'公事','` + ts + `','` + ts + `')`,
	} {
		if _, err := d.Exec(q); err != nil {
			t.Fatalf("seed %q: %v", q, err)
		}
	}

	if _, err := SetShelfLock(s.ID, "", "1234"); err != nil {
		t.Fatalf("SetShelfLock: %v", err)
	}
	if err := LockShelf(s.ID); err != nil {
		t.Fatalf("LockShelf: %v", err)
	}

	bm, err := ListAllBookmarks()
	if err != nil {
		t.Fatalf("ListAllBookmarks: %v", err)
	}
	if len(bm) != 1 || bm[0].BookID != "b2" {
		t.Fatalf("bookmarks of a locked shelf must not be listed: %+v", bm)
	}
	an, err := ListAllAnnotations()
	if err != nil {
		t.Fatalf("ListAllAnnotations: %v", err)
	}
	if len(an) != 1 || an[0].BookID != "b2" {
		t.Fatalf("annotations of a locked shelf must not be listed: %+v", an)
	}

	// Unlock: both lists come back.
	if r, _ := UnlockShelf(s.ID, "1234"); !r.OK {
		t.Fatal("unlock should succeed")
	}
	if bm, _ := ListAllBookmarks(); len(bm) != 2 {
		t.Fatalf("after unlocking both bookmarks should be listed, got %d", len(bm))
	}
	if an, _ := ListAllAnnotations(); len(an) != 2 {
		t.Fatalf("after unlocking both annotations should be listed, got %d", len(an))
	}

	// The trash list reads the disk, so the row has to exist there for the test
	// to mean anything. Trash a book on the locked shelf and it must vanish
	// from the list — "deleted" must not be the way to read the titles the
	// shelf is hiding.
	if err := LockShelf(s.ID); err != nil {
		t.Fatalf("LockShelf: %v", err)
	}
	trashDir := filepath.Join(storage.TrashRoot(), "b1")
	if err := os.MkdirAll(trashDir, 0o755); err != nil {
		t.Fatalf("mkdir trash: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(trashDir) })
	if _, err := d.Exec(`UPDATE books SET deleted_at = ? WHERE id = 'b1'`, ts); err != nil {
		t.Fatalf("soft delete: %v", err)
	}
	trash, err := ListTrash()
	if err != nil {
		t.Fatalf("ListTrash: %v", err)
	}
	for _, it := range trash {
		if it.ID == "b1" {
			t.Fatalf("a locked shelf's book must not appear in the trash list: %+v", it)
		}
	}
	if r, _ := UnlockShelf(s.ID, "1234"); !r.OK {
		t.Fatal("unlock should succeed")
	}
	trash, err = ListTrash()
	if err != nil {
		t.Fatalf("ListTrash: %v", err)
	}
	found := false
	for _, it := range trash {
		if it.ID == "b1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("after unlocking the trashed book should be listed again: %+v", trash)
	}
}

// A background import has nobody to ask for a password, and a stale shelf id
// must not make a book invisible: both land on the default shelf.
func TestImportShelfFallsBackToDefault(t *testing.T) {
	resetShelfState(t)
	s, err := CreateShelf("日记")
	if err != nil {
		t.Fatalf("CreateShelf: %v", err)
	}
	if got := resolveImportShelf(""); got != DefaultShelfID {
		t.Fatalf(`empty shelf id should fall back to default, got %q`, got)
	}
	if got := resolveImportShelf("gone"); got != DefaultShelfID {
		t.Fatalf(`unknown shelf id should fall back to default, got %q`, got)
	}
	if got := resolveImportShelf(s.ID); got != s.ID {
		t.Fatalf("an open shelf should be honoured, got %q", got)
	}
	if _, err := SetShelfLock(s.ID, "", "1234"); err != nil {
		t.Fatalf("SetShelfLock: %v", err)
	}
	if err := LockShelf(s.ID); err != nil {
		t.Fatalf("LockShelf: %v", err)
	}
	if got := resolveImportShelf(s.ID); got != DefaultShelfID {
		t.Fatalf("a locked shelf must not receive an import, got %q", got)
	}
}

// password hashing has to survive its own storage format: a corrupted or
// truncated hash must read as "wrong password", never as "no password".
func TestPasswordHashFormat(t *testing.T) {
	hash, err := hashPassword("1234")
	if err != nil {
		t.Fatalf("hashPassword: %v", err)
	}
	if !strings.HasPrefix(hash, "pbkdf2-sha256$") {
		t.Fatalf("unexpected format: %s", hash)
	}
	if strings.Contains(hash, "1234") {
		t.Fatal("the password must not appear in its own hash")
	}
	if !verifyPassword(hash, "1234") {
		t.Fatal("the hash must verify its own password")
	}
	if verifyPassword(hash, "12345") {
		t.Fatal("a different password must not verify")
	}
	for _, bad := range []string{"", "1234", "pbkdf2-sha256$x$y$z", "pbkdf2-sha256$1000$!!$!!"} {
		if verifyPassword(bad, "1234") {
			t.Fatalf("corrupt hash %q must not verify", bad)
		}
	}
	// Two shelves with the same password must not share a hash: the salt is
	// per shelf, so a leaked table does not become a lookup table.
	other, err := hashPassword("1234")
	if err != nil {
		t.Fatalf("hashPassword: %v", err)
	}
	if other == hash {
		t.Fatal("the same password must hash differently for each shelf")
	}
}
