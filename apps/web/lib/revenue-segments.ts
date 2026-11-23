/**
 * Revenue by segment, for the screen: labels, the table's sorts and the copy.
 * Pure, and free of the API client, so the card and the table render (and are
 * tested) from plain data. The smoothing itself is the server's: every
 * figure here is read off the response, never recomputed.
 */

import type {
  AnalyticsRange,
  RevenueSegment,
  RevenueSegmentConfidence,
  RevenueSegmentsResponse,
} from "./api";
import { snappedSpanDays } from "./row-revenue";
import { referrerLabel } from "./source-rows";

/**
 * The ⓘ beside the title: why a small segment does not top the list, and
 * what the money is. The read counts conversions only, so the revenue here
 * is not the site's revenue.
 */
export const SMOOTHING_NOTE =
  "Small segments are pulled toward your site's average so a handful of visits can't look like a sure thing. Value per visitor counts new revenue, from new subscriptions and one-off purchases.";

/** The confidence band edges the server sends in `thresholds.confidence`. */
export type ConfidenceEdges = RevenueSegmentsResponse["thresholds"]["confidence"];

const count = (n: number) => n.toLocaleString("en-US");

/**
 * The ⓘ's full text: the smoothing note, then what the row's dot means, with
 * the server's band edges. Without them (nothing has loaded, so no row and no
 * dot is on screen) the dot sentence is left off.
 */
export function smoothingNote(edges: ConfidenceEdges | undefined): string {
  if (edges === undefined) return SMOOTHING_NOTE;
  return (
    `${SMOOTHING_NOTE} The dot shows how much data is behind a row: ` +
    `low under ${count(edges.low_visitors)} visitors or ${count(edges.low_buyers)} buyers, ` +
    `high from ${count(edges.high_visitors)} visitors and ${count(edges.high_buyers)} buyers.`
  );
}

/** The dot's own label, the ⓘ's sentence in short for one band. */
export function confidenceLabel(
  confidence: RevenueSegmentConfidence,
  edges: ConfidenceEdges
): string {
  switch (confidence) {
    case "low":
      return `Low confidence: under ${count(edges.low_visitors)} visitors or ${count(edges.low_buyers)} buyers`;
    case "medium":
      return `Medium confidence: at least ${count(edges.low_visitors)} visitors and ${count(edges.low_buyers)} buyers`;
    case "high":
      return `High confidence: at least ${count(edges.high_visitors)} visitors and ${count(edges.high_buyers)} buyers`;
  }
}

/** Under the title of the full table. */
export const SEGMENTS_SUBTITLE =
  "Source, country and device, by what a visit is worth from new subscriptions and one-off purchases";

/**
 * How many segments the screen reads: the most the API returns, so the
 * table's own sorting covers every segment unless a site has more than this.
 */
export const SEGMENTS_FETCH_LIMIT = 500;

/** Under a cut list: the rows are the read's first, by value per visitor. */
export function truncatedCopy(rows: number): string {
  return `Top ${rows.toLocaleString("en-US")} by value per visitor`;
}

export type SegmentSort = "value" | "conversion" | "revenue" | "visitors";

/** The table's columns, in the order they read, with what each sorts by. */
export const SEGMENT_SORTS: { id: SegmentSort; label: string }[] = [
  { id: "value", label: "Per visitor" },
  { id: "conversion", label: "Conversion" },
  { id: "revenue", label: "New revenue" },
  { id: "visitors", label: "Visitors" },
];

const SORT_KEY: Record<SegmentSort, (row: RevenueSegment) => number> = {
  value: (row) => row.smoothed_value_per_visitor_minor,
  conversion: (row) => row.smoothed_conversion_rate,
  revenue: (row) => row.revenue_minor,
  visitors: (row) => row.visitors,
};

/**
 * Highest first, a copy. The rates sort by their smoothed values, the ones
 * the table prints; ties keep the server's order, which is already by
 * smoothed value per visitor.
 */
export function sortSegments(
  rows: readonly RevenueSegment[],
  sort: SegmentSort
): RevenueSegment[] {
  const key = SORT_KEY[sort];
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => key(b.row) - key(a.row) || a.index - b.index)
    .map(({ row }) => row);
}

export function segmentKey(row: RevenueSegment): string {
  return `${row.source}\u0000${row.country}\u0000${row.device}`;
}

/**
 * The rows whose name, country and device read exactly like another row's:
 * google.com and google.de are both "Google". Those rows show their raw host
 * under the name, so two lines never look like one segment twice.
 */
export function segmentsNeedingHost(rows: readonly RevenueSegment[]): Set<string> {
  const byLabel = new Map<string, string[]>();
  for (const row of rows) {
    const label = `${segmentSourceLabel(row.source)}\u0000${row.country}\u0000${row.device}`;
    byLabel.set(label, [...(byLabel.get(label) ?? []), segmentKey(row)]);
  }
  const keys = new Set<string>();
  for (const group of byLabel.values()) {
    if (group.length > 1) for (const key of group) keys.add(key);
  }
  return keys;
}

/**
 * The buyers the rates leave out, in the table's small print: a buyer whose
 * last visit came before the range is not one of its visitors, and one
 * whose last visit was retracted or never recorded has no segment.
 */
export function leftOutBuyersCopy(
  site: Pick<
    RevenueSegmentsResponse["site"],
    "buyers_last_visit_before_range" | "buyers_last_visit_missing"
  >
): string | null {
  const before = site.buyers_last_visit_before_range;
  const missing = site.buyers_last_visit_missing;
  if (before <= 0 && missing <= 0) return null;
  const count = (n: number) => n.toLocaleString("en-US");
  const buyers = (n: number) => `${count(n)} ${n === 1 ? "buyer" : "buyers"}`;
  const verb = before + missing === 1 ? "isn't" : "aren't";
  if (missing <= 0) {
    return `${buyers(before)} whose last visit was before this range ${verb} counted.`;
  }
  if (before <= 0) {
    return `${buyers(missing)} whose last visit wasn't recorded ${verb} counted.`;
  }
  return `${buyers(before)} whose last visit was before this range and ${count(missing)} whose last visit wasn't recorded ${verb} counted.`;
}

/** The Sources card's name for a referrer domain; the empty one is Direct. */
export function segmentSourceLabel(source: string): string {
  return referrerLabel(source);
}

const REGION_NAMES =
  typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

export function countryLabel(code: string): string {
  if (!/^[a-z]{2}$/i.test(code)) return "Unknown country";
  try {
    return REGION_NAMES?.of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export function deviceLabel(device: string): string {
  if (device === "") return "Unknown device";
  return device.charAt(0).toUpperCase() + device.slice(1);
}

/** "2.5%", "25%", or a dash where there is no rate. */
export function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  const percent = rate * 100;
  return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}

/** What the empty state says: the counts, and what would change the answer. */
export function insufficientDataCopy(
  data: Pick<RevenueSegmentsResponse, "site" | "thresholds">
): { title: string; body: string } {
  const buyers = data.site.buyers;
  return {
    title: "Not enough sales to rank traffic yet",
    body:
      `This range has ${buyers.toLocaleString("en-US")} attributed ${buyers === 1 ? "buyer" : "buyers"} ` +
      `from ${data.site.visitors.toLocaleString("en-US")} visitors. ` +
      `Ranking needs at least ${data.thresholds.min_buyers}. ` +
      "Pick a longer range, up to 92 days, or check back after more sales.",
  };
}

/** The longest range the segments read serves, in days (the api's cap). */
export const SEGMENTS_MAX_SPAN_DAYS = 92;

/**
 * Whether the range is past the read's cap, measured the way the api
 * measures it: rounded outward to quarter hours (`snappedSpanDays`), so an
 * unaligned 92 days that the api reads as 92 days and a quarter hour is not
 * sent. An unparseable range is held too.
 */
export function segmentsSpanTooLong(range: Pick<AnalyticsRange, "from" | "to">): boolean {
  const days = snappedSpanDays(range);
  return days === null || days > SEGMENTS_MAX_SPAN_DAYS;
}
