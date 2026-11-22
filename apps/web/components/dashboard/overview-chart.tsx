"use client";

import { useParams } from "next/navigation";
import * as React from "react";
import { ApiErrorPanel } from "@/components/dashboard/api-error";
import {
  FilteredRangePanel,
  useAnalyticsFilters,
} from "@/components/dashboard/filter-context";
import {
  dataStateOf,
  DataStatePanel,
  ProvenanceChips,
} from "@/components/dashboard/data-state";
import {
  useAnalyticsInterval,
  type IntervalKey,
} from "@/components/dashboard/interval-context";
import {
  posterKey,
  publishPosterSeries,
} from "@/components/dashboard/overview-poster-store";
import {
  OverviewMarkers,
  OverviewMarkersLegend,
  useHiddenChartLayers,
  useOverviewMarkers,
} from "@/components/dashboard/chart-markers";
import {
  RevenueAxis,
  RevenueBars,
  useOverviewRevenue,
} from "@/components/dashboard/chart-revenue";
import {
  AVG_VISIT_COLOR,
  BOUNCE_RATE_COLOR,
  OverviewTooltipContent,
  PAGEVIEWS_COLOR,
  VISITORS_COLOR,
  type TrafficSeries,
} from "@/components/dashboard/overview-chart-tooltip";
import { ChartValueAxis } from "@/components/dashboard/chart-value-axis";
import { useOverviewSessions } from "@/components/dashboard/overview-sessions";
import { useOverviewView } from "@/components/dashboard/overview-view";
import { useSiteSummary } from "@/components/dashboard/site-summary-context";
import { Area, AreaChart } from "@/components/charts/area-chart";
import { Background } from "@/components/charts/background";
import { ChartTooltip } from "@/components/charts/tooltip";
import { XAxis } from "@/components/charts/x-axis";
import { useApiResource } from "@/hooks/use-api-resource";
import { useRetainedResource } from "@/hooks/use-retained-resource";
import { PREVIOUS_LINE_PROPS, previousFields } from "@/components/dashboard/chart-previous";
import {
  getAnalyticsTimeseries,
  LIVE_API,
  resolveSiteSlugCached,
  type AnalyticsMeta,
  type AnalyticsTimeseriesResponse,
  type PublicTimeseriesResponse,
} from "@/lib/api";
import {
  bucketRevenue,
  revenueLayers,
  type ChartGrain,
} from "@/lib/chart-revenue";
import {
  alignPrevious,
  fillDailyZeros,
  fillFixedZeros,
  fillPreviousGrid,
  fillWeeklyZeros,
  type PlotPoint,
} from "@/lib/chart-fill";
import { rightAxisMargin } from "@/lib/chart-axis";
import { chartWindow } from "@/lib/chart-window";
import {
  effectiveChartMetric,
  isRevenueChartable,
  isSessionMetric,
  type ChartDrawState,
  type SessionChartMetric,
} from "@/lib/overview-compare";
import {
  bucketSessions,
  sessionGrainFits,
  type SessionBucket,
} from "@/lib/session-buckets";
import { durationLabel, percentLabel } from "@/lib/stat-format";
import { bucketMarkers } from "@/lib/event-markers";
import { markerAnchorKey } from "@/lib/marker-placement";
import { OVERVIEW_SERIES } from "@/lib/overview-series";
import { rankMentionAuthors, rankSaleVisitors } from "@/lib/marker-faces";
import { relativeBucketLabel } from "@/lib/relative-bucket-label";

/**
 * Both callers' series in one type: the dashboard's read and the share
 * page's. Same points, same comparison shape — only the meta differs, and
 * only by the public one not carrying `freshness` (D-213).
 */
type ChartTimeseriesResponse =
  | AnalyticsTimeseriesResponse
  | PublicTimeseriesResponse;

/** The series and the browser's clock at the moment it arrived. */
type StampedSeries = {
  series: ChartTimeseriesResponse;
  receivedAtMs: number;
};

/**
 * The meta's freshness, if this meta is the kind that has one. A plain
 * accessor instead of an `in`-check because narrowing `in` across the union
 * types the absent arm's member as `unknown`; the optional parameter shape
 * (with `accuracy` as the weak-type overlap, same as `dataStateOf`) reads it
 * cleanly and without a cast.
 */
function freshnessOf(meta: {
  freshness?: AnalyticsMeta["freshness"];
  accuracy?: AnalyticsMeta["accuracy"];
}): AnalyticsMeta["freshness"] | undefined {
  return meta.freshness;
}

/** Deterministic 30-day mock series (no randomness → SSR-safe). */
function noise(i: number): number {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const DAY_MS = 86_400_000;
const START = new Date("2026-06-20T00:00:00Z").getTime();

const MOCK_DATA = Array.from({ length: 30 }, (_, i) => {
  const trend = 1450 + i * 42;
  const weekly = 380 * Math.sin((2 * Math.PI * i) / 7 - 0.6);
  const jitter = (noise(i) - 0.5) * 420;
  const spike = i === 21 ? 900 : i === 22 ? 420 : 0;
  const visitors = Math.max(200, Math.round(trend + weekly + jitter + spike));
  // Pageviews track visitors at ~2.2 pages/visit with their own drift
  const perVisit = 2.2 + (noise(i + 100) - 0.5) * 0.5;
  return {
    date: new Date(START + i * DAY_MS),
    visitors,
    pageviews: Math.round(visitors * perVisit),
  };
});

const MOCK_RESPONSE: AnalyticsTimeseriesResponse = {
  meta: {
    requested_range: {
      from: new Date(START).toISOString(),
      to: new Date(START + 30 * DAY_MS).toISOString(),
    },
    effective_range: {
      from: new Date(START).toISOString(),
      to: new Date(START + 30 * DAY_MS).toISOString(),
    },
    timezone: "UTC",
    resolution: "day",
    accuracy: "exact",
    data_sources: ["live"],
    freshness: {
      state: "ok",
      watermark: new Date(START + 29 * DAY_MS).toISOString(),
      as_of: new Date(START + 30 * DAY_MS).toISOString(),
    },
    comparison_range: null,
    truncated: false,
    cached: false,
    partial: false,
  },
  series: MOCK_DATA.map((point) => ({
    bucket: point.date.toISOString(),
    events: point.pageviews,
    pageviews: point.pageviews,
    visitors: point.visitors,
  })),
  comparison: null,
};

/** The 30 days before the mock range, a little quieter: what Compare draws
 * in mock mode. */
const MOCK_COMPARED: AnalyticsTimeseriesResponse = {
  ...MOCK_RESPONSE,
  meta: {
    ...MOCK_RESPONSE.meta,
    comparison_range: {
      from: new Date(START - 30 * DAY_MS).toISOString(),
      to: new Date(START).toISOString(),
    },
  },
  comparison: {
    series: MOCK_DATA.map((point, i) => {
      const visitors = Math.round(point.visitors * (0.78 + noise(i + 200) * 0.22));
      return {
        bucket: new Date(point.date.getTime() - 30 * DAY_MS).toISOString(),
        events: Math.round(visitors * 2.1),
        pageviews: Math.round(visitors * 2.1),
        visitors,
      };
    }),
  },
};

const VISITORS = VISITORS_COLOR;
const PAGEVIEWS = PAGEVIEWS_COLOR;

/** A session metric as the chart draws it: its line, its axis, its words. */
const SESSION_SERIES: Record<
  SessionChartMetric,
  {
    label: string;
    color: string;
    format: (value: number) => string;
    pick: (bucket: SessionBucket) => number | null;
  }
> = {
  bounce_rate: {
    label: "Bounce rate",
    color: BOUNCE_RATE_COLOR,
    format: percentLabel,
    pick: (bucket) => bucket.bounceRate,
  },
  avg_visit: {
    label: "Avg. visit",
    color: AVG_VISIT_COLOR,
    format: durationLabel,
    pick: (bucket) => bucket.avgDurationMs,
  },
};
/** The previous period's pageviews beside visitors: the slate, fainter,
 * as the pageviews area is the quieter of the two. */
const PAGEVIEWS_PREVIOUS_FAINT = `color-mix(in srgb, ${PAGEVIEWS_COLOR} 60%, transparent)`;

/** Scrubbing: the series right of the hovered bucket fade to this. */
const SCRUB_DIM_OPACITY = 0.3;

const PLOT_HEIGHT = "h-[344px] w-full sm:h-[376px]";

/**
 * Label formats, built in the request's zone. The contract's rule: a bucket
 * label is a UTC instant, rendered in the **request's** timezone — never the
 * browser's. The two agree on the private dashboard whenever the account
 * preference matches the machine, which is how browser-local formatting
 * survived here; they split the moment a share viewer picks another zone,
 * where a New York "today" labelled itself with Istanbul clocks (07:00 to
 * 06:00) while the data was already correctly cut at New York midnight.
 *
 * Sub-day views label the axis with the 24-hour clock; multi-day views
 * narrate dates on the axis and the exact bucket in the tooltip.
 */
function labelFormats(timeZone?: string) {
  const zone = timeZone ? ({ timeZone } as const) : {};
  return {
    /** "15:00" — the sub-day axis and the today/yesterday tooltip. */
    time: new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...zone,
    }),
    /** "Thu, Aug 7, 15:00" — the rolling-24h tooltip, which spans two days. */
    timeTitle: new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...zone,
    }),
    /** "Jul 27" — the daily/weekly axis, and the week tooltip's date part. */
    shortDate: new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      ...zone,
    }),
    /** "Sun, Jul 27" — the daily tooltip (the chart lib's default shape). */
    weekdayDate: new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      ...zone,
    }),
  };
}

/** Intervals displayed at a sub-day grain — the pre-response guess, so
 * labels do not flip format when the data lands. */
const SUB_DAY_INTERVALS: ReadonlySet<IntervalKey> = new Set([
  "today",
  "yesterday",
  "24h",
]);
/** Long views read best as ISO weeks — served server-side with true weekly
 * uniques (summing seven daily numbers would overcount return visitors). */
const WEEK_INTERVALS: ReadonlySet<IntervalKey> = new Set(["6mo", "12mo"]);

/** The grain each view asks for via `?resolution=` — explicit, so display
 * and data always agree instead of guessing the server's span heuristic.
 * "All time" follows its actual span: days while the site is young, weeks
 * once the range outgrows a quarter. Exported because the public share
 * board sends the same grain through its own loader (ADR-0039 D8) — one
 * choice, two callers, so both boards draw the same chart on every
 * interval. */
export function resolutionForInterval(
  interval: IntervalKey,
  spanMs: number
): "hour" | "day" | "week" {
  if (SUB_DAY_INTERVALS.has(interval)) return "hour";
  if (WEEK_INTERVALS.has(interval)) return "week";
  if (interval === "all") return spanMs > 92 * DAY_MS ? "week" : "day";
  return "day";
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Small screens breathe with fewer clock ticks: every 6 hours instead of
 * every 3. An external store so render never touches `matchMedia` itself. */
const MOBILE_QUERY = "(max-width: 639px)";
const subscribeMobile = (onChange: () => void) => {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const readMobile = () => window.matchMedia(MOBILE_QUERY).matches;
const readMobileServer = () => false;

/**
 * The traffic chart, fed by `GET /v1/sites/{site_id}/analytics/timeseries`
 * over the screen's shared interval. The served grain is the backend's choice
 * (minute/hour/day by span); the buckets are plotted as they arrive.
 *
 * A client-side re-bucketer (`toViewGrain`) used to live here for the public
 * share surface, which could not be asked for a grain and answered `minute`
 * for every short span. Summing minute buckets into hours over-counted
 * `visitors` — a person active across N buckets counted N times, measured at
 * **+59 % on a live share** — so when ADR-0039 D8 gave the public endpoint the
 * same `?resolution=` the private one has, the re-bucketer was deleted, not
 * kept as a fallback. If a served grain ever disagrees with the ask again,
 * the fix is on the server; re-adding the summing here would be re-adding the
 * over-count.
 */

export function OverviewChart({
  load: loadOverride,
  foldOnError = false,
}: {
  /**
   * Where the series comes from. The dashboard omits it and the chart
   * resolves the route's slug; the public share board injects its own reader,
   * because a share link has no site slug to resolve and no session to
   * resolve it with. Everything below the fetch — the grain choice, the phase
   * machine, the reveal — is identical either way, which is the point: one
   * chart, two callers, no second implementation to keep in step.
   */
  load?: (signal: AbortSignal) => Promise<ChartTimeseriesResponse>;
  /**
   * Public board: a surface the owner did not share answers 404, and that is
   * an absence rather than a fault. Folding beats an error panel telling a
   * visitor about someone else's sharing settings.
   */
  foldOnError?: boolean;
} = {}) {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const { range, interval, rangePending } = useAnalyticsInterval();
  const { filtersParam, active: filtersActive } = useAnalyticsFilters();
  // Bounce rate and average visit over time: the sessions reads the stat
  // tiles already make, shared. `null` on the share board.
  const sharedSessions = useOverviewSessions();
  // Compare and the pressed tile: the dashboard's only. The share board
  // renders this chart without the provider and gets neither (its reads
  // refuse `compare`).
  const view = useOverviewView();
  const compare = view.enabled && loadOverride === undefined && view.compare;
  const { setChart } = view;
  // The right-hand axis's widest label, measured where it is drawn: the
  // plot gives up that much room on the right so no label is cut or sits
  // over the series (`rightAxisMargin`).
  const [rightAxisPx, setRightAxisPx] = React.useState<number | null>(null);
  const reportRightAxis = React.useCallback(
    (px: number) => setRightAxisPx((current) => (current === px ? current : px)),
    []
  );
  const siteRole = useSiteSummary().site?.role ?? null;
  // Every label on this chart renders in the zone the data was cut in. An
  // unrecognized zone name falls back to the browser's rendering rather
  // than crashing the chart over a label.
  const fmt = React.useMemo(() => {
    try {
      return labelFormats(range.timezone);
    } catch {
      return labelFormats();
    }
  }, [range.timezone]);
  const isMobile = React.useSyncExternalStore(
    subscribeMobile,
    readMobile,
    readMobileServer
  );

  const loadFromSlug = React.useCallback(
    async (signal: AbortSignal): Promise<AnalyticsTimeseriesResponse> => {
      if (!LIVE_API) return compare ? MOCK_COMPARED : MOCK_RESPONSE;
      // All-time's anchor is still on its way — hold, don't double-fetch.
      if (rangePending) {
        return new Promise<AnalyticsTimeseriesResponse>(() => {});
      }
      const { site_id } = await resolveSiteSlugCached(slug);
      // `?resolution=` picks the display grain outright: hour for the day
      // views, day for the week/month views, ISO week for 6/12 months —
      // weekly uniques are merged server-side, which no client-side summing
      // of days could reproduce. Named for every zone: the reads compose
      // from a fifteen-minute atom, so +05:30 and +05:45 serve a named grain
      // like any other offset. This used to fall back to the server's
      // span-based choice for those.
      const spanMs = Date.parse(range.to) - Date.parse(range.from);
      return getAnalyticsTimeseries(site_id, range, {
        signal,
        resolution: resolutionForInterval(interval, spanMs),
        ...(filtersParam !== undefined ? { filters: filtersParam } : {}),
        ...(compare ? { compare: true } : {}),
      });
    },
    [slug, range, interval, rangePending, filtersParam, compare]
  );

  // Stamped with the browser's clock when it lands: a share board's meta has
  // no `as_of`, and its relative labels need a "now" that render never reads.
  const loadSeries = loadOverride ?? loadFromSlug;
  const loadStamped = React.useCallback(
    async (signal: AbortSignal): Promise<StampedSeries> => ({
      series: await loadSeries(signal),
      receivedAtMs: Date.now(),
    }),
    [loadSeries]
  );
  const asked = useApiResource<StampedSeries>(loadStamped);
  // Toggling Compare re-reads the same series with the previous period
  // beside it: the current lines stay drawn while that read is in flight,
  // and the dashed lines join them when it lands.
  const { resource } = useRetainedResource(
    asked,
    `${slug}|${range.from}|${range.to}|${range.timezone}|${interval}|${filtersParam ?? ""}`
  );

  // Sales, mentions and notes on the timeline: the dashboard's chart only. A
  // share board has no member and no business showing any of them.
  const { items: markers, noteActions } = useOverviewMarkers(
    range,
    rangePending || loadOverride !== undefined
  );

  // Revenue bars, the same way and for the same members as the sale markers.
  // Asked at the grain the chart asks for, so the read runs beside the
  // traffic read instead of after it; mock mode plots a fixed daily series.
  const askedGrain: ChartGrain = LIVE_API
    ? resolutionForInterval(
        interval,
        Date.parse(range.to) - Date.parse(range.from)
      )
    : "day";
  const { points: revenuePoints, settled: revenueSettled } = useOverviewRevenue(
    range,
    askedGrain,
    rangePending || loadOverride !== undefined
  );
  const [hiddenLayers] = useHiddenChartLayers();

  const response = resource.status === "ready" ? resource.data.series : null;
  const receivedAtMs =
    resource.status === "ready" ? resource.data.receivedAtMs : Number.NaN;
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  const askedResolution = resolutionForInterval(interval, toMs - fromMs);
  /**
   * The grain the answer actually carries — not the one we asked for.
   *
   * When `resolution` is sent the server either honours it or refuses the
   * whole read, so the two agree. But a sub-hour-offset zone (Kathmandu)
   * refuses every named grain, and there both boards fall back to the
   * server's own span-based choice — which can differ from the ask, and a
   * grid zero-filled by the hour over day buckets is a chart lying about
   * its own shape. `meta.resolution` is the truth either way.
   *
   * Falls back to the ask only while the response is still in flight, which
   * is what the whole component did before this line existed.
   */
  const resolution =
    response?.meta.resolution ?? (LIVE_API ? askedResolution : "day");
  // Where the buckets end and what "now" is, from the meta: the zero-fill,
  // the revenue and marker layers and the relative pill all read this one.
  const plotWindow = React.useMemo(
    () =>
      response
        ? chartWindow({
            asOf: freshnessOf(response.meta)?.as_of,
            effectiveTo: response.meta.effective_range.to,
            toMs,
            nowMs: receivedAtMs,
          })
        : null,
    [response, receivedAtMs, toMs]
  );

  // "Yesterday", "3 hours ago": relative to the moment the data was read at,
  // in the request's zone, for the pill that follows the cursor.
  const readAtMs = plotWindow?.readAtMs ?? Number.NaN;
  const pillGrain: ChartGrain =
    resolution === "minute" || resolution === "hour" || resolution === "week"
      ? resolution
      : "day";
  const formatPill = React.useCallback(
    (date: Date) =>
      relativeBucketLabel(date.getTime(), readAtMs, pillGrain, range.timezone),
    [readAtMs, pillGrain, range.timezone]
  );
  const datePillFormat = Number.isNaN(readAtMs) ? undefined : formatPill;

  if (resource.status === "error") {
    if (foldOnError) return null;
    return (
      <div className={`flex items-center justify-center ${PLOT_HEIGHT}`}>
        {resource.error.kind === "filtered_range" ? (
          <FilteredRangePanel />
        ) : (
          <ApiErrorPanel error={resource.error} onRetry={resource.retry} />
        )}
      </div>
    );
  }

  // `minute` joins `hour` as a sub-day view: both label the axis with clock
  // times and share every layout rule. They differ only in stride, which is
  // what `bucketMs` carries. Neither board asks for minute — it only arrives
  // via the sub-hour-zone fallback above, on short spans.
  const subDayView =
    LIVE_API && (resolution === "hour" || resolution === "minute");
  const weekView = LIVE_API && resolution === "week";
  const dailyView = LIVE_API && resolution === "day";
  const bucketMs = resolution === "minute" ? MINUTE_MS : HOUR_MS;
  // Buckets sit on whole grain boundaries; the rolling "last 24 hours" window
  // starts on an arbitrary minute. The zero-fill *grid* starts on that
  // boundary so its slots line up with the served buckets — a display
  // alignment, not a data trim.
  const gridFromMs = subDayView
    ? Math.floor(fromMs / bucketMs) * bucketMs
    : fromMs;

  // Buckets are plotted exactly as served — labels are true UTC instants now,
  // and any client-side trimming or range-filtering would be the bug.
  const series = response?.series ?? [];
  const isEmpty =
    response !== null &&
    series.every((point) => point.events === 0 && point.visitors === 0);
  const state = response ? dataStateOf(response.meta, isEmpty) : null;

  // The cardinal rule: a flatline the pipeline cannot vouch for is not "no
  // traffic", and true silence gets words, not an empty plot.
  if (response && state && isEmpty) {
    // A minute or hour chart has no imported branch — an aggregate-only
    // export carries no sub-day grain — but it still applies the cutover, so
    // a range reaching below it answers the part it can know and flags itself
    // `estimated`. That is a window that was narrowed, not a quiet site, and
    // the words have to say which (frontend_tasks §22).
    const subDayBelowCutover =
      subDayView && response.meta.accuracy === "estimated";
    return (
      <div className={`flex items-center justify-center ${PLOT_HEIGHT}`}>
        <DataStatePanel
          emptyBody={
            subDayBelowCutover
              ? "There is no hour-level history before the import cutover: imported days carry daily totals only. Switch to a daily view to see them."
              : "No traffic in this range yet. Once visits come in, the chart draws itself."
          }
          state={state.kind === "ok" ? { kind: "empty" } : state}
        />
      </div>
    );
  }

  let data: PlotPoint[] = series.map((point) => ({
    date: new Date(point.bucket),
    visitors: point.visitors,
    pageviews: point.pageviews,
  }));

  // Zero-fill the elapsed part of the window on the display grid — hourly
  // for day views, daily for week/month views — capped at the server's
  // `as_of` so the future stays absent. A young site's long ranges read as
  // flat zero until the day the tracker went live, then the real line.
  if (plotWindow) {
    const { untilMs } = plotWindow;
    const hadSignal = data.some(
      (point) => point.visitors > 0 || point.pageviews > 0
    );
    // Days and weeks are the request zone's, never the browser's.
    const filled = subDayView
      ? fillFixedZeros(data, gridFromMs, untilMs, bucketMs)
      : weekView
        ? fillWeeklyZeros(data, fromMs, untilMs, range.timezone)
        : dailyView
          ? fillDailyZeros(data, fromMs, untilMs, range.timezone)
          : data;
    const filledIsSilent = filled.every(
      (point) => point.visitors === 0 && point.pageviews === 0
    );
    // The fill must never *erase* real data: if the served buckets sit off
    // the expected grid and every grid slot came up empty, plot the raw
    // buckets as they are rather than a fabricated flatline.
    data = hadSignal && filledIsSilent ? data : filled;
  }

  /*
   * The previous period, under the current one bucket for bucket. Its grid
   * is cut exactly like the current one, over the window the server says it
   * compared against (`meta.comparison_range`), then paired by position
   * (`alignPrevious`): bucket i of the previous window sits under bucket i
   * of this one, whatever their dates. Zero-filled for the reason the
   * current grid is: a bucket with no row was a quiet one.
   */
  const comparisonSeries = compare ? (response?.comparison?.series ?? null) : null;
  let previousPoints: (PlotPoint | null)[] | null = null;
  // The previous window's own grid and end, kept for the sessions line too.
  let previousGrid: PlotPoint[] | null = null;
  let previousEndMs = fromMs;
  if (comparisonSeries && response) {
    const prevRaw: PlotPoint[] = comparisonSeries.map((point) => ({
      date: new Date(point.bucket),
      visitors: point.visitors,
      pageviews: point.pageviews,
    }));
    const compared = response.meta.comparison_range;
    const prevFromMs = compared ? Date.parse(compared.from) : fromMs - (toMs - fromMs);
    const prevToMs = compared ? Date.parse(compared.to) : fromMs;
    // For a range still in progress the server cut the window at the point
    // the current one has reached, so this grid stops there too.
    const prevFilled = !plotWindow
      ? prevRaw
      : subDayView
        ? fillPreviousGrid(prevRaw, {
            grain: "fixed",
            fromMs: prevFromMs,
            untilMs: prevToMs,
            bucketMs,
          })
        : weekView || dailyView
          ? fillPreviousGrid(prevRaw, {
              grain: weekView ? "week" : "day",
              fromMs: prevFromMs,
              untilMs: prevToMs,
              timeZone: range.timezone,
            })
          : prevRaw;
    previousPoints = alignPrevious(data, prevFilled);
    previousGrid = prevFilled;
    previousEndMs = prevToMs;
  }

  /**
   * Axis labels follow the *view*: sub-day views put the 24-hour clock on
   * the axis, everything longer narrates dates. The tooltip narrates the
   * exact bucket — and where the calendar day is already obvious from the
   * picker, it says so in words: "Today, 15:00" beats repeating a date the
   * person just selected. The rolling 24 hours spans two days, so only
   * there does the full date stay.
   */
  // Always explicit, never the chart lib's defaults: those format in the
  // browser's zone, and this chart's zone is the request's.
  const xLabelFormat = subDayView ? fmt.time.format : fmt.shortDate.format;
  const titleFormat =
    resolution === "week"
      ? (date: Date) => `Week of ${fmt.shortDate.format(date)}`
      : resolution === "day"
        ? fmt.weekdayDate.format
        : interval === "today"
          ? (date: Date) => `Today, ${fmt.time.format(date)}`
          : interval === "yesterday"
            ? (date: Date) => `Yesterday, ${fmt.time.format(date)}`
            : fmt.timeTitle.format;

  // The previous bucket's own date, for the tooltip's Previous lines: never
  // "Today", and short, because it shares a row with a number.
  const previousLabelFormat =
    resolution === "week"
      ? (date: Date) => `Week of ${fmt.shortDate.format(date)}`
      : resolution === "day"
        ? fmt.weekdayDate.format
        : (date: Date) => `${fmt.shortDate.format(date)}, ${fmt.time.format(date)}`;

  // The axis ends on the last bucket of the window — 23:00 for a calendar
  // day, the current hour for the rolling one — never on the exclusive
  // `to`, which would conjure one bucket more than the day has.
  const domainEndMs = Math.floor((toMs - 1) / bucketMs) * bucketMs;

  // Markers and revenue share the chart's own buckets and end where they do:
  // a sale after the last traffic bucket is dropped, not folded into it.
  // (Mock mode's `as_of` ends its fixed June series, so this holds there too.)
  const layerEndMs = plotWindow?.layerEndMs ?? toMs;
  const bucketStarts = data.map((point) => point.date.getTime());
  const revenueModel = bucketRevenue(
    bucketStarts,
    layerEndMs,
    resolution === "minute" ? null : revenuePoints
  );
  const {
    bars: showRevenue,
    barsVisible: revenueVisible,
    tooltip: revenueInTooltip,
  } = revenueLayers(revenueModel, {
    enabled: loadOverride === undefined && response !== null,
    hidden: hiddenLayers.includes("revenue"),
  });

  /*
   * What the chart draws. `null` is the default: both traffic areas, the
   * revenue bars behind them, the markers. A pressed tile narrows it to one
   * traffic series, or promotes the revenue bars to the main series. A
   * linked `metric=revenue` that this reader cannot chart falls back to the
   * default rather than an empty plot.
   */
  const revenueChartable = isRevenueChartable({
    role: siteRole,
    hasBars: showRevenue,
  });
  /*
   * The sessions series can be the chart when it has been read, no filter is
   * on (the sessions read takes none), and it is served at the chart's grain
   * or finer: it folds into the chart's buckets by summing counts and
   * re-deriving the rates (`bucketSessions`), never the other way round.
   */
  const sessionsRead =
    sharedSessions?.current.status === "ready" ? sharedSessions.current.data : null;
  const sessionsChartable =
    view.enabled &&
    !filtersActive &&
    sessionsRead !== null &&
    sessionGrainFits(sessionsRead.meta.resolution, resolution);
  const metric = view.enabled
    ? effectiveChartMetric(view.metric, { revenueChartable, sessionsChartable })
    : null;
  // Asked for revenue and its read is still out: hold the skeleton rather
  // than draw traffic and swap it away a moment later.
  const holdForRevenue =
    view.enabled && view.metric === "revenue" && !revenueSettled;
  // The same for a session metric whose read is out. Not for its previous
  // period: that read waits on the overview's comparison window, and the
  // current line is drawn meanwhile, its dashed partner joining it later.
  const holdForSessions =
    view.enabled &&
    isSessionMetric(view.metric) &&
    !filtersActive &&
    sharedSessions !== null &&
    sharedSessions.current.status === "loading";
  const sessionMetric = isSessionMetric(metric) ? metric : null;
  const sessionSeries = sessionMetric ? SESSION_SERIES[sessionMetric] : null;
  const sessionBuckets =
    sessionMetric && sessionsRead
      ? bucketSessions(bucketStarts, layerEndMs, sessionsRead.series)
      : null;
  // The previous period's sessions on the previous window's grid, then
  // under the current buckets by position, as the traffic lines are.
  const previousSessionsRead =
    sharedSessions?.previous.status === "ready" ? sharedSessions.previous.data : null;
  const previousSessionBuckets =
    sessionMetric && previousSessionsRead && previousGrid
      ? alignPrevious(
          data,
          bucketSessions(
            previousGrid.map((point) => point.date.getTime()),
            previousEndMs,
            previousSessionsRead.series
          )
        )
      : null;
  const previousSessionStarts =
    previousSessionBuckets && previousGrid
      ? alignPrevious(data, previousGrid).map((point) => point?.date.getTime() ?? null)
      : null;
  const revenueMain = metric === "revenue";
  const trafficSeries: readonly TrafficSeries[] =
    metric === "visitors"
      ? ["visitors"]
      : metric === "pageviews"
        ? ["pageviews"]
        : revenueMain || sessionMetric
          ? []
          : ["visitors", "pageviews"];
  // Revenue and the markers are never compared: only traffic has a
  // previous line.
  const comparing = previousPoints !== null && !revenueMain && !sessionMetric;
  const sessionComparing = previousSessionBuckets !== null;
  // Every mode with labels on the right: a session metric's values, revenue
  // as the main series, or the revenue bars' own axis beside the traffic.
  const rightAxisDrawn =
    sessionSeries !== null ||
    revenueMain ||
    (showRevenue && metric === null && revenueVisible);

  const chartData = data.map((point, index) => {
    const previous = comparing ? (previousPoints?.[index] ?? null) : null;
    const bucket = revenueMain ? revenueModel.buckets.get(point.date.getTime()) : undefined;
    const session = sessionBuckets?.[index];
    const sessionValue = session && sessionSeries ? sessionSeries.pick(session) : null;
    const previousSession = previousSessionBuckets?.[index];
    const previousSessionValue =
      previousSession && sessionSeries ? sessionSeries.pick(previousSession) : null;
    const previousSessionAt = previousSessionStarts?.[index] ?? null;
    return {
      ...point,
      // A bucket without sessions carries no value, and the line breaks
      // there (`gapsForMissing`) rather than claiming 0%.
      ...(sessionValue !== null ? { [OVERVIEW_SERIES.session]: sessionValue } : {}),
      ...(previousSessionValue !== null ? { prevSession: previousSessionValue } : {}),
      ...(previousSessionAt !== null ? { prevSessionAtMs: previousSessionAt } : {}),
      // No counterpart, no keys: the dashed line breaks there.
      ...previousFields(previous),
      // What the bars draw, so the primary axis is sized to them: a net bar
      // with its refund outline on top.
      ...(revenueMain
        ? {
            [OVERVIEW_SERIES.revenueTop]: bucket
              ? Math.max(0, bucket.netMinor) + Math.max(0, bucket.refundMinor)
              : 0,
          }
        : {}),
    };
  });
  const markerBuckets = new Map(
    bucketMarkers(
      bucketStarts,
      layerEndMs,
      markers.filter((item) => !hiddenLayers.includes(item.kind)),
      ["sale", "mention", "note"]
    ).map((bucket) => [
      bucket.startMs,
      {
        counts: bucket.counts,
        // The tooltip's small buyer faces: distinct anonymous ids, newest sale
        // first, like the marker's own face.
        saleVisitors: rankSaleVisitors(
          (bucket.byKind.sale ?? []).flatMap((item) =>
            item.payload.kind === "sale" ? [item.payload.sale] : []
          ),
          { limit: 3 }
        ),
        // The tooltip's small faces: distinct authors with a picture, ranked
        // like the marker's own face.
        mentionAuthors: rankMentionAuthors(
          (bucket.byKind.mention ?? []).flatMap((item) =>
            item.payload.kind === "mention" ? [item.payload.mention] : []
          ),
          { limit: 3, withPicture: true }
        ),
      },
    ])
  );

  // Clock axes tick on round hours — every third on desktop, every sixth on
  // a phone: the library's interpolated ticks land on times like 20:20,
  // which no clock axis should ever say. The tooltip still narrates every
  // single bucket.
  const tickStepMs = (isMobile ? 6 : 3) * HOUR_MS;
  const tickDates: Date[] | undefined = subDayView ? [] : undefined;
  if (tickDates) {
    for (let t = gridFromMs; t <= domainEndMs; t += tickStepMs) {
      tickDates.push(new Date(t));
    }
  }

  return (
    <div className="relative">
      {/* What was plotted, for the poster: the zero-filled series exactly as
          drawn, never the raw response. Dashboard only; the share board has
          no slug and no Share button. */}
      {loadOverride === undefined && response ? (
        <PosterSeriesPublisher
          points={data}
          posterKey={posterKey(slug, range, filtersParam)}
        />
      ) : null}
      {/* Above the plot rather than inside it: the chart fills its card
          edge-to-edge, and a chip laid over the series would sit on data. */}
      {/* What this chart draws, for the tiles: pressed is the drawn
          metric's tile, and only what it can draw is a button. Not while it
          is still finding out (a read in flight, or holding for one). */}
      {loadOverride === undefined && view.enabled ? (
        <ChartStatePublisher
          publish={setChart}
          settled={response !== null && !holdForRevenue && !holdForSessions}
          state={{ drawn: metric, revenueChartable, sessionsChartable }}
        />
      ) : null}
      {/* Top-left, mirroring the provenance chips: the legend only exists
          when the range has markers (or the member may add a note), and hides
          any kind for this browser. */}
      {loadOverride === undefined && response ? (
        <OverviewMarkersLegend
          className="absolute left-3 top-0 z-10"
          items={markers}
          noteActions={noteActions}
          // Only beside traffic can the bars be hidden: as the main series
          // they are the chart, and a single traffic series draws none.
          revenue={showRevenue && metric === null}
        />
      ) : null}
      {response ? (
        <ProvenanceChips
          className="absolute right-0 top-0 z-10"
          meta={response.meta}
        />
      ) : null}
      <AreaChart
      // While loading the chart draws its own skeleton (empty data +
      // status="loading"). The handoff is a relay with no dead air: the
      // sweep line plays its exit, then the series wipes in left-to-right
      // (the clip reveal only runs when animationDuration > 0). The
      // y-domain tween is zeroed deliberately — it used to run between
      // those two moments on a plot with nothing drawn on it, which read
      // as the chart blinking out after the skeleton.
      data={chartData}
      status={
        resource.status === "loading" || holdForRevenue || holdForSessions
          ? "loading"
          : "ready"
      }
      aspectRatio="auto"
      animationDuration={500}
      yDomainTweenDuration={0}
      enterTransition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1] }}
      // Zero side margins: the plot fills the card edge-to-edge. The x-axis
      // labels clamp themselves inside the plot (see XAxisLabel) so they never
      // spill past the card even though the chart itself is flush. A right
      // axis (a session metric's values, the revenue bars' money) gets its
      // own room instead of being laid over the series' right end.
      margin={{
        top: 12,
        right: rightAxisMargin(rightAxisDrawn, rightAxisPx),
        bottom: 24,
        left: 0,
      }}
      className={PLOT_HEIGHT}
      scrubDimOpacity={SCRUB_DIM_OPACITY}
      xLabelFormat={xLabelFormat}
      xDomain={
        subDayView
          ? [new Date(gridFromMs), new Date(domainEndMs)]
          : undefined
      }
    >
      <Background pattern="dots" opacity={0.4} />
      {revenueMain ? (
        <RevenueAxis
          model={revenueModel}
          onWidth={reportRightAxis}
          placement="primary"
          visible
        />
      ) : null}
      {revenueMain ? (
        <RevenueBars model={revenueModel} placement="primary" visible />
      ) : null}
      {revenueMain ? (
        // Never drawn: it sizes the chart's primary axis to the bars and
        // gives the hover something to track. The bars are the picture.
        <Area
          dataKey={OVERVIEW_SERIES.revenueTop}
          fill="var(--success)"
          fillOpacity={0}
          showHighlight={false}
          showLine={false}
          dimOpacity={1}
          loadingStyle="sweep"
          loadingStrokeWidth={0.6}
          loadingStroke="var(--muted-foreground)"
          loadingStrokeOpacity={0.35}
        />
      ) : null}
      {sessionSeries ? (
        <ChartValueAxis format={sessionSeries.format} onWidth={reportRightAxis} />
      ) : null}
      {sessionSeries ? (
        <Area
          dataKey={OVERVIEW_SERIES.session}
          dimOpacity={1}
          fadeEdges
          fill={sessionSeries.color}
          fillOpacity={0.1}
          gapsForMissing
          loadingStroke="var(--muted-foreground)"
          loadingStrokeOpacity={0.35}
          loadingStrokeWidth={0.6}
          loadingStyle="sweep"
          strokeOpacity={0.9}
          strokeWidth={2}
        />
      ) : null}
      {sessionSeries && sessionComparing ? (
        <Area
          {...PREVIOUS_LINE_PROPS}
          dashArray="4,4"
          dataKey="prevSession"
          fill={sessionSeries.color}
          strokeWidth={1.5}
        />
      ) : null}
      {/* Behind the traffic: the bars come first among the series layers,
          and their axis sits outside the reveal clip like the x-axis. Only
          on the default chart: a single traffic series stands alone. */}
      {showRevenue && metric === null ? (
        <RevenueAxis
          model={revenueModel}
          onWidth={reportRightAxis}
          visible={revenueVisible}
        />
      ) : null}
      {showRevenue && metric === null ? (
        <RevenueBars model={revenueModel} visible={revenueVisible} />
      ) : null}
      {trafficSeries.includes("pageviews") ? (
        <Area
          dataKey={OVERVIEW_SERIES.pageviews}
          fill={PAGEVIEWS}
          // Alone on the chart, pageviews is the subject rather than the
          // underlay, and takes the visitors area's weight.
          fillOpacity={metric === "pageviews" ? 0.16 : 0.08}
          strokeWidth={metric === "pageviews" ? 2 : 1.5}
          strokeOpacity={metric === "pageviews" ? 0.8 : 0.45}
          // No whole-series dim on hover: scrubbing dims only what lies right
          // of the cursor (`scrubDimOpacity`), and the highlight still traces
          // the hovered stretch.
          dimOpacity={1}
          fadeEdges
          loadingStyle="sweep"
          // a thin, soft-grey loading line instead of a bold black one
          loadingStrokeWidth={0.6}
          loadingStroke="var(--muted-foreground)"
          loadingStrokeOpacity={0.35}
        />
      ) : null}
      {trafficSeries.includes("visitors") ? (
        <Area
          dataKey={OVERVIEW_SERIES.visitors}
          fill={VISITORS}
          fillOpacity={0.14}
          strokeWidth={2}
          strokeOpacity={0.4}
          dimOpacity={1}
          fadeEdges
          loadingStyle="sweep"
          loadingStrokeWidth={0.6}
          loadingStroke="var(--muted-foreground)"
          loadingStrokeOpacity={0.35}
        />
      ) : null}
      {/* The previous period: a dashed line per series, no fill, over the
          areas so the fills never hide it. Pageviews' line stays faint
          beside visitors, as its area does. */}
      {comparing && trafficSeries.includes("pageviews") ? (
        <Area
          {...PREVIOUS_LINE_PROPS}
          dashArray="3,4"
          dataKey="prevPageviews"
          fill={PAGEVIEWS}
          stroke={metric === "pageviews" ? PAGEVIEWS : PAGEVIEWS_PREVIOUS_FAINT}
          strokeWidth={metric === "pageviews" ? 1.5 : 1.25}
        />
      ) : null}
      {comparing && trafficSeries.includes("visitors") ? (
        <Area
          {...PREVIOUS_LINE_PROPS}
          dashArray="4,4"
          dataKey="prevVisitors"
          fill={VISITORS}
          strokeWidth={1.5}
        />
      ) : null}
      <XAxis tickDates={tickDates} />
      <ChartTooltip
        content={({ point }) => {
          const date = point.date as Date;
          const visitors = Number(point.visitors) || 0;
          const bucket = markerBuckets.get(date.getTime());
          const counts = bucket?.counts;
          const prevAtMs = Number(point.prevAtMs);
          const previous =
            comparing && Number.isFinite(prevAtMs)
              ? {
                  label: previousLabelFormat(new Date(prevAtMs)),
                  visitors: Number(point.prevVisitors) || 0,
                  pageviews: Number(point.prevPageviews) || 0,
                }
              : null;
          const sessionAt = Number(point.prevSessionAtMs);
          const sessionValue = point.session;
          const previousSessionValue = point.prevSession;
          const session = sessionSeries
            ? {
                label: sessionSeries.label,
                color: sessionSeries.color,
                // No sessions in the bucket: nothing measured, not zero.
                value:
                  typeof sessionValue === "number"
                    ? sessionSeries.format(sessionValue)
                    : "—",
                previous:
                  sessionComparing && Number.isFinite(sessionAt)
                    ? {
                        label: previousLabelFormat(new Date(sessionAt)),
                        value:
                          typeof previousSessionValue === "number"
                            ? sessionSeries.format(previousSessionValue)
                            : "—",
                      }
                    : null,
              }
            : null;
          return (
            <OverviewTooltipContent
              // Revenue is site-wide; a filter narrows only the traffic.
              filtered={filtersParam !== undefined}
              previous={previous}
              session={session}
              series={trafficSeries}
              mentionAuthors={bucket?.mentionAuthors}
              mentions={counts?.mention ?? 0}
              notes={counts?.note ?? 0}
              saleVisitors={bucket?.saleVisitors}
              pageviews={Number(point.pageviews) || 0}
              // Revenue rides the tooltip where it is drawn: beside the
              // default chart's bars, or as the main series. A single
              // traffic or session line draws no bars, so it says nothing
              // about money either.
              revenue={
                (revenueInTooltip && metric === null) || revenueMain
                  ? (revenueModel.buckets.get(date.getTime()) ?? null)
                  : null
              }
              sales={counts?.sale ?? 0}
              title={titleFormat(date)}
              visitors={visitors}
            />
          );
        }}
        datePillFormat={datePillFormat}
        // The bars mark their own buckets; a dot on the invisible sizing
        // series would float over them.
        showDots={!revenueMain}
        titleFormat={titleFormat}
      />
      {loadOverride === undefined && response ? (
        <OverviewMarkers
          // On the drawn series: the bars' tops as the main series, the
          // pressed metric's line, or visitors on the default chart.
          anchorKey={markerAnchorKey(metric)}
          bucketLabel={titleFormat}
          dimOpacity={SCRUB_DIM_OPACITY}
          endMs={layerEndMs}
          items={markers}
          noteActions={noteActions}
          slug={slug}
          timeLabel={weekView ? fmt.timeTitle.format : fmt.time.format}
        />
      ) : null}
      </AreaChart>
    </div>
  );
}

/**
 * Tells the overview's view what this chart draws and could draw
 * (`ChartDrawState`), so the tiles take "pressed" and "is a button" from the
 * chart rather than from the URL. A component for `PosterSeriesPublisher`'s
 * reason: the answer exists only past the chart's early returns. Unmounting
 * (an error or empty panel in its place) takes it back to the default.
 */
function ChartStatePublisher({
  state,
  settled,
  publish,
}: {
  state: ChartDrawState;
  /** False while a read is out: the last answer stands until it lands. */
  settled: boolean;
  publish: (state: ChartDrawState) => void;
}) {
  const { drawn, revenueChartable, sessionsChartable } = state;
  React.useEffect(() => {
    if (settled) publish({ drawn, revenueChartable, sessionsChartable });
  }, [settled, drawn, revenueChartable, sessionsChartable, publish]);
  React.useEffect(
    () => () =>
      publish({ drawn: null, revenueChartable: false, sessionsChartable: false }),
    [publish]
  );
  return null;
}

/**
 * Publishes the plotted visitors to the overview poster store. A component
 * rather than an effect in `OverviewChart`, because the plotted series only
 * exists past that function's early returns, and hooks cannot follow it
 * there. Keyed on the values, so a re-render that plots the same points
 * publishes nothing.
 */
function PosterSeriesPublisher({
  posterKey: key,
  points,
}: {
  posterKey: string;
  points: readonly PlotPoint[];
}) {
  const signature = points.map((point) => point.visitors).join(",");
  React.useEffect(() => {
    publishPosterSeries({
      key,
      visitors: signature === "" ? [] : signature.split(",").map(Number),
    });
  }, [key, signature]);
  return null;
}
