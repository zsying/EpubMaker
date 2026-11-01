package library

// Shelves: the containers books live in.
//
// A shelf is not a tag. A tag is many-to-many, string-only and additive; a
// shelf is one book, one container — and the password has to hang on the
// container, not on a string. So this is a table of its own plus one column on
// books, and the two features stay orthogonal.
//
// Two invariants worth stating before the code:
//
//  1. Moving a book between shelves only rewrites books.shelf_id. The epub
//     lives at <books>/<bookID>/content, which has nothing to do with shelves,
//     so a move never touches the disk, the reading position, the bookmarks or
//     the annotations. That is what makes a hundred-book move safe.
//
//  2. The lock is a curtain, not a vault. The database is a plain SQLite file;
//     anyone holding it can read every book. What the password buys is that a
//     phone handed around does not open this shelf. The consequence is that the
//     lock state is deliberately NOT persisted: it is a map in this process,
//     and quitting the app puts every shelf back behind its password.

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"epubmaker-desktop/internal/db"
)

// DefaultShelfID is the shelf every book lands on until someone makes another
// one. It is an ordinary shelf that cannot be deleted — not an "all books"
// view, because a locked shelf could never be part of such a view.
const DefaultShelfID = "default"

// Constraints on what a shelf can be called and what a password can be. The
// name limit is about the header pill on a 360px phone: anything longer is
// truncated there anyway, and a silently truncated name in the one place that
// says which shelf you are on is worse than refusing it.
const (
	shelfNameMax = 24
	shelfNameMin = 1
	passwordMin  = 4
	passwordMax  = 32
	pwIterations = 120000
)

var (
	// ErrShelfNotFound is returned for an id that no shelf carries.
	ErrShelfNotFound = errors.New("书架不存在")
	// ErrShelfLocked is returned when a write targets a shelf whose password
	// has not been given in this session.
	ErrShelfLocked = errors.New("书架已锁定，请先解锁")
	// ErrWrongPassword means the password did not match; the caller may retry
	// once the backoff has elapsed.
	ErrWrongPassword = errors.New("密码不正确")
)

// ShelfDTO is what the shelf page draws: the name, the size, and whether the
// row currently needs a password.
type ShelfDTO struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Position  int    `json:"position"`
	BookCount int    `json:"bookCount"`
	// HasLock is whether a password is set at all; Locked is whether it is
	// still owed in this session. A shelf with no password is never locked.
	HasLock bool `json:"hasLock"`
	Locked  bool `json:"locked"`
}

// UnlockResult answers an unlock attempt. Wrong passwords are a normal answer,
// not an error, because the UI has to show how long the backoff runs — and the
// backoff is the only thing standing between a 4-digit password and an evening
// of guessing.
type UnlockResult struct {
	OK           bool  `json:"ok"`
	RetryAfterMS int64 `json:"retryAfterMs"`
}

/* ------------------------- lock state (in memory) ------------------------- */

var shelfLocks = struct {
	sync.Mutex
	// unlocked holds the shelves whose password has been given since launch.
	unlocked map[string]bool
	// fails is the per-shelf failure counter behind the backoff.
	fails map[string]*unlockFailure
}{
	unlocked: map[string]bool{},
	fails:    map[string]*unlockFailure{},
}

type unlockFailure struct {
	count int
	next  time.Time // attempts before this instant are refused without a check
}

// unlockBackoff maps a failure count onto the wait before the next attempt.
// Nothing happens for the first four misses (a typo is not an attack); from the
// fifth it is 10s, doubling per further miss, capped at a quarter of an hour.
// A four-digit password therefore costs roughly 10 hours of sitting there —
// which is the actual threat model: someone holding the phone, not a script
// with a copy of the file.
func unlockBackoff(count int) time.Duration {
	if count < 5 {
		return 0
	}
	d := 10 * time.Second
	for i := 5; i < count && d < 15*time.Minute; i++ {
		d *= 2
	}
	if d > 15*time.Minute {
		d = 15 * time.Minute
	}
	return d
}

// lockedShelfIDs lists the shelves that need a password right now. Query-based
// on purpose: the answer has to be the same for every caller, and the callers
// are SQL statements that must do the filtering in the database — a front-end
// filter would leave /books/:id/read one typed URL away from the content.
func lockedShelfIDs() []string {
	d, err := db.Open()
	if err != nil {
		return nil
	}
	rows, err := d.Query(`SELECT id FROM shelves WHERE pw_hash != ''`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	shelfLocks.Lock()
	defer shelfLocks.Unlock()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil
		}
		if !shelfLocks.unlocked[id] {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// notLockedSQL builds `AND <col> NOT IN (?,?)` for the shelves that are locked
// right now, and nothing at all when there are none — an empty IN () is a
// syntax error, and most databases have no locked shelf at all.
func notLockedSQL(col string) (string, []any) {
	ids := lockedShelfIDs()
	if len(ids) == 0 {
		return "", nil
	}
	args := make([]any, len(ids))
	holes := make([]string, len(ids))
	for i, id := range ids {
		args[i] = id
		holes[i] = "?"
	}
	return " AND " + col + " NOT IN (" + strings.Join(holes, ",") + ")", args
}

// shelfLocked reports whether a single shelf currently needs its password.
func shelfLocked(shelfID string) bool {
	if shelfID == "" {
		return false
	}
	for _, id := range lockedShelfIDs() {
		if id == shelfID {
			return true
		}
	}
	return false
}

// bookShelfLocked answers the same question for a book. Books on a shelf that
// no longer exists (only possible mid-migration) count as unlocked: refusing to
// open them would be a bug, not a protection.
func bookShelfLocked(bookID string) bool {
	d, err := db.Open()
	if err != nil {
		return false
	}
	var shelfID string
	if err := d.QueryRow(`SELECT COALESCE(shelf_id, '') FROM books WHERE id = ?`, bookID).Scan(&shelfID); err != nil {
		return false
	}
	return shelfLocked(shelfID)
}

/* ------------------------------- passwords ------------------------------- */

// hashPassword returns pbkdf2-sha256$<iterations>$<salt>$<hash>. PBKDF2 with a
// per-shelf salt is in the standard library as of Go 1.24, so a plain SHA-256 —
// or worse, the password itself — has no excuse here.
func hashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, pw, salt, pwIterations, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s",
		pwIterations,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

func verifyPassword(encoded, pw string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter <= 0 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil || len(want) == 0 {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, pw, salt, iter, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

/* -------------------------------- queries -------------------------------- */

// shelfNameProblem validates a shelf name: 1–24 characters, after the caller
// has trimmed it.
func shelfNameProblem(name string) error {
	n := utf8.RuneCountInString(name)
	if n < shelfNameMin {
		return fmt.Errorf("书架名不能为空")
	}
	if n > shelfNameMax {
		return fmt.Errorf("书架名最多 %d 个字", shelfNameMax)
	}
	return nil
}

func shelfExists(d *sql.DB, id string) (bool, error) {
	var one int
	err := d.QueryRow(`SELECT 1 FROM shelves WHERE id = ?`, id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// ListShelves returns every shelf in display order, with its live book count.
// Counts of a locked shelf are shown on purpose: its name is visible anyway, so
// hiding the number buys no privacy and reads as a broken list.
func ListShelves() ([]ShelfDTO, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	rows, err := d.Query(
		`SELECT id, name, position, pw_hash != '' FROM shelves
		 ORDER BY position, created_at, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ShelfDTO{}
	for rows.Next() {
		var s ShelfDTO
		if err := rows.Scan(&s.ID, &s.Name, &s.Position, &s.HasLock); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	counts := map[string]int{}
	crows, err := d.Query(
		`SELECT COALESCE(shelf_id, ''), COUNT(*) FROM books
		 WHERE deleted_at IS NULL GROUP BY shelf_id`)
	if err != nil {
		return nil, err
	}
	defer crows.Close()
	for crows.Next() {
		var id string
		var n int
		if err := crows.Scan(&id, &n); err != nil {
			return nil, err
		}
		counts[id] = n
	}

	shelfLocks.Lock()
	defer shelfLocks.Unlock()
	for i := range out {
		out[i].BookCount = counts[out[i].ID]
		out[i].Locked = out[i].HasLock && !shelfLocks.unlocked[out[i].ID]
	}
	return out, nil
}

// GetShelf reads one shelf, or ErrShelfNotFound.
func GetShelf(id string) (*ShelfDTO, error) {
	list, err := ListShelves()
	if err != nil {
		return nil, err
	}
	for i := range list {
		if list[i].ID == id {
			return &list[i], nil
		}
	}
	return nil, ErrShelfNotFound
}

// CreateShelf adds a shelf at the end of the row. Duplicate names are refused:
// two shelves called 小说 cannot be told apart in the very list that is supposed
// to switch between them.
func CreateShelf(name string) (*ShelfDTO, error) {
	name = strings.TrimSpace(name)
	if err := shelfNameProblem(name); err != nil {
		return nil, err
	}
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	var clash int
	if err := d.QueryRow(`SELECT COUNT(*) FROM shelves WHERE name = ?`, name).Scan(&clash); err != nil {
		return nil, err
	}
	if clash > 0 {
		return nil, fmt.Errorf("已经有叫「%s」的书架了", name)
	}
	var pos int
	if err := d.QueryRow(`SELECT COALESCE(MAX(position), 0) + 1 FROM shelves`).Scan(&pos); err != nil {
		return nil, err
	}
	id := uid()
	ts := nowIso()
	if _, err := d.Exec(
		`INSERT INTO shelves (id, name, position, pw_hash, created_at, updated_at)
		 VALUES (?, ?, ?, '', ?, ?)`, id, name, pos, ts, ts); err != nil {
		return nil, err
	}
	return GetShelf(id)
}

// RenameShelf renames any shelf, including a locked one — but only once it has
// been unlocked: a lock forbids writing to the shelf, and a name is a write.
func RenameShelf(id, name string) (*ShelfDTO, error) {
	name = strings.TrimSpace(name)
	if err := shelfNameProblem(name); err != nil {
		return nil, err
	}
	if shelfLocked(id) {
		return nil, ErrShelfLocked
	}
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	ok, err := shelfExists(d, id)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrShelfNotFound
	}
	var clash int
	if err := d.QueryRow(`SELECT COUNT(*) FROM shelves WHERE name = ? AND id != ?`, name, id).Scan(&clash); err != nil {
		return nil, err
	}
	if clash > 0 {
		return nil, fmt.Errorf("已经有叫「%s」的书架了", name)
	}
	if _, err := d.Exec(`UPDATE shelves SET name = ?, updated_at = ? WHERE id = ?`, name, nowIso(), id); err != nil {
		return nil, err
	}
	return GetShelf(id)
}

// DeleteShelf removes the shelf and puts its books back on the default one. It
// never deletes a book: the shelf is a label on the container, and destroying
// what is inside because the label was removed would be the worst possible
// surprise. Returns how many books were moved back.
func DeleteShelf(id string) (int, error) {
	if id == DefaultShelfID {
		return 0, errors.New("默认书架不能删除")
	}
	if shelfLocked(id) {
		return 0, ErrShelfLocked
	}
	d, err := db.Open()
	if err != nil {
		return 0, err
	}
	ok, err := shelfExists(d, id)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, ErrShelfNotFound
	}
	moved := 0
	err = db.Tx(func() error {
		res, err := d.Exec(`UPDATE books SET shelf_id = ? WHERE shelf_id = ?`, DefaultShelfID, id)
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err == nil {
			moved = int(n)
		}
		_, err = d.Exec(`DELETE FROM shelves WHERE id = ?`, id)
		return err
	})
	if err != nil {
		return 0, err
	}
	shelfLocks.Lock()
	delete(shelfLocks.unlocked, id)
	delete(shelfLocks.fails, id)
	shelfLocks.Unlock()
	return moved, nil
}

// MoveBooks puts a batch of books on one shelf. It is the whole "migrate a
// book / migrate thirty books" feature: one statement, no disk work.
//
// Only the destination is checked for a lock. Moving a book OFF a locked shelf
// is not something the UI can reach (the books are not listed), and if it were,
// it would be removing content rather than revealing it.
func MoveBooks(bookIDs []string, shelfID string) (int, error) {
	if len(bookIDs) == 0 {
		return 0, nil
	}
	d, err := db.Open()
	if err != nil {
		return 0, err
	}
	ok, err := shelfExists(d, shelfID)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, ErrShelfNotFound
	}
	if shelfLocked(shelfID) {
		return 0, ErrShelfLocked
	}
	holes := make([]string, len(bookIDs))
	args := make([]any, 0, len(bookIDs)+1)
	args = append(args, shelfID)
	for i, id := range bookIDs {
		holes[i] = "?"
		args = append(args, id)
	}
	res, err := d.Exec(
		`UPDATE books SET shelf_id = ? WHERE id IN (`+strings.Join(holes, ",")+`)`, args...)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

// SetShelfLock sets, changes or clears (newPassword == "") a shelf's password.
// Changing or clearing one requires the current password — and goes through the
// same backoff as UnlockShelf, otherwise this method would be a free oracle for
// guessing it.
func SetShelfLock(id, oldPassword, newPassword string) (*ShelfDTO, error) {
	d, err := db.Open()
	if err != nil {
		return nil, err
	}
	var stored string
	err = d.QueryRow(`SELECT COALESCE(pw_hash, '') FROM shelves WHERE id = ?`, id).Scan(&stored)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrShelfNotFound
	}
	if err != nil {
		return nil, err
	}
	if stored != "" {
		if wait, blocked := unlockWait(id); blocked {
			return nil, fmt.Errorf("请等 %d 秒后再试", int(wait.Seconds()+0.5))
		}
		if !verifyPassword(stored, oldPassword) {
			noteUnlockFailure(id)
			return nil, ErrWrongPassword
		}
		resetUnlockFailures(id)
	}
	if newPassword == "" {
		if _, err := d.Exec(`UPDATE shelves SET pw_hash = '', updated_at = ? WHERE id = ?`, nowIso(), id); err != nil {
			return nil, err
		}
		shelfLocks.Lock()
		delete(shelfLocks.unlocked, id)
		shelfLocks.Unlock()
		return GetShelf(id)
	}
	if n := utf8.RuneCountInString(newPassword); n < passwordMin || n > passwordMax {
		return nil, fmt.Errorf("密码需要 %d–%d 位", passwordMin, passwordMax)
	}
	hash, err := hashPassword(newPassword)
	if err != nil {
		return nil, err
	}
	if _, err := d.Exec(`UPDATE shelves SET pw_hash = ?, updated_at = ? WHERE id = ?`, hash, nowIso(), id); err != nil {
		return nil, err
	}
	// Setting the password is proof of knowing it: the shelf stays open for the
	// rest of the session instead of immediately asking for what was just typed.
	shelfLocks.Lock()
	shelfLocks.unlocked[id] = true
	delete(shelfLocks.fails, id)
	shelfLocks.Unlock()
	return GetShelf(id)
}

// unlockWait reports how long the caller must still wait, if at all.
func unlockWait(id string) (time.Duration, bool) {
	shelfLocks.Lock()
	defer shelfLocks.Unlock()
	f := shelfLocks.fails[id]
	if f == nil || f.next.IsZero() {
		return 0, false
	}
	if d := time.Until(f.next); d > 0 {
		return d, true
	}
	return 0, false
}

func noteUnlockFailure(id string) time.Duration {
	shelfLocks.Lock()
	defer shelfLocks.Unlock()
	f := shelfLocks.fails[id]
	if f == nil {
		f = &unlockFailure{}
		shelfLocks.fails[id] = f
	}
	f.count++
	wait := unlockBackoff(f.count)
	if wait > 0 {
		f.next = time.Now().Add(wait)
	}
	return wait
}

func resetUnlockFailures(id string) {
	shelfLocks.Lock()
	defer shelfLocks.Unlock()
	delete(shelfLocks.fails, id)
}

// UnlockShelf checks a password and, on success, opens the shelf for the rest
// of the session. A shelf with no password is always open.
func UnlockShelf(id, password string) (UnlockResult, error) {
	d, err := db.Open()
	if err != nil {
		return UnlockResult{}, err
	}
	var stored string
	err = d.QueryRow(`SELECT COALESCE(pw_hash, '') FROM shelves WHERE id = ?`, id).Scan(&stored)
	if errors.Is(err, sql.ErrNoRows) {
		return UnlockResult{}, ErrShelfNotFound
	}
	if err != nil {
		return UnlockResult{}, err
	}
	if stored == "" {
		return UnlockResult{OK: true}, nil
	}
	if wait, blocked := unlockWait(id); blocked {
		return UnlockResult{OK: false, RetryAfterMS: wait.Milliseconds()}, nil
	}
	if !verifyPassword(stored, password) {
		wait := noteUnlockFailure(id)
		return UnlockResult{OK: false, RetryAfterMS: wait.Milliseconds()}, nil
	}
	resetUnlockFailures(id)
	shelfLocks.Lock()
	shelfLocks.unlocked[id] = true
	shelfLocks.Unlock()
	return UnlockResult{OK: true}, nil
}

// LockShelf puts the shelf back behind its password. The app calls this when it
// goes to the background for long enough, and when the reader says 锁定.
func LockShelf(id string) error {
	shelfLocks.Lock()
	delete(shelfLocks.unlocked, id)
	shelfLocks.Unlock()
	return nil
}

// LockAllShelves closes every shelf that was opened in this session.
func LockAllShelves() error {
	shelfLocks.Lock()
	shelfLocks.unlocked = map[string]bool{}
	shelfLocks.Unlock()
	return nil
}

// resolvedShelfID turns an optional shelf filter into the id to query. An empty
// shelf means "every shelf that is not locked", which is only used by the
// "search the other shelves too" escape hatch — and that list itself returns ""
// so the caller can skip the filter.
func shelfFilterSQL(shelfID string, col string) (string, []any) {
	if shelfID == "" {
		return notLockedSQL(col)
	}
	// Asking for a specific locked shelf returns nothing rather than an error:
	// the caller sees an empty shelf and the unlock screen, not a crash.
	if shelfLocked(shelfID) {
		return " AND 1 = 0", nil
	}
	return " AND " + col + " = ?", []any{shelfID}
}
