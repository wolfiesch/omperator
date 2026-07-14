// Virtualized transcript timeline on LegendList. Scroll behavior contract:
// at-end follows new output; scrolling away preserves the reading anchor and
// surfaces a "new output" pill; switching sessions restores the per-session
// offset (or the tail when the user was following). List wiring adapted from
// T3 Code apps/web/src/components/chat/MessagesTimeline.tsx (MIT, T3 Tools
// Inc., commit f61fa9499d96fee825492aba204593c37b27e0cb); OMP changes: token
// styling, workspace-store anchors, row model from the app-wire projection.
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { Button, cn } from "@t4-code/ui";
import { ArrowDown } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useWorkspace, workspaceStore } from "../../state/store-instance.ts";
import { selectSessionView } from "../../state/workspace-store.ts";
import type { TranscriptImageSource } from "../session-runtime/transcript-images.ts";
import { createAnchoredToggle, DisclosureAnchorContext } from "./disclosure-anchor.tsx";
import type { TranscriptRow } from "./rows.ts";
import { TranscriptRowContent } from "./TranscriptRows.tsx";

interface NavigationViewTransition {
  skipTransition(): void;
}

function skipPendingNavigationTransition(): void {
  const candidate = (window as Window & { __t4ViewTransition?: NavigationViewTransition }).__t4ViewTransition;
  if (candidate !== undefined) {
    candidate.skipTransition();
    delete (window as Window & { __t4ViewTransition?: NavigationViewTransition }).__t4ViewTransition;
  }
}

const LIST_HEADER = <div className="h-4" />;

function keyExtractor(item: TranscriptRow): string {
  return item.id;
}

function getItemType(item: TranscriptRow): string {
  return item.kind === "message" ? `message:${item.role}` : item.kind;
}

export interface TranscriptTimelineProps {
  readonly sessionId: string;
  readonly rows: readonly TranscriptRow[];
  /** True while the runtime is actively producing output. */
  readonly streaming: boolean;
  /** Space reserved at the end for the floating composer stack. */
  readonly bottomInset: number;
  /** Elapsed-label time base from the session runtime snapshot. */
  readonly nowMs: number;
  readonly imageSource: TranscriptImageSource;
}

export const TranscriptTimeline = memo(function TranscriptTimeline({
  sessionId,
  rows,
  streaming,
  bottomInset,
  nowMs,
  imageSource,
}: TranscriptTimelineProps) {
  const listRef = useRef<LegendListRef | null>(null);
  // null anchor = the user was following the tail when they left.
  const savedScrollTop = useWorkspace(
    (state) => selectSessionView(state, sessionId).scrollTop,
  );
  const initialAnchorRef = useRef<number | null>(savedScrollTop);
  const [atEnd, setAtEnd] = useState(initialAnchorRef.current === null);
  const [newOutputPending, setNewOutputPending] = useState(false);
  // A user disclosure suspends follow-to-bottom: its layout growth must
  // never read as streamed output, and it never re-pins the view.
  const [disclosureActive, setDisclosureActive] = useState(false);
  const following = atEnd && !disclosureActive;

  // Synchronous mirrors for the pre-paint pin: scroll events and disclosure
  // begin/settle update these in the same task, so a ResizeObserver callback
  // can decide "may I pin?" before React re-renders. A wheel-up during a
  // stream burst therefore wins over the pin in that very frame.
  const atEndRef = useRef(initialAnchorRef.current === null);
  const disclosureActiveRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);

  /** The list's DOM scroller, located lazily under the container. */
  const locateScroller = useCallback((): HTMLElement | null => {
    const cached = scrollerRef.current;
    if (cached !== null && cached.isConnected) return cached;
    const root = containerRef.current;
    if (root === null) return null;
    for (const element of root.querySelectorAll<HTMLElement>("div")) {
      const { overflowY } = getComputedStyle(element);
      if (overflowY === "auto" || overflowY === "scroll") {
        scrollerRef.current = element;
        return element;
      }
    }
    return null;
  }, []);

  /** Pin to the true max, only while genuinely following. Layout-phase safe. */
  const pinToEnd = useCallback(() => {
    if (!atEndRef.current || disclosureActiveRef.current) return;
    const scroller = locateScroller();
    if (scroller === null) return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (scroller.scrollTop !== max) scroller.scrollTop = max;
  }, [locateScroller]);

  // Reset anchor bookkeeping when the timeline remounts for a new session.
  // (The component keys by sessionId at the call site.)

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState();
    if (state === undefined) return;
    const isAtEnd = state.isAtEnd || state.isWithinMaintainScrollAtEndThreshold;
    atEndRef.current = isAtEnd;
    setAtEnd(isAtEnd);
    if (isAtEnd) setNewOutputPending(false);
    // Persist the reading anchor; the tail persists as null so switch-back
    // resumes following.
    workspaceStore
      .getState()
      .setSessionScrollTop(sessionId, isAtEnd ? null : Math.round(state.scroll));
  }, [sessionId]);

  // Anchored disclosure toggles: freeze the pin while the expansion lays
  // out, then re-read the true position (expanding at the tail usually
  // leaves the view above the end — that truth wins over the stale flag).
  const anchorController = useMemo(
    () =>
      createAnchoredToggle({
        onBegin: () => {
          disclosureActiveRef.current = true;
          setDisclosureActive(true);
        },
        onSettle: () => {
          disclosureActiveRef.current = false;
          setDisclosureActive(false);
          const state = listRef.current?.getState();
          if (state === undefined) return;
          const isAtEnd = state.isAtEnd || state.isWithinMaintainScrollAtEndThreshold;
          atEndRef.current = isAtEnd;
          setAtEnd(isAtEnd);
          workspaceStore
            .getState()
            .setSessionScrollTop(sessionId, isAtEnd ? null : Math.round(state.scroll));
        },
      }),
    [sessionId],
  );

  // New output while scrolled away raises the pill.
  const lastRowCountRef = useRef(rows.length);
  useEffect(() => {
    if (rows.length !== lastRowCountRef.current) {
      lastRowCountRef.current = rows.length;
      if (!following) setNewOutputPending(true);
    }
  }, [rows.length, following]);

  // Follow pins at the TRUE max on every painted frame, not eventually:
  // 1. React-commit growth (streamed rows, composer/footer resize) pins in
  //    the layout phase below, before that commit paints.
  // 2. LegendList's own async remeasure pins via a ResizeObserver on the
  //    scroller content — RO callbacks run after layout, before paint.
  // 3. One rAF fallback catches anything the list schedules for the next
  //    frame. Never runs scrolled away or during a disclosure, so the
  //    reading anchor is never yanked.
  // `rows` identity matters: streamed text grows within a row without
  // changing the count.
  useLayoutEffect(() => {
    if (!following) return;
    pinToEnd();
    const frame = requestAnimationFrame(pinToEnd);
    return () => cancelAnimationFrame(frame);
  }, [following, rows, bottomInset, pinToEnd]);

  useEffect(() => {
    if (!following) return;
    const scroller = locateScroller();
    if (scroller === null) return;
    const observer = new ResizeObserver(pinToEnd);
    observer.observe(scroller);
    const content = scroller.firstElementChild;
    if (content !== null) observer.observe(content);
    return () => observer.disconnect();
  }, [following, locateScroller, pinToEnd]);

  const renderItem = useCallback(
    ({ item }: { item: TranscriptRow }) => (
      <div data-transcript-row className="mx-auto w-full max-w-(--transcript-measure) min-w-0 px-4 sm:px-6">
        <TranscriptRowContent imageSource={imageSource} nowMs={nowMs} row={item} />
      </div>
    ),
    [imageSource, nowMs],
  );

  const maintainScrollAtEnd = useMemo(
    () =>
      following
        ? { animated: false, on: { dataChange: true, itemLayout: true, layout: true } }
        : false,
    [following],
  );

  const jumpToLatest = useCallback(() => {
    setNewOutputPending(false);
    void listRef.current?.scrollToEnd({ animated: !window.matchMedia("(prefers-reduced-motion: reduce)").matches });
  }, []);

  // Cold-mount mask: LegendList lays rows out a few frames after mount, so
  // a hard refresh briefly shows the shell over an empty transcript. Until
  // the list reports real content, an exact warm overlay renders the tail
  // rows bottom-aligned with the same measure, padding, and composer inset.
  // The measured list stays visibility:hidden during that handoff: both trees
  // may exist for layout, but only one transcript copy can ever paint. The
  // reveal atomically removes the overlay and restores the real list. Sessions
  // restored to a mid-scroll anchor mask with the plain transcript background
  // instead (never wrong content). Removal is layout-driven (rAF poll of the
  // list's content), not a timer.
  const REVEAL_STABILITY_FRAMES = 8;
  const [coldMount, setColdMount] = useState(true);
  useEffect(() => {
    let frame = 0;
    let stableFrames = 0;
    let previousHeight = -1;
    let previousMaxScroll = -1;
    const check = () => {
      const container = containerRef.current;
      const content = container?.querySelector(".legend-list-content-container");
      const scroller = locateScroller();
      const containerRect = container?.getBoundingClientRect();
      const rowsInView = container === null || containerRect === undefined
        ? false
        : [...container.querySelectorAll<HTMLElement>("[data-transcript-row]")].some((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
          });
      let ready = false;
      if (content instanceof HTMLElement && scroller !== null && containerRect !== undefined) {
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const expected = initialAnchorRef.current === null
          ? maxScroll
          : Math.max(0, Math.min(initialAnchorRef.current, maxScroll));
        const height = content.getBoundingClientRect().height;
        const metricsStable = height === previousHeight && maxScroll === previousMaxScroll;
        previousHeight = height;
        previousMaxScroll = maxScroll;
        ready =
          content.childElementCount > 0 &&
          height > 0 &&
          metricsStable &&
          Math.abs(scroller.scrollTop - expected) <= 1 &&
          rowsInView;
      }
      stableFrames = ready ? stableFrames + 1 : 0;
      if (stableFrames >= REVEAL_STABILITY_FRAMES || rows.length === 0) {
        frame = requestAnimationFrame(() => setColdMount(false));
        return;
      }
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [locateScroller, rows.length]);
  useLayoutEffect(() => {
    if (!coldMount) skipPendingNavigationTransition();
  }, [coldMount, rows.length, locateScroller]);
  const warmOverlayRows = initialAnchorRef.current === null ? rows.slice(-24) : [];

  return (
    <div className="relative h-full min-h-0" ref={containerRef}>
      <DisclosureAnchorContext.Provider value={anchorController}>
      <LegendList<TranscriptRow>
        className={cn(
          "h-full min-h-0 overflow-x-hidden overscroll-y-contain [overflow-anchor:none]",
          coldMount && "invisible",
        )}
        data={rows as TranscriptRow[]}
        estimatedItemSize={72}
        getItemType={getItemType}
        keyExtractor={keyExtractor}
        // The composer dock floats over the list, so its measured height is
        // real scrollable content (a footer spacer), not an inset hint: the
        // scroll max then includes it, follow/scrollToEnd settle at the true
        // max, and the last row rests a full gap above the composer at every
        // viewport size.
        ListFooterComponent={<div style={{ height: bottomInset }} />}
        ListHeaderComponent={LIST_HEADER}
        maintainScrollAtEnd={maintainScrollAtEnd}
        maintainVisibleContentPosition={{ data: true, size: false }}
        onScroll={handleScroll}
        ref={listRef}
        renderItem={renderItem}
        {...(initialAnchorRef.current === null
          ? { initialScrollAtEnd: true }
          : { initialScrollOffset: initialAnchorRef.current })}
      />
      </DisclosureAnchorContext.Provider>
      {(newOutputPending || (!following && streaming)) && (
        <div
          className="pointer-events-none absolute inset-x-0 flex justify-center"
          style={{ bottom: bottomInset + 12 }}
        >
          <Button
            className="pointer-events-auto min-h-11 shadow-(--composer-shadow) sm:min-h-0"
            onClick={jumpToLatest}
            size="xs"
            variant="outline"
          >
            <ArrowDown aria-hidden="true" />
            New output
          </Button>
        </div>
      )}
      {coldMount && rows.length > 0 && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 overflow-hidden bg-(--transcript-background)"
          data-cold-mount-overlay
        >
          {warmOverlayRows.length > 0 && (
            <div
              className={cn(
                "flex h-full min-h-0 flex-col overflow-hidden",
                // Long transcripts pin to the tail; short ones top-align
                // exactly like the list's 16px header.
                warmOverlayRows.length >= 8 ? "justify-end" : "pt-4",
              )}
              style={{ paddingBottom: bottomInset }}
            >
              {warmOverlayRows.map((row) => (
                <div
                  className="mx-auto w-full max-w-(--transcript-measure) min-w-0 shrink-0 px-4 sm:px-6"
                  key={row.id}
                >
                  <TranscriptRowContent imageSource={imageSource} nowMs={nowMs} row={row} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
