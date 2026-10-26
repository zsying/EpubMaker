import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { api } from './api';
import { applyAppTheme, appTheme } from './readingPrefs';
import { flagTouchPrimary } from './device';
import { installBackGuard } from './backNav';
import './styles.css';

// Theme and device flags go on <html> BEFORE the first render: the stylesheet
// keys every colour off html[data-app-theme], and a late flip would paint one
// frame of the wrong palette at startup.
applyAppTheme(appTheme());
flagTouchPrimary();
// The hardware-back guard must be registered before react-router mounts its
// own popstate listener: it intercepts in the capture phase so an open overlay
// can consume a back press before the router navigates.
installBackGuard();

// Uncaught errors and unhandled rejections go to the on-device log (我的 → 设置
// → 诊断日志). The WebView console dies with the process, and the failures that
// leave a blank screen are exactly the ones that never reach Go any other way.
// Failure to log is silent on purpose: logging must never be the reason the page
// breaks.
function logFromClient(level: string, message: string, detail: string) {
  try {
    void api.logClient(level, 'ui', message, detail).catch(() => {});
  } catch {
    /* the backend may not be up yet — drop it */
  }
}

window.addEventListener('error', (e) => {
  const ev = e as ErrorEvent;
  const where = ev.filename ? `${ev.filename}:${ev.lineno ?? 0}:${ev.colno ?? 0}` : '';
  logFromClient(
    'error',
    `JS 错误：${ev.message || 'unknown'}`,
    `${where}\n${ev.error?.stack ?? ''}`,
  );
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = (e as PromiseRejectionEvent).reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  logFromClient(
    'error',
    `未处理的 Promise 拒绝：${message}`,
    reason instanceof Error ? (reason.stack ?? '') : '',
  );
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
