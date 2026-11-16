"use client";

import { ArrowDown01Icon, Globe02Icon } from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { usePublishPosterSources } from "@/components/dashboard/poster-publishers";
import {
  AnalyticsCardBody,
  breakdownShare,
  BreakdownRow,
} from "@/components/dashboard/analytics-card";
import { useAnalyticsFilters } from "@/components/dashboard/filter-context";
import { HoverList } from "@/components/dashboard/hover-list";
import {
  SeeAllModal,
  SeeAllSkeleton,
  useIntervalLabel,
} from "@/components/dashboard/see-all-modal";
import { useSourcesResource } from "@/components/dashboard/sources-resource";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  SquircleCard,
  SquircleCardScroll,
} from "@/components/ui/squircle-card";
import {
  RowRevenueCaveat,
  rowRevenueProps,
  RowSortToggle,
  useRowRevenue,
} from "@/components/dashboard/row-revenue";
import type {
  AnalyticsMeta,
  RevenueAttributionDimension,
  SourceRow,
} from "@/lib/api";
import { stackedBars } from "@/lib/row-bars";
import {
  foldReferrers,
  foldUtm,
  type FoldedRow,
} from "@/lib/source-rows";
import { sourceMark } from "@/components/dashboard/source-mark";
import {
  hasUnconvertedOrders,
  revenueOf,
  rowRevenueAmount,
  seeAllColumns,
  sortRows,
  type RowRevenue,
  type RowSort,
} from "@/lib/row-revenue";

/**
 * Acquisition, from `GET /v1/sites/{site_id}/analytics/sources`. The contract
 * row is the full tuple (referrer domain × utm source/medium/campaign); one
 * card shows one *dimension* of it at a time, picked in the header —
 * referrers by default, then the utm cuts. Mixing the dimensions into one
 * list conflated `utm_source=chatgpt.com` with the chatgpt.com referrer,
 * which are different statements about the same visit.
 *
 * Folding sums visitor counts across tuples, so a visitor who arrived under
 * two campaigns of one source counts twice in that row — a small, deliberate
 * over-count. The rows are ranked by that visitors figure all the same,
 * because it is the number the row shows: ranking by the exact views sum
 * underneath read 27, 2, 27, 18 down the list (Abbas, 2026-09-10). Views
 * stay on the row as the tie-break.
 *
 * The read itself is shared with the AI referrals card through
 * `SourcesProvider` (sources-resource.tsx): both fold the same response,
 * and the overview fetches it once.
 *
 * For a site's owner with a connected provider, each cut also shows the
 * last-touch revenue its rows brought (`lib/row-revenue.ts`): a green part on
 * the row's bar, the amount beside its visitors, and a header toggle that
 * ranks the rows by it. Anyone else, a failed read, or a cut where no row
 * earned anything shows the card exactly as it was.
 */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

type SourceView = "referrers" | "utm_campaign" | "utm_source" | "utm_medium";

const VIEWS: {
  id: SourceView;
  label: string;
  empty: string;
  /** The attribution dimension whose revenue joins onto this cut's rows. */
  revenue: RevenueAttributionDimension;
}[] = [
  {
    id: "referrers",
    label: "Referrers",
    empty: "No referrers in this range yet.",
    revenue: "referrer_domain",
  },
  {
    id: "utm_campaign",
    label: "Campaigns",
    empty: "No campaign-tagged visits in this range.",
    revenue: "utm_campaign",
  },
  {
    id: "utm_source",
    label: "UTM sources",
    empty: "No utm_source-tagged visits in this range.",
    revenue: "utm_source",
  },
  {
    id: "utm_medium",
    label: "UTM medium",
    empty: "No utm_medium-tagged visits in this range.",
    revenue: "utm_medium",
  },
];

/** One cut of the tuple list, ranked by visitors. */
function foldView(items: SourceRow[], view: SourceView): FoldedRow[] {
  return view === "referrers" ? foldReferrers(items) : foldUtm(items, view);
}

/**
 * The rows as the card draws them: ranked by `sort`, and the bar behind each,
 * its revenue segment only while revenue is shown. The row's label is its
 * revenue key (referrers fold by label, utm values are the label).
 */
function rankRows(
  rows: FoldedRow[],
  revenue: RowRevenue | null,
  sort: RowSort
) {
  const revenueMinor = (row: FoldedRow) =>
    revenueOf(revenue, row.label)?.revenueMinor ?? 0;
  const ranked = sortRows(rows, revenue === null ? "visitors" : sort, {
    traffic: (row) => row.visitors,
    revenue: revenueMinor,
  });
  const bars = stackedBars(
    ranked.map((row) => ({
      traffic: row.visitors,
      revenue: revenue === null ? null : revenueMinor(row),
    })),
    revenue !== null && sort === "revenue" ? "revenue" : "traffic"
  );
  return ranked.map((row, index) => ({ row, bar: bars[index] ?? [] }));
}

/** Revenue only when at least one row of the cut has some to show. */
function shownRevenue(
  rows: FoldedRow[] | null,
  revenue: RowRevenue | null
): RowRevenue | null {
  if (rows === null || revenue === null) return null;
  return rows.some((row) => revenueOf(revenue, row.label) !== null)
    ? revenue
    : null;
}

export function TopSourcesCard() {
  const { enabled, active, addFilter, hasValue } = useAnalyticsFilters();
  const resource = useSourcesResource();
  const [view, setView] = React.useState<SourceView>("referrers");
  const [open, setOpen] = React.useState(false);
  const [sort, setSort] = React.useState<RowSort>("visitors");
  const current = VIEWS.find((entry) => entry.id === view) ?? VIEWS[0];

  // Owner-only revenue beside the visitors; `null` for everyone else, for a
  // failed read, and for a cut none of whose rows earned anything.
  const rowRevenue = useRowRevenue(current.revenue);
  const folded = React.useMemo(
    () =>
      resource.status === "ready" ? foldView(resource.data.items, view) : null,
    [resource, view]
  );
  const revenue = shownRevenue(folded, rowRevenue);

  // The referrer fold for the share poster, whatever cut the header shows:
  // the poster prints referrers, and the fold reads the same tuple list.
  const posterRows = React.useMemo(
    () =>
      resource.status === "ready"
        ? foldReferrers(resource.data.items).map((row) => ({
            label: row.label,
            domain: row.domain,
            direct: row.direct,
            visitors: row.visitors,
          }))
        : null,
    [resource]
  );
  usePublishPosterSources(
    posterRows,
    resource.status === "ready" && resource.data.meta.truncated
  );

  return (
    <>
    <SquircleCard
      onSeeAll={() => setOpen(true)}
      icon={<Globe02Icon aria-hidden="true" />}
      titleAside={
        revenue !== null ? (
          <RowRevenueCaveat
            unconverted={hasUnconvertedOrders(
              revenue,
              (folded ?? []).map((row) => row.label)
            )}
          />
        ) : undefined
      }
      actions={
        revenue !== null ? (
          <RowSortToggle onSort={setSort} sort={sort} />
        ) : undefined
      }
      title={
        <DropdownMenu
          align="start"
          className="w-44"
          trigger={
            <button
              className="flex cursor-pointer items-center gap-1 rounded-lg py-0.5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
            >
              {/* the house label swap — the title glides when the cut changes */}
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -9, opacity: 0, transition: { duration: 0.1 } }}
                  initial={{ y: 9, opacity: 0 }}
                  key={current.id}
                  transition={SPRING}
                >
                  {current.label}
                </motion.span>
              </AnimatePresence>
              <ArrowDown01Icon
                aria-hidden="true"
                className="!size-3.5 text-muted-foreground/70"
              />
            </button>
          }
        >
          {VIEWS.map((entry) => (
            <DropdownMenuItem key={entry.id} onClick={() => setView(entry.id)}>
              {entry.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenu>
      }
    >
      <AnalyticsCardBody
        emptyBody={
          active
            ? "No visits match these filters."
            : "No referrers in this range yet."
        }
        isEmpty={(data) => data.items.length === 0}
        resource={resource}
      >
        {(data) => {
          const rows = folded ?? foldView(data.items, view);
          const share = breakdownShare(
            rows.map((row) => row.visitors),
            data.meta.truncated
          );
          return (
            <AnimatePresence initial={false} mode="wait">
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="h-full"
                exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}
                initial={{ opacity: 0, y: 8 }}
                key={view}
                transition={SPRING}
              >
                {rows.length === 0 ? (
                  <p className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                    {current.empty}
                  </p>
                ) : (
                  <SquircleCardScroll>
                    <HoverList>
                      {rankRows(rows, revenue, sort).map(({ row, bar }) => (
                        <BreakdownRow
                          {...rowRevenueProps(revenue, row.label)}
                          bar={bar}
                          icon={sourceMark(row)}
                          key={row.label}
                          name={row.label}
                          // Referrers only: the utm cuts have no filter
                          // dimension in v1, so their rows stay plain rows.
                          onSelect={
                            enabled &&
                            view === "referrers" &&
                            // Already filtered by every host this row folds:
                            // the press would add nothing, so the row does not
                            // offer one. Under a source filter this is most of
                            // the rows left standing.
                            !row.raw.every((domain) =>
                              hasValue("referrer_domain", domain)
                            )
                              ? () => {
                                  for (const domain of row.raw) {
                                    addFilter("referrer_domain", domain);
                                  }
                                }
                              : undefined
                          }
                          pct={share(row.visitors)}
                          value={row.visitors.toLocaleString("en-US")}
                        />
                      ))}
                    </HoverList>
                  </SquircleCardScroll>
                )}
              </motion.div>
            </AnimatePresence>
          );
        }}
      </AnalyticsCardBody>
    </SquircleCard>

    <AnimatePresence>
      {open && (
        <SourcesModal
          items={resource.status === "ready" ? resource.data.items : null}
          meta={resource.status === "ready" ? resource.data.meta : null}
          revenue={revenue}
          sort={sort}
          view={view}
          onClose={() => setOpen(false)}
        />
      )}
    </AnimatePresence>
    </>
  );
}

/** The whole ranking of the cut the card is on, in the vertical shell. */
function SourcesModal({
  items,
  meta,
  revenue,
  sort,
  view,
  onClose,
}: {
  items: SourceRow[] | null;
  /** Read for `truncated` alone: a share of a capped row set is inflated. */
  meta: AnalyticsMeta | null;
  /** The card's revenue, when it shows any: a Revenue column here. */
  revenue: RowRevenue | null;
  /** The card's order, so the modal continues the list the card began. */
  sort: RowSort;
  view: SourceView;
  onClose: () => void;
}) {
  const intervalLabel = useIntervalLabel();
  const current = VIEWS.find((entry) => entry.id === view) ?? VIEWS[0];
  const rows = items === null ? null : foldView(items, view);
  const share = breakdownShare(
    rows === null ? [] : rows.map((row) => row.visitors),
    meta?.truncated ?? false
  );

  return (
    <SeeAllModal
      title={current.label}
      subtitle={`Where every visit came from · ${intervalLabel}`}
      onClose={onClose}
    >
      {rows === null ? (
        <SeeAllSkeleton />
      ) : rows.length === 0 ? (
        <p className="px-6 py-14 text-center text-sm text-muted-foreground">
          {current.empty}
        </p>
      ) : (
        <div>
          {revenue !== null ? (
            <SourcesColumns
              columns={seeAllColumns("sources", true)}
              pct={rows.some((row) => share(row.visitors) !== undefined)}
            />
          ) : null}
          {/* the shared white glide, rounded for the grey band */}
          <HoverList className="[&>li>span]:rounded-[10px]">
            {rankRows(rows, revenue, sort).map(({ row, bar }) => (
              <BreakdownRow
                bar={bar}
                icon={sourceMark(row)}
                key={row.label}
                name={row.label}
                pct={share(row.visitors)}
                revenue={
                  revenue === null
                    ? undefined
                    : rowRevenueAmount(
                        revenueOf(revenue, row.label),
                        revenue.currency
                      )
                }
                value={row.visitors.toLocaleString("en-US")}
              />
            ))}
          </HoverList>
        </div>
      )}
    </SeeAllModal>
  );
}

/**
 * The modal's column captions, once above the rows. The first number column
 * is the visitors with their share beside it (the `w-10` spacer, when the rows
 * print one), then the revenue column at the row's own `w-14`.
 */
function SourcesColumns({
  columns,
  pct,
}: {
  columns: string[];
  pct: boolean;
}) {
  const [first, ...rest] = columns;
  return (
    <div className="flex items-center justify-between gap-4 pb-1.5 pl-4.5 pr-5">
      <span className="text-xs font-medium text-muted-foreground/70">
        Source
      </span>
      <span className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-muted-foreground/70">
          {first}
        </span>
        {pct ? <span aria-hidden="true" className="w-10" /> : null}
        {rest.map((column) => (
          <span
            className="w-14 text-right text-xs font-medium text-muted-foreground/70"
            key={column}
          >
            {column}
          </span>
        ))}
      </span>
    </div>
  );
}
