import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, WebDavConn, WebDavEntry } from '../api';
import { toast, toastError } from '../toast';
import SubHeader from '../components/SubHeader';

const LS_KEY = 'epubmaker.webdav.conn';

function isEpub(name: string): boolean {
  return /\.epub$/i.test(name);
}

function fmtSize(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(s: string | null): string {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

/* ---- listing order ---- */

const SORT_LS = 'epubmaker.webdav.sort';
type WdSortKey = 'name' | 'date';
type WdSortDir = 'asc' | 'desc';

const SORT_OPTIONS: Array<{ id: WdSortKey; label: string }> = [
  { id: 'name', label: '名称' },
  { id: 'date', label: '修改日期' },
];

// Natural direction per key: names read A→Z, and a question about modification
// time is nearly always "what is new". Picking a key starts at its natural
// direction, so 修改日期 does not open on the oldest file in the folder.
const NATURAL_DIR: Record<WdSortKey, WdSortDir> = { name: 'asc', date: 'desc' };

/** The stored order, or the default when it is missing / unreadable. */
function loadSort(): { key: WdSortKey; dir: WdSortDir } {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_LS) || '{}');
    const key: WdSortKey = raw?.key === 'date' ? 'date' : 'name';
    const dir: WdSortDir = raw?.dir === 'asc' || raw?.dir === 'desc' ? raw.dir : NATURAL_DIR[key];
    return { key, dir };
  } catch {
    return { key: 'name', dir: NATURAL_DIR.name };
  }
}

/** Name order as a file list wants it: 第2章 before 第10章 (numeric), case
 *  alone does not decide (base sensitivity), and the raw comparison is the
 *  tiebreak so the order stays total. */
function nameOrder(a: string, b: string): number {
  const c = a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  return c !== 0 ? c : a < b ? -1 : a > b ? 1 : 0;
}

function modificationTime(e: WebDavEntry): number {
  return e.lastModified ? Date.parse(e.lastModified) : NaN;
}

/** Directories first, then the chosen key in the chosen direction. */
function orderEntries(rows: WebDavEntry[], key: WdSortKey, dir: WdSortDir): WebDavEntry[] {
  const mul = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    // Directories are navigation and files are content; the two never
    // interleave, whatever the key — the server's own order draws that line.
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    if (key === 'date') {
      const ta = modificationTime(a);
      const tb = modificationTime(b);
      // A server that omits getlastmodified gets its undated rows last in both
      // directions: flipping them to the top under 降序 would put files nobody
      // can date above the newest one.
      if (Number.isNaN(ta) || Number.isNaN(tb)) {
        if (Number.isNaN(ta) && Number.isNaN(tb)) return nameOrder(a.name, b.name);
        return Number.isNaN(ta) ? 1 : -1;
      }
      if (ta !== tb) return mul * (ta - tb);
      return nameOrder(a.name, b.name);
    }
    return mul * nameOrder(a.name, b.name);
  });
}

/** The phone's date column: MM-DD, with a two-digit year only when it is not
 *  this year — "10-31" of a folder's recent files needs no year to be read. */
function fmtDateMini(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const pad = (n: number) => String(n).padStart(2, '0');
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const year = d.getFullYear();
  return year === new Date().getFullYear() ? md : `${String(year).slice(2)}-${md}`;
}

/** Filter text → the tokens a name must all contain. Spaces separate, so
 *  「马伯 合集」 finds the collection's volumes without knowing the separator. */
function filterTokens(keyword: string): string[] {
  return keyword.toLowerCase().split(/\s+/).filter(Boolean);
}

export default function WebDav() {
  const [form, setForm] = useState<WebDavConn>({
    baseUrl: '',
    username: '',
    password: '',
    insecure: false,
  });
  const [showPwd, setShowPwd] = useState(false);
  const [connected, setConnected] = useState(false);
  const [conn, setConn] = useState<WebDavConn | null>(null);
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<WebDavEntry[]>([]);
  // The order is a preference and outlives the visit; the filter is not — a
  // filter left on overnight must never make a folder look like it lost files.
  const [sort, setSort] = useState(loadSort);
  const [keyword, setKeyword] = useState('');
  // Which directory the list is showing. Entering another one clears the
  // filter (its rows are a different question); 刷新 does not.
  const pathRef = useRef('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ ok: number; errors: string[] } | null>(null);

  // 恢复上次保存的连接信息（仅填充表单，不自动连接）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const c = JSON.parse(raw) as WebDavConn;
        setForm({
          baseUrl: c.baseUrl || '',
          username: c.username || '',
          password: c.password || '',
          insecure: !!c.insecure,
        });
      }
    } catch {
      /* ignore */
    }
  }, []);

  /**
   * Lists a directory. `via` exists because 连接并测试 has a connection object
   * that `conn` state does not have yet: the callback in this render still
   * closes over `conn === null`, so the first listing after connecting used to
   * bail out silently and leave an empty folder on screen until 刷新 was
   * pressed. A connection that was just tested is as good as one in state.
   */
  const loadList = useCallback(
    async (p: string, via?: WebDavConn) => {
      const active = via ?? conn;
      if (!active) return;
      setLoading(true);
      setError(null);
      setSelected(new Set());
      try {
        const list = await api.webdavList(active, p);
        setEntries(list);
        if (p !== pathRef.current) setKeyword('');
        pathRef.current = p;
        setPath(p);
        setImportResult(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [conn],
  );

  async function connect() {
    if (!form.baseUrl.trim()) return toast('请填写 WebDAV 服务器地址', 'error');
    setLoading(true);
    setError(null);
    try {
      const res = await api.webdavTest(form);
      if (!res.connected) {
        setError(res.error || '连接失败');
        return;
      }
      const c: WebDavConn = { ...form };
      setConn(c);
      localStorage.setItem(LS_KEY, JSON.stringify(c));
      setConnected(true);
      await loadList('', c);
      toast(res.server ? `已连接（${res.server}）` : '已连接', 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setLoading(false);
    }
  }

  function disconnect() {
    setConnected(false);
    setConn(null);
    setEntries([]);
    setPath('');
    pathRef.current = '';
    setKeyword('');
    setSelected(new Set());
    setError(null);
    setImportResult(null);
  }

  function openDir(e: WebDavEntry) {
    void loadList(e.path);
  }

  function goTo(segPath: string) {
    void loadList(segPath);
  }

  function toggleSelect(e: WebDavEntry) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(e.path)) next.delete(e.path);
      else next.add(e.path);
      return next;
    });
  }

  /** Picking a key starts at that key's natural direction; picking the key
   *  already in use changes nothing (the arrow is the way to reverse). */
  function pickSortKey(key: WdSortKey) {
    setSort((s) => (s.key === key ? s : { key, dir: NATURAL_DIR[key] }));
  }

  function toggleDir() {
    setSort((s) => ({ ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' }));
  }

  useEffect(() => {
    localStorage.setItem(SORT_LS, JSON.stringify(sort));
  }, [sort]);

  // Ordering and filtering are display concerns: the listing is one PROPFIND
  // (Depth: 1) for the whole directory, so neither needs a round trip, and
  // neither may hide the fact that the server's own order is what it is.
  const tokens = useMemo(() => filterTokens(keyword), [keyword]);
  const shown = useMemo(() => {
    const rows = tokens.length
      ? entries.filter((e) => {
          const name = e.name.toLowerCase();
          return tokens.every((t) => name.includes(t));
        })
      : entries;
    return orderEntries(rows, sort.key, sort.dir);
  }, [entries, tokens, sort.key, sort.dir]);

  const filtering = tokens.length > 0;

  async function importItems(list: WebDavEntry[]) {
    if (!conn || !list.length) return;
    const items = list.map((e) => ({ path: e.path, name: e.name }));
    setImporting(true);
    try {
      const res = await api.webdavImport(conn, items);
      const ok = res.books?.length ?? 0;
      const errors = res.errors ?? [];
      setImportResult({ ok, errors });
      setSelected(new Set());
      toast(`成功导入 ${ok} 本书籍`, 'success');
      if (errors.length) toast(errors.join('\n'), 'error', 6000);
    } catch (e) {
      toastError(e);
    } finally {
      setImporting(false);
    }
  }

  const selectedEntries = entries.filter((e) => selected.has(e.path) && isEpub(e.name));
  const crumbs = path.split('/').filter(Boolean);

  /* ---------- 未连接：连接表单 ---------- */
  if (!connected || !conn) {
    return (
      <div className="page" style={{ maxWidth: 640 }}>
        <SubHeader title="连接 WebDAV" />
        <div className="card" style={{ padding: 20 }}>
          <div className="field">
            <label>服务器地址</label>
            <input
              className="input"
              placeholder="https://dav.example.com/remote.php/dav/files/用户名"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
          </div>
          <div className="field">
            <label>用户名（可选）</label>
            <input
              className="input"
              value={form.username}
              autoComplete="username"
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </div>
          <div className="field">
            <label>密码（可选）</label>
            <div style={{ position: 'relative' }}>
              <input
                className="input"
                type={showPwd ? 'text' : 'password'}
                value={form.password}
                autoComplete="password"
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                style={{ paddingRight: 64 }}
              />
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => setShowPwd((v) => !v)}
                style={{ position: 'absolute', right: 4, top: 4 }}
              >
                {showPwd ? '隐藏' : '显示'}
              </button>
            </div>
          </div>
          <label className="wd-check">
            <input
              type="checkbox"
              checked={!!form.insecure}
              onChange={(e) => setForm({ ...form, insecure: e.target.checked })}
            />
            忽略 TLS 证书错误（自签证书 / 内网 HTTPS 用）
          </label>

          {error && <div className="wd-error">{error}</div>}

          <div className="toolbar" style={{ marginTop: 16 }}>
            <button className="btn primary" disabled={loading} onClick={() => void connect()}>
              {loading ? '连接中…' : '连接并测试'}
            </button>
          </div>
        </div>
        <div className="muted" style={{ marginTop: 14, fontSize: 12, lineHeight: 1.8 }}>
          支持 Nextcloud / ownCloud / 群晖 NAS / 各类 WebDAV 服务。凭据仅保存在本机浏览器，
          并在每次请求时发送给本机服务用于连接远端服务器。
        </div>
      </div>
    );
  }

  /* ---------- 已连接：文件浏览器 ---------- */
  return (
    <div className="page">
      <SubHeader title="WebDAV" tag={conn.baseUrl}>
        <button className="btn ghost" disabled={loading} onClick={() => void loadList(path)}>
          刷新
        </button>
        <button className="btn" onClick={disconnect}>
          断开
        </button>
      </SubHeader>

      <div className="wd-crumb">
        <span className="wd-crumb-root" onClick={() => void goTo('')}>
          WebDAV
        </span>
        {crumbs.map((seg, i) => (
          <span key={i} className="wd-crumb-seg">
            <span className="wd-sep">/</span>
            <span
              className={i === crumbs.length - 1 ? 'wd-cur' : 'wd-link'}
              onClick={() => void goTo(crumbs.slice(0, i + 1).join('/') + '/')}
            >
              {decodeURIComponent(seg)}
            </span>
          </span>
        ))}
      </div>

      {/* One row of view controls: what to show, in what order. The listing is
          the whole directory already, so both act on what is on screen — and
          neither has any business reaching the server. */}
      <div className="wd-tools">
        <input
          className="input wd-filter"
          placeholder="过滤文件名…"
          value={keyword}
          autoComplete="off"
          aria-label="过滤文件名"
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setKeyword('');
          }}
        />
        {keyword && (
          <button className="btn sm ghost" onClick={() => setKeyword('')} title="清除过滤">
            清除
          </button>
        )}
        <div className="wd-sortseg" role="group" aria-label="排序方式">
          {SORT_OPTIONS.map((o) => (
            <button
              key={o.id}
              className={sort.key === o.id ? 'on' : ''}
              aria-pressed={sort.key === o.id}
              onClick={() => pickSortKey(o.id)}
            >
              {o.label}
            </button>
          ))}
          <button
            className="wd-dirtoggle"
            aria-label={sort.dir === 'asc' ? '升序，点击改为降序' : '降序，点击改为升序'}
            title={
              sort.key === 'date'
                ? sort.dir === 'asc'
                  ? '升序：旧 → 新'
                  : '降序：新 → 旧'
                : sort.dir === 'asc'
                  ? '升序：A → Z'
                  : '降序：Z → A'
            }
            onClick={toggleDir}
          >
            {sort.dir === 'asc' ? '↑' : '↓'}
          </button>
        </div>
        <span className="wd-count">
          {filtering ? `${shown.length} / ${entries.length} 项` : `${entries.length} 项`}
        </span>
      </div>

      {selectedEntries.length > 0 && (
        <div className="wd-bulk">
          <span>已选 {selectedEntries.length} 个 EPUB</span>
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => setSelected(new Set())}>
            取消选择
          </button>
          <button
            className="btn sm primary"
            disabled={importing}
            onClick={() => void importItems(selectedEntries)}
          >
            {importing ? '导入中…' : `导入选中 (${selectedEntries.length})`}
          </button>
        </div>
      )}

      {error && <div className="wd-error">{error}</div>}

      {importResult && (
        <div className={`wd-result${importResult.errors.length ? ' has-fail' : ' ok'}`}>
          <span className="wd-result-msg">
            已成功导入 <b>{importResult.ok}</b> 本
            {importResult.errors.length > 0 && (
              <>
                ，<b className="wd-fail-count">{importResult.errors.length}</b> 个失败
              </>
            )}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn sm ghost" onClick={() => setImportResult(null)}>
            关闭
          </button>
          {importResult.errors.length > 0 && (
            <ul className="wd-result-list">
              {importResult.errors.map((er, i) => (
                <li key={i}>{er}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading ? (
        <div className="loading">加载中…</div>
      ) : entries.length === 0 ? (
        <div className="empty">
          <p>此目录为空</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <p>没有匹配「{keyword.trim()}」的文件</p>
          <button className="btn sm" onClick={() => setKeyword('')}>
            清除过滤
          </button>
        </div>
      ) : (
        <div className={`wd-list${sort.key === 'date' ? ' dates' : ''}`}>
          {shown.map((e) => {
            const epub = isEpub(e.name);
            return (
              <div
                className={`wd-row${e.isDirectory ? ' dir' : ''}${selected.has(e.path) ? ' sel' : ''}`}
                key={e.path}
                onClick={() => (e.isDirectory ? openDir(e) : undefined)}
              >
                <span className={`wd-badge ${e.isDirectory ? 'dir' : epub ? 'epub' : 'file'}`}>
                  {e.isDirectory ? '目录' : epub ? 'EPUB' : '文件'}
                </span>
                <span className="wd-name" title={e.name}>
                  {e.name}
                </span>
                <span className="wd-meta">
                  {!e.isDirectory && e.size ? (
                    <span className="wd-size">{fmtSize(e.size)}</span>
                  ) : null}
                  {!e.isDirectory && e.size && e.lastModified ? (
                    <span className="wd-dot"> · </span>
                  ) : null}
                  {e.lastModified ? (
                    <span className="wd-date" title={fmtDate(e.lastModified)}>
                      <span className="wd-date-long">{fmtDate(e.lastModified)}</span>
                      <span className="wd-date-mini">{fmtDateMini(e.lastModified)}</span>
                    </span>
                  ) : null}
                </span>
                <span className="wd-actions" onClick={(ev) => ev.stopPropagation()}>
                  {e.isDirectory ? (
                    <button className="btn sm" onClick={() => openDir(e)}>
                      打开
                    </button>
                  ) : epub ? (
                    <>
                      <input
                        type="checkbox"
                        className="wd-cb"
                        checked={selected.has(e.path)}
                        onChange={() => toggleSelect(e)}
                        title="选择以批量导入"
                      />
                      <button
                        className="btn sm primary"
                        disabled={importing}
                        onClick={() => void importItems([e])}
                      >
                        {importing ? '导入中…' : '导入'}
                      </button>
                    </>
                  ) : (
                    <span className="muted" style={{ fontSize: 12 }}>
                      非 EPUB
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
