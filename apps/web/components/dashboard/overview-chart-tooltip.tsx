import type { ReactNode } from "react";
import type { Mention } from "@/lib/api";
import { revenueTooltipModel, type RevenueBucket } from "@/lib/chart-revenue";
import { MentionGlyph, NoteGlyph, SaleGlyph } from "./chart-marker-glyphs";
import { UserAvatar } from "@/components/ui/user-avatar";
import { MentionAvatar } from "./mention-avatar";

/**
 * The overview chart's day tooltip: what one bucket held, in sections read top
 * to bottom: when, traffic, money, and what happened (sales, mentions and
 * notes).
 *
 * Presentational and pure so its rules are tested by rendering it. The width
 * is fixed, so the panel does not jump as the cursor scrubs from a quiet day
 * to one with revenue; only its height follows the sections present.
 */

// Our palette: visitors in the brand primary, pageviews a quiet slate underlay.
export const VISITORS_COLOR = "#296FF0";
export const PAGEVIEWS_COLOR = "#94a3b8";
// The session metrics, when their tile drives the chart: two chart tokens
// apart from the traffic blue and the revenue green.
export const BOUNCE_RATE_COLOR = "var(--chart-5)";
export const AVG_VISIT_COLOR = "var(--chart-2)";

const intFmt = new Intl.NumberFormat("en-US");

/** Faces before a sale or mention count; the count says how many there are. */
const TOOLTIP_FACES = 3;

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
  /** Notes pinned in the bucket; the popover on the marker shows their text. */
  notes?: number;
  /**
   * The bucket's buyers' anonymous ids, distinct, newest sale first; the
   * first three are drawn as small faces before the count, the same faces the
   * realtime views draw (see `lib/marker-faces.ts`). Sales that matched no
   * visitor have none.
   */
  saleVisitors?: readonly string[];
  /**
   * Who wrote the bucket's mentions, ranked, pictures only; the first three
   * are drawn as small faces before the count.
   */
  mentionAuthors?: ReadonlyArray<Pick<Mention["author"], "handle" | "name" | "avatar_url">>;
  /** A dashboard filter narrows the traffic; revenue stays site-wide. */
  filtered?: boolean;
  /**
   * Which traffic series the chart is drawing, and so which rows the traffic
   * section has. Both by default; one when a tile drives the chart; none when
   * revenue does, and the section goes.
   */
  series?: readonly TrafficSeries[];
  /**
   * The previous period's bucket that sits under this one (bucket i with
   * bucket i), while the overview compares. `label` names that bucket's own
   * date, since it is not the date in the title.
   */
  previous?: { label: string; visitors: number; pageviews: number } | null;
  /**
   * A session metric (bounce rate, average visit) when its tile drives the
   * chart: one row, already formatted, and its previous-period value while
   * comparing. Shown in the traffic section's place.
   */
  session?: {
    label: string;
    color: string;
    value: string;
    previous: { label: string; value: string } | null;
  } | null;
};

export type TrafficSeries = "visitors" | "pageviews";

const ALL_SERIES: readonly TrafficSeries[] = ["visitors", "pageviews"];

const SERIES_ROWS: Record<TrafficSeries, { label: string; color: string }> = {
  visitors: { label: "Visitors", color: VISITORS_COLOR },
  pageviews: { label: "Pageviews", color: PAGEVIEWS_COLOR },
};

function Section({ children }: { children: ReactNode }) {
  return <div className="border-t border-white/10 px-3 py-2.5">{children}</div>;
}

function Row({
  label,
  value,
  dot,
  dash,
}: {
  label: ReactNode;
  value: string;
  dot?: string;
  /** A short dashed stroke in the series colour: the previous period's line. */
  dash?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex min-w-0 items-center gap-2 text-chart-tooltip-muted">
        {dot ? (
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: dot }} />
        ) : null}
        {dash ? (
          <span
            aria-hidden="true"
            className="w-2 shrink-0 border-t-[1.5px] border-dashed"
            style={{ borderColor: dash }}
          />
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
  notes = 0,
  saleVisitors = [],
  mentionAuthors = [],
  filtered = false,
  series = ALL_SERIES,
  previous = null,
  session = null,
}: OverviewTooltipContentProps) {
  const counts: Record<TrafficSeries, number> = { visitors, pageviews };
  const money = revenue ? revenueTooltipModel(revenue, visitors, { filtered }) : null;
  const hasMarkers = sales > 0 || mentions > 0 || notes > 0;

  return (
    <div className="w-56 select-none text-xs text-chart-tooltip-foreground">
      <div className="px-3 pt-2.5 pb-2 font-medium">{title}</div>

      {series.length > 0 ? (
        <Section>
          <div className="flex flex-col gap-1.5">
            {series.map((key) => (
              <div className="flex flex-col gap-1" key={key}>
                <Row
                  dot={SERIES_ROWS[key].color}
                  label={SERIES_ROWS[key].label}
                  value={intFmt.format(counts[key])}
                />
                {previous ? (
                  <Row
                    dash={SERIES_ROWS[key].color}
                    label={`Previous · ${previous.label}`}
                    value={intFmt.format(previous[key])}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {session ? (
        <Section>
          <div className="flex flex-col gap-1">
            <Row dot={session.color} label={session.label} value={session.value} />
            {session.previous ? (
              <Row
                dash={session.color}
                label={`Previous · ${session.previous.label}`}
                value={session.previous.value}
              />
            ) : null}
          </div>
        </Section>
      ) : null}

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
                  <SaleGlyph tone="dark" />
                </span>
                {saleVisitors.length > 0 ? (
                  <span className="flex -space-x-1">
                    {saleVisitors.slice(0, TOOLTIP_FACES).map((visitor) => (
                      <span className="flex rounded-full ring-1 ring-black/50" key={visitor}>
                        <UserAvatar seed={visitor} size={16} />
                      </span>
                    ))}
                  </span>
                ) : null}
                {plural(sales, "sale", "sales")}
              </p>
            ) : null}
            {mentions > 0 ? (
              <p className="flex items-center gap-2">
                <span className="flex size-2 items-center justify-center">
                  <MentionGlyph tone="dark" />
                </span>
                {mentionAuthors.length > 0 ? (
                  <span className="flex -space-x-1">
                    {mentionAuthors.slice(0, TOOLTIP_FACES).map((author) => (
                      <MentionAvatar
                        author={author}
                        className="ring-1 ring-black/50"
                        key={author.handle}
                        size={16}
                        tone="dark"
                      />
                    ))}
                  </span>
                ) : null}
                {plural(mentions, "mention", "mentions")}
              </p>
            ) : null}
            {notes > 0 ? (
              <p className="flex items-center gap-2">
                <span className="flex size-2 items-center justify-center">
                  <NoteGlyph tone="dark" />
                </span>
                {plural(notes, "note", "notes")}
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
