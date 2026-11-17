/**
 * The overview's comparison with the previous period, and which metric the
 * chart draws: the rules behind the Compare toggle and the clickable tiles,
 * kept pure so they are tested without a screen.
 *
 * Type-only imports from `./api`: the web tests run before the contracts
 * package is built.
 */

import type { AnalyticsRange, SiteRole } from "./api";
import { durationLabel, percentLabel } from "./stat-format";

/* ------------------------------------------------------------------ */
/* The delta chip                                                      */
/* ------------------------------------------------------------------ */

/**
 * Which way is good. Traffic is `neutral`: more visitors after a launch and
 * fewer over a holiday are both just facts, so neither is painted as a win
 * or a loss. A bounce rate is the one tile where the direction carries a
 * verdict: fewer single-page visits is the better week.
 */
export type DeltaPolarity = "neutral" | "lower-is-better";

export type Delta = {
  /** "+12%", "−4%", "0%", or "—" when there is nothing to compare against. */
  label: string;
  /** `null` when the previous period is zero: there is no direction to show. */
  direction: "up" | "down" | "flat" | null;
  tone: "good" | "bad" | "neutral";
};

const percentFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * The change from `previous` to `current`, as the tile prints it.
 *
 * A percentage against a zero base is not a number, so that case is a dash
 * rather than "+∞%" or a made-up "+100%". The base is taken by size, so a net
 * revenue that climbs out of the negative reads as the rise it is. Rounded
 * to a whole percent, with a true minus sign, the way the revenue panel
 * prints its own delta.
 */
export function computeDelta(
  current: number,
  previous: number,
  polarity: DeltaPolarity = "neutral"
): Delta {
  if (!Number.isFinite(previous) || !Number.isFinite(current) || previous === 0) {
    return { label: "—", direction: null, tone: "neutral" };
  }
  const percent = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (percent === 0) return { label: "0%", direction: "flat", tone: "neutral" };
  const direction = percent > 0 ? "up" : "down";
  const label = `${percent > 0 ? "+" : "−"}${percentFmt.format(Math.abs(percent))}%`;
  const tone =
    polarity === "lower-is-better" ? (direction === "down" ? "good" : "bad") : "neutral";
  return { label, direction, tone };
}

/**
 * The change between two rates (each in [0, 1]) in percentage points: "+5
 * pts", "−3 pts". A rate's relative change misleads: 36% against 31% is a
 * "+16%" that reads like a big swing and is five points. Zero is a real rate
 * here, so a previous 0% still has a direction.
 */
export function computePointsDelta(
  current: number,
  previous: number,
  polarity: DeltaPolarity = "neutral"
): Delta {
  if (!Number.isFinite(previous) || !Number.isFinite(current)) {
    return { label: "—", direction: null, tone: "neutral" };
  }
  const points = Math.round((current - previous) * 100);
  if (points === 0) return { label: "0 pts", direction: "flat", tone: "neutral" };
  const direction = points > 0 ? "up" : "down";
  const label = `${points > 0 ? "+" : "−"}${Math.abs(points)} pts`;
  const tone =
    polarity === "lower-is-better" ? (direction === "down" ? "good" : "bad") : "neutral";
  return { label, direction, tone };
}

/** What a session tile needs of a sessions read's totals. */
export type SessionTileTotals = {
  sessions: number;
  bounce_rate: number;
  avg_session_duration_ms: number;
};

const NOTHING_TO_COMPARE: Delta = { label: "—", direction: null, tone: "neutral" };

/**
 * A session tile's line under its number while comparing: bounce rate's
 * change in points (lower is better), average visit's in percent. A previous
 * period without a single session measured neither, and its zeros are not
 * values: both the previous figure and the change print a dash.
 */
export function sessionTileComparison(
  tile: "bounce_rate" | "avg_visit",
  current: SessionTileTotals,
  previous: SessionTileTotals
): { delta: Delta; previous: string } {
  if (previous.sessions === 0) return { delta: NOTHING_TO_COMPARE, previous: "—" };
  if (tile === "bounce_rate") {
    return {
      delta: computePointsDelta(current.bounce_rate, previous.bounce_rate, "lower-is-better"),
      previous: percentLabel(previous.bounce_rate),
    };
  }
  return {
    delta: computeDelta(current.avg_session_duration_ms, previous.avg_session_duration_ms),
    previous: durationLabel(previous.avg_session_duration_ms),
  };
}

/* ------------------------------------------------------------------ */
/* The previous period                                                 */
/* ------------------------------------------------------------------ */

/**
 * The window the overview read compared against, published for the range it
 * was asked for (`meta.comparison_range`). `window: null`: the read answered
 * and there is nothing to compare (a range not started yet, or a failed read).
 */
export type PublishedComparison = {
  forRange: AnalyticsRange;
  window: { from: string; to: string } | null;
};

const sameRange = (a: AnalyticsRange, b: AnalyticsRange) =>
  a.from === b.from && a.to === b.to && a.timezone === b.timezone;

/**
 * The previous window the sessions read asks for, which takes no `compare`
 * and is asked for that window directly. It is exactly the server's: the
 * overview's `meta.comparison_range`, so the session tiles compare the same
 * stretch the counts do (for a period still in progress, the elapsed part).
 * `undefined` until the overview for this very range has answered; `null`
 * when it had nothing to compare.
 */
export function sessionsPreviousRange(
  range: AnalyticsRange,
  published: PublishedComparison | null
): AnalyticsRange | null | undefined {
  if (!published || !sameRange(published.forRange, range)) return undefined;
  if (!published.window) return null;
  return { ...published.window, timezone: range.timezone };
}

/* ------------------------------------------------------------------ */
/* The view in the URL                                                 */
/* ------------------------------------------------------------------ */

/** What a tile can put on the chart. */
export type ChartMetric = "visitors" | "pageviews" | "bounce_rate" | "avg_visit" | "revenue";

const CHART_METRICS: readonly ChartMetric[] = [
  "visitors",
  "pageviews",
  "bounce_rate",
  "avg_visit",
  "revenue",
];

/** The two metrics drawn from the sessions read rather than the timeseries. */
export type SessionChartMetric = Extract<ChartMetric, "bounce_rate" | "avg_visit">;

export function isSessionMetric(
  metric: ChartMetric | null
): metric is SessionChartMetric {
  return metric === "bounce_rate" || metric === "avg_visit";
}

export type OverviewView = {
  compare: boolean;
  /** `null` is the default chart: both traffic areas, revenue bars, markers. */
  metric: ChartMetric | null;
};

/** `?compare=1&metric=pageviews` (or `compare=true`). Anything unknown reads
 * as the default. */
export function parseOverviewView(search: string): OverviewView {
  const params = new URLSearchParams(search);
  const metric = params.get("metric");
  return {
    // `1` is what this page writes; `true` is how the API spells it.
    compare: params.get("compare") === "1" || params.get("compare") === "true",
    metric: CHART_METRICS.find((known) => known === metric) ?? null,
  };
}

/**
 * The query string with `view` written into it, every other parameter (the
 * filters) left as it was. Defaults are removed rather than written out, so
 * an untouched overview keeps its clean URL. Returns `""` or `"?…"`.
 */
export function writeOverviewView(search: string, view: OverviewView): string {
  const params = new URLSearchParams(search);
  if (view.compare) params.set("compare", "1");
  else params.delete("compare");
  if (view.metric) params.set("metric", view.metric);
  else params.delete("metric");
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/* ------------------------------------------------------------------ */
/* Which tiles drive the chart                                         */
/* ------------------------------------------------------------------ */

export type StatTile = "visitors" | "pageviews" | "bounce_rate" | "avg_visit" | "revenue";

/**
 * Revenue can be the chart only where its bars can be drawn: an owner (the
 * revenue read is owner-only) whose range has at least one bar.
 */
export function isRevenueChartable(input: {
  role: SiteRole | null;
  hasBars: boolean;
}): boolean {
  return input.role === "owner" && input.hasBars;
}

/**
 * What can be charted besides traffic. `sessionsChartable` is false under a
 * filter: the sessions read takes none, so its line would be the whole
 * site's beside filtered tiles (the tiles themselves print a dash there).
 */
export type ChartableContext = {
  revenueChartable: boolean;
  sessionsChartable: boolean;
};

/**
 * The metric a tile puts on the chart, or `null` for a tile that cannot be
 * pressed. Bounce rate and average visit come from the sessions read's own
 * per-bucket series.
 */
export function chartMetricForTile(
  tile: StatTile,
  context: ChartableContext
): ChartMetric | null {
  if (tile === "visitors" || tile === "pageviews") return tile;
  if (tile === "revenue") return context.revenueChartable ? "revenue" : null;
  return context.sessionsChartable ? tile : null;
}

/** Pressing the selected tile again returns the chart to its default. */
export function toggleChartMetric(
  current: ChartMetric | null,
  pressed: ChartMetric
): ChartMetric | null {
  return current === pressed ? null : pressed;
}

/**
 * What the chart actually draws. A link can carry `metric=revenue` to someone
 * who cannot see revenue, or to a range with no sales, or a session metric
 * into a filtered view; they get the default chart rather than an empty one.
 */
export function effectiveChartMetric(
  metric: ChartMetric | null,
  context: ChartableContext
): ChartMetric | null {
  if (metric === "revenue" && !context.revenueChartable) return null;
  if (isSessionMetric(metric) && !context.sessionsChartable) return null;
  return metric;
}

/**
 * What the chart is drawing, as the chart itself publishes it: the metric on
 * the plot (`null` for the default chart) and what it could draw. The tiles
 * take both from here rather than from the URL, so a tile is pressed only
 * when its line is the one on the chart, and a button only when pressing it
 * would put one there.
 */
export type ChartDrawState = ChartableContext & { drawn: ChartMetric | null };

/** Before the chart has said anything: the default chart, nothing extra. */
export const CHART_DRAWS_DEFAULT: ChartDrawState = {
  drawn: null,
  revenueChartable: false,
  sessionsChartable: false,
};

/** A tile as a chart control, or `null` for a plain tile. */
export function tileChartControl(
  tile: StatTile,
  chart: ChartDrawState
): { metric: ChartMetric; pressed: boolean } | null {
  const metric = chartMetricForTile(tile, chart);
  return metric ? { metric, pressed: chart.drawn === metric } : null;
}
