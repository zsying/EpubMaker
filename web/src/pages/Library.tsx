import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, AppPaths, Book } from '../api';
import { toast, toastError } from '../toast';

export default function Library() {
  const [books, setBooks] = useState<Book[]>([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [over, setOver] = useState(false);
  const [paths, setPaths] = useState<AppPaths | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();

  const load = useCallback(async (kw?: string) => {
    setLoading(true);
    try {
      setBooks(await api.listBooks(kw));
    } catch (e) {
      toastError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    api.paths().then(setPaths).catch(() => undefined);
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => void load(keyword.trim() || undefined), 260);
    return () => clearTimeout(t);
  }, [keyword, load]);

  async function doImport(files: FileList | File[] | null) {
    const list = Array.from(files ?? []).filter((f) => /\.epub$/i.test(f.name));
    if (!list.length) return toast('请选择 .epub 文件', 'error');
    setImporting(true);
    try {
      const res = await api.importBooks(list);
      toast(`成功导入 ${res.books.length} 本书籍`, 'success');
      if (res.errors?.length) toast(res.errors.join('\n'), 'error', 6000);
      await load(keyword.trim() || undefined);
    } catch (e) {
      toastError(e);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function remove(book: Book) {
    if (!confirm(`确定删除《${book.title}》？该书将移入回收站，可随时恢复。`)) return;
    try {
      await api.deleteBook(book.id);
      toast('已移入回收站', 'success');
      await load(keyword.trim() || undefined);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="page">
      <div className="lib-head">
        <h1>书架</h1>
        <span className="tag">{books.length} 本</span>
        <span style={{ flex: 1 }} />
        <Link className="btn ghost" to="/trash">
          回收站
        </Link>
        <input
          className="input"
          style={{ width: 220 }}
          placeholder="搜索书名或作者…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <button className="btn primary" disabled={importing} onClick={() => fileRef.current?.click()}>
          {importing ? '导入中…' : '导入 EPUB'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".epub,application/epub+zip"
          multiple
          hidden
          onChange={(e) => void doImport(e.target.files)}
        />
      </div>

      <div
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void doImport(e.dataTransfer.files);
        }}
        onClick={() => fileRef.current?.click()}
      >
        {importing ? '正在解析 EPUB…' : '把 .epub 文件拖到这里，或点击选择文件（支持多选）'}
      </div>

      {loading ? (
        <div className="loading">加载中…</div>
      ) : books.length === 0 ? (
        <div className="empty">
          <p style={{ fontSize: 15, marginBottom: 6 }}>书架还是空的</p>
          <p>导入第一本 EPUB 开始整理吧</p>
        </div>
      ) : (
        <div className="grid">
          {books.map((b) => (
            <div className="book-card" key={b.id}>
              <div className="cover" onClick={() => nav(`/books/${b.id}/read`)} style={{ cursor: 'pointer' }}>
                {b.coverUrl ? (
                  <img src={b.coverUrl} alt={b.title} loading="lazy" />
                ) : (
                  <div className="placeholder">{b.title}</div>
                )}
              </div>
              <div className="book-body">
                <div className="book-title" title={b.title}>
                  {b.title}
                </div>
                <div className="book-meta">{b.author || '未知作者'}</div>
                <div className="book-meta">{b.chapterCount} 章</div>
              </div>
              <div className="book-actions">
                <Link className="btn sm" to={`/books/${b.id}/read`}>
                  阅读
                </Link>
                <Link className="btn sm" to={`/books/${b.id}/edit`}>
                  整理
                </Link>
                <Link className="btn sm" to={`/books/${b.id}/split`}>
                  拆分
                </Link>
                <a className="btn sm" href={api.exportUrl(b.id)}>
                  导出
                </a>
                <button className="btn sm danger" onClick={() => void remove(b)}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {paths && (
        <div style={{ marginTop: 40, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.9 }}>
          <div>
            <strong style={{ color: 'var(--text-2)' }}>存储位置</strong>（可在 config.json 中修改）
          </div>
          <div>配置文件：{paths.configFile}</div>
          <div>数据目录：{paths.dataDir}</div>
          <div>导出目录：{paths.exportDir}</div>
          <div>日志目录：{paths.logDir}</div>
        </div>
      )}
    </div>
  );
}
