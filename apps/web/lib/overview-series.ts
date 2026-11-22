/**
 * The overview chart's drawn series, by `dataKey`: the keys its points carry
 * and its `<Area>`s draw. One place, so the series a chart marker sits on
 * (`markerAnchorKey`) is always one the chart actually draws.
 */
export const OVERVIEW_SERIES = {
  visitors: "visitors",
  pageviews: "pageviews",
  /** The pressed session metric's line (bounce rate or visit duration). */
  session: "session",
  /** Revenue as the main series: the bars' tops, an undrawn sizing series. */
  revenueTop: "revenueTop",
} as const;

export type OverviewSeriesKey = (typeof OVERVIEW_SERIES)[keyof typeof OVERVIEW_SERIES];
