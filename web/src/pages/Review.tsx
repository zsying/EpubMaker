import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ExplainResult, VocabItem } from '../api';
import { toastError } from '../toast';
import { speakWord } from '../speech';
import { useBackClose } from '../backNav';
import AIPanel from '../components/AIPanel';
import AISentence from '../components/AISentence';
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
 *
 * The answer side also carries the AI gloss when there is one. It is not a
 * second gloss: the dictionary says what the word means, the AI says what it
 * means *here*, in the sentence printed under it — which is the thing a card
 * that has the sentence in hand can answer and a dictionary cannot. It hangs
 * off the same cache key as the reader and the notebook sheet (word + that
 * sentence), so a word looked up while reading shows its answer here for free,
 * and only the words never asked about offer the ✦ link. Nothing of it appears
 * before the reveal: an AI explanation is a bigger spoiler than the gloss, and
 * a pass that hands out the meaning is a pass that teaches nothing.
 */
export default function Review() {
  const nav = useNavigate();
  const [list, setList] = useState<VocabItem[] | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [tally, setTally] = useState<Tally>({ hit: 0, miss: 0, skipped: 0 });
  const [receipt, setReceipt] = useState('');
  /** The stored AI gloss for this word in this sentence, if it was ever asked. */
  const [ai, setAi] = useState<ExplainResult | null>(null);
  const [asking, setAsking] = useState(false);
  const busy = useRef(false);

  const cur = list?.[index];
  const done = list !== null && !cur;
  const sentence = (cur?.context ?? '').trim();

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

  // "Has this word been explained with AI before?" — the same cache read the
  // reader and the notebook sheet make, keyed by the word *and the sentence*,
  // so it answers for exactly the question this card is showing. A miss is a
  // quiet null: the card offers ✦ instead of printing nothing.
  useEffect(() => {
    setAi(null);
    setAsking(false);
    if (!cur || !sentence) return;
    let alive = true;
    api
      .aiExplainCached(cur.term, sentence)
      .then((r) => {
        if (alive) setAi(r ?? null);
      })
      .catch(() => {
        /* a cache read that failed is a miss, not a problem for the reader */
      });
    return () => {
      alive = false;
    };
    // The card's identity is the pair below: a re-render of the same card must
    // not re-ask, and the next word must not inherit the previous answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.id, cur?.term, sentence]);

  // The hardware back on a phone closes the AI panel before it leaves the pass.
  useBackClose(asking, () => setAsking(false));

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
                  <div className="review-context">
                    {emphasise(cur.context, [cur.surface, cur.term])}
                  </div>
                )}
                {/* The AI gloss, when this word + sentence was ever asked about.
                    Same block the notebook sheet shows, so the answer a reader
                    already paid for is never asked for twice. */}
                {ai ? (
                  <div className="dict-ai">
                    <div className="dict-ai-head">
                      <span className="dict-ai-star" aria-hidden="true">
                        ✦
                      </span>
                      AI 释义 · 本句
                    </div>
                    {ai.meaning && <div className="dict-ai-meaning">{ai.meaning}</div>}
                    {ai.translation && <div className="dict-ai-trans">整句：{ai.translation}</div>}
                    {ai.note && <div className="dict-ai-note">{ai.note}</div>}
                    {ai.conversationId && (
                      <button
                        className="dict-ai-open"
                        onClick={() => nav(`/ai/${ai.conversationId}`)}
                      >
                        查看对话 <span aria-hidden="true">›</span>
                      </button>
                    )}
                  </div>
                ) : (
                  sentence && (
                    <button
                      className="review-ai-ask"
                      onClick={() => setAsking(true)}
                      title="结合这一句解释这个词，并翻译整句"
                    >
                      <span aria-hidden="true">✦</span> 查 AI 释义
                    </button>
                  )
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

      {/* The panel over the card, exactly as the reader and the notebook stack
          it. `run` also files the answer into `ai`, so closing the panel leaves
          the gloss on the card instead of turning back into a ✦ link. */}
      {asking && cur && sentence && (
        <AIPanel<ExplainResult>
          title={`✦ AI 释义 · ${cur.term}`}
          run={() =>
            api.explainInContext(cur.term, sentence).then((r) => {
              setAi(r ?? null);
              return r;
            })
          }
          render={(r) => (
            <>
              {r.cached && <span className="ai-cache-badge">缓存结果</span>}
              <AISentence text={sentence}>
                {emphasise(sentence, [cur.surface, cur.term], 'ai-hl')}
              </AISentence>
              {r.meaning && (
                <>
                  <div className="ai-label">
                    在本句中
                    {r.pos && <span className="ai-pos">{r.pos}</span>}
                  </div>
                  <p className="ai-explain">{r.meaning}</p>
                </>
              )}
              {r.note && <p className="ai-note">{r.note}</p>}
              {r.translation && (
                <>
                  <div className="ai-label">整句翻译</div>
                  <p className="ai-trans">{r.translation}</p>
                </>
              )}
            </>
          )}
          onClose={() => setAsking(false)}
          onGoSettings={() => {
            setAsking(false);
            nav('/settings');
          }}
          chatId={(r) => r.conversationId}
          onOpenChat={(id) => {
            setAsking(false);
            nav(`/ai/${id}`);
          }}
        />
      )}
    </div>
  );
}
