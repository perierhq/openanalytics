import type { BarSegment, BarTone } from "@/lib/row-bars";
import { cn } from "@/lib/utils";

/**
 * The bar behind a breakdown row: from the row's left edge, as wide as the
 * row's share of the largest row, in a light tint of the accent; a revenue
 * segment, where the card shows revenue, in the same tint of the success
 * green. The hovered row's bar deepens a step and nothing else in the list
 * changes.
 *
 * Rendered as a direct child of the row's `<li>` (through `HoverRow`'s
 * `backdrop`), so a list that rounds its rows (`[&>li>span]:rounded-…`, the
 * See all modal) clips the bar to the row's own shape: the start rounds with
 * the row, and a short bar never turns into a pill. It sits above the white hover
 * glide and below the row's text, and the text colours in `BreakdownRow` are
 * chosen to stay AA on the deeper hover tint.
 */
const TONE: Record<BarTone, string> = {
  traffic: "bg-primary/10 group-hover:bg-primary/14",
  revenue: "bg-success/10 group-hover:bg-success/14",
};

const percent = (fraction: number) => `${Math.round(fraction * 10_000) / 100}%`;

export function RowBar({
  segments,
  className,
}: {
  segments: readonly BarSegment[];
  /** The row's own rounding, for a row that is not in a `HoverList`. */
  className?: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.fraction, 0);
  if (!(total > 0)) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 inset-y-px overflow-hidden",
        className
      )}
    >
      <span
        className="flex h-full"
        style={{ width: percent(Math.min(1, total)) }}
      >
        {segments.map((segment) => (
          <span
            className={`h-full transition-colors ${TONE[segment.tone]}`}
            key={segment.tone}
            style={{ width: percent(segment.fraction / total) }}
          />
        ))}
      </span>
    </span>
  );
}
