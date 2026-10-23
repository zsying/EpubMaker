# Changelog

All notable changes to EpubMaker are recorded here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Fixed

- The lookup card, selection toolbar and annotation popover now stay inside the
  window: they are clamped sideways and flip to the other side of the text when
  the preferred direction has no room.

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

[Unreleased]: https://github.com/zsying/EpubMaker/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zsying/EpubMaker/releases/tag/v0.1.0
