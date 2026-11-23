"use client";

import type * as React from "react";
import { BreakdownRow } from "@/components/dashboard/breakdown-row";
import { HoverList } from "@/components/dashboard/hover-list";
import type { ApiResource } from "@/hooks/use-api-resource";
import type { AdCampaignRow, AdCampaignsResponse, SiteRole } from "@/lib/api";
import { formatMoney, formatMoneyCompact } from "@/lib/currencies";
import {
  campaignLabel,
  campaignSpend,
  formatRoas,
  rankCampaigns,
  roasReason,
  type CampaignSort,
} from "@/lib/meta-ads";
import { stackedBars } from "@/lib/row-bars";

/**
 * The Ad campaigns card without its read: the rows, when the card is drawn,
 * and the figure beside its title. Types only from `lib/api`, so the tests
 * render it without the generated client; the read lives in
 * `ad-campaigns-card.tsx`.
 */

/**
 * Whether the card is drawn: for the owner, once a read says the site is
 * connected, and from then on (`wasConnected`) while later reads are in
 * flight. A 403 folds it away; any other failure is shown in place.
 */
export function adCampaignsVisibility(
  role: SiteRole | null,
  resource: ApiResource<AdCampaignsResponse>,
  wasConnected = false
): "hidden" | "shown" {
  if (role !== "owner") return "hidden";
  if (resource.status === "loading") return wasConnected ? "shown" : "hidden";
  if (resource.status === "error") {
    return resource.error.kind === "forbidden" ? "hidden" : "shown";
  }
  return resource.data.connection === null ? "hidden" : "shown";
}

/** The total ROAS beside the title, or nothing when it cannot be had. */
export function adCampaignsTitleFigure(data: AdCampaignsResponse): string | null {
  return data.totals.roas === null ? null : `${formatRoas(data.totals.roas)} ROAS`;
}

function RoasCell({ row }: { row: AdCampaignRow }) {
  const reason = roasReason(row.roas_unavailable, row.spend.currency);
  return (
    <span className="w-11 text-right text-xs tabular-nums text-foreground/70">
      {formatRoas(row.roas)}
      {reason ? <span className="sr-only"> {reason}</span> : null}
    </span>
  );
}

function rowTooltip(row: AdCampaignRow, currency: string): React.ReactNode {
  const reason = roasReason(row.roas_unavailable, row.spend.currency);
  const converted =
    row.spend_converted_minor !== null && row.spend.currency !== currency
      ? ` (${formatMoney(row.spend_converted_minor, currency)})`
      : "";
  return (
    <span className="flex flex-col gap-0.5">
      <span>
        Spend {formatMoney(row.spend.amount_minor, row.spend.currency)}
        {converted}
      </span>
      <span>
        Revenue {formatMoney(row.revenue_minor, currency)} ·{" "}
        {row.orders} {row.orders === 1 ? "order" : "orders"}
      </span>
      <span>
        {row.matched_by === null
          ? "No utm_campaign matched this campaign"
          : row.matched_by === "id"
            ? "Matched by campaign id"
            : row.matched_by === "name"
              ? "Matched by campaign name"
              : "Matched by name and id"}
      </span>
      {reason ? <span>{reason}</span> : null}
    </span>
  );
}

/** The rows, ranked; what the card and its modal both draw. */
export function AdCampaignList({
  data,
  sort,
  className,
}: {
  data: AdCampaignsResponse;
  sort: CampaignSort;
  className?: string;
}) {
  if (data.campaigns.length === 0) {
    return (
      <p className="flex h-full items-center justify-center px-6 py-6 text-center text-sm text-muted-foreground">
        No ad spend in this range.
      </p>
    );
  }
  const rows = rankCampaigns(data.campaigns, sort);
  const bars = stackedBars(
    rows.map((row) => ({
      traffic: campaignSpend(row, data.currency).minor,
      revenue: row.revenue_minor,
    })),
    sort === "roas" ? "revenue" : "traffic"
  );
  return (
    <HoverList className={className}>
      {rows.map((row, index) => {
        const spend = campaignSpend(row, data.currency);
        return (
          <BreakdownRow
            bar={bars[index]}
            key={row.id}
            name={campaignLabel(row)}
            revenue={
              row.revenue_minor > 0
                ? formatMoneyCompact(row.revenue_minor, data.currency)
                : null
            }
            tooltip={rowTooltip(row, data.currency)}
            trailing={<RoasCell row={row} />}
            value={formatMoneyCompact(spend.minor, spend.currency)}
          />
        );
      })}
    </HoverList>
  );
}
