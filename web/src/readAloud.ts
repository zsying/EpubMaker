// 听书: turning a chapter into speakable sentences, and the players that read
// them aloud.
//
// Two things live here because they are the same problem seen from both ends:
// what to say (spans with character offsets, so the reader can highlight and
// page to them) and how to say it (native engine, Web Speech, or the online
// neural voice). Everything above this file is engine-agnostic — the reader
// only ever pushes a sentence and listens for `start` / `done` / `idle`.
//
// The offset contract is the reader's: a span's `start`/`end` are positions in
// the chapter's rendered text, exactly what annotations and progress already
// use. Nothing here invents a second coordinate system.
import { chapterHost } from './sentence';

export type Span = { start: number; end: number; text: string };

/* ------------------------------ sentence split ----------------------------- */

const BLOCK = new Set([
  'P',
  'DIV',
  'LI',
  'UL',
  'OL',
  'DL',
  'DT',
  'DD',
  'BLOCKQUOTE',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'ASIDE',
  'NAV',
  'MAIN',
  'FIGURE',
  'FIGCAPTION',
  'PRE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'TD',
  'TH',
  'TR',
  'TABLE',
  'BODY',
]);

/** Sentence-final marks. Nothing else ends a span. A semicolon, an ellipsis,
 * an em dash or a closing book-title mark all sit *inside* a sentence, and
 * cutting there is heard as a pause mid-thought — on the online voice it also
 * costs an extra request, so the seam becomes a real gap. */
const TERM = /[。！？!?]/;
/** Marks that may follow a terminator and still belong to that sentence:
 * closing quotes and brackets. Never an opening one, and never 》〉 — a book
 * title closes inside a sentence far more often than at the end of one. */
const CLOSER = /["'”’）)」』】〕]/;
/** Where an over-long span may be cut, best pause first. Same set the reader
 * hears as a beat: clause punctuation, ellipsis, em dash. */
const SOFT = /[，、,:：；;…—]/;

/** Longest text handed to a single utterance. Cloud voices bill and stall by
 * length; the system engine's prosody also drifts on very long input, and a
 * 100-character cap is roughly one comfortable breath. */
const MAX_SPAN = 110;

function nearestBlock(node: Node, root: Element): Element | null {
  let el = node.parentElement;
  while (el && el !== root) {
    if (BLOCK.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return null;
}

/** Pushes `raw` (starting at `start`) with surrounding whitespace trimmed, so
 * offsets stay exact while the spoken text has no leading spaces. */
function pushTrimmed(out: Span[], start: number, raw: string) {
  const lead = raw.length - raw.trimStart().length;
  const body = raw.trim();
  if (!body) return;
  out.push({ start: start + lead, end: start + lead + body.length, text: body });
}

/** Splits an over-long sentence at a comma near the cap, then recurses on the
 * remainder. Headings and run-on paragraphs otherwise come out as 400-character
 * blocks the engine reads in one flat breath. */
function pushSegment(out: Span[], start: number, raw: string) {
  let s = start;
  let t = raw;
  while (t.length > MAX_SPAN) {
    let at = -1;
    const floor = Math.floor(MAX_SPAN * 0.45);
    for (let i = Math.min(MAX_SPAN, t.length - 1); i >= floor; i--) {
      if (SOFT.test(t[i])) {
        at = i + 1;
        break;
      }
    }
    if (at < 0) {
      const sp = t.lastIndexOf(' ', MAX_SPAN);
      at = sp > floor ? sp : MAX_SPAN;
    }
    const head = t.slice(0, at);
    pushTrimmed(out, s, head);
    s += at;
    t = t.slice(at);
  }
  pushTrimmed(out, s, t);
}

/**
 * Every sentence of a chapter, in reading order, with chapter-text offsets.
 * Paragraph boundaries always end a sentence: HTML has no sentence concept, and
 * a heading followed by prose must not be read as one breath.
 *
 * Works on a detached copy of the sanitized HTML (the caller passes `safeHtml`),
 * so it never touches the live reading pane — the reader's own offsets stay
 * whatever they were while this runs.
 */
export function chapterSpans(html: string): Span[] {
  const root = chapterHost(html);
  const out: Span[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  let offset = 0;
  let prevBlock: Element | null = null;
  let buf = '';
  let bufStart = 0;
  // Set when a sentence terminator has been seen; the sentence ends at the
  // first character after it that is neither a terminator nor a closing mark,
  // so quotes and brackets stay attached to the sentence they close.
  let sawTerm = false;

  const cut = () => {
    if (buf) pushSegment(out, bufStart, buf);
    buf = '';
    sawTerm = false;
  };

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent || '';
    if (!text) continue;
    const block = nearestBlock(node, root);
    if (prevBlock !== null && block !== prevBlock) cut();
    prevBlock = block;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\n' || ch === '\r') {
        cut();
        continue;
      }
      // The cut happens *before* the new character: "他说：「走吧。」然后…"
      // ends at 」 and the next span starts at 然.
      if (sawTerm && !TERM.test(ch) && !CLOSER.test(ch)) cut();
      if (!buf) bufStart = offset + i;
      buf += ch;
      if (TERM.test(ch)) sawTerm = true;
    }
    offset += text.length;
  }
  cut();
  return out;
}

/** Index of the span containing `offset` — the sentence being read when the
 * reader presses 听 at this position. Falls back to the first span that starts
 * after it (a position in whitespace between sentences). */
export function spanIndexAt(spans: Span[], offset: number): number {
  if (spans.length === 0) return 0;
  let lo = 0;
  let hi = spans.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].end <= offset) lo = mid + 1;
    else if (spans[mid].start > offset) hi = mid - 1;
    else {
      found = mid;
      break;
    }
  }
  if (found >= 0) return found;
  return Math.min(lo, spans.length - 1);
}

/* --------------------------------- engines -------------------------------- */

export type TtsEvent = {
  type: 'ready' | 'start' | 'done' | 'error' | 'idle';
  sid?: string;
  code?: string;
};

export type TtsEngine = 'system' | 'online';

type Sink = (e: TtsEvent) => void;
let sink: Sink | null = null;

/** One global callback fed by every engine; the reader registers it on mount. */
export function setTtsSink(fn: Sink | null) {
  sink = fn;
  const w = window as unknown as { __epubTts?: (e: TtsEvent) => void };
  if (fn) {
    w.__epubTts = (e) => sink?.(e);
  } else {
    // The Android bridge holds this name: leaving a dead closure behind keeps
    // the module (and everything the reader closed over) reachable.
    delete w.__epubTts;
  }
}

/* ---------------------------------- logging ---------------------------------
   The reader wants a trail it can look at after a week of real listening, not a
   measurement session. The engines are the only place that knows how long the
   network took and how much silence there was between sentences, so they report
   it here; where it goes (the on-device log) is the reader's business. */

export type TtsLogLevel = 'debug' | 'info' | 'warn';
export type TtsLogFn = (level: TtsLogLevel, msg: string, detail: string) => void;
let ttsLog: TtsLogFn | null = null;

export function setTtsLogger(fn: TtsLogFn | null) {
  ttsLog = fn;
}

function log(level: TtsLogLevel, msg: string, detail = '') {
  ttsLog?.(level, msg, detail);
}

/** Sentences between summary lines. One line per sentence would bury every
 * other category in a 300-entry ring buffer within ten minutes of listening;
 * the average and the worst case are what a tuning decision needs anyway. */
const LOG_EVERY = 20;
/** A fetch slower than this is worth its own line. */
const SLOW_FETCH_MS = 1500;
/** Silence between two sentences that is long enough to be heard as a stall. */
const SLOW_GAP_MS = 600;

/** The Android bridge, or null in a desktop / browser host. */
export function nativeTts(): {
  prepare(): void;
  speak(sid: string, text: string, rate: number): void;
  clear(): void;
  status(): string;
  voices(): string;
  setVoice(name: string): void;
} | null {
  const w = window as unknown as {
    EpubMakerTts?: { speak?: unknown };
  };
  const t = w.EpubMakerTts;
  return t && typeof t.speak === 'function' ? (t as ReturnType<typeof nativeTts>) : null;
}

/** Whether this host can read aloud at all, and with what. */
export function ttsAvailability(): { system: boolean; web: boolean } {
  const web =
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    // Android's WebView ships the API surface with no voices; asking is the
    // only way to tell, and `getVoices()` is empty there.
    (window.speechSynthesis.getVoices?.().length ?? 0) > 0;
  return { system: !!nativeTts(), web };
}

/** Warm the Android engine up so the first tap does not pay the init cost. */
export function prepareTts(engine: TtsEngine) {
  if (engine === 'system') nativeTts()?.prepare();
}

/* The Web Speech path — desktop only, and the fallback when the Android bridge
   is missing. It reports the same events so the reader needs no second path. */
let webSpeaking: SpeechSynthesisUtterance | null = null;

export function webSpeak(sid: string, text: string, rate: number): boolean {
  if (typeof window === 'undefined' || !window.speechSynthesis) return false;
  try {
    const u = new SpeechSynthesisUtterance(text);
    const zh = window.speechSynthesis.getVoices().find((v) => /^zh/i.test(v.lang));
    if (zh) u.voice = zh;
    u.lang = zh?.lang || 'zh-CN';
    u.rate = rate;
    u.onstart = () => sink?.({ type: 'start', sid });
    u.onend = () => sink?.({ type: 'done', sid });
    u.onerror = () => sink?.({ type: 'error', sid, code: 'web_speech' });
    webSpeaking = u;
    window.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

export function webStop() {
  webSpeaking = null;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* nothing to cancel */
  }
}

/* The online neural voice. A sentence is fetched from Go (base64 mp3), cached
   by content, and played through an <audio> element. Fetching starts the moment
   a sentence is pushed, so the audio is usually ready before the previous one
   ends — that overlap is what makes the reading sound continuous. */
type OnlineFetch = (text: string, voice: string, rate: number) => Promise<string>;

let onlineFetch: OnlineFetch | null = null;

type CachedAudio = { p: Promise<string>; chars: number };
const audioCache = new Map<string, CachedAudio>();
/** Sentences kept. The player prefetches four at a time, so this is several
 * windows deep — enough for a skipped-back sentence to be free, small enough
 * that a 500-chapter book cannot pile up. */
const CACHE_MAX = 24;
/** Characters of base64 kept, about 4 MB. The count cap alone is not a memory
 * bound: one long sentence is a few hundred KB of mp3 as text. */
const CACHE_CHARS = 4 << 20;
let cachedChars = 0;

function audioKey(text: string, voice: string, rate: number) {
  return `${voice}|${rate}|${text}`;
}

/** Bounded by both count and weight, oldest first. Called on insert and again
 * when a payload lands and its real size becomes known. */
function trimAudioCache() {
  for (const [k, v] of audioCache) {
    if (audioCache.size <= CACHE_MAX && cachedChars <= CACHE_CHARS) break;
    audioCache.delete(k);
    cachedChars -= v.chars;
  }
  if (cachedChars < 0) cachedChars = 0;
}

export function setOnlineFetcher(fn: OnlineFetch | null) {
  onlineFetch = fn;
  // A closed session's audio is dead weight — and on a phone it is megabytes.
  if (!fn) {
    audioCache.clear();
    cachedChars = 0;
  }
}

function fetchAudio(text: string, voice: string, rate: number): Promise<string> {
  const key = audioKey(text, voice, rate);
  const hit = audioCache.get(key);
  if (hit) return hit.p;
  if (!onlineFetch) return Promise.reject(new Error('no fetcher'));
  const entry: CachedAudio = { p: onlineFetch(text, voice, rate), chars: 0 };
  audioCache.set(key, entry);
  entry.p.then(
    (url) => {
      // Weighed once the payload exists: a promise is not what fills the heap.
      if (audioCache.get(key) !== entry) return;
      entry.chars = url.length;
      cachedChars += url.length;
      trimAudioCache();
    },
    () => {
      // A failed sentence must not be remembered as a failure.
      if (audioCache.get(key) === entry) {
        audioCache.delete(key);
        cachedChars -= entry.chars;
      }
    },
  );
  trimAudioCache();
  return entry.p;
}

/** Sequential online player: one <audio> at a time, prefetching ahead. */
export class OnlinePlayer {
  private queue: { sid: string; text: string }[] = [];
  private running = false;
  private stopped = false;
  /** The one element this player ever owns. A data-URL src holds the whole mp3
   * in memory and the element owns a decoder; `new Audio()` per sentence left
   * one behind each time and a long session grew by tens of MB. Re-sourcing
   * one element keeps exactly one decoder alive. */
  private el: HTMLAudioElement | null = null;
  /** Settles the sentence in flight. `stop()` has to call it: pausing an
   * element whose `play()` already resolved leaves the awaited promise pending
   * forever, and that suspended pump frame keeps the player (and its audio)
   * reachable for the rest of the session. */
  private settle: (() => void) | null = null;
  private lastEnd = 0;
  private stat = { n: 0, fetchSum: 0, fetchMax: 0, gapSum: 0, gapN: 0, gapMax: 0 };

  constructor(
    private voice: string,
    private rate: number,
  ) {}

  push(sid: string, text: string) {
    if (this.stopped) return;
    this.queue.push({ sid, text });
    // Prefetch now: the network is the slow part, not the playback.
    void fetchAudio(text, this.voice, this.rate).catch(() => {});
    void this.pump();
  }

  private async pump() {
    if (this.running || this.stopped) return;
    this.running = true;
    // Two failures in a row means the network or the voice is gone, not a
    // single hiccup. Walking the rest of the queue would then emit one error
    // per sentence — a toast storm that fixes nothing, so the player gives up
    // after the second miss and the reader tells the user once.
    let misses = 0;
    while (this.queue.length > 0 && !this.stopped) {
      const item = this.queue.shift()!;
      const hit = audioCache.has(audioKey(item.text, this.voice, this.rate));
      const t0 = Date.now();
      let url: string;
      try {
        url = await fetchAudio(item.text, this.voice, this.rate);
      } catch {
        if (++misses >= 2) {
          this.stop();
          sink?.({ type: 'error', sid: item.sid, code: 'online_failed' });
          break;
        }
        continue;
      }
      const fetchMs = Date.now() - t0;
      misses = 0;
      if (this.stopped) break;
      // Silence the reader actually hears: from the end of the previous
      // sentence to the moment this one can start.
      const gap = this.lastEnd ? Date.now() - this.lastEnd : -1;
      const t1 = Date.now();
      try {
        await this.play(url, item.sid);
      } catch {
        sink?.({ type: 'error', sid: item.sid, code: 'online_playback' });
        continue;
      }
      if (this.stopped) break;
      this.lastEnd = Date.now();
      this.record(item, fetchMs, hit, gap, this.lastEnd - t1);
      sink?.({ type: 'done', sid: item.sid });
    }
    this.running = false;
    if (!this.stopped && this.queue.length === 0) sink?.({ type: 'idle' });
  }

  /** Per-sentence numbers, kept quiet unless something was wrong; a rolling
   * average every LOG_EVERY sentences is what a later tuning pass reads. */
  private record(
    item: { sid: string; text: string },
    fetchMs: number,
    hit: boolean,
    gap: number,
    playMs: number,
  ) {
    const s = this.stat;
    s.n += 1;
    s.fetchSum += fetchMs;
    s.fetchMax = Math.max(s.fetchMax, fetchMs);
    if (gap > 0) {
      s.gapSum += gap;
      s.gapN += 1;
      s.gapMax = Math.max(s.gapMax, gap);
    }
    const tail = `取音 ${Math.round(fetchMs)}ms${hit ? '(缓存)' : ''} 静默 ${Math.max(0, Math.round(gap))}ms 播放 ${Math.round(playMs)}ms`;
    if (fetchMs >= SLOW_FETCH_MS) {
      log('debug', '在线取音偏慢', `句 ${item.sid} ${item.text.length}字 ${tail}`);
    } else if (gap >= SLOW_GAP_MS) {
      log('debug', '句间停顿偏长', `句 ${item.sid} ${item.text.length}字 ${tail}`);
    }
    if (s.n % LOG_EVERY === 0) this.summary();
  }

  private summary() {
    const s = this.stat;
    if (s.n === 0) return;
    log(
      'debug',
      '在线朗读统计',
      `${s.n} 句 · 取音 均 ${Math.round(s.fetchSum / s.n)}ms 最慢 ${Math.round(s.fetchMax)}ms` +
        ` · 静默 均 ${s.gapN ? Math.round(s.gapSum / s.gapN) : 0}ms 最长 ${Math.round(s.gapMax)}ms`,
    );
  }

  private play(url: string, sid: string): Promise<void> {
    if (!this.el) {
      this.el = new Audio();
      this.el.preload = 'auto';
    }
    const a = this.el;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.settle = null;
        a.onended = null;
        a.onerror = null;
        if (err) reject(err);
        else resolve();
      };
      this.settle = () => finish();
      a.onended = () => finish();
      a.onerror = () => finish(new Error('audio'));
      sink?.({ type: 'start', sid });
      a.src = url;
      a.play().catch((e) => finish(e instanceof Error ? e : new Error('play')));
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.queue = [];
    this.summary();
    this.settle?.();
    this.settle = null;
    const a = this.el;
    if (a) {
      a.pause();
      // Let go of the mp3 behind the data URL. Without this the element holds
      // the last sentence's audio until the player itself is collected.
      a.removeAttribute('src');
      a.load();
    }
  }
}
