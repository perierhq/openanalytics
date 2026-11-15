/**
 * How long ago a chart bucket was, for the pill that follows the cursor along
 * the x-axis: "Today", "Yesterday", "13 days ago", "3 hours ago".
 *
 * Calendar days are counted in the site's timezone, not the browser's and not
 * UTC's: at 00:30 in Berlin, yesterday's bucket is "Yesterday" even though UTC
 * is still on the same date. Day differences come from the zone's calendar
 * dates rather than from elapsed milliseconds, so a 23- or 25-hour DST day
 * never shifts the count.
 */

import type { ChartGrain } from "./chart-revenue";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const dateFormats = new Map<string, Intl.DateTimeFormat>();

function dateFormat(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let format = dateFormats.get(key);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        ...(timeZone ? { timeZone } : {}),
      });
    } catch {
      // An unknown zone name falls back to the browser's, like the chart's labels.
      format = new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    }
    dateFormats.set(key, format);
  }
  return format;
}

/** The instant's calendar date in `timeZone`, as a day number (days since 1970-01-01). */
function calendarDay(ms: number, timeZone: string | undefined): number {
  const parts = dateFormat(timeZone).formatToParts(new Date(ms));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Math.round(Date.UTC(part("year"), part("month") - 1, part("day")) / DAY_MS);
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

function daysLabel(days: number): string {
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days === -1) return "Tomorrow";
  return days > 1 ? `${days} days ago` : `In ${-days} days`;
}

/**
 * `startMs` is the bucket's start, `nowMs` the moment the data is read at
 * (`chartWindow`'s `readAtMs`), `grain` the chart's grain.
 */
export function relativeBucketLabel(
  startMs: number,
  nowMs: number,
  grain: ChartGrain,
  timeZone?: string
): string {
  if (grain === "minute") {
    const minutes = Math.floor((nowMs - startMs) / MINUTE_MS);
    return minutes <= 0 ? "Just now" : `${minutes} min ago`;
  }
  if (grain === "hour") {
    const hours = Math.floor((nowMs - startMs) / HOUR_MS);
    if (hours <= 0) return "This hour";
    return `${plural(hours, "hour", "hours")} ago`;
  }
  if (grain === "week") {
    // The bucket starts on its Monday; count whole weeks from the Monday of now.
    const nowDay = calendarDay(nowMs, timeZone);
    // Day 0 (1970-01-01) was a Thursday, so Monday is (day + 3) % 7 === 0.
    const nowMonday = nowDay - ((nowDay + 3) % 7);
    const weeks = Math.floor((nowMonday - calendarDay(startMs, timeZone)) / 7);
    if (weeks <= 0) return "This week";
    if (weeks === 1) return "Last week";
    return `${weeks} weeks ago`;
  }
  return daysLabel(calendarDay(nowMs, timeZone) - calendarDay(startMs, timeZone));
}
