import type { ReactNode } from "react";
import { revenueTooltipModel, type RevenueBucket } from "@/lib/chart-revenue";
import { MentionGlyph, SaleGlyph } from "./chart-marker-glyphs";

/**
 * The overview chart's day tooltip: what one bucket held, in sections read top
 * to bottom: when, traffic, money, and what happened (sales and mentions).
 *
 * Presentational and pure so its rules are tested by rendering it. The width
 * is fixed, so the panel does not jump as the cursor scrubs from a quiet day
 * to one with revenue; only its height follows the sections present.
 */

// Our palette: visitors in the brand primary, pageviews a quiet slate underlay.
export const VISITORS_COLOR = "#296FF0";
export const PAGEVIEWS_COLOR = "#94a3b8";

const intFmt = new Intl.NumberFormat("en-US");

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

export type OverviewTooltipContentProps = {
  /** The bucket's name, already formatted in the chart's zone and grain. */
  title: string;
  visitors: number;
  pageviews: number;
  /** This bucket's revenue; `null` when the layer is off, hidden or unreadable. */
  revenue: RevenueBucket | null;
  /** Marker counts for the bucket, after the legend's show/hide choice. */
  sales: number;
  mentions: number;
  /** A dashboard filter narrows the traffic; revenue stays site-wide. */
  filtered?: boolean;
};

function Section({ children }: { children: ReactNode }) {
  return <div className="border-t border-white/10 px-3 py-2.5">{children}</div>;
}

function Row({
  label,
  value,
  dot,
}: {
  label: ReactNode;
  value: string;
  dot?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex min-w-0 items-center gap-2 text-chart-tooltip-muted">
        {dot ? (
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: dot }} />
        ) : null}
        <span className="truncate">{label}</span>
      </span>
      <span className="shrink-0 font-medium tabular-nums text-chart-tooltip-foreground">
        {value}
      </span>
    </div>
  );
}

export function OverviewTooltipContent({
  title,
  visitors,
  pageviews,
  revenue,
  sales,
  mentions,
  filtered = false,
}: OverviewTooltipContentProps) {
  const money = revenue ? revenueTooltipModel(revenue, visitors, { filtered }) : null;
  const hasMarkers = sales > 0 || mentions > 0;

  return (
    <div className="w-56 select-none text-xs text-chart-tooltip-foreground">
      <div className="px-3 pt-2.5 pb-2 font-medium">{title}</div>

      <Section>
        <div className="flex flex-col gap-1.5">
          <Row dot={VISITORS_COLOR} label="Visitors" value={intFmt.format(visitors)} />
          <Row dot={PAGEVIEWS_COLOR} label="Pageviews" value={intFmt.format(pageviews)} />
        </div>
      </Section>

      {money ? (
        <Section>
          <p className="text-chart-tooltip-muted">Revenue</p>
          <p className="mt-0.5 text-lg font-medium leading-6 tabular-nums">{money.net}</p>
          {money.lines.length > 0 ? (
            <div className="mt-1.5 flex flex-col gap-1">
              {money.lines.map((line) => (
                <Row key={line.label} label={line.label} value={line.value} />
              ))}
            </div>
          ) : null}
        </Section>
      ) : null}

      {hasMarkers ? (
        <Section>
          <div className="flex flex-col gap-1.5">
            {sales > 0 ? (
              <p className="flex items-center gap-2">
                <span className="flex size-2 items-center justify-center">
                  <SaleGlyph />
                </span>
                {plural(sales, "sale", "sales")}
              </p>
            ) : null}
            {mentions > 0 ? (
              <p className="flex items-center gap-2">
                <span className="flex size-2 items-center justify-center">
                  <MentionGlyph />
                </span>
                {plural(mentions, "mention", "mentions")}
              </p>
            ) : null}
          </div>
        </Section>
      ) : null}

      {money && money.notes.length > 0 ? (
        <Section>
          {money.notes.map((note) => (
            <p className="leading-5 text-chart-tooltip-muted" key={note}>
              {note}
            </p>
          ))}
        </Section>
      ) : null}
    </div>
  );
}
