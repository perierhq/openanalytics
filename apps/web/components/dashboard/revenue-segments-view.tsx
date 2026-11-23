"use client";

import * as React from "react";
import { HoverList, HoverRow } from "@/components/dashboard/hover-list";
import { ROW_TOOLTIP_PLACEMENT } from "@/components/dashboard/breakdown-row";
import { sourceMark } from "@/components/dashboard/source-mark";
import { InfoTip } from "@/components/dashboard/stat-card";
import { DeviceGlyph, FlagIcon } from "@/components/dashboard/tech-icons";
import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  RevenueSegment,
  RevenueSegmentConfidence,
  RevenueSegmentsResponse,
} from "@/lib/api";
import { formatMoney } from "@/lib/currencies";
import { resolveReferrer } from "@/lib/referrers";
import {
  countryLabel,
  deviceLabel,
  formatRate,
  insufficientDataCopy,
  leftOutBuyersCopy,
  SEGMENT_SORTS,
  segmentKey,
  segmentsNeedingHost,
  segmentSourceLabel,
  SMOOTHING_NOTE,
  sortSegments,
  truncatedCopy,
  type SegmentSort,
} from "@/lib/revenue-segments";
import { cn } from "@/lib/utils";

/**
 * Revenue by segment, drawn: the overview card's rows, the full sortable
 * table, the insufficient-data state and the two notes. Presentational only,
 * so it renders (and is tested) without the API client; the reads live in
 * `revenue-segments.tsx`.
 *
 * **The smoothed figures are the headline.** Value per visitor and
 * conversion are the server's smoothed values everywhere a number is printed
 * in a column; the raw figures, the buyers and the orders behind them are in
 * the row's tooltip. A segment of forty visits with one big order would
 * otherwise top every list on the strength of one person.
 */

/** Money per visitor: the smoothed minor units, rounded to the currency's unit. */
function perVisitor(minor: number, currency: string): string {
  return formatMoney(Math.round(minor), currency);
}

const CONFIDENCE_COPY: Record<RevenueSegmentConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

/**
 * One small mark per row, monochrome: solid for high, half-tone for medium,
 * a ring for low. Not a status colour: low confidence is not a fault, it is a
 * small segment.
 */
export function ConfidenceDot({
  confidence,
}: {
  confidence: RevenueSegmentConfidence;
}) {
  return (
    <span className="inline-flex size-3 shrink-0 items-center justify-center">
      <span
        aria-hidden="true"
        className={cn(
          "size-2 rounded-full",
          confidence === "high" && "bg-foreground/70",
          confidence === "medium" && "bg-foreground/30",
          confidence === "low" && "ring-1 ring-inset ring-foreground/40"
        )}
      />
      <span className="sr-only">{CONFIDENCE_COPY[confidence]}</span>
    </span>
  );
}

/**
 * The source mark, the name, the flag and the device: what the segment is.
 * `trailing` sits right after the marks (the table's confidence dot), never
 * pushed to the far edge of a wide cell. `showHost` puts the raw referrer
 * host under the name, for a row that would otherwise read exactly like
 * another one (google.com and google.de are both Google).
 */
function SegmentIdentity({
  segment,
  trailing,
  showHost = false,
}: {
  segment: RevenueSegment;
  trailing?: React.ReactNode;
  showHost?: boolean;
}) {
  const name = segmentSourceLabel(segment.source);
  const country = countryLabel(segment.country);
  const device = deviceLabel(segment.device);
  const direct = segment.source === "";
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span
        aria-hidden="true"
        className="flex size-4 shrink-0 items-center justify-center"
      >
        {sourceMark({
          label: name,
          domain: direct ? null : resolveReferrer(segment.source).domain,
          direct,
          views: 0,
          visitors: 0,
          raw: [segment.source],
        })}
      </span>
      {showHost ? (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm">{name}</span>
          <span
            className="truncate text-xs leading-4 text-muted-foreground"
            data-segment-host=""
          >
            {segment.source}
          </span>
        </span>
      ) : (
        <span className="truncate text-sm" title={segment.source || undefined}>
          {name}
        </span>
      )}
      <span className="flex shrink-0 items-center gap-1.5" title={`${country} · ${device}`}>
        <FlagIcon className="size-3.5" code={segment.country} />
        <DeviceGlyph className="size-3.5" deviceType={segment.device} />
        <span className="sr-only">
          {country}, {device}
        </span>
      </span>
      {trailing}
    </span>
  );
}

/** The numbers the row has no room for: raw rates, buyers, orders. */
export function SegmentTip({
  segment,
  currency,
}: {
  segment: RevenueSegment;
  currency: string;
}) {
  const money = (minor: number) => formatMoney(Math.round(minor), currency);
  const lines: [string, string][] = [
    ["Visitors", segment.visitors.toLocaleString("en-US")],
    [
      "Buyers",
      `${segment.buyers.toLocaleString("en-US")} · ${formatRate(segment.conversion_rate)} raw`,
    ],
    ["New revenue", money(segment.revenue_minor)],
    [
      "Orders",
      segment.average_order_value_minor === null
        ? segment.orders.toLocaleString("en-US")
        : `${segment.orders.toLocaleString("en-US")} · ${money(segment.average_order_value_minor)} avg.`,
    ],
    [
      "Per visitor, raw",
      segment.value_per_visitor_minor === null
        ? "—"
        : money(segment.value_per_visitor_minor),
    ],
  ];
  return (
    <div className="py-0.5">
      <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
        {lines.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right tabular-nums">{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      <p className="mt-1 max-w-52 text-muted-foreground">
        {CONFIDENCE_COPY[segment.confidence]}
        {segment.unconverted_orders > 0
          ? `. ${segment.unconverted_orders} ${segment.unconverted_orders === 1 ? "order" : "orders"} with no exchange rate not counted.`
          : "."}
      </p>
    </div>
  );
}

/** A row's tooltip wrapper: the row is the focusable trigger, as on the breakdown cards. */
function WithTip({
  segment,
  currency,
  className,
  children,
}: {
  segment: RevenueSegment;
  currency: string;
  className: string;
  children: React.ReactNode;
}) {
  const row = (
    <div
      className={cn(
        className,
        "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      )}
      tabIndex={0}
    >
      {children}
    </div>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup {...ROW_TOOLTIP_PLACEMENT}>
        <SegmentTip currency={currency} segment={segment} />
      </TooltipPopup>
    </Tooltip>
  );
}

/** The overview card's row: identity, smoothed value per visitor, smoothed conversion, confidence. */
export function SegmentRow({
  segment,
  currency,
  showHost = false,
}: {
  segment: RevenueSegment;
  currency: string;
  showHost?: boolean;
}) {
  return (
    <WithTip
      className="flex items-center justify-between gap-3 py-1.5 pl-4.5 pr-4"
      currency={currency}
      segment={segment}
    >
      <SegmentIdentity segment={segment} showHost={showHost} />
      <span className="flex shrink-0 items-center gap-2">
        <span className="text-sm tabular-nums text-foreground/80">
          {perVisitor(segment.smoothed_value_per_visitor_minor, currency)}
        </span>
        <span className="w-10 text-right text-xs tabular-nums text-foreground/70">
          {formatRate(segment.smoothed_conversion_rate)}
        </span>
        <ConfidenceDot confidence={segment.confidence} />
      </span>
    </WithTip>
  );
}

/** The card's list: the house hover glide over segment rows. */
export function SegmentList({
  segments,
  currency,
}: {
  segments: readonly RevenueSegment[];
  currency: string;
}) {
  const needsHost = segmentsNeedingHost(segments);
  return (
    <HoverList>
      {segments.map((segment) => (
        <HoverRow key={segmentKey(segment)}>
          <SegmentRow
            currency={currency}
            segment={segment}
            showHost={needsHost.has(segmentKey(segment))}
          />
        </HoverRow>
      ))}
    </HoverList>
  );
}

/**
 * The card's column captions, once above the rows, at the widths the rows
 * use: the per-visitor amount, the conversion's `w-10`, the dot's `size-3`.
 */
export function SegmentListColumns() {
  return (
    <div className="flex items-center justify-between gap-3 pb-1 pl-4.5 pr-4 text-[11px] font-medium text-muted-foreground/70">
      <span>Segment</span>
      <span className="flex items-center gap-2">
        <span>Per visitor</span>
        <span className="w-10 text-right">Conv.</span>
        <span aria-hidden="true" className="size-3" />
      </span>
    </div>
  );
}

/**
 * The full table: every segment the read returned, sortable by the four
 * numbers. A container query, not a viewport one, decides the layout,
 * because the same table sits on the Revenue page's full width and in the
 * narrow See-all modal: below 32rem each segment takes a line of its own
 * and its four numbers sit under it in the header's four columns.
 */
export function SegmentsTable({
  segments,
  currency,
  sort,
  onSort,
}: {
  segments: readonly RevenueSegment[];
  currency: string;
  sort: SegmentSort;
  onSort: (sort: SegmentSort) => void;
}) {
  const needsHost = segmentsNeedingHost(segments);
  const grid =
    "grid grid-cols-4 items-center gap-x-3 @lg:grid-cols-[minmax(0,1fr)_5.5rem_5rem_6rem_5rem]";
  const cell = (sortId: SegmentSort) =>
    cn(
      "text-right text-sm tabular-nums",
      sortId === sort ? "text-foreground" : "text-foreground/70"
    );
  return (
    <div className="@container">
      <div
        className={cn(grid, "border-b border-border pb-2 pl-1 pr-2 text-xs")}
        role="row"
      >
        <span
          className="hidden text-muted-foreground @lg:block"
          role="columnheader"
        >
          Segment
        </span>
        {SEGMENT_SORTS.map((column) => (
          <span
            aria-sort={column.id === sort ? "descending" : "none"}
            className="flex justify-end"
            key={column.id}
            role="columnheader"
          >
            <button
              className={cn(
                "-mr-1.5 cursor-pointer whitespace-nowrap rounded-full px-1.5 py-0.5 font-medium outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                column.id === sort
                  ? "text-foreground"
                  : "text-muted-foreground"
              )}
              onClick={() => onSort(column.id)}
              type="button"
            >
              {column.label}
            </button>
          </span>
        ))}
      </div>
      <HoverList className="flex flex-col">
        {sortSegments(segments, sort).map((segment) => (
          <HoverRow
            className="border-b border-border/60 last:border-b-0"
            key={segmentKey(segment)}
          >
            <WithTip
              className={cn(grid, "gap-y-1.5 py-2.5 pl-1 pr-2")}
              currency={currency}
              segment={segment}
            >
              <span className="col-span-4 flex min-w-0 @lg:col-span-1">
                <SegmentIdentity
                  segment={segment}
                  showHost={needsHost.has(segmentKey(segment))}
                  trailing={<ConfidenceDot confidence={segment.confidence} />}
                />
              </span>
              <span className={cell("value")}>
                {perVisitor(segment.smoothed_value_per_visitor_minor, currency)}
              </span>
              <span className={cell("conversion")}>
                {formatRate(segment.smoothed_conversion_rate)}
              </span>
              <span className={cell("revenue")}>
                {formatMoney(segment.revenue_minor, currency)}
              </span>
              <span className={cell("visitors")}>
                {segment.visitors.toLocaleString("en-US")}
              </span>
            </WithTip>
          </HoverRow>
        ))}
      </HoverList>
    </div>
  );
}

/** The ⓘ beside the title. */
export function SmoothingInfo() {
  return <InfoTip text={SMOOTHING_NOTE} width="w-64" />;
}

/** How many segments were too small to show; nothing when none were. */
export function SegmentsHiddenNote({
  hidden,
  minVisitors,
  className,
}: {
  hidden: number;
  minVisitors: number;
  className?: string;
}) {
  if (hidden <= 0) return null;
  return (
    <p className={cn("text-xs leading-5 text-muted-foreground", className)}>
      {hidden.toLocaleString("en-US")} {hidden === 1 ? "segment" : "segments"}{" "}
      with fewer than {minVisitors} visitors {hidden === 1 ? "is" : "are"} not
      shown.
    </p>
  );
}

/**
 * The table's small print: a cut list says it is the top of a longer one,
 * then the segments too small to show, then the buyers the rates leave out
 * because their last visit was not in the range. Nothing when none applies.
 */
export function SegmentsSmallPrint({
  data,
  className,
}: {
  data: Pick<
    RevenueSegmentsResponse,
    "meta" | "site" | "segments" | "hidden_segments" | "thresholds"
  >;
  className?: string;
}) {
  const leftOut = leftOutBuyersCopy(data.site);
  const truncated = data.meta.truncated && data.segments.length > 0;
  if (!truncated && data.hidden_segments <= 0 && leftOut === null) return null;
  return (
    <div className={cn("flex flex-col", className)}>
      {truncated ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {truncatedCopy(data.segments.length)}
        </p>
      ) : null}
      <SegmentsHiddenNote
        hidden={data.hidden_segments}
        minVisitors={data.thresholds.min_segment_visitors}
      />
      {leftOut === null ? null : (
        <p className="text-xs leading-5 text-muted-foreground">{leftOut}</p>
      )}
    </div>
  );
}

/** Under the buyer minimum: the counts, and what would change the answer. */
export function SegmentsInsufficient({
  data,
  className,
}: {
  data: Pick<RevenueSegmentsResponse, "site" | "thresholds">;
  className?: string;
}) {
  const copy = insufficientDataCopy(data);
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <p className="text-sm font-medium text-foreground/80">{copy.title}</p>
      <p className="text-sm leading-6 text-muted-foreground">{copy.body}</p>
    </div>
  );
}
