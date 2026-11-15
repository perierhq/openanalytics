/**
 * The window the overview chart may draw in, from the response's meta.
 *
 * Three readers need the same answer: the zero-fill (no buckets for time that
 * has not happened), the revenue and marker layers (nothing past the last
 * traffic bucket), and the relative-time pill ("Today" means the day the data
 * was read on).
 */

export type ChartWindow = {
  /** Exclusive end of the plotted buckets: the range's end, capped at `as_of`. */
  untilMs: number;
  /** Where the revenue and marker layers stop. */
  layerEndMs: number;
  /** The moment "now" means for relative labels. */
  readAtMs: number;
};

export function chartWindow(input: {
  /** `meta.freshness.as_of`; the public share meta has none. */
  asOf: string | undefined;
  /** `meta.effective_range.to`. */
  effectiveTo: string;
  /** The requested range's end. */
  toMs: number;
  /** The browser's clock, for a meta without `as_of`. */
  nowMs: number;
}): ChartWindow {
  const { asOf, effectiveTo, toMs, nowMs } = input;
  // The public meta has no `freshness` at all (D-213); the effective range's
  // end is then the only honest cap for the zero-fill.
  const asOfMs = Date.parse(asOf ?? effectiveTo);
  const untilMs = Number.isNaN(asOfMs) ? toMs : Math.min(toMs, asOfMs);
  // Without `as_of`, the effective end of "today" or "last 7 days" is
  // tomorrow's midnight, and counting from there turns today into
  // "Yesterday". The browser's clock stands in, never past the range's end.
  const readAtMs =
    asOf !== undefined ? Date.parse(asOf) : Math.min(nowMs, Date.parse(effectiveTo));
  // The layers end where the plotted buckets do: a sale or a revenue point
  // past the last traffic bucket is dropped, not folded into that bucket.
  return { untilMs, layerEndMs: untilMs, readAtMs };
}
