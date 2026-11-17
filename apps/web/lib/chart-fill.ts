/**
 * The overview chart's zero-filled grids, and how the previous period's grid
 * lines up under the current one.
 *
 * Moved out of `overview-chart.tsx` unchanged when the chart learned to draw
 * a previous period: the same grid is now cut twice, once per window, and
 * the pairing between the two is a rule worth testing on its own.
 *
 * The daily and weekly grids step the calendar of the zone the range was cut
 * in (`timeZone`, the request's), never the browser's: a Berlin browser
 * reading a Tokyo site keys and labels Tokyo days. Left out, the zone is the
 * browser's own.
 */

import {
  nearestZonedMidnight,
  zonedDayKey,
  zonedDayStart,
  zonedWeekdayFromMonday,
} from "./zoned-day";

export { nearestZonedMidnight } from "./zoned-day";

export type PlotPoint = { date: Date; visitors: number; pageviews: number };

/**
 * Zero-fill a fixed-stride grid between `fromMs` and `untilMs` (exclusive): a
 * rolled-up bucket with no row IS zero traffic, and skipping it would let the
 * area jump across the gap. `untilMs` is capped at the server's `as_of`, so
 * buckets that have not happened yet stay absent instead of drawing a false
 * flatline into the future.
 *
 * `stepMs` is the served grain, not an assumed one. Both boards ask for
 * `hour` and get it — except in a sub-hour-offset zone (Kathmandu), where no
 * named grain is available and automatic selection can serve **minute** — and
 * stepping an hourly grid over minute buckets is what turned the share chart
 * into spikes, because every bucket but the top of each hour missed its slot
 * and got zero-filled instead.
 */
export function fillFixedZeros(
  data: PlotPoint[],
  fromMs: number,
  untilMs: number,
  stepMs: number
): PlotPoint[] {
  const byMs = new Map(data.map((point) => [point.date.getTime(), point]));
  const filled: PlotPoint[] = [];
  for (let t = fromMs; t < untilMs; t += stepMs) {
    filled.push(byMs.get(t) ?? { date: new Date(t), visitors: 0, pageviews: 0 });
  }
  return filled;
}

/**
 * The daily counterpart of `fillFixedZeros`, stepping the zone's calendar
 * days (DST days are 23/25 hours long — a fixed 24-hour stride would drift
 * off the served midnights). Matching is by the zone's calendar day, not by
 * instant, which stays robust to where exactly a served bucket sits within
 * its day. A young site's 90-day view is mostly this: flat zero until the day
 * the tracker went live, then the real line.
 */
export function fillDailyZeros(
  data: PlotPoint[],
  fromMs: number,
  untilMs: number,
  timeZone?: string
): PlotPoint[] {
  const byDay = new Map(
    data.map((point) => [zonedDayKey(point.date.getTime(), timeZone), point])
  );
  const filled: PlotPoint[] = [];
  for (
    let t = fromMs;
    t < untilMs;
    t = zonedDayStart(new Date(t), timeZone, { days: 1 }).getTime()
  ) {
    filled.push(
      byDay.get(zonedDayKey(t, timeZone)) ?? {
        date: new Date(t),
        visitors: 0,
        pageviews: 0,
      }
    );
  }
  return filled;
}

/**
 * Weekly grid for the 6/12-month views: server weeks are labelled with the
 * instant their Monday starts at in the request's zone, so the grid steps
 * that zone's Mondays. The first week of a range that starts mid-week is
 * labelled *before* the range's `from` — the contract's one legitimate
 * outside-the-window label — so the grid anchors on that Monday rather than
 * on `from` itself.
 */
export function fillWeeklyZeros(
  data: PlotPoint[],
  fromMs: number,
  untilMs: number,
  timeZone?: string
): PlotPoint[] {
  const byDay = new Map(
    data.map((point) => [zonedDayKey(point.date.getTime(), timeZone), point])
  );
  const monday = zonedDayStart(new Date(fromMs), timeZone, {
    days: -zonedWeekdayFromMonday(fromMs, timeZone),
  });
  const filled: PlotPoint[] = [];
  for (
    let t = monday.getTime();
    t < untilMs;
    t = zonedDayStart(new Date(t), timeZone, { days: 7 }).getTime()
  ) {
    filled.push(
      byDay.get(zonedDayKey(t, timeZone)) ?? {
        date: new Date(t),
        visitors: 0,
        pageviews: 0,
      }
    );
  }
  return filled;
}

/** How the previous period's grid is stepped: the current grid's grain. */
export type PreviousGrid =
  | { grain: "fixed"; fromMs: number; untilMs: number; bucketMs: number; timeZone?: string }
  | { grain: "day" | "week"; fromMs: number; untilMs: number; timeZone?: string };

/**
 * The previous period's zero-filled grid, cut exactly like the current one
 * over the window the server compared against.
 *
 * The window starts one span before the current range, which in a zone with
 * DST can land an hour off the zone's midnight; a day or week grid starts on
 * the zone's nearest midnight instead, so it keys the same days the server
 * bucketed. A sub-day grid floors to its bucket, as the current one does.
 */
export function fillPreviousGrid(data: PlotPoint[], grid: PreviousGrid): PlotPoint[] {
  if (grid.grain === "fixed") {
    return fillFixedZeros(
      data,
      Math.floor(grid.fromMs / grid.bucketMs) * grid.bucketMs,
      grid.untilMs,
      grid.bucketMs
    );
  }
  const startMs = nearestZonedMidnight(grid.fromMs, grid.timeZone);
  return grid.grain === "week"
    ? fillWeeklyZeros(data, startMs, grid.untilMs, grid.timeZone)
    : fillDailyZeros(data, startMs, grid.untilMs, grid.timeZone);
}

/**
 * The previous period's bucket for each current bucket: bucket i with bucket
 * i, never by calendar date. The previous window is the same length cut at
 * the same grain, so position is the pairing: the 31st day of March sits
 * over the 31st day of the window before it, which ends in a 28-day
 * February, and hour 13 of today over hour 13 of yesterday.
 *
 * As long as the current grid, never longer: today's grid stops at the hour
 * it has reached, and the previous day's later hours have nothing to sit
 * over. A current bucket with no counterpart gets `null`.
 */
export function alignPrevious<T>(
  current: readonly unknown[],
  previous: readonly T[]
): (T | null)[] {
  return current.map((_, index) => previous[index] ?? null);
}
