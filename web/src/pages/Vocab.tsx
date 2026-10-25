import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, VocabItem, VocabStats } from '../api';
import { toast, toastError } from '../toast';
import { speakWord } from '../speech';
import { STATUS_HINT, STATUS_LABEL } from '../vocabLabels';

type Filter = '' | 'new' | 'learning' | 'known';

const FILTERS: { key: Filter; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'new', label: '待学' },
  { key: 'learning', label: '学习中' },
  { key: 'known', label: '已掌握' },
];

/** A pass has to be finishable; a queue you cannot reach the end of is one you
 * stop starting. The rest waits for the next pass. */
const REVIEW_LIMIT = 30;

/** "When is this due again", said the way a person would say it. */
function dueLabel(iso: string): string {
  if (!iso) return '待复习';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const ms = at.getTime() - Date.now();
  if (ms <= 0) return '今天到期';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟后`;
  const days = Math.round(ms / 86400000);
  if (days <= 1) return '明天';
  // Beyond two months a countdown stops meaning anything; the date reads better.
  if (days < 60) return `${days} 天后`;
  return `${at.getMonth() + 1}月${at.getDate()}日`;
}

/** The interval a grade just produced, for the review card's feedback line. */
function intervalLabel(days: number): string {
  if (days <= 0) return '稍后';
  if (days < 1) return '10 分钟';
  const d = Math.round(days);
  return d === 1 ? '明天' : `${d} 天后`;
}

/** When the word is due, said the way a schedule would: a word that was never
 * scheduled has no date to show, and saying "今天到期" about it would be wrong. */
function scheduleLine(dueAt: string): string {
  return dueAt ? `下次 ${dueLabel(dueAt)}` : '还没复习过';
}

/** Marks the word inside its example sentence, so the row reads as a quote
 * rather than an unexplained string. Falls back to the base form when the
 * stored surface text is inflected differently. */
function emphasise(text: string, candidates: string[]): ReactNode {
  const lower = text.toLowerCase();
  for (const c of candidates) {
    const needle = c.trim().toLowerCase();
    if (!needle) continue;
    const at = lower.indexOf(needle);
    if (at < 0) continue;
    return (
      <>
        {text.slice(0, at)}
        <mark className="vocab-hit">{text.slice(at, at + needle.length)}</mark>
        {text.slice(at + needle.length)}
      </>
    );
  }
  return text;
}

function shortDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export default function Vocab() {
  const nav = useNavigate();
  const [items, setItems] = useState<VocabItem[]>([]);
  const [stats, setStats] = useState<VocabStats | null>(null);
  const [filter, setFilter] = useState<Filter>('');
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);

  const [reviewing, setReviewing] = useState(false);
  const [queue, setQueue] = useState<VocabItem[]>([]);
  const [preparing, setPreparing] = useState(false);

  // The notebook is searched on every keystroke; each row costs one dictionary
  // lookup on the Go side, so a short debounce keeps typing responsive.
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const [list, st] = await Promise.all([api.listVocab(filter, keyword), api.vocabStats()]);
        if (!alive) return;
        setItems(list ?? []);
        setStats(st);
      } catch (e) {
        if (alive) toastError(e);
      } finally {
        if (alive) setLoading(false);
      }
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [filter, keyword]);

  async function reload() {
    try {
      const [list, st] = await Promise.all([api.listVocab(filter, keyword), api.vocabStats()]);
      setItems(list ?? []);
      setStats(st);
    } catch (e) {
      toastError(e);
    }
  }

  function jump(it: VocabItem) {
    if (!it.bookId || !it.chapterId) return;
    nav(`/books/${it.bookId}/read/${it.chapterId}`, {
      state: {
        // Marking the visit as a preview is what keeps it from overwriting the
        // reading position: the reader came here to see one word, not to read.
        preview: {
          source: 'vocab',
          label: it.term,
          offset: it.offset,
          word: it.term,
          surface: it.surface || it.term,
        },
      },
    });
  }

  async function startReview() {
    setPreparing(true);
    try {
      const q = await api.vocabQueue(REVIEW_LIMIT);
      if (q.length === 0) {
        toast('今天没有到期的词，明天再来', 'info');
        return;
      }
      setQueue(q);
      setReviewing(true);
    } catch (e) {
      toastError(e);
    } finally {
      setPreparing(false);
    }
  }

  // What is worth reviewing right now — not "everything not yet mastered":
  // a word scheduled for next week is not a word to be asked about today.
  const due = stats?.due ?? 0;

  if (reviewing) {
    return (
      <Review
        items={queue}
        onExit={() => {
          setReviewing(false);
          void reload();
        }}
      />
    );
  }

  return (
    <div className="page">
      <div className="lib-head">
        <h1>生词本</h1>
        {stats && (
          <span className="tag">
            {stats.total} 词 · 今日到期 {due} · 已掌握 {stats.known}
          </span>
        )}
        <span style={{ flex: 1 }} />

        <input
          className="input vocab-search"
          placeholder="搜索单词或例句…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        {/* The history is where the words the notebook declined live, so the
            way in sits next to the notebook it feeds. */}
        <button className="btn sm" onClick={() => nav('/vocab/history')} title="看都查过哪些词">
          查词历史
        </button>
        <button
          className="btn primary"
          disabled={due === 0 || preparing}
          title={due === 0 ? '今天没有到期的词' : '复习到期的词'}
          onClick={() => void startReview()}
        >
          {preparing ? '准备中…' : `复习 ${due}`}
        </button>
      </div>

      <div className="vocab-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`btn sm${filter === f.key ? ' primary' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading">加载中…</div>
      ) : items.length === 0 ? (
        <div className="empty">
          {keyword || filter
            ? filter === 'learning'
              ? '还没有「学习中」的词。复习时点「不记得」的词会落到这里。'
              : '没有匹配的词。'
            : '生词本还是空的。阅读时划选单词查一次，同一个词查第二次就会自动收录。'}
        </div>
      ) : (
        <div className="note-list">
          {items.map((it) => (
            <div className="note-card" key={it.id}>
              <button
                className="note-card-main"
                onClick={() => jump(it)}
                disabled={!it.bookId || !it.chapterId}
                title={it.bookTitle ? '回到原文' : '原书已删除'}
              >
                <div className="vocab-wordline">
                  <span className="vocab-word">{it.term}</span>
                  {it.phonetic && <span className="dict-phon">/{it.phonetic}/</span>}
                </div>
                <div className="vocab-trans">{it.translation || '（词库无释义）'}</div>
                {it.context && (
                  <div className="note-card-text">{emphasise(it.context, [it.surface, it.term])}</div>
                )}
                {/* Status sits on the metadata line, not in a column of its own:
                    it is a label about the word, and giving it a lane made the
                    row compete for width and pushed the page sideways on a
                    phone. `new` is the default and says nothing, so only a word
                    that has moved on wears a tag. */}
                <div className="note-card-meta vocab-meta">
                  <span className="vocab-meta-text">
                    {it.bookTitle ? `${it.bookTitle} · ${it.chapterTitle || '未知章节'}` : '原书已删除'}
                    {it.lookups > 1 && ` · 查过 ${it.lookups} 次`}
                    {it.reviews > 0 && ` · 复习 ${it.reviews} 次（${shortDate(it.lastReviewedAt)}）`}
                    {it.lapses > 0 && ` · 忘过 ${it.lapses} 次`}
                    {it.status !== 'ignored' && ` · ${scheduleLine(it.dueAt)}`}
                  </span>
                  {it.status !== 'new' && (
                    <span className={`vocab-status s-${it.status}`} title={STATUS_HINT[it.status]}>
                      {STATUS_LABEL[it.status]}
                    </span>
                  )}
                </div>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ review pass ------------------------------ */

type ReviewStats = { hit: number; miss: number; skipped: number };

/**
 * One pass over the words that are due. Each grade reschedules the word with
 * SM-2: a hit walks 1 day → 6 days → interval × ease, a miss drops back to a
 * ten-minute step. The header keeps a one-line receipt of what the last grade
 * just did, because a schedule nobody can see is indistinguishable from no
 * schedule at all.
 *
 * The card shows the word first and the meaning only after a click, because
 * reading the gloss straight away is what makes a card feel productive while
 * teaching nothing.
 */
function Review({ items, onExit }: { items: VocabItem[]; onExit: () => void }) {
  const [list] = useState(items);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [tally, setTally] = useState<ReviewStats>({ hit: 0, miss: 0, skipped: 0 });
  const [lastGrade, setLastGrade] = useState('');
  const busy = useRef(false);

  const cur = list[index];

  async function grade(didKnow: boolean) {
    if (!cur || busy.current) return;
    busy.current = true;
    try {
      // The Go side reschedules the word and hands the new state back, so the
      // card can say what happens next instead of just disappearing.
      const next = await api.gradeVocab(cur.id, didKnow);
      setLastGrade(
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

  if (!cur) {
    return (
      <div className="page">
        <div className="lib-head">
          <h1>本轮复习完成</h1>
        </div>
        <div className="empty">
          <p style={{ marginBottom: 6 }}>
            认识 {tally.hit} 个，还不认识 {tally.miss} 个
            {tally.skipped > 0 && `，跳过 ${tally.skipped} 个`}。
          </p>
          <p className="muted">
            {tally.miss > 0
              ? '答错的词十分钟后会回到队列里；答对的按 1 天、6 天、再按熟练度翻倍往后排。'
              : '这些词的间隔都往后推了，短期内不会再打扰你。'}
          </p>
          {lastGrade && <p className="muted">最后一个：{lastGrade}</p>}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button className="btn primary" onClick={onExit}>
            返回生词本
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="lib-head">
        <h1>复习</h1>
        <span className="tag">
          {index + 1} / {list.length}
        </span>
        {lastGrade && <span className="muted vocab-hint">{lastGrade}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={skip}>
          跳过
        </button>
        <button className="btn" onClick={onExit}>
          结束本轮
        </button>
      </div>

      <div className="review-card">
        <div className="review-word">{cur.term}</div>
        {cur.phonetic && <div className="review-phon">/{cur.phonetic}/</div>}
        <button className="btn sm" onClick={() => speakWord(cur.term)}>
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
          <button className="review-reveal" onClick={() => setRevealed(true)}>
            想好了，显示释义
          </button>
        )}

        <div className="review-actions">
          <button className="btn" disabled={!revealed} onClick={() => void grade(false)}>
            不记得
          </button>
          <button className="btn primary" disabled={!revealed} onClick={() => void grade(true)}>
            认识
          </button>
        </div>
      </div>
    </div>
  );
}
