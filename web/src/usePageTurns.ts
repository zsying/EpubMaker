import {
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { Chapter } from './api';
import { prefersReducedMotion } from './device';
import {
  turnLevelFactor,
  turnThresholds,
  type ReadMode,
  type TurnSensitivity,
} from './readingPrefs';

// A page turn the finger is holding. `follow` is the drag itself — the page
// sits exactly where the thumb has dragged it; `settle` is the release, where
// the same slide carries it to whichever end the gesture earned.
export type TurnDrag = { dir: 1 | -1; phase: 'follow' | 'settle' };

/** The neighbouring chapter's page, laid out one spread off-screen (TurnPeek). */
export type PagePeek = { cid: string; side: 1 | -1; html: string };

/**
 * Page turning: the turn the finger owns, and the ways it ends.
 *
 * What lives here is the part of the reader that has to stay in step with a
 * finger at 60Hz — the drag, the ribbon pulled out of the page's top edge, the
 * long press that builds a one-word selection, the release that decides between
 * going on and going back. What does NOT live here is what any of it MEANS: a
 * tap is routed by the reader (`onTap`), a chapter is opened by the reader
 * (`onOpenChapter`), a word is selected by the reader (`onSelectWord`). That
 * split is the point of the hook. The gesture is a state machine over touch
 * events; the meaning of the gesture is a policy about this book, and the two
 * change for different reasons.
 *
 * Two rules hold the whole thing together, both of them hard-won (ADR-43):
 *
 *  * The page is written straight to the DOM. `.reader-drag` is moved by
 *    `style.transform` on every touchmove, never through state — a page turn
 *    must not cost a re-render of the reader tree per frame.
 *  * The listeners are registered per chapter, and read everything else
 *    through a ref. It used to depend on the page count: one image finishing
 *    its load re-registered the gesture under the finger, the cleanup pinned
 *    the page back and the closure's `active` died with it, so the rest of the
 *    swipe went nowhere. Hence `args` is mirrored into one ref below and the
 *    effect depends on `[mode, chapterKey]` and nothing else.
 *
 * The page's own geometry — the strip, the spread, the drag layer — stays in
 * the reader: the hook moves a page, it does not lay one out.
 */
export function usePageTurns(args: {
  mode: ReadMode;
  /** The reader root: the listeners go here, not on the stage. A touch that
   *  starts on the word card or the chrome is a sibling of the stage, so a
   *  stage listener would never see it and the swipe would be dropped. */
  hostRef: RefObject<HTMLDivElement | null>;
  /** The neighbouring chapter's page, waiting one spread off-screen. */
  peekRef: RefObject<HTMLDivElement | null>;
  /** The drag layer the offset is written to, and the band that rides it. */
  dragLayerRef: RefObject<HTMLDivElement | null>;
  veilRef: RefObject<HTMLDivElement | null>;
  /** The ribbon hanging out of the page's top edge. */
  tagWrapRef: RefObject<HTMLDivElement | null>;
  tagRef: RefObject<HTMLDivElement | null>;
  /** The chapter on the sheet. A registration lives exactly as long as this. */
  chapterKey: string | null;
  pageIndex: number;
  setPageIndex: Dispatch<SetStateAction<number>>;
  /** Pages advanced per turn (1 or 2, from the 单页/双页 setting). */
  turnStep: number;
  /** The last page-aligned index that still has content. */
  maxPageIndex: number;
  /** The spread's width — what the band travels across during a turn. */
  viewWidth: number;
  /** Which phase the page is in, and the only thing that re-renders mid-gesture. */
  turnDrag: TurnDrag | null;
  setTurnDrag: Dispatch<SetStateAction<TurnDrag | null>>;
  /** What a gesture turn needs while it is running — see the reader. */
  turnGeomRef: MutableRefObject<{ stride: number; step: number; max: number }>;
  /** Set from the frame the chapter turn lands until the new chapter has been
   *  measured and painted: the peek is covering the sheet during the swap, so
   *  nothing underneath it may be exposed first. */
  peekHandoffRef: MutableRefObject<boolean>;
  preview: boolean;
  peekLive: RefObject<PagePeek | null>;
  next: Chapter | null;
  prev: Chapter | null;
  /** The two neighbours as refs: a turn in flight outlives the render that
   *  started it and must read the chapter list as it is now. */
  nextRef: MutableRefObject<Chapter | null>;
  prevRef: MutableRefObject<Chapter | null>;
  turnSensRef: MutableRefObject<TurnSensitivity>;
  /** When the reader last turned a page, so a synthesised click that follows
   *  the gesture is not counted as a second instruction. */
  turnedAtRef: MutableRefObject<number>;
  /** Bookmark toggle, assigned by the bookmark section. The gesture cannot
   *  capture it: it is rebuilt with the reading position. */
  bookmarkToggleRef: MutableRefObject<() => void>;
  /** The chapter handoff, which lives in a measure pass above this hook's call
   *  site, borrows the one operation it needs out of the drag. */
  dropDragRef: MutableRefObject<() => void>;
  /** One tap, handed over raw: the reader is the only thing that knows what a
   *  tap means (word, highlight, chrome) and which mode it means it in. */
  onTap: (x: number, y: number) => void;
  /** The word card points at a word on the page that is going away. */
  dropLookup: () => void;
  /** A press that may become a lookup: cancel the one already scheduled. */
  cancelLookup: () => void;
  /** A committed turn: the page is the reader's now, so 听书 stops following. */
  onTurnCommit: () => void;
  /** A deliberate turn ends whatever floats over the page. */
  onClearSelection: () => void;
  /** Anything floating over the page, dismissed once the gesture is over. */
  onDismiss: () => void;
  /** The sweep that belongs to a turn inside one chapter. */
  onSlide: (dir: 1 | -1) => void;
  /** A chapter turn with nothing to slide: fade out, swap, fade in. */
  onDissolve: (apply: () => void) => void;
  onOpenChapter: (cid: string, intent: { type: 'first' | 'last' }) => void;
  /** A hold that landed on a word: build the selection (the caller owns the
   *  DOM selection — it is the reader's, not the gesture's). */
  onSelectWord: (range: Range) => void;
  /** A new press ends the previous selection. */
  onSelectionStart: () => void;
  hitWord: (x: number, y: number, allowCJK: boolean) => { range: Range } | null;
}) {
  const {
    mode,
    pageIndex,
    setPageIndex,
    turnStep,
    maxPageIndex,
    turnDrag,
    setTurnDrag,
    turnGeomRef,
    peekHandoffRef,
    peekLive,
    peekRef,
    dragLayerRef,
    veilRef,
    tagWrapRef,
    tagRef,
    // Named apart from `next`/`prev` because the ribbon weighs its own "next"
    // against the arm point, and a shadowed chapter reads as a mystery.
    next: nextChapter,
    prev: prevChapter,
    nextRef,
    prevRef,
    turnSensRef,
    turnedAtRef,
    bookmarkToggleRef,
    hostRef,
    chapterKey,
  } = args;
  // One ref for the lot, for the reason in the header: the listeners outlive
  // the render they were registered in, and a callback captured then would turn
  // the page of the chapter that was open then.
  const cb = useRef(args);
  cb.current = args;
  // The band travels across the spread, so it needs the spread's width — and
  // placeBand runs from a listener that may predate the render that measured it.
  const viewWidthRef = useRef(args.viewWidth);
  viewWidthRef.current = args.viewWidth;
  // Which page the reader is on now — read through a ref for the same reason as
  // the geometry: this is called from a gesture listener that was registered on
  // the chapter's first page, and pageIndex has moved several times since. It
  // used to read the closure's value, so a drag made at the far end of a chapter
  // still thought it was on the page where the listener had been registered.
  const pageIndexRef = useRef(pageIndex);
  pageIndexRef.current = pageIndex;
  // The peek covers the sheet until the new chapter is painted; the measure pass
  // that knows that is declared above this hook and cannot call into it, so it
  // calls through here.
  args.dropDragRef.current = () => {
    dragTurnRef.current = null;
    placeDrag(0, true);
    setTurnDrag(null);
  };

  // Measured band geometry, per veil element (see placeBand).
  const bandGeomRef = useRef<{ el: HTMLElement; w: number; bw: number } | null>(null);
  // The live drag: how far the page is pulled, in px, where the finger picked
  // it up, how it must end, and whether the release slide is the thing running
  // now. Deliberately not state — it changes every frame and nothing renders
  // from it.
  const dragTurnRef = useRef<{
    dir: 1 | -1;
    px: number;
    origin: number;
    commit: boolean;
    settling: boolean;
    // What the gesture is turning: a page of this chapter, or — at a chapter
    // edge, with the neighbour's page in the peek — the chapter itself.
    kind: 'page' | 'chapter';
  } | null>(null);
  const dragEndTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(dragEndTimer.current), []);

  /* ---- the turn itself ---- */
  // Keyboard, wheel and page-edge clicks keep the reader's fixed-duration sweep
  // (`onSlide`): no finger, nothing to synchronise with. A touch gesture is the
  // opposite — the page has to be under the thumb at every instant, and where
  // the turn ends is decided by where the finger lets go.
  //
  // Both endings run through the same slide, so a release never "resolves" a
  // turn the reader has not already been shown: drag a third of the page, let
  // go, and the page finishes the journey from exactly where it was left.
  const TURN_SLIDE_MS = 210; // must match .reader-spread.turn-settle in styles.css

  // The page's position during a turn, in px from the spread it belongs to.
  // Written straight to the element: this runs on every touchmove.
  //
  // `cancelSlide` is the take-over case. A running CSS transition keeps winning
  // over the specified value until it is over — dropping the class that declared
  // it does not stop it, and neither does writing a new value (Chrome carries on
  // to the old target). The only way to stop it where it stands is to take the
  // transition out of the style and force a recalc before the value goes in;
  // that recalc is never painted, so the jump it causes is not seen.
  function placeDrag(px: number, cancelSlide = false) {
    const el = dragLayerRef.current;
    if (!el) return;
    if (cancelSlide) {
      el.style.transition = 'none';
      void el.offsetWidth;
    }
    el.style.transform = px === 0 ? '' : `translate3d(${px}px, 0, 0)`;
  }

  // Where the page is right now. Only read when a new touch catches a page that
  // is still sliding.
  function dragLayerX(): number {
    const el = dragLayerRef.current;
    if (!el) return 0;
    const tr = getComputedStyle(el).transform;
    if (!tr || tr === 'none') return 0;
    const m = tr.match(/matrix(?:3d)?\(([^)]+)\)/);
    if (!m) return 0;
    const v = m[1].split(',').map(Number);
    return tr.startsWith('matrix3d') ? v[12] : v[4];
  }

  // The shadow rides the same progress as the page: off the right edge before
  // the turn, off the left edge after it — so at any point of a drag it sits
  // where the pulled page's edge is, instead of flying on its own schedule.
  //
  // The band's width is measured ONCE per veil: reading offsetWidth here would
  // force a layout on every touchmove, which is exactly the cost a page turn
  // must not pay. The veil is keyed per turn, so a new turn re-measures.
  function placeBand(p: number, dir: 1 | -1) {
    const band = veilRef.current?.firstElementChild as HTMLElement | null;
    if (!band) return;
    const w = viewWidthRef.current;
    const cache = bandGeomRef.current;
    if (!cache || cache.el !== band || cache.w !== w) {
      bandGeomRef.current = { el: band, w, bw: band.offsetWidth };
    }
    const bw = bandGeomRef.current!.bw;
    const travel = w + bw;
    band.style.transform = `translate3d(${dir > 0 ? w - p * travel : p * travel - bw}px, 0, 0)`;
  }

  // The neighbour's page rides the same offset as the page leaving: one spread
  // away at rest, home at a full stride. `px` is the live page's offset, so the
  // two move as one gesture.
  function placePeek(px: number, dir: 1 | -1) {
    const el = peekRef.current;
    if (!el) return;
    const { stride } = turnGeomRef.current;
    el.style.transform = `translate3d(${(dir > 0 ? stride : -stride) + px}px, 0, 0)`;
  }

  function dragAvailable(dir: 1 | -1) {
    const { step, max } = turnGeomRef.current;
    const at = pageIndexRef.current;
    return dir > 0 ? at + step <= max : at - step >= 0;
  }

  // Is there a page to turn to past this chapter's edge? Only when the
  // neighbour's page is already laid out in the peek: without it there would be
  // nothing to drag in, and the cross-fade covers the load instead.
  function chapterReachable(dir: 1 | -1) {
    if (mode !== 'paged' || cb.current.preview) return false;
    const p = peekLive.current;
    if (peekHandoffRef.current || !p || p.side !== dir) return false;
    // Through the refs: this is called from a gesture listener that outlives
    // the render it was registered in.
    return dir > 0 ? !!nextRef.current : !!prevRef.current;
  }

  // Returns whether the page took the gesture. A chapter edge takes it too, as
  // long as the neighbour's page is ready: the peek is positioned exactly one
  // spread away, so the same drag brings it in.
  function beginDragTurn(dx: number): boolean {
    if (cb.current.preview) return false;
    if (peekHandoffRef.current) return false;
    // A chapter turn is a one-way journey with the next chapter loading behind
    // the peek; there is nothing to catch and re-aim, so it refuses a new grip.
    if (dragTurnRef.current?.kind === 'chapter') return false;
    // Reduced motion is a request for no moving pictures, and a page sliding
    // under the thumb is exactly that.
    if (prefersReducedMotion()) return false;
    // A fast reader flicks again before the last page has finished sliding. The
    // new touch catches the page where it is and drags on from there, instead
    // of fighting the slide or waiting it out.
    const carried = dragTurnRef.current?.settling ? dragLayerX() : 0;
    const px = carried + dx;
    const dir: 1 | -1 = px < 0 ? 1 : -1;
    const kind: 'page' | 'chapter' = dragAvailable(dir) ? 'page' : 'chapter';
    if (kind === 'chapter' && !chapterReachable(dir)) return false;
    if (carried) {
      window.clearTimeout(dragEndTimer.current);
      dragTurnRef.current!.settling = false;
      dragTurnRef.current!.commit = false;
      // Pin the page where it was caught, before the class change reaches React.
      placeDrag(carried, true);
    }
    dragTurnRef.current = { dir, px, origin: carried, commit: false, settling: false, kind };
    setTurnDrag({ dir, phase: 'follow' });
    followDrag(dx);
    return true;
  }

  // 1:1 with the finger, but never past the neighbouring spread: the strip
  // holds the whole chapter, so beyond that it would show the end of the paper
  // rather than more book. There it stiffens instead.
  function followDrag(dx: number) {
    const d = dragTurnRef.current;
    if (!d) return;
    const stride = turnGeomRef.current.stride || 1;
    // Measured from where this finger started, which is the page's own position
    // on a fresh drag and wherever it was caught on one that interrupts a slide.
    let px = d.origin + dx;
    // The reader drags a page back and forth before deciding, so the direction
    // is whatever side of the spread the finger is on now.
    const want: 1 | -1 = px < 0 ? 1 : -1;
    if (want !== d.dir) {
      // A chapter turn has only its one neighbour waiting behind the spread, so
      // it cannot reverse into that chapter. It can, however, hand the gesture
      // back to the strip: the finger changed its mind and is now pulling a page
      // of this chapter, and the neighbour's page simply goes home.
      if (!dragAvailable(want)) {
        d.px = 0;
        placeDrag(0);
        placeBand(0, d.dir);
        if (d.kind === 'chapter') placePeek(0, d.dir);
        return;
      }
      if (d.kind === 'chapter') {
        placePeek(0, d.dir);
        d.kind = 'page';
      }
      d.dir = want;
    }
    const mag = Math.abs(px);
    px = mag <= stride ? mag : stride + (mag - stride) * 0.12;
    d.px = -want * px;
    placeDrag(d.px);
    placeBand(Math.min(1, px / stride), d.dir);
    if (d.kind === 'chapter') placePeek(d.px, d.dir);
  }

  // Let go. A flick counts even when it barely moved the page — the gesture
  // said "next" — and a slow drag has to be carried the distance the reader's
  // 翻页灵敏度 setting asks for (标准 = a third of the spread, the value this
  // reader has always used).
  // `interrupted` is the system taking the gesture back: nobody let go, so
  // nothing was decided, and the page returns whatever it had travelled.
  function releaseDragTurn(flick: number, interrupted = false) {
    const d = dragTurnRef.current;
    if (!d) return;
    // Already decided: a settle in flight is not re-judged by a later touch,
    // and a chapter turn is waiting for its chapter, not for another verdict.
    if (d.settling) return;
    const dist = Math.abs(d.px);
    const { far, flickFloor } = turnThresholds(turnSensRef.current, turnGeomRef.current.stride);
    d.commit = !interrupted && (dist >= far || (flick * d.dir < -0.5 && dist > flickFloor));
    // The card points at a word on the page being left behind. It goes when the
    // page is known to be going — not at touchstart, where unmounting the
    // element under the finger makes the browser cancel the gesture — and not
    // when the page is only being pulled at and let go again.
    if (d.commit) {
      cb.current.dropLookup();
    }
    d.settling = true;
    setTurnDrag({ dir: d.dir, phase: 'settle' });
    window.clearTimeout(dragEndTimer.current);
    // Only a stalled main thread reaches this: the slide's own transitionend
    // normally ends the turn first.
    dragEndTimer.current = window.setTimeout(finishDragTurn, TURN_SLIDE_MS + 240);
  }

  function finishDragTurn() {
    window.clearTimeout(dragEndTimer.current);
    const d = dragTurnRef.current;
    // A committed swipe is the reader turning the page themselves: from here
    // the page is theirs and 听书 must stop paging it back. (A drag that was
    // pulled back and abandoned is not a turn and changes nothing.)
    if (d?.commit) cb.current.onTurnCommit();
    if (d?.commit && d.kind === 'chapter') {
      // Read from the refs: this runs from a timer armed by a listener that may
      // predate the last render.
      const target = d.dir > 0 ? nextRef.current : prevRef.current;
      if (target) {
        // Everything stays exactly where the slide left it: the peek covers the
        // page while the chapter loads, and measureAndLayout drops the offset in
        // one frame once the new page is painted underneath (see the handoff).
        peekHandoffRef.current = true;
        cb.current.onOpenChapter(target.id, { type: d.dir > 0 ? 'first' : 'last' });
        return;
      }
    }
    dragTurnRef.current = null;
    if (d?.commit) {
      // The strip's base moves to the page the slide ended on, and the drag
      // offset is dropped in the same commit — see the layout effect below.
      const { step, max } = turnGeomRef.current;
      setPageIndex((p) => Math.max(0, Math.min(max, p + d.dir * step)));
    } else {
      placeDrag(0);
    }
    setTurnDrag(null);
  }

  // The release target is written after React has put the settling class on the
  // element: the transition must exist before the value it has to animate.
  // During the drag this only places the band — and re-anchors a page that a
  // new touch has just caught, in the same frame the transition comes off, so
  // it stops where it was instead of snapping to the value it was heading for.
  useLayoutEffect(() => {
    const d = dragTurnRef.current;
    if (!turnDrag || !d) return;
    const stride = turnGeomRef.current.stride || 1;
    if (turnDrag.phase === 'settle') {
      // A page that was caught by hand has an inline `transition: none` on it
      // from the take-over; this is where it goes back to the stylesheet's.
      const el = dragLayerRef.current;
      if (el) el.style.transition = '';
      placeDrag(d.commit ? -d.dir * stride : 0);
      placeBand(d.commit ? 1 : 0, d.dir);
      if (d.kind === 'chapter') placePeek(d.commit ? -d.dir * stride : 0, d.dir);
    } else {
      placeDrag(d.px);
      placeBand(Math.min(1, Math.abs(d.px) / stride), d.dir);
      if (d.kind === 'chapter') placePeek(d.px, d.dir);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnDrag]);

  // A committed turn: the base has just moved to the new page, so the offset
  // goes now — one frame later and the same page would be shown twice.
  useLayoutEffect(() => {
    if (dragTurnRef.current) return;
    placeDrag(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex]);

  // A chapter turn with no finger on it — the keyboard, the wheel, a click on
  // the page edge — plays the same slide as a gesture one whenever the
  // neighbour's page is already laid out. Two frames, for the same reason a
  // release needs them: the band has to be put at its start without a
  // transition before the transition may carry it across.
  function slideChapterTurn(dir: 1 | -1): boolean {
    if (!chapterReachable(dir)) return false;
    dragTurnRef.current = {
      dir,
      px: 0,
      origin: 0,
      commit: true,
      settling: true,
      kind: 'chapter',
    };
    setTurnDrag({ dir, phase: 'follow' });
    requestAnimationFrame(() => {
      const d = dragTurnRef.current;
      if (!d || d.kind !== 'chapter') return;
      setTurnDrag({ dir, phase: 'settle' });
      window.clearTimeout(dragEndTimer.current);
      // Only a stalled main thread reaches this; the drag layer's own
      // transitionend normally ends the slide first.
      dragEndTimer.current = window.setTimeout(finishDragTurn, TURN_SLIDE_MS + 240);
    });
    return true;
  }

  function turn(delta: number) {
    // Preview visits do not turn pages: the position must stay on the anchor,
    // and every save guard aside, drifting would break the "temporary look"
    // model. Use the banner's two exits to leave the mode.
    if (cb.current.preview) return;
    // A chapter turn is already in flight, with its chapter loading behind the
    // peek: another turn would have nowhere to land.
    if (peekHandoffRef.current) return;
    // A deliberate turn while the book is being read aloud: the page is the
    // reader's from here, and 听书 keeps reading without taking it back. This
    // is what made a swipe look broken — the next sentence start paged the
    // reader to the voice a second later, so the turn appeared not to happen.
    cb.current.onTurnCommit();
    // The card points at a word on the page being left behind.
    cb.current.dropLookup();
    cb.current.onClearSelection();
    const step = turnStep;
    if (delta > 0) {
      if (pageIndex + step <= maxPageIndex) {
        cb.current.onSlide(1);
        setPageIndex(pageIndex + step);
      } else if (nextChapter) {
        if (!slideChapterTurn(1))
          cb.current.onDissolve(() => cb.current.onOpenChapter(nextChapter.id, { type: 'first' }));
      }
    } else {
      if (pageIndex - step >= 0) {
        cb.current.onSlide(-1);
        setPageIndex(pageIndex - step);
      } else if (prevChapter) {
        if (!slideChapterTurn(-1))
          cb.current.onDissolve(() => cb.current.onOpenChapter(prevChapter.id, { type: 'last' }));
      }
    }
  }

  // `turn` closes over the page it is turning from, so a gesture callback that
  // captured it would keep turning from the page it was registered on. Same
  // reason as nextRef above.
  const turnRef = useRef(turn);
  turnRef.current = turn;

  /* ---- touch: a horizontal swipe turns the page ---- */
  // Registered as native listeners so touchmove can be non-passive and own the
  // gesture: without that the WebView treats a fast horizontal drag as its own
  // overscroll/back gesture and the page never sees the move events. CSS
  // (`touch-action: pan-y` on the paged stage) keeps the browser out of the way.
  //
  // The reader OWNS the page gesture end to end: touchstart is prevented, so
  // the browser never starts its own long-press selection, never shows its
  // floating text menu (the "圆形菜单" the notebook jump used to surface) and
  // never synthesises a click that would race our routing. Every meaning —
  // tap, swipe, hold — is decided here.
  useEffect(() => {
    if (mode !== 'paged') return;
    // Listen on the whole reader, not just the stage: the word card and the
    // chrome bars are siblings of the stage, so a touch that starts on one of
    // them never bubbles to a stage listener and the swipe is silently dropped.
    // Looking a word up and then turning the page is the most common sequence
    // in this reader, and the card sits exactly where the thumb already is.
    const host = hostRef.current;
    if (!host) return;
    // The swipe floor for the paths that never hand the page to the finger —
    // preview mode, and reduced motion (a page sliding under the thumb is
    // exactly what that setting asks not to see). Everything else decides on
    // the drag itself, in releaseDragTurn. 40 px is the 标准 level; the others
    // scale it so the setting is not silently ignored just because the reader
    // prefers reduced motion.
    const MIN_TRAVEL = 40; // px before a drag counts as a page turn
    const MIN_RATIO = 1.2; // horizontal travel must beat vertical by this much
    const LP_MS = 450; // hold-to-select threshold, tuned like 微信读书
    const LP_SLOP = 10; // finger drift that cancels the hold
    const TAP_MS = 500; // holds longer than this are a press, not a tap
    // Pulling the page down pulls a tag out of its top edge, and letting go past
    // the arm point marks the page. The numbers are the ribbon's, not the
    // finger's: the ribbon lags the finger (TAG_DAMP) so it reads as something
    // being drawn out of the book rather than as a slider, and it stops growing
    // at TAG_MAX_RAW so an enthusiastic pull cannot run it down the page.
    const TAG_ARM = 70; // ribbon height at which a release marks the page
    const TAG_DAMP = 0.7;
    const TAG_MAX_RAW = 150;
    let startX = 0;
    let startY = 0;
    let startT = 0;
    let active = false;
    let horizontal = false;
    let pulling = false;
    let armed = false;
    let lpTimer = 0;
    // The hold, in two parts. `lpArmed` means the press outlived the tap window
    // and is no longer an ordinary tap; `lpFired` means it also produced a word
    // selection. Keeping them apart is what lets a hold on blank paper still
    // open the chrome (ADR-43): a press that selected nothing must not end in
    // silence just because it was long. Only `lpFired` may swallow the tap.
    let lpArmed = false;
    let lpFired = false;
    // Recent finger positions of the current drag, for the release decision: a
    // flick has to count even when it barely moved the page, and one frame of
    // velocity is noise.
    const samples: Array<{ x: number; t: number }> = [];

    const flickVelocity = (): number => {
      const now = Date.now();
      const recent = samples.filter((s) => now - s.t < 120);
      if (recent.length < 2) return 0;
      const a = recent[0];
      const b = recent[recent.length - 1];
      const dt = b.t - a.t;
      return dt > 0 ? (b.x - a.x) / dt : 0;
    };

    const cancelLongPress = () => {
      window.clearTimeout(lpTimer);
      lpTimer = 0;
    };

    // The ribbon is drawn at the finger's pace, and it says what letting go will
    // do as soon as it is long enough to be a promise: armed is the moment the
    // colour changes, not the moment anything is written.
    const drawTag = (raw: number) => {
      const el = tagRef.current;
      if (!el) return;
      const h = Math.round(Math.min(Math.max(raw, 0), TAG_MAX_RAW) * TAG_DAMP);
      el.style.height = `${h}px`;
      const next = h >= TAG_ARM;
      if (next === armed) return;
      armed = next;
      if (tagWrapRef.current) tagWrapRef.current.dataset.armed = String(armed);
      if (armed) {
        // One tick, exactly where the gesture becomes a commitment.
        try {
          navigator.vibrate?.(8);
        } catch {
          /* no vibration on this device */
        }
      }
    };

    // Putting the ribbon down. Handing the height back to CSS IS the settle:
    // `.page-tag` is shut and `.page-tag-wrap.on` is a resting height, so one
    // deleted inline property covers both outcomes — and the reader's own state
    // (the bookmark row) decides which of the two the page ends up showing.
    const releaseTag = (cancel: boolean) => {
      const el = tagRef.current;
      const h = el ? parseFloat(el.style.height) || 0 : 0;
      const fire = !cancel && h >= TAG_ARM;
      pulling = false;
      armed = false;
      const wrap = tagWrapRef.current;
      if (wrap) {
        wrap.dataset.drag = 'false';
        wrap.dataset.armed = 'false';
      }
      if (el) el.style.height = '';
      if (fire) {
        // The drag was ours end to end; no stray click can follow it.
        turnedAtRef.current = Date.now();
        bookmarkToggleRef.current();
      }
    };

    // Surfaces that keep native behaviour — their buttons, sliders and inputs
    // need real click events, and a drag inside them must never turn pages.
    // The floating cards are deliberately NOT listed: everything interactive
    // inside them is a button/input (matched below), and a swipe that starts
    // on the word card must still turn the page. The AI surfaces ARE listed:
    // a bottom panel scrolled with a thumb, or a privacy dialog being read,
    // has nothing to do with page turning.
    const isNativeTarget = (t: EventTarget | null): boolean =>
      !!(
        t instanceof Element &&
        (t.closest('.drawer-mask') ||
          t.closest('.sheet-mask') ||
          t.closest('.ai-sheet') ||
          t.closest('.modal-backdrop') ||
          t.closest('.reader-chrome') ||
          t.closest('.sel-handle') ||
          t.closest('button') ||
          t.closest('input') ||
          t.closest('textarea') ||
          t.closest('a'))
      );

    const onStart = (e: TouchEvent) => {
      lpArmed = false;
      lpFired = false;
      samples.length = 0;
      // Multi-touch is never a page turn (pinch, or a stray second finger).
      if (e.touches.length !== 1) {
        active = false;
        return;
      }
      const target = e.target as HTMLElement | null;
      if (isNativeTarget(target)) {
        active = false;
        return;
      }
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      startT = Date.now();
      active = true;
      horizontal = false;
      pulling = false;
      armed = false;
      // Owning the gesture: no native long-press selection, no synthesized
      // click, no native text handles. Everything below is ours.
      if (e.cancelable) e.preventDefault();
      // The card points at a word on the page being left behind.
      cb.current.cancelLookup();
      // A new touch on the page ends the previous word selection (dragging a
      // handle or tapping the toolbar is exempt — see the ignore list above).
      cb.current.onSelectionStart();
      // Own the long-press: native selection inside the column layout selects
      // the whole content box (the "整面变暗" bug), so user-select is disabled
      // and this timer builds a one-word selection instead.
      cancelLongPress();
      lpTimer = window.setTimeout(() => {
        lpTimer = 0;
        if (!active) return;
        // Past the tap window from here on, whatever the hit test says.
        lpArmed = true;
        // allowCJK: a hold on Chinese text selects that one character (a tap
        // must not — there is no Chinese dictionary to open).
        const hit = cb.current.hitWord(startX, startY, true);
        if (!hit) return;
        // A tap on the word would have been a lookup; a hold is a selection.
        try {
          navigator.vibrate?.(15);
        } catch {
          /* no vibration on this device */
        }
        lpFired = true;
        cb.current.onSelectWord(hit.range);
        // Swallow the tap that ends the gesture: with a live selection it
        // would be a no-op anyway, but turning the timestamp also protects the
        // no-hit case.
        turnedAtRef.current = Date.now();
      }, LP_MS);
    };

    const onMove = (e: TouchEvent) => {
      if (!active || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.hypot(dx, dy) > LP_SLOP) cancelLongPress();
      // A page already in this finger's hand follows it whatever it does next —
      // it is off its mark, and freezing it mid-drag reads as a dropped gesture.
      // A page still sliding home from the last flick is NOT in this hand yet:
      // it is caught below, once this gesture has travelled far enough to be one.
      const held = dragTurnRef.current;
      if (held && !held.settling) {
        if (e.cancelable) e.preventDefault();
        samples.push({ x: t.clientX, t: Date.now() });
        if (samples.length > 8) samples.shift();
        followDrag(dx);
        return;
      }
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
        horizontal = true;
        if (e.cancelable) e.preventDefault();
        // From the first horizontal pixel the page belongs to the finger: it
        // sits exactly where the drag has taken it, so the gesture is answered
        // while it happens rather than after it has been judged.
        samples.push({ x: t.clientX, t: Date.now() });
        if (samples.length > 8) samples.shift();
        beginDragTurn(dx);
        return;
      }
      // Down, and downwards by more than sideways: the finger is pulling the
      // page's tag. A hold that already selected a word is a selection, not a
      // pull — dragging it is how you extend the selection.
      if (pulling || (!lpFired && dy > 10 && dy > Math.abs(dx) * MIN_RATIO)) {
        if (!pulling) {
          pulling = true;
          samples.length = 0;
          if (tagWrapRef.current) tagWrapRef.current.dataset.drag = 'true';
        }
        // Non-passive: the WebView must not take a downward drag as its own
        // overscroll while the ribbon is coming out.
        if (e.cancelable) e.preventDefault();
        drawTag(dy);
      }
    };

    const onEnd = (e: TouchEvent) => {
      cancelLongPress();
      if (!active) return;
      active = false;
      const t = e.changedTouches[0];
      if (!t) {
        if (pulling) releaseTag(true);
        else if (dragTurnRef.current) releaseDragTurn(0);
        return;
      }
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      // A pull is never a tap, however short: a thumb that settles 30px down
      // the page and lets go there is not asking for the chrome.
      if (pulling) {
        releaseTag(false);
        return;
      }
      if (!horizontal) {
        // A tap: the native click was suppressed at touchstart, so route it
        // ourselves. A hold that produced a selection is not a tap; a hold that
        // produced nothing still is one, and is routed the same way no matter
        // how long the thumb stayed down (ADR-43).
        if (!lpFired && (lpArmed || Date.now() - startT < TAP_MS))
          cb.current.onTap(t.clientX, t.clientY);
        return;
      }
      // Dismiss whatever floats over the page only once the gesture is over.
      // Unmounting the element under the finger mid-drag makes the browser
      // cancel the touch sequence, and the page turn never happens — which is
      // how "swipe while the word card is open" stayed broken even after the
      // listener moved to the reader root.
      const dismiss = () => {
        cb.current.onDismiss();
      };
      // A page that was pulled in owns the release however far it went: it has
      // to be put down somewhere, finished or returned.
      if (dragTurnRef.current) {
        turnedAtRef.current = Date.now();
        dismiss();
        releaseDragTurn(flickVelocity());
        return;
      }
      if (Math.abs(dx) < MIN_TRAVEL * turnLevelFactor(turnSensRef.current)) return;
      if (Math.abs(dx) < Math.abs(dy) * MIN_RATIO) return;
      // The gesture was ours end to end; no stray click can follow.
      turnedAtRef.current = Date.now();
      dismiss();
      turnRef.current(dx < 0 ? 1 : -1);
    };

    const onCancel = () => {
      cancelLongPress();
      active = false;
      horizontal = false;
      // The system took the gesture back (a notification shade pulled down, an
      // app switch): nobody let go, so the page must not be left standing half
      // turned — and must not be turned on a decision no finger made. A page
      // still sliding from an earlier flick is not this gesture's to interrupt.
      // The same goes for a ribbon half out of the book: it goes back, unwritten.
      if (pulling) releaseTag(true);
      const held = dragTurnRef.current;
      if (held && !held.settling) releaseDragTurn(0, true);
    };

    host.addEventListener('touchstart', onStart, { passive: false });
    host.addEventListener('touchmove', onMove, { passive: false });
    host.addEventListener('touchend', onEnd, { passive: true });
    host.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      cancelLongPress();
      host.removeEventListener('touchstart', onStart);
      host.removeEventListener('touchmove', onMove);
      host.removeEventListener('touchend', onEnd);
      host.removeEventListener('touchcancel', onCancel);
      // A re-registration (chapter change, mode switch) mid-gesture orphans the
      // drag: put the page back rather than leave it half turned. Not while a
      // chapter turn is handing over, though — that drag is the chapter load's,
      // and the handoff drops it when the new page is painted.
      if (dragTurnRef.current && !peekHandoffRef.current) {
        dragTurnRef.current = null;
        window.clearTimeout(dragEndTimer.current);
        // No transition here: the offset is being abandoned, not settled, and a
        // slide running on while the sheet changes under it would be seen.
        placeDrag(0, true);
        setTurnDrag(null);
      }
      // Same for a pull caught by the re-registration: retract, write nothing.
      if (pulling) releaseTag(true);
    };
    // `mode` and the chapter, nothing else. Everything a gesture decides on —
    // where the page is, how many there are, which chapter is next — is read
    // through a ref (turnGeomRef, nextRef, prevRef, turnRef), so a change in any
    // of them must not re-register these listeners. It used to: one image
    // finishing its load called setPageCount, the effect tore down and rebuilt
    // itself under the finger, and the cleanup pinned the page back while the
    // closure's `active` died with it — the rest of the swipe went nowhere
    // (ADR-43, tap-hold.cjs H2).
  }, [mode, chapterKey]);

  return {
    turn,
    /**
     * The release slide is over. The drag layer's own `transitionend` is what
     * normally ends the turn; the timer inside finishDragTurn only covers a
     * stalled main thread, where no such event arrives.
     */
    onSettleEnd() {
      if (dragTurnRef.current?.settling) finishDragTurn();
    },
  };
}
