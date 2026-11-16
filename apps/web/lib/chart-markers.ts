/**
 * What the overview chart marks on its timeline: posts that mention the site,
 * and sales.
 *
 * The loader takes its reads as arguments so the rules about *when* to read
 * are tested without a network: mentions are readable by every member, while
 * revenue is `revenue:read`, which is owner-only, and needs a connected
 * provider. An admin or a viewer therefore never sends a revenue request at
 * all (a `403` per page load would be noise in their console and our logs),
 * and an owner without a connection stops after the connection read.
 *
 * Every failure becomes "no markers of that kind". The markers decorate the
 * chart; they never get to break it.
 */

import type {
  AnalyticsRange,
  Mention,
  MentionsResponse,
  Money,
  RevenueConnectionState,
  RevenueTransaction,
  RevenueTransactionsResponse,
  SiteRole,
} from "./api";

/** One page is enough for markers; 200 is the contract's page maximum. */
export const MARKER_PAGE_LIMIT = 200;

export type ChartMarkerDeps = {
  listMentions: (
    siteId: string,
    range: AnalyticsRange,
    options: { limit: number; signal?: AbortSignal }
  ) => Promise<Pick<MentionsResponse, "items">>;
  revenueState: (
    siteId: string,
    options: { signal?: AbortSignal }
  ) => Promise<RevenueConnectionState>;
  revenueTransactions: (
    siteId: string,
    range: AnalyticsRange,
    options: { limit: number; signal?: AbortSignal }
  ) => Promise<Pick<RevenueTransactionsResponse, "items">>;
};

export type ChartMarkerData = {
  mentions: Mention[];
  sales: RevenueTransaction[];
};

/** `revenue:read` is owner-only (the overview's revenue card hides for anyone else). */
export function canReadRevenue(role: SiteRole): boolean {
  return role === "owner";
}

/** Charge statuses that mean the money moved. A later refund doesn't undo the sale. */
const SALE_STATUSES = new Set(["succeeded", "partially_refunded", "refunded"]);

/**
 * A sale is a live charge that went through. Refunds and disputes are not
 * sales, failed or pending charges did not happen yet, and a test-mode charge
 * must never read as real money.
 */
export function isSale(transaction: RevenueTransaction): boolean {
  return (
    transaction.object_kind === "charge" &&
    transaction.livemode &&
    SALE_STATUSES.has(transaction.status)
  );
}

/**
 * What a sale is worth on screen: its net restated in the reporting currency,
 * or its own net in its own currency when no rate existed (`reporting` null).
 */
export function saleAmount(transaction: RevenueTransaction): Money {
  return transaction.reporting ?? transaction.net;
}

/**
 * Totals per currency, in first-seen order. Unconverted sales keep their own
 * currency instead of being summed into the reporting total: adding euros to
 * dollars is a number nobody earned.
 */
export function saleTotals(sales: readonly RevenueTransaction[]): Money[] {
  const totals = new Map<string, number>();
  for (const sale of sales) {
    const amount = saleAmount(sale);
    totals.set(amount.currency, (totals.get(amount.currency) ?? 0) + amount.amount_minor);
  }
  return [...totals.entries()].map(([currency, amount_minor]) => ({
    amount_minor,
    currency,
  }));
}

async function loadSales(
  siteId: string,
  role: SiteRole,
  range: AnalyticsRange,
  deps: ChartMarkerDeps,
  signal?: AbortSignal
): Promise<RevenueTransaction[]> {
  if (!canReadRevenue(role)) return [];
  try {
    const state = await deps.revenueState(siteId, { signal });
    // `disabled` keeps its recorded history, which is still real sales.
    if (state.status === "not_connected") return [];
    const page = await deps.revenueTransactions(siteId, range, {
      limit: MARKER_PAGE_LIMIT,
      signal,
    });
    return page.items.filter(isSale);
  } catch {
    return [];
  }
}

async function loadMentions(
  siteId: string,
  range: AnalyticsRange,
  deps: ChartMarkerDeps,
  signal?: AbortSignal
): Promise<Mention[]> {
  try {
    const page = await deps.listMentions(siteId, range, {
      limit: MARKER_PAGE_LIMIT,
      signal,
    });
    return page.items;
  } catch {
    return [];
  }
}

/** Both reads in parallel; each one fails on its own. */
export async function loadChartMarkers(
  request: {
    siteId: string;
    role: SiteRole;
    range: AnalyticsRange;
    signal?: AbortSignal;
  },
  deps: ChartMarkerDeps
): Promise<ChartMarkerData> {
  const { siteId, role, range, signal } = request;
  const [mentions, sales] = await Promise.all([
    loadMentions(siteId, range, deps, signal),
    loadSales(siteId, role, range, deps, signal),
  ]);
  return { mentions, sales };
}
