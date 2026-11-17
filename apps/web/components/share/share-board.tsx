"use client";

import {
  AiChat02Icon,
  ArrowDown01Icon,
  BrowserIcon as BrowserCardIcon,
  File01Icon,
  Globe02Icon,
  Location01Icon,
  SmartPhone01Icon,
} from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import * as React from "react";
import {
  AI_REFERRALS_CAVEAT,
  aiTotals,
  foldAiReferrals,
} from "@/components/dashboard/ai-referrals-card";
import {
  BreakdownRow,
  breakdownShare,
} from "@/components/dashboard/analytics-card";
import {
  DEVICE_LABEL,
  familyLabel,
  fold,
  titleCase,
} from "@/components/dashboard/tech-card";
import { HoverList } from "@/components/dashboard/hover-list";
import {
  OverviewChart,
  resolutionForInterval,
} from "@/components/dashboard/overview-chart";
import { sourceMark } from "@/components/dashboard/source-mark";
import {
  INTERVALS,
  IntervalProvider,
  useAnalyticsInterval,
} from "@/components/dashboard/interval-context";
import { IntervalSelect } from "@/components/dashboard/interval-select";
import { TimezonePill } from "@/components/dashboard/timezone-pill";
import {
  InfoTip,
  StatCard,
  type Stat,
} from "@/components/dashboard/stat-card";
// The dashboard's own wording and formats: one source for both boards.
import {
  AVG_VISIT_INFO,
  BOUNCE_INFO,
  durationLabel,
} from "@/lib/stat-format";
import { LiveBadge } from "@/components/dashboard/realtime-card";
import { Favicon } from "@/components/dashboard/site-favicon";
import {
  BrowserIcon,
  DeviceGlyph,
  FlagIcon,
  OSIcon,
} from "@/components/dashboard/tech-icons";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { SkeletonReveal } from "@/components/ui/skeleton-reveal";
import {
  SquircleCard,
  SquircleCardScroll,
  SquircleSurface,
} from "@/components/ui/squircle-card";
import {
  LIVE_API,
  publicShare,
  REALTIME_BASE_URL,
  type PublicDevicesResponse,
  type PublicPagesResponse,
  type PublicSiteIdentity,
  type PublicSourcesResponse,
  type DeviceRow,
  type PublicGeographyResponse,
  type PublicOverviewResponse,
  type PublicSessionsResponse,
} from "@/lib/api";
import { resolveViewingTimezone } from "@/lib/timezone";
import {
  MOCK_DEVICES,
  MOCK_PAGES,
  MOCK_PUBLIC_GEOGRAPHY,
  MOCK_PUBLIC_OVERVIEW,
  MOCK_PUBLIC_SITE_IDENTITY,
  MOCK_SESSIONS,
  MOCK_SOURCES,
} from "@/lib/mock";
import { readSseRecords, toFrame } from "@/lib/realtime";
import { useApi } from "@/lib/use-api";
import { trafficBars } from "@/lib/row-bars";
import { foldReferrers } from "@/lib/source-rows";

/**
 * The public share board — `/share/{share_slug}`, no account needed — in the
 * dashboard's own anatomy. Same stat cards, same squircle mini-cards, same
 * interval picker; what is missing is the app, not the design: no site
 * switcher, no account, no See all, no connect doors.
 *
 * Eight surfaces now, each behind its own owner opt-in (ADR-0039): overview
 * totals, the traffic chart, session metrics, geography, pages, sources,
 * devices and the live count. **Each renders only if the owner shared it** —
 * a surface that was not shared answers 404, and that is an absence, not a
 * fault. No endpoint reports which surfaces are on, deliberately: such a list
 * would itself describe a site nobody chose to describe. So every surface is
 * read independently and folds itself away, and the board's shape is the
 * owner's choices rather than ours.
 *
 * The chart is the dashboard's own `OverviewChart` with its reader injected,
 * not a second implementation — a share link has no slug to resolve and no
 * session to resolve it with, but everything below the fetch is identical.
 *
 * Every failure (wrong slug, rotated link, disabled dashboard) is an
 * indistinguishable "not available" — existence is deliberately not revealed.
 */

/**
 * The intervals offered while "All time" has no anchor. The public identity
 * read (ADR-0044) carries `first_event_at`; until it settles — and on a site
 * that has never ingested an event, where it is `null` — offering "All time"
 * would name one window and serve the trailing-12-months fallback.
 */
const PUBLIC_INTERVALS = INTERVALS.filter((entry) => entry.key !== "all");

/** Never fires: `useSyncExternalStore` only needs it to read the snapshot. */
const zoneSubscribe = () => () => {};

export function ShareBoard({ slug }: { slug: string }) {
  /**
   * The one non-analytics public read (ADR-0044), made once per page view
   * and deliberately never re-fetched on interval changes: it answers who
   * the site is (when the owner opted in) and where its history starts, and
   * neither moves with the range. `null` on a settled read means the slug is
   * dark or identity could not be read — the header falls back to the
   * generic line and "All time" stays withheld.
   */
  const identity = useApi<PublicSiteIdentity | null>(
    () => publicShare.siteIdentity(slug).catch(() => null),
    () => MOCK_PUBLIC_SITE_IDENTITY,
    slug
  );

  const firstEventAt = identity.data?.first_event_at ?? null;
  const allAnchorMs = firstEventAt === null ? null : Date.parse(firstEventAt);

  /**
   * The clock the board cuts its windows in (F-317, resolved here for the
   * public surface): the viewer's explicit pick, else the site's reporting
   * zone (ADR-0044), else the viewer's own browser. The pick is remembered
   * per tab and per slug — like the interval, reading someone's share link
   * must not follow the viewer to another site's link.
   *
   * The zone is applied the moment the identity read lands, so a site with
   * a reporting zone briefly cuts in the viewer's clock and refetches once —
   * the same settling the "All time" anchor already does on this screen.
   */
  // Read through `useSyncExternalStore`, the interval memory's own shape:
  // the server render (no storage) and hydration agree on `null`, then the
  // remembered pick takes over in the post-hydration pass.
  const readStoredZone = React.useCallback(() => {
    try {
      return window.sessionStorage.getItem(`oa-share-tz:${slug}`);
    } catch {
      return null;
    }
  }, [slug]);
  const storedZone = React.useSyncExternalStore(
    zoneSubscribe,
    readStoredZone,
    () => null
  );
  const [chosenZone, setChosenZone] = React.useState<string | null>(null);
  const pickZone = React.useCallback(
    (zone: string) => {
      setChosenZone(zone);
      try {
        window.sessionStorage.setItem(`oa-share-tz:${slug}`, zone);
      } catch {
        /* per-tab memory only — the pick still applies this visit */
      }
    },
    [slug]
  );
  // The dashboard's rule, from the one place that holds it (ADR-0079 D5).
  // There is no `preference` step here and there never can be: the viewer is
  // anonymous, so the chain runs out at their browser.
  const timezone = resolveViewingTimezone({
    chosen: chosenZone,
    remembered: storedZone,
    site: identity.data?.reporting_timezone ?? null,
  });

  return (
    // The dashboard's own interval machinery, with two changes for a surface
    // that renders in a stranger's browser: the pick is remembered per tab
    // rather than in the account's own entry (one shared key meant reading a
    // share link rewrote the viewer's dashboard picker), and "All time" is
    // offered only once the identity read has produced its anchor.
    <IntervalProvider
      allAnchorMs={
        allAnchorMs === null || Number.isNaN(allAnchorMs) ? null : allAnchorMs
      }
      intervals={
        allAnchorMs === null || Number.isNaN(allAnchorMs)
          ? PUBLIC_INTERVALS
          : INTERVALS
      }
      memory="visit"
      timezone={timezone}
    >
      <ShareScreen
        identity={identity.data}
        onPickZone={pickZone}
        slug={slug}
        timezone={timezone}
      />
    </IntervalProvider>
  );
}

function ShareScreen({
  identity,
  slug,
  timezone,
  onPickZone,
}: {
  identity: PublicSiteIdentity | null;
  slug: string;
  /** The resolved viewing zone — the same one the provider cuts ranges in. */
  timezone: string;
  onPickZone: (zone: string) => void;
}) {
  const { interval, range } = useAnalyticsInterval();
  const query = React.useMemo(
    () =>
      new URLSearchParams({
        from: range.from,
        to: range.to,
        timezone: range.timezone,
      }).toString(),
    [range]
  );

  // `null` data on a settled read = the owner did not share that surface.
  const overview = useApi<PublicOverviewResponse | null>(
    () => publicShare.overview(slug, query).catch(() => null),
    () => MOCK_PUBLIC_OVERVIEW,
    `${slug}?${query}`
  );
  const geography = useApi<PublicGeographyResponse | null>(
    () => publicShare.geography(slug, query).catch(() => null),
    () => MOCK_PUBLIC_GEOGRAPHY,
    `${slug}?${query}`
  );
  const sessions = useApi<PublicSessionsResponse | null>(
    () => publicShare.sessions(slug, query).catch(() => null),
    () => MOCK_SESSIONS,
    `${slug}?${query}`
  );
  const pages = useApi<PublicPagesResponse | null>(
    () => publicShare.pages(slug, query).catch(() => null),
    () => MOCK_PAGES,
    `${slug}?${query}`
  );
  const sources = useApi<PublicSourcesResponse | null>(
    () => publicShare.sources(slug, query).catch(() => null),
    () => MOCK_SOURCES,
    `${slug}?${query}`
  );
  const devices = useApi<PublicDevicesResponse | null>(
    () => publicShare.devices(slug, query).catch(() => null),
    () => MOCK_DEVICES,
    `${slug}?${query}`
  );
  const liveCount = useLiveCount(slug);

  /**
   * The chart reads for itself, through the dashboard component. Its loader is
   * keyed on the range so a new interval refetches, and it rejects rather than
   * resolving null — `foldOnError` is what turns "not shared" into absence.
   *
   * `?resolution=` is the dashboard's own grain choice, sent verbatim now
   * that the public endpoint accepts it (ADR-0039 D8) — so both boards draw
   * the same chart on every interval, weekly uniques included. The client-side
   * re-bucketing that used to live here over-counted `visitors` by 59 % on a
   * measured live day; do not bring it back. The whole-hour guard mirrors the
   * dashboard's: a sub-hour-offset zone (Kathmandu) refuses every named grain,
   * so there the plain ask keeps the server's own span-based choice.
   */
  // The chart's plate cannot stay when the chart folds: an unshared chart
  // left a long empty band where the plot used to be. The chart still owns
  // its own fold (`foldOnError`), but the loader it is handed reports each
  // outcome here, so the wrapper hides and shows in step with it — same
  // promise, two readers, no second fetch. The fold remembers *which read*
  // it folded for: a new range or interval is a new key, so the plate comes
  // back on its own and the remounted chart re-reads — then either draws or
  // folds again, exactly like the keyed `useApi` cards around it.
  const chartKey = `${slug}|${query}|${interval}`;
  const [chartFoldedFor, setChartFoldedFor] = React.useState<string | null>(
    null
  );
  const chartFolded = chartFoldedFor === chartKey;
  const loadChart = React.useCallback(async () => {
    // The grain is named for every zone now: since ADR-0079 step 3 the reads
    // compose from a fifteen-minute atom, so an hour or a day is servable at
    // +05:30 exactly as it is at +01:00. This used to withhold `resolution`
    // for the offsets the server would have refused.
    const search = new URLSearchParams(query);
    const spanMs = Date.parse(range.to) - Date.parse(range.from);
    search.set("resolution", resolutionForInterval(interval, spanMs));
    try {
      const response = await publicShare.timeseries(slug, search.toString());
      setChartFoldedFor(null);
      return response;
    } catch (error) {
      setChartFoldedFor(chartKey);
      throw error;
    }
  }, [slug, query, interval, range, chartKey]);

  const settled =
    overview.phase !== "loading" &&
    geography.phase !== "loading" &&
    sessions.phase !== "loading" &&
    pages.phase !== "loading" &&
    sources.phase !== "loading" &&
    devices.phase !== "loading";
  // Every surface off, and no live count, is indistinguishable from a dead
  // link — which is the point. The chart is not consulted: it reports through
  // its own fold, and waiting on it would delay this verdict for everyone.
  const nothingShared =
    settled &&
    overview.data === null &&
    geography.data === null &&
    sessions.data === null &&
    pages.data === null &&
    sources.data === null &&
    devices.data === null &&
    liveCount === null;

  return (
    <div className="flex min-h-svh flex-col">
      {/* fixed, not sticky — the dashboard header's rule (overscroll bounce)
          and its exact progressive-blur stack: sharpness itself fades out,
          no tint, so content slides under glass. Main compensates with pt. */}
      <header className="fixed inset-x-0 top-0 z-40">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-22"
        >
          <div className="absolute inset-0 backdrop-blur-[2px] [mask-image:linear-gradient(to_bottom,black_55%,transparent_84%)]" />
          <div className="absolute inset-0 backdrop-blur-[6px] [mask-image:linear-gradient(to_bottom,black_42%,transparent_70%)]" />
          <div className="absolute inset-0 backdrop-blur-[14px] [mask-image:linear-gradient(to_bottom,black_28%,transparent_56%)]" />
          <div className="absolute inset-0 backdrop-blur-[28px] [mask-image:linear-gradient(to_bottom,black_12%,transparent_42%)]" />
        </div>
        <div className="relative mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          {/* the OWNER's identity, not ours — our mark lives in the footer.
              Name and favicon come from the public identity read (ADR-0044)
              and exist only when the owner opted `share_identity` in; an
              anonymous share keeps the honest generic line. */}
          <span className="flex min-w-0 items-center gap-3">
            <SiteIdentity identity={identity} />
            {/* The board's clock, beside whose board it is: the site's
                reporting zone when configured, else the viewer's own — and
                a full IANA list, so a reader anywhere views the numbers in
                their own time. */}
            <TimezonePill onPick={onPickZone} value={timezone} />
          </span>
          <span className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              Want a page like this?
            </span>
            <Button render={<Link href="/" />} size="xs">
              Get Started
            </Button>
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-28 pt-22 sm:px-6">
        {nothingShared ? (
          // Wrong slug, rotated link and disabled dashboard all look like
          // this — existence is deliberately not revealed.
          <div className="flex flex-col items-center justify-center gap-3 py-32 text-center">
            <p className="text-base font-medium">
              This dashboard isn&apos;t available
            </p>
            <p className="max-w-sm text-sm leading-6 text-muted-foreground">
              The link may have been turned off or replaced. Ask whoever
              shared it for a fresh one.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between gap-4">
              {/* The live count rides the heading rather than a card of its
                  own. It is the one number on this page that does not belong
                  to the selected range — everything below answers "in this
                  window", this answers "right now" — and a card in that grid
                  invited it to be read as a seventh breakdown. Beside the
                  title it reads as the state of the site, which is what it is.
                  Absent when realtime was not shared, exactly as before. */}
              {/* The dashboard's own badge (`OverviewLiveBadge` wears the
                  same one), so the two headings read alike to the pixel. */}
              <div className="flex items-baseline gap-2.5">
                <h1 className="text-xl font-medium tracking-tight">Overview</h1>
                {liveCount !== null ? (
                  <LiveBadge className="text-base" count={liveCount} />
                ) : null}
              </div>
              <IntervalSelect />
            </div>

            {/* the dashboard's stat cards over the public totals — chrome
                immediately, numbers when the read lands. Folded away only
                once the read settles on "not shared". */}
            {overview.phase === "ready" &&
            overview.data === null &&
            sessions.data === null ? null : (
              <PublicStats
                overview={overview.data}
                sessions={sessions.data}
                sessionsSettled={sessions.phase !== "loading"}
              />
            )}

            {/* The dashboard's chart, in the dashboard's own plate — the same
                double surface `app/dashboard/[site]/page.tsx` wraps it in,
                because a chart sitting bare on the page was never a design
                decision, only a missing wrapper. `foldOnError` is the one real
                difference: a visitor must never be shown an error panel about
                someone else's sharing settings. The plate folds with the
                chart — `chartFolded` mirrors the same read — since an empty
                plate over a folded chart was just a long blank band. */}
            {chartFolded ? null : (
              <SquircleSurface
                className="flex flex-col border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                render={<section />}
              >
                <SquircleSurface className="overflow-hidden rounded-[22px] border border-border bg-[#f6f6f6] shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]">
                  <div className="py-3">
                    <OverviewChart
                      foldOnError
                      load={LIVE_API ? loadChart : undefined}
                    />
                  </div>
                </SquircleSurface>
              </SquircleSurface>
            )}

            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {geography.phase === "ready" && geography.data === null ? null : (
                <PublicLocationsCard geography={geography.data} />
              )}
              {pages.phase === "ready" && pages.data === null ? null : (
                <PublicPagesCard pages={pages.data} />
              )}
              {sources.phase === "ready" && sources.data === null ? null : (
                <PublicSourcesCard sources={sources.data} />
              )}
              {sources.phase === "ready" && sources.data === null ? null : (
                <PublicAiReferralsCard sources={sources.data} />
              )}
              {devices.phase === "ready" && devices.data === null ? null : (
                <>
                  <PublicTechCard devices={devices.data} />
                  <PublicDevicesCard devices={devices.data} />
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {/* fixed like the header, but on a white page glass is invisible —
          a white fade is what reads: content dissolves before the line. */}
      <footer className="pointer-events-none fixed inset-x-0 bottom-0 z-40">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-white via-white/85 to-transparent"
        />
        <div className="relative mx-auto flex h-12 w-full max-w-6xl items-center justify-center px-4">
          <Link
            className="pointer-events-auto flex items-center gap-1.5 text-xs leading-none text-muted-foreground transition-colors hover:text-foreground"
            href="/"
          >
            <span>Powered by</span>
            <Logo className="size-3.5 text-primary" />
            <span>Open Analytics</span>
          </Link>
        </div>
      </footer>
    </div>
  );
}

/**
 * The header's left corner belongs to whoever's numbers these are.
 *
 * `display_name` existing on the response *is* the opt-in (ADR-0044: absent,
 * never `null`, when `share_identity` is off), so the check is key presence
 * rather than truthiness. An anonymous share and a dark slug both get the
 * generic line — a page that never alarms a visitor also never explains
 * itself to one.
 */
function SiteIdentity({ identity }: { identity: PublicSiteIdentity | null }) {
  if (identity?.display_name !== undefined) {
    return (
      <span className="flex items-center gap-2">
        {identity.favicon_domain ? (
          <Favicon
            className="size-5 rounded-full border border-border/60 object-cover"
            domain={identity.favicon_domain}
          />
        ) : null}
        <span className="text-sm font-medium text-foreground/80">
          {identity.display_name}
        </span>
      </span>
    );
  }
  return (
    <span className="text-sm font-medium text-foreground/80">
      Shared dashboard
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Stat row — the dashboard's cards, public counts                     */
/* ------------------------------------------------------------------ */

/**
 * The dashboard's four cards, over public numbers.
 *
 * Bounce rate and average visit ride the sessions read, which is now public —
 * so this row is the dashboard's row exactly, and the copy comes from the same
 * constants rather than a second wording of the same idea. A shared surface
 * that is off shows "—" instead of vanishing: a missing card would shuffle the
 * grid, and the gap is more honest than the reflow.
 */
function PublicStats({
  overview,
  sessions,
  sessionsSettled,
}: {
  overview: PublicOverviewResponse | null;
  sessions: PublicSessionsResponse | null;
  sessionsSettled: boolean;
}) {
  const totals = overview?.totals ?? null;
  const stats: Stat[] = [
    {
      label: "Visitors",
      display: totals ? totals.visitors.toLocaleString("en-US") : null,
      info: "Unique people in this range. A visitor is counted once, no matter how many pages they open.",
    },
    {
      label: "Pageviews",
      display: totals ? totals.pageviews.toLocaleString("en-US") : null,
      info: "Every page load. One visitor browsing five pages counts five times.",
    },
    {
      label: "Bounce rate",
      display: sessions
        ? `${Math.round(sessions.totals.bounce_rate * 100)}%`
        : sessionsSettled
          ? "—"
          : null,
      info: BOUNCE_INFO,
    },
    {
      label: "Avg. visit",
      display: sessions
        ? durationLabel(sessions.totals.avg_session_duration_ms)
        : sessionsSettled
          ? "—"
          : null,
      info: AVG_VISIT_INFO,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((stat) => (
        <StatCard key={stat.label} stat={stat} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pages, sources, devices — the dashboard's cards without their modals */
/* ------------------------------------------------------------------ */

/**
 * One shell for the three plain breakdowns.
 *
 * They differ only in icon, title and how a row is drawn, so the skeleton, the
 * empty line and the scroll behaviour live here once. The dashboard's own
 * cards cannot be reused directly — each fetches for itself through
 * `useSiteAnalytics` and carries a See-all modal this board has no business
 * opening — but their *folding* is imported rather than reimplemented, so the
 * two boards can never disagree about what a referrer is.
 */
function PublicBreakdownCard({
  icon,
  title,
  titleAside,
  rows,
  empty,
  truncated = false,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  /** Beside the title, outside the heading: the AI card's share and tip. */
  titleAside?: React.ReactNode;
  rows: Array<{
    key: string;
    name: string;
    value: number;
    icon?: React.ReactNode;
  }> | null;
  empty: string;
  /** The response's own `meta.truncated`: a share of a capped row set is
   *  inflated, so the rows render without percentages at all. */
  truncated?: boolean;
}) {
  // `breakdownShare`, the dashboard's own arithmetic: a share of the TOTAL,
  // not of the biggest row. Dividing by the max made the top row always read
  // 100% and everything under it a ratio to it, not a share of traffic.
  const share = breakdownShare(
    rows === null ? [] : rows.map((row) => row.value),
    truncated
  );
  const bar = trafficBars(rows === null ? [] : rows.map((row) => row.value));
  return (
    <SquircleCard
      hideSeeAll
      icon={icon}
      title={title}
      titleAside={titleAside}
    >
      <SkeletonReveal
        className="h-full [&>div]:h-full"
        ready={rows !== null}
        skeleton={<RowsSkeleton />}
      >
        {rows === null ? null : rows.length === 0 ? (
          <p className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {empty}
          </p>
        ) : (
          <SquircleCardScroll>
            <HoverList>
              {rows.map((row) => (
                <BreakdownRow
                  icon={row.icon}
                  key={row.key}
                  name={row.name}
                  bar={bar(row.value)}
                  pct={share(row.value)}
                  value={row.value.toLocaleString("en-US")}
                />
              ))}
            </HoverList>
          </SquircleCardScroll>
        )}
      </SkeletonReveal>
    </SquircleCard>
  );
}

function PublicPagesCard({ pages }: { pages: PublicPagesResponse | null }) {
  const rows =
    pages === null
      ? null
      : [...pages.items]
          .sort((a, b) => b.views - a.views)
          .map((row) => ({
            key: row.page_path,
            name: row.page_path,
            value: row.views,
          }));
  return (
    <PublicBreakdownCard
      empty="No pages in this range."
      icon={<File01Icon aria-hidden="true" />}
      rows={rows}
      title="Top pages"
      truncated={pages?.meta.truncated ?? false}
    />
  );
}

function PublicSourcesCard({
  sources,
}: {
  sources: PublicSourcesResponse | null;
}) {
  // Referrers only. The dashboard offers UTM cuts behind a dropdown; a share
  // link publishing someone's campaign taxonomy is a different decision from
  // publishing their traffic, and not one this board should make for them.
  const rows =
    sources === null
      ? null
      : foldReferrers(sources.items).map((row) => ({
          key: row.label,
          name: row.label,
          value: row.visitors,
          icon: sourceMark(row),
        }));
  return (
    <PublicBreakdownCard
      empty="No referrers in this range."
      icon={<Globe02Icon aria-hidden="true" />}
      rows={rows}
      title="Sources"
      truncated={sources?.meta.truncated ?? false}
    />
  );
}

/**
 * The visits AI assistants sent, cut from the same public sources read the
 * Sources card folds, with the dashboard's own `foldAiReferrals`, so the two
 * boards can never disagree about what an assistant is. The share of all
 * visitors rides beside the title with the dashboard's caveat; there is no
 * See all here, so the total has no header to live in and is not shown.
 */
function PublicAiReferralsCard({
  sources,
}: {
  sources: PublicSourcesResponse | null;
}) {
  const rows =
    sources === null
      ? null
      : foldAiReferrals(sources.items).map((row) => ({
          key: row.label,
          name: row.label,
          value: row.visitors,
          icon: sourceMark(row),
        }));
  const pct =
    sources === null
      ? null
      : aiTotals(sources.items, sources.meta.truncated).pct;
  return (
    <PublicBreakdownCard
      empty="No visits from AI assistants in this range."
      icon={<AiChat02Icon aria-hidden="true" />}
      rows={rows}
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          AI referrals
          {pct !== null ? (
            <span className="text-xs font-normal tabular-nums text-muted-foreground">
              {pct}% of all visitors
            </span>
          ) : null}
        </span>
      }
      titleAside={<InfoTip text={AI_REFERRALS_CAVEAT} width="w-72" />}
      truncated={sources?.meta.truncated ?? false}
    />
  );
}

/**
 * Browsers and operating systems in one card with the cut picker in its
 * header, and device types as a card of their own: three cuts of one read,
 * `GET /devices` returning the device_type × browser × os combination, so
 * every cut is a folding of the same response. The dashboard folds all
 * three into one card since 2026-09-10; this board keeps Devices separate
 * because with AI referrals beside Sources its grid holds six cards, and a
 * seventh slot standing empty read as a missing card (Abbas, 2026-09-10).
 * The locations card already asks a visitor to pick a cut, so the picker
 * here hides nothing new.
 *
 * Folding is on the raw token and the label is applied at render. Folding on
 * the label would hand the icons "Other" and "macOS", which no glyph map
 * knows, and every row would fall back to the generic mark.
 */
type TechView = "browsers" | "os";

const TECH_CUTS: {
  id: TechView;
  label: string;
  empty: string;
  keyOf: (row: DeviceRow) => string;
  name: (token: string) => string;
  mark: (token: string) => React.ReactNode;
}[] = [
  {
    id: "browsers",
    label: "Browsers",
    empty: "No browsers in this range.",
    keyOf: (row) => row.browser,
    name: familyLabel,
    mark: (token) => <BrowserIcon className="size-4" family={token} />,
  },
  {
    id: "os",
    label: "OS",
    empty: "No systems in this range.",
    keyOf: (row) => row.os,
    name: familyLabel,
    mark: (token) => <OSIcon className="size-4" family={token} />,
  },
];

function PublicDevicesCard({
  devices,
}: {
  devices: PublicDevicesResponse | null;
}) {
  const rows =
    devices === null
      ? null
      : fold(devices.items, (row) => row.device_type).map((row) => ({
          key: row.label,
          name: DEVICE_LABEL[row.label] ?? titleCase(row.label),
          value: row.visitors,
          icon: <DeviceGlyph className="size-4" deviceType={row.label} />,
        }));
  return (
    <PublicBreakdownCard
      empty="No devices in this range."
      icon={<SmartPhone01Icon aria-hidden="true" />}
      rows={rows}
      title="Devices"
      truncated={devices?.meta.truncated ?? false}
    />
  );
}

function PublicTechCard({
  devices,
}: {
  devices: PublicDevicesResponse | null;
}) {
  const [view, setView] = React.useState<TechView>("browsers");
  const current = TECH_CUTS.find((cut) => cut.id === view) ?? TECH_CUTS[0];
  // "unknown" and "" collapse to one bucket first, as on the dashboard.
  const rows =
    devices === null
      ? null
      : fold(devices.items, (row) => {
          const value = current.keyOf(row);
          return value === "unknown" || value === "" ? "unknown" : value;
        });
  const share = breakdownShare(
    rows === null ? [] : rows.map((row) => row.visitors),
    devices?.meta.truncated ?? false
  );
  const bar = trafficBars(rows === null ? [] : rows.map((row) => row.visitors));

  return (
    <SquircleCard
      hideSeeAll
      icon={<BrowserCardIcon aria-hidden="true" />}
      title={
        <DropdownMenu
          align="start"
          className="w-36"
          trigger={
            <button
              className="flex cursor-pointer items-center gap-1 rounded-lg py-0.5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
            >
              {/* the house label swap: the title glides when the cut changes */}
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
          {TECH_CUTS.map((cut) => (
            <DropdownMenuItem key={cut.id} onClick={() => setView(cut.id)}>
              {cut.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenu>
      }
    >
      <SkeletonReveal
        className="h-full [&>div]:h-full"
        ready={rows !== null}
        skeleton={<RowsSkeleton />}
      >
        {rows === null ? null : (
          // the dashboard card's cut change: outgoing list drifts up and
          // out, the new one rises in; title and content move as one
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
                    {rows.map((row) => (
                      <BreakdownRow
                        icon={current.mark(row.label)}
                        key={row.label}
                        name={current.name(row.label)}
                        bar={bar(row.visitors)}
                        pct={share(row.visitors)}
                        value={row.visitors.toLocaleString("en-US")}
                      />
                    ))}
                  </HoverList>
                </SquircleCardScroll>
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </SkeletonReveal>
    </SquircleCard>
  );
}

/* ------------------------------------------------------------------ */
/* Locations — the dashboard's card, public geography                  */
/* ------------------------------------------------------------------ */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

type LocationView = "countries" | "cities";

const VIEWS: { id: LocationView; label: string; empty: string }[] = [
  { id: "countries", label: "Countries", empty: "No visits in this range." },
  {
    id: "cities",
    label: "Cities",
    empty: "No city detail in this range.",
  },
];

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
function countryName(code: string): string {
  if (code === "unknown" || code === "") return "Unknown";
  try {
    return REGION_NAMES.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

type FoldedPlace = {
  key: string;
  label: string;
  country: string;
  visitors: number;
};

function foldCountries(
  items: PublicGeographyResponse["items"]
): FoldedPlace[] {
  const byCountry = new Map<string, number>();
  for (const row of items) {
    byCountry.set(row.country, (byCountry.get(row.country) ?? 0) + row.visitors);
  }
  return [...byCountry.entries()]
    .map(([code, visitors]) => ({
      key: code,
      label: "",
      country: code,
      visitors,
    }))
    .sort((a, b) => b.visitors - a.visitors);
}

/** Suppressed or nameless cities fold away — counted in the country cut. */
function foldCities(items: PublicGeographyResponse["items"]): FoldedPlace[] {
  const byCity = new Map<string, FoldedPlace>();
  for (const row of items) {
    const city = row.city?.trim() ?? "";
    if (row.city_suppressed || city === "" || city === "unknown") continue;
    const key = `${row.country}|${city}`;
    const bucket = byCity.get(key) ?? {
      key,
      label: city,
      country: row.country,
      visitors: 0,
    };
    bucket.visitors += row.visitors;
    byCity.set(key, bucket);
  }
  return [...byCity.values()].sort((a, b) => b.visitors - a.visitors);
}

/** Five pulse rows, the shape of the list that is about to appear. */
function RowsSkeleton() {
  return (
    <ul aria-hidden="true">
      {[0, 1, 2, 3, 4].map((index) => (
        <li
          key={index}
          className="flex items-center justify-between gap-4 px-5 py-1.5"
        >
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <span className="size-2 shrink-0 rounded-full bg-muted-foreground/15" />
            <span
              className="my-1 h-3 animate-pulse rounded bg-muted-foreground/15"
              style={{ width: `${72 - index * 9}%` }}
            />
          </span>
          <span className="my-1 h-3 w-8 animate-pulse rounded bg-muted-foreground/15" />
        </li>
      ))}
    </ul>
  );
}

function PublicLocationsCard({
  geography,
}: {
  geography: PublicGeographyResponse | null;
}) {
  const [view, setView] = React.useState<LocationView>("countries");
  const current = VIEWS.find((entry) => entry.id === view) ?? VIEWS[0];
  const items = geography?.items ?? null;
  const places =
    items === null
      ? null
      : view === "countries"
        ? foldCountries(items)
        : foldCities(items);
  // Share of the total, never of the biggest row (the dashboard's own
  // `breakdownShare`, same reasoning as `PublicBreakdownCard` above).
  const share = breakdownShare(
    places === null ? [] : places.map((place) => place.visitors),
    geography?.meta.truncated ?? false
  );
  const bar = trafficBars(places === null ? [] : places.map((place) => place.visitors));

  return (
    <SquircleCard
      hideSeeAll
      icon={<Location01Icon aria-hidden="true" />}
      title={
        <DropdownMenu
          align="start"
          className="w-40"
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
      <SkeletonReveal
        className="h-full [&>div]:h-full"
        ready={places !== null}
        skeleton={<RowsSkeleton />}
      >
        {places === null ? null : (
          // the dashboard card's cut change: outgoing list drifts up and
          // out, the new one rises in — title and content move as one
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              className="h-full"
              exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}
              initial={{ opacity: 0, y: 8 }}
              key={view}
              transition={SPRING}
            >
              {places.length === 0 ? (
                <p className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                  {current.empty}
                </p>
              ) : (
                <SquircleCardScroll>
                  <HoverList>
                    {places.map((place) => (
                      <BreakdownRow
                        icon={
                          <FlagIcon code={place.country} className="size-4" />
                        }
                        key={place.key}
                        name={
                          view === "countries"
                            ? countryName(place.country)
                            : place.label
                        }
                        bar={bar(place.visitors)}
                        pct={share(place.visitors)}
                        value={place.visitors.toLocaleString("en-US")}
                      />
                    ))}
                  </HoverList>
                </SquircleCardScroll>
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </SkeletonReveal>
    </SquircleCard>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The public live count. Absence is a normal state — realtime sharing off, or
 * the stream unreachable — and hides the card rather than showing an error;
 * this page never alarms a visitor about someone else's plumbing.
 */
function useLiveCount(slug: string): number | null {
  // The fixture's number in mock mode, so the card stays designable.
  const [count, setCount] = React.useState<number | null>(
    LIVE_API ? null : 128
  );

  React.useEffect(() => {
    if (!LIVE_API) return;

    const abort = new AbortController();

    const run = async () => {
      try {
        const token = await publicShare.realtimeToken(slug);
        const response = await fetch(
          `${REALTIME_BASE_URL}/v1/realtime/stream`,
          {
            headers: {
              accept: "text/event-stream",
              authorization: `Bearer ${token.token}`,
            },
            signal: abort.signal,
          }
        );
        if (!response.ok || !response.body) return;
        for await (const record of readSseRecords(
          response.body,
          abort.signal
        )) {
          const frame = toFrame(record, "public");
          if (frame?.type === "snapshot") {
            setCount(frame.data.active_visitors);
          }
          if (frame?.type === "control" && frame.data.action === "disconnect") {
            setCount(null);
            return;
          }
        }
      } catch {
        // Token 404 (not shared) or stream failure — no card, no error.
      }
    };

    void run();
    return () => abort.abort();
  }, [slug]);

  return count;
}
