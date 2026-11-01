import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Chapter, TocEntry } from '../api';
import { Caret } from '../Caret';
import type { TocView } from '../tocNav';

// The table of contents as it is drawn — one tree, two sources. It knows
// nothing about layout (tocLayout.ts) or about resolving hrefs (tocNav.ts): it
// is handed an entry list, a resolver and the current selection, and it calls
// back when a row is picked or a group is folded.

// Recursive hierarchical TOC renderer. Collapse state is controlled by the parent
// via `collapsed` (a Set of node-path keys) so a "locate current chapter" action
// can expand ancestors. Indentation comes from the row wrapper. The active node is
// highlighted and clicking a node opens the matching chapter. Group nodes without
// an href are not clickable to open, but their caret still collapses their subtree.
function TocTree({
  entries,
  depth = 0,
  itemClass,
  activeSet,
  resolve,
  onPick,
  collapsed,
  onToggle,
  pathBase = '',
}: {
  entries: TocEntry[];
  depth?: number;
  itemClass: string;
  activeSet: Set<string>;
  resolve: (href: string) => string | undefined;
  onPick: (cid: string, href?: string) => void;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  pathBase?: string;
}) {
  return (
    <>
      {entries.map((e, i) => {
        const key = pathBase === '' ? `/${i}` : `${pathBase}/${i}`;
        return (
          <TocNode
            key={key}
            entry={e}
            nodeKey={key}
            depth={depth}
            itemClass={itemClass}
            activeSet={activeSet}
            resolve={resolve}
            onPick={onPick}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        );
      })}
    </>
  );
}

function TocNode({
  entry,
  nodeKey,
  depth,
  itemClass,
  activeSet,
  resolve,
  onPick,
  collapsed,
  onToggle,
}: {
  entry: TocEntry;
  nodeKey: string;
  depth: number;
  itemClass: string;
  activeSet: Set<string>;
  resolve: (href: string) => string | undefined;
  onPick: (cid: string, href?: string) => void;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}) {
  const hasKids = !!entry.children && entry.children.length > 0;
  const open = !collapsed.has(nodeKey);
  const cid = entry.href ? resolve(entry.href) : undefined;
  const active = entry.href ? activeSet.has(entry.href) : false;
  const toggle = (ev: ReactMouseEvent) => {
    ev.stopPropagation();
    onToggle(nodeKey);
  };
  const labelClick = () => {
    // The href travels with the id: a nav entry usually points at a section
    // inside the document (#filepos…), not at the document's top.
    if (cid) onPick(cid, entry.href);
    else if (hasKids) onToggle(nodeKey);
  };
  return (
    <>
      <div className="toc-row" style={{ paddingLeft: depth * 16 }}>
        {hasKids ? (
          <button
            type="button"
            className="toc-caret"
            onClick={toggle}
            aria-label={open ? '折叠' : '展开'}
          >
            <Caret open={open} />
          </button>
        ) : (
          <span className="toc-caret toc-caret-empty" />
        )}
        <button
          type="button"
          className={`${itemClass}${active ? ' active' : ''}${hasKids ? ' group' : ''}`}
          style={{ padding: '7px 12px' }}
          onClick={labelClick}
          title={entry.title}
          disabled={!cid && !hasKids}
        >
          {entry.title || '(无标题)'}
        </button>
      </div>
      {hasKids && open && (
        <TocTree
          entries={entry.children!}
          depth={depth + 1}
          itemClass={itemClass}
          activeSet={activeSet}
          resolve={resolve}
          onPick={onPick}
          collapsed={collapsed}
          onToggle={onToggle}
          pathBase={nodeKey}
        />
      )}
    </>
  );
}
/** The 目录 / 文件 switch. It only exists when the book has a nav to switch to:
 *  a book without one has exactly one possible view, and a control that cannot
 *  change anything is a question with no answer. */
export function TocSeg({ view, onChange }: { view: TocView; onChange: (v: TocView) => void }) {
  return (
    <span className="toc-seg" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={view === 'nav'}
        className={view === 'nav' ? 'on' : ''}
        onClick={() => onChange('nav')}
        title="按书的目录（EPUB nav / NCX），原样显示"
      >
        目录
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'file'}
        className={view === 'file' ? 'on' : ''}
        onClick={() => onChange('file')}
        title="按文件（spine 文档），每份文档一行"
      >
        文件
      </button>
    </span>
  );
}

/** "Locate current chapter" — the same icon in all three TOC surfaces. */
export function TocLocate({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="toc-locate"
      title="定位到当前章节"
      onClick={onClick}
      aria-label="定位到当前章节"
    >
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      </svg>
    </button>
  );
}

/** One list, two sources. The nav is drawn as the tree it is; the file view is
 *  one row per spine document, numbered, which is the only way to reach a
 *  document the nav never names. */
export function TocList({
  view,
  toc,
  chapters,
  itemClass,
  activeSet,
  resolve,
  onPick,
  current,
  openChapter,
  collapsed,
  onToggle,
}: {
  view: TocView;
  toc: TocEntry[];
  chapters: Chapter[];
  itemClass: string;
  activeSet: Set<string>;
  resolve: (href: string) => string | undefined;
  onPick: (cid: string, href?: string) => void;
  current: string | null;
  openChapter: (cid: string) => void;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}) {
  if (view === 'nav') {
    return (
      <TocTree
        entries={toc}
        itemClass={itemClass}
        activeSet={activeSet}
        resolve={resolve}
        onPick={onPick}
        collapsed={collapsed}
        onToggle={onToggle}
      />
    );
  }
  return (
    <>
      {chapters.map((c, i) => (
        <button
          key={c.id}
          className={`${itemClass}${c.id === current ? ' active' : ''}`}
          onClick={() => openChapter(c.id)}
          title={c.title}
        >
          <span className="num">{String(i + 1).padStart(2, '0')}</span>
          {c.title}
        </button>
      ))}
    </>
  );
}
