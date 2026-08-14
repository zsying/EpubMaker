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
      const ch = e.href ? byHref.get(docKey(e.href)) : undefined;
      if (e.children?.length) {
        // This entry is a parent section: it becomes a group header for its
        // descendants even when it also links to its own chapter (common in real
        // EPUBs where a volume/part entry carries both an href and child entries).
        // Skipping the header here previously dropped every ancestor caret.
        const g: GroupMeta = { key: `g${gid++}`, title: e.title || ch?.title || '(未命名分组)' };
        if (ch) found.push({ chapter: ch, depth: depth + 1, groups: [...groups, g] });
        walk(e.children, depth + 1, [...groups, g]);
      } else if (ch) {
        found.push({ chapter: ch, depth, groups });
      }
      // else: an entry with no href and no children is ignored.
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

export interface HierarchySplit {
  parts: { title: string }[];
  assign: Record<string, number>;
}

// Build a volume split directly from the hierarchical TOC. Each TOC group at the
// requested depth (`level`, 1 = top-level) becomes its own volume; every chapter
// under that group is assigned to it. `excluded` holds chapter ids the user has
// already marked "不包含" — those stay out of the auto-split. Chapters not
// covered by the chosen level (e.g. a deep book with only 2 real levels) fall
// back to a single volume.
export function splitByHierarchy(
  toc: TocEntry[],
  chapters: Chapter[],
  level: number,
  excluded: Set<string> = new Set(),
): HierarchySplit {
  const byHref = new Map<string, Chapter>();
  for (const c of chapters) byHref.set(docKey(c.href), c);

  const parts: { title: string }[] = [];
  const assign: Record<string, number> = {};

  const assignSubtree = (e: TocEntry, p: number) => {
    if (e.href) {
      const ch = byHref.get(docKey(e.href));
      if (ch && !excluded.has(ch.id)) assign[ch.id] = p;
    }
    for (const c of e.children ?? []) assignSubtree(c, p);
  };

  const walk = (es: TocEntry[], depth: number) => {
    for (const e of es) {
      if (depth + 1 < level) {
        walk(e.children ?? [], depth + 1);
      } else {
        const p = parts.length;
        parts.push({ title: e.title || `分卷 ${p + 1}` });
        assignSubtree(e, p);
      }
    }
  };

  walk(toc, 0);

  if (parts.length === 0) {
    parts.push({ title: '分卷 1' });
    for (const c of chapters) if (!excluded.has(c.id)) assign[c.id] = 0;
  }

  // Drop volumes that ended up with no chapters (e.g. a whole group was
  // excluded) and reindex so downstream assign values stay valid.
  const keep: number[] = [];
  parts.forEach((_, i) => {
    if (Object.values(assign).some((p) => p === i)) keep.push(i);
  });
  if (keep.length < parts.length) {
    const remap = new Map<number, number>();
    keep.forEach((oldP, newP) => remap.set(oldP, newP));
    const next: Record<string, number> = {};
    for (const [cid, p] of Object.entries(assign)) {
      const np = remap.get(p);
      if (np !== undefined) next[cid] = np;
    }
    return { parts: keep.map((p) => parts[p]), assign: next };
  }
  return { parts, assign };
}
