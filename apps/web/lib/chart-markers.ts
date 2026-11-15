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

/**
 * The revenue gate every chart layer shares: the member may read revenue
 * (owner only, decided without a request) and a provider is connected. A
 * `disabled` connection keeps its recorded history, which is still real
 * money, so it counts. Throws what the connection read throws; callers turn
 * that into "no layer".
 */
export async function hasRevenueAccess(
  siteId: string,
  role: SiteRole,
  revenueState: ChartMarkerDeps["revenueState"],
  signal?: AbortSignal
): Promise<boolean> {
  if (!canReadRevenue(role)) return false;
  const state = await revenueState(siteId, { signal });
  return state.status !== "not_connected";
}

async function loadSales(
  siteId: string,
  role: SiteRole,
  range: AnalyticsRange,
  deps: ChartMarkerDeps,
  signal?: AbortSignal
): Promise<RevenueTransaction[]> {
  try {
    if (!(await hasRevenueAccess(siteId, role, deps.revenueState, signal))) return [];
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

/** How long one connection read answers for, per site. */
const REVENUE_STATE_TTL_MS = 60_000;

/**
 * One connection read per site, shared by every chart layer that needs the
 * revenue gate (the sale markers and the revenue bars), instead of one read
 * per layer on every range change.
 *
 * The read is sent without a caller's abort signal: it is shared, and one
 * caller leaving must not cancel it for the other. A failed read is not kept,
 * and an answer expires after a minute, so a provider connected in another
 * tab or on the integrations page shows up on the next range change rather
 * than on the next page load.
 */
export function sharedRevenueState(
  read: ChartMarkerDeps["revenueState"],
  options: { ttlMs?: number; now?: () => number } = {}
): ChartMarkerDeps["revenueState"] {
  const ttlMs = options.ttlMs ?? REVENUE_STATE_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; pending: Promise<RevenueConnectionState> }>();
  return (siteId) => {
    const cached = cache.get(siteId);
    if (cached && now() - cached.at < ttlMs) return cached.pending;
    const pending = read(siteId, {}).catch((raised: unknown) => {
      if (cache.get(siteId)?.pending === pending) cache.delete(siteId);
      throw raised;
    });
    cache.set(siteId, { at: now(), pending });
    return pending;
  };
}

/**
 * Everything the overview chart's legend can hide: the two marker kinds and
 * the revenue bars. One list in one stored value, so the bars joined without
 * a new key.
 */
export type OverviewChartLayer = "sale" | "mention" | "revenue";

/**
 * The legend's stored value, a JSON array of hidden layers. A value saved
 * before the revenue layer existed (`["sale"]`) reads as it was; entries this
 * build does not know are dropped, and anything unreadable hides nothing.
 */
export function parseHiddenLayers(raw: string): OverviewChartLayer[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (kind): kind is OverviewChartLayer =>
        kind === "sale" || kind === "mention" || kind === "revenue"
    );
  } catch {
    return [];
  }
}
