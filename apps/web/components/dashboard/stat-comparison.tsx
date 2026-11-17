import { ArrowDownRight01Icon, ArrowUpRight01Icon } from "hugeicons-react";
import type { Delta } from "@/lib/overview-compare";
import { cn } from "@/lib/utils";

/**
 * The line under a stat tile's number while the overview compares: the
 * change as a small chip, then the previous period's value.
 *
 * The chip carries an arrow as well as a colour, so the direction never
 * rests on colour alone, and a screen reader hears the whole sentence
 * instead of a glyph. Only a tile with a verdict (bounce rate) is coloured;
 * everything else stays neutral in both directions.
 */
const TONE_CLASS: Record<Delta["tone"], string> = {
  neutral: "bg-foreground/[0.06] text-foreground/70",
  good: "bg-success/10 text-success-foreground",
  bad: "bg-destructive/10 text-destructive-foreground",
};

function spokenDelta(delta: Delta, previous: string): string {
  // A previous session tile with no sessions prints a dash for its value.
  if (previous === "—") return "No visits in the previous period to compare with";
  const amount = delta.label.replace(/^[+−]/, "").replace(/ pts$/, " points");
  const from = `from ${previous} in the previous period`;
  if (delta.direction === "up") return `Up ${amount} ${from}`;
  if (delta.direction === "down") return `Down ${amount} ${from}`;
  if (delta.direction === "flat") return `No change ${from}`;
  return `No percentage change: the previous period was ${previous}`;
}

export function StatComparison({
  delta,
  previous,
}: {
  delta: Delta;
  /** The previous period's value, formatted the way the tile formats its own. */
  previous: string;
}) {
  const Arrow =
    delta.direction === "up"
      ? ArrowUpRight01Icon
      : delta.direction === "down"
        ? ArrowDownRight01Icon
        : null;
  return (
    <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs leading-5">
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 font-medium tabular-nums",
          TONE_CLASS[delta.tone]
        )}
        data-direction={delta.direction ?? "none"}
        data-tone={delta.tone}
      >
        {Arrow ? <Arrow className="-ml-0.5 size-3" strokeWidth={2} /> : null}
        {delta.label}
      </span>
      <span aria-hidden="true" className="truncate tabular-nums text-muted-foreground">
        vs {previous}
      </span>
      <span className="sr-only">
        {spokenDelta(delta, previous)}
      </span>
    </p>
  );
}
