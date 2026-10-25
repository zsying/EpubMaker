import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, VocabItem, VocabStats } from '../api';
import { toastError } from '../toast';
import { STATUS_HINT, STATUS_LABEL } from '../vocabLabels';
import { emphasise } from '../highlight';

type Filter = '' | 'new' | 'learning' | 'known';

const FILTERS: { key: Filter; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'new', label: '待学' },
  { key: 'learning', label: '学习中' },
  { key: 'known', label: '已掌握' },
];

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

/** When the word is due, said the way a schedule would: a word that was never
 * scheduled has no date to show, and saying "今天到期" about it would be wrong. */
function scheduleLine(dueAt: string): string {
  return dueAt ? `下次 ${dueLabel(dueAt)}` : '还没复习过';
}

export default function Vocab() {
  const nav = useNavigate();
  const [items, setItems] = useState<VocabItem[]>([]);
  const [stats, setStats] = useState<VocabStats | null>(null);
  const [filter, setFilter] = useState<Filter>('');
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);

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

  // What is worth reviewing right now — not "everything not yet mastered":
  // a word scheduled for next week is not a word to be asked about today.
  const due = stats?.due ?? 0;

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
        {/* A pass gets its own page: it is a mode with its own back header and
            no tab bar, and a route is the only way to give it both. */}
        <button
          className="btn primary"
          disabled={due === 0}
          title={due === 0 ? '今天没有到期的词' : '复习到期的词'}
          onClick={() => nav('/vocab/review')}
        >
          复习 {due}
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
          {items.map((it) => {
            const origin = it.bookTitle
              ? `${it.bookTitle} · ${it.chapterTitle || '未知章节'}`
              : '原书已删除';
            // Two things share one line, and only one of them can give way. The
            // study line is the reason the page exists, so it stays whole and
            // short — the schedule, not a tally; the provenance truncates. The
            // counters still exist, in the row's tooltip.
            const learn = it.status === 'ignored' ? '' : scheduleLine(it.dueAt);
            const counts = [
              it.lookups > 1 ? `查过 ${it.lookups} 次` : '',
              it.reviews > 0 ? `复习 ${it.reviews} 次` : '',
              it.lapses > 0 ? `忘过 ${it.lapses} 次` : '',
            ]
              .filter(Boolean)
              .join(' · ');
            const detail = [origin, counts, learn].filter(Boolean).join(' · ');

            return (
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
                  {/* One line, always. A long book title used to fold this row in
                      two and break "还没复习过" in the middle of a word, so the
                      provenance truncates with an ellipsis instead and the study
                      line beside it never wraps. Status is the last thing on the
                      line — a label, not a column of its own — and `new` is the
                      default, so only a word that has moved on wears a tag. */}
                  <div className="note-card-meta vocab-meta" title={detail}>
                    <span className="vocab-origin">{origin}</span>
                    {learn && <span className="vocab-learn">{learn}</span>}
                    {it.status !== 'new' && (
                      <span className={`vocab-status s-${it.status}`} title={STATUS_HINT[it.status]}>
                        {STATUS_LABEL[it.status]}
                      </span>
                    )}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
