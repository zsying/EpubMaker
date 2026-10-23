import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, VocabItem, VocabStats } from '../api';
import { toast, toastError } from '../toast';

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

const STATUS_HINT: Record<VocabItem['status'], string> = {
  new: '查词时自动收录，还没有复习过',
  learning: '复习时没答上来，还没记住',
  known: '已掌握，不再出现在复习队列里',
  ignored: '不再提示',
};

const STATUS_LABEL: Record<VocabItem['status'], string> = {
  new: '待学',
  learning: '学习中',
  known: '已掌握',
  ignored: '已忽略',
};

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

  // Deleting a word is rare and irreversible, so it is behind a mode: the
  // per-row button would otherwise sit one slip away from every row.
  const [deleting, setDeleting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());

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
        setItems(list);
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

  // Selection is scoped to what is on screen: a hidden word must not be
  // deleted by a confirmation that never showed it.
  useEffect(() => {
    setPicked(new Set());
  }, [filter, keyword]);

  async function reload() {
    try {
      const [list, st] = await Promise.all([api.listVocab(filter, keyword), api.vocabStats()]);
      setItems(list);
      setStats(st);
    } catch (e) {
      toastError(e);
    }
  }

  async function markKnown(it: VocabItem) {
    try {
      await api.setVocabStatus(it.id, 'known');
      await reload();
      toast(`已标记掌握：${it.term}`, 'success');
    } catch (e) {
      toastError(e);
    }
  }

  function togglePick(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function leaveDeleteMode() {
    setDeleting(false);
    setPicked(new Set());
  }

  async function confirmDelete() {
    const ids = [...picked];
    if (ids.length === 0) return;
    if (!confirm(`从生词本删除这 ${ids.length} 个词？此操作不可撤销。`)) return;
    try {
      await Promise.all(ids.map((id) => api.deleteVocab(id)));
      toast(`已删除 ${ids.length} 个词`, 'success');
      leaveDeleteMode();
      await reload();
    } catch (e) {
      toastError(e);
    }
  }

  function jump(it: VocabItem) {
    if (!it.bookId || !it.chapterId) return;
    nav(`/books/${it.bookId}/read/${it.chapterId}`, {
      state: {
        offset: it.offset,
        // Marking the visit as a detour is what keeps it from overwriting the
        // reading position: the reader came here to see one word, not to read.
        detour: { word: it.term, surface: it.surface || it.term, offset: it.offset },
      },
    });
  }

  async function startReview() {
    setPreparing(true);
    try {
      const q = await api.vocabQueue(REVIEW_LIMIT);
      if (q.length === 0) {
        toast('没有需要复习的词', 'info');
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

  const pending = stats ? stats.new + stats.learning : 0;
  const allPicked = items.length > 0 && picked.size === items.length;

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
            {stats.total} 词 · 待学 {pending} · 已掌握 {stats.known}
          </span>
        )}
        <span style={{ flex: 1 }} />

        {deleting ? (
          <>
            <span className="muted">已选 {picked.size} 个</span>
            <button
              className="btn sm"
              onClick={() => setPicked(allPicked ? new Set() : new Set(items.map((it) => it.id)))}
            >
              {allPicked ? '取消全选' : '全选'}
            </button>
            <button className="btn sm" onClick={leaveDeleteMode}>
              取消
            </button>
            <button className="btn sm danger" disabled={picked.size === 0} onClick={() => void confirmDelete()}>
              删除 {picked.size}
            </button>
          </>
        ) : (
          <>
            <input
              className="input vocab-search"
              placeholder="搜索单词或例句…"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            <button className="btn sm" onClick={() => setDeleting(true)} disabled={items.length === 0} title="批量删除单词">
              删除
            </button>
            <button className="btn primary" disabled={pending === 0 || preparing} onClick={() => void startReview()}>
              {preparing ? '准备中…' : `复习 ${pending}`}
            </button>
          </>
        )}
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
        {deleting && <span className="muted vocab-hint">正在删除：点击单词选中，可多选</span>}
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
            <div className={`note-card${picked.has(it.id) ? ' picked' : ''}`} key={it.id}>
              {deleting && (
                <span className={`vocab-check${picked.has(it.id) ? ' on' : ''}`} aria-hidden>
                  {picked.has(it.id) ? '✓' : ''}
                </span>
              )}
              <button
                className="note-card-main"
                onClick={() => (deleting ? togglePick(it.id) : jump(it))}
                disabled={!deleting && (!it.bookId || !it.chapterId)}
                title={deleting ? '选中' : it.bookTitle ? '回到原文' : '原书已删除'}
              >
                <div className="vocab-wordline">
                  <span className="vocab-word">{it.term}</span>
                  {it.phonetic && <span className="dict-phon">/{it.phonetic}/</span>}
                  <span className={`vocab-status s-${it.status}`} title={STATUS_HINT[it.status]}>
                    {STATUS_LABEL[it.status]}
                  </span>
                </div>
                <div className="vocab-trans">{it.translation || '（词库无释义）'}</div>
                {it.context && (
                  <div className="note-card-text">{emphasise(it.context, [it.surface, it.term])}</div>
                )}
                <div className="note-card-meta">
                  {it.bookTitle ? `${it.bookTitle} · ${it.chapterTitle || '未知章节'}` : '原书已删除'}
                  {it.lookups > 1 && ` · 查过 ${it.lookups} 次`}
                  {it.reviews > 0 && ` · 复习 ${it.reviews} 次（${shortDate(it.lastReviewedAt)}）`}
                </div>
              </button>
              {!deleting && (
                <div className="vocab-actions">
                  {it.status !== 'known' && (
                    <button className="btn sm" onClick={() => void markKnown(it)}>
                      已掌握
                    </button>
                  )}
                </div>
              )}
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
 * One pass over the words that are not yet mastered. It is not an SRS: there is
 * no interval schedule yet, only an order (unseen first, then whatever has
 * waited longest), so calling it spaced repetition would be a lie.
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
  const busy = useRef(false);

  const cur = list[index];

  function speak(text: string) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 0.9;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {
      /* speech synthesis unavailable in this WebView */
    }
  }

  async function grade(didKnow: boolean) {
    if (!cur || busy.current) return;
    busy.current = true;
    try {
      // A miss is what puts the word into `learning` — and the Go side records
      // the review either way, so "seen 3 times" is a fact, not a guess.
      await api.gradeVocab(cur.id, didKnow);
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
          认识 {tally.hit} 个，还不认识 {tally.miss} 个
          {tally.skipped > 0 && `，跳过 ${tally.skipped} 个`}。
          {tally.miss > 0 && '答错的词已进入「学习中」，下一轮会排在前面。'}
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
        <button className="btn sm" onClick={() => speak(cur.term)}>
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
