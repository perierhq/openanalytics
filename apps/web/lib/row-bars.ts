/**
 * The bars behind breakdown rows: how wide each row's bar is.
 *
 * A bar is a *scale*, so it is drawn against the largest row in the list, and
 * the first row of a ranking fills the row. That is the opposite of the
 * printed `pct` beside it (`breakdownShare`), whose denominator is the sum of
 * the rows: a printed number has to be true on its own, a bar only has to
 * compare rows with each other.
 */

/** What a segment of the bar stands for, which decides its colour. */
export type BarTone = "traffic" | "revenue";

export type BarSegment = {
  tone: BarTone;
  /** Of the row's full width, in `[0, 1]`. */
  fraction: number;
};

const finite = (value: number): number =>
  Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Each value as a fraction of the largest. A list whose largest value is zero
 * (or that is empty) draws no bars rather than dividing by zero, and a
 * negative or broken value draws nothing rather than a bar going backwards.
 */
export function barScale(values: readonly number[]): (value: number) => number {
  const max = values.reduce((largest, value) => Math.max(largest, finite(value)), 0);
  if (max <= 0) return () => 0;
  return (value) => Math.min(1, finite(value) / max);
}

/**
 * Bars of two segments: the row's traffic share, and its revenue share beside
 * it. Each part is scaled against its own largest row, so a source with the
 * most visitors and the most revenue would read as two full halves; the sum is
 * then scaled so the fullest row fills the width, and nothing overflows it.
 *
 * `lead` is the measure the rows are sorted by, and its segment comes first.
 * Without revenue on any row this is `barScale` with one segment per row.
 */
export function stackedBars(
  rows: readonly { traffic: number; revenue: number | null }[],
  lead: BarTone
): BarSegment[][] {
  const traffic = barScale(rows.map((row) => row.traffic));
  const revenue = barScale(rows.map((row) => row.revenue ?? 0));
  const shares = rows.map((row) => ({
    traffic: traffic(row.traffic),
    revenue: revenue(row.revenue ?? 0),
  }));
  const fullest = shares.reduce(
    (largest, share) => Math.max(largest, share.traffic + share.revenue),
    0
  );
  return shares.map((share) => {
    if (fullest <= 0) return [];
    const segments: BarSegment[] = [
      { tone: "traffic", fraction: share.traffic / fullest },
      { tone: "revenue", fraction: share.revenue / fullest },
    ];
    if (lead === "revenue") segments.reverse();
    return segments.filter((segment) => segment.fraction > 0);
  });
}

/**
 * `barScale` as one-segment bars, for the cards that show traffic alone: the
 * function a list builds once and calls per row.
 */
export function trafficBars(
  values: readonly number[]
): (value: number) => BarSegment[] {
  const scale = barScale(values);
  return (value) => {
    const fraction = scale(value);
    return fraction > 0 ? [{ tone: "traffic", fraction }] : [];
  };
}
