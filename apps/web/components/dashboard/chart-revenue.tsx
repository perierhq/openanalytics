"use client";

import { scaleLinear } from "@visx/scale";
import { motion } from "motion/react";
import * as React from "react";
import { useChartStable } from "@/components/charts/chart-context";
import { liveRevenueState } from "@/components/dashboard/chart-markers";
import { useSiteSummary } from "@/components/dashboard/site-summary-context";
import { useApiResource } from "@/hooks/use-api-resource";
import {
  LIVE_API,
  revenue,
  type AnalyticsRange,
  type RevenueConnectionState,
  type RevenueTimeseriesPoint,
} from "@/lib/api";
import {
  loadChartRevenue,
  revenueBarMax,
  type ChartGrain,
  type ChartRevenueDeps,
  type RevenueModel,
} from "@/lib/chart-revenue";
import { formatMoneyCompact } from "@/lib/currencies";
import { MOCK_REVENUE_TIMESERIES } from "@/lib/mock";

/**
 * Revenue bars behind the overview chart's traffic: one bar per bucket, its
 * height the bucket's net on a scale of its own, read off a right-hand axis.
 *
 * The rules (who may read, which grain, how days become weeks, which currency)
 * live in `lib/chart-revenue.ts`; this file is the read and the drawing.
 */

/* ------------------------------------------------------------------ */
/* The read                                                            */
/* ------------------------------------------------------------------ */

const LIVE_DEPS: ChartRevenueDeps = {
  // Shared with the sale markers: one connection read per site, not one each.
  revenueState: liveRevenueState,
  revenueTimeseries: (siteId, range, options) =>
    revenue.timeseries(siteId, range, options),
};

/** Mock mode: connected, like the revenue card's mock story; the role gate still applies. */
const MOCK_DEPS: ChartRevenueDeps = {
  revenueState: async () => ({ status: "active" }) as RevenueConnectionState,
  revenueTimeseries: async () => MOCK_REVENUE_TIMESERIES,
};

/**
 * The revenue points for the chart's range at `grain`, or `null` for "no
 * bars". Reads nothing while `hold` is set ("all time" still finding its
 * start, or the public share board) and waits for the site summary, whose role
 * decides whether revenue is asked for at all.
 */
export function useOverviewRevenue(
  range: AnalyticsRange,
  grain: ChartGrain,
  hold: boolean
): RevenueTimeseriesPoint[] | null {
  const summary = useSiteSummary();
  const site = summary.site;
  const load = React.useCallback(
    async (signal: AbortSignal): Promise<RevenueTimeseriesPoint[] | null> => {
      if (!site || hold) return new Promise<RevenueTimeseriesPoint[] | null>(() => {});
      return loadChartRevenue(
        { siteId: site.site_id, role: site.role, range, grain, signal },
        LIVE_API ? LIVE_DEPS : MOCK_DEPS
      );
    },
    [site, range, grain, hold]
  );
  const resource = useApiResource(load);
  return resource.status === "ready" ? resource.data : null;
}

/* ------------------------------------------------------------------ */
/* The drawing                                                         */
/* ------------------------------------------------------------------ */

/**
 * The bars' own scale, from 0 to a nice value above the tallest bar (net plus
 * its refund). The headroom keeps the tallest bar below the traffic peaks and
 * its axis label clear of the chips above the plot.
 */
function useRevenueScale(model: RevenueModel) {
  const { innerHeight } = useChartStable();
  const max = revenueBarMax(model);
  return React.useMemo(
    () =>
      scaleLinear<number>({
        domain: [0, Math.max(1, max * 1.35)],
        range: [innerHeight, 0],
        nice: 3,
      }),
    [innerHeight, max]
  );
}

const BAR_FILL = "var(--success)";
const BAR_FILL_OPACITY = 0.22;
const REFUND_STROKE = "var(--muted-foreground)";
/** At most this wide, and never more than 60% of a bucket. */
const MAX_BAR_WIDTH = 24;

const SERIES_PHASES = new Set(["revealing", "ready", "exitingReady"]);

/**
 * The bars. Drawn as a series layer, so they ride the chart's left-to-right
 * reveal and its scrub dim; put them before the areas to sit behind them.
 * Bars that arrive after the reveal fade in instead of popping.
 */
export function RevenueBars({
  model,
  visible,
}: {
  model: RevenueModel;
  visible: boolean;
}) {
  const { data, xAccessor, xScale, innerWidth, columnWidth, chartPhase } =
    useChartStable();
  const yScale = useRevenueScale(model);
  if (!SERIES_PHASES.has(chartPhase) || model.buckets.size === 0) return null;

  const slot = columnWidth > 0 ? columnWidth : innerWidth;
  const barWidth = Math.max(2, Math.min(slot * 0.6, MAX_BAR_WIDTH));
  const baseline = yScale(0) ?? 0;

  return (
    <motion.g
      animate={{ opacity: visible ? 1 : 0 }}
      initial={{ opacity: 0 }}
      pointerEvents="none"
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      {data.map((point) => {
        const date = xAccessor(point);
        const bucket = model.buckets.get(date.getTime());
        if (!bucket) return null;
        // Negative net (refunds over charges) clamps at zero; the refund
        // outline still shows what went back.
        const net = Math.max(0, bucket.netMinor);
        const refund = Math.max(0, bucket.refundMinor);
        if (net === 0 && refund === 0) return null;
        const centre = xScale(date) ?? 0;
        // The plot runs edge to edge: keep the first and last bars whole.
        const x = Math.min(Math.max(centre - barWidth / 2, 0), innerWidth - barWidth);
        const netTop = yScale(net) ?? baseline;
        const refundTop = yScale(net + refund) ?? netTop;
        return (
          <g key={bucket.startMs}>
            {net > 0 ? (
              <rect
                fill={BAR_FILL}
                fillOpacity={BAR_FILL_OPACITY}
                height={Math.max(1, baseline - netTop)}
                rx={2}
                width={barWidth}
                x={x}
                y={netTop}
              />
            ) : null}
            {refund > 0 ? (
              // A refund is money that left: an outline, never a fill, so it
              // can't be read as income.
              <rect
                fill="none"
                height={Math.max(1, netTop - refundTop - 1)}
                rx={2}
                stroke={REFUND_STROKE}
                strokeDasharray="3 2"
                strokeOpacity={0.7}
                strokeWidth={1}
                width={Math.max(1, barWidth - 1)}
                x={x + 0.5}
                y={refundTop + 0.5}
              />
            ) : null}
          </g>
        );
      })}
    </motion.g>
  );
}

/**
 * The bars' axis on the right edge, inside the plot: a few compact amounts in
 * the reporting currency. Outside the series clip, like the x-axis, and only
 * there while the bars are.
 */
export function RevenueAxis({
  model,
  visible,
}: {
  model: RevenueModel;
  visible: boolean;
}) {
  const { innerWidth, chartPhase } = useChartStable();
  const yScale = useRevenueScale(model);
  const currency = model.currency;
  if (!(visible && currency) || !SERIES_PHASES.has(chartPhase)) return null;
  // Zero needs no label, and a tick at the very top would sit in the chips' row.
  const ticks = yScale
    .ticks(3)
    .filter((tick) => tick > 0 && (yScale(tick) ?? 0) >= 16);
  return (
    <motion.g
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
          textAnchor="end"
          x={innerWidth - 8}
          y={(yScale(tick) ?? 0) - 4}
        >
          {formatMoneyCompact(tick, currency)}
        </text>
      ))}
    </motion.g>
  );
}
RevenueAxis.__isClipExcluded = true;
