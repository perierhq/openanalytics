/**
 * The scrub dim's cut: while hovering, everything right of the hovered
 * bucket's right edge (halfway to the next point) fades. One answer for the
 * series' mask (`time-series-chart-shell.tsx`) and the event markers, so
 * the two always dim at the same x. Null when there is no dim: no dim
 * opacity, no hover, a selection being dragged, or a chart that cannot be
 * used yet (loading, revealing).
 */
export function scrubDimCut({
  dimOpacity,
  canInteract,
  tooltipX,
  selecting,
  innerWidth,
  columnWidth,
}: {
  dimOpacity: number | null | undefined;
  canInteract: boolean;
  /** The hovered bucket's x in plot coordinates, or null without a hover. */
  tooltipX: number | null | undefined;
  /** A drag selection is active. */
  selecting: boolean;
  innerWidth: number;
  columnWidth: number;
}): number | null {
  if (dimOpacity == null || !canInteract || tooltipX == null || selecting) return null;
  return Math.min(innerWidth, tooltipX + columnWidth / 2);
}
