"use client";

import { ArrowDown01Icon } from "hugeicons-react";
import * as React from "react";
import { AnalyticsCardBody } from "@/components/dashboard/analytics-card";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { Favicon } from "@/components/dashboard/site-favicon";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { SquircleSurface } from "@/components/ui/squircle-card";
import { useApiResource } from "@/hooks/use-api-resource";
import {
  revenue,
  type RevenueAttributionDimension,
  type RevenueAttributionResponse,
  type RevenueAttributionRow,
  type RevenueAttributionTouch,
} from "@/lib/api";
import { formatMoney } from "@/lib/currencies";
import { resolveReferrer } from "@/lib/referrers";

/**
 * Revenue by source / entry page (Perier fork, DataFast gap 3).
 *
 * One row per value of the chosen touch's dimension, from
 * `GET /v1/sites/{site_id}/revenue/attribution`: the money the attribution
 * rows tie to that source, the orders behind it, and, for ranges up to 92
 * days, how many visitors entered that way and what share of them bought.
 *
 * **Unattributed revenue is a row, first**, never left out: without it the
 * column would add up to less than the net figure above it and nothing on the
 * screen would say why. Above 92 days the server does not count visitors, and
 * the two rate columns say "—" rather than 0.
 */

const DIMENSIONS: {
  id: RevenueAttributionDimension;
  label: string;
  empty: string;
}[] = [
  { id: "referrer_domain", label: "Referrers", empty: "Direct / none" },
  { id: "utm_campaign", label: "Campaigns", empty: "No campaign" },
  { id: "utm_source", label: "UTM sources", empty: "No utm_source" },
  { id: "utm_medium", label: "UTM medium", empty: "No utm_medium" },
  { id: "entry_page", label: "Entry pages", empty: "Unknown page" },
];

const TOUCHES: { id: RevenueAttributionTouch; label: string }[] = [
  { id: "first", label: "First touch" },
  { id: "last", label: "Last touch" },
];

export function RevenueBySource({ siteId }: { siteId: string }) {
  const { range, rangePending } = useAnalyticsInterval();
  const [dimension, setDimension] =
    React.useState<RevenueAttributionDimension>("referrer_domain");
  const [touch, setTouch] = React.useState<RevenueAttributionTouch>("first");

  const load = React.useCallback(
    (signal: AbortSignal): Promise<RevenueAttributionResponse> =>
      // All-time's anchor is still on its way: hold the skeleton rather than
      // fetch a placeholder range and replace it a moment later.
      rangePending
        ? new Promise<RevenueAttributionResponse>(() => {})
        : revenue.attribution(siteId, range, { dimension, touch, signal }),
    [siteId, range, rangePending, dimension, touch]
  );
  const resource = useApiResource(load);
  const current =
    DIMENSIONS.find((entry) => entry.id === dimension) ?? DIMENSIONS[0];
  const currentTouch = TOUCHES.find((entry) => entry.id === touch) ?? TOUCHES[0];

  return (
    <SquircleSurface
      className="flex flex-col border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
      render={<section />}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-1.5 pt-1">
        <p className="text-sm font-medium text-foreground/80">
          Revenue by source / entry page
        </p>
        <div className="flex items-center gap-1">
          <Picker
            label={current.label}
            onPick={setDimension}
            options={DIMENSIONS}
          />
          <Picker
            label={currentTouch.label}
            onPick={setTouch}
            options={TOUCHES}
          />
        </div>
      </div>
      <SquircleSurface className="overflow-hidden rounded-[22px] border border-border bg-[#f6f6f6] px-4 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]">
        <AnalyticsCardBody
          emptyBody="No payments in this range."
          isEmpty={(data) => data.rows.length === 0}
          resource={resource}
        >
          {(data) => (
            <AttributionTable data={data} emptyLabel={current.empty} />
          )}
        </AnalyticsCardBody>
      </SquircleSurface>
    </SquircleSurface>
  );
}

function Picker<T extends string>({
  label,
  options,
  onPick,
}: {
  label: string;
  options: { id: T; label: string }[];
  onPick: (id: T) => void;
}) {
  return (
    <DropdownMenu
      className="w-40"
      trigger={
        <button
          className="flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          type="button"
        >
          {label}
          <ArrowDown01Icon
            aria-hidden="true"
            className="size-3.5 text-muted-foreground/70"
          />
        </button>
      }
    >
      {options.map((option) => (
        <DropdownMenuItem key={option.id} onClick={() => onPick(option.id)}>
          {option.label}
        </DropdownMenuItem>
      ))}
    </DropdownMenu>
  );
}

const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-6 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto]";

function AttributionTable({
  data,
  emptyLabel,
}: {
  data: RevenueAttributionResponse;
  emptyLabel: string;
}) {
  const money = (minor: number) => formatMoney(minor, data.currency);
  const percent = (value: number | null) =>
    value === null ? "—" : `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;

  return (
    <div className="flex flex-col">
      <div
        className={`${GRID} border-b border-border py-2 text-xs text-muted-foreground`}
      >
        <span>Source</span>
        <span
          className="text-right"
          title="Every charge, subscription renewals and plan changes included"
        >
          Revenue
        </span>
        <span
          className="text-right"
          title="New subscriptions and one-off purchases. Renewals and plan changes count as revenue, not as orders."
        >
          Orders
        </span>
        <span className="hidden text-right sm:block">Conversion</span>
        <span className="hidden text-right sm:block">Per visitor</span>
      </div>
      <ul className="flex flex-col divide-y divide-border">
        {data.rows.map((row) => (
          <li className={`${GRID} py-2.5`} key={row.value ?? "\u0000"}>
            <SourceName
              dimension={data.dimension}
              emptyLabel={emptyLabel}
              row={row}
            />
            <span
              className="text-right text-sm font-medium tabular-nums"
              title={
                row.recurring_revenue_minor > 0
                  ? `${money(row.recurring_revenue_minor)} from renewals and plan changes`
                  : undefined
              }
            >
              {money(row.revenue_minor)}
            </span>
            <span className="text-right text-sm tabular-nums text-muted-foreground">
              {row.orders.toLocaleString("en-US")}
            </span>
            <span
              className="hidden text-right text-sm tabular-nums text-muted-foreground sm:block"
              title={
                row.visitors === null
                  ? undefined
                  : `${row.buyers} of ${row.visitors.toLocaleString("en-US")} visitors bought`
              }
            >
              {percent(row.conversion_rate)}
            </span>
            <span className="hidden text-right text-sm tabular-nums text-muted-foreground sm:block">
              {row.revenue_per_visitor_minor === null
                ? "—"
                : money(Math.round(row.revenue_per_visitor_minor))}
            </span>
          </li>
        ))}
      </ul>
      {!data.visitors_available ? (
        <p className="pt-2 text-xs leading-5 text-muted-foreground">
          Conversion and revenue per visitor need a range of 92 days or less.
        </p>
      ) : null}
    </div>
  );
}

function SourceName({
  row,
  dimension,
  emptyLabel,
}: {
  row: RevenueAttributionRow;
  dimension: RevenueAttributionDimension;
  emptyLabel: string;
}) {
  if (row.value === null) {
    return (
      <span
        className="truncate text-sm text-muted-foreground"
        title="Payments we could not tie to a visit"
      >
        Unattributed
      </span>
    );
  }
  if (row.value === "") {
    return (
      <span className="truncate text-sm text-muted-foreground">
        {emptyLabel}
      </span>
    );
  }
  if (dimension === "referrer_domain") {
    const source = resolveReferrer(row.value);
    return (
      <span className="flex min-w-0 items-center gap-2.5">
        <Favicon
          className="size-4 shrink-0 rounded-full border border-border/60 object-cover"
          domain={source.domain}
        />
        <span className="truncate text-sm" title={row.value}>
          {source.name}
        </span>
      </span>
    );
  }
  return (
    <span className="truncate text-sm" title={row.value}>
      {row.value}
    </span>
  );
}
