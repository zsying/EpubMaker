import { NavLink, useLocation } from 'react-router-dom';

/**
 * Bottom tab bar for phones. Rendered by App.tsx on every non-reader route;
 * CSS keeps it off the desktop (display:none outside the 640px breakpoint) and
 * hides the desktop top bar in return. Icons are inline SVG stroked with
 * currentColor so the active state is one CSS color away.
 */
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
              if (here) e.preventDefault();
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
