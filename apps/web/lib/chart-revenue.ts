/**
 * Revenue on the overview chart: which grain to ask for, how the answer lands
 * in the chart's buckets, and what the day tooltip says about it.
 *
 * Like `chart-markers.ts`, the loader takes its reads as arguments so the
 * rules about *when* to read are tested without a network. The gate is the
 * sale markers' gate (`hasRevenueAccess`): owner only, and a provider
 * connected. Every failure becomes "no bars"; the bars decorate the chart and
 * never get to break it.
 */

import type {
  AnalyticsRange,
  RevenueResolution,
  RevenueTimeseriesPoint,
  RevenueTimeseriesResponse,
  SiteRole,
} from "./api";
import { hasRevenueAccess, type ChartMarkerDeps } from "./chart-markers";
import { formatMoney } from "./currencies";
import { bucketIndexOf } from "./event-markers";

/** The grains the traffic chart can be drawn at. */
export type ChartGrain = "minute" | "hour" | "day" | "week";

/**
 * The revenue grain for a chart grain. The revenue timeseries serves hour and
 * day only: a week chart asks for days and sums them into its weeks, and a
 * minute chart (the sub-hour-zone fallback) gets no bars at all.
 */
export function revenueResolutionFor(grain: ChartGrain): RevenueResolution | null {
  if (grain === "hour") return "hour";
  if (grain === "day" || grain === "week") return "day";
  return null;
}

export type ChartRevenueDeps = {
  revenueState: ChartMarkerDeps["revenueState"];
  revenueTimeseries: (
    siteId: string,
    range: AnalyticsRange,
    options: { resolution: RevenueResolution; signal?: AbortSignal }
  ) => Promise<Pick<RevenueTimeseriesResponse, "series">>;
};

/**
 * The revenue points for the chart's range, or `null` when there are none to
 * draw: a member who may not read revenue (no request is sent at all), no
 * connected provider, a minute chart, or any failed read.
 */
export async function loadChartRevenue(
  request: {
    siteId: string;
    role: SiteRole;
    range: AnalyticsRange;
    grain: ChartGrain;
    signal?: AbortSignal;
  },
  deps: ChartRevenueDeps
): Promise<RevenueTimeseriesPoint[] | null> {
  const { siteId, role, range, grain, signal } = request;
  const resolution = revenueResolutionFor(grain);
  if (resolution === null) return null;
  try {
    if (!(await hasRevenueAccess(siteId, role, deps.revenueState, signal))) return null;
    const response = await deps.revenueTimeseries(siteId, range, { resolution, signal });
    return response.series;
  } catch {
    return null;
  }
}

/**
 * The currency the bars are drawn in. Points carry the reporting currency, so
 * a range normally has one; if the setting changed inside the range, the
 * currency with the largest total wins (first seen on a tie) and the others
 * are named in the tooltip instead of being added to it. The total is net
 * plus refunds: what the bars draw, a net bar with its refund on top.
 */
export function pickRevenueCurrency(
  points: readonly RevenueTimeseriesPoint[]
): string | null {
  const totals = new Map<string, number>();
  for (const point of points) {
    totals.set(
      point.currency,
      (totals.get(point.currency) ?? 0) + point.net_minor + point.refund_minor
    );
  }
  let best: string | null = null;
  let bestTotal = Number.NEGATIVE_INFINITY;
  for (const [currency, total] of totals) {
    if (total > bestTotal) {
      best = currency;
      bestTotal = total;
    }
  }
  return best;
}

/** One chart bucket's revenue, in minor units of `currency`. */
export type RevenueBucket = {
  startMs: number;
  currency: string;
  netMinor: number;
  grossMinor: number;
  refundMinor: number;
  /** `charge_count`. */
  sales: number;
  /** Transactions in the bucket that had no rate into the reporting currency. */
  unconverted: number;
  /** The bucket also had money in a currency the bars leave out. */
  otherCurrencies: boolean;
};

export type RevenueModel = {
  currency: string | null;
  /** Keyed by the chart bucket's start; only buckets with a point appear. */
  buckets: Map<number, RevenueBucket>;
};

/**
 * Sums revenue points into the chart's buckets, which start at `starts`
 * (ascending) and end at `endMs` (exclusive).
 *
 * Uses the chart's own bucket starts rather than re-deriving a grain, like the
 * marker layer: the chart has already cut hours, local days or ISO weeks in
 * the request's timezone, so "the last bucket that starts at or before this
 * point" puts a Berlin Sunday in the right week whatever UTC calls it. At hour
 * and day grain this is one point per bucket; at week grain, seven.
 */
export function bucketRevenue(
  starts: readonly number[],
  endMs: number,
  points: readonly RevenueTimeseriesPoint[] | null
): RevenueModel {
  const buckets = new Map<number, RevenueBucket>();
  if (!points || starts.length === 0) return { currency: null, buckets };
  const currency = pickRevenueCurrency(points);
  if (currency === null) return { currency, buckets };

  for (const point of points) {
    const at = Date.parse(point.bucket);
    if (!Number.isFinite(at) || at >= endMs) continue;
    const index = bucketIndexOf(starts, at);
    const startMs = starts[index];
    if (index < 0 || startMs === undefined) continue;
    let bucket = buckets.get(startMs);
    if (!bucket) {
      bucket = {
        startMs,
        currency,
        netMinor: 0,
        grossMinor: 0,
        refundMinor: 0,
        sales: 0,
        unconverted: 0,
        otherCurrencies: false,
      };
      buckets.set(startMs, bucket);
    }
    bucket.unconverted += point.unconverted_count;
    if (point.currency !== currency) {
      if (point.charge_gross_minor !== 0 || point.net_minor !== 0 || point.refund_minor !== 0) {
        bucket.otherCurrencies = true;
      }
      continue;
    }
    bucket.netMinor += point.net_minor;
    bucket.grossMinor += point.charge_gross_minor;
    bucket.refundMinor += point.refund_minor;
    bucket.sales += point.charge_count;
  }
  return { currency, buckets };
}

/**
 * Which revenue layers the chart shows. `enabled` is "this chart may show
 * revenue at all" (the dashboard, with a response); `hidden` is the legend's
 * remembered choice.
 *
 * The bars need something to draw, but the tooltip section only needs a
 * bucket: a range whose only sales could not be converted has no bars and
 * still says so. The legend's toggle exists only next to bars, so a hidden
 * choice cannot silence the tooltip when there is no toggle to undo it with.
 */
export function revenueLayers(
  model: RevenueModel,
  options: { enabled: boolean; hidden: boolean }
): { bars: boolean; barsVisible: boolean; tooltip: boolean } {
  const bars = options.enabled && hasRevenueBars(model);
  const barsVisible = bars && !options.hidden;
  const tooltip =
    options.enabled && model.buckets.size > 0 && (bars ? barsVisible : true);
  return { bars, barsVisible, tooltip };
}

/** Whether any bucket has something to draw: income or a refund. */
export function hasRevenueBars(model: RevenueModel): boolean {
  for (const bucket of model.buckets.values()) {
    if (bucket.netMinor > 0 || bucket.refundMinor > 0) return true;
  }
  return false;
}

/** The largest bar the chart has to fit: a net bar with its refund on top. */
export function revenueBarMax(model: RevenueModel): number {
  let max = 0;
  for (const bucket of model.buckets.values()) {
    max = Math.max(max, Math.max(0, bucket.netMinor) + bucket.refundMinor);
  }
  return max;
}

/** Money with a true minus sign, the way the revenue card prints a deduction. */
function signedMoney(minor: number, currency: string): string {
  return minor < 0 ? `−${formatMoney(-minor, currency)}` : formatMoney(minor, currency);
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

export type RevenueTooltipModel = {
  /** Always shown, zero included: "no money that day" is an answer. */
  net: string;
  /**
   * Gross, Refunds, Revenue per visitor — each only when it isn't zero. The
   * sale count is not here: the markers line under it already says "3 sales".
   */
  lines: Array<{ label: string; value: string }>;
  notes: string[];
};

/** Net per visitor, never rounded to nothing: less than a minor unit says so. */
function perVisitorMoney(netMinor: number, visitors: number, currency: string): string {
  if (visitors <= 0) return "—";
  const minor = Math.round(netMinor / visitors);
  if (minor !== 0) return signedMoney(minor, currency);
  const tiny = `<${formatMoney(1, currency)}`;
  return netMinor < 0 ? `−${tiny}` : tiny;
}

/**
 * What the day tooltip says about one bucket's revenue. `filtered`: the
 * traffic is narrowed by a dashboard filter while revenue is site-wide, so
 * a per-visitor figure would divide one by the other; it is left out and the
 * footer says why.
 */
export function revenueTooltipModel(
  bucket: RevenueBucket,
  visitors: number,
  options: { filtered?: boolean } = {}
): RevenueTooltipModel {
  const { currency } = bucket;
  const filtered = options.filtered ?? false;
  const lines: RevenueTooltipModel["lines"] = [];
  if (bucket.grossMinor !== 0) {
    lines.push({ label: "Gross", value: formatMoney(bucket.grossMinor, currency) });
  }
  if (bucket.refundMinor !== 0) {
    lines.push({ label: "Refunds", value: signedMoney(-bucket.refundMinor, currency) });
  }
  if (bucket.netMinor !== 0 && !filtered) {
    lines.push({
      label: "Revenue per visitor",
      value: perVisitorMoney(bucket.netMinor, visitors, currency),
    });
  }

  const notes: string[] = [];
  if (bucket.unconverted > 0) {
    notes.push(`${plural(bucket.unconverted, "sale", "sales")} could not be converted`);
  }
  if (bucket.otherCurrencies) notes.push("Other currencies not shown");
  if (filtered) notes.push("Revenue isn't filtered.");

  return { net: signedMoney(bucket.netMinor, currency), lines, notes };
}
