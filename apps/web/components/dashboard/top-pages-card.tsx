"use client";

import { ArrowDown01Icon, File01Icon } from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import {
  AnalyticsCardBody,
  useSiteAnalytics,
} from "@/components/dashboard/analytics-card";
import {
  BreakdownRow,
  RevenueAmount,
} from "@/components/dashboard/breakdown-row";
import { useAnalyticsFilters } from "@/components/dashboard/filter-context";
import { usePublishPosterPages } from "@/components/dashboard/poster-publishers";
import { HoverList, HoverRow } from "@/components/dashboard/hover-list";
import { RowBar } from "@/components/dashboard/row-bar";
import {
  SeeAllModal,
  SeeAllSkeleton,
  useIntervalLabel,
} from "@/components/dashboard/see-all-modal";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  RowRevenueCaveat,
  rowRevenueProps,
  RowSortToggle,
  useRowRevenue,
} from "@/components/dashboard/row-revenue";
import {
  SquircleCard,
  SquircleCardScroll,
} from "@/components/ui/squircle-card";
import {
  getAnalyticsPages,
  LIVE_API,
  type PageRow,
  type PagesSort,
} from "@/lib/api";
import { MOCK_PAGES } from "@/lib/mock";
import { stackedBars } from "@/lib/row-bars";
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
 * Top pages, from `GET /v1/sites/{site_id}/analytics/pages`, and, behind
 * the header dropdown, the same read ranked as entry pages or exit pages
 * (ADR-0075 §3).
 *
 * **The dropdown changes the request, not the array.** The server returns
 * the top N *by the sorted measure*, and the cut and the sort are one
 * decision: a top-100-by-views page re-sorted by exits client-side would
 * present that page's biggest exits as the site's biggest exits, and the
 * checkout-confirmation page (a busy exit, a quiet view) would be missing
 * from it entirely. So picking a cut sends `?sort=` and the ranking comes
 * back whole.
 *
 * **`null` is not zero.** The four session fields are nullable, and `null`
 * means "not measured on this response": an imported row, or a surface
 * that does not ask. `0` is a measurement: no session began or ended here.
 * The two render differently on purpose: a dash for null, a zero for zero.
 *
 * **Entry pages carry revenue** for a site's owner: the last-touch revenue of
 * the visits that began on the page, as on the Sources card
 * (`lib/row-revenue.ts`). Only that cut: revenue is about where a buyer's
 * visit began, which says nothing about a page's views or its exits.
 *
 * Brings its own SquircleCard: the header carries the cut picker and
 * "See all" opens the vertical modal, both of which need card state.
 */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

type PagesView = "pages" | "entries" | "exits";

const VIEWS: {
  id: PagesView;
  label: string;
  sort: PagesSort;
  /** What the number column holds in this cut. */
  measure: (page: PageRow) => number | null;
}[] = [
  {
    id: "pages",
    label: "Top pages",
    // The server ranks pages by views, entrances or exits, and by nothing
    // else; the card shows visitors, so this is the one cut whose order
    // and whose column are different measures. `orderRows` closes the gap
    // wherever it honestly can.
    sort: "views",
    measure: (page) => page.visitors,
  },
  {
    id: "entries",
    label: "Entry pages",
    sort: "entrances",
    measure: (page) => page.entrances,
  },
  {
    id: "exits",
    label: "Exit pages",
    sort: "exits",
    measure: (page) => page.exits,
  },
];

/**
 * A nullable measure, rendered by the null-is-not-zero rule: a dash for
 * "not measured on this response", the number (zero included) for a
 * measurement. An en dash, not a hyphen: it reads as a mark rather than
 * as punctuation at this size.
 */
function measureLabel(value: number | null): string {
  return value === null ? "–" : value.toLocaleString("en-US");
}

/** `bounce_rate` is `[0,1]` with its denominator on the same row; a null
 *  rate with zero entrances is correct, not missing data. */
function rateLabel(value: number | null): string {
  return value === null ? "–" : `${Math.round(value * 100)}%`;
}

export function TopPagesCard() {
  const { active, filtersParam } = useAnalyticsFilters();
  const [view, setView] = React.useState<PagesView>("pages");
  const current = VIEWS.find((entry) => entry.id === view) ?? VIEWS[0];

  const resource = useSiteAnalytics(getAnalyticsPages, MOCK_PAGES, {
    filters: filtersParam,
    sort: current.sort,
  });
  const [open, setOpen] = React.useState(false);
  const [sort, setSort] = React.useState<RowSort>("visitors");

  // Revenue is about where visits began, so only the Entry pages cut reads
  // it (owner-only; `null` for everyone else and on any failure).
  const rowRevenue = useRowRevenue(view === "entries" ? "entry_page" : null);
  const revenue =
    view === "entries" &&
    rowRevenue !== null &&
    resource.status === "ready" &&
    resource.data.items.some(
      (page) => revenueOf(rowRevenue, page.page_path) !== null
    )
      ? rowRevenue
      : null;

  // The views ranking for the share poster, and only that: the read is
  // cut by the header's sort, and a top-N by exits is not a top pages list.
  const posterRows = React.useMemo(
    () =>
      resource.status === "ready" && current.sort === "views"
        ? resource.data.items.map((page) => ({
            path: page.page_path,
            views: page.views,
          }))
        : null,
    [resource, current.sort]
  );
  usePublishPosterPages(
    posterRows,
    resource.status === "ready" && resource.data.meta.truncated
  );

  /**
   * Rows in the order of the column they show, wherever that is honest.
   *
   * The rule above is about a top-N cut of a larger population, and it
   * stands: a capped response keeps the server's order whatever the column
   * holds. But a response the gateway did not cap (`meta.truncated` false)
   * IS its whole population, like the mock fixture always is, and sorting
   * the whole by the shown measure presents nothing the server did not
   * return. That is what the Top pages cut needs: it shows visitors on a
   * views ranking, which read 45, 38, 62 down the card (Abbas, 2026-09-10).
   * Stable, so ties keep the server's order. Over a capped set the numbers
   * can still read out of order; the fix there is a `sort=visitors` the
   * server does not take yet.
   */
  const orderRows = React.useCallback(
    (rows: PageRow[], truncated: boolean): PageRow[] => {
      if (LIVE_API && truncated) return rows;
      return [...rows].sort(
        (a, b) => (current.measure(b) ?? -1) - (current.measure(a) ?? -1)
      );
    },
    [current]
  );

  return (
    <>
      <SquircleCard
        icon={<File01Icon aria-hidden="true" />}
        onSeeAll={() => setOpen(true)}
        titleAside={
          revenue !== null && resource.status === "ready" ? (
            <RowRevenueCaveat
              entryPages
              unconverted={hasUnconvertedOrders(
                revenue,
                resource.data.items.map((page) => page.page_path)
              )}
            />
          ) : undefined
        }
        actions={
          revenue !== null ? (
            <RowSortToggle
              onSort={setSort}
              sort={sort}
              trafficLabel="Entries"
            />
          ) : undefined
        }
        title={
          <DropdownMenu
            align="start"
            className="w-40"
            trigger={
              <button
                className="flex cursor-pointer items-center gap-1 rounded-lg py-0.5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
              >
                {/* the house label swap: the title glides on cut change */}
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
                onClick={() => setView(entry.id)}
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
              : "No pageviews in this range yet."
          }
          isEmpty={(data) => data.items.length === 0}
          resource={resource}
        >
          {(data) => (
            <AnimatePresence initial={false} mode="wait">
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="h-full"
                exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}
                initial={{ opacity: 0, y: 8 }}
                key={view}
                transition={SPRING}
              >
                <SquircleCardScroll>
                  <HoverList>
                    {rankPages(
                      orderRows(data.items, data.meta.truncated),
                      current,
                      revenue,
                      sort
                    ).map(({ page, bar }) => (
                      <BreakdownRow
                        {...rowRevenueProps(revenue, page.page_path)}
                        bar={bar}
                        key={page.page_path}
                        name={page.page_path}
                        value={measureLabel(current.measure(page))}
                      />
                    ))}
                  </HoverList>
                </SquircleCardScroll>
              </motion.div>
            </AnimatePresence>
          )}
        </AnalyticsCardBody>
      </SquircleCard>

      <AnimatePresence>
        {open && (
          <TopPagesModal
            onClose={() => setOpen(false)}
            revenue={revenue}
            sort={sort}
            pages={
              resource.status === "ready"
                ? orderRows(
                    resource.data.items,
                    resource.data.meta.truncated
                  )
                : null
            }
            view={current}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/**
 * The rows as drawn: ranked by `sort` while revenue is shown, each with the
 * bar behind it (the cut's measure, then the entry page's revenue). A
 * measure that was not measured (`null`) draws no traffic segment.
 */
function rankPages(
  pages: PageRow[],
  view: (typeof VIEWS)[number],
  revenue: RowRevenue | null,
  sort: RowSort
) {
  const traffic = (page: PageRow) => view.measure(page) ?? 0;
  const revenueMinor = (page: PageRow) =>
    revenueOf(revenue, page.page_path)?.revenueMinor ?? 0;
  const ranked = sortRows(pages, revenue === null ? "visitors" : sort, {
    traffic,
    revenue: revenueMinor,
  });
  const bars = stackedBars(
    ranked.map((page) => ({
      traffic: traffic(page),
      revenue: revenue === null ? null : revenueMinor(page),
    })),
    revenue !== null && sort === "revenue" ? "revenue" : "traffic"
  );
  return ranked.map((page, index) => ({ page, bar: bars[index] ?? [] }));
}

/** The modal's two numeric cells for one row, by the cut being shown. */
function modalCells(view: PagesView, page: PageRow): [string, string] {
  if (view === "entries") {
    return [measureLabel(page.entrances), rateLabel(page.bounce_rate)];
  }
  if (view === "exits") {
    return [measureLabel(page.exits), measureLabel(page.views)];
  }
  return [
    page.views.toLocaleString("en-US"),
    page.visitors.toLocaleString("en-US"),
  ];
}

const MODAL_SUBTITLE: Record<PagesView, string> = {
  pages: "Every page your visitors opened",
  entries: "Where visits began, and how many left from there",
  exits: "The last page of each visit",
};

function TopPagesModal({
  pages,
  view,
  revenue,
  sort,
  onClose,
}: {
  pages: PageRow[] | null;
  view: (typeof VIEWS)[number];
  /** The card's entry-page revenue, when it shows any: a Revenue column. */
  revenue: RowRevenue | null;
  /** The card's order, so the modal continues the list the card began. */
  sort: RowSort;
  onClose: () => void;
}) {
  const intervalLabel = useIntervalLabel();
  const columns = seeAllColumns(view.id, revenue !== null);
  return (
    <SeeAllModal
      title={view.label}
      subtitle={`${MODAL_SUBTITLE[view.id]} · ${intervalLabel}`}
      onClose={onClose}
    >
      {pages === null ? (
        <SeeAllSkeleton />
      ) : (
        <div>
          <div className="flex items-center justify-between gap-4 px-3 pb-1.5">
            <span className="text-xs font-medium text-muted-foreground/70">
              Page
            </span>
            <span className="flex items-baseline gap-2">
              {columns.map((column) => (
                <span
                  className="w-14 text-right text-xs font-medium text-muted-foreground/70"
                  key={column}
                >
                  {column}
                </span>
              ))}
            </span>
          </div>
          {/* the shared white glide, rounded for the grey band */}
          <HoverList className="[&>li>span]:rounded-[10px]">
            {rankPages(pages, view, revenue, sort).map(({ page, bar }) => {
              const [first, second] = modalCells(view.id, page);
              return (
                <HoverRow
                  backdrop={<RowBar segments={bar} />}
                  key={page.page_path}
                >
                  <div className="flex items-center justify-between gap-4 px-3 py-2">
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full bg-primary/50 transition-colors group-hover:bg-primary"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {page.page_path}
                      </span>
                    </span>
                    <span className="flex items-baseline gap-2">
                      <span className="w-14 text-right text-sm tabular-nums text-foreground/80">
                        {first}
                      </span>
                      <span className="w-14 text-right text-sm tabular-nums text-foreground/70">
                        {second}
                      </span>
                      {revenue !== null ? (
                        <RevenueAmount
                          amount={rowRevenueAmount(
                            revenueOf(revenue, page.page_path),
                            revenue.currency
                          )}
                        />
                      ) : null}
                    </span>
                  </div>
                </HoverRow>
              );
            })}
          </HoverList>
        </div>
      )}
    </SeeAllModal>
  );
}
