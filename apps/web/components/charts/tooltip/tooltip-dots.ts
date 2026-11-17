/**
 * The series that get a dot at the hovered bucket: those with a position
 * there. A series whose point has no number for its key (a previous period
 * shorter than the current one, a session line through an empty bucket) has
 * no position, and a dot for it would be drawn at y = 0, the top of the plot.
 */
export function linesWithDots<T extends { dataKey: string }>(
  lines: readonly T[],
  yPositions: Readonly<Record<string, number>> | undefined
): T[] {
  if (!yPositions) return [];
  return lines.filter((line) => Number.isFinite(yPositions[line.dataKey]));
}
