import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, DictStatus, pickDictFile } from '../api';
import { FONT_CATALOG } from '../components/FontPicker';
import { useBackClose } from '../backNav';
import { toast, toastError } from '../toast';
import {
  APP_THEMES,
  FONT_FAMILY_KEY,
  FONT_SIZE_KEY,
  MODE_KEY,
  appTheme,
  type ReadMode,
} from '../readingPrefs';

/**
 * 「我的」tab.
 *
 * The page is four intent groups, not a list of links (2026-10-28)
 * ---------------------------------------------------------------
 * It used to be seven flat rows plus a dictionary button floating outside the
 * list, which made 查词词库, WebDAV and 设置 look like siblings of the same
 * weight — and gave the reader no way to tell where to go first.
 *
 * The rule now: a group is a thing the reader wants to DO (调阅读 / 看笔记 /
 * 搬书 / 配工具), a row is a page inside it, and every row answers "what is
 * the state right now" on the right — a count, a connection, a model name.
 * Without that value a row is only a signpost.
 *
 * Two row sizes carry the hierarchy: `.tall` (36px coloured tile, two lines)
 * for the two things used weekly, the standard row (32px grey tile) for the
 * rest. The dictionary stays a sheet, not a page: it has four actions and no
 * content of its own.
 */

const WEBDAV_KEY = 'epubmaker.webdav.conn';

// Inline icons, stroked with currentColor so the tile colour is one CSS rule.
const ICON = {
  prefs: (
    <svg width="19" height="19" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M3.6 13.4 7.8 3.9h1.2l4.2 9.5M5.4 10.2h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 16.8h14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity=".4"
      />
    </svg>
  ),
  dict: (
    <svg width="19" height="19" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M3.4 3.6h6.2c.7 0 1.2.5 1.2 1.2v10c0-.7-.5-1.2-1.2-1.2H3.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="13.6" cy="12.4" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M15.9 14.7 17.6 16.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  bookmark: (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M4.6 2.6h8.8v12.8l-4.4-3.2-4.4 3.2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  ),
  pen: (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M3.4 14.4l1.2-3.6 7-7 2.4 2.4-7 7z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M9.8 4.6l2.4 2.4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  cloud: (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M5 13.2a2.7 2.7 0 0 1 .3-5.4 4 4 0 0 1 7.7-.8 2.9 2.9 0 0 1-.4 5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  globe: (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M3.2 9h11.6M9 2.6c1.6 1.8 2.4 3.9 2.4 6.4S10.6 13.6 9 15.4C7.4 13.6 6.6 11.5 6.6 9S7.4 4.4 9 2.6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  ),
  wifi: (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M2.9 7a9 9 0 0 1 12.2 0M5.5 10a5.6 5.6 0 0 1 7 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="9" cy="13.2" r="1.2" fill="currentColor" />
    </svg>
  ),
  trash: (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M3.8 5.2h10.4M5.6 5.2l.7 9.2h5.4l.7-9.2M7.4 5.2V3.6h3.2v1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  spark: (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M9 2.4l1.6 5L15.6 9l-5 1.6L9 15.6l-1.6-5L2.4 9l5-1.6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  ),
  log: (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M4.4 3.6h9.2v10.8H4.4z" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M6.6 6.8h4.8M6.6 9.4h4.8M6.6 12h2.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  ),
  download: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 3v7m0 0 2.6-2.6M8 10 5.4 7.4M3.4 12.4h9.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  lines: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.4 4.2h9.2M3.4 8h9.2M3.4 11.8h5.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
};

const CHEV = (
  <svg className="me-chev" width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
    <path
      d="M5 3l5 4-5 4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Formats the advertised size of a downloadable dictionary ("约 12 MB").
function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `约 ${Math.round(n / (1 << 20))} MB`;
  if (n >= 1024) return `约 ${Math.round(n / 1024)} KB`;
  return '';
}

function fontLabel(file: string): string {
  if (!file || file === 'default') return '默认字体';
  return FONT_CATALOG.find((f) => f.file === file)?.label ?? '自定义字体';
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

  // Row values. Every one of them is optional: a failed call leaves the row
  // without a number instead of taking the page down.
  const [marks, setMarks] = useState<{ bookmarks: number; annotations: number } | null>(null);
  const [trashed, setTrashed] = useState<number | null>(null);
  const [ai, setAi] = useState<{ configured: boolean; model: string } | null>(null);
  const [logOn, setLogOn] = useState<boolean | null>(null);
  const [version, setVersion] = useState('');

  // Reading preferences are read at mount: the reader's Aa sheet and the
  // settings page write the same keys, and a route change remounts this page,
  // so coming back from 设置 always shows the new summary.
  const [prefs] = useState(() => {
    const theme = (APP_THEMES.find((t) => t.id === appTheme()) ?? APP_THEMES[0]).label;
    const mode = (localStorage.getItem(MODE_KEY) as ReadMode) || 'paged';
    const size = Number(localStorage.getItem(FONT_SIZE_KEY)) || 17;
    return {
      theme,
      mode: mode === 'scroll' ? '滚动' : '翻页',
      font: fontLabel(localStorage.getItem(FONT_FAMILY_KEY) || 'default'),
      size,
    };
  });
  const webdav = (() => {
    try {
      const raw = localStorage.getItem(WEBDAV_KEY);
      if (!raw) return '';
      const url = String(JSON.parse(raw).baseUrl || '');
      try {
        return new URL(url).host || url;
      } catch {
        return url;
      }
    } catch {
      return '';
    }
  })();

  // Hardware back closes the dictionary sheet instead of leaving the page.
  useBackClose(sheetOpen, () => setSheetOpen(false));

  useEffect(() => {
    let alive = true;
    const guard = <T,>(p: Promise<T>, set: (v: T) => void) =>
      p.then((v) => alive && set(v)).catch(() => {});

    guard(api.dictStatus(), setDict);
    guard(api.trash(), (list) => setTrashed(list.length));
    guard(api.aiConfig(), (c) => setAi({ configured: c.configured, model: c.model }));
    guard(api.logState(), (s) => setLogOn(s.enabled));
    guard(api.appVersion(), setVersion);
    // Two list calls, counted here rather than in the backend: the notebook
    // counts are small, and a COUNT method per list is not worth a binding.
    Promise.all([api.listAllBookmarks(), api.listAllAnnotations()])
      .then(([b, a]) => {
        if (alive) setMarks({ bookmarks: b.length, annotations: a.length });
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
  // backend in a single blocking call. First run downloads ~12 MB and builds
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

  const dictState = busy
    ? busy.label
    : dict?.installed
      ? `${dict.entries.toLocaleString('en-US')} 词`
      : '尚未安装';

  return (
    // `.shell` is the four-tab skeleton: the title bar is fixed, everything
    // below it scrolls (2026-10-28). Same header component as 书架 / 生词本 / AI,
    // so the four pages agree on where the top of the page is.
    <div className="page me-page shell">
      <div className="lib-head">
        <h1>我的</h1>
        <span className="me-head-note">本地 · 离线可用</span>
      </div>

      <div className="lib-scroll">
        <div className="me-grp">
          <div className="me-grp-title">阅读</div>
          <div className="me-card">
            <Link className="me-row tall" to="/settings">
              <span className="me-tile accent">{ICON.prefs}</span>
              <span className="me-row-text">
                <span className="me-rt">阅读偏好</span>
                <span className="me-rs">
                  {prefs.theme} · {prefs.mode} · {prefs.font} {prefs.size}
                </span>
              </span>
              {CHEV}
            </Link>
            <button
              type="button"
              className="me-row tall"
              disabled={!!busy}
              onClick={() => setSheetOpen(true)}
            >
              <span className="me-tile accent">{ICON.dict}</span>
              <span className="me-row-text">
                <span className="me-rt">查词词库</span>
                <span className="me-rs">{dictState}</span>
              </span>
              {dict?.installed ? (
                <span className="me-badge ok">已安装</span>
              ) : (
                <span className="me-badge warn">未安装</span>
              )}
            </button>
          </div>
        </div>

        <div className="me-grp">
          <div className="me-grp-title">笔记</div>
          <div className="me-card">
            <Link className="me-row" to="/bookmarks">
              <span className="me-tile">{ICON.bookmark}</span>
              <span className="me-row-text">
                <span className="me-rt">书签</span>
              </span>
              {marks && <span className="me-val">{marks.bookmarks}</span>}
              {CHEV}
            </Link>
            <Link className="me-row" to="/annotations">
              <span className="me-tile">{ICON.pen}</span>
              <span className="me-row-text">
                <span className="me-rt">划线与批注</span>
              </span>
              {marks && <span className="me-val">{marks.annotations}</span>}
              {CHEV}
            </Link>
          </div>
        </div>

        <div className="me-grp">
          <div className="me-grp-title">书库</div>
          <div className="me-card">
            <Link className="me-row" to="/webdav">
              <span className="me-tile">{ICON.cloud}</span>
              <span className="me-row-text">
                <span className="me-rt">WebDAV</span>
              </span>
              <span className="me-val">{webdav || '未连接'}</span>
              {CHEV}
            </Link>
            <Link className="me-row" to="/opds">
              <span className="me-tile">{ICON.globe}</span>
              <span className="me-row-text">
                <span className="me-rt">在线书库</span>
              </span>
              <span className="me-val">OPDS</span>
              {CHEV}
            </Link>
            <Link className="me-row" to="/wifi">
              <span className="me-tile">{ICON.wifi}</span>
              <span className="me-row-text">
                <span className="me-rt">Wi-Fi 传书</span>
              </span>
              {CHEV}
            </Link>
            <Link className="me-row" to="/trash">
              <span className="me-tile">{ICON.trash}</span>
              <span className="me-row-text">
                <span className="me-rt">回收站</span>
              </span>
              {trashed !== null && (
                <span className={trashed > 0 ? 'me-val warn' : 'me-val'}>{trashed}</span>
              )}
              {CHEV}
            </Link>
          </div>
        </div>

        <div className="me-grp">
          <div className="me-grp-title">AI 与系统</div>
          <div className="me-card">
            <Link className="me-row" to="/llm">
              <span className="me-tile">{ICON.spark}</span>
              <span className="me-row-text">
                <span className="me-rt">AI 配置</span>
              </span>
              {ai?.configured ? (
                <span className="me-val">{ai.model}</span>
              ) : (
                <span className="me-badge warn">未配置</span>
              )}
              {CHEV}
            </Link>
            <Link className="me-row" to="/logs">
              <span className="me-tile">{ICON.log}</span>
              <span className="me-row-text">
                <span className="me-rt">诊断日志</span>
              </span>
              {logOn !== null && <span className="me-val">{logOn ? '已开启' : '已关闭'}</span>}
              {CHEV}
            </Link>
          </div>
        </div>

        <div className="me-foot">
          <span className="me-foot-line" />
          <Link className="me-foot-link" to="/about">
            关于 EpubMaker
            {version ? ` · ${version}` : ''}
            <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M5 3l5 4-5 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </div>
      </div>

      {sheetOpen && (
        <div className="sheet-mask" onClick={() => !busy && setSheetOpen(false)}>
          <div
            className="sheet dict-sheet"
            role="dialog"
            aria-label="查词词库"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-title">查词词库</div>

            <div className={`dict-state${dict?.installed ? ' ok' : ''}`}>
              <span className="dict-state-dot" />
              <span className="dict-state-text">
                <b>{busy ? '正在处理…' : dict?.installed ? '词库已就绪' : '尚未安装词库'}</b>
                <small>
                  {busy
                    ? busy.label
                    : dict?.installed
                      ? `${dict.entries.toLocaleString('en-US')} 词 · 重新下载会覆盖现有词库`
                      : '划词查词需要先安装，约 12 MB，只需一次'}
                </small>
              </span>
            </div>

            <div className="dict-label">在线下载</div>
            {sources.map((s) => (
              <button
                key={s.id}
                type="button"
                className="dict-item"
                disabled={!!busy}
                onClick={() => void downloadDict(s.id)}
              >
                <span className="dict-item-icon">{ICON.download}</span>
                <span className="dict-item-text">
                  <b>{s.name}</b>
                  {s.desc && <small>{s.desc}</small>}
                </span>
                {s.bytes > 0 && <span className="dict-item-meta">{fmtBytes(s.bytes)}</span>}
              </button>
            ))}

            <div className="dict-label">从本地导入</div>
            <button
              type="button"
              className="dict-item"
              disabled={!!busy}
              onClick={() => void importDictFile()}
            >
              <span className="dict-item-icon plain">{ICON.lines}</span>
              <span className="dict-item-text">
                <b>ECDICT CSV 文件</b>
                <small>已有完整词库或自定义词表时使用</small>
              </span>
              {CHEV}
            </button>

            <button
              type="button"
              className="dict-cancel"
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
