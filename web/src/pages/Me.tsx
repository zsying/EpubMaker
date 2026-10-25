import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, DictStatus, pickDictFile } from '../api';
import { useBackClose } from '../backNav';
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
  { to: '/wifi', title: 'Wi-Fi 传书', desc: '电脑扫码，局域网直传 EPUB' },
  { to: '/settings', title: '设置', desc: '字体、翻页模式等阅读偏好' },
  { to: '/about', title: '关于', desc: '版本与系统信息' },
];

// Formats the advertised size of a downloadable dictionary ("约 18 MB").
function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `约 ${Math.round(n / (1 << 20))} MB`;
  if (n >= 1024) return `约 ${Math.round(n / 1024)} KB`;
  return '';
}

// The downloadable catalog comes from the backend; the fallback keeps the
// sheet usable against an older backend that predates DictSources.
const FALLBACK_SOURCES = [{ id: 'ecdict-mini', name: 'ECDICT 精简词库', desc: '', bytes: 0 }];

export default function Me() {
  const [dict, setDict] = useState<DictStatus | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sources, setSources] = useState(FALLBACK_SOURCES);
  // Downloading and importing both block their binding call; the sheet stays
  // up with a busy label until the backend answers.
  const [busy, setBusy] = useState<null | { kind: 'download' | 'import'; label: string }>(null);

  // Hardware back closes the dictionary sheet instead of leaving the page.
  useBackClose(sheetOpen, () => setSheetOpen(false));

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

  // Load the catalog the first time the sheet opens; a failure (old backend,
  // transient) falls back to the built-in default entry.
  useEffect(() => {
    if (!sheetOpen || sources !== FALLBACK_SOURCES) return;
    let alive = true;
    api
      .dictSources()
      .then((s) => {
        if (alive && Array.isArray(s) && s.length > 0) setSources(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sheetOpen, sources]);

  async function refreshStatus() {
    try {
      setDict(await api.dictStatus());
    } catch {
      /* keep the old status */
    }
  }

  // One-tap online download: the catalog source is fetched and imported by the
  // backend in a single blocking call. First run downloads ~18 MB and builds
  // the database; later runs reuse the cached CSV and only re-import.
  async function downloadDict(id: string) {
    if (busy) return;
    setBusy({ kind: 'download', label: '正在下载词库，首次需要几分钟…' });
    try {
      const res = await api.downloadDict(id);
      await refreshStatus();
      toast(`词库安装完成 · ${res.entries} 条`, 'success');
      setSheetOpen(false);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  // Local import from the host file picker (SAF on the phone) for users who
  // already have the full ECDICT csv or a custom one.
  async function importDictFile() {
    if (busy) return;
    let path: string | null = null;
    try {
      path = await pickDictFile();
    } catch (e) {
      toastError(e);
      return;
    }
    if (!path) return; // cancelled
    setBusy({ kind: 'import', label: '正在导入词库…' });
    try {
      const res = await api.dictImport(path);
      await refreshStatus();
      toast(`词库导入完成 · ${res.entries} 条`, 'success');
      setSheetOpen(false);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  const dictDesc = busy
    ? busy.label
    : dict?.installed
      ? `已安装 · ${dict.entries} 条 · 点击更换`
      : '未安装 · 点击下载或导入';

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
              <path
                d="M5 3 L10 7 L5 11"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </Link>
        ))}
      </div>

      <button
        type="button"
        className="me-dict"
        disabled={!!busy}
        onClick={() => setSheetOpen(true)}
      >
        <span>查词词库</span>
        <span className={dict?.installed || busy ? 'tag' : 'tag muted-tag'}>{dictDesc}</span>
      </button>

      {sheetOpen && (
        <div className="sheet-mask" onClick={() => !busy && setSheetOpen(false)}>
          <div className="sheet" role="menu" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-title">查词词库</div>
            {sources.map((s) => (
              <button key={s.id} className="sheet-item" onClick={() => void downloadDict(s.id)}>
                在线下载{s.name}
                {s.bytes > 0 ? `（${fmtBytes(s.bytes)}）` : ''}
              </button>
            ))}
            <button className="sheet-item" onClick={() => void importDictFile()}>
              从本地文件导入（ECDICT CSV）
            </button>
            <button
              className="sheet-item cancel"
              disabled={!!busy}
              onClick={() => setSheetOpen(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
