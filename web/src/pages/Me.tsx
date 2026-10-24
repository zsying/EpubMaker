import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, DictStatus, pickDictFile } from '../api';
import { toast, toastError } from '../toast';

/**
 * The mobile「我的」tab. The desktop top bar spreads the low-frequency
 * destinations across six links; on a phone they live here as one list, so the
 * bottom bar only needs three tabs for the things that matter daily.
 */
const ENTRIES = [
  { to: '/bookmarks', title: '书签', desc: '按书保存的阅读位置' },
  { to: '/annotations', title: '划线', desc: '高亮与批注' },
  { to: '/trash', title: '回收站', desc: '已删除的书' },
  { to: '/webdav', title: 'WebDAV', desc: '远程书库连接与导入' },
  { to: '/settings', title: '设置', desc: '字体、翻页模式等阅读偏好' },
];

export default function Me() {
  const [dict, setDict] = useState<DictStatus | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .dictStatus()
      .then((d) => {
        if (alive) setDict(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // The dictionary row is a button, not a status line: tapping it opens the
  // host's file picker (SAF on the phone) and builds the dictionary from the
  // chosen ECDICT csv. Importing a full dictionary blocks the binding call for
  // a while, so the row flips to a busy label until it lands.
  async function importDict() {
    if (importing) return;
    let path: string | null = null;
    try {
      path = await pickDictFile();
    } catch (e) {
      toastError(e);
      return;
    }
    if (!path) return; // cancelled
    setImporting(true);
    try {
      const res = await api.dictImport(path);
      const fresh = await api.dictStatus();
      setDict(fresh);
      toast(`词库导入完成 · ${res.entries} 条`, 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setImporting(false);
    }
  }

  const dictDesc = importing
    ? '正在导入，大词库可能需要一两分钟…'
    : dict?.installed
      ? `已安装 · ${dict.entries} 条 · 点击更换词库`
      : '未安装 · 点击选择词库 CSV 文件导入';

  return (
    <div className="page me-page">
      <div className="lib-head">
        <h1>我的</h1>
      </div>

      <div className="me-list">
        {ENTRIES.map((e) => (
          <Link key={e.to} className="me-row" to={e.to}>
            <span className="me-row-text">
              <span className="me-row-title">{e.title}</span>
              <span className="me-row-desc">{e.desc}</span>
            </span>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M5 3 L10 7 L5 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </Link>
        ))}
      </div>

      <button type="button" className="me-dict" disabled={importing} onClick={() => void importDict()}>
        <span>查词词库</span>
        <span className={dict?.installed || importing ? 'tag' : 'tag muted-tag'}>{dictDesc}</span>
      </button>
    </div>
  );
}
