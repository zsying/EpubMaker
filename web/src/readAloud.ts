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

/** Sentence-final marks. 「…」 counts double: it is how Chinese prose ends. */
const TERM = /[。！？!?…；;]/;
/** Marks that belong to the sentence they follow, not to the next one. */
const CLOSER = /["'”’）)」』】》〉]/;
/** A long paragraph is cut here before it becomes an unreadable mouthful. */
const SOFT = /[，、,:：]/;

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

  const cut = () => {
    if (buf) pushSegment(out, bufStart, buf);
    buf = '';
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
      if (!buf) bufStart = offset + i;
      buf += ch;
      const next = text[i + 1];
      // Cut after a terminator (or a closing quote after one) only when the
      // sentence really ends: "他说：「走吧。」" ends at 」, not at 。.
      if ((TERM.test(ch) || CLOSER.test(ch)) && !(next && (TERM.test(next) || CLOSER.test(next)))) {
        cut();
      }
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
  }
}

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
const audioCache = new Map<string, Promise<string>>();
const CACHE_MAX = 60;

export function setOnlineFetcher(fn: OnlineFetch | null) {
  onlineFetch = fn;
}

function fetchAudio(text: string, voice: string, rate: number): Promise<string> {
  const key = `${voice}|${rate}|${text}`;
  const hit = audioCache.get(key);
  if (hit) return hit;
  if (!onlineFetch) return Promise.reject(new Error('no fetcher'));
  const p = onlineFetch(text, voice, rate);
  audioCache.set(key, p);
  // A failed sentence must not be remembered as a failure.
  p.catch(() => audioCache.delete(key));
  if (audioCache.size > CACHE_MAX) {
    const oldest = audioCache.keys().next().value;
    if (oldest !== undefined) audioCache.delete(oldest);
  }
  return p;
}

/** Sequential online player: one <audio> at a time, prefetching ahead. */
export class OnlinePlayer {
  private queue: { sid: string; text: string }[] = [];
  private running = false;
  private stopped = false;
  private audio: HTMLAudioElement | null = null;
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
      misses = 0;
      if (this.stopped) break;
      try {
        await this.play(url, item.sid);
      } catch {
        sink?.({ type: 'error', sid: item.sid, code: 'online_playback' });
        continue;
      }
      sink?.({ type: 'done', sid: item.sid });
    }
    this.running = false;
    if (!this.stopped && this.queue.length === 0) sink?.({ type: 'idle' });
  }

  private play(url: string, sid: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const a = new Audio(url);
      this.audio = a;
      a.onended = () => {
        this.audio = null;
        resolve();
      };
      a.onerror = () => {
        this.audio = null;
        reject(new Error('audio'));
      };
      sink?.({ type: 'start', sid });
      a.play().catch(reject);
    });
  }

  stop() {
    this.stopped = true;
    this.queue = [];
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
  }
}
