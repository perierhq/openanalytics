/**
 * Stacking inside a chart's container, for the layers drawn over the plot.
 * The crosshair's line has none and paints under both; the event markers
 * sit over it, and the crosshair's dots over the markers, so the crosshair
 * runs behind a marker on the line while the hovered point stays in view.
 */
export const CHART_LAYER_Z = {
  markers: 1,
  crosshairDots: 2,
} as const;
