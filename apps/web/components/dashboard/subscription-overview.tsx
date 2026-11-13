"use client";

import * as React from "react";
import { Area, AreaChart } from "@/components/charts/area-chart";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { SquircleSurface } from "@/components/ui/squircle-card";
import {
  revenue,
  type SubscriptionSummaryResponse,
  type SubscriptionTimeseriesResponse,
  type SubscriptionTotals,
} from "@/lib/api";
import { formatMoney } from "@/lib/currencies";
import { cn } from "@/lib/utils";

/**
 * Subscriptions: MRR and churn over the selected range (Perier fork, gap 7).
 *
 * A small card between the money and the transaction list. It answers the one
 * question the revenue totals cannot: of what came in, how much will come
 * again next month, and how much walked away. MRR is list price normalized to
 * a month, so it is a different number from net revenue on purpose.
 *
 * **Hidden on a site that has never had a subscription.** A shop that only
 * sells one-off passes would otherwise get a card of zeros under its revenue.
 * Its renewal and new-charge split still lives in the transaction list.
 */

const MRR = "#296FF0";

export function SubscriptionOverview({ siteId }: { siteId: string }) {
  const { range, rangePending } = useAnalyticsInterval();
  const [summary, setSummary] =
    React.useState<SubscriptionSummaryResponse | null>(null);
  const [series, setSeries] =
    React.useState<SubscriptionTimeseriesResponse | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (rangePending) return;
    Promise.all([
      revenue.subscriptionSummary(siteId, range),
      revenue.subscriptionTimeseries(siteId, range),
    ]).then(
      ([summaryResponse, seriesResponse]) => {
        if (cancelled) return;
        setSummary(summaryResponse);
        setSeries(seriesResponse);
      },
      () => {
        /* The list below reports the failure; a third panel shouting is noise. */
      }
    );
    return () => {
      cancelled = true;
    };
  }, [siteId, range, rangePending]);

  const points = React.useMemo(
    () =>
      (series?.series ?? []).map((point) => ({
        date: new Date(point.bucket),
        mrr: point.mrr_minor,
      })),
    [series]
  );

  const totals = summary?.totals ?? null;
  if (!totals || !hasSubscriptions(totals)) return null;

  const renewals = summary?.purchase_kinds.find(
    (row) => row.purchase_kind === "renewal"
  );

  return (
    <SquircleSurface
      className="flex flex-col border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
      render={<section />}
    >
      <p className="px-4 pb-1.5 pt-1 text-sm font-medium text-foreground/80">
        Subscriptions
      </p>
      <SquircleSurface className="overflow-hidden rounded-[22px] border border-border bg-[#f6f6f6] shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]">
        <div className="grid grid-cols-1 items-center gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:px-7 sm:py-5">
          <Figures renewalCharges={renewals?.charges ?? 0} totals={totals} />
          {points.length > 1 ? (
            <AreaChart
              animationDuration={0}
              aspectRatio="auto"
              className="h-28"
              data={points}
              margin={{ bottom: 20, left: 0, right: 0, top: 8 }}
              status="ready"
              xLabelFormat={(date) =>
                date.toLocaleDateString("en-US", {
                  day: "numeric",
                  month: "short",
                })
              }
            >
              <Area
                dataKey="mrr"
                fadeEdges
                fill={MRR}
                fillOpacity={0.12}
                strokeOpacity={0.5}
                strokeWidth={2}
              />
            </AreaChart>
          ) : null}
        </div>
      </SquircleSurface>
    </SquircleSurface>
  );
}

/** Anything at all to show: a level at either end, or a movement in between. */
function hasSubscriptions(totals: SubscriptionTotals): boolean {
  return (
    totals.mrr_start_minor !== 0 ||
    totals.mrr_end_minor !== 0 ||
    totals.active_start + totals.active_end !== 0 ||
    totals.trialing_start + totals.trialing_end !== 0 ||
    totals.new_subscriptions + totals.churned_subscriptions !== 0 ||
    totals.trials_started !== 0
  );
}

function Figures({
  totals,
  renewalCharges,
}: {
  totals: SubscriptionTotals;
  renewalCharges: number;
}) {
  const money = (minor: number) => formatMoney(minor, totals.currency);
  const change = totals.mrr_end_minor - totals.mrr_start_minor;
  // Churn against the subscriptions there were at the start. With none at the
  // start there is no rate to give, so it is left out rather than shown as 0%.
  const churnRate =
    totals.active_start > 0
      ? totals.churned_subscriptions / totals.active_start
      : null;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
          MRR
        </p>
        <p className="mt-1 flex items-baseline gap-2.5">
          <span className="text-2xl font-medium tabular-nums tracking-tight">
            {money(totals.mrr_end_minor)}
          </span>
          {change !== 0 ? (
            <span
              className={cn(
                "text-sm font-medium tabular-nums",
                change > 0
                  ? "text-success-foreground"
                  : "text-destructive-foreground"
              )}
            >
              {change > 0 ? "+" : "−"}
              {money(Math.abs(change))}
            </span>
          ) : null}
        </p>
      </div>
      <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <Stat label="Active" value={String(totals.active_end)} />
        <Stat
          label={`Churn · ${totals.churned_subscriptions}`}
          value={
            churnRate === null ? "–" : `${(churnRate * 100).toFixed(1)}%`
          }
        />
        <Stat label="New MRR" value={money(totals.new_mrr_minor)} />
        <Stat
          label="Lost MRR"
          value={`−${money(totals.churned_mrr_minor + totals.contraction_mrr_minor)}`}
        />
        {totals.trialing_end > 0 ? (
          <Stat label="Trialing" value={String(totals.trialing_end)} />
        ) : null}
        {renewalCharges > 0 ? (
          <Stat label="Renewals" value={String(renewalCharges)} />
        ) : null}
      </dl>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}
