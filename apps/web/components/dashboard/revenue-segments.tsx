"use client";

import { AnalyticsUpIcon } from "hugeicons-react";
import { AnimatePresence } from "motion/react";
import * as React from "react";
import { AnalyticsCardBody } from "@/components/dashboard/analytics-card";
import { ApiErrorPanel } from "@/components/dashboard/api-error";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { useOverviewRevenueSummary } from "@/components/dashboard/overview-revenue-summary";
import {
  SeeAllModal,
  SeeAllSkeleton,
  useIntervalLabel,
} from "@/components/dashboard/see-all-modal";
import {
  SegmentList,
  SegmentListColumns,
  SegmentsInsufficient,
  SegmentsSmallPrint,
  SegmentsTable,
  SmoothingInfo,
} from "@/components/dashboard/revenue-segments-view";
import {
  SquircleCard,
  SquircleCardScroll,
  SquircleSurface,
} from "@/components/ui/squircle-card";
import { useApiResource, type ApiResource } from "@/hooks/use-api-resource";
import { useParams } from "next/navigation";
import {
  LIVE_API,
  resolveSiteSlugCached,
  revenue,
  type AnalyticsRange,
  type RevenueSegmentsResponse,
} from "@/lib/api";
import {
  MOCK_REVENUE_SEGMENTS,
  MOCK_REVENUE_SEGMENTS_INSUFFICIENT,
} from "@/lib/mock";
import {
  SEGMENTS_FETCH_LIMIT,
  SEGMENTS_SUBTITLE,
  type SegmentSort,
} from "@/lib/revenue-segments";

/**
 * Revenue by segment: which visitors convert, and what a visit is worth.
 *
 * Segments are (entry referrer, country, device) from
 * `GET /v1/sites/{site_id}/revenue/segments`, ranked by smoothed value per
 * visitor. Two surfaces read it:
 *
 * - **"Most valuable traffic" on the overview**, the top five, for an owner
 *   whose provider is connected. It decides on the overview's one revenue
 *   summary read (`useOverviewRevenueSummary`): a non-owner's summary is a
 *   403 and a not-connected site's says so in its meta, and in both cases the
 *   card does not exist. It sits at the end of the grid, so arriving after
 *   the summary moves nothing anybody is reading.
 * - **The full table on the Revenue page**, sortable by the four numbers.
 *
 * Both fetch up to 500 segments once, the most the API returns, so the
 * table's own sorting covers every segment of all but the largest sites; a
 * cut list says it is the top 500 by value per visitor. The card shows the
 * first five and its See all opens the same rows as the table, so the two
 * never disagree.
 *
 * The read covers at most 92 days. Past that the surfaces say so instead of
 * asking, rather than painting the server's `RANGE_TOO_LARGE` as an error.
 */

const CARD_ROWS = 5;
const MAX_SPAN_MS = 92 * 86_400_000;

function spanTooLong(range: AnalyticsRange): boolean {
  return Date.parse(range.to) - Date.parse(range.from) > MAX_SPAN_MS;
}

/** Mock mode: a short range has too few sales, as a real site's would. */
function mockSegments(range: AnalyticsRange): RevenueSegmentsResponse {
  return Date.parse(range.to) - Date.parse(range.from) < 2 * 86_400_000
    ? MOCK_REVENUE_SEGMENTS_INSUFFICIENT
    : MOCK_REVENUE_SEGMENTS;
}

/** The segments of the screen's range, or nothing to ask for past 92 days. */
function useRevenueSegments(siteId: string | null): {
  resource: ApiResource<RevenueSegmentsResponse>;
  tooLong: boolean;
} {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const { range, rangePending } = useAnalyticsInterval();
  const tooLong = !rangePending && spanTooLong(range);
  const load = React.useCallback(
    async (signal: AbortSignal): Promise<RevenueSegmentsResponse> => {
      // Held, never resolved: the range is pending or past the cap, and the
      // surface draws its own sentence for the second case.
      if (rangePending || tooLong) return new Promise(() => {});
      if (!LIVE_API) return mockSegments(range);
      const id = siteId ?? (await resolveSiteSlugCached(slug)).site_id;
      return revenue.segments(id, range, {
        limit: SEGMENTS_FETCH_LIMIT,
        signal,
      });
    },
    [siteId, slug, range, rangePending, tooLong]
  );
  return { resource: useApiResource(load), tooLong };
}

const TOO_LONG_COPY =
  "Traffic is ranked over 92 days at most. Pick a shorter range to see it.";

/* Overview card ------------------------------------------------------------ */

export function MostValuableTrafficCard() {
  const { resource: summary } = useOverviewRevenueSummary();
  // Connected, or connected and failing to sync (the figures still stand).
  // Never for a site with no provider, nor for a non-owner, whose summary is
  // a 403. `null` while the summary is in flight: the last answer holds then,
  // so changing the range does not fold the card away and back.
  const decided =
    summary.status === "ready"
      ? summary.data.meta.revenue?.connection_status === "connected" ||
        summary.data.meta.revenue?.connection_status === "degraded"
      : summary.status === "error"
        ? false
        : null;
  const [shown, setShown] = React.useState(false);
  if (decided !== null && decided !== shown) setShown(decided);
  if (!(decided ?? shown)) return null;
  return <MostValuableTrafficCardBody />;
}

function MostValuableTrafficCardBody() {
  const { resource, tooLong } = useRevenueSegments(null);
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <SquircleCard
        hideSeeAll={tooLong}
        icon={<AnalyticsUpIcon aria-hidden="true" />}
        onSeeAll={() => setOpen(true)}
        title="Most valuable traffic"
        titleAside={<SmoothingInfo />}
      >
        {tooLong ? (
          <p className="flex h-full items-center px-5 text-sm leading-6 text-muted-foreground">
            {TOO_LONG_COPY}
          </p>
        ) : (
          <AnalyticsCardBody
            emptyBody="No segment had 20 visitors in this range yet."
            isEmpty={(data) => data.status === "ok" && data.segments.length === 0}
            resource={resource}
          >
            {(data) =>
              data.status === "insufficient_data" ? (
                <SegmentsInsufficient
                  className="h-full justify-center px-5"
                  data={data}
                />
              ) : (
                <SquircleCardScroll>
                  <SegmentListColumns />
                  <SegmentList
                    currency={data.currency}
                    segments={data.segments.slice(0, CARD_ROWS)}
                  />
                </SquircleCardScroll>
              )
            }
          </AnalyticsCardBody>
        )}
      </SquircleCard>

      <AnimatePresence>
        {open ? (
          <SegmentsModal onClose={() => setOpen(false)} resource={resource} />
        ) : null}
      </AnimatePresence>
    </>
  );
}

/** The card's See all: every segment the read returned, sortable. */
function SegmentsModal({
  resource,
  onClose,
}: {
  resource: ApiResource<RevenueSegmentsResponse>;
  onClose: () => void;
}) {
  const intervalLabel = useIntervalLabel();
  const [sort, setSort] = React.useState<SegmentSort>("value");
  return (
    <SeeAllModal
      onClose={onClose}
      subtitle={`${SEGMENTS_SUBTITLE} · ${intervalLabel}`}
      title="Most valuable traffic"
    >
      {resource.status === "error" ? (
        <ApiErrorPanel
          className="px-3 py-6"
          error={resource.error}
          onRetry={resource.retry}
        />
      ) : resource.status !== "ready" ? (
        <SeeAllSkeleton />
      ) : resource.data.status === "insufficient_data" ? (
        <SegmentsInsufficient className="px-3 py-6" data={resource.data} />
      ) : (
        <SegmentsBody data={resource.data} onSort={setSort} sort={sort} />
      )}
    </SeeAllModal>
  );
}

/** The table and its small print. */
function SegmentsBody({
  data,
  sort,
  onSort,
}: {
  data: RevenueSegmentsResponse;
  sort: SegmentSort;
  onSort: (sort: SegmentSort) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {data.segments.length === 0 ? (
        <p className="px-1 py-6 text-center text-sm text-muted-foreground">
          No segment had {data.thresholds.min_segment_visitors} visitors in
          this range yet.
        </p>
      ) : (
        <SegmentsTable
          currency={data.currency}
          onSort={onSort}
          segments={data.segments}
          sort={sort}
        />
      )}
      <SegmentsSmallPrint className="px-1" data={data} />
    </div>
  );
}

/* Revenue page ------------------------------------------------------------- */

export function RevenueSegments({ siteId }: { siteId: string }) {
  const { resource, tooLong } = useRevenueSegments(siteId);
  const [sort, setSort] = React.useState<SegmentSort>("value");

  return (
    <SquircleSurface
      className="flex flex-col border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
      render={<section />}
    >
      <div className="flex items-center gap-2 px-4 pb-1.5 pt-1">
        <p className="text-sm font-medium text-foreground/80">
          Most valuable traffic
        </p>
        <SmoothingInfo />
      </div>
      <SquircleSurface className="overflow-hidden rounded-[22px] border border-border bg-[#f6f6f6] px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]">
        {tooLong ? (
          <p className="px-1 py-8 text-center text-sm text-muted-foreground">
            {TOO_LONG_COPY}
          </p>
        ) : (
          <AnalyticsCardBody
            emptyBody="No payments in this range."
            isEmpty={() => false}
            resource={resource}
          >
            {(data) =>
              data.status === "insufficient_data" ? (
                <SegmentsInsufficient className="px-1 py-6" data={data} />
              ) : (
                <SegmentsBody data={data} onSort={setSort} sort={sort} />
              )
            }
          </AnalyticsCardBody>
        )}
      </SquircleSurface>
    </SquircleSurface>
  );
}
