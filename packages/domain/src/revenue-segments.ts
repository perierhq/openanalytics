/**
 * Revenue by segment: which visitors convert, and what they are worth.
 *
 * A segment is one (entry referrer domain, country, device type) of a
 * session. The api counts each segment's visitors from the session facts and
 * its buyers, orders and revenue from the last-touch attribution rows; this
 * module is the arithmetic over those counts and nothing else, so the
 * numbers on the card, in the read route and in the MCP tool are one
 * definition.
 *
 * Segment-level only: there is no per-visitor score anywhere in this
 * module, and nothing labels a person as a likely buyer.
 *
 * ## Smoothing
 *
 * A raw rate over a small segment is noise: three visits and one sale is a
 * 33% "converter". So every rate is pulled toward the site's own rate over
 * the same range by an additive prior worth `k` visitors (an empirical-Bayes
 * shrinkage with a fixed strength):
 *
 *     smoothed = (count + k * prior) / (visitors + k)
 *
 * with `k = REVENUE_SEGMENT_PRIOR_K = 200`. A segment with no visitors reads
 * exactly the site's rate; one with ten thousand barely moves. The same
 * formula smooths value per visitor toward the site's value per visitor, in
 * minor units. `k` is a constant rather than a fitted value on purpose: the
 * response states it, and a number that moved with the data would make two
 * ranges impossible to compare.
 */

/** How many visitors' worth of weight the site-wide prior carries. */
export const REVENUE_SEGMENT_PRIOR_K = 200

/**
 * A segment with fewer visitors than this is not shown: it is noise, and a
 * very small group of visitors is closer to describing people than traffic.
 * The response counts how many were left out.
 */
export const REVENUE_SEGMENT_MIN_VISITORS = 20

/** Below this many attributed buyers in the range there is no answer at all. */
export const REVENUE_SEGMENTS_MIN_BUYERS = 10

/** The confidence band edges: `low` below either low edge, `high` at both high ones. */
export const REVENUE_SEGMENT_CONFIDENCE_EDGES = {
  lowVisitors: 100,
  lowBuyers: 3,
  highVisitors: 1_000,
  highBuyers: 10,
} as const

export type RevenueSegmentConfidence = 'low' | 'medium' | 'high'
export type RevenueSegmentsStatus = 'ok' | 'insufficient_data'

/** One segment's counts over the range, as the gateway returns them. */
export interface RevenueSegmentCounts {
  /** Entry referrer domain; the empty string is Direct. */
  source: string
  /** ISO country code of the session, or the empty string when unknown. */
  country: string
  /** Device type of the session, or the empty string when unknown. */
  device: string
  visitors: number
  buyers: number
  orders: number
  /** Reporting-currency revenue of converted orders, in minor units. */
  revenueMinor: number
  /** Orders with no usable exchange rate: not in `revenueMinor`. */
  unconvertedOrders: number
}

export interface RevenueSegmentScore extends RevenueSegmentCounts {
  /** `buyers / visitors`, or null with no visitors. */
  conversionRate: number | null
  smoothedConversionRate: number
  /** `revenueMinor / orders`, or null with no orders. */
  averageOrderValueMinor: number | null
  /** `revenueMinor / visitors`, or null with no visitors. */
  valuePerVisitorMinor: number | null
  smoothedValuePerVisitorMinor: number
  confidence: RevenueSegmentConfidence
}

export interface RevenueSegmentsPrior {
  conversionRate: number
  valuePerVisitorMinor: number
}

/** `(count + k * prior) / (visitors + k)`; the prior itself when both are zero. */
export function smoothTowardPrior(
  count: number,
  visitors: number,
  prior: number,
  k: number = REVENUE_SEGMENT_PRIOR_K,
): number {
  const weight = visitors + k
  if (weight <= 0) return prior
  return (count + k * prior) / weight
}

export function revenueSegmentConfidence(
  visitors: number,
  buyers: number,
): RevenueSegmentConfidence {
  const edges = REVENUE_SEGMENT_CONFIDENCE_EDGES
  if (visitors < edges.lowVisitors || buyers < edges.lowBuyers) return 'low'
  if (visitors >= edges.highVisitors && buyers >= edges.highBuyers) return 'high'
  return 'medium'
}

export function isRevenueSegmentShown(visitors: number): boolean {
  return visitors >= REVENUE_SEGMENT_MIN_VISITORS
}

/**
 * Whether the range has enough to rank segments by. Ten attributed buyers,
 * and some visitors: buyers whose last visit fell before the range give the
 * site no rate to smooth toward.
 */
export function revenueSegmentsStatus(site: {
  visitors: number
  buyers: number
}): RevenueSegmentsStatus {
  return site.buyers >= REVENUE_SEGMENTS_MIN_BUYERS && site.visitors > 0
    ? 'ok'
    : 'insufficient_data'
}

/** The site-wide rates the segments are smoothed toward. */
export function revenueSiteRates(site: {
  visitors: number
  buyers: number
  revenueMinor: number
}): { conversionRate: number | null; valuePerVisitorMinor: number | null } {
  if (site.visitors <= 0) return { conversionRate: null, valuePerVisitorMinor: null }
  return {
    conversionRate: site.buyers / site.visitors,
    valuePerVisitorMinor: site.revenueMinor / site.visitors,
  }
}

export function scoreRevenueSegment(
  row: RevenueSegmentCounts,
  prior: RevenueSegmentsPrior,
  k: number = REVENUE_SEGMENT_PRIOR_K,
): RevenueSegmentScore {
  const hasVisitors = row.visitors > 0
  return {
    ...row,
    conversionRate: hasVisitors ? row.buyers / row.visitors : null,
    smoothedConversionRate: smoothTowardPrior(row.buyers, row.visitors, prior.conversionRate, k),
    averageOrderValueMinor: row.orders > 0 ? row.revenueMinor / row.orders : null,
    valuePerVisitorMinor: hasVisitors ? row.revenueMinor / row.visitors : null,
    smoothedValuePerVisitorMinor: smoothTowardPrior(
      row.revenueMinor,
      row.visitors,
      prior.valuePerVisitorMinor,
      k,
    ),
    confidence: revenueSegmentConfidence(row.visitors, row.buyers),
  }
}

/**
 * The shown segments, scored against the site's rates and ranked by smoothed
 * value per visitor; ties go to the bigger segment, then to the segment key,
 * so the same counts always come out in the same order.
 */
export function rankRevenueSegments(
  rows: readonly RevenueSegmentCounts[],
  site: { visitors: number; buyers: number; revenueMinor: number },
  k: number = REVENUE_SEGMENT_PRIOR_K,
): RevenueSegmentScore[] {
  const rates = revenueSiteRates(site)
  const prior: RevenueSegmentsPrior = {
    conversionRate: rates.conversionRate ?? 0,
    valuePerVisitorMinor: rates.valuePerVisitorMinor ?? 0,
  }
  return rows
    .filter((row) => isRevenueSegmentShown(row.visitors))
    .map((row) => scoreRevenueSegment(row, prior, k))
    .sort(
      (a, b) =>
        b.smoothedValuePerVisitorMinor - a.smoothedValuePerVisitorMinor ||
        b.visitors - a.visitors ||
        compareText(a.source, b.source) ||
        compareText(a.country, b.country) ||
        compareText(a.device, b.device),
    )
}

/**
 * Never leave exactly one segment hidden. With one segment under the
 * threshold, the site totals minus the shown segments are that segment's own
 * visitors, buyers and revenue, and the threshold would hide nothing. So the
 * smallest shown segment (fewest visitors; of equals, the lowest ranked) is
 * withheld with it and counted as hidden, and the subtraction always has two
 * unknowns. `ranked` keeps its order; with no shown segment there is nothing
 * to withhold.
 *
 * Applied to the rows the response carries. When those are a top-N cut, the
 * smallest of them goes; the rows past the cut are not in the response
 * either, so the subtraction is not possible from it.
 */
export function withholdBesideLoneHidden<T extends { visitors: number }>(
  ranked: readonly T[],
  hidden: number,
): { segments: T[]; hidden: number } {
  if (hidden !== 1 || ranked.length === 0) return { segments: [...ranked], hidden }
  let smallest = 0
  ranked.forEach((row, index) => {
    if (row.visitors <= (ranked[smallest] as T).visitors) smallest = index
  })
  return { segments: ranked.filter((_, index) => index !== smallest), hidden: hidden + 1 }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
