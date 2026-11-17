import { z } from 'zod'
import { isValidTimezone, timezoneOffsetMinutes, type Resolution } from '@openanalytics/contracts'

/**
 * Dashboard rollup selection (docs snapshot 02 §15 "Dashboard query rule",
 * plan Milestone 7 item 7).
 *
 * This is the one place that decides which rollup family answers a
 * `[from, to)` request in a given IANA timezone, and it is deliberately pure so
 * that both the query gateway (Checkpoint B) and the read API (Checkpoint C)
 * reach the same decision from the same inputs. §15's rule is span-based:
 *
 *   - today / realtime       → minute (or hour)
 *   - 7–30 days              → hour (or day)
 *   - 90 days, 6 mo, 1 y, all → day
 *
 * ### The timezone problem
 *
 * Every rollup buckets on `occurred_at` at **UTC** boundaries (migrations
 * 0003–0012, 0025–0026): `metrics_1d.bucket_start` is a UTC midnight,
 * `*_15m.bucket_start` a UTC quarter-hour. A site's "day", however, begins at
 * midnight in its own IANA timezone. So a non-UTC day cannot be read from
 * `*_1d` — its UTC-day buckets straddle two local days. It must be composed
 * from `*_15m` with ClickHouse's timezone-aware
 * `toStartOfDay(bucket_start, {tz:String})`, which also produces the correct
 * 23-/25-hour days across a DST transition.
 *
 * That composition only works when each stored bucket belongs wholly to one
 * local day — i.e. when the zone's offset is a whole number of bucket widths.
 * With the hour atom this file was built on, zones on a sub-hour offset
 * (Asia/Kolkata +05:30, Asia/Kathmandu +05:45, Australia/Lord_Howe +10:30) had
 * a local midnight — and every local hour boundary — falling in the *middle* of
 * a UTC hour, and were refused rather than misattributed. ADR-0079 moved the
 * atom to fifteen minutes, which is the coarsest grain every IANA offset in
 * force since 1979 is a multiple of, so those zones compose exactly like any
 * other and are served by the same path.
 *
 * What remains refusable is an offset that is not a multiple of fifteen minutes
 * at all. The last one in the tz database ended on 1979-10-01, when
 * Pacific/Kiritimati left −10:40, so only a historical range can reach this
 * class — but the rule is enforced rather than assumed, because a range that
 * dips into such an offset would otherwise be answered with buckets split down
 * the middle. Rather than return misattributed buckets, this function reports
 * such combinations as **not servable** and names why; the caller surfaces that
 * instead of a wrong number.
 *
 * The rule this encodes, therefore:
 *
 * | timezone class | minute grain | hour grain | day grain                    |
 * |----------------|--------------|------------|------------------------------|
 * | UTC            | `metrics_1m` | `*_15m`    | `*_1d` (direct)              |
 * | local          | `metrics_1m` | `*_15m`    | `*_15m` via toStartOfDay(tz) |
 * | unservable     | `metrics_1m` | not served | not served                   |
 *
 * Timezone is never spliced into SQL here: this module only *classifies* the
 * zone and picks a resolution. The gateway binds the zone as a `{tz:String}`
 * parameter (docs snapshot 02 §18).
 */

/** Which rollup table family answers the query. */
export const ROLLUP_RESOLUTIONS = ['1m', '15m', '1d'] as const
export type RollupResolution = (typeof ROLLUP_RESOLUTIONS)[number]

/**
 * How the requested zone's UTC offset aligns to rollup bucket boundaries
 * (ADR-0079, D4).
 *
 * `utc` is a zero offset throughout the range and reads the UTC-day rollup
 * directly; `local` is any other offset the fifteen-minute atom can compose;
 * `unservable` is an offset that is not a multiple of fifteen minutes, which
 * no bucket in any family can be split to honour.
 */
export const TIMEZONE_ALIGNMENTS = ['utc', 'local', 'unservable'] as const
export type TimezoneAlignment = (typeof TIMEZONE_ALIGNMENTS)[number]

const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

/** The atom grain, in minutes: every servable offset is a multiple of it. */
const ATOM_GRAIN_MINUTES = 15

/**
 * Engineering values for rollup selection (docs snapshot 02 §5: typed config,
 * not scattered literals). None of these is a `GATE` value in
 * docs snapshot 05 — G-005 enumerates abuse ceilings and rate limits, not query
 * planning — so they are ordinary defaults with recorded invariants, mirroring
 * the precedent `policy.ts` sets.
 */
export const analyticsQueryConfigSchema = z
  .object({
    /**
     * Longest span still answered at minute grain. "Today" (≤24h) and shorter
     * recent ranges get the minute rollup; 48h keeps a "yesterday + today"
     * view at minute grain without spilling into a week of minute buckets.
     */
    MINUTE_GRAIN_MAX_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    /**
     * Longest span answered at hour grain. Beyond a month the chart moves to
     * day grain (§15: 90 days and up are day-grain), and an hourly chart past a
     * month is more points than a dashboard renders usefully.
     */
    HOUR_GRAIN_MAX_DAYS: z.coerce.number().int().min(1).max(400).default(31),

    /** Hard cap on a minute-rollup scan, independent of grain selection. */
    MAX_SPAN_MINUTE_HOURS: z.coerce.number().int().min(1).max(336).default(48),
    /**
     * Hard cap on the atom-rollup scan. It must clear a full year, because a
     * non-UTC "1 year" day chart composes its days from `*_15m` (see the class
     * table above) — 366 days × 96 = 35 136 quarter-hour buckets per series.
     *
     * The env key still says `HOUR` because it is a deployed name and ADR-0079
     * changed the atom, not the operator's configuration surface; a rename
     * would silently drop whatever a running `.env` already sets.
     */
    MAX_SPAN_HOUR_DAYS: z.coerce.number().int().min(1).max(1_000).default(400),
    /** Hard cap on a day-rollup scan — the "all time" ceiling for UTC sites. */
    MAX_SPAN_DAY_DAYS: z.coerce.number().int().min(1).max(36_600).default(3_660),
  })
  .superRefine((config, ctx) => {
    // A grain can only be offered up to the span its own source rollup is
    // allowed to scan; otherwise selection would hand back a resolution the
    // range-bound check then rejects.
    if (config.MINUTE_GRAIN_MAX_HOURS > config.MAX_SPAN_MINUTE_HOURS) {
      ctx.addIssue({
        code: 'custom',
        path: ['MINUTE_GRAIN_MAX_HOURS'],
        message:
          `MINUTE_GRAIN_MAX_HOURS (${config.MINUTE_GRAIN_MAX_HOURS}h) must not exceed ` +
          `MAX_SPAN_MINUTE_HOURS (${config.MAX_SPAN_MINUTE_HOURS}h)`,
      })
    }
    if (config.HOUR_GRAIN_MAX_DAYS > config.MAX_SPAN_HOUR_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['HOUR_GRAIN_MAX_DAYS'],
        message:
          `HOUR_GRAIN_MAX_DAYS (${config.HOUR_GRAIN_MAX_DAYS}d) must not exceed ` +
          `MAX_SPAN_HOUR_DAYS (${config.MAX_SPAN_HOUR_DAYS}d)`,
      })
    }
    // Grain thresholds must be ordered: the minute band ends before the hour
    // band does, or a span could match both and the result would depend on
    // check order.
    if (config.MINUTE_GRAIN_MAX_HOURS / 24 >= config.HOUR_GRAIN_MAX_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['MINUTE_GRAIN_MAX_HOURS'],
        message:
          `MINUTE_GRAIN_MAX_HOURS (${config.MINUTE_GRAIN_MAX_HOURS}h) must be shorter than ` +
          `HOUR_GRAIN_MAX_DAYS (${config.HOUR_GRAIN_MAX_DAYS}d)`,
      })
    }
    // Source caps must be ordered coarsest-longest: a finer rollup never
    // outscans a coarser one.
    if (config.MAX_SPAN_HOUR_DAYS > config.MAX_SPAN_DAY_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAX_SPAN_HOUR_DAYS'],
        message:
          `MAX_SPAN_HOUR_DAYS (${config.MAX_SPAN_HOUR_DAYS}d) must not exceed ` +
          `MAX_SPAN_DAY_DAYS (${config.MAX_SPAN_DAY_DAYS}d)`,
      })
    }
  })

export type AnalyticsQueryConfig = z.infer<typeof analyticsQueryConfigSchema>

export class AnalyticsQueryConfigError extends Error {
  readonly issues: readonly { path: string; message: string }[]

  constructor(error: z.ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }))
    super(
      `Invalid analytics query configuration:\n${issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    )
    this.name = 'AnalyticsQueryConfigError'
    this.issues = issues
  }
}

export function loadAnalyticsQueryConfig(
  source: Record<string, string | undefined> = process.env,
): AnalyticsQueryConfig {
  const result = analyticsQueryConfigSchema.safeParse(source)
  if (!result.success) {
    throw new AnalyticsQueryConfigError(result.error)
  }
  return result.data
}

/** Defaults, resolved once. The gateway's per-operation span caps read these. */
export const DEFAULT_ANALYTICS_QUERY_CONFIG: AnalyticsQueryConfig = loadAnalyticsQueryConfig({})

/**
 * UTC offset, in minutes, that `timezone` had at `instant`.
 *
 * Re-exported rather than implemented: the arithmetic moved to
 * `@openanalytics/contracts` when the dashboard needed the same `% 60` rule and
 * may import nothing else (D-218). This name stays because it is the one every
 * caller in this package and the widget range builder already use.
 */
export { timezoneOffsetMinutes }

/**
 * Interior sampling step for {@link classifyTimezoneAlignment}.
 *
 * Endpoints alone are not enough: a range whose two ends share a servable
 * offset can still enclose a stretch on a *different* offset. Australia/Lord_Howe
 * is the worst case — it runs +11:00 in its summer DST and +10:30 for the ~six
 * standard-time months between. Both are multiples of fifteen minutes, so both
 * are servable today; the walk is what keeps that a *measured* fact rather than
 * an assumption, and it is the same walk that catches a historical range dipping
 * through an offset the atom cannot express.
 *
 * So the interior is walked too. A daily step catches any offset regime that
 * lasts a day or more, which every real IANA offset period does (the shortest
 * is months). The walk is bounded to {@link MAX_ALIGNMENT_SAMPLES} `Intl` lookups
 * regardless of range length: up to that many days it steps daily; past it (only
 * for ranges longer than ~two years, which are already beyond the atom-rollup
 * composed-day domain and refused by the span caps) it coarsens the step to stay
 * cheap. The step is not a correctness knob a caller sets — it is fixed here so
 * the classification a caller gets is the same one the gateway's range check
 * enforces.
 */
const ALIGNMENT_SAMPLE_STEP_MS = MS_PER_DAY

/**
 * Ceiling on interior samples, so a pathological multi-decade range cannot turn
 * classification into thousands of `Intl` lookups. Chosen above the atom-rollup
 * cap (400 days) so every range that can actually be composed from the atom
 * rollup — the only case where a missed interior offset stretch would matter —
 * is still sampled at full daily granularity.
 */
const MAX_ALIGNMENT_SAMPLES = 750

/**
 * How the zone aligns to UTC bucket boundaries across the whole of `[from, to)`.
 *
 * The offset is sampled at both ends **and** at every interior day boundary, so a
 * range that dips through a different offset in its middle (Lord Howe's +10:30
 * between two +11:00 summers) is classified by its worst sample, not by its ends.
 * `utc` requires a zero offset at every sample; `local` requires every sample to
 * be a whole number of fifteen-minute atoms; anything else is `unservable`. A
 * worse sample can only *demote* the result (utc → local → unservable), so the
 * walk can stop the moment it sees an offset the atom cannot express.
 */
export function classifyTimezoneAlignment(
  from: Date,
  to: Date,
  timezone: string,
): TimezoneAlignment {
  const fromMs = from.getTime()
  const toMs = to.getTime()
  let sawNonZero = false

  // Daily by default; coarsened only when the range is long enough that a daily
  // walk would exceed the sample budget (see MAX_ALIGNMENT_SAMPLES).
  const step = Math.max(
    ALIGNMENT_SAMPLE_STEP_MS,
    Math.ceil((toMs - fromMs) / MAX_ALIGNMENT_SAMPLES),
  )

  // Both endpoints and every step boundary strictly inside the range. `to` is
  // exclusive (the range is half-open) so it is sampled but a bucket starting at
  // `to` is not part of the answer; sampling it is harmless and catches an
  // end-exact transition.
  for (let at = fromMs; ; at += step) {
    const sampleAt = at > toMs ? toMs : at
    const offset = timezoneOffsetMinutes(new Date(sampleAt), timezone)
    if (offset % ATOM_GRAIN_MINUTES !== 0) return 'unservable'
    if (offset !== 0) sawNonZero = true
    if (sampleAt === toMs) break
  }

  return sawNonZero ? 'local' : 'utc'
}

export interface ResolutionInput {
  /** Half-open range start, ISO-8601 UTC instant. */
  readonly from: string
  /** Half-open range end (exclusive), ISO-8601 UTC instant. */
  readonly to: string
  /** IANA timezone the caller's calendar boundaries are expressed in. */
  readonly timezone: string
}

export interface QueryResolution {
  /**
   * Bucket size of the answer. `chooseResolution` only ever picks
   * `minute`/`hour`/`day`; `week` reaches here solely through
   * {@link resolveForcedGrain}, which the caller opts into.
   */
  readonly grain: Resolution
  /** Rollup family to read. */
  readonly sourceRollup: RollupResolution
  /**
   * Whether a day-grain answer must be composed with `toStartOfDay(bucket, tz)`
   * over the atom rollup (`true`) rather than read straight from a day rollup
   * (`false`). Only meaningful when `grain === 'day'`.
   *
   * The name predates ADR-0079, when the atom was an hour; it still names the
   * same decision — compose a local day from sub-day buckets, or read the
   * UTC-day table — and every caller of it reads that meaning.
   */
  readonly composeDayFromHour: boolean
  readonly timezoneAlignment: TimezoneAlignment
  readonly requestedSpanMs: number
  /** `false` when no rollup can answer this range/timezone honestly. */
  readonly servable: boolean
  /** Set when `servable` is false, or as a caveat on the chosen resolution. */
  readonly reason?: string
}

/**
 * Picks the rollup resolution for a `[from, to)` range in an IANA timezone.
 *
 * Pure and total: it never throws. An inverted or malformed range comes back
 * `servable: false` rather than as an exception, so a caller can render a
 * message from `reason`. The gateway still validates the instants and the
 * `from < to` invariant on its own before binding.
 */
export function chooseResolution(
  input: ResolutionInput,
  config: AnalyticsQueryConfig = DEFAULT_ANALYTICS_QUERY_CONFIG,
): QueryResolution {
  const fromMs = Date.parse(input.from)
  const toMs = Date.parse(input.to)

  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || !isValidTimezone(input.timezone)) {
    return {
      grain: 'day',
      sourceRollup: '1d',
      composeDayFromHour: false,
      timezoneAlignment: 'utc',
      requestedSpanMs: 0,
      servable: false,
      reason: 'range instants or timezone are invalid',
    }
  }

  const spanMs = toMs - fromMs
  if (spanMs <= 0) {
    return {
      grain: 'day',
      sourceRollup: '1d',
      composeDayFromHour: false,
      timezoneAlignment: 'utc',
      requestedSpanMs: spanMs,
      servable: false,
      reason: 'range must be half-open with from < to',
    }
  }

  const alignment = classifyTimezoneAlignment(new Date(fromMs), new Date(toMs), input.timezone)

  // Grain by span (§15).
  let grain: Resolution
  if (spanMs <= config.MINUTE_GRAIN_MAX_HOURS * MS_PER_HOUR) {
    grain = 'minute'
  } else if (spanMs <= config.HOUR_GRAIN_MAX_DAYS * MS_PER_DAY) {
    grain = 'hour'
  } else {
    grain = 'day'
  }

  const notServable = (reason: string): QueryResolution => ({
    grain,
    sourceRollup: '1m',
    composeDayFromHour: false,
    timezoneAlignment: alignment,
    requestedSpanMs: spanMs,
    servable: false,
    reason,
  })

  const spanHours = spanMs / MS_PER_HOUR
  const spanDays = spanMs / MS_PER_DAY

  if (grain === 'minute') {
    if (spanHours > config.MAX_SPAN_MINUTE_HOURS) {
      return notServable(
        `minute grain span ${spanHours.toFixed(1)}h exceeds the ${config.MAX_SPAN_MINUTE_HOURS}h minute-rollup cap`,
      )
    }
    // Minute buckets align to any whole-minute offset — every IANA zone.
    return {
      grain,
      sourceRollup: '1m',
      composeDayFromHour: false,
      timezoneAlignment: alignment,
      requestedSpanMs: spanMs,
      servable: true,
    }
  }

  if (grain === 'hour') {
    if (alignment === 'unservable') {
      return notServable(
        'hour grain cannot be aligned to a timezone offset that is not a multiple of fifteen ' +
          'minutes; use minute grain for a shorter range',
      )
    }
    if (spanDays > config.MAX_SPAN_HOUR_DAYS) {
      return notServable(
        `hour grain span ${spanDays.toFixed(1)}d exceeds the ${config.MAX_SPAN_HOUR_DAYS}d hour-rollup cap`,
      )
    }
    return {
      grain,
      sourceRollup: '15m',
      composeDayFromHour: false,
      timezoneAlignment: alignment,
      requestedSpanMs: spanMs,
      servable: true,
    }
  }

  // grain === 'day'
  if (alignment === 'unservable') {
    return notServable(
      'day grain cannot be aligned to a timezone offset that is not a multiple of fifteen minutes',
    )
  }

  if (alignment === 'utc') {
    if (spanDays > config.MAX_SPAN_DAY_DAYS) {
      return notServable(
        `day grain span ${spanDays.toFixed(1)}d exceeds the ${config.MAX_SPAN_DAY_DAYS}d day-rollup cap`,
      )
    }
    // UTC days == the day rollup's own buckets: read it directly.
    return {
      grain,
      sourceRollup: '1d',
      composeDayFromHour: false,
      timezoneAlignment: alignment,
      requestedSpanMs: spanMs,
      servable: true,
    }
  }

  // Non-UTC: compose local days from the atom rollup so DST 23/25h days are
  // correct. The day rollup would be UTC-day-bucketed and therefore wrong for
  // this zone.
  if (spanDays > config.MAX_SPAN_HOUR_DAYS) {
    return notServable(
      `day grain for a non-UTC timezone composes from the hour rollup, and span ${spanDays.toFixed(
        1,
      )}d exceeds the ${config.MAX_SPAN_HOUR_DAYS}d hour-rollup cap`,
    )
  }
  return {
    grain,
    sourceRollup: '15m',
    composeDayFromHour: true,
    timezoneAlignment: alignment,
    requestedSpanMs: spanMs,
    servable: true,
  }
}

/**
 * Picks the rollup for a grain the **caller named**, rather than one derived
 * from the span (the `resolution` query parameter, CP3).
 *
 * `chooseResolution` above is untouched by this and stays the only automatic
 * path: a request with no `resolution` never reaches here, so the span-based
 * ladder and everything that depends on it behave exactly as before.
 *
 * The forcing rule is deliberately *not* "anything the caller asks for". A
 * grain is honoured only where the automatic selector could already have served
 * it for this range and timezone — the same source-rollup span caps, the same
 * timezone-alignment classes. What forcing buys the caller is the freedom to ask
 * for hour buckets over a fortnight the ladder would have given days for, not
 * the freedom to ask for a number no rollup can produce truthfully. A grain that
 * fails those checks comes back `servable: false` with the precise reason, which
 * the API surfaces as `RESOLUTION_NOT_AVAILABLE`.
 *
 * ### Week
 *
 * `week` is the one grain automatic selection never picks, and the only one with
 * no rollup family of its own. It is the ISO week — Monday start — **in the
 * request timezone**, which is exactly why no week rollup exists: a stored
 * UTC-week bucket would be the wrong seven days for every zone but UTC, and the
 * DST-crossing weeks (167h and 169h) would be wrong for all of them. So it is
 * grouped at read time, from the same sources the day grain uses and under the
 * same class rules:
 *
 * | timezone class | week source                                    |
 * |----------------|------------------------------------------------|
 * | UTC            | `metrics_1d`, grouped by `toStartOfWeek(…, 1)` |
 * | local          | `metrics_15m`, grouped by the local Monday     |
 * | unservable     | not served — same reason day is not            |
 *
 * A UTC week always starts on a UTC midnight, so the day rollup's buckets nest
 * inside it exactly; a non-UTC week starts on a local midnight, which only the
 * atom rollup can honour, and only when the zone's offset is a whole number of
 * fifteen-minute atoms. Grouping (rather than summing seven day-buckets client-side) is also
 * what keeps weekly unique visitors correct: the read merges the stored
 * `uniq` states across the whole week instead of adding seven overlapping
 * counts.
 */
export function resolveForcedGrain(
  input: ResolutionInput,
  requested: Resolution,
  config: AnalyticsQueryConfig = DEFAULT_ANALYTICS_QUERY_CONFIG,
): QueryResolution {
  const fromMs = Date.parse(input.from)
  const toMs = Date.parse(input.to)

  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || !isValidTimezone(input.timezone)) {
    return {
      grain: requested,
      sourceRollup: '1d',
      composeDayFromHour: false,
      timezoneAlignment: 'utc',
      requestedSpanMs: 0,
      servable: false,
      reason: 'range instants or timezone are invalid',
    }
  }

  const spanMs = toMs - fromMs
  if (spanMs <= 0) {
    return {
      grain: requested,
      sourceRollup: '1d',
      composeDayFromHour: false,
      timezoneAlignment: 'utc',
      requestedSpanMs: spanMs,
      servable: false,
      reason: 'range must be half-open with from < to',
    }
  }

  const alignment = classifyTimezoneAlignment(new Date(fromMs), new Date(toMs), input.timezone)
  const spanHours = spanMs / MS_PER_HOUR
  const spanDays = spanMs / MS_PER_DAY

  const refuse = (reason: string): QueryResolution => ({
    grain: requested,
    sourceRollup: '1m',
    composeDayFromHour: false,
    timezoneAlignment: alignment,
    requestedSpanMs: spanMs,
    servable: false,
    reason,
  })

  const serve = (sourceRollup: RollupResolution, composeDayFromHour = false): QueryResolution => ({
    grain: requested,
    sourceRollup,
    composeDayFromHour,
    timezoneAlignment: alignment,
    requestedSpanMs: spanMs,
    servable: true,
  })

  if (requested === 'minute') {
    if (spanHours > config.MAX_SPAN_MINUTE_HOURS) {
      return refuse(
        `minute grain span ${spanHours.toFixed(1)}h exceeds the ${config.MAX_SPAN_MINUTE_HOURS}h minute-rollup cap`,
      )
    }
    // Every IANA offset is a whole number of minutes, so no zone is refused here.
    return serve('1m')
  }

  if (requested === 'hour') {
    if (alignment === 'unservable') {
      return refuse(
        'hour grain cannot be aligned to a timezone offset that is not a multiple of fifteen ' +
          'minutes; use minute grain for a shorter range',
      )
    }
    if (spanDays > config.MAX_SPAN_HOUR_DAYS) {
      return refuse(
        `hour grain span ${spanDays.toFixed(1)}d exceeds the ${config.MAX_SPAN_HOUR_DAYS}d hour-rollup cap`,
      )
    }
    return serve('15m')
  }

  // day and week share their sources and therefore their class rules.
  if (alignment === 'unservable') {
    return refuse(
      `${requested} grain cannot be aligned to a timezone offset that is not a multiple of ` +
        'fifteen minutes',
    )
  }

  if (alignment === 'utc') {
    if (spanDays > config.MAX_SPAN_DAY_DAYS) {
      return refuse(
        `${requested} grain span ${spanDays.toFixed(1)}d exceeds the ${config.MAX_SPAN_DAY_DAYS}d day-rollup cap`,
      )
    }
    // UTC days are the day rollup's own buckets, and a UTC week is a whole
    // number of them: both read `*_1d` directly.
    return serve('1d')
  }

  // Non-UTC: local days (and therefore local weeks) start on a boundary the day
  // rollup cannot express, so compose from `*_15m`.
  if (spanDays > config.MAX_SPAN_HOUR_DAYS) {
    return refuse(
      `${requested} grain for a non-UTC timezone composes from the hour rollup, and span ${spanDays.toFixed(
        1,
      )}d exceeds the ${config.MAX_SPAN_HOUR_DAYS}d hour-rollup cap`,
    )
  }
  return serve('15m', requested === 'day')
}

/** A half-open UTC range as ISO-8601 instants. */
export interface UtcRange {
  readonly from: string
  readonly to: string
}

/**
 * Where a period still in progress is cut for its comparison.
 *
 * `asOf` is the instant the read is answered at (the response's
 * `meta.freshness.as_of`); `stepMs` is the read's own bucket, the unit its
 * effective range is snapped to (a minute, a quarter-hour, a UTC day). An
 * absent or unparseable `asOf` means the period's progress is unknown, and the
 * whole previous period is compared, as it was before this cut existed.
 */
export interface PreviousPeriodCut {
  readonly asOf?: string | null | undefined
  readonly stepMs: number
}

/**
 * The comparison range for a `[from, to)` request (docs snapshot 02 §18:
 * "comparison interval"; plan Milestone 7 item 9).
 *
 * The previous period starts one span before the current one, `from - span`,
 * and is as long as the part of the current period that has happened: for a
 * finished period that is all of it, `[from - span, from)`; for a period still
 * in progress (`asOf` inside it) it is cut at the same offset, so 09:00 on
 * "today" compares 00:00-09:00 today with 00:00-09:00 yesterday rather than
 * with all of yesterday. The cut rounds `asOf` up to the read's bucket
 * (`stepMs`), because the current period's partial bucket is already counted
 * and its counterpart must be too; a read that can only resolve whole UTC days
 * therefore compares whole days. It is derived here, in domain code, so the API
 * and any future caller compute the same comparison from the same inputs rather
 * than each doing date maths at the edge.
 *
 * The definition is span-based, not calendar-based, and that is deliberate: an
 * equal-UTC-span preceding window is exact and reversible, and it lines up bucket
 * for bucket with the current range at whatever grain answered it. A
 * calendar-based "same days last month" comparison changes length across DST and
 * month boundaries and is a Milestone 8 refinement once session facts land; the
 * metadata already carries the comparison range explicitly so a client is never
 * left guessing which window a comparison number came from.
 *
 * Returns `null` for a malformed or non-positive range, and for a period that
 * has not started yet (nothing of it has happened, so there is nothing to set
 * against it), mirroring `chooseResolution`'s total, throw-free contract.
 */
export function derivePreviousPeriod(range: UtcRange, cut?: PreviousPeriodCut): UtcRange | null {
  const fromMs = Date.parse(range.from)
  const toMs = Date.parse(range.to)
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) return null
  const span = toMs - fromMs
  const asOfMs = cut?.asOf ? Date.parse(cut.asOf) : Number.NaN
  const step = cut && cut.stepMs > 0 ? cut.stepMs : 1
  const elapsedEndMs = Number.isNaN(asOfMs) ? toMs : Math.min(toMs, Math.ceil(asOfMs / step) * step)
  const elapsed = elapsedEndMs - fromMs
  if (elapsed <= 0) return null
  return {
    from: new Date(fromMs - span).toISOString(),
    to: new Date(fromMs - span + elapsed).toISOString(),
  }
}

/** True when the instant lands exactly on a UTC minute (`:ss.mmm` are zero). */
export function isUtcMinuteAligned(instant: string): boolean {
  const ms = Date.parse(instant)
  return !Number.isNaN(ms) && ms % 60_000 === 0
}

/**
 * True when the instant lands exactly on a UTC quarter-hour — the atom rollup's
 * own bucket boundary (ADR-0079), and the alignment every non-UTC read is
 * snapped to and checked against.
 */
export function isUtcQuarterAligned(instant: string): boolean {
  const ms = Date.parse(instant)
  return !Number.isNaN(ms) && ms % (ATOM_GRAIN_MINUTES * 60_000) === 0
}

/**
 * True when the instant lands exactly on a UTC hour.
 *
 * No read has been routed to an hour boundary since ADR-0079 step 3 moved the
 * atom to fifteen minutes, and step 4 retired the grain itself: the `*_1h`
 * tables are frozen history now and nothing writes them. Kept because the
 * predicate is part of this package's public surface and a whole-hour instant
 * is still a meaningful thing to ask about.
 */
export function isUtcHourAligned(instant: string): boolean {
  const ms = Date.parse(instant)
  return !Number.isNaN(ms) && ms % MS_PER_HOUR === 0
}

/** True when the instant lands exactly on a UTC day (midnight UTC). */
export function isUtcDayAligned(instant: string): boolean {
  const ms = Date.parse(instant)
  return !Number.isNaN(ms) && ms % MS_PER_DAY === 0
}
