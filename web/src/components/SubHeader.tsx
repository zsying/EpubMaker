import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Header for second-level pages (书签/划线/回收站/WebDAV/整理/拆分/设置). The
 * desktop keeps the flat `.lib-head` look; on a phone the page turns into a
 * sticky bar with a back chevron on the left and the title in it — the same
 * pattern as the reader's own top bar, and the only way back when the desktop
 * top bar is hidden.
 */
export default function SubHeader({ title, tag, children }: { title: ReactNode; tag?: ReactNode; children?: ReactNode }) {
  const nav = useNavigate();
  return (
    <div className="sub-head">
      <button
        className="sub-back"
        aria-label="返回"
        onClick={() => {
          if (window.history.length > 1) nav(-1);
          else nav('/');
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
      <h1>{title}</h1>
      {tag ? <span className="tag sub-tag">{tag}</span> : null}
      <span className="spacer" />
      {children}
    </div>
  );
}
