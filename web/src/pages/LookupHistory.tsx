import { useEffect, useState } from 'react';
import { api, LookupHit } from '../api';
import { toast, toastError } from '../toast';
import SubHeader from '../components/SubHeader';
import { STATUS_LABEL } from '../vocabLabels';

/** "When did I last look this up", said the way a person would say it. */
function whenLabel(iso: string): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const days = Math.floor((Date.now() - at.getTime()) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return `${at.getFullYear() === new Date().getFullYear() ? '' : `${at.getFullYear()}年`}${at.getMonth() + 1}月${at.getDate()}日`;
}

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
  const [busy, setBusy] = useState('');

  // One dictionary lookup per row on the Go side, so the typing is debounced
  // the same way the notebook page does it.
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const list = await api.listLookupHistory(keyword);
        if (alive) setItems(list ?? []);
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
  }, [keyword]);

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

  const added = items.filter((it) => it.inNotebook).length;

  return (
    <div className="page">
      <SubHeader title="查词历史" tag={items.length > 0 ? `${items.length} 词 · 已收录 ${added}` : undefined} />

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
          {keyword
            ? '没有查过这个词。'
            : '还没有查词记录。阅读时点一下单词，这里就会留下一条。'}
        </div>
      ) : (
        <div className="note-list">
          {items.map((it) => (
            <div className="note-card" key={it.term}>
              <div className="note-card-body hist-body">
                <div className="vocab-wordline">
                  <span className="vocab-word">{it.term}</span>
                  {it.phonetic && <span className="dict-phon">/{it.phonetic}/</span>}
                </div>
                <div className="vocab-trans">{it.translation || '（词库无释义）'}</div>
                <div className="note-card-meta hist-meta">
                  <span className="hist-when">
                    查过 {it.lookups} 次 · {whenLabel(it.lastAt)}
                  </span>
                  {it.inNotebook ? (
                    <span className="hist-in">
                      已在生词本{it.status ? ` · ${STATUS_LABEL[it.status]}` : ''}
                    </span>
                  ) : (
                    <button
                      className="btn sm"
                      disabled={busy === it.term}
                      onClick={() => void add(it)}
                    >
                      {busy === it.term ? '加入中…' : '加入生词本'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
