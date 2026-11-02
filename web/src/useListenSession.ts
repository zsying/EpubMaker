import { useEffect, useRef, useState, type RefObject } from 'react';
import { api } from './api';
import type { Chapter } from './api';
import { textNodeAt } from './sentence';
import { toast } from './toast';
import {
  chapterSpans,
  nativeTts,
  OnlinePlayer,
  prepareTts,
  publishNowPlaying,
  setListenCommandHandler,
  setOnlineFetcher,
  setTtsLogger,
  setTtsSink,
  spanIndexAt,
  ttsAvailability,
  webSpeak,
  webStop,
  type ListenCommand,
  type NowPlaying,
  type Span,
  type TtsEngine,
  type TtsEvent,
} from './readAloud';
import type { AppTheme, ReadMode } from './readingPrefs';

// 听书 — the session that reads a chapter aloud, one sentence at a time.
//
// It owns a queue position and nothing else about the book: which sentence is
// speaking, which engine is speaking it, whether the page still follows the
// voice. Everything it needs from the reader arrives as an argument — the DOM
// to measure, the paged geometry to turn, the neighbour to read into — so a
// change here cannot quietly reach into a chapter, and a change to a chapter
// cannot quietly re-time the voice.
//
// The two directions are deliberately asymmetric. The reader CALLS into this
// hook (start, stop, jump, and the two follow switches the gesture needs). This
// hook calls back out through `openChapter` and `setPageIndex` only: it moves
// the page, it does not lay one out — the same line ADR-45 drew for the gesture.
//
// Why it is not in Reader.tsx: 615 lines of queue management, three engines,
// a media notification and a settings sheet sat between the chapter loader and
// the page turn, and every one of the twelve effects below had to be judged
// against two thousand lines of reading logic. ADR-46 split out the code that
// never touches the book; this is the first part that does touch it, and pays
// for the move with an explicit interface (ADR-47).

/** How many sentences may be queued ahead of the one being spoken. Four is
 * roughly 15-25 seconds of speech: enough to cover a slow network fetch of the
 * online voice, short enough that skipping forward feels immediate. */
const LISTEN_WINDOW = 4;

const LISTEN_RATE_KEY = 'epubmaker.listen.rate';
const LISTEN_ENGINE_KEY = 'epubmaker.listen.engine';
const LISTEN_VOICE_KEY = 'epubmaker.listen.voice';

/** The rates the bar cycles through. 0.75 for a hard passage, 2 for skimming. */
export const LISTEN_RATES = [0.75, 1, 1.25, 1.5, 2];

/** What the phone's media widget is told when there is no session. Sending it
 * is how the notification is taken down; the host does not guess. */
export const INACTIVE_NOW_PLAYING: NowPlaying = {
  active: false,
  playing: false,
  title: '',
  artist: '',
  canPrev: false,
  canNext: false,
};

/** 听书 goes into the on-device log under its own category, so a week of real
 * listening is a record the reader can scroll back through — the numbers a
 * tuning decision needs (how slow a fetch was, how long the silence between
 * sentences) are not guessable after the fact. Fire and forget: a log write
 * must never be a reason for the reading to stutter or fail. */
function ttsLog(level: 'debug' | 'info' | 'warn', msg: string, detail = '') {
  void api.logClient(level, 'tts', msg, detail).catch(() => {});
}

type ListenState = {
  playing: boolean;
  /** Sentence being spoken right now. */
  index: number;
  engine: TtsEngine;
  rate: number;
  voice: string;
};

/** What a chapter open was asked to do. Structurally the reader's `PageIntent`;
 *  declared here so the hook does not import the page it lives beside. */
type OpenIntent = { type: 'first' | 'last' | 'restore'; offset?: number; cid?: string };

/** A box on screen, painted under the sentence being spoken. */
type MarkBox = { left: number; top: number; width: number; height: number };

export type ListenSessionArgs = {
  /** The chapter as rendered — the span list is extracted from it. */
  html: string;
  /** The chapter's text container: the band is measured against its nodes. */
  contentRef: RefObject<HTMLDivElement>;
  /** The visible page box: rects outside it belong to another column. */
  stageRef: RefObject<HTMLDivElement>;
  /** The scroll container (scroll mode reveals the sentence inside it). */
  mainRef: RefObject<HTMLDivElement>;
  mode: ReadMode;
  pageIndex: number;
  setPageIndex: (i: number) => void;
  /** Which page a character offset is on, in the current layout. */
  pageIndexForOffset: (offset: number) => number;
  /** Where the current page starts, in character offsets. */
  offsetForPage: (page: number) => number;
  /** Where the scroll viewport starts, in character offsets. */
  offsetAtViewportTop: () => number;
  /** Read into the neighbouring chapter at a boundary. */
  openChapter: (cid: string, intent?: OpenIntent | null) => void;
  next: Chapter | null;
  prev: Chapter | null;
  /** Named in the on-device log, which is how a tuning decision is read back. */
  chapterTitle: string;
  /** Geometry: the band has to be re-measured when any of these reflow the
   *  page under it. */
  fontSize: number;
  fontEpoch: number;
  theme: AppTheme;
};

export function useListenSession(args: ListenSessionArgs) {
  const {
    html,
    contentRef,
    stageRef,
    mainRef,
    mode,
    pageIndex,
    setPageIndex,
    pageIndexForOffset,
    offsetForPage,
    offsetAtViewportTop,
    openChapter,
    next,
    prev,
    chapterTitle,
    fontSize,
    fontEpoch,
    theme,
  } = args;

  /* ---- the session ---- */
  const [listen, setListen] = useState<ListenState | null>(null);
  // Rectangles of the sentence being spoken, painted by a fixed layer above the
  // page. Never spans injected into the text: the chapter DOM belongs to React.
  const [listenMarks, setListenMarks] = useState<MarkBox[]>([]);
  const [listenSheet, setListenSheet] = useState(false);
  // Whether the page still follows the voice. A manual turn says "I want to
  // look over here": the reading must not drag the page back a second later,
  // which is exactly what it did — every sentence start re-paged, so a swipe
  // looked like it had never happened. The bar keeps the way home.
  const [following, setFollowing] = useState(true);
  const followRef = useRef(true);
  /** When the reader's own code last scrolled the text (following the voice,
   * restoring a position). A scroll inside this window is ours, not a signal
   * that the reader went somewhere else. */
  const autoScrollAtRef = useRef(0);
  const [edgeVoices, setEdgeVoices] = useState<Array<{ name: string; label: string }>>([]);
  // Preferences outlive the session; the session snapshots them when it starts
  // so changing the rate mid-chapter is an explicit action, not a side effect.
  const [listenRate, setListenRate] = useState<number>(() => {
    const v = Number(localStorage.getItem(LISTEN_RATE_KEY));
    return LISTEN_RATES.includes(v) ? v : 1;
  });
  const [listenEngine, setListenEngine] = useState<TtsEngine>(() =>
    localStorage.getItem(LISTEN_ENGINE_KEY) === 'online' ? 'online' : 'system',
  );
  const [listenVoice, setListenVoice] = useState<string>(
    () => localStorage.getItem(LISTEN_VOICE_KEY) || 'zh-CN-XiaoxiaoNeural',
  );
  // The engine calls back from outside React, so the handler is reached through
  // a ref that every render refreshes — the alternative is a closure that
  // speaks from a chapter two pages old.
  const listenRef = useRef<ListenState | null>(null);
  listenRef.current = listen;
  const spansRef = useRef<Span[]>([]);
  const pushedRef = useRef(0);
  const onlineRef = useRef<OnlinePlayer | null>(null);
  const listenHandlerRef = useRef<(e: TtsEvent) => void>(() => {});
  // Same trick for the notification's buttons: they arrive on a channel the
  // host owns, installed once, and must reach the session as it is *now*.
  const listenCmdRef = useRef<(c: ListenCommand) => void>(() => {});
  /** The last now-playing record handed to the host, as JSON. Publishing is a
   * side effect with a real cost on the phone (a notification rebuild), and the
   * session object is recreated on every sentence — so equality is judged on
   * what the widget actually shows, not on the object identity. */
  const nowPlayingRef = useRef('');

  /* ---- 听书: the session ------------------------------------------------ */

  function listenVoiceLabel(): string {
    return edgeVoices?.find((v) => v.name === listenVoice)?.label || '在线音色';
  }

  /** The reader took the page into their own hands. Reading carries on; the
   * page and the band stop chasing the voice until the reader asks for them
   * back. Without this every sentence start re-paged the reader a second after
   * a swipe, so a manual turn looked like it had been ignored. */
  function pauseFollow() {
    if (!listenRef.current || !followRef.current) return;
    followRef.current = false;
    setFollowing(false);
    setListenMarks([]);
    ttsLog('debug', '手动翻页，暂停跟随', `第 ${(listenRef.current.index || 0) + 1} 句`);
  }

  /** Back to where the voice is, and follow it again from here. */
  function resumeFollow() {
    followRef.current = true;
    setFollowing(true);
    const L = listenRef.current;
    if (L) showListenSpan(L.index);
  }

  /** Silences every engine at once. Called before any restart, so a sentence is
   * never read twice by two engines that both think they are in charge. */
  function clearListenEngine() {
    nativeTts()?.clear();
    onlineRef.current?.stop();
    onlineRef.current = null;
    webStop();
  }

  function pushSpan(i: number, L: ListenState) {
    const span = spansRef.current[i];
    if (!span) return;
    const sid = String(i);
    if (L.engine === 'online') {
      if (!onlineRef.current) onlineRef.current = new OnlinePlayer(L.voice, L.rate);
      onlineRef.current.push(sid, span.text);
      return;
    }
    const native = nativeTts();
    if (native) {
      native.speak(sid, span.text, L.rate);
      return;
    }
    // Desktop: Web Speech is the engine, and the only one that needs no bridge.
    if (!webSpeak(sid, span.text, L.rate)) {
      toast('这台设备没有可用的朗读引擎', 'error');
      stopListen();
    }
  }

  /** Keeps the engine fed, starting at sentence `from`.
   *
   * The window is engine-shaped on purpose. The system engine queues inside
   * Android, where the queue keeps playing with the screen off and JS frozen —
   * so it gets the whole rest of the chapter, and the reading does not stop at
   * the fourth sentence after the phone goes dark. The online voice is fetched
   * per sentence over the network: handing it a whole chapter would mean 40
   * simultaneous requests and no chance to cancel them, so it stays a window. */
  function pumpListen(from: number) {
    const L = listenRef.current;
    if (!L) return;
    const spans = spansRef.current;
    const limit = L.engine === 'system' ? spans.length : from + LISTEN_WINDOW;
    while (pushedRef.current < spans.length && pushedRef.current < limit) {
      pushSpan(pushedRef.current, L);
      pushedRef.current += 1;
    }
  }

  /** On-screen boxes for one sentence, filtered to what is actually visible:
   * the paged strip holds the whole chapter, so an off-page column has real
   * coordinates that would paint the band somewhere off the paper. */
  function spanRects(span: Span): DOMRect[] {
    const root = contentRef.current;
    if (!root) return [];
    const a = textNodeAt(root, span.start);
    const b = textNodeAt(root, Math.max(span.start, span.end - 1));
    if (!a || !b) return [];
    const range = document.createRange();
    range.setStart(a.node, Math.min(a.offset, (a.node.textContent || '').length));
    range.setEnd(b.node, Math.min(b.offset + 1, (b.node.textContent || '').length));
    const view = stageRef.current?.getBoundingClientRect();
    return Array.from(range.getClientRects()).filter((r) => {
      if (r.width < 2 || r.height < 2) return false;
      if (!view) return true;
      return (
        r.right > view.left && r.left < view.right && r.bottom > view.top && r.top < view.bottom
      );
    });
  }

  function paintListen(span: Span) {
    setListenMarks(
      spanRects(span).map((r) => ({
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      })),
    );
  }

  /** Scroll mode has no pages: bring the sentence into view when the reading
   * walks past the bottom of the screen, and leave it alone otherwise (a jump
   * every sentence would feel like the page is being dragged). */
  function revealSpan(span: Span) {
    const scroller = mainRef.current;
    if (!scroller) return;
    const rects = spanRects(span);
    if (rects.length === 0) return;
    const box = scroller.getBoundingClientRect();
    const top = rects[0].top;
    const bottom = rects[rects.length - 1].bottom;
    if (top >= box.top + 24 && bottom <= box.bottom - 24) return;
    // Tell the scroll listener this one is ours, so following the voice does
    // not read as the reader scrolling away.
    autoScrollAtRef.current = Date.now();
    scroller.scrollTo({
      top: scroller.scrollTop + (top - box.top) - box.height / 3,
      behavior: 'smooth',
    });
  }

  /** Puts the sentence on screen: turns the page if it lives on another one,
   * then paints the band once the layout has settled. Both frames test that the
   * session is still alive first — a stop that lands inside the two frames would
   * otherwise be followed by a repaint, leaving a band on the page with nothing
   * left to clear it.
   *
   * Does nothing at all once the reader has turned away: their page is theirs
   * until they ask for the voice's again. */
  function showListenSpan(i: number) {
    if (!followRef.current) return;
    const span = spansRef.current[i];
    if (!span) return;
    if (mode === 'paged') {
      const target = pageIndexForOffset(span.start);
      if (target !== pageIndex) setPageIndex(target);
      // Two frames: the first lets the strip move, the second measures it.
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => {
          if (listenRef.current) paintListen(span);
        }),
      );
      return;
    }
    window.requestAnimationFrame(() => {
      if (!listenRef.current) return;
      revealSpan(span);
      paintListen(span);
    });
  }

  /** Starts (or restarts) a session at `fromOffset` — the current page, a
   * selection, or the beginning of a chapter that was just opened. */
  function startListen(fromOffset?: number) {
    const avail = ttsAvailability();
    // The online voice is fetched by the backend and played by an <audio>
    // element, so it needs neither the phone's engine nor Web Speech: only the
    // local engines have to prove they exist.
    if (listenEngine !== 'online' && !avail.system && !avail.web) {
      toast('这台设备没有可用的朗读引擎', 'error');
      return;
    }
    const spans = chapterSpans(html);
    if (spans.length === 0) {
      toast('这一章没有可朗读的文字', 'info');
      return;
    }
    const base =
      fromOffset !== undefined
        ? fromOffset
        : mode === 'paged'
          ? offsetForPage(pageIndex)
          : offsetAtViewportTop();
    const at = spanIndexAt(spans, base);
    clearListenEngine();
    spansRef.current = spans;
    pushedRef.current = at;
    followRef.current = true;
    setFollowing(true);
    const L: ListenState = {
      playing: true,
      index: at,
      engine: listenEngine,
      rate: listenRate,
      voice: listenVoice,
    };
    listenRef.current = L;
    setListen(L);
    prepareTts(L.engine);
    pumpListen(at);
    showListenSpan(at);
    ttsLog(
      'info',
      '开始朗读',
      `${chapterTitle} · 第 ${at + 1}/${spans.length} 句 · ` +
        `引擎 ${L.engine === 'online' ? `在线 ${listenVoiceLabel()}` : '系统'} · 语速 ${L.rate}×`,
    );
  }

  function stopListen() {
    const L = listenRef.current;
    if (L) ttsLog('info', '退出听书', `停在第 ${L.index + 1} 句`);
    clearListenEngine();
    listenRef.current = null;
    setListen(null);
    setListenMarks([]);
    setListenSheet(false);
    followRef.current = true;
    setFollowing(true);
  }

  /** Play / pause. Pausing keeps the position: the bar stays, and pressing play
   * again re-reads the sentence that was interrupted. */
  function toggleListen() {
    const L = listenRef.current;
    if (!L) {
      startListen();
      return;
    }
    if (L.playing) {
      clearListenEngine();
      const paused = { ...L, playing: false };
      listenRef.current = paused;
      setListen(paused);
      ttsLog('info', '暂停朗读', `第 ${L.index + 1} 句`);
      return;
    }
    const resumed = { ...L, playing: true };
    listenRef.current = resumed;
    setListen(resumed);
    pushedRef.current = L.index;
    // Pressing play is a request to listen, not to look at the page the reader
    // left behind: follow the voice again from here.
    followRef.current = true;
    setFollowing(true);
    pumpListen(L.index);
    ttsLog('info', '继续朗读', `第 ${L.index + 1} 句`);
  }

  function jumpListen(delta: number) {
    const L = listenRef.current;
    if (!L) return;
    const total = spansRef.current.length;
    const at = L.index + delta;
    // Past either end of the chapter, the voice walks into the neighbouring
    // one — the same thing 听书 already does on its own when a chapter runs out.
    // Going back lands on the previous chapter's first sentence rather than its
    // last: the reader asked for "the previous one", and a chapter is the unit
    // they can see.
    if (at < 0 || at >= total) {
      const target = at < 0 ? prev : next;
      if (!target) return;
      ttsLog('info', at < 0 ? '上一章' : '下一章', target.title);
      openChapter(target.id, { type: 'first' });
      return;
    }
    clearListenEngine();
    const s = { ...L, index: at, playing: true };
    listenRef.current = s;
    setListen(s);
    pushedRef.current = at;
    // 上一句/下一句 are explicit moves along the voice's own path, so they take
    // the page back with them.
    followRef.current = true;
    setFollowing(true);
    pumpListen(at);
    showListenSpan(at);
    ttsLog('debug', delta > 0 ? '下一句' : '上一句', `第 ${at + 1}/${spansRef.current.length} 句`);
  }

  /** A button on the media notification / lock screen / headset. The host has
   * no idea where the voice is — it only knows which button was pressed — so
   * every one of these is routed into the same handlers the bar uses. */
  function onListenCommand(cmd: ListenCommand) {
    const L = listenRef.current;
    if (cmd === 'toggle') {
      toggleListen();
      return;
    }
    if (cmd === 'stop') {
      if (L) stopListen();
      return;
    }
    // Skipping with no session at all is a request to listen, not a no-op: the
    // widget can outlive a reader that was rebuilt under it.
    if (!L) {
      startListen();
      return;
    }
    jumpListen(cmd === 'next' ? 1 : -1);
  }

  function changeListenRate() {
    const i = LISTEN_RATES.indexOf(listenRate);
    setListenRateTo(LISTEN_RATES[(i + 1) % LISTEN_RATES.length]);
  }

  function setListenRateTo(rate: number) {
    setListenRate(rate);
    localStorage.setItem(LISTEN_RATE_KEY, String(rate));
    const L = listenRef.current;
    if (!L) return;
    ttsLog('info', '调整语速', `${L.rate}× → ${rate}×`);
    // The platform applies the rate per utterance, so the current sentence has
    // to start over for the change to be audible now.
    const s = { ...L, rate };
    listenRef.current = s;
    setListen(s);
    if (!L.playing) return;
    clearListenEngine();
    pushedRef.current = L.index;
    pumpListen(L.index);
  }

  function switchListenEngine(engine: TtsEngine) {
    setListenEngine(engine);
    localStorage.setItem(LISTEN_ENGINE_KEY, engine);
    const L = listenRef.current;
    if (!L) return;
    ttsLog(
      'info',
      '切换朗读引擎',
      `${L.engine === 'online' ? '在线' : '系统'} → ${engine === 'online' ? '在线' : '系统'}`,
    );
    const s = { ...L, engine };
    listenRef.current = s;
    setListen(s);
    clearListenEngine();
    prepareTts(engine);
    pushedRef.current = L.index;
    if (L.playing) pumpListen(L.index);
  }

  function switchListenVoice(voice: string) {
    setListenVoice(voice);
    localStorage.setItem(LISTEN_VOICE_KEY, voice);
    const L = listenRef.current;
    if (!L) return;
    ttsLog('info', '切换音色', voice);
    const s = { ...L, voice };
    listenRef.current = s;
    setListen(s);
    clearListenEngine();
    pushedRef.current = L.index;
    if (L.playing) pumpListen(L.index);
  }

  /** Everything the engines report comes through here. Deliberately does not
   * advance on `done`: the next sentence's `start` is what moves the page, so
   * a paused or cleared queue cannot turn pages behind the reader's back. */
  function onTtsEvent(e: TtsEvent) {
    const L = listenRef.current;
    if (!L) return;
    if (e.type === 'start' && e.sid) {
      const i = Number(e.sid);
      if (!Number.isFinite(i) || i < 0 || i >= spansRef.current.length) return;
      if (i !== L.index || !L.playing) {
        const s = { ...L, index: i, playing: true };
        listenRef.current = s;
        setListen(s);
      }
      showListenSpan(i);
      pumpListen(i);
      return;
    }
    if (e.type === 'idle') {
      if (e.code === 'clear' || e.code === 'shutdown') return;
      if (e.code === 'focus_lost') {
        // A call or another player took the audio: pause rather than talk over it.
        const s = { ...L, playing: false };
        listenRef.current = s;
        setListen(s);
        return;
      }
      if (pushedRef.current < spansRef.current.length) {
        pumpListen(L.index);
        return;
      }
      // The chapter is finished: read on into the next one, which is the whole
      // point of 听书 — the reader should not have to turn a page every minute.
      // A chapter boundary is also where following resumes: the book moved on
      // under the reader, and there is no page of the old chapter left to hold.
      if (next) {
        followRef.current = true;
        setFollowing(true);
        ttsLog('info', '本章读完，接着读下一章', next.title);
        openChapter(next.id, { type: 'first' });
        return;
      }
      toast('全书已读完', 'success');
      ttsLog('info', '全书读完', '');
      stopListen();
      return;
    }
    if (e.type === 'error') {
      const code = e.code || '';
      ttsLog('warn', '朗读失败', `${code} · 第 ${L.index + 1} 句`);
      if (code === 'no_zh_voice') {
        toast('手机上没有中文语音，请先在系统设置里安装中文朗读引擎', 'error');
        stopListen();
        return;
      }
      if (code === 'init_failed') {
        toast('朗读引擎启动失败', 'error');
        stopListen();
        return;
      }
      if (code === 'online_failed' || code === 'online_playback') {
        // The player has already given up by the time this arrives, so there is
        // nothing left to fight: pause, drop the engine, and say it once.
        toast('在线音色请求失败，可在听书设置里换回系统引擎', 'error');
        const s = { ...L, playing: false };
        listenRef.current = s;
        setListen(s);
        clearListenEngine();
        return;
      }
      // A single failed sentence is not a reason to stop: ask for the next one.
      pumpListen(pushedRef.current);
    }
  }

  /* ---- 听书: wiring ----------------------------------------------------- */

  // The engines call back from outside React; the handler is refreshed every
  // render so it always speaks for the chapter on screen.
  listenHandlerRef.current = onTtsEvent;
  // Same for the notification's buttons.
  listenCmdRef.current = onListenCommand;

  useEffect(() => {
    setTtsSink((e) => listenHandlerRef.current(e));
    // The media notification's buttons come back through this channel.
    setListenCommandHandler((c) => listenCmdRef.current(c));
    // The engines' own timing goes to the on-device log: after a week of real
    // listening it is the record a tuning decision is made from.
    setTtsLogger((level, msg, detail) => ttsLog(level, msg, detail));
    // The online voice is fetched one sentence at a time and handed back as a
    // data URL: an <audio> element plays it with no CORS and no second server.
    setOnlineFetcher(async (text, voice, rate) => {
      const b64 = await api.ttsEdge(text, voice, rate);
      return `data:audio/mpeg;base64,${b64}`;
    });
    return () => {
      setTtsSink(null);
      setListenCommandHandler(null);
      setTtsLogger(null);
      setOnlineFetcher(null);
      clearListenEngine();
      // Leaving the reader ends the session, so the widget goes with it.
      publishNowPlaying(INACTIVE_NOW_PLAYING);
      nowPlayingRef.current = JSON.stringify(INACTIVE_NOW_PLAYING);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What the phone's media notification shows lives below, next to
  // `currentChapter`: the widget's title *is* the chapter, and a TDZ reference
  // is not worth the shrug.

  // A new chapter means a new span list. Reading continues from its beginning —
  // that is also how an automatic chapter turn hands over to the next chapter
  // without the engine ever going quiet for long.
  useEffect(() => {
    const L = listenRef.current;
    if (!L) return;
    const spans = chapterSpans(html);
    if (spans.length === 0) return;
    spansRef.current = spans;
    pushedRef.current = 0;
    // A new chapter is a new place: the reader's detour, if there was one, is
    // over and the page follows the voice again.
    followRef.current = true;
    setFollowing(true);
    const s = { ...L, index: 0 };
    listenRef.current = s;
    setListen(s);
    pumpListen(0);
    showListenSpan(0);
    ttsLog('debug', '换章朗读', `${spans.length} 句`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  // The band is geometry, so it has to be re-measured whenever the page it was
  // measured on changed underneath it.
  useEffect(() => {
    const L = listenRef.current;
    // Not while the reader is away: a page turn of theirs must not bring a band
    // back for a sentence they are not looking at.
    if (!L || !followRef.current) return;
    const span = spansRef.current[L.index];
    if (!span) return;
    const raf = window.requestAnimationFrame(() => {
      // Re-checked inside the frame: closing the bar between the effect and the
      // frame must not resurrect the band.
      if (listenRef.current && followRef.current) paintListen(span);
    });
    return () => window.cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, mode, fontSize, fontEpoch, theme]);

  // The online voice list is needed by the settings sheet — and by the bar,
  // which names the voice it is using. Not fetched on a reading session that
  // never listens.
  const needsVoices = listenSheet || listen?.engine === 'online';
  useEffect(() => {
    if (!needsVoices || edgeVoices.length > 0) return;
    api
      .edgeVoices()
      // A backend that answers null (older build, failed call) must not take
      // the reader down with it: the list is a picker, not a dependency.
      .then((list) => setEdgeVoices(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, [needsVoices, edgeVoices.length]);

  /** The reader is about to scroll the text itself (restoring a position,
   *  landing a preview). Without this the follow would read our own jump as the
   *  reader turning away and stop chasing the voice. */
  function noteOwnScroll() {
    autoScrollAtRef.current = Date.now();
  }

  /** True while a scroll of OURS is still fresh — the voice revealing the
   *  sentence, or a position being restored. The reader scrolling is what takes
   *  the page away from the voice; our own reveal is not, and counting it as
   *  such would stop the follow the first time the voice brought a paragraph
   *  into view. Kept as a question rather than the raw timestamp so the caller
   *  does not have to know the window twice. */
  function recentScrollWasOurs(): boolean {
    return Date.now() - autoScrollAtRef.current <= 700;
  }

  return {
    // The session, and everything the surfaces hang off it.
    listen,
    listenMarks,
    listenSheet,
    setListenSheet,
    following,
    edgeVoices,
    listenRate,
    listenEngine,
    listenVoice,
    /** The span list of the chapter being read: the media widget needs its
     *  length to know whether "next" means a sentence or a chapter. */
    spansRef,
    /** Last now-playing record handed to the host, as JSON (dedupe). */
    nowPlayingRef,

    // The bar's actions.
    startListen,
    stopListen,
    toggleListen,
    jumpListen,
    /** The reader took the page: reading goes on, the page stops chasing. */
    pauseFollow,
    resumeFollow,
    /** Asked by scroll mode's listener: was that scroll the voice's own? */
    recentScrollWasOurs,
    /** Told when the reader scrolls the text on the session's behalf. */
    noteOwnScroll,

    // The settings sheet's actions.
    listenVoiceLabel,
    changeListenRate,
    setListenRateTo,
    switchListenEngine,
    switchListenVoice,
  };
}
