import { useCallback, useEffect, useRef, useState } from 'react';
import { api, LookupHit } from '../api';
import { toast, toastError } from '../toast';
import SubHeader from '../components/SubHeader';
import LookupCard from '../components/LookupCard';
import { STATUS_LABEL, whenLabel } from '../vocabLabels';
import { useLoadMore } from '../useLoadMore';

/**
 * Rows per request. The history records every tap forever — it is the one list
 * in the app that has no natural ceiling — so it is read a screenful at a time
 * and never fetched whole.
 */
const PAGE = 40;

/**
 * Everything the reader has ever looked up, newest first.
 *
 * This is the notebook's second-level page and its raw material: reading fills
 * it automatically, and the words the automatic rule declined to keep — basic
 * vocabulary, one-off curiosities — are exactly the ones worth a second look
 * here. Adding one is explicit, because the notebook has no delete: a word that
 * goes in stays in and gets a review schedule.
 */
export default function LookupHistory() {
  const [items, setItems] = useState<LookupHit[]>([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  // Set when a page fetch failed: automatic loading stops so a failing request
  // cannot retry on every scroll frame, and the button becomes '重试'.
  const [stalled, setStalled] = useState(false);
  /** Matching rows in the database, not rows on screen. */
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState('');
  /** The word whose card is open, by term: the row is the state of record. */
  const [cardTerm, setCardTerm] = useState<string | null>(null);

  // Offsets are tracked apart from `items.length`: a row dropped as a duplicate
  // must not shift the next request and make the page skip a word.
  const cursor = useRef(0);
  const query = useRef(0);

  // One dictionary lookup per row on the Go side, so the typing is debounced
  // the same way the notebook page does it.
  useEffect(() => {
    let alive = true;
    const seq = ++query.current;
    setLoading(true);
    // An in-flight page belongs to the previous keyword and will never clear
    // this flag itself, so reset it here.
    setLoadingMore(false);
    setStalled(false);
    const timer = setTimeout(async () => {
      try {
        const page = await api.listLookupHistory(keyword, 0, PAGE);
        if (!alive || seq !== query.current) return;
        const rows = page?.items ?? [];
        cursor.current = rows.length;
        setItems(rows);
        setHasMore(Boolean(page?.hasMore));
        setTotal(page?.total ?? rows.length);
      } catch (e) {
        if (alive && seq === query.current) toastError(e);
      } finally {
        if (alive && seq === query.current) setLoading(false);
      }
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [keyword]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || !hasMore) return;
    const seq = query.current;
    const offset = cursor.current;
    setLoadingMore(true);
    try {
      const page = await api.listLookupHistory(keyword, offset, PAGE);
      if (seq !== query.current) return;
      const more = page?.items ?? [];
      cursor.current = offset + more.length;
      setItems((prev) => {
        const seen = new Set(prev.map((p) => p.term));
        return [...prev, ...more.filter((p) => !seen.has(p.term))];
      });
      setHasMore(Boolean(page?.hasMore));
      setTotal(page?.total ?? offset + more.length);
      setStalled(false);
    } catch (e) {
      toastError(e);
      if (seq === query.current) setStalled(true);
    } finally {
      if (seq === query.current) setLoadingMore(false);
    }
  }, [keyword, loading, loadingMore, hasMore]);

  const sentinel = useLoadMore(
    !loading && !loadingMore && hasMore && !stalled,
    () => void loadMore(),
  );

  async function add(hit: LookupHit) {
    if (busy) return;
    setBusy(hit.term);
    try {
      // No book and no sentence: the history knows the word, not where it was
      // met. The notebook row is still complete enough to be reviewed.
      await api.vocabAdd(hit.term, hit.term, '', '', 0, '');
      setItems((prev) =>
        prev.map((it) => (it.term === hit.term ? { ...it, inNotebook: true, status: 'new' } : it)),
      );
      toast(`已加入生词本：${hit.term}`, 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy('');
    }
  }

  // Drawn from the list, not a copy: adding the word updates the row, and the
  // card that is still open behind it must say 已在生词本 without being closed.
  const card = cardTerm ? (items.find((it) => it.term === cardTerm) ?? null) : null;

  return (
    <div className="page">
      {/* The number is the whole history, not the part on screen: the page is
          read a screenful at a time, and '40 词' that keeps growing as you
          scroll would be a lie about how much is there. */}
      <SubHeader title="查词历史" tag={total > 0 ? `共 ${total} 词` : undefined} />

      <div className="hist-toolbar">
        <input
          className="input hist-search"
          placeholder="搜索查过的单词…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="loading">加载中…</div>
      ) : items.length === 0 ? (
        <div className="empty">
          {keyword ? '没有查过这个词。' : '还没有查词记录。阅读时点一下单词，这里就会留下一条。'}
        </div>
      ) : (
        <>
          <div className="note-list">
            {items.map((it) => (
              <div className="note-card" key={it.term}>
                {/* The row opens the word's card — the same tap the notebook's
                    rows answer — and the card is where the word is added. */}
                <button className="note-card-main hist-body" onClick={() => setCardTerm(it.term)}>
                  <div className="vocab-wordline">
                    <span className="vocab-word">{it.term}</span>
                    {it.phonetic && <span className="dict-phon">/{it.phonetic}/</span>}
                  </div>
                  <div className="vocab-trans">{it.translation || '（词库无释义）'}</div>
                  <div className="note-card-meta hist-meta">
                    <span className="hist-when">
                      查过 {it.lookups} 次 · {whenLabel(it.lastAt)}
                    </span>
                    <span className={it.inNotebook ? 'hist-in' : 'hist-out'}>
                      {it.inNotebook
                        ? `已在生词本${it.status ? ` · ${STATUS_LABEL[it.status]}` : ''}`
                        : '未加入生词本'}
                    </span>
                  </div>
                </button>
              </div>
            ))}
          </div>
          {/* Same as the notebook: the next screenful arrives on scroll, and
              the button is both the fallback and the progress read-out. */}
          <div className="list-foot" ref={sentinel}>
            {loadingMore ? (
              <span className="list-foot-busy">加载更多…</span>
            ) : hasMore ? (
              <button
                className="btn sm"
                onClick={() => {
                  setStalled(false);
                  void loadMore();
                }}
              >
                {stalled ? '重试' : '加载更多'} · 已显示 {items.length}/{total}
              </button>
            ) : total > PAGE ? (
              <span className="list-foot-end">已显示全部 {total} 个词</span>
            ) : null}
          </div>
        </>
      )}

      {card && (
        <LookupCard
          hit={card}
          busy={busy === card.term}
          onClose={() => setCardTerm(null)}
          onAdd={() => void add(card)}
        />
      )}
    </div>
  );
}
