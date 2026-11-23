import { Activity01Icon } from "hugeicons-react";
import { AdCampaignsCard } from "@/components/dashboard/ad-campaigns-card";
import { AiReferralsCard } from "@/components/dashboard/ai-referrals-card";
import { AwaitingEventsBadge } from "@/components/dashboard/awaiting-events";
import { CustomEventsCard } from "@/components/dashboard/custom-events-card";
import { IntervalProvider } from "@/components/dashboard/interval-context";
import { IntervalSelect } from "@/components/dashboard/interval-select";
import { LocationsCard } from "@/components/dashboard/locations-card";
import { OverviewChart } from "@/components/dashboard/overview-chart";
import { OverviewStats } from "@/components/dashboard/overview-stats";
import { OverviewRevenueSummaryProvider } from "@/components/dashboard/overview-revenue-summary";
import { OverviewSessionsProvider } from "@/components/dashboard/overview-sessions";
import {
  CompareToggle,
  OverviewViewProvider,
} from "@/components/dashboard/overview-view";
import { RefreshButton } from "@/components/dashboard/refresh-button";
import {
  OverviewLiveBadge,
  RealtimeCard,
} from "@/components/dashboard/realtime-card";
import { RevenueCard } from "@/components/dashboard/revenue-card";
import { MostValuableTrafficCard } from "@/components/dashboard/revenue-segments";
import { ShareOverviewButton } from "@/components/dashboard/share-overview-button";
import { HeaderTimezonePill } from "@/components/dashboard/timezone-pill";
import { SourcesProvider } from "@/components/dashboard/sources-resource";
import { TechCard } from "@/components/dashboard/tech-card";
import { TopPagesCard } from "@/components/dashboard/top-pages-card";
import { TopSourcesCard } from "@/components/dashboard/top-sources-card";
import { WebVitalsCard } from "@/components/dashboard/web-vitals-card";
import {
  SquircleCard,
  SquircleSurface,
} from "@/components/ui/squircle-card";

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ site: string }>;
}) {
  const { site } = await params;
  return (
    <IntervalProvider>
    {/* Compare and the pressed stat tile, in the URL beside the filters:
        the header toggle, the tiles and the chart all read it. */}
    <OverviewViewProvider>
    {/* One sessions read (and its previous period), shared by the stat
        tiles and the chart, which draws bounce rate or average visit over
        time when their tile is pressed. */}
    <OverviewSessionsProvider>
    {/* One revenue summary read, shared by the Revenue stat tile and the
        Revenue panel in the grid. */}
    <OverviewRevenueSummaryProvider>
    {/* The screen's clock, worn in the dashboard header beside the site
        switcher: it is painted into the header's slot from inside this
        provider, so the pick reaches every panel below. Only this screen
        paints one. It shows the site's own zone by default, and changing it
        changes this visit, never the site. */}
    <HeaderTimezonePill />
    <div className="flex flex-col gap-6">
      {/* Wraps on a phone: the title group and the three controls do not
          fit one 390px row, and the controls drop below rather than
          sliding over the title. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        {/* Baseline group, not items-center: the badge is text against the
            heading's text, and mixed sizes only look level when they share a
            baseline. Fed by the Realtime card's own stream through a module
            store, so the heading never opens a second SSE connection. */}
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-xl font-medium tracking-tight">Overview</h1>
            <OverviewLiveBadge />
          </div>
          {/* Outside the baseline group: a bordered control against text
              only looks level when it is centred, not baselined. */}
          <RefreshButton />

          {/* A site that has never received an event says so here rather than
              in a strip above the cards: the state is usually over within a
              minute, and it should not move the whole board while it lasts. */}
          <AwaitingEventsBadge />
        </div>
        {/* The active filters ride the tab bar's own tray (its filter face),
            which is the one piece of chrome on every screen and the only one
            with nothing else to be beside. The interval picker stays here,
            because the window and the filter are different kinds of
            statement and only the filter has marks. */}
        <div className="flex items-center gap-2">
          <ShareOverviewButton />
          {/* Beside the range it compares: the previous period is defined
              by the range, so the two controls read as one statement. */}
          <CompareToggle />
          <IntervalSelect />
        </div>
      </div>

      <OverviewStats />

      {/* traffic chart — headerless squircle: frame + inset panel only */}
      <SquircleSurface
        render={<section />}
        className="flex flex-col border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
      >
        <SquircleSurface className="overflow-hidden rounded-[22px] border border-border bg-[#f6f6f6] shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]">
          {/* vertical padding only — the plot itself hugs the side edges */}
          <div className="py-3">
            <OverviewChart />
          </div>
        </SquircleSurface>
      </SquircleSurface>

      {/* breakdown lists — 3x3; uniform h-60 panels sized for five rows.
          Every card brings its own SquircleCard now: "See all" opens the
          shared vertical modal with the full ranking, which needs card
          state a server component cannot hold. The sources read is fetched
          once here and folded twice, by Sources and by AI referrals. */}
      <SourcesProvider>
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <TopPagesCard />

        {/* brings its own SquircleCard: the header carries the dimension
            picker (Referrers / Campaigns / UTM), which needs the card state */}
        <TopSourcesCard />

        {/* brings its own SquircleCard: `revenue:read` is owner-only, so the
            card decides whether it exists at all rather than rendering a frame
            an admin would only ever see an error inside */}
        <RevenueCard />

        {/* brings its own SquircleCard: the header carries the cut picker
            (Countries / Cities), which needs the card state */}
        <LocationsCard />

        {/* the visits AI assistants sent, cut from the shared sources read;
            it took this slot from Devices on 2026-09-10 */}
        <AiReferralsCard />

        {/* brings its own SquircleCard: the header carries the cut picker
            (Browsers / OS / Devices), which needs the card state */}
        <TechCard />

        {/* realtime has a whole page — its "See all" is a door, not a modal */}
        <SquircleCard
          title="Realtime"
          icon={<Activity01Icon aria-hidden="true" />}
          seeAllHref={`/dashboard/${site}/realtime`}
        >
          <RealtimeCard />
        </SquircleCard>

        <WebVitalsCard />

        {/* brings its own SquircleCard: "See all" opens the event builder
            modal (M13), so the header needs a click handler, not a href */}
        <CustomEventsCard />

        {/* owner-only and only with a provider connected: it decides on the
            shared revenue summary, and sits last so its arrival after that
            read moves nothing anybody is reading */}
        <MostValuableTrafficCard />
        {/* Meta ad spend and ROAS per campaign (migration 0052). Last, and
            drawn only for an owner whose site is connected: most sites never
            are, and a card that appeared and folded away would move the grid */}
        <AdCampaignsCard />
      </div>
      </SourcesProvider>
    </div>
    </OverviewRevenueSummaryProvider>
    </OverviewSessionsProvider>
    </OverviewViewProvider>
    </IntervalProvider>
  );
}
