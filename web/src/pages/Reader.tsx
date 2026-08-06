import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { api, Book, Chapter } from '../api';
import { toastError } from '../toast';

const FONT_KEY = 'epubmaker.fontSize';
const posKey = (id: string) => `epubmaker.pos.${id}`;

export default function Reader() {
  const { id = '', chapterId } = useParams();
  const nav = useNavigate();
  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem(FONT_KEY)) || 17);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const [b, cs] = await Promise.all([api.getBook(id), api.listChapters(id)]);
        setBook(b);
        setChapters(cs);
        const saved = localStorage.getItem(posKey(id));
        const target =
          (chapterId && cs.find((c) => c.id === chapterId)?.id) ||
          (saved && cs.find((c) => c.id === saved)?.id) ||
          cs[0]?.id ||
          null;
        setCurrent(target);
      } catch (e) {
        toastError(e);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!current) return;
    localStorage.setItem(posKey(id), current);
    (async () => {
      try {
        const r = await api.renderChapter(id, current);
        setHtml(r.html);
        mainRef.current?.scrollTo({ top: 0, behavior: 'auto' });
      } catch (e) {
        toastError(e);
        setHtml('<p class="muted">章节内容读取失败</p>');
      }
    })();
  }, [id, current]);

  useEffect(() => localStorage.setItem(FONT_KEY, String(fontSize)), [fontSize]);

  const safeHtml = useMemo(
    () => DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['script', 'style', 'link'] }),
    [html]
  );

  const idx = chapters.findIndex((c) => c.id === current);
  const prev = idx > 0 ? chapters[idx - 1] : null;
  const next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowLeft' && prev) setCurrent(prev.id);
      if (e.key === 'ArrowRight' && next) setCurrent(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, next]);

  if (loading) return <div className="loading">加载中…</div>;
  if (!book) return <div className="page empty">书籍不存在</div>;

  return (
    <div className="reader">
      <aside className="toc">
        <div className="toc-head">目录 · {chapters.length} 章</div>
        {chapters.map((c, i) => (
          <button
            key={c.id}
            className={`toc-item${c.id === current ? ' active' : ''}`}
            onClick={() => setCurrent(c.id)}
            title={c.title}
          >
            <span className="num">{String(i + 1).padStart(2, '0')}</span>
            {c.title}
          </button>
        ))}
      </aside>

      <div className="reader-main" ref={mainRef}>
        <div className="reader-toolbar">
          <div className="crumb">
            <strong>{book.title}</strong>
            <span>·</span>
            <span>{book.author || '未知作者'}</span>
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => setFontSize((f) => Math.max(13, f - 1))}>
            A−
          </button>
          <span className="muted" style={{ fontSize: 12, minWidth: 30, textAlign: 'center' }}>
            {fontSize}
          </span>
          <button className="btn sm" onClick={() => setFontSize((f) => Math.min(26, f + 1))}>
            A+
          </button>
          <Link className="btn sm" to={`/books/${id}/edit`}>
            整理
          </Link>
          <button className="btn sm" onClick={() => nav('/')}>
            书架
          </button>
        </div>

        <article className="reader-paper">
          <div
            className="reader-content"
            style={{ fontSize }}
            dangerouslySetInnerHTML={{ __html: safeHtml }}
          />
        </article>

        <div className="reader-nav">
          <button className="btn" disabled={!prev} onClick={() => prev && setCurrent(prev.id)}>
            ← {prev ? prev.title.slice(0, 18) : '已是第一章'}
          </button>
          <button className="btn" disabled={!next} onClick={() => next && setCurrent(next.id)}>
            {next ? next.title.slice(0, 18) : '已是最后一章'} →
          </button>
        </div>
      </div>
    </div>
  );
}
