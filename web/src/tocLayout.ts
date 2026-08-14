import type { Chapter, TocEntry } from './api';

// Strip any #fragment so a TOC node (e.g. ch1.xhtml#s2) matches its chapter
// document (ch1.xhtml). Mirrors Reader.tsx's docKey.
export function docKey(href: string): string {
  const i = href.indexOf('#');
  return i >= 0 ? href.slice(0, i) : href;
}

export type TocRenderItem =
  | { kind: 'group'; key: string; title: string; level: number }
  | { kind: 'chapter'; chapter: Chapter; level: number };

interface GroupMeta {
  key: string;
  title: string;
}

// Merge the hierarchical TOC tree with the flat spine-ordered chapters into a
// single render list. Group (section) headers are inserted before the first
// spine chapter that falls under them; chapters are tagged with their depth so
// the UI can indent them. Chapters absent from the TOC render at depth 0.
export function buildTocItems(toc: TocEntry[], chapters: Chapter[]): TocRenderItem[] {
  if (!toc || toc.length === 0) {
    return chapters.map((c) => ({ kind: 'chapter', chapter: c, level: 0 }));
  }
  const byHref = new Map<string, Chapter>();
  for (const c of chapters) byHref.set(docKey(c.href), c);

  interface Found {
    chapter: Chapter;
    depth: number;
    groups: GroupMeta[];
  }
  const found: Found[] = [];
  let gid = 0;
  const walk = (es: TocEntry[], depth: number, groups: GroupMeta[]) => {
    for (const e of es) {
      if (e.href) {
        const ch = byHref.get(docKey(e.href));
        if (ch) {
          found.push({ chapter: ch, depth, groups });
          if (e.children?.length) walk(e.children, depth + 1, groups);
          continue;
        }
      }
      // Pure structural group (no matching chapter): becomes a header and its
      // children are walked with it prepended to the ancestor path.
      const g: GroupMeta = { key: `g${gid++}`, title: e.title || '(未命名分组)' };
      if (e.children?.length) walk(e.children, depth + 1, [...groups, g]);
    }
  };
  walk(toc, 0, []);

  const seen = new Set(found.map((f) => f.chapter.id));
  const extra: Found[] = chapters
    .filter((c) => !seen.has(c.id))
    .map((c) => ({ chapter: c, depth: 0, groups: [] }));

  const order = new Map(chapters.map((c, i) => [c.id, i] as const));
  const all = [...found, ...extra].sort(
    (a, b) => order.get(a.chapter.id)! - order.get(b.chapter.id)!,
  );

  // Emit group headers by diffing each chapter's ancestor path against the
  // currently-open stack (longest common prefix), so headers open/close as we
  // walk spine order and never double up within a contiguous block.
  const out: TocRenderItem[] = [];
  let openKeys: string[] = [];
  for (const f of all) {
    const desired = f.groups;
    let lcp = 0;
    while (lcp < openKeys.length && lcp < desired.length && openKeys[lcp] === desired[lcp].key) lcp++;
    openKeys = openKeys.slice(0, lcp);
    for (let k = lcp; k < desired.length; k++) {
      out.push({ kind: 'group', key: desired[k].key, title: desired[k].title, level: k });
      openKeys.push(desired[k].key);
    }
    out.push({ kind: 'chapter', chapter: f.chapter, level: f.depth });
  }
  return out;
}

// Given the full render list and the set of collapsed group keys, return only
// the items that should be visible. A collapsed group hides every descendant
// item (level strictly deeper than the group) until a sibling or ancestor
// appears.
export function visibleTocItems(items: TocRenderItem[], collapsed: Set<string>): TocRenderItem[] {
  const out: TocRenderItem[] = [];
  let hideAbove = -1;
  for (const it of items) {
    if (hideAbove >= 0 && it.level > hideAbove) continue;
    if (it.kind === 'group') {
      out.push(it);
      hideAbove = collapsed.has(it.key) ? it.level : -1;
    } else {
      out.push(it);
    }
  }
  return out;
}
