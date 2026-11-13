import {
  chooseResolution,
  classifyTimezoneAlignment,
  DEFAULT_ANALYTICS_QUERY_CONFIG,
  importQueryParams,
  resolveForcedGrain,
  type ImportPointer,
  type AnalyticsQueryConfig,
  type RollupResolution,
  type SessionSplitUnit,
  type TimezoneAlignment,
} from '@openanalytics/domain'
import type { Resolution } from '@openanalytics/contracts'

/**
 * Turns a `[from, to)` request in an IANA timezone into a concrete gateway
 * operation and an effective, bucket-aligned range (plan Milestone 7 items 6/7,
 * docs snapshot 02 §15/§18).
 *
 * `chooseResolution` in `@openanalytics/domain` is the shared brain: it decides
 * grain and rollup family and refuses a range no rollup can answer honestly. This
 * module is the API-side adapter around it — it names the gateway operation for a
 * (report, grain) pair and snaps the requested range to the source rollup's UTC
 * bucket boundary so the gateway's own alignment check accepts it. The snapped
 * range is the response's `effective_range`; the caller's is `requested_range`
 * (§18 wants both surfaced, precisely because they can differ).
 */

const MS_PER_DAY = 86_400_000

export type SnapUnit = 'minute' | 'quarter' | 'day'

/** Floors an ISO instant down to the start of its UTC minute/quarter-hour/day. */
export function floorToUtcBoundary(iso: string, unit: SnapUnit): string {
  const ms = Date.parse(iso)
  const size = unit === 'minute' ? 60_000 : unit === 'quarter' ? 900_000 : MS_PER_DAY
  return new Date(Math.floor(ms / size) * size).toISOString()
}

export interface ResolvedTimeseries {
  readonly servable: true
  readonly operation: string
  readonly grain: Resolution
  readonly sourceRollup: RollupResolution
  readonly alignment: TimezoneAlignment
  readonly withTimezone: boolean
  readonly effectiveFrom: string
  readonly effectiveTo: string
}

export interface Unservable {
  readonly servable: false
  readonly reason: string
  readonly alignment: TimezoneAlignment
}

const snapForRollup: Record<RollupResolution, SnapUnit> = {
  '1m': 'minute',
  '15m': 'quarter',
  '1d': 'day',
}

function snapRange(
  from: string,
  to: string,
  unit: SnapUnit,
): { effectiveFrom: string; effectiveTo: string } {
  return {
    effectiveFrom: floorToUtcBoundary(from, unit),
    effectiveTo: floorToUtcBoundary(to, unit),
  }
}

/** The timeseries operation ID for a resolution. */
function timeseriesOperationFor(
  grain: Resolution,
  sourceRollup: RollupResolution,
  composeDayFromHour: boolean,
): string {
  // Week has no rollup of its own — it is grouped at read time over whichever
  // family the zone allows — so the grain, not the table, names the operation.
  if (grain === 'week') {
    return sourceRollup === '1d' ? 'analytics.timeseries_week_utc' : 'analytics.timeseries_week'
  }
  if (sourceRollup === '1m') return 'analytics.timeseries_minute'
  if (sourceRollup === '1d') return 'analytics.timeseries_day_utc'
  // '15m': either the hour chart or a composed local-day chart. The operation
  // ids keep saying `_hour` because they name the grain they *answer at*, which
  // ADR-0079 did not change — only the table underneath them moved.
  return composeDayFromHour ? 'analytics.timeseries_day' : 'analytics.timeseries_hour'
}

/**
 * Resolves a timeseries request. Uses the full minute/hour/day selector, so a
 * short "today" range gets the minute rollup and every other range composes from
 * the fifteen-minute atom, in whatever zone the caller asked for (ADR-0079).
 *
 * `input.resolution` forces the grain instead (CP3). The forced path is a
 * separate domain function rather than a flag threaded through the automatic
 * one, so a request that names no resolution takes byte-identical decisions to
 * the ones it took before the parameter existed. The effective range is snapped
 * the same way either way — to the *source rollup's* boundary, never to a week
 * boundary: `[from, to)` keeps filtering source buckets, and the week a partial
 * one belongs to is a grouping decision made after the filter (exactly as a
 * local day composed from hours already behaves at a range edge).
 */
export function resolveTimeseries(
  input: { from: string; to: string; timezone: string; resolution?: Resolution | undefined },
  config: AnalyticsQueryConfig = DEFAULT_ANALYTICS_QUERY_CONFIG,
): ResolvedTimeseries | Unservable {
  const requested = input.resolution
  const decision =
    requested === undefined
      ? chooseResolution(input, config)
      : resolveForcedGrain(input, requested, config)
  if (!decision.servable) {
    return {
      servable: false,
      reason: decision.reason ?? 'range is not servable',
      alignment: decision.timezoneAlignment,
    }
  }
  const unit = snapForRollup[decision.sourceRollup]
  const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, unit)
  const withTimezone = decision.sourceRollup !== '1d'
  return {
    servable: true,
    operation: timeseriesOperationFor(
      decision.grain,
      decision.sourceRollup,
      decision.composeDayFromHour,
    ),
    grain: decision.grain,
    sourceRollup: decision.sourceRollup,
    alignment: decision.timezoneAlignment,
    withTimezone,
    effectiveFrom,
    effectiveTo,
  }
}

export interface ResolvedAggregate {
  readonly servable: true
  readonly grain: Resolution
  readonly sourceRollup: RollupResolution
  readonly alignment: TimezoneAlignment
  readonly effectiveFrom: string
  readonly effectiveTo: string
}

/**
 * Resolves an *aggregate* request — overview totals and top-N reports, which have
 * no time bucketing and only exist at hour/day grain in the gateway registry.
 *
 * The rule mirrors the timezone logic in `chooseResolution` but without a minute
 * tier: a non-UTC zone always uses the atom rollup (only its quarter-hour
 * boundaries match a local midnight, and a report over the atom rollup is
 * correct at any length up to the hour cap); UTC uses the day rollup once past
 * the hour band and the atom rollup below it. A zone whose offset the atom
 * cannot express is refused, the same refusal `chooseResolution` makes.
 *
 * `input.resolution` forces the source instead (CP3), and only `hour` or `day`
 * can be forced: those are the only two rollups these totals have. `minute`
 * would change nothing — a total is summed over the whole range either way, so a
 * minute scan would buy the same number at a much higher cost — and `week` is a
 * bucketing concept with no meaning for a figure that has no buckets. The route
 * layer rejects both before this point; they are refused here too so the
 * function is total on its own type.
 */
export function resolveAggregate(
  input: { from: string; to: string; timezone: string; resolution?: Resolution | undefined },
  config: AnalyticsQueryConfig = DEFAULT_ANALYTICS_QUERY_CONFIG,
): ResolvedAggregate | Unservable {
  const fromMs = Date.parse(input.from)
  const toMs = Date.parse(input.to)
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) {
    return { servable: false, reason: 'range must be half-open with from < to', alignment: 'utc' }
  }
  const alignment = classifyTimezoneAlignment(new Date(fromMs), new Date(toMs), input.timezone)
  const spanDays = (toMs - fromMs) / MS_PER_DAY
  const requested = input.resolution

  if (requested !== undefined && requested !== 'hour' && requested !== 'day') {
    return {
      servable: false,
      alignment,
      reason: `${requested} grain has no meaning for range totals; these read the hour or day rollup`,
    }
  }

  if (alignment === 'unservable') {
    return {
      servable: false,
      alignment,
      reason:
        'a timezone offset that is not a multiple of fifteen minutes cannot be aligned to the ' +
        'rollups these totals read',
    }
  }

  // A forced `day` is the same day rule as the automatic one, minus the span
  // threshold that would otherwise have chosen hour: the day rollup buckets on
  // UTC midnight, so only a UTC request can read it without misattributing the
  // edges of every local day in the range.
  if (requested === 'day') {
    if (alignment !== 'utc') {
      return {
        servable: false,
        alignment,
        reason:
          'day grain totals read the UTC-day rollup, which cannot honour a non-UTC timezone’s ' +
          'local day boundaries; use hour grain',
      }
    }
    if (spanDays > config.MAX_SPAN_DAY_DAYS) {
      return {
        servable: false,
        alignment,
        reason: `range span ${spanDays.toFixed(1)}d exceeds the ${config.MAX_SPAN_DAY_DAYS}d cap`,
      }
    }
    const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'day')
    return {
      servable: true,
      grain: 'day',
      sourceRollup: '1d',
      alignment,
      effectiveFrom,
      effectiveTo,
    }
  }

  // A forced `hour` skips the UTC day-rollup branch below and falls through to
  // the hour path, which already carries the only guard it needs (the hour cap).
  if (requested === undefined && alignment === 'utc' && spanDays > config.HOUR_GRAIN_MAX_DAYS) {
    if (spanDays > config.MAX_SPAN_DAY_DAYS) {
      return {
        servable: false,
        alignment,
        reason: `range span ${spanDays.toFixed(1)}d exceeds the ${config.MAX_SPAN_DAY_DAYS}d cap`,
      }
    }
    const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'day')
    return {
      servable: true,
      grain: 'day',
      sourceRollup: '1d',
      alignment,
      effectiveFrom,
      effectiveTo,
    }
  }

  if (spanDays > config.MAX_SPAN_HOUR_DAYS) {
    return {
      servable: false,
      alignment,
      reason: `range span ${spanDays.toFixed(1)}d exceeds the ${config.MAX_SPAN_HOUR_DAYS}d hour-rollup cap`,
    }
  }
  const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'quarter')
  return {
    servable: true,
    grain: 'hour',
    sourceRollup: '15m',
    alignment,
    effectiveFrom,
    effectiveTo,
  }
}

/**
 * Resolves a *session-metrics* request to the pair of gateway operations that
 * read its finalized and provisional layers, plus the grain, effective range and
 * the UTC unit the finalized/provisional split is aligned on (docs snapshot 02
 * §10, §15; plan Milestone 8 items 6-7).
 *
 * Session rollups exist only at 15m/1d, so unlike the metrics chart there is no
 * minute grain: a short "today" range is served at hour grain. The
 * grain/timezone decision is delegated to the shared `chooseResolution` and then
 * mapped: its minute tier folds into hour, its UTC-day tier reads the 1d layers,
 * and its non-UTC composed-day tier composes local days from the 15m layers.
 *
 * Since ADR-0079 step 3 there is no zone-shaped refusal left here to make. A
 * `chooseResolution` that refuses an offset the atom cannot express refuses it
 * for this family too, through the `servable: false` branch above — one refusal,
 * in one place, rather than a second copy of the rule with its own wording.
 */
export interface ResolvedSession {
  readonly servable: true
  readonly grain: Resolution
  readonly finalizedOperation: string
  readonly provisionalOperation: string
  /** UTC unit the split boundary and the effective range are aligned on. */
  readonly splitUnit: SessionSplitUnit
  readonly withTimezone: boolean
  readonly effectiveFrom: string
  readonly effectiveTo: string
}

export function resolveSession(
  input: { from: string; to: string; timezone: string },
  config: AnalyticsQueryConfig = DEFAULT_ANALYTICS_QUERY_CONFIG,
): ResolvedSession | Unservable {
  const decision = chooseResolution(input, config)
  if (!decision.servable) {
    return {
      servable: false,
      reason: decision.reason ?? 'range is not servable',
      alignment: decision.timezoneAlignment,
    }
  }

  if (decision.sourceRollup === '1d') {
    // UTC day: read the 1d layers directly.
    const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'day')
    return {
      servable: true,
      grain: 'day',
      finalizedOperation: 'analytics.sessions_finalized_day',
      provisionalOperation: 'analytics.sessions_provisional_day',
      splitUnit: 'day',
      withTimezone: false,
      effectiveFrom,
      effectiveTo,
    }
  }

  if (decision.grain === 'day' && decision.composeDayFromHour) {
    // Non-UTC local day: compose from the 15m layers, split on the UTC
    // quarter-hour.
    const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'quarter')
    return {
      servable: true,
      grain: 'day',
      finalizedOperation: 'analytics.sessions_finalized_day_local',
      provisionalOperation: 'analytics.sessions_provisional_day_local',
      splitUnit: 'quarter',
      withTimezone: true,
      effectiveFrom,
      effectiveTo,
    }
  }

  // Minute or hour tier: session metrics are served at hour grain from the 15m
  // layers (the finest session rollup).
  const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'quarter')
  return {
    servable: true,
    grain: 'hour',
    finalizedOperation: 'analytics.sessions_finalized_hour',
    provisionalOperation: 'analytics.sessions_provisional_hour',
    splitUnit: 'quarter',
    withTimezone: true,
    effectiveFrom,
    effectiveTo,
  }
}

/** Report slugs whose gateway operations are `analytics.<slug>_hour|_day`. */
export const REPORT_SLUGS = [
  'pages',
  'sources',
  'geography',
  'devices',
  'custom_events',
  'performance',
] as const
export type ReportSlug = (typeof REPORT_SLUGS)[number]

/** The report operation ID for a resolved aggregate grain. */
export function reportOperationFor(slug: ReportSlug, sourceRollup: RollupResolution): string {
  return `analytics.${slug}_${sourceRollup === '1d' ? 'day' : 'hour'}`
}

/**
 * The custom-event sample operation for a resolved aggregate grain (ADR-0038,
 * D5; ClickHouse migration 0021).
 *
 * Its own function rather than a `REPORT_SLUGS` entry, because it is not a
 * report: it produces no rows of its own for a caller, it decorates the
 * custom-events report with three fields, and it takes neither the zone nor the
 * import parameters the report family takes. It is therefore absent from
 * `TIMEZONE_OPERATIONS` and from both import sets below, and that absence is
 * asserted rather than assumed — the registry walk in
 * `tests/unit/query-gateway-operations.test.ts` fails on a set that drifts from
 * the statements.
 */
export function customEventSamplesOperationFor(sourceRollup: RollupResolution): string {
  return sourceRollup === '1d'
    ? 'analytics.custom_event_samples_day'
    : 'analytics.custom_event_samples_hour'
}

/**
 * The entry/exit/bounce operation for a resolved aggregate grain (ADR-0075,
 * D-E1).
 *
 * Its own function rather than a `REPORT_SLUGS` entry, for the reason
 * `customEventSamplesOperationFor` gives above: it is not a report. It produces
 * no rows a caller reads on their own, it decorates the pages report with four
 * fields, and it takes neither the zone nor the import parameters the report
 * family takes — an imported provider day has no session in it, so there is
 * nothing on that side of the cutover for it to partition. It is therefore
 * absent from `TIMEZONE_OPERATIONS` and from both import sets below, and the
 * registry walk in `tests/unit/query-gateway-operations.test.ts` is what keeps
 * that absence true rather than assumed.
 */
export function pageSessionsOperationFor(sourceRollup: RollupResolution): string {
  return sourceRollup === '1d' ? 'analytics.page_sessions_day' : 'analytics.page_sessions_hour'
}

/** The overview operation ID for a resolved aggregate grain. */
export function overviewOperationFor(sourceRollup: RollupResolution): string {
  return sourceRollup === '1d' ? 'analytics.overview_day' : 'analytics.overview_hour'
}

/**
 * Longest range a filtered read may cover, in days (ADR-0075, D-F5).
 *
 * The gateway's filtered operations cap the same span in their own parameter
 * schemas, and this is not a duplicate of that: the schema's refusal reaches a
 * client as a generic operation-parameter failure, while a request that is
 * refused HERE is refused by name, with the cap and the requested span in the
 * error details, before any query is signed. The frontend has committed to
 * building that screen, and it needs something to render.
 */
export const FILTERED_MAX_SPAN_DAYS = 92

/**
 * Every filtered operation the gateway registers.
 *
 * Written out rather than derived by string surgery alone, because the surgery
 * is what decides whether a report is filterable at all: `custom_events` and
 * `performance` have no filtered counterpart in v1, and mapping their ids by
 * pattern would produce an operation name the gateway rejects as unknown —
 * a 400 that says nothing, where the api should say "this report does not take
 * a filter yet".
 */
const FILTERED_OPERATIONS: ReadonlySet<string> = new Set([
  'analytics.filtered_overview_hour',
  'analytics.filtered_overview_day',
  'analytics.filtered_timeseries_minute',
  'analytics.filtered_timeseries_hour',
  'analytics.filtered_timeseries_day',
  'analytics.filtered_timeseries_day_utc',
  'analytics.filtered_timeseries_week',
  'analytics.filtered_timeseries_week_utc',
  'analytics.filtered_pages_hour',
  'analytics.filtered_pages_day',
  'analytics.filtered_sources_hour',
  'analytics.filtered_sources_day',
  'analytics.filtered_geography_hour',
  'analytics.filtered_geography_day',
  'analytics.filtered_devices_hour',
  'analytics.filtered_devices_day',
  'analytics.filtered_page_sessions_hour',
  'analytics.filtered_page_sessions_day',
])

/** The reports a filter may be applied to in v1 (ADR-0075, D-F2). */
export const FILTERABLE_REPORT_SLUGS: readonly ReportSlug[] = [
  'pages',
  'sources',
  'geography',
  'devices',
]

/**
 * The filtered twin of an unfiltered operation, or `null` when it has none.
 *
 * The ids are parallel on purpose — `analytics.pages_hour` and
 * `analytics.filtered_pages_hour` — so the grain decision is made ONCE, by the
 * same resolver, and the filter only chooses which of two families answers it.
 * A second grain selector for filtered reads is how the two would eventually
 * disagree about what "today" means.
 */
export function filteredOperationFor(operation: string): string | null {
  const candidate = operation.replace(/^analytics\./, 'analytics.filtered_')
  return FILTERED_OPERATIONS.has(candidate) ? candidate : null
}

/**
 * The operations that carry the import parameters (ADR-0032, D2b/D4).
 *
 * Named here rather than inferred, because the gateway rejects both directions:
 * an operation whose SQL has the placeholders and receives no value fails to
 * bind, and one that receives values its SQL does not use fails as "bound unused
 * parameter". A unit test walks the gateway registry and asserts this set is
 * exactly the set of operations whose SQL contains `{import_run_id:UUID}`, so the
 * two ends cannot drift.
 *
 * **Minute and hour timeseries take the cutover but no imported branch.** An
 * aggregate-only provider ships one row per day and nothing finer, so there is
 * nothing honest to union — inventing one would spread a daily total across 24
 * buckets nobody measured. They still apply the partition, because two charts of
 * the same range disagreeing about whether the pre-cutover days exist is worse
 * than one of them being empty, and the empty one is explained by `estimated`.
 */
export const IMPORT_AWARE_OPERATIONS: ReadonlySet<string> = new Set([
  'analytics.timeseries_minute',
  'analytics.timeseries_hour',
  'analytics.timeseries_day',
  'analytics.timeseries_day_utc',
  'analytics.timeseries_week',
  'analytics.timeseries_week_utc',
  'analytics.overview_day',
  'analytics.overview_hour',
  // The live breakdowns take the cutover but no union: their imported rows
  // arrive through the `analytics.imported_*` operations and are merged in the
  // api. `performance` is absent — no provider exports web vitals, so there is
  // nothing to partition against.
  'analytics.pages_hour',
  'analytics.pages_day',
  'analytics.sources_hour',
  'analytics.sources_day',
  'analytics.geography_hour',
  'analytics.geography_day',
  'analytics.devices_hour',
  'analytics.devices_day',
  'analytics.custom_events_hour',
  'analytics.custom_events_day',
  'analytics.imported_pages',
  'analytics.imported_sources',
  'analytics.imported_geography',
  'analytics.imported_devices',
  'analytics.imported_browsers',
  'analytics.imported_os',
  'analytics.imported_custom_events',
])

/**
 * The subset that also binds `import_run_id` — the operations that actually read
 * a staged row.
 *
 * A live breakdown is import-aware without being one of these: it needs to know
 * where live data starts and nothing more, and binding a run id its statement
 * cannot use is precisely what the gateway rejects as "bound unused parameter".
 */
export const IMPORT_RUN_OPERATIONS: ReadonlySet<string> = new Set([
  'analytics.timeseries_day',
  'analytics.timeseries_day_utc',
  'analytics.timeseries_week',
  'analytics.timeseries_week_utc',
  'analytics.overview_day',
  'analytics.overview_hour',
  'analytics.imported_pages',
  'analytics.imported_sources',
  'analytics.imported_geography',
  'analytics.imported_devices',
  'analytics.imported_browsers',
  'analytics.imported_os',
  'analytics.imported_custom_events',
])

/** The import parameters one operation takes — none, the cutover, or both. */
export function importParamsFor(
  operation: string,
  pointer: ImportPointer | null,
): Record<string, string> {
  if (!IMPORT_AWARE_OPERATIONS.has(operation)) return {}
  const params = importQueryParams(pointer)
  return IMPORT_RUN_OPERATIONS.has(operation)
    ? { ...params }
    : { import_cutover: params.import_cutover }
}

/**
 * The operations whose statement binds `{tz:String}`.
 *
 * A **separate** list from the import-aware one, because the two sets are not the
 * same and assuming they were is a 400 on a working endpoint: the UTC-bucketed
 * charts read the import and take no zone (they are only ever routed a UTC
 * request), while `performance` takes neither. Every operation's parameter schema
 * is a `strictObject`, so an unexpected `timezone` is rejected exactly as loudly
 * as a missing one — which is the property that makes this list worth pinning
 * rather than inferring.
 *
 * A unit test asserts it is exactly the registry's `{tz:String}` set. The session
 * operations are in it for completeness; the session read path passes the zone
 * through its own resolver.
 */
export const TIMEZONE_OPERATIONS: ReadonlySet<string> = new Set([
  'analytics.timeseries_minute',
  'analytics.timeseries_hour',
  'analytics.timeseries_day',
  'analytics.timeseries_week',
  'analytics.overview_hour',
  'analytics.overview_day',
  'analytics.pages_hour',
  'analytics.pages_day',
  'analytics.sources_hour',
  'analytics.sources_day',
  'analytics.geography_hour',
  'analytics.geography_day',
  'analytics.devices_hour',
  'analytics.devices_day',
  'analytics.custom_events_hour',
  'analytics.custom_events_day',
  'analytics.imported_pages',
  'analytics.imported_sources',
  'analytics.imported_geography',
  'analytics.imported_devices',
  'analytics.imported_browsers',
  'analytics.imported_os',
  'analytics.imported_custom_events',
  'analytics.sessions_finalized_hour',
  'analytics.sessions_finalized_day_local',
  'analytics.sessions_provisional_hour',
  'analytics.sessions_provisional_day_local',
  // The revenue charts (CP5). Only the two that BUCKET in local time are here:
  // `revenue_timeseries_day` reads the UTC-day rollup and is only ever routed a
  // UTC request, and the two summaries have no bucket to label at all — a zone
  // bound to any of the three is a "bound unused parameter" rejection.
  'analytics.revenue_timeseries_hour',
  'analytics.revenue_timeseries_day_local',
  // The subscription MRR chart (Perier gap 7) buckets in the site's local day.
  'analytics.subscription_timeseries_day',
  // The filtered charts (ADR-0075). Only the four that bucket in local time:
  // the two UTC variants take no zone, and the filtered breakdowns and totals
  // have no bucket to label and no cutover to render, so a zone bound to any of
  // them is a "bound unused parameter" rejection — the same rule, applied to a
  // second family.
  //
  // `operationParamsFor` reads this set for the UNFILTERED operation id and the
  // filtered read binds its own zone from the same answer, which is why both
  // spellings of one grain must be listed together or a filtered hour chart
  // would silently lose its timezone.
  'analytics.filtered_timeseries_minute',
  'analytics.filtered_timeseries_hour',
  'analytics.filtered_timeseries_day',
  'analytics.filtered_timeseries_week',
])

/**
 * Everything one operation needs beyond `site_id`, the range and its own limit.
 *
 * One helper for both, so a caller cannot get the zone right and the cutover
 * wrong (or bind a zone to an operation that has none). The whole point is that
 * the *operation id* decides, not the request.
 */
export function operationParamsFor(
  operation: string,
  pointer: ImportPointer | null,
  timezone: string,
): Record<string, string> {
  return {
    ...(TIMEZONE_OPERATIONS.has(operation) ? { timezone } : {}),
    ...importParamsFor(operation, pointer),
  }
}

/**
 * The imported-only operation whose rows merge into a live report's, or null for
 * a report the import cannot answer.
 *
 * `performance` is null and always will be: web vitals are a browser
 * measurement, not an analytics aggregate, and no provider export carries them.
 */
export function importedReportOperationFor(slug: ReportSlug): string | null {
  switch (slug) {
    case 'pages':
      return 'analytics.imported_pages'
    case 'sources':
      return 'analytics.imported_sources'
    case 'geography':
      return 'analytics.imported_geography'
    case 'devices':
      return 'analytics.imported_devices'
    case 'custom_events':
      return 'analytics.imported_custom_events'
    case 'performance':
      return null
  }
}

/**
 * Resolves a *revenue* request to its rollup pair and effective range
 * (ADR-0033, D7; ClickHouse migration 0018). Milestone 12 Checkpoint 5.
 *
 * `resolveSession` again, and deliberately so: the revenue rollups have exactly
 * the session rollups' shape — 15m and 1d only, no minute grain, versioned
 * generation swaps rather than an incremental view — so the grain decision is
 * the same decision. Two consequences follow, and each is the session rule
 * with money in it:
 *
 * - **A minute-tier range is served at hour grain.** "Today" on a revenue chart
 *   is hourly, which is also the finest grain the money is meaningful at — a
 *   per-minute revenue series is noise around individual transactions, and the
 *   transactions list is the surface for those.
 * - **A non-UTC day is composed from the atom rollup**, so a DST 23/25-hour day
 *   sums the hours it actually had — in every zone, since ADR-0079 step 3 put
 *   `revenue_15m` under the composition.
 *
 * The summary shares this resolver rather than having one of its own: a range
 * total is the same buckets without the `GROUP BY`, so a range the chart refuses
 * is a range the total would have to guess at.
 */
export interface ResolvedRevenue {
  readonly servable: true
  readonly grain: Resolution
  /** The bucketed operation — the timeseries surface. */
  readonly timeseriesOperation: string
  /** The range-total operation — the summary surface. */
  readonly summaryOperation: string
  readonly withTimezone: boolean
  readonly effectiveFrom: string
  readonly effectiveTo: string
}

export function resolveRevenue(
  input: { from: string; to: string; timezone: string; resolution?: Resolution | undefined },
  config: AnalyticsQueryConfig = DEFAULT_ANALYTICS_QUERY_CONFIG,
): ResolvedRevenue | Unservable {
  const requested = input.resolution
  // `minute` and `week` are refused here as well as at the route edge, so the
  // function is total on its own type: revenue has hour and day rollups and
  // nothing else, and a forced grain neither of them can serve is a refusal
  // rather than a silent downgrade.
  if (requested !== undefined && requested !== 'hour' && requested !== 'day') {
    return {
      servable: false,
      alignment: classifyTimezoneAlignment(
        new Date(Date.parse(input.from)),
        new Date(Date.parse(input.to)),
        input.timezone,
      ),
      reason: `revenue has no ${requested} rollup; it is bucketed at hour or day grain only`,
    }
  }

  const decision =
    requested === undefined
      ? chooseResolution(input, config)
      : resolveForcedGrain(input, requested, config)
  if (!decision.servable) {
    return {
      servable: false,
      reason: decision.reason ?? 'range is not servable',
      alignment: decision.timezoneAlignment,
    }
  }

  if (decision.sourceRollup === '1d') {
    const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'day')
    return {
      servable: true,
      grain: 'day',
      timeseriesOperation: 'analytics.revenue_timeseries_day',
      summaryOperation: 'analytics.revenue_summary_day',
      withTimezone: false,
      effectiveFrom,
      effectiveTo,
    }
  }

  const { effectiveFrom, effectiveTo } = snapRange(input.from, input.to, 'quarter')
  if (decision.grain === 'day' && decision.composeDayFromHour) {
    return {
      servable: true,
      grain: 'day',
      timeseriesOperation: 'analytics.revenue_timeseries_day_local',
      summaryOperation: 'analytics.revenue_summary_hour',
      withTimezone: true,
      effectiveFrom,
      effectiveTo,
    }
  }

  return {
    servable: true,
    grain: 'hour',
    timeseriesOperation: 'analytics.revenue_timeseries_hour',
    summaryOperation: 'analytics.revenue_summary_hour',
    withTimezone: true,
    effectiveFrom,
    effectiveTo,
  }
}
