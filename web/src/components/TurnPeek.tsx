import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { lastTextPage } from '../columns';

/** The live page's geometry, as measureAndLayout derived it. The peek has to be
 *  laid out with exactly these numbers or what slides in would not match the
 *  page it becomes. */
export type PeekGeometry = {
  margin: number;
  contentWidth: number;
  contentHeight: number;
  columnGap: number;
  /** Distance between two sheets, gutter included: one page of travel. */
  pageStride: number;
  /** Distance between two spreads: how far out the peek waits. */
  stride: number;
  pagesPerView: number;
};

type Props = {
  /** Sanitised chapter HTML, same pipeline as the live chapter. */
  html: string;
  /** 1: the chapter that follows (show its first page). -1: the one before it
   *  (show its last). */
  side: 1 | -1;
  geom: PeekGeometry;
  contentStyle: CSSProperties;
  /** The moving layer. The reader writes its transform during a drag. */
  layerRef: RefObject<HTMLDivElement>;
};

/**
 * The neighbouring chapter's page, held one spread off-screen.
 *
 * A chapter turn is a page turn like any other as long as there is a page to
 * turn to: this is that page. It is laid out here — with the reader's own
 * geometry and typography, from the same sanitised HTML — a moment before it is
 * needed, so a chapter edge is not a place where the book stops behaving like a
 * book. Nothing here is interactive: it is a picture of the next page, not a
 * second reader.
 */
export function TurnPeek({ html, side, geom, contentStyle, layerRef }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  // Bumped when an image inside the peek finishes loading: images are laid out
  // at zero height until they arrive, so the columns — and therefore which page
  // is the last one — move once they do.
  const [epoch, setEpoch] = useState(0);

  // Rest position: exactly one spread to the side, so one page of drag brings it
  // home. Written imperatively because React must never re-assert it while a
  // finger is dragging the layer.
  useLayoutEffect(() => {
    const el = layerRef.current;
    if (el) el.style.transform = `translate3d(${side * geom.stride}px, 0, 0)`;
  }, [side, geom.stride, layerRef]);

  // Which page of the neighbour to show. Forwards that is its first page, which
  // needs no measurement at all; backwards it is the last, and where the last
  // page starts is only known once the chapter has been flowed into columns —
  // the same measurement measureAndLayout does for the live chapter, down to the
  // same detail: the strip is wide enough for every column, but the last column
  // can be empty, and an empty page is not somewhere the reader can land.
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const stride = geom.contentWidth + geom.columnGap;
    el.style.width = 'auto';
    el.style.columnWidth = `${geom.contentWidth}px`;
    el.style.columnGap = `${geom.columnGap}px`;
    const cols = Math.max(1, Math.ceil(el.scrollWidth / stride));
    el.style.width = `${cols * geom.contentWidth + (cols - 1) * geom.columnGap}px`;
    const last = lastTextPage(el, el.querySelector('.reader-content'), stride);
    const pages = last === null ? cols : Math.max(1, Math.min(cols, last + 1));
    let page = side > 0 ? 0 : Math.max(0, pages - geom.pagesPerView);
    // Two-page mode opens on a spread boundary, exactly like openChapter's
    // {type:'last'} does for the real chapter.
    if (geom.pagesPerView > 1 && page > 0 && page % geom.pagesPerView !== 0) {
      page -= page % geom.pagesPerView;
    }
    setOffset(page);

    el.querySelectorAll('img').forEach((img) => {
      if (img.complete) return;
      const bump = () => setEpoch((e) => e + 1);
      img.addEventListener('load', bump, { once: true });
      img.addEventListener('error', bump, { once: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, side, geom.contentWidth, geom.contentHeight, geom.columnGap, geom.pagesPerView, epoch]);

  return (
    <div className="turn-peek" ref={layerRef} aria-hidden="true">
      <div
        className="turn-peek-columns"
        ref={stripRef}
        style={{
          left: geom.margin,
          top: geom.margin,
          height: Math.max(0, geom.contentHeight),
          transform: `translate3d(-${offset * geom.pageStride}px, 0, 0)`,
        }}
      >
        <div
          className="reader-content"
          style={contentStyle}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
