# Changelog

All notable changes to EpubMaker are recorded here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

AI comes to the phone — three capabilities, each hanging off data the app
already has. A word is explained in the sentence it sits in (and that sentence
is translated with it), a sentence is broken down where it was selected, and a
chapter gets a guide before you commit to reading it. Keys are yours (BYOK):
nothing is proxied, nothing is phoned home, and without a key every existing
feature works exactly as before. Everything either feature sends and receives
is recorded in a local diagnostic log, so a failure can be handed over instead
of described.

### Added

- **The review card shows the AI gloss it already has, and offers to ask when it
  does not** — a word explained while reading had its answer sitting in the cache
  while the review card showed only the dictionary line. The card now asks what
  the reader and the notebook sheet already ask, keyed by the word *and the
  sentence printed on it*, so a repeat costs nothing: the stored gloss appears
  with the answer, its sentence translation, and the way into the transcript. A
  word nobody has asked about offers ✦ 查 AI 释义, which opens the same panel the
  reader uses and leaves the answer on the card afterwards instead of turning
  back into a link. None of it is on screen before 显示释义 is tapped — an AI
  explanation is a bigger spoiler than the gloss, and this page exists for
  recall. See ADR-23.
- **AI 对话 can be searched and filtered** — the transcript list is where a
  reader goes to find something the model said, and it offered no way to look:
  thirty rows in recency order and a scroll. It now wears the same header as the
  other two tabs — a search box (always out on the desktop, behind the magnifier
  on a phone) and a 分类 row: 全部 / 查词 / 拆句 / 导读 / 对话. Both narrow the list
  on the backend (`AIConversations(origin, keyword, offset, limit)`), because the
  list arrives a page at a time: a client-side filter would search the thirty
  rows already downloaded and quietly miss the rest. The keyword matches the
  title *and* every message body — what a reader remembers is usually something
  said in the conversation, not the twelve characters the row clips it to — and
  the chips row is drawn from the unfiltered total, so a filter that matches
  nothing cannot hide the way back to 全部.
- **Sort direction on the shelf (顺序 / 倒序)** — the sort sheet gains a
  方向 row below the sort keys. Every key has a natural direction (titles and
  authors read A→Z, 添加时间 shows the newest first — exactly what it did
  before), and the row flips it; the choice persists and a reload keeps it.
  默认排序 has no direction — it is the backend's own order. Picking a
  different sort key falls back to that key's natural direction, so a direction
  left on 倒序 never surprises the next sort.
- **Tag categories on the shelf** — the tags the metadata editor already took
  are finally visible and useful. A chips row under the shelf header (全部 +
  every used label, most used first) narrows the grid to one class of books
  with a tap and releases it with another; filtering is single-select and
  lives only for the session, so the shelf never comes back looking smaller
  than it was left. Cards draw up to two tag chips (+n past that), the active
  tag lighting up on its card, and the phone's editor offers already-used
  labels as reuse chips so the same word is never retyped per book. No
  backend change: ListBooks already carried the tags.
- **The phone's shelf long-press menu gains 导出** — long-pressing a book now
  offers building its EPUB and handing it to the system share sheet, next to
  编辑 and 删除. The Go side writes the built file into an export staging dir
  (swept of day-old copies on every export); a dedicated
  `EpubMakerNative.shareExport` JS surface — its own name, because the v3
  runtime overwrites `window.wails` and shadows the host bridge — wraps it in
  a FileProvider URI and opens the Android chooser, so the book can go to
  WeChat, another reader, or 另存为. The desktop keeps the browser download.
- **Contextual gloss「✦ AI 释义」** — the word card's ✦ AI asks the model what
  the word means *in this sentence*, how the sentence reads in Chinese, and one
  thing worth noticing about its use. The sentence is the grounding: the word
  and the line it came from are the entire request, so the answer cannot wander
  into a different book, and a word the dictionary does not know can still be
  asked about.
  (It originally had the model pick among the dictionary's numbered senses.
  That worked worse in practice: ECDICT folds a word's meanings into one line —
  `n. 1.儿童 2.婴儿 3.子女 …` — which is not something a model can choose from,
  and it kept answering "none of these fit" with the right sense sitting in the
  middle of the line.)
- **The card offers the AI when the dictionary has nothing** —「词库未收录」used
  to be the end of the answer, which is backwards: a word no dictionary has is
  usually a name, a coinage or a domain term, and that is exactly the word a
  reader needs help with. The card now says why the word is missing and puts a
  full-width 「✦ 让 AI 解释「…」」 button in the same box, so the model is one tap
  away instead of hidden behind a small chip. It is offered with no dictionary
  installed as well, since the model never needed one.
- **Sentence parse「✦ AI 拆句」** — the selection toolbar's ✦ AI opens one
  merged view: the translation on top, then the sentence sliced into segments
  with their roles and glosses, then grammar notes. The original sentence is
  echoed above it, so the answer reads against the text it came from.
- **Chapter guide「✦ AI 导读」** — a button in the reader's top bar, next to
  目录 and 书签, offers a summary, the key points and a few words worth
  remembering. Because the chapter text is about to leave the device, every
  send asks first: the dialog names the model and the size, and 取消 sends
  nothing. Long chapters are cut to the prompt budget and the panel says so.
- **BYOK AI settings** —「我的 → 设置」gains an AI section: endpoint, model and
  key, with six presets (OpenAI / DeepSeek / Moonshot / 智谱 / 通义 / Ollama
  本地) and a 测试连接 button. The key lives in `<AppHome>/ai.json` at 0600 —
  never in `config.json`, never in the frontend, which only ever sees whether
  one is stored and its last four characters. A local provider (Ollama) needs
  no key at all.
- **One bottom panel for every answer** — the three capabilities share a
  single sheet (asking / failed / answered / cached), because splitting them
  would triplicate the state machine for no gain. Failure is a soft state
  with 重试 and 去设置; the answer lands above the word card and the selection
  toolbar, and a drag inside the panel scrolls the panel — never the page
  behind it (the swipe exemption list learned two new surfaces).
- **Diagnostic log「设置 → 诊断日志」** — a local, switchable record of what the
  app did: every AI request (the system and user text in full, model, endpoint),
  every answer (finish reason, elapsed time, tokens, the text), why an empty one
  was empty, cache hits, settings saves, frontend errors and every route change.
  Readable in the app, copyable as plain text, clearable, and off with one
  switch. It stays on the device — the app still sends nothing anywhere but to
  the provider the reader configured. Two sinks, because the failures that
  matter most (a blank screen, a killed WebView) take the in-memory copy with
  them: a 300-entry ring for the page and a rotating file (`logs/app.log`) for
  afterwards. The file is capped at 50 MB — past that the oldest 30 MB is
  dropped at a line boundary, and the trim leaves a note in the log saying how
  much went — so months of use cannot fill the phone. Logging is on by default:
  the log is only worth anything if it was already running when the bug
  happened, and one switch in the same panel turns it off.
- **An answer cache that cannot lie** — completed answers are cached in
  SQLite (`ai_cache`), keyed by the hash of the *exact prompt*, so improving a
  prompt retires its old answers instead of serving stale ones. Empty
  answers, network failures and HTTP errors are never cached, which is what
  keeps 重试 honest. Calls are serialised, so a double tap cannot double-bill.
- **AI 对话页（底栏「AI」）** — every answer the app has ever asked for is a
  conversation: a word looked up in a sentence, a sentence broken down, a
  chapter guided. The list shows where each came from, when it was last added
  to and the last thing said in it; opening one replays the whole transcript —
  **system prompt included**, because that is what actually went to the
  provider — and continues it: the stored messages go back as they were, so
  the model answers with the context it originally had. 「新对话」 starts a
  chat by hand. One question is one transcript: a repeat lookup is a cache hit
  and adds nothing, and a failed send rolls its own question back so a retry
  cannot duplicate it.
- **The word card shows the AI gloss it already has** — open a word whose
  sentence was explained before and the explanation is simply there, under
  the dictionary entry (or in place of 「词库未收录」). It is a cache read that
  never calls the provider: the same question, the same answer, no waiting and
  no cost.
- **A JSON answer reads as facts, not as punctuation** — the grounded prompts
  ask the model for JSON, so that is what the transcript stores; the page used
  to print it raw. It now lays the same object out as labelled rows (释义 /
  翻译 / 提示, 句子拆解 as a list of segments), keeps prose that wrapped the
  JSON where it was, and puts the untouched object behind a collapsed
  「原始 JSON」 — the formatting is a view, not a rewrite of the record. The
  list's one-line preview is humanised too (meaning → summary → translation),
  so a row quotes the answer instead of `{"summary":"…`.
- **「查看对话」 from wherever the answer appeared** — the word card's cached
  gloss and the AI panel's three answers now name their transcript, so the
  summary in front of the reader is one tap from the full record (system
  prompt included) and from continuing it. `ParseSentence` and
  `SummarizeChapter` return the conversation id for this; the lookup already
  did.
- **A notebook row opens the word, not the book** — tapping a word in 生词本
  used to leave for the chapter it came from, which answered a different
  question than the tap asked ("what was this?" not "where was this?") and
  spent a page turn to do it. The row now opens a sheet: the word at reading
  size with 发音, the gloss, the whole example sentence, the provenance and the
  schedule, with two quiet links in the footer — 定位原文 (the old behaviour, now
  a deliberate second tap) and ✦ AI 解释, which explains this word in this
  sentence and translates it, with 查看完整对话 one tap further on. A previously
  asked question shows its cached answer inside the sheet without a tap, and the
  AI link is then gone: the answer is already on the card, so a second door to
  it would only be noise.
- **查词历史 rows open a word card too** — the history is the notebook's raw
  material, and its rows only ever offered one thing: a 加入生词本 button sitting
  in the way of the row. The row itself now opens a card with the word at
  reading size, 发音, the gloss in full (the row clamps it to a line — for
  `small` that hides four of its five senses), when it was last looked up, and
  加入生词本 as a single text link that disappears once the word is in. There is
  no 定位原文 and no AI here: the history remembers what was looked up, not
  where, so it has no page to point at and no sentence to explain the word in.
- **批注 writes the note at the moment of highlighting** — the selection toolbar
  could only paint, so a highlight that carried a thought took two steps: mark
  the sentence, then find the mark again to open its popover. 批注 does both in
  one press — it marks the range in the colour last used and opens the note field
  with the cursor already in it, the marked sentence echoed above the field
  because on a phone the keyboard covers the line the note is about. It reuses
  the popover a tap on an existing mark opens, so there is one note editor rather
  than two; opening an existing mark does not raise the keyboard, since
  recolouring is not writing. Offered in paged mode only, where highlights are
  actually painted.
- **LLM 配置 gets its own page** — the settings page had outgrown one card, and
  what grew is more than a key: the endpoint form (address / model / key, as
  before) now shares `/llm` with a standing-prompt card — the prompt every
  hand-made conversation opens with, configurable and restorable to the built-in
  default by saving empty — and a prompt library: named prompts saved by the
  reader, offered when a new conversation starts. The picker lives in the chat
  room while the conversation is still unnamed, and the prompt it chose comes
  back with the first answer so the room shows what it opened with. The library
  is a library, not a source of truth: a conversation copies its prompt when it
  starts, so editing or deleting one never rewrites an existing transcript.

### Changed

- **The three tabs' second row is now literally one row** — 生词本's 全部 / 待学 /
  学习中 / 已掌握 were `.btn.sm` rectangles (26px tall, 6px radius, no padding
  above the row) while the shelf's tag chips were 28px pills inset 2px: the same
  bar, one tab over, sat 2px higher and read as a different control. They are
  now the shelf's `.lib-tags` / `.lib-tag-chip`, so 书架 tags, notebook statuses
  and AI origins are one control on all three pages — same height, same padding,
  same radius, same row position. The header's search box was also sized twice
  (`.input`'s padding gave the shelf 33px, the notebook's own `height: 32px` gave
  it 32), which is why the notebook's entire page sat 1px above the shelf's on
  the desktop; `.lib-search-input` owns that size now.
- **The four tabs share one skeleton** — 书架 / 生词本 / AI / 我的 used to be four
  variations of the same idea: the shelf split its header from its scroller so
  the title stayed, 生词本 used the same header class but inside the page, so
  scrolling lost the title entirely, the AI list stuck its header down with
  `position: sticky`, and 我的 was never fixed at all. They now all wear
  `.page.shell` — a fixed title bar, an optional fixed action row (the shelf's
  tag chips, the notebook's filter chips), and one scroller between them, which
  is the shelf's own shape adopted by the other three. Rows sit outside the
  scroller rather than being sticky inside it: sticky needs to know how tall the
  row above is, and that number moves whenever the header grows.
- **生词本's header is one row on a phone** — title, count, 搜索, 查词历史 and
  复习 used to take three lines (a full-width search box, then the buttons under
  it). The count now shows the short form (96 词 · 到期 7) where the full one
  does not fit, 查词历史 becomes a clock icon (still named for screen readers),
  and the search box hides behind the magnifier exactly like the shelf's — it
  opens to a full-width field instead of owning a permanent row.
- **The reader's footer splits in two** — the page number and the progress
  percentage shared one centred line ("38% · 第 3/12 页"), which put both in the
  middle of the screen where neither thumb rests. 第 3/12 页 now sits at the left
  edge and 全书 38% at the right. The label is spelled out because the two
  numbers have different denominators — this chapter's pages against the whole
  book — and an unlabelled percentage beside a page counter invites reading one
  as a restatement of the other.
- **「我的」is four intent groups, not a list of links** — the tab used to be
  seven flat rows (书签 / 划线 / 回收站 / WebDAV / Wi-Fi 传书 / 设置 / 关于) with the
  dictionary button floating outside the list, which gave 查词词库, WebDAV and
  设置 the same weight and left no way to see where to start. It is now
  阅读 / 笔记 / 书库 / AI 与系统, with 关于 demoted to a footer line. Two row
  sizes carry the hierarchy — a 36px coloured icon tile and two lines for
  阅读偏好 and 查词词库, a 32px grey tile for the rest — and every row answers
  "what is the state" on its own: 书签 12, 回收站 3, WebDAV's saved host,
  the AI model, 词库 100,214 词. The dictionary stays a sheet, but now opens on
  a status card with the sources listed one by one (name, blurb, size) instead
  of two bare lines of text.
- **设置 has one structure for every row** — the whole font catalogue used to
  be dumped inline (eight chips carrying "下载中…" and "↓") while AI was a
  single line pointing at another page: the same kind of setting at two
  different depths. Settings is grouped 外观 / 阅读 / AI / 诊断, and the rule is
  now explicit — what needs a preview stays inline (the theme swatches, the
  paged/scroll segment, the switches), what needs browsing or typing sinks a
  level (the font list, AI 配置, 查看记录). 阅读字体 is therefore a one-line
  summary that opens a sheet, the sibling of AI 配置.
- **Theme swatches are mini pages** — five dots that only differed in paper
  colour are five page previews that also show the ink colour, because the
  paper alone says nothing about how a page will read.
- **字号 is settable outside the reader** — the same 13–26 range the Aa panel
  clamps to, writing the same `epubmaker.fontSize` key, so the setting can be
  reached without opening a book first.
- **Warm and status colours follow the dark themes** — `--warn` / `--warn-soft`
  joined the palette (for 未安装 / 未配置, which must read as attention rather
  than failure), and the dark and midnight themes now brighten `--ok` /
  `--danger` and darken their soft fills, so badges and the dictionary status
  card do not flash a light-theme block on a dark page.
- **A new chat starts by choosing its prompt, in two steps** — the dropdown that
  mixed the prompt into the composer (and hid the prompt's text entirely) is
  replaced by a chooser: a list of titles with the selected prompt's full text
  previewed underneath, and one 开始对话 button to commit. The seeded 对话 row
  is preselected, so confirming is one tap; before the first message the room
  still shows which prompt is opening it, with a 更换 way back.
- **The prompt library absorbed the 对话提示词 card** — /llm is two cards now.
  The library ships with four seeded system prompts: 对话 (the standing prompt
  every hand-made chat opens with, migrated from the old setting), and the
  built-in texts of 查词 / 拆句 / 导读, which those features now read from the
  library — editing them is real, for better or worse. System rows cannot be
  deleted, editing is allowed but discouraged (the note says so; a broken edit
  to the JSON-shaped ones feeds straight into the feature), and a drifted row
  offers 恢复默认, which puts the built-in name and text back in one tap.
- **Editing a prompt opens a dialog, not a form at the bottom of the list** —
  the old inline editor sat under the last row, so with a long library you had
  to scroll past every prompt to reach it. The dialog is centered, capped at
  85vh with its own scroll, closes on a mask tap (and on one hardware back,
  via the same back-close contract as every other overlay), and for a drifted
  system row it offers 恢复默认内容 — the built-in text back in the editor,
  still one 保存 away from being real.
- **恢复默认 is always on a system row** — it used to appear only after the
  text had drifted, so a reader who had never edited had no way to see (or
  trust) that the way back exists. The button is now always there, disabled
  while pristine, enabled the moment the text leaves the built-in.

- **A page turn moves like paper, and moves nothing but pixels** — turning a page
  inside a chapter used to land in a single frame: the column strip's
  `translate3d` jumped from one page to the next. It now slides over 210 ms, with
  a soft shadow band sweeping across the sheet in the same direction (34% of the
  sheet wide, ~14% black at its peak; denser on the dark themes, where a shadow
  over near-black paper would otherwise not read at all). The transition lives on
  a `turning` class instead of on `.reader-columns` itself, so restore, resize and
  the 1↔2 page switch still land instantly — an always-on transition made the text
  fly in from page 1 after any re-measure. Nothing re-layouts: clip box, spread,
  sheet slots, page count and page number stay put on every frame of the turn
  (asserted frame by frame, not eyeballed), and the strip was already its own
  compositor layer, so the slide is animated on the GPU. Measured on the phone
  through `Page.startScreencast`: 21 frames per turn, 19 of them distinct, 20 ms
  median — continuous motion, not a few steps. `prefers-reduced-motion: reduce`
  turns the page instantly and draws no band.
- **A swipe turns the page under the thumb instead of after it** — the turn used
  to be decided at `touchend` and played out afterwards, so the page sat still
  while the finger moved and then moved while the finger was gone. Now the page
  follows the finger 1:1 from the first horizontal pixel, shadow and all, and the
  release decides the rest: carried a third of the way (or flicked faster than
  0.5 px/ms) it finishes the journey; let go short it falls back to where it came
  from. Both endings are the same 210 ms slide, so a page that is put down halfway
  is a state the reader really passes through rather than a decision announced at
  the end. A `touchcancel` always puts the page back — nobody let go, so nothing
  was decided. A second flick catches the page still sliding from the first and
  carries on from there, which is what makes fast page-turning feel continuous.
  `prefers-reduced-motion: reduce` keeps the old instant turn with no drag at
  all. The keyboard, the wheel and the page-edge clicks keep the fixed-duration
  slide: there is no finger to synchronise with.
- **A swipe carries the reader across a chapter boundary too** — the boundary was
  the one place the hand let go of the paper: the column strip only holds this
  chapter, so pulling further dragged a page onto nothing, and the swipe fell back
  to a 130 ms cross-fade. The neighbour's page is now laid out *before* the finger
  arrives — same margins, same column width, same trailing-page measurement as the
  page you are on — and parked exactly one spread off-screen, so the finger drags a
  real pair of pages. Releasing past the threshold hands over rather than cuts: the
  next chapter loads and measures while the neighbour page still covers the paper,
  and a single frame then drops the drag offset, the buffer and the neighbour at
  once, so the swap has nothing visible to show. Dragging back mid-turn gives the
  page back to the strip instead of swallowing the gesture, a second chapter turn
  needs a second swipe, and when there is no neighbour to pull in (a one-chapter
  book, or a fetch that failed) the boundary behaves exactly as before.
  Measured on the phone: a 60 / 140 / 240 px drag moves the page 60 / 140 / 240 px
  and the neighbour in lockstep, the release lands on the previous chapter's *last*
  page with text on it, and the 600 ms after a boundary turn run 38 frames with
  none over 34 ms — the neighbour is a whole chapter being typeset, which is where
  a hitch would have been expected.
- **The AI tab behaves like the top-level tab it is** — 书架 / 生词本 / AI / 我的
  are siblings, so `/ai` no longer shows a back chevron: there is no layer
  above it, and the button could only leave the app. The chevron stays on
  `/ai/:id`, which really is stacked on the list.
- **The conversation list is paged** — 30 rows per request, more when the
  bottom of the list comes into view (`AIConversations(offset, limit)` returns
  `{items, total, hasMore}`, capped at 100). A month of lookups is hundreds of
  transcripts, and none of them needed to be in the first payload for the page
  to work; the header still shows the true total.
- **Deleting a conversation is a gesture, not a button** — a red 删 on every
  row made a reading list look like a database screen, and sat exactly where
  the thumb lands. Rows now slide left to reveal 删除, and the row waits for
  the gesture to commit to an axis first, so a vertical scroll is still a
  scroll.
- **The transcript scrolls; the composer does not** — the input box is pinned
  to the bottom of the room and the messages scroll inside it, instead of the
  whole page scrolling the box out of reach after two answers (and, on a
  phone, behind the keyboard).
- **Returning to the shelf is fast again** — the shelf's book list carried every
  cover inline as base64, and the WebView had to write twelve of those ~400 KB
  data URLs into `<img src>` on every visit. Measured on the phone with a
  40-book library: a 16.5 MB list, 1.5–2.1 s to build it, 866 ms of
  `setAttribute`, a 1.2 s frozen frame, and 1.2–1.5 s between the tap and the
  shelf appearing. Each cover now gets a 320×480 JPEG thumbnail (~20–45 KB)
  written next to it once — at import, at a cover change, or by a background
  pass for books imported before this change — and the list ships that instead.
  Same measurement after: 1.4 MB, ~220 ms, 82 ms, a 182 ms worst frame, and
  ~230 ms from tap to shelf. Books whose cover cannot be decoded (WEBP, AVIF,
  SVG) keep using the original image, which is the old behaviour for a handful
  of books rather than a broken shelf.
- **The example sentence is no longer cut at 220 characters** — the extractor
  counted 220 characters on each side of the word and stopped, which is not a
  sentence but half of one: looking up a word inside *Lessons in Chemistry*'s
  opening sentence stored `…the thirty-year-old mother of Madel`. The walk now
  runs to the paragraph's own end, and only a block with no sentence terminator
  at all (a poem, a wall of dialogue) is windowed — 800 characters around the
  word, marked with `…` on the cut side and never through a word. Rows already
  in a notebook are re-cut from their chapter the next time the page is opened
  (`looksLikeFragment` now also flags a context that stops before its own full
  stop, not only one that starts mid-word).
- **Notebook rows show five lines of the sentence instead of three** — three cut
  the ordinary sentence, not just the long one, and an example clipped
  mid-clause is no example at all. The sheet behind the row shows it whole
  however long it is.
- **A long sentence is quoted in the AI panel, not reprinted** — the panel that
  explains a word in a sentence has to show the sentence, and a 583-character
  one filled the whole sheet: the explanation the reader tapped for started on
  the bottom edge of the screen. Past four lines it folds with 展开整句, so the
  answer begins on the first screen. Nothing is lost — the abbreviation is a
  view, the sentence of record is still whole, and the word sheet underneath
  shows all of it.
- **Taps no longer wait out the double-tap-to-zoom window.** Only the book card
  had `touch-action: manipulation`; on the tab bar the browser held the click
  back for ~292 ms (measured: touchend at 457 ms, click at 749 ms), which is the
  first thing a thumb feels after touching 书架 or 生词本. The rule is on `html`
  now, so every button, tab and row is immediate; the reader's drag surfaces
  keep their stricter `touch-action` (`pan-y` for page turns, `none` for the
  selection handles).
- The shelf no longer repaints when a re-fetch returns the same books. Leaving a
  book and coming back always re-reads the list, and the answer is usually
  identical — replacing it parked twelve new `<img>` elements and twelve image
  decodes at the end of the transition.
- The reader's gesture exemption list covers the AI panel and the privacy
  dialog: a touch that starts inside either scrolls it, and a horizontal drag
  there can no longer turn the page behind the answer.
- The chapter-head guide chip is a fixed chip, not an injection into the
  text: this reader paginates by measuring the content, and anything joining
  the flow would shift every character offset after it — progress,
  highlights and lookups all count text nodes.
- The chapter guide moved from a chip floating over the first page into the
  reader's top bar. Read as a page element it looked like part of the text it
  hovered above, and it only existed at the top of a chapter — the top bar is
  where every other chapter-scale action already lives, and it is reachable
  from any page. The chip and its scroll tracking are gone, so nothing floats
  over the text at all.
- The word card's ✦ AI closes the card as the panel opens. Both answer the same
  question and the panel answers it in full; leaving the card up parked a
  duplicate over the page the panel is meant to leave readable.
- An AI failure now says *which* failure it was. "AI 没有返回内容" was the single
  wording for four different things; the provider's `finish_reason`, its
  `reasoning_content` and the answer's shape now separate a truncated answer
  ("被截断，请重试或换一个模型") from a reasoning model that only thought, from a
  content filter, from a genuinely empty reply. The output budget went from 1024
  to 4096 tokens, which is a ceiling rather than a target — but 1024 could not
  fit a segmented sentence plus a reasoning model's thinking, and the whole
  budget going to the thinking is exactly how a successful request looked like
  "no content".
- **The phone's reader no longer offers 整理** — the action row is 目录 · 书签 ·
  划线 · 设置. 整理 is chapter tooling (drag chapters into order, an HTML editor,
  splitting a volume) and none of it fits a phone: opening it ended a reading
  session in a three-pane desktop layout whose controls a thumb cannot hit. The
  phone keeps the book-level edit it can actually use — long-press a cover on the
  shelf for 书名 / 作者 / 标签 / 封面 — and the route itself now answers on a
  touch-primary device (an old link or a carried-over history entry explains
  where that edit lives) instead of rendering the desktop page there. The desktop
  keeps 整理 everywhere it had it: the scroll-mode toolbar, the shelf card, and
  `/books/:id/edit`.

### Fixed

- **A hard navigation to any page no longer dies with `net::ERR_CONNECTION_REFUSED`**
  — reported from the phone as `/llm` failing to load, where 退回 and tapping again
  worked. The page it asked for had nothing to serve it: every route is a 404 on
  that host, and the Android WebView never shows a 404 — `WailsPathHandler` turns
  "no bytes for this path" into `null`, which to Chromium means "not mine, ask the
  network", and `https://wails.localhost` is loopback port 443, where nothing
  listens. A tap that arrived while the WebView was still resuming, a renderer
  restored after a long idle, a reload — each could only end on an error page. The
  bundle now answers a document request for a path that is not a file with
  `index.html` (`internal/webassets`, shared by the desktop shell and the phone),
  so the router picks the route as it always does for an in-app tap, and a reload
  on a deep link is no longer a way to lose the document. A missing *asset* still
  404s rather than being dressed up as HTML. The main frame is also told
  `text/html`: the type is guessed from the path's extension, so an extension-less
  route would have arrived as `application/octet-stream` and been downloaded
  instead of rendered.
- **生词本's title no longer breaks in two on a 360px phone** — the fixed bar
  put the title, the count and four controls in one 360px row and came to
  ~357px, so flex took the difference out of the `h1` and 生词本 rendered as
  生词 / 本, doubling the height of a bar that is supposed to be fixed. The
  title is now `flex: 0 0 auto; white-space: nowrap`; whatever has to give is
  the count, via ellipsis. The phone count also drops 「· 到期 N」 — the 复习
  button beside it already carries that number, and the duplicate was a large
  part of what filled the row.
- **The search box no longer turns the header into three rows** — the input is
  ordered after the buttons in the DOM (right for the desktop row, where it
  reads left of them), and on a phone `flex: 1 1 100%` claimed a whole line and
  pushed 搜索 / 查词历史 / 复习 onto a third. `order: 10` sends the input to the
  end of the row: opening the search costs one line (38px → 78px) instead of
  two, and closing it returns to 38px. The collapsed and open states also share
  one `margin-bottom` now, so the scroller shrinks by exactly what the header
  grows and the list keeps ending at the tab bar.
- **Paging no longer dies after the shelf was scrolled to its end** — the
  load-more sentinel unmounts once every book is rendered, and the observer
  effect (which bails when the sentinel ref is null) did not re-run when the
  paging reset re-mounted it: change the sort or the filter after one full
  scroll-through and the shelf went permanently stuck on its first page of
  cards. The sentinel's mounted state is now a dependency of that effect, and
  picking a sort key resets paging in the same batch, so the reset no longer
  paints the whole sorted shelf for one frame on the way.
- **Wi-Fi 传书 no longer refuses a book because an unrelated one carries the
  same epub identifier** — import dedupe matched the file's sha256 or the
  epub's `dc:identifier`, and z-library epubs reuse one urn:uuid across
  unrelated books: a Kissinger set was rejected as 「已有《TABOO: MEGA Bundle
  150 BOOKS…》」, a shelf entry the reader could never have confused it with.
  The identifier now only counts as a duplicate when the title matches too
  (case- and whitespace-insensitive) — the same-file key is the sha256, and
  a legacy (pre-hashing) re-import has the same title by construction, so
  nothing that used to be caught is let through except collisions like this
  one.
- **Long chapters from some Chinese EPUBs no longer collapse to a single page
  in paged mode** — txt-converted books wrap whole chapters in
  `<div class="main">`, which collided with the app shell's own `.main
  { overflow-y: auto }`: inside the multicol strip a scroll container is
  monolithic, never splits across columns, and a 100k-character chapter
  paginated to one page while scroll mode looked fine. The book's stylesheet is
  never loaded, so `class`/`id` on chapter markup are now stripped at sanitize
  time (they were dead weight whose only possible effect was colliding with the
  app's classes), and the reader content subtree force-resets the two inline
  styles that can likewise make a chapter unbreakable (`overflow`,
  `position`). Character offsets are untouched — attributes are not text — so
  highlights, progress, bookmarks and vocabulary keep pointing where they did.
- **A chapter's last page is no longer unreachable in two-page mode** — the
  turn ceiling was `pageCount - pagesPerView`, which forces every spread to be
  full: a 9-page chapter on a wide window turned 1 / 3 / 5 / 7 and then
  straight into the next chapter, and page 9 did not exist for the reader. Odd
  page counts are the norm, so the ceiling is now the last page-aligned index
  that has content, and the final spread may carry a single page, alone in its
  slot like a book's last page. (Its sheet also took a right-hand page's
  rounding and page-number corner by parity, backwards for a page whose gutter
  is on its right; the sheet now takes its side from the slot it sits in.)
- **Crossing a chapter no longer flashes the chapter just left** — the
  neighbouring page is a whole chapter typeset into one strip, thousands of
  pixels wide, parked one spread off-screen in a screen-sized box with no
  clipping of its own. When the reader turns forward into a chapter, the reader
  pre-fetches the chapter it came from (a sideways chapter turn has to be able to
  go back), and that strip's overflow runs back across the viewport — a page of
  the chapter just left, sitting under the live page. A desktop browser hides it
  by clipping a promoted layer to its own bounds, which is the compositor's rule
  and not ours; the phone's WebView drops that clip for the first frame of a
  fresh layer, which is the flash. The peek now clips to its own box, so "parked
  off-screen" is a rule the stylesheet states rather than something to hope for,
  and the test asks the question that would have caught it — hit-testing the
  middle of the sheet with the peek's `pointer-events` lifted for one call —
  instead of measuring a box that was always off-screen anyway.
- **A page can only be bookmarked once** — the 书签 drawer's ＋ 添加当前页 button
  added a bookmark on every press, so one page could collect a column of identical
  rows (and then the star in the reader's top bar, which asks "is this page
  marked?", behaved oddly: it removed one of them and stayed lit). The button is
  now the same action as the star — 添加当前页 or 移除本页书签, depending on the
  page — and the page is marked once however many times it is pressed, including
  two presses inside one frame, because a press that lands while the first request
  is in flight is dropped rather than queued. The rule is enforced where the data
  lives as well: a bookmark is identified by its chapter and anchor, so the
  database has one row per spot (`ON CONFLICT DO NOTHING`, plus a unique index),
  and `AddBookmark` answers with the row that is already there. Pages that already
  carry duplicates are collapsed by the migration (the first copy wins) and one
  press of the star or the button now clears all of them, so the star cannot be
  left lit by a mark the reader cannot see.
- **A chapter no longer ends on a blank page** — the page count was
  `ceil(scrollWidth / stride)`, which counts column *boxes*: a last paragraph that
  spilled a few pixels past the final column widened the strip by one and produced
  an empty page. Nothing showed it until reading backwards, where the previous
  chapter's last page is exactly where the reader lands — so the page flipped to
  blank paper, and the counter stuck at 11 / 12. The box count and the page count
  are now separate numbers: the strip is still as wide as its columns, but the page
  count comes from measuring where the last non-blank character actually sits
  (through `getClientRects`, because a soft hyphen splits one character into two
  fragments). Reading position uses the same measurement, so the last page no
  longer records the offset of the page before it.
- **A back gesture out of a long reading session could leave a blank screen** —
  the reader itself was fine; the history bookkeeping behind the hardware back
  button was not. Every overlay pushed its own history entry and, on unmount,
  decided "was that pop mine?" by looking at `history.state`. With two overlays
  stacked (word card → AI panel) they could drop each other's entry, so the next
  back consumed a real page entry while the guard swallowed it to close an
  overlay: the URL and the screen ended up on different pages, and a few more
  swipes produced an empty screen and then Android's exit prompt. Any number of
  open overlays now owns exactly one history entry; the drop is deferred to the
  end of the effect flush (so closing one overlay while opening another cannot
  drop the wrong one) and only fires when the current entry is still ours. Two
  safety nets were added with it: an error boundary (an uncaught render error
  used to unmount the whole tree, which on the reader's dark background is
  indistinguishable from a frozen app) and a catch-all route for reader URLs, so
  a desynced history can land on the shelf instead of on nothing.
- **Backing out of a book no longer walks through it twice** — reported as
  生词本 → 书籍正文 → 生词本 → 书架 → 退出. Leaving a page while an overlay was
  open (the word card, the AI panel, the selection toolbar) pushed the new page
  *on top of* the overlay's single history entry, burying it; the next back press
  then popped that buried copy and re-rendered the page the reader had just left.
  Four rules now keep the stack honest: a navigation taken with an overlay open
  replaces that entry instead of stacking on it, an in-app 返回 with a card on
  screen closes the overlays and steps over them in the same press (the press
  used to be swallowed, which read as a dead button), a marked entry that nobody
  is tracking is skipped rather than rendered, and tapping the tab you are
  already on no longer pushes a second copy of it.
- **Tabs no longer leave copies behind them** — reported as 生词本 → 书架 → 生词本
  → 书架 → 退出: from 生词本, one back reached the shelf, and the *next* back went
  into the notebook again instead of leaving. Every tab switch pushed a history
  entry, so walking 书架 → 生词本 → 书架 → 生词本 produced
  `[/, /vocab, /, /vocab]` — the third press landed on the second entry, which
  is a copy of the notebook. The three tabs are siblings, not steps, so they now
  behave that way: from the shelf a tab is pushed once (so it sits directly on
  the shelf), from a sibling tab it replaces it (so the depth stays 2), and the
  shelf tab pops straight back to the root however deep the page is. One back
  from 生词本 is therefore always the shelf, and the next one is the exit
  prompt. The header chevron and the reader's 返回 step over at most what
  exists — asking for one entry more used to be a silent no-op, which is how a
  back button could look dead.
- **Tapping a word on the line after a hyphenated wrap looks up that word** —
  it used to look up the word that was split. Print-converted EPUBs carry a
  soft hyphen (U+00AD) inside words, so a line can end "ac-" and start
  "cused". For the character right after such a break the browser reports a
  rect that unions an empty run at the end of the previous line with the glyph
  on the next one — a box as wide as the column and two lines tall — and the
  hit test trusted it, so every point on the following line resolved to that
  one character and the whole line looked up the hyphenated word. Hit testing
  now matches line fragment by line fragment and anchors the card to the
  fragment that was actually tapped; the offset→page map takes the glyph
  fragment too, so restoring into a hyphenated line no longer lands on the
  page before it.
- **A word selected across a hyphen is still that word** — a long press on
  "psychiatrist" in a print-converted book selects the word *with three soft
  hyphens inside it* (that converter marked every hyphenation point), and the
  raw selection reached the dictionary as-is, so the lookup missed a word
  printed right there on the page.
  Lookup keys now drop the invisible marks a print/web conversion leaves inside
  words — U+00AD soft hyphen, the zero-width spaces and the BOM — and so does
  the sentence stored as a notebook row's context and sent to the AI, which is
  text rather than a position. Reading offsets are left alone on purpose: they
  count the characters that are actually in the document, and rewriting the text
  would have shifted every annotation, bookmark and vocabulary pointer saved so
  far.
- **A highlight no longer keeps the converter's invisible marks in its text** —
  the label a highlight stores is text (it is what the 划线 drawer lists and
  what a jump back searches for), so selection text is normalised at the point
  it leaves the reader, exactly like lookup keys and sentences already were.
  Long-pressing "psychiatrist" in a print-converted book used to store
  `psy<SHY>chi<SHY>at<SHY>rist`.
- **「✦ AI 导读」 says what is missing instead of failing after the fact** —
  the guide checks the provider settings before it offers to send anything, so
  an unconfigured install gets a dialog that says so with a 去设置 button,
  rather than a privacy confirmation whose only possible outcome is an error.
  The not-configured error itself now names the settings file the app actually
  read, because "but I DID configure it" is nearly always a second `ai.json`
  under another `AppHome`.
- **The selection toolbar leaves when the AI panel arrives** — tapping ✦ AI on
  a selection opened the answer but left the little strip of buttons (查词 /
  ✦ AI / the three colours) parked above the highlighted sentence. On a phone
  that strip sits near the top of the page, so it ended up over the chapter
  heading while the reader was reading the answer. Opening the panel now clears
  the selection and the bar, the way 划线 already did.
- **A word card that grows after opening no longer hangs off the screen** —
  reopening a word whose gloss was already cached opened the card short (the
  dictionary entry alone), placed it against *that* height, and then let the
  cached answer arrive and double it. Measured on the phone: 217 px → 424 px
  while the card stayed at the top it was given, so its bottom landed at 902 in
  a 758 px window and the last lines — the answer the card exists to show —
  were below the edge. Placement now re-runs whenever the overlay's own size
  changes (`ResizeObserver`), instead of on a hand-picked list of state keys
  that the cached answer never touched; a font swap, an image, or 加入生词本
  turning into 已在生词本 re-place it the same way. And when neither side can
  hold the card whole, it now goes where there is more room rather than always
  hanging downwards: the same card settles at 8..432, above the word it
  explains, which stays visible instead of disappearing under it.

### Tooling

- **Wails v3.0.0 replaces the beta** — the stable release landed on 2026-10-26,
  so `go.mod` moves from `v3.0.0-beta.34` to `v3.0.0` and the `wails3` CLI is
  reinstalled at the same version (module and CLI are pinned together on
  purpose: it generates the version resource and the Android overlay). No
  application code changed — the beta.34 → v3.0.0 delta is five fixes (a Windows
  menu-bar paint crash, a dark-mode crash, updater staging/rollback, `update cli`
  not finding v3 releases, template runtime pinning) and no public API — so the
  entire diff is one line of `go.mod` and four of `go.sum`. v3.0.0 asks for Go
  1.26+; we were already on 1.26.4 / 1.27.
- **The desktop build moved to Wails v3, so there is one host instead of two** —
  `app/main.go` now serves both the Windows window and the Android package; the
  only platform-specific code left is two `//go:build` files (`platform_android.go`
  pins `EPUBMAKER_HOME` and writes `trace.log`, `platform_desktop.go` is the
  no-op twin) and `cmd/mobile/main.go` is gone. The v2 API turned out to be used
  in six call sites across two files, so the work was in the build chain, not in
  the app: the frontend's two-transport switch (`window.go` vs `Call.ByName`,
  plus `hasV3Runtime()` / `hasNativeDialogs`) is deleted and every call now goes
  through the host's own `/wails/runtime.js`. Native dialogs and file drop are
  v3 APIs (`Dialog.OpenFile`, `EnableFileDrop` + `WindowFilesDropped` → an
  `epub:dropped` event), which is why the phone and the desktop finally share one
  implementation. See ADR-22.
- **The build scripts are ours, and the CLI only generates** — `wails3 build`,
  `dev` and `package` drive Taskfiles through go-task, which cannot run this
  repo's wrappers on Windows (same reason the Android build has always had its
  own script). `app/build-windows.ps1` (web bundle → version resource → `go build`
  → optional NSIS) and `app/dev-windows.ps1` (vite on :7800, the app proxied to
  it, rebuild + relaunch on a Go change) replace them; `wails3` keeps exactly two
  jobs, `generate syso` and `android overlay:gen`. `run.ps1` is now a thin
  dispatcher and its `Set-WailsToolchain` workaround is gone.
- **A version number is written in one place** — `app/build/config.yml`'s
  `info.version`; both build scripts inject `-X …AppVersion=` from it, and the
  NSIS build passes `-DINFO_PRODUCTVERSION` instead of inheriting v2's stale
  fallbacks. `app/wails.json` and the Android-only `build/config.yml` are deleted.
- **The desktop can be driven over CDP** — `EPUBMAKER_DEBUG_PORT` becomes
  `--remote-debugging-port` in `Windows.AdditionalBrowserArgs` (v3 ignores the
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable), so the release
  binary can be inspected and asserted the way the phone already could.

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
