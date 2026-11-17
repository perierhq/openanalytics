import type { PlotPoint } from "@/lib/chart-fill";

/**
 * How the overview chart draws a previous period: a dashed line per series,
 * no fill, no hover highlight, never part of the loading sweep.
 *
 * `gapsForMissing` because the previous window can be shorter than the
 * current one (a month of 28 days under one of 31) and a bucket with no
 * counterpart carries no `prev*` key. Without it the line reads that point as
 * having no position and the dash jumps to the top of the plot.
 */
export const PREVIOUS_LINE_PROPS = {
  dashFromIndex: 0,
  dimOpacity: 1,
  fadeEdges: true,
  fillOpacity: 0,
  gapsForMissing: true,
  loading: false,
  showHighlight: false,
} as const;

/**
 * A current bucket's previous-period fields: the counterpart's numbers and
 * its own date (the tooltip names it), or none at all when there is no
 * counterpart, so the dashed line breaks there instead of claiming zero.
 */
export function previousFields(
  previous: PlotPoint | null
): { prevVisitors?: number; prevPageviews?: number; prevAtMs?: number } {
  if (!previous) return {};
  return {
    prevVisitors: previous.visitors,
    prevPageviews: previous.pageviews,
    prevAtMs: previous.date.getTime(),
  };
}
