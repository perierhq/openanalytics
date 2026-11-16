"use client";

import { ArrowUpDownIcon } from "hugeicons-react";
import * as React from "react";
import { liveRevenueState } from "@/components/dashboard/chart-markers";
import { useAnalyticsFilters } from "@/components/dashboard/filter-context";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { InfoTip } from "@/components/dashboard/overview-stats";
import { useSiteSummary } from "@/components/dashboard/site-summary-context";
import { useApiResource } from "@/hooks/use-api-resource";
import {
  LIVE_API,
  revenue,
  type RevenueAttributionDimension,
  type RevenueConnectionState,
} from "@/lib/api";
import { mockRevenueAttribution } from "@/lib/mock";
import {
  loadRowRevenue,
  revenueOf,
  rowRevenueAmount,
  rowRevenueCaveat,
  rowRevenueHold,
  rowRevenueTip,
  sharedAttribution,
  type RowRevenue,
  type RowRevenueDeps,
  type RowRevenueEntry,
  type RowSort,
} from "@/lib/row-revenue";

/**
 * Revenue on breakdown rows, for the Sources card and the Entry pages cut:
 * the read, the header's sort toggle and caveat, and the row tooltip. The
 * rules (who reads, how rows join, how they sort) are in `lib/row-revenue.ts`.
 */

const LIVE_DEPS: RowRevenueDeps = {
  // The overview chart's connection read: one per site for every layer.
  revenueState: liveRevenueState,
  // One read per site, cut and range for the page: switching cuts away and
  // back answers from the first read.
  attribution: sharedAttribution((siteId, range, options) =>
    revenue.attribution(siteId, range, options)
  ),
};

/** Mock mode: connected, like the chart's mock story; the role gate still applies. */
const MOCK_DEPS: RowRevenueDeps = {
  revenueState: async () => ({ status: "active" }) as RevenueConnectionState,
  attribution: sharedAttribution(async (_siteId, _range, { dimension }) =>
    mockRevenueAttribution(dimension)
  ),
};

/**
 * The card's revenue for `dimension`, or `null` for "show no revenue". When it
 * reads nothing at all is `rowRevenueHold` (a cut revenue is not about, a
 * pending range, an active filter, a range the read does not serve).
 */
export function useRowRevenue(
  dimension: RevenueAttributionDimension | null
): RowRevenue | null {
  const site = useSiteSummary().site;
  const { range, rangePending } = useAnalyticsInterval();
  const { active } = useAnalyticsFilters();
  const hold = rowRevenueHold({
    dimension,
    rangePending,
    filtered: active,
    range,
  });
  const load = React.useCallback(
    async (signal: AbortSignal): Promise<RowRevenue | null> => {
      if (dimension === null || hold) return null;
      if (!site) return new Promise<RowRevenue | null>(() => {});
      return loadRowRevenue(
        { siteId: site.site_id, role: site.role, range, dimension, signal },
        LIVE_API ? LIVE_DEPS : MOCK_DEPS
      );
    },
    [site, range, dimension, hold]
  );
  const resource = useApiResource(load);
  return resource.status === "ready" ? resource.data : null;
}

/**
 * "Visitors ↕" / "Revenue ↕": what the rows are ranked by, and a press ranks
 * them by the other. One button rather than a two-part switch, because it
 * shares the card header with the cut picker, the ⓘ and "See all", and a
 * header that wraps its title is worse than a choice that shows one option.
 * Styled as the header's other quiet control, "See all".
 */
export function RowSortToggle({
  sort,
  onSort,
  trafficLabel = "Visitors",
}: {
  sort: RowSort;
  onSort: (sort: RowSort) => void;
  /** The card's own number, when it is not visitors (Entry pages: entries). */
  trafficLabel?: string;
}) {
  const next: RowSort = sort === "visitors" ? "revenue" : "visitors";
  const label = (option: RowSort) =>
    option === "visitors" ? trafficLabel : "Revenue";
  return (
    <button
      aria-label={`Sorted by ${label(sort).toLowerCase()}. Sort by ${label(next).toLowerCase()}`}
      className="flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={() => onSort(next)}
      type="button"
    >
      {/* Both labels in one cell, so the button keeps its width on a press. */}
      <span className="grid text-right">
        {(["visitors", "revenue"] as const).map((option) => (
          <span
            aria-hidden={option !== sort}
            className={
              "col-start-1 row-start-1" + (option === sort ? "" : " invisible")
            }
            key={option}
          >
            {label(option)}
          </span>
        ))}
      </span>
      <ArrowUpDownIcon aria-hidden="true" className="size-3.5" />
    </button>
  );
}

/** The ⓘ beside the title while revenue is shown: which source gets the money. */
export function RowRevenueCaveat({
  entryPages = false,
  unconverted,
}: {
  entryPages?: boolean;
  /** A row of the card leaves orders in other currencies out. */
  unconverted: boolean;
}) {
  return (
    <InfoTip text={rowRevenueCaveat({ entryPages, unconverted })} width="w-60" />
  );
}

/** The row tooltip: the numbers behind the bar, for a row with revenue. */
export function RowRevenueTip({
  entry,
  currency,
}: {
  entry: RowRevenueEntry;
  currency: string;
}) {
  const { lines, note } = rowRevenueTip(entry, currency);
  return (
    <div className="py-0.5">
      <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
        {lines.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right tabular-nums">{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {note !== null ? (
        <p className="mt-1 max-w-48 text-muted-foreground">{note}</p>
      ) : null}
    </div>
  );
}

/** Everything a revenue-capable row needs, from the card's row key. */
export function rowRevenueProps(
  revenue: RowRevenue | null,
  key: string
): {
  revenue?: string | null;
  tooltip?: React.ReactNode;
} {
  if (revenue === null) return {};
  const entry = revenueOf(revenue, key);
  return {
    revenue: rowRevenueAmount(entry, revenue.currency),
    tooltip:
      entry === null ? undefined : (
        <RowRevenueTip currency={revenue.currency} entry={entry} />
      ),
  };
}
