/**
 * Calendar maths in an arbitrary IANA zone: where a day starts, which day an
 * instant falls on, and which weekday that is, on the zone's calendar rather
 * than the browser's.
 *
 * The overview cuts its range in the site's zone (`rangeForInterval`), and
 * the chart's daily and weekly grids have to step the same calendar: a
 * browser in Berlin looking at a Tokyo site sees Tokyo days, and its own
 * midnights mean nothing to the data. `timeZone` left out is the browser's
 * own zone, which is what `Intl` does with no zone.
 */

const DAY_MS = 86_400_000;

const offsetFormats = new Map<string, Intl.DateTimeFormat>();
const dayFormats = new Map<string, Intl.DateTimeFormat>();

function cached(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string | undefined,
  build: (zone: { timeZone?: string }) => Intl.DateTimeFormat
): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let format = cache.get(key);
  if (!format) {
    format = build(timeZone ? { timeZone } : {});
    cache.set(key, format);
  }
  return format;
}

/** The zone's UTC offset at `at`, in milliseconds. */
function tzOffsetMs(timeZone: string | undefined, at: Date): number {
  const format = cached(offsetFormats, timeZone, (zone) =>
    new Intl.DateTimeFormat("en-US", {
      ...zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  );
  const parts = Object.fromEntries(
    format.formatToParts(at).map((part) => [part.type, part.value])
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The zone's calendar date of `at`: `[year, month (1-12), day]`. */
function zonedDate(at: Date, timeZone: string | undefined): [number, number, number] {
  const format = cached(dayFormats, timeZone, (zone) =>
    new Intl.DateTimeFormat("en-CA", {
      ...zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
  );
  const [y, m, d] = format.format(at).split("-").map(Number);
  return [y, m, d];
}

/**
 * The UTC instant at which the calendar day containing `base` — shifted by
 * whole years/months/days *on that zone's calendar* — starts in `timeZone`.
 * Two offset passes converge across DST transitions.
 */
export function zonedDayStart(
  base: Date,
  timeZone: string | undefined,
  shift: { years?: number; months?: number; days?: number } = {}
): Date {
  const [y, m, d] = zonedDate(base, timeZone);
  const target = Date.UTC(
    y + (shift.years ?? 0),
    m - 1 + (shift.months ?? 0),
    d + (shift.days ?? 0)
  );
  let instant = target - tzOffsetMs(timeZone, new Date(target));
  instant = target - tzOffsetMs(timeZone, new Date(instant));
  return new Date(instant);
}

/** "2026-07-23": the zone's calendar day of `ms`, as a map key. */
export function zonedDayKey(ms: number, timeZone: string | undefined): string {
  return zonedDate(new Date(ms), timeZone).join("-");
}

/** The zone's ISO weekday of `ms`, Monday 0 through Sunday 6. */
export function zonedWeekdayFromMonday(ms: number, timeZone: string | undefined): number {
  const [y, m, d] = zonedDate(new Date(ms), timeZone);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/**
 * The zone's midnight nearest `ms`: an instant up to half a day either side
 * of one lands on it. A span-based start that crosses a DST change sits an
 * hour off midnight, and a daily grid started there would step 23:00s.
 */
export function nearestZonedMidnight(ms: number, timeZone: string | undefined): number {
  return zonedDayStart(new Date(ms + DAY_MS / 2), timeZone).getTime();
}
