import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { closeForNavigation, navigationDepth } from '../backNav';

/**
 * How many entries stand behind this page.
 *
 * The router's own counter is the honest one — `history.length` never shrinks,
 * so it keeps claiming there is something behind a page whose stack is already
 * empty. But it is NOT always there: an entry the router did not push carries
 * no `idx` at all, and one real case is exactly the reported "退出直接回首页" —
 * Android reclaims the app in the background, the WebView restores its
 * session, and the restored entry has the URL but no state. Reading that as
 * depth 0 turned 返回 into `replace`-to-root from any depth. So a missing (or
 * non-numeric, which is what `idx + 1` on an undefined state silently produces)
 * counter falls back to the entry count, which is coarse but never zero when
 * there really is something to go back to.
 */
function depthBehind(): number {
  const st = window.history.state as { idx?: number } | null;
  const idx = st?.idx;
  if (typeof idx === 'number' && Number.isFinite(idx)) return idx;
  return Math.max(0, window.history.length - 1);
}

/**
 * Header for second-level pages (书签/划线/回收站/WebDAV/整理/拆分/设置). The
 * desktop keeps the flat `.lib-head` look; on a phone the page turns into a
 * sticky bar with a back chevron on the left and the title in it — the same
 * pattern as the reader's own top bar, and the only way back when the desktop
 * top bar is hidden.
 */
export default function SubHeader({
  title,
  tag,
  children,
  backTo = '/',
  back = true,
}: {
  title: ReactNode;
  tag?: ReactNode;
  children?: ReactNode;
  /** Where to go when there is no history to pop (a cold start on this URL). */
  backTo?: string;
  /**
   * A top-level tab (书架 / 生词本 / AI / 我的) has nothing above it: its
   * siblings are reached through the tab bar, not by going back. Showing a
   * chevron there promises a layer that does not exist — pressing it leaves
   * the app rather than going "up".
   */
  back?: boolean;
}) {
  const nav = useNavigate();
  return (
    <div className="sub-head">
      {back && (
        <button
          className="sub-back"
          aria-label="返回"
          onClick={() => {
            // The number the router keeps, not history.length: the latter never
            // shrinks, so it says "there is something behind me" long after the
            // stack is empty. A sheet left open is stepped over, not swallowed.
            const behind = depthBehind();
            const depth = Math.min(navigationDepth(), Math.max(1, behind));
            closeForNavigation();
            if (behind > 0) nav(-depth);
            else nav(backTo, { replace: true });
          }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path
              d="M11.5 3.5 L6 9 L11.5 14.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      <h1>{title}</h1>
      {tag ? <span className="tag sub-tag">{tag}</span> : null}
      <span className="spacer" />
      {children}
    </div>
  );
}
