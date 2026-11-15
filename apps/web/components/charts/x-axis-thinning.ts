/**
 * Drops x-axis labels that would overlap their neighbour. Ticks are chosen by
 * time (round hours, evenly spaced data rows), not by how wide their labels
 * are, so on a narrow chart two of them can land on each other: "Jun 20Jun 27"
 * at 390px, where the first label is also clamped inward to stay inside the
 * plot. This keeps the first label, skips any that would touch the last one
 * kept, and swaps in the range's final label when it would be skipped.
 *
 * Widths are estimated from the label's length rather than measured: the axis
 * labels are one size and short, and an estimate keeps this pure.
 */

/** Average advance of a `text-xs` axis character, rounded up. */
const CHAR_WIDTH_PX = 7;
/** Clear space kept between two labels. */
const MIN_GAP_PX = 8;

/** Where `XAxisLabel` draws a label: inside `[edgePad, clampWidth - edgePad]`. */
export function clampLabelX(x: number, clampWidth: number, edgePad: number): number {
  return clampWidth > edgePad * 2
    ? Math.min(Math.max(x, edgePad), clampWidth - edgePad)
    : x;
}

export function thinAxisLabels<T extends { x: number; label: string }>(
  ticks: readonly T[],
  options: { clampWidth: number; edgePad: number }
): T[] {
  if (ticks.length <= 1) return [...ticks];
  const { clampWidth, edgePad } = options;
  const span = (tick: T) => {
    const centre = clampLabelX(tick.x, clampWidth, edgePad);
    const half = (tick.label.length * CHAR_WIDTH_PX) / 2;
    return { left: centre - half, right: centre + half };
  };
  const fitsAfter = (previous: T | undefined, tick: T) =>
    previous === undefined || span(tick).left >= span(previous).right + MIN_GAP_PX;

  const kept: T[] = [];
  for (const tick of ticks) {
    if (fitsAfter(kept.at(-1), tick)) kept.push(tick);
  }

  // The end of the range says more than the label before it.
  const last = ticks.at(-1);
  if (last !== undefined && kept.at(-1) !== last) {
    while (kept.length > 1 && !fitsAfter(kept.at(-1), last)) kept.pop();
    if (kept.length > 1 || fitsAfter(kept[0], last)) kept.push(last);
  }
  return kept;
}
