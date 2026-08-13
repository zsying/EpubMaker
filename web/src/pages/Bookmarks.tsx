import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, BookmarkListItem } from '../api';
import { toastError } from '../toast';

export default function Bookmarks() {
  const nav = useNavigate();
  const [items, setItems] = useState<BookmarkListItem[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const list = await api.listAllBookmarks();
      setItems(list);
    } catch (e) {
      toastError(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function remove(id: string) {
    try {
      await api.deleteBookmark(id);
      setItems((prev) => prev.filter((b) => b.id !== id));
    } catch (e) {
      toastError(e);
    }
  }

  function jump(b: BookmarkListItem) {
    nav(`/books/${b.bookId}/read/${b.chapterId}`, { state: { page: b.anchor } });
  }

  return (
    <div className="page">
      <div className="lib-head">
        <h1>书签</h1>
        <span className="tag">{items.length} 条</span>
      </div>

      {loading ? (
        <div className="loading">加载中…</div>
      ) : items.length === 0 ? (
        <div className="empty">还没有书签；在阅读器里按页阅读时可随时添加。</div>
      ) : (
        <div className="note-list">
          {items.map((b) => (
            <div className="note-card" key={b.id}>
              <button className="note-card-main" onClick={() => jump(b)}>
                <div className="note-card-title">{b.bookTitle}</div>
                <div className="note-card-meta">
                  {b.chapterTitle} · 第 {b.anchor + 1} 页
                  {b.label ? ' · ' + b.label : ''}
                </div>
              </button>
              <button className="btn sm danger" onClick={() => void remove(b.id)}>
                删
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
