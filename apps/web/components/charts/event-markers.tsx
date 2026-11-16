"use client";

import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  bucketMarkers,
  MARKER_FACE,
  MARKER_GLYPH,
  markerFaceMode,
  markerStack,
  type EventMarkerBucket,
  type EventMarkerItem,
  type MarkerSlot,
} from "@/lib/event-markers";
import { cn } from "@/lib/utils";
import { useChartHover, useChartStable } from "./chart-context";

/**
 * Point-in-time markers along the bottom of a time-series plot: one per
 * bucket that has at least one item, with the bucket's items in a popover.
 *
 * **Generic.** It knows items have a `kind` and an `at`, and nothing else.
 * Each kind brings its own glyph and its own words through `kinds`, and the
 * popover's body comes from `renderContent`, so sales, mentions and later
 * notes or commits share one layer instead of three that overlap.
 *
 * **Several kinds in one bucket stack**, one glyph per kind, bottom-up in
 * the order `kinds` lists them. One glyph per kind (never per item) keeps a
 * 90-bucket chart calm: the glyph says "something of this kind happened
 * here", and the popover says how much.
 *
 * **Faces when there's room.** A kind may bring a `face`: who is behind the
 * bucket's items (a mention's author, a sale's buyer), about 20px. With at
 * most 45 buckets, each wide enough for one (`markerFaceMode`), the face
 * stands in for the glyph; otherwise every kind keeps its glyph. A kind may
 * have no face for one bucket's items (sales that matched no visitor), and
 * that bucket keeps the glyph. Two faces in one bucket overlap by 6px, the
 * lower one first. A face keeps its kind readable without colour on its own
 * (its ring and badge), and the button's label, hit area and focus ring are
 * the same either way.
 *
 * **HTML, not SVG.** The chart's `<svg>` is `aria-hidden`, so a marker drawn
 * inside it could be neither focused nor read. The markers portal into the
 * chart's container (the same door the tooltip uses) as real buttons, each
 * with a label that spells out the bucket ("Jul 12: 2 mentions, 1 sale").
 */

export type EventMarkerKind<P = unknown> = {
  /** "2 mentions", "1 sale" — read out in the marker's label. */
  describe: (count: number) => string;
  /** The small mark drawn for this kind, about 8px. */
  glyph: ReactNode;
  /**
   * The bucket's items of this kind (newest first) as a face, 20px, drawn
   * instead of the glyph when the chart has room, or `null` when these items
   * have no face and the glyph should stay. Decorative: the marker's label
   * already says what is there.
   */
  face?: (items: readonly EventMarkerItem<string, P>[]) => ReactNode | null;
};

export interface EventMarkersProps<K extends string, P> {
  items: readonly EventMarkerItem<K, P>[];
  /** Exclusive end of the last bucket (the range's `to`). */
  endMs: number;
  /** Kinds in stacking order, bottom first. Items of an unlisted kind are not drawn. */
  kinds: Readonly<Record<K, EventMarkerKind<P>>>;
  /** The bucket's name in the chart's own zone and grain. */
  bucketLabel: (start: Date) => string;
  renderContent: (bucket: EventMarkerBucket<K, P>) => ReactNode;
}

/** Clear of the plot's bottom edge, so the glyphs sit above the axis rule. */
const BOTTOM_INSET = 6;

/**
 * Asks once, after the first commit, whether the snapshot changed: the
 * chart's container is attached by then, so the layer renders a second time
 * with somewhere to portal into. Null on the server and in the first render.
 */
const checkAfterCommit = (onChange: () => void) => {
  onChange();
  return () => {};
};

export function EventMarkers<K extends string, P>(props: EventMarkersProps<K, P>) {
  const { containerRef } = useChartStable();
  const container = useSyncExternalStore(
    checkAfterCommit,
    () => containerRef.current,
    () => null
  );
  if (!container) return null;
  return createPortal(<EventMarkersLayer {...props} />, container);
}

/** Drawn after the interaction overlay, outside the series clip. */
EventMarkers.__isPostOverlay = true;

function EventMarkersLayer<K extends string, P>({
  items,
  endMs,
  kinds,
  bucketLabel,
  renderContent,
}: EventMarkersProps<K, P>) {
  const { data, xAccessor, xScale, margin, innerHeight, width, columnWidth, chartStatus } =
    useChartStable();

  const { setTooltipData } = useChartHover();

  const kindOrder = useMemo(() => Object.keys(kinds) as K[], [kinds]);
  const starts = useMemo(
    () => data.map((point) => xAccessor(point).getTime()),
    [data, xAccessor]
  );
  const buckets = useMemo(
    () =>
      bucketMarkers(
        starts,
        endMs,
        items.filter((item) => item.kind in kinds),
        kindOrder
      ),
    [starts, endMs, items, kinds, kindOrder]
  );

  if (chartStatus === "loading" || buckets.length === 0 || width <= 0) return null;

  /**
   * A portal still bubbles React events through the React tree, and this
   * layer is a child of the plot's interaction `<g>`: left alone, a pointer
   * over a marker reached the chart's handlers with coordinates measured from
   * the button and pinned the crosshair to the first bucket. The layer keeps
   * its events to itself, and entering a marker puts the chart tooltip away
   * so the two never show at once.
   */
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  const layerHandlers = {
    onMouseDown: stop,
    onMouseMove: stop,
    onMouseUp: stop,
    onTouchEnd: stop,
    onTouchMove: stop,
    onTouchStart: stop,
    onMouseEnter: () => setTooltipData(null),
  };

  const faces = markerFaceMode(data.length, columnWidth);
  // Wide enough to aim at, never wider than a bucket, so neighbours don't
  // overlap; face mode only runs on columns wide enough for this width.
  const hitWidth = Math.max(
    (faces ? MARKER_FACE : MARKER_GLYPH) + 4,
    Math.min(24, columnWidth || 24)
  );
  const bottom = margin.top + innerHeight - BOTTOM_INSET;

  return (
    <div className="pointer-events-none absolute inset-0 z-1 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
      {buckets.map((bucket) => {
        const start = new Date(bucket.startMs);
        // Each kind's face for this bucket, or null for its glyph.
        const marks = bucket.kinds.map((kind) => {
          const face = faces ? (kinds[kind].face?.(bucket.byKind[kind] ?? []) ?? null) : null;
          return { kind, face, slot: (face === null ? "glyph" : "face") as MarkerSlot };
        });
        const stack = markerStack(marks.map((mark) => mark.slot));
        const hitHeight = stack.height + 8;
        // The plot runs edge to edge, so the first and last buckets sit on the
        // card's edge; the centre is clamped to keep the whole mark visible.
        const centre = Math.min(
          Math.max(margin.left + xScale(start), hitWidth / 2),
          width - hitWidth / 2
        );
        const label = `${bucketLabel(start)}: ${bucket.kinds
          .map((kind) => kinds[kind].describe(bucket.counts[kind] ?? 0))
          .join(", ")}`;
        return (
          <Popover key={bucket.startMs}>
            <PopoverTrigger
              aria-label={label}
              className={cn(
                "pointer-events-auto absolute flex cursor-pointer flex-col-reverse items-center justify-start rounded-full pb-1 outline-none",
                "transition-[background-color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring",
                "data-popup-open:bg-black/6 [@media(hover:hover)]:hover:bg-black/6"
              )}
              closeDelay={120}
              delay={150}
              openOnHover
              {...layerHandlers}
              style={{
                left: centre - hitWidth / 2,
                top: bottom - hitHeight + 4,
                width: hitWidth,
                height: hitHeight,
              }}
            >
              {marks.map((mark, index) => {
                const size = mark.slot === "face" ? MARKER_FACE : MARKER_GLYPH;
                return (
                  <span
                    aria-hidden="true"
                    className="flex shrink-0 items-center justify-center"
                    key={mark.kind}
                    // The stack is column-reverse: a mark's offset from the
                    // one below it is its bottom margin (2px between two
                    // faces, so neither hides the other).
                    style={{ width: size, height: size, marginBottom: stack.offsets[index] }}
                  >
                    {mark.face ?? kinds[mark.kind].glyph}
                  </span>
                );
              })}
            </PopoverTrigger>
            <PopoverPopup
              className="w-72 max-w-[calc(100vw-2rem)]"
              side="top"
              sideOffset={6}
            >
              {renderContent(bucket)}
            </PopoverPopup>
          </Popover>
        );
      })}
    </div>
  );
}
