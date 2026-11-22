"use client";

import { motion, useReducedMotion, type Transition } from "motion/react";
import {
  createContext,
  memo,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
import {
  markerAnchorY,
  markerHasStem,
  markerHitWidth,
  placeMarker,
  type MarkerGeometry,
} from "@/lib/marker-placement";
import { cn } from "@/lib/utils";
import { clipRevealTransition, DEFAULT_CHART_ENTER_TRANSITION } from "./animation";
import { CHART_LAYER_Z } from "./chart-layers";
import { type Margin, useChartHover, useChartStable, useYScale } from "./chart-context";
import { isChartInteractionPhase } from "./chart-phase";
import { scrubDimCut } from "./scrub-dim";

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
 * the plot's bottom.
 *
 * **In step with the line.** The markers wipe in with the line's reveal
 * clip, on the same transition (none under reduced motion), and fade with
 * the scrub dim right of the cursor, at the same cut (`scrubDimCut`). They
 * do not glide: the line redraws at once when the metric changes, the chart
 * resizes or the data refreshes, so the markers move at once with it rather
 * than trailing behind.
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
 * **Hover opens a face; a dense chart's glyphs wait for a click.** On a
 * dense chart a glyph sits in every few pixels of the line, and a popover
 * opening under a pointer sweeping across it would get in the way of
 * scrubbing; there each marker opens on click (or Enter), its hit area stays
 * inside its bucket's column, and the chart's tooltip keeps running.
 *
 * **A popover someone is writing in stays open.** A hovered popover closes
 * when the pointer drifts off it, which is right for reading and
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

/** Insets past the layer's edges: nothing clipped, focus rings included. */
const UNCLIPPED = "inset(-64px -64px -64px -64px)";


/** One bucket's marker, laid out: everything but the hover. */
type BucketLayout<K extends string, P> = {
  bucket: EventMarkerBucket<K, P>;
  /** Each kind's face for this bucket, or null for its glyph. */
  marks: { kind: K; face: ReactNode | null; slot: MarkerSlot }[];
  offsets: number[];
  stackHeight: number;
  at: MarkerGeometry;
  /** The point's x on the card: where the stem and dot stand. */
  pointX: number;
  /** The stack's centre, kept inside the card at its edges. */
  centre: number;
  label: string;
};

/** What a marker's button does with the pointer (`EventMarkersLayer`). */
type TriggerHandlers = {
  onMouseDown: (event: { stopPropagation: () => void }) => void;
  onMouseMove: (event: { stopPropagation: () => void }) => void;
  onMouseUp: (event: { stopPropagation: () => void }) => void;
  onTouchEnd: (event: { stopPropagation: () => void }) => void;
  onTouchMove: (event: { stopPropagation: () => void }) => void;
  onTouchStart: (event: { stopPropagation: () => void }) => void;
  onMouseEnter?: () => void;
};

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

function EventMarkersLayer<K extends string, P>({
  items,
  endMs,
  kinds,
  bucketLabel,
  renderContent,
  anchorKey,
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
    isLoaded,
    animationDuration,
    enterTransition,
  } = useChartStable();
  const yScale = useYScale();
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

  const faces = markerFaceMode(data.length, columnWidth);
  const hitWidth = markerHitWidth(faces, columnWidth);
  const marginLeft = margin.left;

  /*
   * Faces, stacks and positions, worked out once per bucket. They change
   * with the buckets and the chart's geometry, never with the hover, so a
   * moving crosshair re-renders the layer but no bucket whose dim it leaves
   * alone (`MarkerBucket` is memoised on this object).
   */
  const layout = useMemo<BucketLayout<K, P>[]>(
    () =>
      buckets.map((bucket) => {
        const start = new Date(bucket.startMs);
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
        });
        const pointX = marginLeft + xScale(start);
        return {
          bucket,
          marks,
          offsets: stack.offsets,
          stackHeight: stack.height,
          at,
          pointX,
          // The plot runs edge to edge, so the first and last buckets sit on
          // the card's edge: the stack moves in to stay whole, while the stem
          // and dot keep the true point.
          centre: Math.min(Math.max(pointX, hitWidth / 2), width - hitWidth / 2),
          label: `${bucketLabel(start)}: ${bucket.kinds
            .map((kind) => kinds[kind].describe(bucket.counts[kind] ?? 0))
            .join(", ")}`,
        };
      }),
    [buckets, faces, kinds, anchorKey, data, yScale, xScale, marginLeft, innerHeight, width, hitWidth, bucketLabel]
  );

  /**
   * A portal still bubbles React events through the React tree, and this
   * layer is a child of the plot's interaction `<g>`: left alone, a pointer
   * over a marker reached the chart's handlers with coordinates measured from
   * the button and pinned the crosshair to the first bucket. The layer keeps
   * its events to itself. Entering a face puts the chart tooltip away, so the
   * face's popover and the tooltip never show at once; a dense chart's
   * glyphs open on click only, and leave the tooltip where it is.
   */
  const handlers = useMemo<TriggerHandlers>(
    () => ({
      onMouseDown: stop,
      onMouseMove: stop,
      onMouseUp: stop,
      onTouchEnd: stop,
      onTouchMove: stop,
      onTouchStart: stop,
      ...(faces ? { onMouseEnter: () => setTooltipData(null) } : {}),
    }),
    [faces, setTooltipData]
  );

  // Drawn while the series is: wiping in, at rest, and wiping out.
  const drawn =
    chartPhase === "revealing" || chartPhase === "ready" || chartPhase === "exitingReady";
  if (!drawn || buckets.length === 0 || width <= 0) return null;

  // Scrubbing: the cut the series dim at, right of the hovered bucket.
  const scrubCut = scrubDimCut({
    dimOpacity,
    canInteract: isLoaded && isChartInteractionPhase(chartPhase),
    tooltipX: tooltipData?.x,
    selecting: selection?.active === true,
    innerWidth,
    columnWidth,
  });

  /*
   * The reveal: the line wipes in left to right through a clip; this layer
   * follows with the same clip edge (the plot's left edge to its right
   * edge) on the line's own transition (`ChartRevealClip`), then drops the
   * clip so focus rings at the card's edge are not cut. The conceal mirrors
   * it, as the series does. None under reduced motion: the markers are
   * simply there.
   */
  const animateClip = !reduceMotion && animationDuration > 0;
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
      ? clipRevealTransition(
          enterTransition ?? {
            ...DEFAULT_CHART_ENTER_TRANSITION,
            duration: animationDuration / 1000,
          }
        )
      : { duration: 0 };

  return (
    <motion.div
      animate={{ clipPath: clipTo }}
      className="pointer-events-none absolute inset-0 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
      data-chart-layer="markers"
      initial={{ clipPath: clipFrom }}
      // Over the crosshair's line, under its dots (`CHART_LAYER_Z`), so a
      // marker on the line never covers the hovered point.
      style={{ zIndex: CHART_LAYER_Z.markers }}
      transition={clipTransition}
    >
      {layout.map((entry) => (
        <MarkerBucket
          dimOpacity={dimOpacity ?? 1}
          dimmed={scrubCut !== null && entry.pointX - margin.left > scrubCut}
          entry={entry}
          faces={faces}
          handlers={handlers}
          hitWidth={hitWidth}
          innerHeight={innerHeight}
          key={entry.bucket.startMs}
          kinds={kinds}
          margin={margin}
          renderContent={renderContent}
        />
      ))}
    </motion.div>
  );
}

/** The dot on the line under a stack. */
const DOT = 5;

/** The scrub dim's own fade (`ScrubDimRect`): opacity reads the same with reduced motion. */
const FADE = "opacity 150ms ease-out";

type MarkerBucketProps<K extends string, P> = {
  entry: BucketLayout<K, P>;
  /** Right of the scrub cut. */
  dimmed: boolean;
  dimOpacity: number;
  faces: boolean;
  hitWidth: number;
  margin: Margin;
  innerHeight: number;
  kinds: Readonly<Record<K, EventMarkerKind<P>>>;
  handlers: TriggerHandlers;
  renderContent: EventMarkersProps<K, P>["renderContent"];
};

/**
 * One bucket's stem, dot and button. Memoised: on a hover move only the
 * buckets whose dim flips render again.
 */
const MarkerBucket = memo(function MarkerBucket<K extends string, P>({
  entry,
  dimmed,
  dimOpacity,
  faces,
  hitWidth,
  margin,
  innerHeight,
  kinds,
  handlers,
  renderContent,
}: MarkerBucketProps<K, P>) {
  const { bucket, marks, offsets, stackHeight, at, pointX, centre, label } = entry;
  return (
    <div
      className="absolute inset-0"
      data-marker-bucket={bucket.index}
      style={{ opacity: dimmed ? dimOpacity : 1, transition: FADE }}
    >
      {at.stem ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 w-px bg-foreground/40"
          data-marker-stem=""
          style={{
            height: Math.max(0, Math.min(at.stem.bottom, innerHeight) - at.stem.top),
            transform: `translate(${pointX - 0.5}px, ${margin.top + at.stem.top}px)`,
          }}
        />
      ) : null}
      {at.dot ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 rounded-full bg-foreground/55 shadow-[0_0_0_1.5px_var(--chart-background)]"
          data-marker-dot=""
          style={{
            width: DOT,
            height: DOT,
            transform: `translate(${pointX - DOT / 2}px, ${margin.top + at.anchorY - DOT / 2}px)`,
          }}
        />
      ) : null}
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
          openOnHover={faces}
          {...handlers}
          style={{
            width: hitWidth,
            height: stackHeight + 8,
            // The hit area reaches 4px past the stack on each side.
            transform: `translate(${centre - hitWidth / 2}px, ${margin.top + at.stackTop - 4}px)`,
            transition: "background-color 150ms ease-out",
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
                style={{ width: size, height: size, marginBottom: offsets[index] }}
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
}) as <K extends string, P>(props: MarkerBucketProps<K, P>) => ReactNode;

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
