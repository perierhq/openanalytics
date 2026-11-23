"use client";

import { Megaphone01Icon } from "hugeicons-react";
import { AnimatePresence } from "motion/react";
import * as React from "react";
import { ApiErrorPanel } from "@/components/dashboard/api-error";
import {
  AdCampaignList,
  adCampaignsTitleFigure,
  adCampaignsVisibility,
} from "@/components/dashboard/ad-campaign-rows";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { RowSortToggle } from "@/components/dashboard/row-revenue";
import {
  SeeAllModal,
  SeeAllSkeleton,
  useIntervalLabel,
} from "@/components/dashboard/see-all-modal";
import { useSiteSummary } from "@/components/dashboard/site-summary-context";
import { SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { SquircleCard, SquircleCardScroll } from "@/components/ui/squircle-card";
import { useApiResource } from "@/hooks/use-api-resource";
import { LIVE_API, metaAds, type AdCampaignsResponse } from "@/lib/api";
import { formatMoney } from "@/lib/currencies";
import { formatRoas, roasReason, type CampaignSort } from "@/lib/meta-ads";
import { mockAdCampaigns } from "@/lib/mock";

/**
 * Ad campaigns on the overview (migration 0052): what each Meta campaign
 * cost, the last-touch revenue whose `utm_campaign` named it, and the ratio.
 *
 * **Only where it can say something.** The read is owner-only and a site
 * without a Meta connection has nothing to show, so for everyone else, and
 * for an owner who never connected, the card is not drawn at all. It is not
 * drawn while the first read is in flight either: most sites have no
 * connection, and a card that appeared and folded away would shove the grid.
 * Once a site has shown it, a later range change keeps the frame and swaps
 * the rows through the skeleton like every other card.
 *
 * Rows: spend in the reporting currency (the account's own when a day had no
 * exchange rate), revenue in green, ROAS last. The bar is spend and revenue
 * side by side, the Sources card's two-tone bar.
 */

/** Five pulse rows, the shape of the list about to appear. */
function RowsSkeleton() {
  return (
    <ul aria-hidden="true">
      {[0, 1, 2, 3, 4].map((index) => (
        <li className="flex items-center justify-between gap-4 px-5 py-1.5" key={index}>
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <span className="size-2 shrink-0 rounded-full bg-muted-foreground/15" />
            <span
              className="my-1 h-3 animate-pulse rounded bg-muted-foreground/15"
              style={{ width: `${72 - index * 9}%` }}
            />
          </span>
          <span className="my-1 h-3 w-20 animate-pulse rounded bg-muted-foreground/15" />
        </li>
      ))}
    </ul>
  );
}

export function AdCampaignsCard() {
  const summary = useSiteSummary();
  const role = summary.site?.role ?? null;
  const siteId = summary.site?.site_id ?? null;
  const reportingCurrency = summary.site?.reporting_currency ?? "USD";
  const { range, rangePending } = useAnalyticsInterval();
  const [sort, setSort] = React.useState<CampaignSort>("spend");
  const [open, setOpen] = React.useState(false);

  const load = React.useCallback(
    async (signal: AbortSignal): Promise<AdCampaignsResponse> => {
      if (role !== "owner" || siteId === null) return new Promise(() => {});
      if (!LIVE_API) return mockAdCampaigns(reportingCurrency);
      if (rangePending) return new Promise(() => {});
      return metaAds.campaigns(siteId, range, { signal });
    },
    [role, siteId, reportingCurrency, range, rangePending]
  );
  const resource = useApiResource(load);

  // Adjusted during render, not in an effect: the card keeps its frame
  // through a range change once a read has said the site is connected.
  const connectedNow =
    resource.status === "ready" ? resource.data.connection !== null : null;
  const [wasConnected, setWasConnected] = React.useState(false);
  if (connectedNow !== null && connectedNow !== wasConnected) {
    setWasConnected(connectedNow);
  }

  if (adCampaignsVisibility(role, resource, wasConnected) === "hidden") return null;

  const data = resource.status === "ready" ? resource.data : null;
  const figure = data === null ? null : adCampaignsTitleFigure(data);
  const stopped = data?.connection?.status === "needs_reconnect";

  return (
    <>
      <SquircleCard
        actions={
          <RowSortToggle
            onSort={(next) => setSort(next === "visitors" ? "spend" : "roas")}
            revenueLabel="ROAS"
            sort={sort === "spend" ? "visitors" : "revenue"}
            trafficLabel="Spend"
          />
        }
        icon={<Megaphone01Icon aria-hidden="true" />}
        onSeeAll={() => setOpen(true)}
        title={
          <span className="flex min-w-0 items-baseline gap-2 whitespace-nowrap">
            Ad campaigns
            {/* Beside the title where there is room for it; on a phone the
                header holds the sort and See all, and the modal has it. */}
            {figure !== null ? (
              <span className="hidden text-xs font-normal tabular-nums text-muted-foreground sm:inline">
                {figure}
              </span>
            ) : null}
          </span>
        }
      >
        <SkeletonReveal
          className="h-full [&>div]:h-full"
          ready={resource.status !== "loading"}
          skeleton={<RowsSkeleton />}
        >
          {resource.status === "error" ? (
            <ApiErrorPanel
              className="h-full gap-1 px-4 py-2 [&_p]:text-xs [&_p]:leading-5"
              error={resource.error}
              onRetry={resource.retry}
            />
          ) : data !== null ? (
            <SquircleCardScroll>
              {stopped ? (
                <p className="px-5 pb-1 pt-2 text-xs leading-5 text-warning-foreground">
                  Syncing stopped: Meta refused the token. Reconnect under
                  Settings, Integrations.
                </p>
              ) : null}
              <AdCampaignList data={data} sort={sort} />
            </SquircleCardScroll>
          ) : null}
        </SkeletonReveal>
      </SquircleCard>

      <AnimatePresence>
        {open ? (
          <AdCampaignsModal data={data} onClose={() => setOpen(false)} sort={sort} />
        ) : null}
      </AnimatePresence>
    </>
  );
}

/** Every campaign, with the totals and the spend nothing matched. */
function AdCampaignsModal({
  data,
  sort,
  onClose,
}: {
  data: AdCampaignsResponse | null;
  sort: CampaignSort;
  onClose: () => void;
}) {
  const intervalLabel = useIntervalLabel();
  const subtitle =
    data === null
      ? intervalLabel
      : [
          `${formatMoney(
            data.totals.spend_converted_minor ?? data.totals.spend.amount_minor,
            data.totals.spend_converted_minor === null
              ? data.totals.spend.currency
              : data.currency
          )} spent`,
          `${formatMoney(data.totals.revenue_minor, data.currency)} revenue`,
          data.totals.roas === null ? null : `${formatRoas(data.totals.roas)} ROAS`,
          intervalLabel,
        ]
          .filter((part) => part !== null)
          .join(" · ");
  const unmatched = data?.unmatched;
  return (
    <SeeAllModal onClose={onClose} subtitle={subtitle} title="Ad campaigns">
      {data === null ? (
        <SeeAllSkeleton />
      ) : (
        <div className="flex flex-col gap-2">
          <AdCampaignList className="[&>li>span]:rounded-[10px]" data={data} sort={sort} />
          {unmatched !== undefined && unmatched.campaigns > 0 ? (
            <p className="px-3 pb-2 text-xs leading-5 text-muted-foreground">
              {formatMoney(
                unmatched.spend_converted_minor ?? unmatched.spend.amount_minor,
                unmatched.spend_converted_minor === null
                  ? unmatched.spend.currency
                  : data.currency
              )}{" "}
              of spend across {unmatched.campaigns}{" "}
              {unmatched.campaigns === 1 ? "campaign" : "campaigns"} matched no
              utm_campaign. Tag their links with the campaign name or{" "}
              <code className="font-mono">{"{{campaign.id}}"}</code> to see
              their revenue.
            </p>
          ) : null}
          {data.totals.roas_unavailable === "no_rate" ? (
            <p className="px-3 pb-2 text-xs leading-5 text-muted-foreground">
              {roasReason("no_rate", data.totals.spend.currency)} ROAS is left
              out rather than guessed.
            </p>
          ) : null}
        </div>
      )}
    </SeeAllModal>
  );
}
