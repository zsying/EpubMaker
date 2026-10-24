import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, TrashItem } from '../api';
import { toast, toastError } from '../toast';
import SubHeader from '../components/SubHeader';

function fmt(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}

export default function Trash() {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    try {
      setItems(await api.trash());
    } catch (e) {
      toastError(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function restore(it: TrashItem) {
    if (!confirm(`确定恢复《${it.title}》？恢复后将重新出现在书库中。`)) return;
    setBusyId(it.id);
    try {
      const book = await api.restoreTrash(it.id);
      toast(`已恢复《${book.title}》`, 'success');
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusyId(null);
    }
  }

  async function purge(it: TrashItem) {
    if (
      !confirm(
        `确定彻底删除《${it.title}》？此操作不可恢复（数据库记录与磁盘文件都会被删除）。`
      )
    )
      return;
    setBusyId(it.id);
    try {
      const out = await api.purgeTrash(it.id);
      toast(out.dataKept ? '已彻底删除（磁盘文件因受限保留在回收区）' : '已彻底删除', 'success');
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <SubHeader title="回收站" tag={`${items.length} 项`}>
        <Link className="btn" to="/">
          返回书架
        </Link>
      </SubHeader>

      {loading ? (
        <div className="loading">加载中…</div>
      ) : items.length === 0 ? (
        <div className="empty">
          <p>回收站是空的。</p>
          <p className="muted" style={{ fontSize: 12.5 }}>
            删除书籍时会移入回收站，可在此恢复或彻底删除。
          </p>
        </div>
      ) : (
        <div className="pane" style={{ padding: 8 }}>
          {items.map((it) => (
            <div
              key={it.dirName}
              className="split-row"
              style={{ gap: 12, padding: '10px 12px', borderBottom: '1px solid #f0f2f6' }}
            >
              <span className="cover-thumb is-ph" style={{ flex: 'none' }}>
                <span>删</span>
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  className="name"
                  style={{ fontSize: 13.5, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={it.title}
                >
                  {it.title}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                  {it.recoverable ? `${it.author || '未知作者'} · 删除于 ${fmt(it.deletedAt)}` : '该条目的原数据库记录已丢失，无法恢复，只能彻底删除'}
                </div>
              </div>
              <button
                className="btn sm"
                disabled={!it.recoverable || busyId === it.id}
                onClick={() => void restore(it)}
              >
                {busyId === it.id ? '处理中…' : '恢复'}
              </button>
              <button
                className="btn sm danger"
                disabled={busyId === it.id}
                onClick={() => void purge(it)}
              >
                彻底删除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
