import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';

/**
 * Bottom tab bar for phones. Rendered by App.tsx on every non-reader route;
 * CSS keeps it off the desktop (display:none outside the 640px breakpoint) and
 * hides the desktop top bar in return. Icons are inline SVG stroked with
 * currentColor so the active state is one CSS color away.
 *
 * Tabs are siblings, not steps (2026-10-26)
 * ----------------------------------------
 * 书架 / 生词本 / AI / 我的 are four views of the same level, so switching between
 * them must not add history — yet every switch used to push, and the copies
 * piled up behind each other. Walk 书架 → 生词本 → 书架 → 生词本 and the stack
 * is [/, /vocab, /, /vocab]: the first back lands on the third entry, which is
 * the shelf, so it looks fine; the next back lands on the SECOND entry and the
 * reader is inside the notebook again — 生词本 appearing after 书架, which is
 * exactly the sequence that reads as "the app is going backwards on its own".
 *
 * The rule is therefore positional rather than additive:
 *
 *   - at the root (idx 0) a non-shelf tab is pushed once, so the shelf stays
 *     underneath and one back returns to it;
 *   - from a sibling tab it REPLACES, so the depth stays 2 and one back still
 *     returns to the shelf — the notebook can never end up under the shelf;
 *   - from a second-level page (设置 / 书签 …) the stack is collapsed to the
 *     root first, then the tab is entered from there, so the same invariant
 *     holds no matter where the reader came from;
 *   - the shelf tab pops straight back to the root, however many levels are
 *     up, because the shelf IS the root.
 *
 * Net effect: at any moment 生词本 and 我的 sit directly on 书架, so one back
 * from either always reaches the shelf and the next one leaves the app.
 */

/** The router's own depth counter. `history.length` is useless here: it never
 * shrinks, so it keeps claiming there is something behind a page whose stack
 * has already been emptied. */
function depthIndex(): number {
  const st = window.history.state as { idx?: number } | null;
  return st && typeof st.idx === 'number' ? st.idx : 0;
}
const TABS = [
  {
    to: '/',
    label: '书架',
    end: true,
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M3.5 4 h5.5 a1.6 1.6 0 0 1 1.6 1.6 V16.5 a1.6 1.6 0 0 0 -1.6 -1.6 H3.5 Z M16.5 4 H11 a1.6 1.6 0 0 0 -1.6 1.6 V16.5 a1.6 1.6 0 0 1 1.6 -1.6 h5.5 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    ),
  },
  {
    to: '/vocab',
    label: '生词本',
    end: false,
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M4.5 5 h11 M4.5 9 h11 M4.5 13 h6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    to: '/ai',
    label: 'AI',
    end: false,
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        {/* The four-point star the ✦ buttons already use across the app. */}
        <path
          d="M10 2.5 L11.8 8.2 L17.5 10 L11.8 11.8 L10 17.5 L8.2 11.8 L2.5 10 L8.2 8.2 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    to: '/me',
    label: '我的',
    end: false,
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="6.5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M4 16.5 c0.9 -3.2 3.2 -4.9 6 -4.9 s5.1 1.7 6 4.9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];

export default function MobileTabs() {
  const { pathname } = useLocation();
  const nav = useNavigate();
  // A tab that had to wait for the stack to collapse. Set when the reader taps
  // a tab from a second-level page; consumed by the effect below once the root
  // is actually on screen.
  const [afterRoot, setAfterRoot] = useState<string | null>(null);

  useEffect(() => {
    if (!afterRoot || pathname !== '/') return; // still unwinding
    setAfterRoot(null);
    nav(afterRoot);
  }, [afterRoot, pathname, nav]);

  return (
    <nav className="tabbar" aria-label="主导航">
      {TABS.map((t) => {
        // Tapping the tab you are already on must not push a second copy of the
        // same page: the press would look like it did nothing, and the copy would
        // only show up later as a back press that goes nowhere.
        const here = t.end ? pathname === t.to : pathname.startsWith(t.to);
        return (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            onClick={(e) => {
              // Every case below navigates by hand: the default link behaviour
              // is the push that used to pile copies up.
              e.preventDefault();
              if (here) return;
              const idx = depthIndex();
              if (t.to === '/') {
                // The shelf is the root. Coming back to it means putting away
                // whatever stands on top, however many levels that is.
                if (idx > 0) nav(-idx);
                return;
              }
              if (idx <= 1) {
                // From the shelf: one level up, so a back press returns there.
                // From a sibling tab: in place, so the shelf stays underneath.
                nav(t.to, { replace: idx === 1 });
                return;
              }
              // The bar is only drawn on the three top-level routes today, so
              // this is a guard rather than a path in use: if it ever grows to
              // a second-level page, collapse to the root first and enter from
              // there, instead of stacking a tab on top of a sub-page.
              setAfterRoot(t.to);
              nav(-(idx - 1));
            }}
            className={({ isActive }) => `tabbar-item${isActive ? ' active' : ''}`}
          >
            {t.icon}
            <span>{t.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
