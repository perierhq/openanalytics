"use client";

import { ArrowDown01Icon } from "hugeicons-react";
import type * as React from "react";
import { HoverRow } from "@/components/dashboard/hover-list";
import { RowBar } from "@/components/dashboard/row-bar";
import {
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { BarSegment } from "@/lib/row-bars";

/**
 * Where a row's tooltip opens: below the row, at its right end under the
 * numbers it explains. Never above, not even for a row near the viewport's
 * bottom: the first rows sit right under the card header, and a tooltip on
 * top of them covered the header's sort toggle. Sideways it shifts to stay
 * clear of the viewport's edge, by the collision padding.
 */
export const ROW_TOOLTIP_PLACEMENT = {
  side: "bottom",
  align: "end",
  sideOffset: 2,
  collisionPadding: 8,
  collisionAvoidance: { side: "none", align: "shift" },
} as const;

/**
 * A row's revenue cell: the compact amount in the success green, named for a
 * screen reader, or an empty cell for a row without revenue so the amounts
 * stay one right-aligned column. At least the column's width, and wider for a
 * long amount ("CHF 12.3K") rather than wrapping or spilling.
 */
export function RevenueAmount({ amount }: { amount: string | null }) {
  return (
    <span className="min-w-14 whitespace-nowrap text-right text-sm tabular-nums text-success-foreground">
      {amount !== null ? (
        <>
          <span className="sr-only">revenue </span>
          {amount}
        </>
      ) : null}
    </span>
  );
}

/** Shared row for simple name/value breakdowns (moved off the mock page). */
export function BreakdownRow({
  name,
  value,
  pct,
  icon,
  onSelect,
  bar,
  revenue,
  trailing,
  tooltip,
  expanded,
  onToggle,
  details,
  reserveExpander,
}: {
  name: string;
  value: string;
  pct?: number;
  /** A real mark (flag, favicon, browser glyph) in place of the dot. Sits
   *  in a fixed 16px box so mixed marks in one list stay aligned. */
  icon?: React.ReactNode;
  /**
   * Makes the row a filter door: the whole row becomes a button, the name
   * underlines under the pointer so the affordance is visible before the
   * press, and the press adds this row's value to the chip row (ADR-0075:
   * row → chip is the entire discovery mechanism, there is no separate
   * filter picker). Absent, the row renders exactly as before, which is
   * what every non-filterable cut (UTM views, browsers, OS) passes.
   */
  onSelect?: () => void;
  /** The bar behind the row (`stackedBars` / `barScale`); none when absent. */
  bar?: readonly BarSegment[];
  /**
   * The revenue column, on the cards that show revenue: the amount, or
   * `null` for a row that has none (the column keeps its width, so the
   * amounts stay one right-aligned column). Absent, there is no column.
   */
  revenue?: string | null;
  /**
   * One more figure after the revenue column, on the cards that carry a
   * ratio of the two (Ad campaigns: ROAS). Absent, there is no column.
   */
  trailing?: React.ReactNode;
  /** A light tooltip on the row, for the numbers the row has no room for. */
  tooltip?: React.ReactNode;
  /**
   * Makes the row an expander: the whole row toggles `details` open below
   * it, a chevron at its end turns with it. Given only to a row that has
   * something to show, so no row ever opens onto nothing. Not combined with
   * `onSelect`: a row is a filter door or an expander, never both.
   */
  onToggle?: () => void;
  expanded?: boolean;
  /** What an open expander shows under the row. */
  details?: React.ReactNode;
  /** Keeps the chevron's width on a row without one, so a list that mixes
   *  expanders and plain rows keeps its numbers in one column. */
  reserveExpander?: boolean;
}) {
  const body = (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-3">
        {icon !== undefined ? (
          <span
            aria-hidden="true"
            className="flex size-4 shrink-0 items-center justify-center"
          >
            {icon}
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-primary/50 transition-colors group-hover:bg-primary"
          />
        )}
        <span
          className={
            "truncate text-sm" +
            (onSelect !== undefined
              ? " underline-offset-2 group-hover:underline"
              : "")
          }
        >
          {name}
        </span>
      </span>
      {/* The numbers sit on the row's bar, so they are a step darker than
          muted: AA on the hover tint as well as on the grey. */}
      <span className="flex items-baseline gap-2">
        <span className="text-sm tabular-nums text-foreground/80">
          {value}
        </span>
        {pct !== undefined && (
          <span className="w-10 text-right text-xs tabular-nums text-foreground/70">
            {pct}%
          </span>
        )}
        {revenue !== undefined && <RevenueAmount amount={revenue} />}
        {onToggle === undefined && reserveExpander === true && (
          <span aria-hidden="true" className="w-3.5 shrink-0" />
        )}
        {onToggle !== undefined && (
          <ArrowDown01Icon
            aria-hidden="true"
            className={
              "size-3.5 shrink-0 self-center text-muted-foreground/60 transition-transform duration-200" +
              (expanded === true ? " rotate-180" : "")
            }
          />
        )}
        {trailing !== undefined && trailing}
      </span>
    </>
  );

  /* pl-4.5 with a mark: the 16px mark's centre lands a hair right of
     the dots' centre, tuned by eye against the header icon. */
  const rowClass =
    "flex items-center justify-between gap-4 py-1.5 pr-5 " +
    (icon !== undefined ? "pl-4.5" : "pl-5");

  const row =
    onToggle !== undefined ? (
      <button
        aria-expanded={expanded === true}
        className={
          rowClass +
          " w-full cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        }
        onClick={onToggle}
        type="button"
      >
        {body}
      </button>
    ) : onSelect !== undefined ? (
      <button
        aria-label={`Filter by ${name}`}
        className={
          rowClass +
          " w-full cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        }
        onClick={onSelect}
        type="button"
      >
        {body}
      </button>
    ) : tooltip !== undefined ? (
      // A plain row with a tooltip is its trigger: focusable, so a keyboard
      // reaches the numbers, and a tap focuses it on a touch screen.
      <div
        className={
          rowClass +
          " outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        }
        tabIndex={0}
      >
        {body}
      </div>
    ) : (
      <div className={rowClass}>{body}</div>
    );

  const hoverRow = (
    <HoverRow
      backdrop={bar !== undefined ? <RowBar segments={bar} /> : undefined}
    >
      {tooltip !== undefined ? (
        <Tooltip>
          <TooltipTrigger render={row} />
          <TooltipPopup {...ROW_TOOLTIP_PLACEMENT}>
            {tooltip}
          </TooltipPopup>
        </Tooltip>
      ) : (
        row
      )}
    </HoverRow>
  );

  // The details are the row's next sibling rather than part of it, so the
  // row's bar and the list's hover glide stay the height of the row.
  return onToggle !== undefined && expanded === true ? (
    <>
      {hoverRow}
      <li className="pb-1.5">{details}</li>
    </>
  ) : (
    hoverRow
  );
}
