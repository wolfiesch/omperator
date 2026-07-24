// Small render hooks for the pane families: a self-ticking clock scoped to
// the leaf that displays it (so elapsed labels never re-render a tree), and
// fixed-row-height windowing for the activity stream.
import { useEffect, useState, type RefObject } from "react";

/**
 * A 1-second clock for elapsed/relative labels. Mount it in the leaf text
 * node that shows the time — ticking stays local to that node.
 */
export function useNowTick(enabled = true): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return nowMs;
}

export interface VirtualWindow {
  readonly start: number;
  readonly end: number;
  readonly topPad: number;
  readonly bottomPad: number;
}

/**
 * Fixed-row-height windowing: render only the rows the viewport can show
 * (plus overscan), padding the rest. Cheap, deterministic, and enough for a
 * capped stream of uniform 28px rows.
 */
export function useVirtualWindow(
  containerRef: RefObject<HTMLElement | null>,
  count: number,
  rowHeight: number,
  overscan = 12,
): VirtualWindow {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const onScroll = () => setScrollTop(element.scrollTop);
    let frame = 0;
    const measureViewport = () => {
      frame = 0;
      setViewport(element.clientHeight);
    };
    const observer = new ResizeObserver(() => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measureViewport);
    });
    setViewport(element.clientHeight);
    element.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(element);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [containerRef]);

  const start = Math.max(Math.floor(scrollTop / rowHeight) - overscan, 0);
  const visible = Math.ceil(viewport / rowHeight) + overscan * 2;
  const end = Math.min(start + visible, count);
  return {
    start,
    end,
    topPad: start * rowHeight,
    bottomPad: Math.max(count - end, 0) * rowHeight,
  };
}
