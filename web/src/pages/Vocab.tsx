import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, VocabItem, VocabStats } from '../api';
import { toast, toastError } from '../toast';

const FILTERS: { key: '' | 'new' | 'learning' | 'known'; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'new', label: '待学' },
  { key: 'learning', label: '学习中' },
  { key: 'known', label: '已掌握' },
];

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

export default function Vocab() {
  const nav = useNavigate();
  const [items, setItems] = useState<VocabItem[]>([]);
  const [stats, setStats] = useState<VocabStats | null>(null);
  const [filter, setFilter] = useState<'' | 'new' | 'learning' | 'known'>('');
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState(false);

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

  async function remove(it: VocabItem) {
    try {
      await api.deleteVocab(it.id);
      await reload();
    } catch (e) {
      toastError(e);
    }
  }

  function jump(it: VocabItem) {
    if (!it.bookId || !it.chapterId) return;
    nav(`/books/${it.bookId}/read/${it.chapterId}`, { state: { offset: it.offset } });
  }

  // Words worth reviewing: everything not already mastered or explicitly
  // ignored. The review pass walks this queue once.
  const queue = useMemo(() => items.filter((it) => it.status === 'new' || it.status === 'learning'), [items]);

  if (reviewing) {
    return <Review items={queue} onExit={() => { setReviewing(false); void reload(); }} />;
  }

  return (
    <div className="page">
      <div className="lib-head">
        <h1>生词本</h1>
        {stats && (
          <span className="tag">
            {stats.total} 词 · 待学 {stats.new + stats.learning} · 已掌握 {stats.known}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <input
          className="input vocab-search"
          placeholder="搜索单词或例句…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <button className="btn primary" disabled={queue.length === 0} onClick={() => setReviewing(true)}>
          复习 {queue.length}
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
            ? '没有匹配的词。'
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
                  <span className={`vocab-status s-${it.status}`}>
                    {{ new: '待学', learning: '学习中', known: '已掌握', ignored: '已忽略' }[it.status]}
                  </span>
                </div>
                <div className="vocab-trans">{it.translation || '（词库无释义）'}</div>
                {it.context && (
                  <div className="note-card-text">{emphasise(it.context, [it.surface, it.term])}</div>
                )}
                <div className="note-card-meta">
                  {it.bookTitle ? `${it.bookTitle} · ${it.chapterTitle || '未知章节'}` : '原书已删除'}
                  {it.lookups > 1 && ` · 查过 ${it.lookups} 次`}
                </div>
              </button>
              <div className="vocab-actions">
                {it.status !== 'known' && (
                  <button className="btn sm" onClick={() => void markKnown(it)}>
                    已掌握
                  </button>
                )}
                <button className="btn sm danger" onClick={() => void remove(it)}>
                  删
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ review pass ------------------------------ */

/**
 * One pass over the words that are not yet mastered. Deliberately not an SRS:
 * there is no schedule yet, so promising "spaced repetition" would be a lie.
 * The card shows the word first and the meaning only after a click, because
 * reading the gloss straight away is what makes a card feel productive while
 * teaching nothing.
 */
function Review({ items, onExit }: { items: VocabItem[]; onExit: () => void }) {
  const [list] = useState(items);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [known, setKnown] = useState(0);
  const [again, setAgain] = useState(0);
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
      if (didKnow) {
        await api.setVocabStatus(cur.id, 'known');
        setKnown((n) => n + 1);
      } else {
        // Marking it "learning" keeps it in the queue for the next pass.
        await api.setVocabStatus(cur.id, 'learning');
        setAgain((n) => n + 1);
      }
    } catch (e) {
      toastError(e);
    } finally {
      busy.current = false;
      setRevealed(false);
      setIndex((i) => i + 1);
    }
  }

  if (!cur) {
    return (
      <div className="page">
        <div className="lib-head">
          <h1>本轮复习完成</h1>
        </div>
        <div className="empty">
          认识 {known} 个，还需再看 {again} 个。
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
            还不认识
          </button>
          <button className="btn primary" disabled={!revealed} onClick={() => void grade(true)}>
            认识
          </button>
        </div>
      </div>
    </div>
  );
}
