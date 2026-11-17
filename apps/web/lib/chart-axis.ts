/**
 * Room for the overview chart's right-hand axis: the session metric's value
 * labels ("36%", "1m 40s") or the revenue bars' money labels ("$1.2k").
 *
 * The plot used to run edge to edge with the labels laid over its right end,
 * where the series ran under them and the widest label could be cut by the
 * card. When a right axis is drawn, the plot gives up a margin as wide as the
 * widest label (measured off the rendered text) plus a gap, and the labels sit
 * in it. Without a right axis the plot stays flush with the card.
 */

/** Between the plot's right edge and the labels. */
export const RIGHT_AXIS_GAP = 8;
/** After the labels, before the card's edge. */
const RIGHT_AXIS_PAD = 6;
/** Until the labels are measured: about six characters at 10px. */
const UNMEASURED_LABEL_PX = 36;

export function rightAxisMargin(drawn: boolean, widestLabelPx: number | null): number {
  if (!drawn) return 0;
  const label = widestLabelPx === null ? UNMEASURED_LABEL_PX : Math.ceil(widestLabelPx);
  return RIGHT_AXIS_GAP + label + RIGHT_AXIS_PAD;
}
