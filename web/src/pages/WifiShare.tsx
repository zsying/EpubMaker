import { useEffect, useRef, useState } from 'react';
import { api, WifiShareStatus } from '../api';
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
      .then((QRCode) => QRCode.toDataURL(status.url, { width: 200, margin: 1 }))
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
    } finally {
      setBusy(false);
    }
  }

  const running = !!status?.running;

  return (
    <div className="page wifi-page">
      <SubHeader title="Wi-Fi 传书" />

      <div className="wifi-hero">
        <p className="wifi-desc">
          在同一 Wi-Fi 下，用电脑浏览器打开下方地址（或扫码），即可把 EPUB 文件推送到本书架。传输不经过任何服务器。
        </p>

        <button type="button" className={`btn wifi-toggle${running ? ' on' : ''}`} disabled={busy} onClick={() => void toggle()}>
          {running ? '停止传书' : '开启传书'}
        </button>

        {running && (
          <div className="wifi-live">
            <img className="wifi-qr" src={qr} alt="传书地址二维码" style={{ opacity: qr ? 1 : 0 }} />
            <div className="wifi-url">{status.url}</div>
            <div className="wifi-hint">手机与电脑需连接同一 Wi-Fi；传输期间请保持本页在后台运行。</div>
          </div>
        )}
      </div>

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
            <strong>{status.failures.length}</strong>
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

      {running && status.failures.length > 0 && (
        <div className="wifi-fails">
          {status.failures.map((f, i) => (
            <div key={i}>{f}</div>
          ))}
        </div>
      )}
    </div>
  );
}
