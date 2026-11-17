"use client";

import { motion } from "motion/react";
import { useChartStable, useYScale } from "@/components/charts/chart-context";
import { useAxisWidth } from "@/components/dashboard/use-axis-width";
import { RIGHT_AXIS_GAP } from "@/lib/chart-axis";

const SERIES_PHASES = new Set(["revealing", "ready", "exitingReady"]);

/**
 * A few labels for the chart's own y-axis, in the language of the series
 * drawn: "36%", "1m 24s". The traffic chart has none (its counts read off the
 * tooltip); a rate or a duration does, because its scale is not obvious from
 * the shape. Drawn the way the revenue bars' axis is: outside the series clip
 * like the x-axis, right of the plot in the room the chart leaves for it
 * (`rightAxisMargin`), whose width it learns from `onWidth`.
 */
export function ChartValueAxis({
  format,
  onWidth,
}: {
  format: (value: number) => string;
  /** The widest label's width in px, measured once drawn. */
  onWidth?: (px: number) => void;
}) {
  const { innerWidth, chartPhase } = useChartStable();
  const yScale = useYScale();
  // Zero needs no label, and a tick at the very top would sit in the chips' row.
  const ticks = yScale
    .ticks(3)
    .filter((tick) => tick > 0 && (yScale(tick) ?? 0) >= 16);
  const drawn = SERIES_PHASES.has(chartPhase);
  const ref = useAxisWidth(drawn ? ticks.map(format).join("|") : "", onWidth);
  if (!drawn) return null;
  return (
    <motion.g
      ref={ref}
      animate={{ opacity: 1 }}
      initial={{ opacity: 0 }}
      pointerEvents="none"
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      {ticks.map((tick) => (
        <text
          className="tabular-nums"
          fill="var(--muted-foreground)"
          fillOpacity={0.8}
          fontSize={10}
          key={tick}
          textAnchor="start"
          x={innerWidth + RIGHT_AXIS_GAP}
          y={(yScale(tick) ?? 0) - 4}
        >
          {format(tick)}
        </text>
      ))}
    </motion.g>
  );
}
ChartValueAxis.__isClipExcluded = true;
