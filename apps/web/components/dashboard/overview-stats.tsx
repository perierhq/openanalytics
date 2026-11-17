"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { ApiErrorPanel } from "@/components/dashboard/api-error";
import {
  dataStateOf,
  DataStatePanel,
  ProvenanceChips,
} from "@/components/dashboard/data-state";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import {
  posterKey,
  publishPosterRevenue,
  publishPosterSessions,
  publishPosterTotals,
} from "@/components/dashboard/overview-poster-store";
import { SquircleSurface } from "@/components/ui/squircle-card";
import { useApiResource } from "@/hooks/use-api-resource";
import { useRetainedResource } from "@/hooks/use-retained-resource";
import { useOverviewView } from "@/components/dashboard/overview-view";
import { useOverviewRevenueSummary } from "@/components/dashboard/overview-revenue-summary";
import { useOverviewSessions } from "@/components/dashboard/overview-sessions";
import {
  ComparisonLine,
  StatCard,
  StatFrame,
  type Stat,
  type StatChartControl,
  type StatComparisonValue,
} from "@/components/dashboard/stat-card";
import {
  FilteredRangePanel,
  useAnalyticsFilters,
} from "@/components/dashboard/filter-context";
import {
  getAnalyticsOverview,
  LIVE_API,
  resolveSiteSlugCached,
  type AnalyticsOverviewResponse,
} from "@/lib/api";
import { formatMoney } from "@/lib/currencies";
import { MOCK_OVERVIEW } from "@/lib/mock";
import {
  AVG_VISIT_INFO,
  BOUNCE_INFO,
  durationLabel,
  percentLabel,
  STAT_DEFINITIONS,
} from "@/lib/stat-format";
import {
  computeDelta,
  sessionTileComparison,
  tileChartControl,
  type PublishedComparison,
  type StatTile,
} from "@/lib/overview-compare";

/**
 * The overview stat row — `GET .../analytics/overview` for the counts, and
 * `GET .../analytics/sessions` for bounce rate and average visit duration.
 *
 * The `[site]` route segment is the public **slug**; it is resolved to the
 * internal `site_id` with `GET /v1/sites/resolve?slug=` rather than by matching
 * against `GET /v1/sites`. That endpoint exists for exactly this, it is one
 * request instead of pulling the whole list, it works on a deep link where no
 * list has been fetched, and a slug the caller cannot see comes back as
 * `404 SITE_NOT_FOUND` — which is the honest answer, and the same one a
 * non-member gets.
 *
 * The session numbers ride their own request on purpose: they carry the
 * `layering` block — everything after `layering.finalized_through` can still
 * change (an open session finalizes later), so those two cards say "still
 * settling" while the tail is provisional — and a failed sessions read must
 * not take the four counts down with it: the row degrades to four cards.
 */

export function OverviewStats() {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const { range, rangePending } = useAnalyticsInterval();
  const { active: filtersActive, filtersParam } = useAnalyticsFilters();
  const view = useOverviewView();
  const { compare } = view;

  const load = React.useCallback(
    async (signal: AbortSignal): Promise<AnalyticsOverviewResponse> => {
      if (!LIVE_API) return MOCK_OVERVIEW;
      // All-time's anchor is still on its way — hold, don't double-fetch.
      if (rangePending) {
        return new Promise<AnalyticsOverviewResponse>(() => {});
      }
      const { site_id } = await resolveSiteSlugCached(slug);
      return getAnalyticsOverview(site_id, range, {
        signal,
        ...(filtersParam !== undefined ? { filters: filtersParam } : {}),
        ...(compare ? { compare: true } : {}),
      });
    },
    [slug, range, rangePending, filtersParam, compare]
  );

  const asked = useApiResource(load);
  // Toggling Compare re-reads the same counts with the previous period
  // beside them: the counts in hand stay up while that read is in flight.
  const { resource: overview, refreshing } = useRetainedResource(
    asked,
    `${slug}|${range.from}|${range.to}|${range.timezone}|${filtersParam ?? ""}`
  );

  // Bounce rate and average visit, and their previous period: the reads
  // the chart shares (`OverviewSessionsProvider`).
  const sharedSessions = useOverviewSessions();
  if (sharedSessions === null) {
    throw new Error("OverviewStats needs an <OverviewSessionsProvider> above it");
  }
  const { current: sessions, previous: prevSessions } = sharedSessions;
  const comparePrevSessions = sharedSessions.comparing;

  // The comparison window, for the sessions read to ask for exactly the
  // same one: what this read answered with, for the range it was asked
  // for. Never the retained answer, which may be from before Compare.
  const comparisonPublished: PublishedComparison | null =
    !compare || asked.status === "loading"
      ? null
      : {
          forRange: range,
          window:
            asked.status === "ready"
              ? (asked.data.meta.comparison_range ?? null)
              : null,
        };

  // Rendered on every branch below, the error panels too: a sessions read
  // waiting on this window must hear that there is none.
  const publisher = comparisonPublished ? (
    <ComparisonPublisher
      publish={sharedSessions.publishComparison}
      published={comparisonPublished}
    />
  ) : null;

  if (LIVE_API && overview.status === "error") {
    return (
      <SquircleSurface className="border border-border shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
        {publisher}
        {overview.error.kind === "filtered_range" ? (
          <FilteredRangePanel className="py-10" />
        ) : (
          <ApiErrorPanel error={overview.error} onRetry={overview.retry} />
        )}
      </SquircleSurface>
    );
  }

  const data = !LIVE_API
    ? MOCK_OVERVIEW
    : overview.status === "ready"
      ? overview.data
      : null;

  // The cardinal rule cuts one way only: a pipeline that is behind or
  // unverifiable must never be mistaken for a site with no traffic — that
  // case keeps the warning panel. A *true* empty (fresh pipeline, nothing
  // recorded) is honest zeros on the normal cards.
  if (data) {
    const isEmpty = data.totals.events === 0;
    const state = dataStateOf(data.meta, isEmpty);
    if ((state.kind === "stale" || state.kind === "degraded") && isEmpty) {
      return (
        <SquircleSurface className="border border-border shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
          {publisher}
          <DataStatePanel
            className="py-14"
            emptyBody="Nothing has been rolled up for this range yet. Install the snippet, or widen the range."
            state={state}
          />
        </SquircleSurface>
      );
    }
  }

  // Session numbers ride their own read; `null` display = still in flight.
  const sessionData = sessions.status === "ready" ? sessions.data : null;
  // An error is settled: those two cards show an honest em-dash rather than
  // pulsing forever, and the four counts stay up.
  const sessionsSettled = sessions.status !== "loading";

  // The frames and their labels never wait: all five cards are knowable
  // before any request answers, so the chrome is static and only the numbers
  // come into focus — each when its own read lands. The row's height is
  // constant either way, so the chart underneath never moves by a pixel.
  // The previous period, per tile. The counts arrive with the overview
  // read itself; a mock (or a retained answer from before the toggle) can
  // carry a comparison the screen did not ask for, so `compare` gates it.
  const previousTotals = compare && data ? data.comparison?.totals : undefined;
  const countComparison = (
    key: "visitors" | "pageviews"
  ): StatComparisonValue | null | undefined => {
    if (!compare) return undefined;
    if (!data) return null;
    if (!previousTotals) return refreshing ? null : undefined;
    return {
      delta: computeDelta(data.totals[key], previousTotals[key]),
      previous: previousTotals[key].toLocaleString("en-US"),
    };
  };
  const prevSessionData =
    prevSessions.status === "ready" ? prevSessions.data : null;
  const sessionComparison = (
    tile: "bounce_rate" | "avg_visit"
  ): StatComparisonValue | null | undefined => {
    if (!comparePrevSessions) return undefined;
    // An error on either read settles to no line rather than a pulse.
    if (sessions.status === "error" || prevSessions.status === "error") {
      return undefined;
    }
    if (!sessionData || !prevSessionData) return null;
    return sessionTileComparison(tile, sessionData.totals, prevSessionData.totals);
  };

  const stats: (Stat & { tile: StatTile })[] = [
    {
      tile: "visitors",
      label: "Visitors",
      display: data ? data.totals.visitors.toLocaleString("en-US") : null,
      info: STAT_DEFINITIONS.visitors,
      comparison: countComparison("visitors"),
    },
    {
      tile: "pageviews",
      label: "Pageviews",
      display: data ? data.totals.pageviews.toLocaleString("en-US") : null,
      info: STAT_DEFINITIONS.pageviews,
      comparison: countComparison("pageviews"),
    },
    /* Under an active filter these two go dark on purpose. They ride the
       sessions read, which does not take a filter in v1, so the number in
       hand is the unfiltered site, and printing it beside filtered visitor
       counts would present two populations as one row of facts. A dash is
       not measured-zero here; it is "not measurable on this view". */
    {
      tile: "bounce_rate",
      label: "Bounce rate",
      display: filtersActive
        ? "–"
        : sessionData
          ? percentLabel(sessionData.totals.bounce_rate)
          : sessionsSettled
            ? "–"
            : null,
      info: filtersActive ? FILTERED_SESSION_INFO : BOUNCE_INFO,
      comparison: sessionComparison("bounce_rate"),
    },
    {
      tile: "avg_visit",
      label: "Avg. visit",
      display: filtersActive
        ? "–"
        : sessionData
          ? durationLabel(sessionData.totals.avg_session_duration_ms)
          : sessionsSettled
            ? "–"
            : null,
      info: filtersActive ? FILTERED_SESSION_INFO : AVG_VISIT_INFO,
      comparison: sessionComparison("avg_visit"),
    },
  ];

  /**
   * How a tile relates to the chart, on this screen: taken from what the
   * chart says it draws (`view.chart`), so a tile is pressed only while its
   * line is the one on the chart, and a button only where pressing it would
   * put one there. Revenue without bars, a session tile whose series cannot
   * be drawn (a filter, a grain it cannot fold into) are simply numbers.
   */
  const chartControl = (tile: StatTile): StatChartControl | undefined => {
    if (!view.enabled) return undefined;
    const control = tileChartControl(tile, view.chart);
    return control
      ? { ...control, onPress: () => view.pressMetric(control.metric) }
      : undefined;
  };

  return (
    <div className="flex flex-col gap-2">
      {/* What this row shows, for the poster: the same totals, and the
          bounce figure exactly as the tile would print it (null where the
          tile shows a dash). */}
      {publisher}
      <PosterStatsPublisher
        bounceRate={
          filtersActive || !sessionData ? null : sessionData.totals.bounce_rate
        }
        data={data}
        posterKey={posterKey(slug, range, filtersParam)}
      />
      <StatGrid>
        {stats.map((stat) => (
          <StatCard
            chart={chartControl(stat.tile)}
            key={stat.label}
            stat={stat}
          />
        ))}
        <RevenueCard chart={chartControl("revenue")} compare={compare} slug={slug} />
      </StatGrid>
      {/* Where these five numbers came from, per response. The overview is
          the first thing read on the screen, so an imported range says so
          here rather than only on the cards below. */}
      {data ? <ProvenanceChips className="self-end" meta={data.meta} /> : null}
    </div>
  );
}

/**
 * Revenue on the stat row: one figure, or the door to connecting a provider.
 *
 * It reads the same `revenue/summary` the overview panel does — one request
 * serves both: `OverviewRevenueSummaryProvider` reads it once for the page
 * (with the previous period while comparing) and both cards fold it — and
 * it takes the same rule the panel takes: a provider that is not connected
 * gets a link, never a `0`. Anything richer than the net figure (the identity
 * parts, the unconverted remainder, the degraded warning) lives on the panel,
 * which has the room for it.
 *
 * No owner gate here: this row is rendered by `OverviewStats`, which an admin
 * sees, and the summary read would 403 for them. A 403 lands in `error` and
 * the card falls back to the connect door, which is the honest thing to show
 * someone who cannot read the number — the alternative is an error tile in
 * the middle of a working dashboard.
 */
function RevenueCard({
  slug,
  compare,
  chart,
}: {
  slug: string;
  /** Ask for the previous period too, and print it under the figure. */
  compare: boolean;
  chart: StatChartControl | undefined;
}) {
  // While Compare toggles, the figure in hand stays up (`refreshing`) and
  // only the comparison line waits.
  const { resource: summary, refreshing } = useOverviewRevenueSummary();
  // Settled covers error too: a 403 (admin, `revenue:read` is owner-only)
  // resolves to the connect door, not to a pulse that never ends.
  const settled = summary.status !== "loading";
  const totals = summary.status === "ready" ? summary.data.totals : null;
  const status =
    summary.status === "ready"
      ? (summary.data.meta.revenue?.connection_status ?? "not_connected")
      : null;
  const connected = totals !== null && status !== "not_connected";

  // For the poster, once this tile has settled: the net figure it prints,
  // or null where it shows the connect door. Keyed without filters, as the
  // read itself is.
  const { range } = useAnalyticsInterval();
  const key = posterKey(slug, range);
  const netMinor = connected && totals ? totals.net_minor : null;
  const currency = connected && totals ? totals.currency : null;
  React.useEffect(() => {
    if (!settled) return;
    publishPosterRevenue({ key, netMinor, currency });
  }, [key, settled, netMinor, currency]);

  // The previous period's net, while comparing. Two currencies have no
  // honest percentage between them (the reporting currency changed), so
  // that case prints the previous figure with a dash for the change.
  const previousTotals =
    compare && connected && summary.status === "ready"
      ? summary.data.comparison?.totals
      : undefined;
  const comparison: StatComparisonValue | null | undefined = !compare
    ? undefined
    : !settled || (refreshing && !previousTotals)
      ? null
      : totals && previousTotals
        ? {
            delta: computeDelta(
              totals.net_minor,
              previousTotals.currency === totals.currency
                ? previousTotals.net_minor
                : Number.NaN
            ),
            previous: formatMoney(previousTotals.net_minor, previousTotals.currency),
          }
        : undefined;

  return (
    <StatFrame chart={chart} info={STAT_DEFINITIONS.revenue} label="Revenue">
      <SkeletonReveal
        ready={settled}
        skeleton={
          <p className="flex h-7 items-center sm:h-8">
            <span className="h-5 w-16 rounded bg-muted-foreground/15 sm:h-6" />
          </p>
        }
      >
        {!settled ? null : connected && totals ? (
          <p className="text-xl font-medium tabular-nums tracking-tight sm:text-2xl">
            {formatMoney(totals.net_minor, totals.currency)}
          </p>
        ) : (
          // Above the tile's chart button, so the door stays a door.
          <span className="pointer-events-auto relative z-[2] inline-flex">
            <Button
              render={
                <Link
                  href={`/dashboard/${encodeURIComponent(slug)}/settings?tab=integrations`}
                >
                  Connect
                </Link>
              }
              size="xs"
              variant="link"
            />
          </span>
        )}
      </SkeletonReveal>
      <ComparisonLine comparison={settled && !connected ? undefined : comparison} />
    </StatFrame>
  );
}

/** Why the two session tiles are dashes while a filter is on. */
const FILTERED_SESSION_INFO =
  "Session metrics cannot be filtered yet, so this tile pauses while filters are active rather than showing the whole site's number next to filtered ones.";


function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{children}</div>
  );
}

/**
 * Tells the sessions read which window this overview read compared against
 * (`meta.comparison_range`), so the session tiles' previous period is the
 * server's own. A component for `PosterStatsPublisher`'s reason: it has to
 * render on the branches that return early.
 */
function ComparisonPublisher({
  published,
  publish,
}: {
  published: PublishedComparison;
  publish: (published: PublishedComparison) => void;
}) {
  React.useEffect(() => {
    publish(published);
  }, [published, publish]);
  return null;
}

/**
 * Publishes the stat row's numbers to the overview poster store. Rendered
 * inside the row's normal branch only, so an error panel or a stale empty
 * publishes nothing and the Share button stays off for that range.
 */
function PosterStatsPublisher({
  posterKey: key,
  data,
  bounceRate,
}: {
  posterKey: string;
  data: AnalyticsOverviewResponse | null;
  bounceRate: number | null;
}) {
  React.useEffect(() => {
    if (!data) return;
    const state = dataStateOf(data.meta, data.totals.events === 0);
    publishPosterTotals({
      key,
      visitors: data.totals.visitors,
      pageviews: data.totals.pageviews,
      state: state.kind,
    });
  }, [key, data]);
  React.useEffect(() => {
    publishPosterSessions({ key, bounceRate });
  }, [key, bounceRate]);
  return null;
}
