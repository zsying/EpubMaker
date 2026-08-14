import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, WebDavConn, WebDavEntry } from '../api';
import { toast, toastError } from '../toast';

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

export default function WebDav() {
  const [form, setForm] = useState<WebDavConn>({ baseUrl: '', username: '', password: '', insecure: false });
  const [showPwd, setShowPwd] = useState(false);
  const [connected, setConnected] = useState(false);
  const [conn, setConn] = useState<WebDavConn | null>(null);
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<WebDavEntry[]>([]);
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
          insecure: !!c.insecure
        });
      }
    } catch {
      /* ignore */
    }
  }, []);

  const loadList = useCallback(
    async (p: string) => {
      if (!conn) return;
      setLoading(true);
      setError(null);
      setSelected(new Set());
      try {
      const list = await api.webdavList(conn, p);
      setEntries(list);
      setPath(p);
      setImportResult(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [conn]
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
      await loadList('');
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
        <div className="lib-head">
          <h1>连接 WebDAV</h1>
        </div>
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
      <div className="lib-head">
        <h1>WebDAV</h1>
        <span className="tag" title={conn.baseUrl}>
          {conn.baseUrl}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" disabled={loading} onClick={() => void loadList(path)}>
          刷新
        </button>
        <button className="btn" onClick={disconnect}>
          断开
        </button>
      </div>

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
      ) : (
        <div className="wd-list">
          {entries.map((e) => {
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
                  {!e.isDirectory && e.size ? fmtSize(e.size) : ''}
                  {!e.isDirectory && e.size && e.lastModified ? ' · ' : ''}
                  {e.lastModified ? fmtDate(e.lastModified) : ''}
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
