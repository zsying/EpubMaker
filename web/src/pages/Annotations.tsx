import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, AnnotationListItem } from '../api';
import { toastError } from '../toast';
import SubHeader from '../components/SubHeader';

export default function Annotations() {
  const nav = useNavigate();
  const [items, setItems] = useState<AnnotationListItem[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const list = await api.listAllAnnotations();
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
      await api.deleteAnnotation(id);
      setItems((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      toastError(e);
    }
  }

  function jump(a: AnnotationListItem) {
    // `preview` puts the reader in its locked visit mode: the page opens on the
    // highlighted range (selected, toolbar up) and the reading position stays
    // untouched.
    nav(`/books/${a.bookId}/read/${a.chapterId}`, {
      state: {
        preview: {
          source: 'annotation',
          label: a.text,
          offset: a.startOffset,
          end: a.endOffset,
        },
      },
    });
  }

  return (
    <div className="page">
      <SubHeader title="划线 / 批注" tag={`${items.length} 条`} />

      {loading ? (
        <div className="loading">加载中…</div>
      ) : items.length === 0 ? (
        <div className="empty">还没有划线或批注；在按页阅读时划选文字即可添加。</div>
      ) : (
        <div className="note-list">
          {items.map((a) => (
            <div className="note-card" key={a.id}>
              <button className="note-card-main" onClick={() => jump(a)}>
                <div className="note-card-title">
                  <span className={`dot hl-${a.color}`} />
                  {a.bookTitle}
                </div>
                <div className="note-card-meta">{a.chapterTitle}</div>
                <div className="note-card-text">{a.text}</div>
                {a.note && <div className="note-card-note">批注：{a.note}</div>}
              </button>
              <button className="btn sm danger" onClick={() => void remove(a.id)}>
                删
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
