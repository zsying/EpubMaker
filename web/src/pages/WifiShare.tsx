import { useEffect, useRef, useState } from 'react';
import { api, WifiShareStatus } from '../api';
import { toast, toastError } from '../toast';
import SubHeader from '../components/SubHeader';

/**
 * Wi-Fi 传书: the phone starts a tiny LAN upload server, and a computer on the
 * same Wi-Fi opens the URL (or scans the QR code) to push EPUB files straight
 * into the library. The page is a switch plus a live view of the address and
 * the transfer counters; leaving the page does NOT stop the server — a
 * transfer outlives a bit of navigation, and the app's death stops it anyway.
 */
export default function WifiShare() {
  const [status, setStatus] = useState<WifiShareStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState('');
  const pollRef = useRef<number | null>(null);

  async function refresh() {
    try {
      setStatus(await api.wifiShareStatus());
    } catch {
      /* keep the old status */
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // While the server runs, poll the counters so the phone shows upload
  // progress happening on the computer.
  useEffect(() => {
    if (!status?.running) {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = window.setInterval(() => void refresh(), 2000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [status?.running]);

  // The QR code is generated locally (no network), so it works offline.
  useEffect(() => {
    if (!status?.url) {
      setQr('');
      return;
    }
    let alive = true;
    import('qrcode')
      .then((QRCode) => QRCode.toDataURL(status.url, { width: 320, margin: 1 }))
      .then((url) => {
        if (alive) setQr(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [status?.url]);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      setStatus(status?.running ? await api.wifiShareStop() : await api.wifiShareStart());
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  // Backend fields can arrive null (older builds, serializers) — the shelf
  // once went black reading .length of a null failures array.
  const failures = status?.failures ?? [];
  const running = !!status?.running;

  async function copyAddress() {
    if (!status?.url) return;
    try {
      await navigator.clipboard.writeText(status.url);
      toast('地址已复制', 'success');
    } catch {
      toast('复制失败，请手动记录地址', 'info');
    }
  }

  return (
    <div className="page wifi-page">
      <SubHeader title="Wi-Fi 传书" />

      <div className="wifi-hero">
        <div className={`wifi-orb${running ? ' on' : ''}`}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M2.5 9.5C8 4.5 16 4.5 21.5 9.5M5.5 13C9.5 9.7 14.5 9.7 18.5 13M8.6 16.4c2-1.7 4.8-1.7 6.8 0M12 19.6h.01"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div className={`wifi-state${running ? ' on' : ''}`}>
          <i className="wifi-dot" aria-hidden="true" />
          {running ? '传书中' : '未开启'}
        </div>
        <p className="wifi-desc">
          在同一 Wi-Fi 下，用电脑浏览器打开下方地址（或扫码），即可把 EPUB
          文件推送到本书架。传输不经过任何服务器。
        </p>

        <button
          type="button"
          className={`btn wifi-toggle${running ? ' on' : ''}`}
          disabled={busy}
          onClick={() => void toggle()}
        >
          {running ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2.5" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 3v8M6.3 6.5a8 8 0 1 0 11.4 0"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          )}
          {busy ? '切换中…' : running ? '停止传书' : '开启传书'}
        </button>
      </div>

      {running && (
        <div className="wifi-live">
          <div className="wifi-qr-card">
            <img
              className="wifi-qr"
              src={qr}
              alt="传书地址二维码"
              style={{ opacity: qr ? 1 : 0 }}
            />
            {!qr && <div className="wifi-qr-loading" />}
            <div className="wifi-qr-label">电脑浏览器扫码打开</div>
          </div>

          <button
            type="button"
            className="wifi-url"
            onClick={() => void copyAddress()}
            title="点击复制"
          >
            {status.url}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect
                x="9"
                y="9"
                width="11"
                height="11"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <path
                d="M5 15V6a2 2 0 0 1 2-2h9"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <div className="wifi-hint">
            手机与电脑需连接同一 Wi-Fi；传输期间请保持本页在后台运行。
          </div>
        </div>
      )}

      {running && (
        <div className="wifi-stats">
          <div className="wifi-stat">
            <strong>{status.imports}</strong>
            <span>已导入</span>
          </div>
          <div className="wifi-stat">
            <strong>{status.duplicates}</strong>
            <span>重复跳过</span>
          </div>
          <div className="wifi-stat">
            <strong>{failures.length}</strong>
            <span>失败</span>
          </div>
          {status.lastImportUnix ? (
            <div className="wifi-stat">
              <strong>
                {new Date(status.lastImportUnix * 1000).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
              </strong>
              <span>最近导入</span>
            </div>
          ) : null}
        </div>
      )}

      {running && failures.length > 0 && (
        <div className="wifi-fails">
          {failures.map((f, i) => (
            <div key={i}>{f}</div>
          ))}
        </div>
      )}
    </div>
  );
}
