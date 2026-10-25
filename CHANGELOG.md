# Changelog

All notable changes to EpubMaker are recorded here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] — 2026-10-25

EpubMaker runs on a phone. A second entry point (Wails v3) binds the same
`internal/app.Backend` and serves the same `web/dist`, so the shelf, the reader
and the notebook open on Android — and the reading itself was rebuilt for a
thumb: paged by default, chrome that slides over the page instead of sitting
around it, a selection with handles you can reshape, a word looked up by
holding it. Around that, the import routes a phone actually has (Wi-Fi, system
share, a local picker), five themes, a font catalogue, and a dictionary that
downloads itself.

### Added

- **Android app** — the library, the reader and the dictionary now run on a
  phone. A second entry point (`app/cmd/mobile`, Wails v3) binds the *same*
  `internal/app.Backend` the desktop binds with Wails v2, and the same
  `web/dist` bundle detects its host at runtime, so one frontend serves both.
  No port is opened on the phone either: assets travel through
  `WebViewAssetLoader` and calls through the in-process bridge.
- **Touch-first reading** — on a phone the page fills the screen instead of
  lying on a desk: no rounded corners, no drop shadow, no spine shading. Tap the
  top/bottom margin to toggle the chrome, the edges to turn, a word to look it
  up. Long-press selection drives the lookup toolbar (a touch screen never fires
  `mouseup`), and a swipe still turns the page while a word card is open.
- **A phone reading chrome** — the phone's bars are the ones a reader expects:
  back + chapter title + a bookmark star on top, and at the bottom a chapter
  slider between 上一章/下一章 with a percent caption over a five-slot action row
  (目录 · 书签 · 划线 · 整理 · 设置). Scroll mode gets the same bars and a toggle
  on blank space; the desktop toolbar is untouched.
- **Reachable selection** — long-press yields a word, and two teardrop handles
  hang under it to widen or trim the selection, so a phrase can be looked up
  without fighting the OS selection.
- **Five themes, app-wide** — light, sepia, green, dark and midnight are one
  attribute on `<html>` driving CSS variables, so the shelf, the settings page,
  the reader's paper *and* its chrome recolour together; the paper no longer
  sits under jet-black bars. The old reader-only background setting migrates.
- **A settings page and a font catalogue** —「我的 → 设置」shares the reader's
  keys: font size, paged/scroll, reading theme, a seven-face font catalogue
  (思源宋体/黑体 plus five OFL handwriting faces, downloaded on first use into
  `<dataDir>/fonts`) and 覆盖书籍字体, which defaults ON because an EPUB's own
  `font-family` otherwise wins the cascade and the setting looks broken.
- **A phone information architecture** — the desktop top bar's six links become
  a bottom tab bar (书架 · 生词本 · 我的) below 640px, with the low-frequency
  destinations (bookmarks, annotations, trash, WebDAV, dictionary status)
  collected on a new「我的」page. The reader route stays fullscreen and tab-free.
  Second-level pages get a sub-header with the back chevron merged into it —
  without it a phone had no way back at all. The desktop layout is untouched.
- **A phone-shaped shelf** — a two-cover grid, a collapsible search field,
  finger-sized 排序 and ＋ icons, a sort sheet (default / title / author /
  created, persisted), a reading-progress badge at the end of the author line
  that a long author name can never cover, and a per-book ⋯ sheet — edit
  (title / author / tags / cover) and delete — opened by holding anywhere on a
  card's face, not just its cover. Touch devices render 12 cards first and pull
  the rest as the grid scrolls.
- **Wi-Fi 传书** — a new「我的」entry starts a tiny LAN upload server on the
  phone; a computer on the same Wi-Fi opens the shown URL (or scans the QR
  code) and drops EPUB files straight into the shelf, with per-file progress
  and duplicate/failure reporting. Requires no account and no cloud; the
  router must allow device-to-device traffic (AP isolation off).
- **System-share import (Android)** — sharing an EPUB from WeChat, a browser
  or a file manager ("分享到 EpubMaker") or opening one with the app now
  imports it directly: the host copies the content URI into the cache and
  hands it to the frontend, which imports it wherever the user happens to be.
  The local file picker works on the phone too, through the v3 runtime's
  `Dialogs.OpenFile` → the Android SAF picker.
- **Duplicate imports are skipped** — `books.file_hash` (sha256 of the epub) is
  stored on import and backfilled for existing books, so importing the same
  file twice reports it instead of shelving it twice.
- **Lookup history** — a new「查词历史」second-level page under 生词本 lists every
  word ever looked up — including the ones the notebook's automatic rule
  declined (basic vocabulary, one-off curiosities) — with its gloss, how many
  times it was looked up and when it was last seen. Words outside the notebook
  carry a「加入生词本」button; the ones already in it show their state instead.
  Backed by a new `lookup_history` table (written on every successful lookup and
  seeded from `vocab_seen`/`vocab` on first run) and a
  `Backend.ListLookupHistory` binding.
- **The review pass is a page of its own** — `/vocab/review` replaces the
  in-place mode switch. It is a second-level page, so it now behaves like one:
  a back chevron in a sticky header, no bottom tab bar, and every action in a
  dock pinned to the bottom edge — the only place a thumb reaches without
  regripping the phone. The primary button is 48–50px (显示释义 → 不记得 /
  认识), with 跳过 and 结束本轮 as quiet links under it; the card above stays a
  reading surface. The queue is fetched by the page itself, so a fresh start
  gets a fresh queue, and the summary is a page rather than a dialog.
- **Words the dictionary cannot explain can be fetched online** — the notebook
  shows「N 个词还没有释义 · 联网补全」for the rest (proper nouns, coinages, and
  whatever the trimmed Android dictionary leaves out), and one click asks a
  public dictionary. 有道 supplies a Chinese gloss and phonetic; when it has
  nothing, dictionaryapi.dev supplies an English definition. Answers are stored
  in the library database (`dict_online`), not in `dict.db`, so they survive a
  dictionary re-import and work on the phone, which ships with a 150k-entry
  dictionary instead of the 770k one. Once fetched, the word answers like any
  other entry — notebook, review card, and the reader's popover — and is never
  requested again. Nothing is sent anywhere until the reader presses the button.
- **The word lists load a screenful at a time** — 生词本 and 查词历史 both fetched
  every row at once, and each row costs a dictionary lookup on the Go side, so
  opening either page got slower the longer the reader used the app. Both now
  read 40 rows per request and pull the next page as the end of the list comes
  into view, with a「加载更多 · 已显示 40/312」button as the fallback and as the
  progress read-out. A failed page stops the automatic loading (otherwise a
  failing request would retry on every scroll frame) and turns the button into
  「重试」. `ListVocab`/`ListLookupHistory` now return `{items, total, hasMore}`;
  `total` is counted under the same filter, so the history header says「共 N 词」
  about the whole list rather than about the downloaded part. The ordering gained
  a unique tie-breaker (`id` / `term`): pages are read one screen at a time, and
  a batch import stamps hundreds of rows with the same timestamp, so without it
  the second page repeated and skipped rows at random.
- **The dictionary can be installed from the app** — the「我的」dictionary row
  opens a sheet with an online download and a local CSV import. The default
  source is a curated ECDICT subset built for this purpose (101k frequent
  headwords + 52k inflection rows, 11.6 MB, served from
  `zsying/epubmaker-dict` via jsDelivr — the only CDN a phone here reaches
  without a proxy). `DownloadDict` fetches, caches under `<dataDir>/dict` and
  imports in one blocking call. Tap-to-lookup with no dictionary used to be
  dead twice over (the frontend gated it on `dictReady`, the backend returned
  `ErrNotInstalled`); both are fixed and the card now points at the download.
- **A jump is a visit, not a detour** — entries opened from 生词本/划线/书签
  share one preview mode: the visit opens on the entry (word selected, toolbar
  up), never writes progress, and refuses to browse — page turns, the slider
  and the chapter buttons are dead while it is active. One toolbar carries
  out of it: 返回 (to the list), 跳到最后阅读 (to the saved position),
  从当前开始阅读 (adopt the spot and read on).
- **Book tags and a shelf-level progress figure** — `books.tags` (a JSON array,
  with an idempotent migration) is editable on both platforms, and
  `ListProgress` folds each book's saved position into a 0..1 fraction so the
  shelf can show a badge without one round trip per book.
- **About page** — a new「关于」entry on the「我的」tab shows the app version
  (new `Backend.AppVersion` binding) and the system paths block that used to
  trail the shelf (config file, data/export/log dirs). The shelf footer is gone.

### Changed

- **The notebook is read-only** — the per-row「已掌握」button and the batch
  delete are gone. The button was the real bug behind "words I just added are
  marked mastered": it was an action, but it read as a state and sat in a column
  of its own, squeezing every row. Status is now a small label on the metadata
  line, and only appears once a word has moved on (`待学` is the default and
  says nothing). Deleting is gone too — from the UI, the `DeleteVocab` binding
  and `vocab.Delete`: a word retires through the review schedule, not by
  hand. `STATUS_LABEL`/`STATUS_HINT` moved to `web/src/vocabLabels.ts` so the
  notebook and the history cannot name a state differently.
- **Paged by default, and the tap zones follow the thumb** — reading opens in
  paged mode under a v2 storage key (the old key was written on every mount, so
  a new default could never reach anyone who had opened the reader once).
  Lookup wins wherever a word actually is; the edge strips only turn the page
  where there is no text under the finger.
- **Hardware back peels one layer at a time** — every overlay (reader drawers,
  sheets, word card, selection, the shelf's import/sort/book menus) pushes a
  sentinel history entry while open, and a capture-phase guard consumes one
  back press per overlay, so back closes the menu instead of leaving the page.
  At the root, a first press shows 再按一次退出 and a second within 2s leaves.
- **The headword is underlined, not highlighted** — inside an example sentence
  the word was marked with a yellow block, which turned every card into stripes
  and pulled the eye to the colour instead of the word. It is a dotted rule
  under the word now (2px, the theme's warm mark colour), so the sentence still
  reads as a sentence. Marking also works on text extracted with soft hyphens:
  「in­tim­acy」 never matched「intimacy」with a plain `indexOf`, so the word went
  unmarked on every card from a book that hyphenates.
- **Example sentences are cut at paragraphs, not line breaks** — a word that
  happened to begin a line in the source file was saved with nothing but itself
  as its example: EPUB text is hard-wrapped, and the extraction counted that
  wrap as the end of a sentence, so a card read `compensation.` instead of the
  sentence it sits in. The sentence is now bounded by the paragraph the word is
  in, and the notebook re-cuts entries written before this — from the chapter
  itself, only the ones that need it, and only where the stored position still
  lands on the word.
- **The notebook's metadata line is one row** — a long book title used to fold
  the row in two and break「还没复习过」across lines mid-word. The provenance now
  truncates with an ellipsis and the study line (`下次 6 天后` / `还没复习过`)
  never shrinks, with the status label last. The lookup/review/lapse counters
  moved into the row's tooltip, and `.note-list` is `minmax(0, 1fr)` so no
  unbreakable line can widen a card past the page.
- **No more sideways scroll on the notebook** — a long headword plus its
  phonetic now wraps inside the card (`flex-wrap` + `overflow-wrap: anywhere`)
  instead of widening the page.
- **Secondary pages own the full screen** — a page-wide flash on every tap is
  gone, and pages other than the shelf and the reader no longer sit inside the
  desktop shell's padding.

### Fixed

- **A word never reaches into the block below it** — tapping the heading
  「Dedication」 looked up `dedicationthis`. Word expansion falls back to the
  chapter's flat text when a word touches the edge of its text node, and that
  stream has no block boundaries in it: the heading and the paragraph under it
  are adjacent characters, so a heading at the end of its own block swallowed
  the first word of the next one. The wider span is now only accepted when both
  of its ends sit in the same block, and a `<br/>` between them counts as a
  boundary too. Long-press selection had the same defect (it selected
  "Dedication…This") and is fixed with it.
- **The selection menu stays up while a drag handle is moved** — it used to be
  hidden for the whole gesture, which read as "the menu is gone"; it only came
  back after the finger was lifted. It now stays on screen and stops taking
  hits while dragging, so the caret under the thumb still resolves to the text
  instead of to the menu's own label.
- **No more bare strip above the tab bar on the shelf** — the bar was a fixed
  overlay reserving a hand-tuned 76px of padding, while the bar itself is 53px
  tall; the 23px in between showed the page background, which looked like a
  band laid over the last row of covers. The bar is now a row of the app's
  column, so the scroll pane always ends exactly where the bar begins.
- **A table of contents never promises more chapters than it lists** — the
  drawer's header counts the spine, so the list behind it has to reach every
  spine document. Converted EPUBs break that in two ways, and both used to slip
  through: a nav with a single「Start」entry (「目录 · 28 章」, one row), and a
  nav that names only some documents — calibre split one book into 28 files but
  wrote three labels, so the tree drew 3 rows under a「29 章」header and 26
  chapters had no way in. The outline is now drawn only when it is hierarchical
  *and* reaches every chapter; anything less falls back to the complete chapter
  list, which is complete by construction and keeps the chapter numbers.
- **A notebook word now shows its base form's meaning** — `disrupts`,
  `primitives`, `violates` used to sit in 生词本 as「（词库无释义）」while the
  whole answer was one row away: ECDICT ships inflected forms as their own
  entries, and those entries carry `exchange = 0:disrupt` with an empty
  translation. The lists now read the headword's meaning and, when it has none,
  the base form's — Chinese always before English. This alone explains most of
  the rows that looked broken, on both platforms.
- **Anywhere on a shelf card opens the book, and the card answers the press** —
  the cover was the only tap target: a thumb aimed at the title or the author
  line hit dead space and all it did was lift the card. Every point on the card
  face opens the book now, after a 130ms "button down" frame (scale .972,
  dimmed) — navigation tears the card down, so without it a tap has no visible
  answer at all. `prefers-reduced-motion` skips straight to the reader.
- **The long-press menu survives the release that opened it** — the sheet opens
  under the thumb that asked for it, so lifting the finger sent a click to the
  mask, which closed the menu the same gesture had just opened. Worse, the
  "just long-pressed" flag was sticky (that click never reached the card), which
  swallowed the *next* real tap. Both are timestamps now. The menu's text is
  also no longer selectable: the WebView's own selection timer fires at about
  the same 500ms, so a hold would sometimes select the book title printed at the
  top of the sheet.
- **Changing a cover changes the cover** — `UploadCover` only stored the image
  and inserted an asset row; it never pointed `books.cover_href` at it, so the
  shelf kept painting the old cover while the new file sat on disk unreachable.
  The phone's edit sheet now follows the upload with `UpdateBook({coverHref})`,
  carrying the rest of the form with it so a cover change cannot discard a title
  or tags typed in the same visit.
- **Android: the backend answers.** On a real device the shelf now loads
  through Wails v3's runtime. Two fixes were needed: the Java host no longer
  forces `application/json` onto `/wails/runtime.js` (the WebView refused to
  import it as a module, so the runtime never mounted), and the frontend calls
  bindings by their fully qualified name (`<module>.<pkg>.Backend.<Method>`).
  The runtime is imported from the host itself; the npm `@wailsio/runtime`
  dependency is gone.
- **About page fixes** — the build time now formats in the device's timezone
  (Go's `time.Local` is unusable inside the Android c-shared runtime, so the
  backend hands over raw unix seconds); the shelf's floating ＋ button is gone,
  the header ＋ is the one import entry.

### Tooling

- **Prettier has a config and a pinned version** — `.prettierrc.json` writes the
  project's existing style down (single quotes, 100 columns, LF) instead of
  inheriting Prettier's defaults, so a bare `npx prettier --write` can no longer
  rewrite every string in the repo; `npm run format` / `format:check` wrap it,
  `3.9.10` is pinned with `--save-exact`, `.gitattributes` locks LF, and
  `.git-blame-ignore-revs` points `git blame` past the one-off baseline commit
  (`git config blame.ignoreRevsFile .git-blame-ignore-revs`).
- **`run.ps1` grew `mobile` / `mobile-install`** — the Android APK is built (and
  installed) from the same entry point as the desktop build, and its artifacts
  live under `app/build/mobile`.
- **`install-and-check.ps1`** — one command to install on a USB device,
  launch, pull the startup trace, scan for crashes and grab a screenshot.
- **`scripts/sync-frontend-dist.js`** — copies `web/dist` into the mobile
  frontend; it resolves paths from the project root, so it must be run from
  `web/` (documented in `AGENTS.md`).

## [0.2.0] — 2026-10-23

The reader grew a memory. Look a word up as you read and it settles into a
cross-book notebook; the notebook is reviewed on an SM-2 schedule instead of
being re-listed; and the reading itself became direct — one click on a word, one
click or one pull on the paper's edge to turn. Everything else in this release
is polish around that: a shelf that stops blanking, an Escape key that closes
one layer at a time, and a drop zone that finally imports what you drop.

### Added

- **Dictionary lookup** — select a word in the reader to see phonetic, gloss and
  base form without leaving the page. Backed by a local ECDICT SQLite database
  (`internal/dict`) with lemma table and suffix fallback; installable from the
  library page or `go run ./cmd/dictimport <csv>` (770,611 entries, ~98 MB).
- **Vocabulary notebook** — looked-up words settle into a cross-book notebook
  with the sentence and location they came from (`internal/vocab`). Words ranked
  in the top 5000 by frequency are never auto-filed; everything else needs a
  second lookup. Manual adding always works.
- **Pronunciation** — uses the WebView's built-in speech synthesis, so no audio
  files ship with the app.
- **Notebook page** — every word with its gloss, the sentence it was met in and
  the book it came from; filter by status, search, mark as known, delete. Clicking
  a row jumps back to that line in the book (scrolling mode included, with the
  word kept highlighted). A one-pass review shows the word first and the gloss on
  click.
- **Review history** — every grade bumps a review counter and a timestamp, so
  "学习中" means "you were asked and did not know it" rather than nothing at all.
- **Spaced repetition** — the review pass is scheduled with SM-2 rather than
  "everything not yet mastered, in some order": a correct answer walks the
  interval 1 day → 6 days → interval × ease, a miss drops the word to a
  ten-minute relearning step and lowers its ease factor (clamped at 1.3), and a
  word only counts as mastered once its interval reaches three weeks. The
  notebook header counts what is **due today** — not what is unmastered — each
  row says when it comes back, and every grade reports the new interval.
- **Batch delete** — deletion is behind a mode in the notebook header: rows
  become checkboxes, selection can be inverted, and nothing goes until a
  confirmation names the count.
- **One-click lookup** — a single click on a word opens its card; no selection
  needed. The pointer is resolved with the browser's caret hit test and expanded
  to the word around it, so clicking the margin, a space or a number does
  nothing. Double-clicking still selects (and reaches the highlight colours)
  without flashing a card on the way.
- **Page turning on the book itself** — clicking the covered page stack or the
  empty space beside the book turns, and so does holding the mouse in that edge
  and pulling the paper sideways (one page per gesture). The turn zones follow
  the book instead of a fixed share of the window, so the text column is never a
  page-turn surface.

### Fixed

- Dropping an EPUB on the shelf now imports it. The drop zone claimed to accept
  files but only opened the native picker, because a webview drop carries `File`
  objects with no filesystem path and the import reads from disk. Drops are now
  resolved natively (`DragAndDrop.EnableFileDrop` + `web/src/filedrop.ts`) and
  import straight away, anywhere on the shelf rather than only on the dashed
  box. The same change stops a dropped file from navigating the webview to it —
  previously, dropping anywhere else replaced the app with the raw file.
- Marking a word 已掌握 no longer drops it out of study for good: it is treated
  as a claim and scheduled for a check three weeks out. 忽略 stays the way to
  retire a word permanently.
- The shelf no longer blanks itself on every visit. Returning from a book, the
  notebook or the trash used to unmount the page and rebuild it from nothing:
  a "加载中…" line where the grid had been, then every cover decoding again.
  The page now keeps its last answer across navigations, paints it immediately
  and refreshes underneath, asks the backend once per visit instead of twice,
  and puts imported or deleted books on the shelf as they happen rather than
  after a full reload.
- Escape now dismisses what is on top of the page before leaving it: the word
  card, the selection toolbar, an annotation popover, the contents / bookmarks /
  annotations drawers, and the menu bar each take one press, and only a reader
  with nothing left to close goes back to the library. A bar raised by hovering
  the page edge counts as the same layer and stays down until the pointer
  leaves the edge, and a focused note field swallows the press instead of
  closing the book.
- The notebook detour banner no longer gets covered by the bottom chrome bar that
  slides out when the pointer approaches the bottom edge: the edge probe is off
  for the whole detour, and the banner outranks the chrome when the bars are
  opened on purpose.
- The covered page stacks are only drawn when the book continues that way,
  instead of always promising a turn in both directions.
- The lookup card, selection toolbar and annotation popover now stay inside the
  window: they are clamped sideways and flip to the other side of the text when
  the preferred direction has no room.
- A notebook jump no longer overwrites the reading position, and Backspace during
  one returns to the notebook. The visitor gets a banner with "back to where I
  was" and "continue reading from here".
- Scrolling mode stored offset 0 on every save, so "last read" always meant
  "start of the chapter". It now records the character at the top of the pane.
- Selecting a word did nothing in scrolling mode, which is the default: the
  selection listener and the overlay layer only existed in the paginated view.

## [0.1.0] — 2026-10-09

First release. EpubMaker is a local desktop app (Wails v2, Go + TypeScript) for
importing, reading, reorganising, splitting and exporting EPUB books. The whole
backend is Go — no Node service, no reverse proxy, no open ports.

### Added

- **Import** — native file dialog and `.epub` double-click (file association);
  metadata, TOC, chapters and all resources parsed by a self-written
  EPUB/OCF/OPF/NCX/nav engine (standard library only, no third-party EPUB lib).
- **Library** — shelf with sorting, soft-delete trash with restore and purge,
  cover upload.
- **Reading** — immersive paged reader with single/double page spreads, page
  geometry scaled to the viewport, docked or drawer TOC, hierarchical
  collapsible TOC, "locate current chapter", edge-hover chrome.
- **Annotations** — highlights with colours, per-chapter notes, bookmarks,
  persisted page index and progress offset so reading resumes exactly where it
  stopped.
- **Editing** — book title/author/description, chapter titles and body HTML,
  drag-to-reorder, add/delete/merge chapters, hierarchical TOC editing.
- **Split** — cut a book into multiple volumes by chapter hierarchy, carrying
  only the images, styles and fonts each volume actually references.
- **Export** — EPUB 3 output with both `nav` and `ncx` for older readers.
- **WebDAV** — browse a WebDAV server and import books directly.
- **Recycle bin** — deleting a book moves its directory to `data/trash`; nothing
  is unlinked behind your back.

### Changed

- Backend fully migrated from Express/TypeScript to Go (`app/internal/*`), with
  in-process Wails bindings replacing the HTTP `/api` layer.
- Frontend is embedded into the binary (`go:embed`), so `EpubMaker.exe` is
  self-contained and starts without a separate asset server.
- Paged reader renders real book sheets with covered page edges and a spine.

### Removed

- The 3D page-flip animation. It was rebuilt across eight commits and never felt
  right: each turn mounted two full copies of the chapter HTML (one per face) and
  laid the whole chapter out as one multi-column strip under a
  `mix-blend-mode: screen` sheen, which composites in software inside WebView2 —
  visibly laggy and nothing like a physical book. Within-chapter turns are now an
  instant page swap (a single `translate3d`, no animation, no duplicated DOM).
  The 130 ms cross-dissolve remains for chapter switches only, where it covers
  the async chapter load. Net −585 lines.

### Tooling

- `run.ps1` — single entry point for the build/dev/clean cycle: `help` (default),
  `clean`, `build`, `nsis`, `dev`, `web`, `install`, `test`.
- `build`/`dev` pin `GOTOOLCHAIN` to the version in `app/go.mod`, working around
  wails v2.11 being unable to read Go 1.27 export data.

[Unreleased]: https://github.com/zsying/EpubMaker/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/zsying/EpubMaker/releases/tag/v0.3.0
[0.2.0]: https://github.com/zsying/EpubMaker/releases/tag/v0.2.0
[0.1.0]: https://github.com/zsying/EpubMaker/releases/tag/v0.1.0
