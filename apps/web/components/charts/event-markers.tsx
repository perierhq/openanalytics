"use client";

import { motion, useReducedMotion, type Transition } from "motion/react";
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
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
import { markerAnchorY, markerHasStem, placeMarker } from "@/lib/marker-placement";
import { cn } from "@/lib/utils";
import { useChartHover, useChartStable, useYScale } from "./chart-context";

/**
 * Point-in-time markers on a time-series plot: one per bucket that has at
 * least one item, with the bucket's items in a popover.
 *
 * **On the line.** Each bucket's stack is anchored to the drawn series'
 * value at that bucket (`anchorKey`), through the y scale the line uses, so
 * a sale reads against the traffic it came with. Faces stand above their
 * point on a thin stem, with a dot on the line; small marks (a dense chart's
 * glyphs, a lone note's flag) sit just above it with the dot and no stem
 * (`lib/marker-placement.ts`). A bucket where the series has no value keeps
 * the plot's bottom. The markers
 * follow the line in time too: they wipe in with its reveal clip, glide to a
 * new point when the metric changes (not under reduced motion), and fade
 * with the scrub dim right of the cursor.
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
 * that bucket keeps the glyph. Two faces in one bucket sit one above the
 * other, far enough apart that their "+N" badges never meet
 * (`markerStack`). A face keeps its kind readable without colour on its own
 * (its ring and badge), and the button's label, hit area and focus ring are
 * the same either way.
 *
 * **A popover someone is writing in stays open.** The popover opens on hover,
 * and a pointer drifting off it closes it, which is right for reading and
 * wrong for a half-typed note. `renderContent` gets `setEngaged`; while it is
 * set, only Escape, a click outside or a close from the content end it.
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
  /**
   * This kind's mark stands on its own (a note's flag has a pole): a bucket
   * holding only this kind sits just above the line without a stem, even
   * when the chart draws faces.
   */
  stemless?: boolean;
};

/** What a popover's content may ask of the marker that opened it. */
export type EventMarkerContentControls = {
  /** Keep the popover open against hover-out while something is being edited. */
  setEngaged: (engaged: boolean) => void;
};

export interface EventMarkersProps<K extends string, P> {
  items: readonly EventMarkerItem<K, P>[];
  /** Exclusive end of the last bucket (the range's `to`). */
  endMs: number;
  /** Kinds in stacking order, bottom first. Items of an unlisted kind are not drawn. */
  kinds: Readonly<Record<K, EventMarkerKind<P>>>;
  /** The bucket's name in the chart's own zone and grain. */
  bucketLabel: (start: Date) => string;
  renderContent: (bucket: EventMarkerBucket<K, P>, controls: EventMarkerContentControls) => ReactNode;
  /**
   * The drawn series the markers sit on (its `dataKey`). Without one, or
   * where it has no value, a stack sits on the plot's bottom.
   */
  anchorKey?: string;
  /** That series' y axis, when it is not the default one. */
  yAxisId?: string | number;
  /**
   * The chart's scrub dim: while hovering, markers right of the hovered
   * bucket fade to this opacity, as the series do. Omit for no dim.
   */
  dimOpacity?: number;
}

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

/** The line's own enter transition as CSS, for the glide between points. */
function cssTransition(transition: Transition | undefined): { ms: number; ease: string } {
  const ease = transition?.ease;
  const bezier =
    Array.isArray(ease) && ease.length === 4 && ease.every((n) => typeof n === "number")
      ? `cubic-bezier(${ease.join(",")})`
      : "cubic-bezier(0.32,0.72,0,1)";
  const seconds = typeof transition?.duration === "number" ? transition.duration : 0.5;
  return { ms: Math.round(seconds * 1000), ease: bezier };
}

/** Insets past the layer's edges: nothing clipped, focus rings included. */
const UNCLIPPED = "inset(-64px -64px -64px -64px)";

/** The dot on the line under a stack. */
const DOT = 5;

function EventMarkersLayer<K extends string, P>({
  items,
  endMs,
  kinds,
  bucketLabel,
  renderContent,
  anchorKey,
  yAxisId,
  dimOpacity,
}: EventMarkersProps<K, P>) {
  const {
    data,
    xAccessor,
    xScale,
    margin,
    innerHeight,
    innerWidth,
    width,
    columnWidth,
    chartPhase,
    enterTransition,
  } = useChartStable();
  const yScale = useYScale(yAxisId);
  const { tooltipData, setTooltipData, selection } = useChartHover();
  const reduceMotion = useReducedMotion() ?? false;

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

  // Drawn while the series is: wiping in, at rest, and wiping out.
  const drawn =
    chartPhase === "revealing" || chartPhase === "ready" || chartPhase === "exitingReady";
  if (!drawn || buckets.length === 0 || width <= 0) return null;

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
  const markWidth = faces ? MARKER_FACE : MARKER_GLYPH;
  const hitWidth = Math.max(markWidth + 4, Math.min(24, columnWidth || 24));

  // The series' own timing, so a marker arrives at its new point with the
  // line. None under reduced motion: the marker is simply there.
  const { ms, ease } = cssTransition(enterTransition);
  const glide = reduceMotion ? "" : `transform ${ms}ms ${ease}, clip-path ${ms}ms ${ease}`;
  // The scrub dim's own fade (`ScrubDimRect`): opacity reads the same with
  // reduced motion.
  const fade = "opacity 150ms ease-out";
  const moving = (extra?: string): CSSProperties => ({
    transition: [glide, extra].filter(Boolean).join(", ") || undefined,
  });

  // Scrubbing: the cut the series dim at, right of the hovered bucket.
  const scrubCut =
    dimOpacity != null && tooltipData && selection?.active !== true
      ? Math.min(innerWidth, tooltipData.x + columnWidth / 2)
      : null;
  const hoveredIndex = tooltipData?.index ?? null;

  /*
   * The reveal: the line wipes in left to right through a clip; this layer
   * follows with the same clip edge (the plot's left edge to its right
   * edge) on the same transition, then drops the clip so focus rings at the
   * card's edge are not cut. The conceal mirrors it, as the series does.
   */
  const animateClip = !reduceMotion;
  const clipFrom =
    animateClip && chartPhase === "revealing"
      ? `inset(-64px ${width - margin.left}px -64px -64px)`
      : UNCLIPPED;
  const clipTo =
    chartPhase === "revealing"
      ? `inset(-64px ${Math.max(0, width - margin.left - innerWidth)}px -64px -64px)`
      : chartPhase === "exitingReady" && animateClip
        ? `inset(-64px -64px -64px ${margin.left + innerWidth}px)`
        : UNCLIPPED;
  const clipTransition: Transition =
    animateClip && chartPhase !== "ready"
      ? { duration: ms / 1000, ease: enterTransition?.ease ?? [0.32, 0.72, 0, 1] }
      : { duration: 0 };

  return (
    <motion.div
      animate={{ clipPath: clipTo }}
      // Under the crosshair and its dots (z-2 in the tooltip), so a marker on
      // the line never covers the hovered point.
      className="pointer-events-none absolute inset-0 z-1 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
      initial={{ clipPath: clipFrom }}
      transition={clipTransition}
    >
      {buckets.map((bucket) => {
        const start = new Date(bucket.startMs);
        // Each kind's face for this bucket, or null for its glyph.
        const marks = bucket.kinds.map((kind) => {
          const face = faces ? (kinds[kind].face?.(bucket.byKind[kind] ?? []) ?? null) : null;
          return { kind, face, slot: (face === null ? "glyph" : "face") as MarkerSlot };
        });
        const stack = markerStack(marks.map((mark) => mark.slot));
        const anchor = anchorKey
          ? markerAnchorY(data[bucket.index], anchorKey, (value) => yScale(value))
          : null;
        const at = placeMarker({
          anchorY: anchor,
          stackHeight: stack.height,
          stem: markerHasStem(
            faces,
            marks.map((mark) => kinds[mark.kind])
          ),
          plotHeight: innerHeight,
          hovered: hoveredIndex === bucket.index,
        });

        const pointX = margin.left + xScale(start);
        // The plot runs edge to edge, so the first and last buckets sit on the
        // card's edge; the centre is clamped to keep the whole mark visible.
        const centre = Math.min(Math.max(pointX, hitWidth / 2), width - hitWidth / 2);
        // The stem and dot stay under the stack where the stack was clamped.
        const lineX = Math.min(
          Math.max(pointX, centre - markWidth / 2 + 2),
          centre + markWidth / 2 - 2
        );
        const hitHeight = stack.height + 8;
        const dimmed = scrubCut !== null && pointX - margin.left > scrubCut;

        // The stem, collapsed onto the point where a bucket has none, so it
        // grows and shrinks instead of popping when the stack flips or the
        // chart turns dense.
        const stem = at.stem ?? { top: at.anchorY, bottom: at.anchorY };

        const label = `${bucketLabel(start)}: ${bucket.kinds
          .map((kind) => kinds[kind].describe(bucket.counts[kind] ?? 0))
          .join(", ")}`;
        return (
          <div
            className="absolute inset-0"
            key={bucket.startMs}
            style={{ opacity: dimmed ? dimOpacity : 1, transition: fade }}
          >
            <span
              aria-hidden="true"
              className="absolute left-0 w-px bg-foreground/40"
              style={{
                top: margin.top,
                height: innerHeight,
                transform: `translateX(${lineX - 0.5}px)`,
                clipPath: `inset(${stem.top}px 0px ${Math.max(0, innerHeight - stem.bottom)}px 0px)`,
                ...moving(),
              }}
            />
            <span
              aria-hidden="true"
              className="absolute top-0 left-0 rounded-full bg-foreground/55 shadow-[0_0_0_1.5px_var(--chart-background)]"
              style={{
                width: DOT,
                height: DOT,
                opacity: at.dot ? 1 : 0,
                transform: `translate(${lineX - DOT / 2}px, ${margin.top + at.anchorY - DOT / 2}px)`,
                ...moving(fade),
              }}
            />
            <MarkerPopover>
              <PopoverTrigger
                aria-label={label}
                className={cn(
                  "pointer-events-auto absolute top-0 left-0 flex cursor-pointer flex-col-reverse items-center justify-start rounded-full pb-1 outline-none",
                  "focus-visible:ring-2 focus-visible:ring-ring",
                  "data-popup-open:bg-black/6 [@media(hover:hover)]:hover:bg-black/6"
                )}
                closeDelay={120}
                delay={150}
                openOnHover
                {...layerHandlers}
                style={{
                  width: hitWidth,
                  height: hitHeight,
                  // The hit area reaches 4px past the stack on each side.
                  transform: `translate(${centre - hitWidth / 2}px, ${margin.top + at.stackTop - 4}px)`,
                  ...moving("background-color 150ms ease-out"),
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
                      // one below it is its bottom margin (`markerStack`).
                      style={{ width: size, height: size, marginBottom: stack.offsets[index] }}
                    >
                      {mark.face ?? kinds[mark.kind].glyph}
                    </span>
                  );
                })}
              </PopoverTrigger>
              <MarkerPopoverContent>
                {(controls) => renderContent(bucket, controls)}
              </MarkerPopoverContent>
            </MarkerPopover>
          </div>
        );
      })}
    </motion.div>
  );
}

const NOT_ENGAGED: EventMarkerContentControls = { setEngaged: () => {} };
const MarkerControlsContext = createContext<EventMarkerContentControls>(NOT_ENGAGED);

/**
 * One bucket's popover, controlled so that an engaged popover (a form open in
 * it) ignores the hover-out and focus-out that would otherwise close it.
 */
function MarkerPopover({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const engaged = useRef(false);
  const controls = useMemo<EventMarkerContentControls>(
    () => ({
      setEngaged: (next) => {
        engaged.current = next;
      },
    }),
    []
  );
  return (
    <Popover
      onOpenChange={(next, details) => {
        if (
          !next &&
          engaged.current &&
          (details.reason === "trigger-hover" || details.reason === "focus-out")
        ) {
          return;
        }
        if (!next) engaged.current = false;
        setOpen(next);
      }}
      open={open}
    >
      <MarkerControlsContext.Provider value={controls}>{children}</MarkerControlsContext.Provider>
    </Popover>
  );
}

function MarkerPopoverContent({
  children,
}: {
  children: (controls: EventMarkerContentControls) => ReactNode;
}) {
  const controls = useContext(MarkerControlsContext);
  return (
    <PopoverPopup className="w-72 max-w-[calc(100vw-2rem)]" side="top" sideOffset={6}>
      {children(controls)}
    </PopoverPopup>
  );
}
