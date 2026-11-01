import { Component, type ErrorInfo, type ReactNode } from 'react';
import { api } from '../api';

/**
 * The last line of defence against a blank screen.
 *
 * An uncaught error during render makes React unmount the whole tree, which on
 * this app's dark background is indistinguishable from a frozen WebView: no
 * text, no tabs, nothing to tap — the reader's only move is to swipe back until
 * Android offers to exit. That is exactly the report we got after a long
 * reading session, so instead of a blank page we now show what happened, offer
 * the way back to the shelf, and put the stack in the diagnostic log.
 */
interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    void api
      .logClient(
        'error',
        'ui',
        `页面异常：${error?.message || String(error)}`,
        `${error?.stack || ''}\n--- component stack ---${info.componentStack || ''}`,
      )
      .catch(() => {});
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <h2>页面出错了</h2>
        <p>刚才的操作触发了错误，界面已停在安全状态。详细信息已经写进日志。</p>
        <pre className="crash-msg">{String(error.message || error)}</pre>
        <div className="crash-actions">
          <button
            className="btn primary"
            onClick={() => {
              // The root URL is the one path the packaged asset server always
              // serves, which is why recovery goes here rather than reloading
              // the deep link the reader was on.
              location.href = '/';
            }}
          >
            回到书架
          </button>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            重试
          </button>
        </div>
        <p className="crash-hint">我的 → 设置 → 诊断日志 可以查看或复制记录。</p>
      </div>
    );
  }
}
