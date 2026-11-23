/**
 * Revenue beside the traffic on the Sources card and the Top pages card's
 * Entry pages cut: which attribution row belongs to which card row, and when
 * to read it at all.
 *
 * The read is `GET /v1/sites/{site_id}/revenue/attribution`, which is
 * `revenue:read` and so owner-only, behind the same gate as the overview
 * chart's revenue (`hasRevenueAccess`): an admin or a viewer never sends it,
 * and an owner without a connected provider stops after the connection read.
 * Every failure is "no revenue", and the card shows exactly what it showed
 * before.
 *
 * Revenue is the **last touch**: the source (or entry page) of the buyer's
 * last session before the purchase. One model and no picker, because the card
 * header has room for one small control and the sort toggle is it.
 */

import type {
  AnalyticsRange,
  RevenueAttributionDimension,
  RevenueAttributionResponse,
  RevenueAttributionTouch,
  SiteRole,
} from "./api";
import { hasRevenueAccess, type ChartMarkerDeps } from "./chart-markers";
import { formatMoney, formatMoneyCompact } from "./currencies";
import { referrerLabel } from "./source-rows";

/** The attribution model the rows use. See the file comment. */
export const ROW_REVENUE_TOUCH: RevenueAttributionTouch = "last";

/**
 * Rows to ask for. The attribution ranks by revenue, so this is the top 500
 * earners, the contract's maximum: a card row outside it earned less than
 * every row inside, and gets no amount rather than a wrong one. The visitor
 * counts the rows divide by come from the same response, so they cover the
 * same 500 values.
 */
export const ROW_REVENUE_LIMIT = 500;

/**
 * The longest range the attribution read serves (the api's
 * `REVENUE_ATTRIBUTION_MAX_SPAN_DAYS`): a longer one is a `RANGE_TOO_LARGE`,
 * so the card does not send it.
 */
export const ROW_REVENUE_MAX_SPAN_DAYS = 400;

/** Numbers and money on the rows, in the locale the visitor counts use. */
const LOCALE = "en-US";

/**
 * The card row an attribution value lands on, or `null` for none.
 *
 * Each cut is joined the way the card groups its own rows, which is also how
 * the api groups them: referrers by display name (hosts folded, any case, the
 * empty domain as "Direct / none"), utm values exactly after trimming (the
 * card keeps `Newsletter` and `newsletter` apart, and so does the api), entry
 * pages by path. Unattributed revenue (`null`) and untagged utm traffic have
 * no row on the card.
 */
export function revenueRowKey(
  dimension: RevenueAttributionDimension,
  value: string | null
): string | null {
  if (value === null) return null;
  if (dimension === "referrer_domain") return referrerLabel(value);
  if (dimension === "entry_page") return value === "" ? null : value;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** One card row's revenue, in minor units of the response's currency. */
export type RowRevenueEntry = {
  revenueMinor: number;
  /** Distinct buyers with a conversion in the row, from the attribution. */
  buyers: number;
  /**
   * Unique visitors whose session entered with the row's value, counted by
   * the attribution read itself, or `null` when it did not count them (over
   * 92 days, or a failed visitor scan). Never the card's own number: the
   * Sources card's visitors come from the sources rollup, whose Direct / none
   * also holds internal navigation, and Entry pages counts entries.
   */
  visitors: number | null;
  /** Charges with no exchange rate, left out of `revenueMinor`. */
  unconvertedOrders: number;
};

export type RowRevenue = {
  /** The site's reporting currency. */
  currency: string;
  byKey: ReadonlyMap<string, RowRevenueEntry>;
};

type AttributionAnswer = Pick<
  RevenueAttributionResponse,
  "currency" | "dimension" | "rows" | "visitors_available"
>;

/** Attribution rows summed onto the card's row keys. */
export function joinAttribution(response: AttributionAnswer): RowRevenue {
  const byKey = new Map<string, RowRevenueEntry>();
  for (const row of response.rows) {
    const key = revenueRowKey(response.dimension, row.value);
    if (key === null) continue;
    const entry = byKey.get(key);
    const visitors = response.visitors_available ? row.visitors : null;
    if (entry === undefined) {
      byKey.set(key, {
        revenueMinor: row.revenue_minor,
        buyers: row.buyers,
        visitors,
        unconvertedOrders: row.unconverted_orders,
      });
      continue;
    }
    entry.revenueMinor += row.revenue_minor;
    // Folded hosts are different touch values, so a buyer is in one of them
    // per charge; a buyer who bought twice through two hosts of one source
    // counts twice, the same small over-count the card's visitors carry. The
    // visitors fold the same way, and one value without a count leaves the
    // row without one.
    entry.buyers += row.buyers;
    entry.visitors =
      entry.visitors === null || visitors === null ? null : entry.visitors + visitors;
    entry.unconvertedOrders += row.unconverted_orders;
  }
  return { currency: response.currency, byKey };
}

/** A row's revenue, or `null` when it has none to show. */
export function revenueOf(
  revenue: RowRevenue | null,
  key: string
): RowRevenueEntry | null {
  const entry = revenue?.byKey.get(key);
  return entry !== undefined && entry.revenueMinor > 0 ? entry : null;
}

/**
 * Revenue per visitor in minor units, over the attribution's own visitors,
 * or `null` when it did not count any.
 */
export function revenuePerVisitor(entry: RowRevenueEntry): number | null {
  return entry.visitors !== null && entry.visitors > 0
    ? entry.revenueMinor / entry.visitors
    : null;
}

/** The compact amount a row shows, or `null` for a row without revenue. */
export function rowRevenueAmount(
  entry: RowRevenueEntry | null,
  currency: string
): string | null {
  return entry === null
    ? null
    : formatMoneyCompact(entry.revenueMinor, currency, LOCALE);
}

/**
 * The row tooltip's lines. Visitors and revenue per visitor only when the
 * attribution counted the row's visitors; the row's own number is on the row
 * already, and dividing by it would mix two counts. `note` is the orders the
 * amount leaves out.
 */
export function rowRevenueTip(
  entry: RowRevenueEntry,
  currency: string
): { lines: [string, string][]; note: string | null } {
  const perVisitor = revenuePerVisitor(entry);
  const lines: [string, string][] = [];
  if (entry.visitors !== null) {
    lines.push(["Visitors", entry.visitors.toLocaleString(LOCALE)]);
  }
  lines.push(["Revenue", formatMoney(entry.revenueMinor, currency, LOCALE)]);
  if (perVisitor !== null) {
    lines.push([
      "Revenue per visitor",
      formatMoney(Math.round(perVisitor), currency, LOCALE),
    ]);
  }
  lines.push(["Buyers", entry.buyers.toLocaleString(LOCALE)]);
  const n = entry.unconvertedOrders;
  const note =
    n <= 0
      ? null
      : n === 1
        ? "1 order in another currency not included"
        : `${n.toLocaleString(LOCALE)} orders in other currencies not included`;
  return { lines, note };
}

/** Whether any of the card's rows leaves orders in other currencies out. */
export function hasUnconvertedOrders(
  revenue: RowRevenue,
  keys: Iterable<string>
): boolean {
  for (const key of keys) {
    if ((revenue.byKey.get(key)?.unconvertedOrders ?? 0) > 0) return true;
  }
  return false;
}

/** The card's ⓘ while revenue is shown: which touch gets the money. */
export function rowRevenueCaveat({
  entryPages,
  unconverted,
}: {
  entryPages: boolean;
  /** A row leaves orders out (`hasUnconvertedOrders`). */
  unconverted: boolean;
}): string {
  const credit = entryPages
    ? "Revenue, including renewals, is credited to the entry page of the visit's last session before the purchase."
    : "Revenue, including renewals, is credited to the visit's last source before the purchase.";
  return unconverted
    ? `${credit} Orders in a currency with no exchange rate are not included.`
    : credit;
}

/** What the rows are ranked by, picked in the card header. */
export type RowSort = "visitors" | "revenue";

/**
 * Rows by revenue, highest first; rows without revenue follow in their
 * traffic order. Sorting by visitors is the order the card already has, so
 * that returns the same array.
 */
export function sortRows<T>(
  rows: T[],
  sort: RowSort,
  by: { traffic: (row: T) => number; revenue: (row: T) => number }
): T[] {
  if (sort === "visitors") return rows;
  return [...rows].sort(
    (a, b) => by.revenue(b) - by.revenue(a) || by.traffic(b) - by.traffic(a)
  );
}

/** The cuts a See all modal can show. */
export type SeeAllCut = "sources" | "pages" | "entries" | "exits";

const BASE_COLUMNS: Record<SeeAllCut, string[]> = {
  sources: ["Visitors"],
  pages: ["Views", "Visitors"],
  entries: ["Entries", "Bounce"],
  exits: ["Exits", "Views"],
};

/**
 * The See all modal's number columns. Revenue is a column of the cuts it is
 * read for (sources and entry pages) whenever the card shows it.
 */
export function seeAllColumns(cut: SeeAllCut, revenue: boolean): string[] {
  const base = BASE_COLUMNS[cut];
  return revenue && (cut === "sources" || cut === "entries")
    ? [...base, "Revenue"]
    : base;
}

export type RowRevenueDeps = {
  revenueState: ChartMarkerDeps["revenueState"];
  attribution: (
    siteId: string,
    range: AnalyticsRange,
    options: {
      dimension: RevenueAttributionDimension;
      touch: RevenueAttributionTouch;
      limit: number;
      signal?: AbortSignal;
    }
  ) => Promise<AttributionAnswer>;
};

/**
 * Whether the card holds its revenue read, so nothing is sent: a cut revenue
 * is not about (`null`), a range still pending, an active filter (the
 * attribution takes no filters, so its revenue would sit beside filtered
 * visitors as if it were filtered), or a range longer than the read serves.
 * The span is snapped outward to quarter hours as the api snaps it.
 */
export function rowRevenueHold(request: {
  dimension: RevenueAttributionDimension | null;
  rangePending: boolean;
  filtered: boolean;
  range: AnalyticsRange;
}): boolean {
  if (request.dimension === null || request.rangePending || request.filtered) {
    return true;
  }
  const days = snappedSpanDays(request.range);
  return days === null || days > ROW_REVENUE_MAX_SPAN_DAYS;
}

const QUARTER_HOUR_MS = 15 * 60_000;

/**
 * A range's length in days once rounded outward to quarter hours, the way
 * the api snaps a revenue read's range before it checks the cap; `null` for
 * an unparseable range. The revenue segments' cap reads it too.
 */
export function snappedSpanDays(range: Pick<AnalyticsRange, "from" | "to">): number | null {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  const span =
    (Math.ceil(to / QUARTER_HOUR_MS) - Math.floor(from / QUARTER_HOUR_MS)) *
    QUARTER_HOUR_MS;
  return span / 86_400_000;
}

/** How long one attribution read answers for, per site, cut and range. */
const ATTRIBUTION_TTL_MS = 60_000;

/**
 * One attribution read per site, cut and range for the page, the way
 * `sharedRevenueState` shares the connection read: switching the card's cut
 * away and back answers from the first read. A failed read is forgotten so
 * the next look tries again. The shared read takes no caller's signal, since
 * a card that switched away must not cancel it for the next one.
 */
export function sharedAttribution(
  read: RowRevenueDeps["attribution"],
  options: { ttlMs?: number; now?: () => number } = {}
): RowRevenueDeps["attribution"] {
  const ttlMs = options.ttlMs ?? ATTRIBUTION_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; pending: Promise<AttributionAnswer> }>();
  return (siteId, range, { signal: _signal, ...request }) => {
    const key = JSON.stringify([
      siteId,
      range.from,
      range.to,
      range.timezone,
      request.dimension,
      request.touch,
      request.limit,
    ]);
    const cached = cache.get(key);
    if (cached && now() - cached.at < ttlMs) return cached.pending;
    for (const [old, entry] of cache) {
      if (now() - entry.at >= ttlMs) cache.delete(old);
    }
    const pending = read(siteId, range, request).catch((raised: unknown) => {
      if (cache.get(key)?.pending === pending) cache.delete(key);
      throw raised;
    });
    cache.set(key, { at: now(), pending });
    return pending;
  };
}

/**
 * The card's revenue for one dimension, or `null` for none: a member who may
 * not read revenue (nothing is sent), no connected provider, or a failed read.
 */
export async function loadRowRevenue(
  request: {
    siteId: string;
    role: SiteRole;
    range: AnalyticsRange;
    dimension: RevenueAttributionDimension;
    signal?: AbortSignal;
  },
  deps: RowRevenueDeps
): Promise<RowRevenue | null> {
  const { siteId, role, range, dimension, signal } = request;
  try {
    if (!(await hasRevenueAccess(siteId, role, deps.revenueState, signal))) return null;
    const response = await deps.attribution(siteId, range, {
      dimension,
      touch: ROW_REVENUE_TOUCH,
      limit: ROW_REVENUE_LIMIT,
      signal,
    });
    return joinAttribution(response);
  } catch {
    return null;
  }
}
