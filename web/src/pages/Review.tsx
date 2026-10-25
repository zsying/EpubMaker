import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, VocabItem } from '../api';
import { toastError } from '../toast';
import { speakWord } from '../speech';
import SubHeader from '../components/SubHeader';
import { emphasise } from '../highlight';

/** A pass has to be finishable; a queue you cannot reach the end of is one you
 * stop starting. The rest waits for the next pass. */
const REVIEW_LIMIT = 30;

/** The interval a grade just produced, for the receipt under the card. */
function intervalLabel(days: number): string {
  if (days <= 0) return '稍后';
  if (days < 1) return '10 分钟';
  const d = Math.round(days);
  return d === 1 ? '明天' : `${d} 天后`;
}

type Tally = { hit: number; miss: number; skipped: number };

/**
 * One pass over the words that are due.
 *
 * This is a second-level page, so it behaves like one: a back chevron in a
 * sticky header, no bottom tab bar (App.tsx only renders it for the three
 * top-level destinations), and every action collected in a dock pinned to the
 * bottom edge — the only place a thumb reaches without regripping the phone.
 * The card above stays a reading surface; the word is shown first and the
 * gloss only after the dock is tapped, because reading the meaning straight
 * away is what makes a card feel productive while teaching nothing.
 *
 * Each grade reschedules the word with SM-2: a hit walks 1 day → 6 days →
 * interval × ease, a miss drops back to a ten-minute step. The receipt line
 * says what the last grade just did, because a schedule nobody can see is
 * indistinguishable from no schedule at all.
 */
export default function Review() {
  const nav = useNavigate();
  const [list, setList] = useState<VocabItem[] | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [tally, setTally] = useState<Tally>({ hit: 0, miss: 0, skipped: 0 });
  const [receipt, setReceipt] = useState('');
  const busy = useRef(false);

  // The queue is fetched here rather than handed over by the notebook: the
  // route is then self-contained, and a back press followed by a fresh start
  // gets a fresh queue (words graded a minute ago are no longer due).
  useEffect(() => {
    let alive = true;
    api
      .vocabQueue(REVIEW_LIMIT)
      .then((q) => {
        if (alive) setList(q ?? []);
      })
      .catch((e) => {
        if (alive) {
          setList([]);
          toastError(e);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  /** Back to the notebook. The pass was pushed on top of it, so one history
   * step is the honest move; the route fallback covers a cold start. */
  function leave() {
    if (window.history.length > 1) nav(-1);
    else nav('/vocab', { replace: true });
  }

  const cur = list?.[index];
  const done = list !== null && !cur;

  async function grade(didKnow: boolean) {
    if (!cur || busy.current) return;
    busy.current = true;
    try {
      // The Go side reschedules the word and hands the new state back, so the
      // receipt can say what happens next instead of the card just vanishing.
      const next = await api.gradeVocab(cur.id, didKnow);
      setReceipt(
        didKnow
          ? `${cur.term}：认识，下次 ${intervalLabel(next.intervalDays)}`
          : `${cur.term}：不记得，10 分钟后再看`,
      );
      setTally((t) => (didKnow ? { ...t, hit: t.hit + 1 } : { ...t, miss: t.miss + 1 }));
    } catch (e) {
      toastError(e);
    } finally {
      busy.current = false;
      setRevealed(false);
      setIndex((i) => i + 1);
    }
  }

  function skip() {
    setTally((t) => ({ ...t, skipped: t.skipped + 1 }));
    setRevealed(false);
    setIndex((i) => i + 1);
  }

  return (
    <div className="page review-page">
      <SubHeader
        title={done ? '复习完成' : '复习'}
        tag={
          !done && list && list.length > 0
            ? `${index + 1} / ${list.length}`
            : done && list && list.length > 0
              ? `本轮 ${list.length} 词`
              : undefined
        }
        backTo="/vocab"
      />

      {list === null ? (
        <div className="loading">准备中…</div>
      ) : done ? (
        <div className="review-stage">
          <div className="review-done">
            {list.length === 0 ? (
              <p className="muted">今天没有到期的词，明天再来。</p>
            ) : (
              <>
                <div className="review-scores">
                  <div className="review-score">
                    <b>{tally.hit}</b>
                    <span>认识</span>
                  </div>
                  <div className="review-score">
                    <b>{tally.miss}</b>
                    <span>不记得</span>
                  </div>
                  {tally.skipped > 0 && (
                    <div className="review-score">
                      <b>{tally.skipped}</b>
                      <span>跳过</span>
                    </div>
                  )}
                </div>
                <p className="muted">
                  {tally.miss > 0
                    ? '答错的词十分钟后会回到队列里；答对的按 1 天、6 天、再按熟练度翻倍往后排。'
                    : '这些词的间隔都往后推了，短期内不会再打扰你。'}
                </p>
              </>
            )}
          </div>
        </div>
      ) : cur ? (
        <div className="review-stage">
          <div className="review-card">
            <div className="review-word">{cur.term}</div>
            {cur.phonetic && <div className="review-phon">/{cur.phonetic}/</div>}
            <button className="btn sm review-speak" onClick={() => speakWord(cur.term)}>
              发音
            </button>

            {revealed ? (
              <>
                <div className="review-trans">{cur.translation || '（词库无释义）'}</div>
                {cur.context && (
                  <div className="review-context">{emphasise(cur.context, [cur.surface, cur.term])}</div>
                )}
              </>
            ) : (
              <div className="review-hint">先在心里回想，再看释义</div>
            )}
          </div>
        </div>
      ) : null}

      <div className="review-dock">
        {receipt && !done && <div className="review-receipt">{receipt}</div>}

        {done ? (
          <button className="btn primary review-primary" onClick={leave}>
            返回生词本
          </button>
        ) : list === null ? null : revealed ? (
          <div className="review-grades">
            <button className="btn review-grade" onClick={() => void grade(false)}>
              不记得
            </button>
            <button className="btn primary review-grade" onClick={() => void grade(true)}>
              认识
            </button>
          </div>
        ) : (
          <button className="btn primary review-primary" onClick={() => setRevealed(true)}>
            显示释义
          </button>
        )}

        {!done && list !== null && (
          <div className="review-minors">
            <button className="btn ghost sm" onClick={skip}>
              跳过
            </button>
            <button className="btn ghost sm" onClick={leave}>
              结束本轮
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
