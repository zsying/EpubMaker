package db

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// openForTest makes sure the shared handle is open on a throwaway database and
// closes it afterwards. Tx always goes through Open(), so these cases cannot use
// the detached openTemp() helper that the schema tests use — see isolateHome for
// why a plain t.Setenv would not be enough.
func openForTest(t *testing.T) {
	t.Helper()
	isolateHome(t)
	if _, err := Open(); err != nil {
		t.Fatalf("open: %v", err)
	}
}

func insertShelf(t *testing.T, id string) error {
	t.Helper()
	return Tx(func() error {
		d, err := Open()
		if err != nil {
			return err
		}
		_, err = d.Exec(`INSERT INTO shelves (id, name) VALUES (?, ?)`, id, id)
		return err
	})
}

// A panic inside the callback used to leave the connection sitting inside an
// open transaction. The pool has exactly one connection, so every later BEGIN
// failed with "cannot start a transaction within a transaction" — the app kept
// running and silently refused to write anything until it was restarted.
func TestPanicInsideTxDoesNotPoisonTheConnection(t *testing.T) {
	openForTest(t)

	func() {
		defer func() {
			if r := recover(); r == nil {
				t.Fatal("the panic should have propagated; swallowing it hides real bugs")
			}
		}()
		_ = Tx(func() error {
			d, _ := Open()
			_, _ = d.Exec(`INSERT INTO shelves (id, name) VALUES ('ghost', 'ghost')`)
			panic("boom")
		})
	}()

	if err := insertShelf(t, "after-panic"); err != nil {
		t.Fatalf("a later transaction must still work: %v", err)
	}

	// The half-written row must be gone too, otherwise the rollback did not run.
	d, _ := Open()
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM shelves WHERE id = 'ghost'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("the panicking transaction was not rolled back: %d ghost row(s) left", n)
	}
}

// Two transactions running at once used to share the single connection, so the
// second BEGIN landed inside the first transaction and failed. That is not a
// hypothetical: importing a book runs a transaction while an AI reply, an OPDS
// download or a shelf edit can start another.
func TestSecondTxWaitsForTheFirst(t *testing.T) {
	openForTest(t)

	firstStarted := make(chan struct{})
	release := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- Tx(func() error {
			d, _ := Open()
			if _, err := d.Exec(`INSERT INTO shelves (id, name) VALUES ('a', 'a')`); err != nil {
				return err
			}
			close(firstStarted)
			<-release
			return nil
		})
	}()
	<-firstStarted

	secondDone := make(chan error, 1)
	go func() { secondDone <- insertShelf(t, "b") }()

	// While the first transaction is open the second must block, not fail and
	// certainly not join it.
	select {
	case err := <-secondDone:
		t.Fatalf("the second transaction finished while the first was still open: %v", err)
	case <-time.After(150 * time.Millisecond):
	}

	close(release)
	if err := <-firstDone; err != nil {
		t.Fatalf("first transaction: %v", err)
	}
	if err := <-secondDone; err != nil {
		t.Fatalf("second transaction: %v", err)
	}
}

// A failing callback must roll back, and the error must be the caller's own —
// not a "cannot start a transaction" from the next attempt.
func TestFailedTxRollsBackAndReleasesTheConnection(t *testing.T) {
	openForTest(t)

	want := errors.New("nope")
	err := Tx(func() error {
		d, _ := Open()
		if _, e := d.Exec(`INSERT INTO shelves (id, name) VALUES ('half', 'half')`); e != nil {
			return e
		}
		return want
	})
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want the callback's own", err)
	}

	d, _ := Open()
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM shelves WHERE id = 'half'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("rollback left %d row(s) behind", n)
	}

	// The connection must be clean enough for the next transaction.
	if err := insertShelf(t, "next"); err != nil {
		t.Fatalf("next transaction: %v", err)
	}
}

// If the transaction is somehow still open (a rollback that itself failed, a
// handle reused after a panic), the next call must recover instead of failing
// forever. Self-healing beats a stuck app.
func TestTxRecoversFromAStaleOpenTransaction(t *testing.T) {
	openForTest(t)

	d, _ := Open()
	if _, err := d.Exec("BEGIN"); err != nil {
		t.Fatal(err)
	}

	if err := insertShelf(t, "after-stale"); err != nil {
		if strings.Contains(err.Error(), "within a transaction") {
			t.Fatalf("Tx did not clear the stale transaction: %v", err)
		}
		t.Fatalf("tx: %v", err)
	}
}
