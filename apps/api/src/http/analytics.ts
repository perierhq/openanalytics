import {
  ApiError,
  resolutionSchema,
  timezoneSchema,
  utcInstantSchema,
  type Resolution,
} from '@openanalytics/contracts'
import {
  funnelConfigSchema,
  parseAnalyticsFilters,
  roleHasCapability,
  type AnalyticsFilter,
  type FunnelScope,
} from '@openanalytics/domain'
import { getFinalizerState, listEventDisplayNames, type Database } from '@openanalytics/postgres'
import { Hono } from 'hono'
import type { AnalyticsReportRequest, AnalyticsService, PagesSort } from '../analytics/service.ts'
import { requireAnalyticsAccess, siteMembership, type ApiVariables } from './middleware.ts'

/**
 * The authenticated analytics read surface (plan Milestone 7 items 5, 6, 9).
 *
 * Mounted only when a query gateway is configured (the optional-until-used rule).
 * Every route runs the server-side authorization chain — session (applied by the
 * parent subtree) → `siteMembership` → `requireAnalyticsAccess` (billing gate) —
 * before the service ever signs a gateway request. There is no analytics route
 * that reaches the gateway without membership and entitlement having passed.
 */

type Env = { Variables: ApiVariables }

interface RangeQuery {
  readonly from: string
  readonly to: string
  readonly timezone: string
}

/**
 * Parses and validates the shared query parameters using the contract's own zod
 * schemas (imported from `@openanalytics/contracts`, so the API carries no direct
 * zod dependency). `from`/`to` must be UTC instants and `timezone` a valid IANA
 * identifier; a failure is one typed `VALIDATION_FAILED` listing every problem.
 */
export function parseRange(query: Record<string, string | undefined>): RangeQuery {
  const issues: { path: string; message: string }[] = []

  const from = utcInstantSchema.safeParse(query['from'])
  if (!from.success) issues.push({ path: 'from', message: 'from must be an ISO-8601 UTC instant' })
  const to = utcInstantSchema.safeParse(query['to'])
  if (!to.success) issues.push({ path: 'to', message: 'to must be an ISO-8601 UTC instant' })
  const timezone = timezoneSchema.safeParse(query['timezone'])
  if (!timezone.success) {
    issues.push({ path: 'timezone', message: 'timezone must be a valid IANA identifier' })
  }

  if (issues.length > 0) {
    throw new ApiError('VALIDATION_FAILED', 'Invalid analytics query parameters', {
      details: { issues },
    })
  }
  return { from: from.data as string, to: to.data as string, timezone: timezone.data as string }
}

export function parseCompare(query: Record<string, string | undefined>): boolean {
  const raw = query['compare']
  if (raw === undefined || raw === 'false') return false
  if (raw === 'true') return true
  throw new ApiError('VALIDATION_FAILED', 'compare must be "true" or "false"', {
    details: { issues: [{ path: 'compare', message: 'must be a boolean' }] },
  })
}

/**
 * The optional `resolution` override (CP3).
 *
 * Two enums, not one: the timeseries surface takes the whole contract
 * `Resolution` (including `week`), while overview totals only have hour and day
 * rollups to be read from. Both are validated here, at the edge, so an
 * unsupported *value* is a 400 `VALIDATION_FAILED` — the caller wrote something
 * the API does not have — and is never confused with a supported grain this
 * particular range or timezone cannot honestly serve, which is the resolver's
 * `RESOLUTION_NOT_AVAILABLE`.
 */
export function parseResolution(
  query: Record<string, string | undefined>,
  allowed: readonly Resolution[],
): Resolution | undefined {
  const raw = query['resolution']
  if (raw === undefined) return undefined
  const parsed = resolutionSchema.safeParse(raw)
  if (!parsed.success || !allowed.includes(parsed.data)) {
    throw new ApiError('VALIDATION_FAILED', `resolution must be one of: ${allowed.join(', ')}`, {
      details: {
        issues: [{ path: 'resolution', message: `must be one of: ${allowed.join(', ')}` }],
      },
    })
  }
  return parsed.data
}

export const TIMESERIES_RESOLUTIONS: readonly Resolution[] = ['minute', 'hour', 'day', 'week']
export const OVERVIEW_RESOLUTIONS: readonly Resolution[] = ['hour', 'day']

/**
 * The grains the **public** timeseries accepts (ADR-0039, D8).
 *
 * Deliberately the same list as `TIMESERIES_RESOLUTIONS` and deliberately an
 * alias rather than a second literal: the public share is not being given a
 * narrower or wider vocabulary than the owner's chart, it is being given the
 * ability to *name* the grain it is already receiving. Two literals that were
 * meant to stay equal would be two literals that eventually did not.
 *
 * If the public surface ever does need a narrower set, this is the line to
 * change, and the ADR decision that narrows it is what should change it.
 */
export const PUBLIC_TIMESERIES_RESOLUTIONS = TIMESERIES_RESOLUTIONS

/**
 * The session-scoped filter set (ADR-0075, D-F1 … D-F5).
 *
 * Parsed and refused at the EDGE, in the domain grammar both read surfaces
 * share, so the dashboard, `/v1/read` and MCP cannot end up with three dialects
 * of one idea. An absent parameter is the empty set — the unfiltered read, which
 * must stay on the rollups (D-F4) — and a present but unusable one is a named
 * `VALIDATION_FAILED` that carries the offending dimension and the supported
 * list in `details`, so a client can render the refusal rather than guess at it.
 *
 * The refusal shape is `readReturnTo`'s, deliberately: a value the caller
 * believed was doing something, that silently would not have, is worth naming.
 */
export function parseFilters(query: Record<string, string | undefined>): AnalyticsFilter[] {
  const parsed = parseAnalyticsFilters(query['filters'])
  if (parsed.ok) return [...parsed.filters]
  throw new ApiError('VALIDATION_FAILED', parsed.message, {
    details: {
      ...(parsed.dimension === undefined ? {} : { dimension: parsed.dimension }),
      ...(parsed.operator === undefined ? {} : { operator: parsed.operator }),
      ...(parsed.supported === undefined ? {} : { supported: parsed.supported }),
      issues: [{ path: 'filters', message: parsed.message }],
    },
  })
}

/**
 * The pages report's sort key (ADR-0075, D-E2).
 *
 * Validated at the edge and refused **by name**, the shape `readReturnTo` uses
 * for the same kind of mistake: an absent value is the default rather than an
 * error, so every caller written before this parameter existed keeps working,
 * and a present-but-unknown value is named — because the caller believed it was
 * choosing an order and silently would not have been.
 */
export function parsePagesSort(query: Record<string, string | undefined>): PagesSort {
  const raw = query['sort']
  if (raw === undefined) return 'views'
  if (raw === 'views' || raw === 'entrances' || raw === 'exits') return raw
  throw new ApiError('VALIDATION_FAILED', 'sort must be one of: views, entrances, exits', {
    details: { issues: [{ path: 'sort', message: 'must be one of: views, entrances, exits' }] },
  })
}

export function parseLimit(query: Record<string, string | undefined>): number {
  const raw = query['limit']
  if (raw === undefined) return 100
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    throw new ApiError('VALIDATION_FAILED', 'limit must be an integer in [1, 500]', {
      details: { issues: [{ path: 'limit', message: 'must be an integer in [1, 500]' }] },
    })
  }
  return n
}

/** Longest recent-visitor window, mirroring the gateway operation's own cap. */
const RECENT_WINDOW_MAX_HOURS = 24
const RECENT_WINDOW_DEFAULT_HOURS = 2
const RECENT_VISITORS_MAX_LIMIT = 200

export function parseRecentHours(query: Record<string, string | undefined>): number {
  const raw = query['hours']
  if (raw === undefined) return RECENT_WINDOW_DEFAULT_HOURS
  const hours = Number(raw)
  if (!Number.isInteger(hours) || hours < 1 || hours > RECENT_WINDOW_MAX_HOURS) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `hours must be an integer in [1, ${RECENT_WINDOW_MAX_HOURS}]`,
      {
        details: {
          issues: [
            { path: 'hours', message: `must be an integer in [1, ${RECENT_WINDOW_MAX_HOURS}]` },
          ],
        },
      },
    )
  }
  return hours
}

export function parseRecentLimit(query: Record<string, string | undefined>): number {
  const raw = query['limit']
  if (raw === undefined) return 100
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > RECENT_VISITORS_MAX_LIMIT) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `limit must be an integer in [1, ${RECENT_VISITORS_MAX_LIMIT}]`,
      {
        details: {
          issues: [
            { path: 'limit', message: `must be an integer in [1, ${RECENT_VISITORS_MAX_LIMIT}]` },
          ],
        },
      },
    )
  }
  return n
}

export function parseVisitorHash(query: Record<string, string | undefined>): string {
  const hash = query['hash']
  if (hash === undefined || hash.length === 0 || hash.length > 128) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'hash must be a visitor identifier of 1–128 characters',
      {
        details: { issues: [{ path: 'hash', message: 'must be 1–128 characters' }] },
      },
    )
  }
  return hash
}

/**
 * The recent window, ending **now** (ADR-0035, D7).
 *
 * It used to floor the end to the whole minute, so a panel that polls would
 * reuse one gateway cache key instead of minting a new one every second. The
 * cost of that was the freshest 0–60 s of traffic being outside the range *by
 * construction*: stacked with the 30 s query cache and the board's 60 s poll, a
 * brand-new page view could take ~2.5 minutes to reach the visitor trail — on
 * the screen whose whole job is to be live.
 *
 * The trade turned out to be worse than it looked. The floor bought cache
 * *sharing*, not cache *hits*: the board polls every 60 s against a 60-second
 * quantum, so two consecutive polls from one viewer land in different minutes
 * almost every time and the hit rate was already near zero. What it really
 * bought was two concurrent viewers of one site sharing an entry — paid for with
 * a minute of staleness for everybody.
 *
 * Both operations this feeds are `cacheable: false` in the gateway registry, so
 * an ever-moving `to` cannot churn the shared bounded LRU with keys that can
 * never be reused. Every other analytics route keeps its floor: those serve
 * rollup ranges where a whole-minute boundary is both harmless and the thing
 * that makes the cache work.
 */
export function recentWindow(hours: number, now: Date): { from: string; to: string } {
  return {
    from: new Date(now.getTime() - hours * 3_600_000).toISOString(),
    to: now.toISOString(),
  }
}

export interface FunnelQuery {
  readonly scope: FunnelScope
  readonly steps: readonly string[]
  readonly windowMs: number
}

/**
 * Parses the funnel-specific parameters through the domain funnel schema, so the
 * step count, window bound and scope enum are validated in one place shared with
 * the gateway operation. Steps are passed as repeated `steps=` query parameters.
 */
export function parseFunnel(
  steps: readonly string[],
  query: Record<string, string | undefined>,
): FunnelQuery {
  const windowRaw = query['window_ms']
  const parsed = funnelConfigSchema.safeParse({
    scope: query['scope'] ?? 'visitor',
    steps,
    windowMs: windowRaw === undefined ? undefined : Number(windowRaw),
  })
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', 'Invalid funnel parameters', {
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      },
    })
  }
  return { scope: parsed.data.scope, steps: parsed.data.steps, windowMs: parsed.data.windowMs }
}

/** The timezone parameter alone — the recent-visitor reads take no from/to. */
export function parseTimezone(query: Record<string, string | undefined>): string {
  const timezone = timezoneSchema.safeParse(query['timezone'])
  if (!timezone.success) {
    throw new ApiError('VALIDATION_FAILED', 'Invalid analytics query parameters', {
      details: {
        issues: [{ path: 'timezone', message: 'timezone must be a valid IANA identifier' }],
      },
    })
  }
  return timezone.data
}

/**
 * Custom events, decorated with their dashboard labels (ADR-0034, D7).
 *
 * The decoration happens in the route layer rather than in the analytics
 * service because the service talks only to the query gateway — giving it a
 * Postgres handle to fetch labels would put a database read inside the one
 * component D-208 keeps free of them. Shared by the dashboard route and the
 * `/v1/read` route, so the two doors cannot label one event differently.
 *
 * `display_template` is returned **unrendered**. Rendering a sentence needs
 * one event's properties, and this surface is an aggregate grouped by name —
 * there is no single event to render. The template travels so the per-event
 * surfaces can render it against the events they do have.
 */
export async function customEventsWithLabels(
  db: Database,
  service: AnalyticsService,
  req: AnalyticsReportRequest,
) {
  const [report, labels] = await Promise.all([
    service.customEvents(req),
    listEventDisplayNames(db, req.siteId),
  ])

  const byName = new Map(labels.map((label) => [label.eventName, label]))
  return {
    ...report,
    items: report.items.map((item) => {
      const label = byName.get(item.event_name)
      return {
        ...item,
        // Required-and-nullable, the ADR-0027 convention: `null` states "this
        // event has no dashboard definition", which is a fact a client renders
        // differently from "we did not look".
        display_name: label?.displayName ?? null,
        display_template: label?.displayTemplate ?? null,
      }
    }),
  }
}

export function createAnalyticsRoutes(deps: {
  db: Database
  service: AnalyticsService
}): Hono<Env> {
  const { db, service } = deps
  const app = new Hono<Env>()

  // Membership + billing entitlement guard every analytics route on the site.
  app.use('/sites/:site_id/analytics/*', siteMembership(db), requireAnalyticsAccess(db))

  const base = '/sites/:site_id/analytics'

  app.get(`${base}/overview`, async (c) => {
    const { siteId } = c.get('membership')
    const query = c.req.query()
    const range = parseRange(query)
    return c.json(
      await service.overview({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...range,
        filters: parseFilters(query),
        compare: parseCompare(query),
        resolution: parseResolution(query, OVERVIEW_RESOLUTIONS),
      }),
    )
  })

  app.get(`${base}/timeseries`, async (c) => {
    const { siteId } = c.get('membership')
    const query = c.req.query()
    const range = parseRange(query)
    return c.json(
      await service.timeseries({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...range,
        filters: parseFilters(query),
        compare: parseCompare(query),
        resolution: parseResolution(query, TIMESERIES_RESOLUTIONS),
      }),
    )
  })

  /**
   * `filterable` is per-route rather than global (ADR-0075, D-F2): custom events
   * and performance have no filtered operation in v1, so they do not read the
   * parameter at all and a filter sent to them is ignored rather than half-
   * applied. The two that DO take it refuse an unknown dimension by name — the
   * service raises the same refusal for an unfilterable report reached any other
   * way, so there is one message for one mistake.
   */
  const reportRoute = <T>(
    path: string,
    handler: (s: AnalyticsService, req: AnalyticsReportRequest) => Promise<T>,
    options: { filterable?: boolean } = {},
  ) => {
    app.get(`${base}/${path}`, async (c) => {
      const { siteId } = c.get('membership')
      const query = c.req.query()
      const range = parseRange(query)
      return c.json(
        await handler(service, {
          siteId,
          cacheEpoch: c.get('siteCacheEpoch'),
          importPointer: c.get('siteImportPointer'),
          ...range,
          limit: parseLimit(query),
          ...(options.filterable === true ? { filters: parseFilters(query) } : {}),
        }),
      )
    })
  }

  /**
   * Top pages, with entry, exit and bounce (ADR-0075, D-E1).
   *
   * Its own route rather than a `reportRoute` entry, because it is the one
   * report that takes a parameter the others do not — and because the session
   * decoration is asked for HERE rather than defaulted in the service: the
   * public share and the widget read call the same method and must keep paying
   * for one query, not two.
   */
  app.get(`${base}/pages`, async (c) => {
    const { siteId } = c.get('membership')
    const query = c.req.query()
    const range = parseRange(query)
    return c.json(
      await service.pages({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...range,
        limit: parseLimit(query),
        filters: parseFilters(query),
        sessionMetrics: true,
        sort: parsePagesSort(query),
      }),
    )
  })
  reportRoute('sources', (s, req) => s.sources(req), { filterable: true })
  reportRoute('geography', (s, req) => s.geography(req), { filterable: true })
  reportRoute('devices', (s, req) => s.devices(req), { filterable: true })
  // Custom events, with their dashboard labels; see `customEventsWithLabels`.
  app.get(`${base}/custom-events`, async (c) => {
    const { siteId } = c.get('membership')
    const query = c.req.query()
    return c.json(
      await customEventsWithLabels(db, service, {
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...parseRange(query),
        limit: parseLimit(query),
      }),
    )
  })
  reportRoute('performance', (s, req) => s.performance(req))

  // Session metrics: the finalized_through watermark comes from Postgres (the
  // session finalizer's control state); the service splits the range on it and
  // merges the finalized rollup layer with the provisional facts layer (§15).
  app.get(`${base}/sessions`, async (c) => {
    const { siteId } = c.get('membership')
    const range = parseRange(c.req.query())
    const state = await getFinalizerState(db, siteId)
    return c.json(
      await service.sessions({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...range,
        finalizedThrough: state ? state.finalizedThrough : null,
      }),
    )
  })

  // Recent visitors: the hours-deep companion to the realtime feed (ADR-0024).
  // Same guards as every other analytics route — and, like every other one, not
  // reachable from the public dashboard, which mounts its own narrow surface.
  app.get(`${base}/recent-visitors`, async (c) => {
    const { siteId, role } = c.get('membership')
    const query = c.req.query()
    const timezone = parseTimezone(query)
    const window = recentWindow(parseRecentHours(query), new Date())
    return c.json(
      await service.recentVisitors({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...window,
        timezone,
        limit: parseRecentLimit(query),
        // Owner-only (ADR-0036 CP7): for anyone else the revenue fields are
        // ABSENT, never zero — `0` would be a claim about the business, and a
        // non-owner is not allowed to know it either way.
        includeRevenue: roleHasCapability(role, 'revenue:read'),
      }),
    )
  })

  app.get(`${base}/visitor`, async (c) => {
    const { siteId, role } = c.get('membership')
    const query = c.req.query()
    const timezone = parseTimezone(query)
    const window = recentWindow(parseRecentHours(query), new Date())
    return c.json(
      await service.visitorTrail({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...window,
        timezone,
        visitor: parseVisitorHash(query),
        includeRevenue: roleHasCapability(role, 'revenue:read'),
      }),
    )
  })

  // Funnels: ordered step sequence over the event facts, bounded and cached (§15).
  app.get(`${base}/funnel`, async (c) => {
    const { siteId, role } = c.get('membership')
    const range = parseRange(c.req.query())
    const steps = c.req.queries('steps') ?? []
    const funnel = parseFunnel(steps, c.req.query())
    return c.json(
      await service.funnel({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...range,
        ...funnel,
        // Buyers and revenue per step are owner-only (ADR-0036 CP7): absent,
        // never zero, for anyone else.
        withRevenue: roleHasCapability(role, 'revenue:read'),
      }),
    )
  })

  return app
}
