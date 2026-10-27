import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { closeForNavigation, navigationDepth } from '../backNav';

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
            const st = window.history.state as { idx?: number } | null;
            const idx = st && typeof st.idx === 'number' ? st.idx : 0;
            // Never step past what exists: idx counts the entries above the root,
            // so this page plus its past is idx+1. go(-3) with two entries behind
            // is a no-op, and the button simply stops working.
            const depth = Math.min(navigationDepth(), idx + 1);
            closeForNavigation();
            if (idx > 0) nav(-depth);
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
