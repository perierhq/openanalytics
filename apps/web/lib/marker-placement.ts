/**
 * Where a bucket's marker stack sits on a time-series chart, given where the
 * drawn line is at that bucket.
 *
 * Pure geometry in plot coordinates (0 is the plot's top edge, `plotHeight`
 * its bottom). The layer that draws the markers (`components/charts/
 * event-markers.tsx`) turns the answer into pixels; nothing here knows what a
 * marker shows.
 *
 * The stack sits on the line: above its point, with a small dot on the line.
 * A stack of faces stands on a 1px stem, 12px long; small marks (a dense
 * chart's glyphs, a lone note's flag) sit 4px above the point with no stem.
 * Near the top of the plot the stack flips below the point; a stack too tall
 * for either side is clamped inside the plot. Where the line has no value,
 * the stack sits on the plot's bottom.
 */

import type { ChartMetric } from "./overview-compare";

/** Room kept clear at the top of the plot: the legend and chips sit there. */
export const PLOT_TOP_SAFE = 16;
/** Clear of the plot's bottom edge, so a stack sits above the axis rule. */
export const PLOT_BOTTOM_INSET = 6;
/** A stack on a stem: the stem's length, point to stack. */
export const STEM_GAP = 12;
/** A stack without a stem: its distance from the point. */
export const GLYPH_GAP = 4;
/**
 * The hovered bucket's crosshair dot is 5px with a 2px halo (6px out from the
 * point); a stack on that bucket keeps at least this far away so it never
 * covers the dot.
 */
export const HOVER_DOT_CLEARANCE = 7;

export interface MarkerPlacementInput {
  /** The drawn series' y at this bucket, or null where it has no value. */
  anchorY: number | null;
  /** The stack's drawn height (`markerStack(...).height`). */
  stackHeight: number;
  /** The stack stands on a stem (`markerHasStem`). */
  stem: boolean;
  plotHeight: number;
  /** The crosshair is on this bucket. */
  hovered?: boolean;
}

export type MarkerSide = "above" | "below" | "clamped" | "bottom";

export interface MarkerGeometry {
  /** The stack's top edge. */
  stackTop: number;
  side: MarkerSide;
  /** Where the stem and dot point: the line, or the plot's bottom. */
  anchorY: number;
  /** The stem between the stack and the point, top to bottom, if any. */
  stem: { top: number; bottom: number } | null;
  /** A small dot on the line at the anchor. */
  dot: boolean;
}

/**
 * Whether a bucket's stack stands on a stem: in faces mode, unless every
 * mark in it is one that stands on its own (`stemless`: a note's flag has a
 * pole of its own). A dense chart's glyphs never do; they sit close enough
 * to their point to read without one.
 */
export function markerHasStem(
  faceMode: boolean,
  marks: readonly { stemless?: boolean }[]
): boolean {
  return faceMode && marks.some((mark) => !mark.stemless);
}

/**
 * The drawn series' y at a bucket, through the scale the line itself uses,
 * or null where the series has no number (a bucket without sessions has no
 * bounce rate, and the line breaks there).
 */
export function markerAnchorY(
  point: Record<string, unknown> | undefined,
  dataKey: string,
  yScale: (value: number) => number | undefined
): number | null {
  const value = point?.[dataKey];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const y = yScale(value);
  return typeof y === "number" && Number.isFinite(y) ? y : null;
}

/**
 * A stack on the line: `STEM_GAP` above its point on a stem, or `GLYPH_GAP`
 * above it without one; below the point when above would cross the plot's
 * top (plus the legend's room); clamped, with no stem, when it fits neither.
 * With no value, on the plot's bottom, with neither stem nor dot.
 */
export function placeMarker({
  anchorY,
  stackHeight,
  stem,
  plotHeight,
  hovered = false,
}: MarkerPlacementInput): MarkerGeometry {
  const floor = plotHeight - PLOT_BOTTOM_INSET;
  if (anchorY === null) {
    return {
      stackTop: floor - stackHeight,
      side: "bottom",
      anchorY: plotHeight,
      stem: null,
      dot: false,
    };
  }

  const gap = stem ? STEM_GAP : GLYPH_GAP;
  // Clear of the crosshair dot on the hovered bucket.
  const clear = hovered ? Math.max(gap, HOVER_DOT_CLEARANCE) : gap;

  const above = anchorY - clear - stackHeight;
  if (above >= PLOT_TOP_SAFE) {
    return {
      stackTop: above,
      side: "above",
      anchorY,
      stem: stem ? { top: anchorY - clear, bottom: anchorY } : null,
      dot: true,
    };
  }

  const below = anchorY + clear;
  if (below + stackHeight <= floor) {
    return {
      stackTop: below,
      side: "below",
      anchorY,
      stem: stem ? { top: anchorY, bottom: below } : null,
      dot: true,
    };
  }

  // Too tall for either side: as near the point as the plot allows.
  const highest = PLOT_TOP_SAFE;
  const lowest = Math.max(highest, floor - stackHeight);
  return {
    stackTop: Math.min(Math.max(above, highest), lowest),
    side: "clamped",
    anchorY,
    stem: null,
    dot: true,
  };
}

/**
 * The overview chart's drawn primary series for a metric mode, by `dataKey`:
 * visitors on the default chart, the pressed metric's own series otherwise
 * (both session metrics draw `session`, revenue its bars' tops).
 */
export function markerAnchorKey(metric: ChartMetric | null): string {
  switch (metric) {
    case "pageviews":
      return "pageviews";
    case "bounce_rate":
    case "avg_visit":
      return "session";
    case "revenue":
      return "revenueTop";
    default:
      return "visitors";
  }
}
