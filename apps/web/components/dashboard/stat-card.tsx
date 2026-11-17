"use client";

import { InformationCircleIcon } from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { createPortal } from "react-dom";
import { SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { SquircleSurface } from "@/components/ui/squircle-card";
import {
  AVG_VISIT_COLOR,
  BOUNCE_RATE_COLOR,
  PAGEVIEWS_COLOR,
  VISITORS_COLOR,
} from "@/components/dashboard/overview-chart-tooltip";
import { StatComparison } from "@/components/dashboard/stat-comparison";
import type { ChartMetric, Delta } from "@/lib/overview-compare";
import { cn } from "@/lib/utils";

/**
 * A stat tile: the overview's five and the public share board's, one
 * anatomy. Its own module, apart from the overview's reads, so a tile renders
 * (and is tested) without the API client.
 */

/** `display: null` means the number's read is still in flight. */
export type Stat = {
  label: string;
  display: string | null;
  info: string;
  /**
   * The previous period, while the overview compares: `undefined` when it
   * does not (or this tile has nothing to compare), `null` while the
   * previous read is in flight.
   */
  comparison?: StatComparisonValue | null;
};

export type StatComparisonValue = { delta: Delta; previous: string };

/**
 * A tile that drives the chart: a button that puts its metric on the chart
 * (`pressed` when it is the one drawn). Absent on a tile that cannot (the
 * share board's tiles, revenue without bars, the session tiles under a
 * filter).
 */
export type StatChartControl = {
  metric: ChartMetric;
  pressed: boolean;
  onPress: () => void;
};

/** The series colour a selected tile wears, matching its line on the chart. */
const METRIC_COLOR: Record<ChartMetric, string> = {
  visitors: VISITORS_COLOR,
  pageviews: PAGEVIEWS_COLOR,
  bounce_rate: BOUNCE_RATE_COLOR,
  avg_visit: AVG_VISIT_COLOR,
  revenue: "var(--success)",
};

const emptySubscribe = () => () => {};

/**
 * Where a hover tip opens: above the centre of the element it explains.
 * `open`/`close` go on that element's pointer and focus handlers.
 */
function useTipAnchor<T extends HTMLElement>() {
  const ref = React.useRef<T>(null);
  const [anchor, setAnchor] = React.useState<{ x: number; y: number } | null>(
    null
  );
  const open = React.useCallback(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: rect.left + rect.width / 2, y: rect.top - 8 });
  }, []);
  const close = React.useCallback(() => setAnchor(null), []);
  return { ref, anchor, open, close };
}

/**
 * The house tooltip pill — the dark one the tab bar uses — portalled to
 * <body> and opened *upward*: rendered in place it would be trapped inside
 * a card's squircle clip.
 */
function TipPill({
  anchor,
  text,
  width,
}: {
  anchor: { x: number; y: number } | null;
  text: string;
  width: string;
}) {
  const mounted = React.useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
  if (!mounted) return null;
  return createPortal(
    <AnimatePresence>
      {anchor ? (
        <span
          className="pointer-events-none fixed z-[70]"
          style={{
            left: anchor.x,
            top: anchor.y,
            transform: "translate(-50%, -100%)",
          }}
        >
          <motion.span
            animate={{ opacity: 1, y: 0, scale: 1 }}
            className={`block ${width} rounded-[12px] bg-[#1c1c1f] px-3 py-2 text-[12px] font-normal leading-4.5 text-white shadow-[0_1px_1px_rgba(0,0,0,0.3),0_8px_24px_rgba(0,0,0,0.35)] ring-1 ring-white/10`}
            exit={{
              opacity: 0,
              y: 4,
              scale: 0.95,
              transition: { duration: 0.1 },
            }}
            initial={{ opacity: 0, y: 6, scale: 0.9 }}
            role="tooltip"
            transition={{ type: "spring", stiffness: 550, damping: 40 }}
          >
            {text}
          </motion.span>
        </span>
      ) : null}
    </AnimatePresence>,
    document.body
  );
}

/**
 * The little ⓘ beside a card's title: hover (or keyboard focus) pops a short
 * plain-words explanation in the house tooltip language. Exported for the
 * one breakdown card that carries a caveat in its title (AI referrals), so
 * a tip beside any title reads the same.
 */
export function InfoTip({
  text,
  width = "w-52",
}: {
  text: string;
  /** The pill's width class. The stat cards' one-liners fit the default; a
   *  longer caveat asks for a wider pill rather than a taller one. */
  width?: string;
}) {
  const { ref, anchor, open, close } = useTipAnchor<HTMLSpanElement>();
  return (
    <span
      ref={ref}
      className="inline-flex"
      onBlur={close}
      onFocus={open}
      onMouseEnter={open}
      onMouseLeave={close}
      tabIndex={0}
    >
      <InformationCircleIcon
        aria-hidden="true"
        className="size-3.5 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
      />
      <span className="sr-only">{text}</span>
      <TipPill anchor={anchor} text={text} width={width} />
    </span>
  );
}

/** The skeleton stand-in for a comparison line still in flight: its height. */
export function ComparisonLine({
  comparison,
}: {
  comparison: StatComparisonValue | null | undefined;
}) {
  if (comparison === undefined) return null;
  if (comparison === null) {
    return (
      <p className="mt-1 flex h-5 items-center">
        <span className="h-3.5 w-20 rounded bg-muted-foreground/15" />
      </p>
    );
  }
  return <StatComparison delta={comparison.delta} previous={comparison.previous} />;
}

/**
 * A stat tile's frame: label in the top strip, value on the inset panel.
 *
 * With a `chart` control the tile drives the overview chart. A selectable
 * tile is a real `<button>` laid over the whole frame (`aria-pressed`, so
 * it is announced as a toggle and works from the keyboard), with the ⓘ
 * raised above it so the tip stays its own control rather than nesting one
 * interactive element inside another. Pressed, the frame turns ink and a
 * dot in the series colour ties the tile to its line. A tile that cannot
 * drive the chart (revenue without bars, the session tiles under a filter)
 * stays a plain surface.
 */
export function StatFrame({
  label,
  info,
  chart,
  children,
}: {
  label: string;
  info: string;
  chart?: StatChartControl;
  children: React.ReactNode;
}) {
  const selectable = chart ?? null;
  return (
    <SquircleSurface
      className={cn(
        "flex flex-col rounded-[24px] border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:13px] sm:rounded-[30px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:17px]",
        selectable &&
          "transition-[border-color,background-color,scale] duration-150 has-[>button:active]:scale-[0.98]",
        selectable && !selectable.pressed && "[@media(hover:hover)]:has-[>button:hover]:bg-accent/40",
        selectable?.pressed && "border-foreground"
      )}
    >
      {selectable ? (
        <button
          aria-label={`${label} on the chart`}
          aria-pressed={selectable.pressed}
          className="peer absolute inset-0 z-[1] cursor-pointer outline-none"
          onClick={selectable.onPress}
          type="button"
        />
      ) : null}
      <p className="pointer-events-none relative z-[2] flex items-center gap-1.5 pb-1.5 pl-3.5 pr-3 pt-1">
        <span className="select-none text-sm font-medium text-foreground/80">
          {label}
        </span>
        <span className="pointer-events-auto inline-flex">
          <InfoTip text={info} />
        </span>
        {selectable?.pressed ? (
          <span
            aria-hidden="true"
            className="ml-auto size-2 shrink-0 rounded-full"
            style={{ backgroundColor: METRIC_COLOR[selectable.metric] }}
          />
        ) : null}
      </p>
      {/* The keyboard focus ring is drawn here, inset: the frame's squircle
          clip cuts off any ring drawn outside a surface, and the frame's own
          border is taken by the pressed state. Inside the value panel nothing
          clips it, pressed or not. */}
      <SquircleSurface className="flex-1 rounded-[20px] border border-border bg-[#f6f6f6] px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:11px] peer-focus-visible:ring-2 peer-focus-visible:ring-inset peer-focus-visible:ring-ring sm:rounded-[26px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:14px]">
        {children}
      </SquircleSurface>
    </SquircleSurface>
  );
}

/**
 * Same anatomy as the mini cards: label in the frame's top strip, value on
 * the inset panel, and — while the overview compares — the change and the
 * previous value under it.
 *
 * The frame and the label are chrome — real from the first frame, like a
 * settings panel's title. Only the number waits on the network, so only the
 * number gets a stand-in and the blur: the card never reads as a new card
 * arriving, just as its figure coming into focus.
 *
 * Exported for the public share board, which renders the same cards over the
 * public overview read — one anatomy, two audiences. The board passes no
 * `chart` and no comparison, so its tiles stay plain.
 */
export function StatCard({
  stat,
  chart,
}: {
  stat: Stat;
  chart?: StatChartControl;
}) {
  return (
    <StatFrame chart={chart} info={stat.info} label={stat.label}>
      <SkeletonReveal
        ready={stat.display !== null}
        skeleton={
          // Exactly the number line's height (text-xl 28px / sm:text-2xl
          // 32px): a taller skeleton loads the chart a few px low, then
          // snaps it up when the real number lands.
          <p className="flex h-7 items-center sm:h-8">
            <span className="h-5 w-16 rounded bg-muted-foreground/15 sm:h-6" />
          </p>
        }
      >
        {stat.display === null ? null : (
          <p className="text-xl font-medium tabular-nums tracking-tight sm:text-2xl">
            {stat.display}
          </p>
        )}
      </SkeletonReveal>
      <ComparisonLine comparison={stat.comparison} />
    </StatFrame>
  );
}

