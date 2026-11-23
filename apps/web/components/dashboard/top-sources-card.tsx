"use client";

import { ArrowDown01Icon, Globe02Icon } from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import { useParams } from "next/navigation";
import * as React from "react";
import { usePublishPosterSources } from "@/components/dashboard/poster-publishers";
import {
  AnalyticsCardBody,
  breakdownShare,
  BreakdownRow,
  useSiteAnalytics,
} from "@/components/dashboard/analytics-card";
import { useAnalyticsFilters } from "@/components/dashboard/filter-context";
import { HoverList } from "@/components/dashboard/hover-list";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { useApiResource } from "@/hooks/use-api-resource";
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
import {
  getAnalyticsChannels,
  getReferrerPaths,
  LIVE_API,
  resolveSiteSlugCached,
  type AnalyticsMeta,
  type RevenueAttributionDimension,
  type SourceRow,
} from "@/lib/api";
import { MOCK_CHANNELS, MOCK_REFERRER_PATHS } from "@/lib/mock";
import { stackedBars } from "@/lib/row-bars";
import {
  foldChannels,
  foldReferrers,
  foldUtm,
  pathHostsOf,
  REFERRER_PATHS_MAX_DAYS,
  referrerPathsByRow,
  referrerPathsServable,
  sourcesGroupByFor,
  type FoldedRow,
  type ReferrerPathItem,
  type SourceView,
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
 * row is the full tuple (referrer domain × utm source/medium/campaign), each
 * carrying the channel the server classified it into; one card shows one
 * *dimension* of it at a time, picked in the header — referrers by default,
 * then channels, then the utm cuts. The Channels cut reads its own
 * `group_by=channel` answer, one row per channel summed by the api over the
 * deepest tuple list it serves, rather than folding this card's top-100
 * tuple read: the rule and the totals are the server's
 * (`packages/domain/src/channel.ts`). Mixing the dimensions into one
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
 * earned anything shows the card exactly as it was. Channels show no
 * revenue: revenue attribution groups by one stored column (referrer, a utm
 * field, entry page), and a channel is computed from several of them.
 *
 * The See all list on the Referrers cut also shows the pages a referrer's
 * visits came from (`/analytics/sources/referrer-paths`): one read for the
 * top hosts when the modal opens, and a row expands only when its hosts sent
 * at least one page beyond their origin.
 */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

const VIEWS: {
  id: SourceView;
  label: string;
  empty: string;
  /** The attribution dimension whose revenue joins onto this cut's rows;
   *  `null` for a cut revenue attribution cannot group by. */
  revenue: RevenueAttributionDimension | null;
}[] = [
  {
    id: "referrers",
    label: "Referrers",
    empty: "No referrers in this range yet.",
    revenue: "referrer_domain",
  },
  {
    id: "channels",
    label: "Channels",
    empty: "No visits in this range yet.",
    revenue: null,
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
  if (view === "referrers") return foldReferrers(items);
  if (view === "channels") return foldChannels(items);
  return foldUtm(items, view);
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
  const { enabled, active, addFilter, hasValue, filtersParam } =
    useAnalyticsFilters();
  const tuples = useSourcesResource();
  const [view, setView] = React.useState<SourceView>("referrers");
  // The Channels cut's own `group_by=channel` read, fired the first time the
  // cut is picked and kept from then on, so switching back is instant.
  const [channelsWanted, setChannelsWanted] = React.useState(false);
  const channels = useSiteAnalytics(getAnalyticsChannels, MOCK_CHANNELS, {
    filters: filtersParam,
    enabled: channelsWanted,
  });
  const resource = sourcesGroupByFor(view) === "channel" ? channels : tuples;
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
  // the poster prints referrers, folded from the tuple list.
  const posterRows = React.useMemo(
    () =>
      tuples.status === "ready"
        ? foldReferrers(tuples.data.items).map((row) => ({
            label: row.label,
            domain: row.domain,
            direct: row.direct,
            visitors: row.visitors,
          }))
        : null,
    [tuples]
  );
  usePublishPosterSources(
    posterRows,
    tuples.status === "ready" && tuples.data.meta.truncated
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
            <DropdownMenuItem
              key={entry.id}
              onClick={() => {
                if (sourcesGroupByFor(entry.id) === "channel") {
                  setChannelsWanted(true);
                }
                setView(entry.id);
              }}
            >
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

/** How many hosts one referring-pages read names (the route's own cap). */
const REFERRER_PATHS_HOSTS = 20;

/**
 * The referring pages of the See all list's Referrers rows, keyed by row
 * label: one read for the hosts of the top rows when the list opens. `null`
 * while it is loading, when the cut is not Referrers, when the range is wider
 * than the read serves (`tooWide`, which the list says in a note), or when
 * the read failed; a row is an expander only when its entry here has at
 * least one page, so none of those states can draw an expander that opens
 * onto nothing.
 */
function useReferrerPaths(
  rows: FoldedRow[] | null,
  tooWide: boolean
): Map<string, ReferrerPathItem[]> | null {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const { range, rangePending } = useAnalyticsInterval();
  const { filtersParam } = useAnalyticsFilters();
  const hosts = rows === null ? null : pathHostsOf(rows, REFERRER_PATHS_HOSTS);
  const hostsKey = hosts === null ? null : hosts.join("\u0000");

  const load = React.useCallback(
    async (signal: AbortSignal) => {
      const named = hostsKey === null || hostsKey === "" ? [] : hostsKey.split("\u0000");
      if (named.length === 0 || tooWide) return [];
      if (!LIVE_API) {
        return MOCK_REFERRER_PATHS.items.filter((row) =>
          named.includes(row.referrer_domain)
        );
      }
      if (rangePending) return new Promise<never>(() => {});
      const { site_id } = await resolveSiteSlugCached(slug);
      const response = await getReferrerPaths(site_id, range, named, {
        signal,
        limit: 10,
        ...(filtersParam ? { filters: filtersParam } : {}),
      });
      return response.items;
    },
    [hostsKey, tooWide, slug, range, rangePending, filtersParam]
  );
  const resource = useApiResource(load);
  return React.useMemo(
    () =>
      rows === null || resource.status !== "ready"
        ? null
        : referrerPathsByRow(rows, resource.data),
    [rows, resource]
  );
}

/** The pages under an open Referrers row, each a link to the page itself. */
function ReferrerPathList({
  paths,
  pct,
  revenue,
}: {
  paths: ReferrerPathItem[];
  /** Whether the rows print a share, so the numbers line up under theirs. */
  pct: boolean;
  revenue: boolean;
}) {
  return (
    <ul className="flex flex-col pl-[46px] pr-5">
      {paths.map((path) => (
        <li
          className="flex items-baseline justify-between gap-4 py-1"
          key={path.label}
        >
          <a
            className="line-clamp-2 min-w-0 break-all text-[13px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            href={`https://${path.label}`}
            rel="noopener noreferrer"
            target="_blank"
            title={path.label}
          >
            {path.label}
          </a>
          <span className="flex shrink-0 items-baseline gap-2">
            <span className="text-[13px] tabular-nums text-muted-foreground">
              {path.visitors.toLocaleString("en-US")}
            </span>
            {pct ? <span aria-hidden="true" className="w-10" /> : null}
            {revenue ? <span aria-hidden="true" className="w-14" /> : null}
            <span aria-hidden="true" className="w-3.5" />
          </span>
        </li>
      ))}
    </ul>
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
  const rows = React.useMemo(
    () => (items === null ? null : foldView(items, view)),
    [items, view]
  );
  const share = breakdownShare(
    rows === null ? [] : rows.map((row) => row.visitors),
    meta?.truncated ?? false
  );
  const ranked = rows === null ? null : rankRows(rows, revenue, sort);
  // The api caps the read on the range it actually queries, the aligned
  // `effective_range`, so the card checks that one and says why when the
  // pages are not offered rather than quietly drawing no expanders.
  const pathsTooWide =
    view === "referrers" &&
    meta !== null &&
    !referrerPathsServable(meta.effective_range);
  const paths = useReferrerPaths(
    view === "referrers" && ranked !== null ? ranked.map(({ row }) => row) : null,
    pathsTooWide
  );
  const [open, setOpen] = React.useState<string | null>(null);
  const anyExpander =
    paths !== null && [...paths.values()].some((list) => list.length > 0);
  const printsPct = rows !== null && rows.some((row) => share(row.visitors) !== undefined);

  return (
    <SeeAllModal
      title={current.label}
      subtitle={`Where every visit came from · ${intervalLabel}`}
      onClose={onClose}
    >
      {rows === null || ranked === null ? (
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
              expander={anyExpander}
              pct={printsPct}
            />
          ) : null}
          {/* the shared white glide, rounded for the grey band */}
          <HoverList className="[&>li>span]:rounded-[10px]">
            {ranked.map(({ row, bar }) => {
              const rowPaths = paths?.get(row.label);
              const expandable = rowPaths !== undefined && rowPaths.length > 0;
              return (
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
                  reserveExpander={anyExpander}
                  {...(expandable
                    ? {
                        expanded: open === row.label,
                        onToggle: () =>
                          setOpen((label) =>
                            label === row.label ? null : row.label
                          ),
                        details: (
                          <ReferrerPathList
                            paths={rowPaths}
                            pct={share(row.visitors) !== undefined}
                            revenue={revenue !== null}
                          />
                        ),
                      }
                    : {})}
                />
              );
            })}
          </HoverList>
          {pathsTooWide ? (
            <p className="px-5 pb-1 pt-3 text-xs text-muted-foreground">
              Referring pages are available for ranges up to{" "}
              {REFERRER_PATHS_MAX_DAYS} days.
            </p>
          ) : null}
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
  expander,
  pct,
}: {
  columns: string[];
  /** Whether the rows end in an expander's chevron, so the captions do too. */
  expander: boolean;
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
        {expander ? <span aria-hidden="true" className="w-3.5" /> : null}
      </span>
    </div>
  );
}
