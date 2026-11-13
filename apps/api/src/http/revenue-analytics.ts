import {
  ApiError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type Resolution,
} from '@openanalytics/contracts'
import {
  getRevenueAttributionState,
  readRevenueCredential,
  type Database,
} from '@openanalytics/postgres'
import { Hono } from 'hono'
import type { AnalyticsService, RevenueConnectionInput } from '../analytics/service.ts'
import { decodeRevenueCursor, type RevenueCursor } from '../analytics/revenue-cursor.ts'
import { parseCompare, parseRange, parseResolution } from './analytics.ts'
import {
  requireAnalyticsAccess,
  requireCapability,
  siteMembership,
  type ApiVariables,
} from './middleware.ts'

/**
 * The revenue read surface (ADR-0033, D7). Milestone 12 Checkpoint 5.
 *
 * Four endpoints — summary, timeseries, transactions, journey — and one
 * authorization stack on all of them:
 *
 * ```
 * sessionAuth → siteMembership → requireAnalyticsAccess → requireCapability('revenue:read')
 * ```
 *
 * ## Why this is a separate mount from `analytics.ts`
 *
 * The analytics surface is **membership-gated and capability-free**: 02 §19 gives
 * a viewer analytics read, so `createAnalyticsRoutes` deliberately has no
 * `requireCapability` in front of it. Revenue is the opposite — `revenue:read`
 * has sat in the owner-only set of `packages/domain/src/authz.ts` beside
 * `export:raw` and `site:delete` since M2 with **no route ever requiring it**,
 * and D7 confirms owner-only as the launch posture. Adding a capability gate to
 * a subtree that has none would be one `app.use` away from gating the whole
 * dashboard for admins, so the two live apart.
 *
 * `requireAnalyticsAccess` is still in the stack, and not merely for the
 * `config_version` it sets: 02 §23 closes revenue read with `suspended`
 * exactly as it closes every other analytics read, and the 402 comes from there.
 * Note the contrast with the **connection** routes in `revenue.ts`, which are
 * deliberately NOT behind it — reading the money is what billing gates; severing
 * a provider link is not.
 *
 * ## The connection block is read here, once, per request
 *
 * The service holds a query gateway and nothing else, so the credential row is
 * read at this layer and threaded in. It is what makes an empty response
 * interpretable (D7's `not_connected` / no-sales / `degraded` trichotomy), and
 * it is the newest row of **any** status — a site that connected and then
 * disconnected reads `disconnected`, never `not_connected`, because those are
 * different sentences on the empty-state screen and CP1 kept the row precisely
 * so the API could tell them apart.
 */

type Env = { Variables: ApiVariables }

const REVENUE_RESOLUTIONS: readonly Resolution[] = ['hour', 'day']

/**
 * The credential row, reduced to the four fields the metadata carries.
 *
 * A read failure is not swallowed: it propagates and the route answers 503.
 * Defaulting to `not_connected` on an error would be the exact failure this
 * milestone is named after — a Postgres blip rendering as "you have never
 * connected a provider" on a site that has.
 */
export async function readConnection(
  db: Database,
  siteId: string,
): Promise<RevenueConnectionInput> {
  // Both in one round trip. The control row is what carries OUR half of the
  // freshness story — the provider can be answering perfectly while the
  // projection or attribution loop is dead, and nothing in the credential row
  // can see that (acceptance criterion 3's internal half).
  const [credential, state] = await Promise.all([
    readRevenueCredential(db, { siteId }),
    getRevenueAttributionState(db, siteId),
  ])
  // The epoch is the column's default and means "never computed", not "computed
  // at the dawn of time". Reported as null so freshness reads it as no_data
  // rather than as a watermark fifty-six years behind.
  const rollupThrough =
    state === null || state.computedThrough.getTime() === 0
      ? null
      : state.computedThrough.toISOString()

  if (!credential) {
    return {
      provider: null,
      connectionStatus: 'not_connected',
      lastSyncedAt: null,
      lastWebhookAt: null,
      rollupThrough,
    }
  }
  return {
    provider: credential.provider,
    // `disabled` on the credential row is `disconnected` on the wire: the column
    // describes what we did to the row, the field describes what the customer
    // did to the connection, and only the second is a sentence anybody wants to
    // read on a dashboard.
    connectionStatus:
      credential.status === 'disabled'
        ? 'disconnected'
        : credential.status === 'degraded'
          ? 'degraded'
          : 'connected',
    lastSyncedAt: credential.lastSyncedAt?.toISOString() ?? null,
    lastWebhookAt: credential.lastWebhookAt?.toISOString() ?? null,
    rollupThrough,
  }
}

/**
 * The page size. Bounded by the contract's own constants rather than by numbers
 * repeated here, so the schema and the validator cannot drift.
 */
function parseLimit(query: Record<string, string | undefined>): number {
  const raw = query['limit']
  if (raw === undefined) return DEFAULT_PAGE_SIZE
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
    throw new ApiError('VALIDATION_FAILED', `limit must be an integer in [1, ${MAX_PAGE_SIZE}]`, {
      details: {
        issues: [{ path: 'limit', message: `must be an integer in [1, ${MAX_PAGE_SIZE}]` }],
      },
    })
  }
  return n
}

/**
 * The cursor, decoded — or a typed 400.
 *
 * A malformed cursor is **never** treated as "start from the beginning". A
 * client paging through a customer's transactions would then loop over page one
 * forever with nothing reporting an error, which is the worst possible failure
 * for a list somebody is reconciling against their provider dashboard.
 */
function parseCursor(query: Record<string, string | undefined>): RevenueCursor | null {
  const raw = query['cursor']
  if (raw === undefined || raw === '') return null
  const cursor = decodeRevenueCursor(raw)
  if (cursor === null) {
    throw new ApiError('VALIDATION_FAILED', 'cursor is not a cursor this API issued', {
      details: {
        issues: [{ path: 'cursor', message: 'malformed or from an incompatible version' }],
      },
    })
  }
  return cursor
}

export function createRevenueAnalyticsRoutes(deps: {
  db: Database
  service: AnalyticsService
}): Hono<Env> {
  const { db, service } = deps
  const app = new Hono<Env>()

  const base = '/sites/:site_id/revenue'

  // Every verb below the prefix, in one place, so a route added later cannot be
  // registered without the capability. `revenue:read` is owner-only in the
  // matrix, so an admin and a viewer both get 403 here while keeping full
  // analytics access — which is exactly what 02 §19 separates.
  app.use(
    `${base}/summary`,
    siteMembership(db),
    requireAnalyticsAccess(db),
    requireCapability('revenue:read'),
  )
  app.use(
    `${base}/timeseries`,
    siteMembership(db),
    requireAnalyticsAccess(db),
    requireCapability('revenue:read'),
  )
  // Perier gap 7: subscription MRR and churn, the same stack as /summary.
  app.use(
    `${base}/subscriptions/summary`,
    siteMembership(db),
    requireAnalyticsAccess(db),
    requireCapability('revenue:read'),
  )
  app.use(
    `${base}/subscriptions/timeseries`,
    siteMembership(db),
    requireAnalyticsAccess(db),
    requireCapability('revenue:read'),
  )
  app.use(
    `${base}/transactions`,
    siteMembership(db),
    requireAnalyticsAccess(db),
    requireCapability('revenue:read'),
  )
  app.use(
    `${base}/transactions/:object_id/journey`,
    siteMembership(db),
    requireAnalyticsAccess(db),
    requireCapability('revenue:read'),
  )

  app.get(`${base}/summary`, async (c) => {
    const { siteId } = c.get('membership')
    const query = c.req.query()
    const range = parseRange(query)
    return c.json(
      await service.revenueSummary({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        reportingCurrency: c.get('siteReportingCurrency'),
        connection: await readConnection(db, siteId),
        ...range,
        compare: parseCompare(query),
        resolution: parseResolution(query, REVENUE_RESOLUTIONS),
      }),
    )
  })

  app.get(`${base}/timeseries`, async (c) => {
    const { siteId } = c.get('membership')
    const query = c.req.query()
    const range = parseRange(query)
    return c.json(
      await service.revenueTimeseries({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        reportingCurrency: c.get('siteReportingCurrency'),
        connection: await readConnection(db, siteId),
        ...range,
        resolution: parseResolution(query, REVENUE_RESOLUTIONS),
      }),
    )
  })

  app.get(`${base}/subscriptions/summary`, async (c) => {
    const { siteId } = c.get('membership')
    return c.json(
      await service.subscriptionSummary({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        reportingCurrency: c.get('siteReportingCurrency'),
        connection: await readConnection(db, siteId),
        ...parseRange(c.req.query()),
      }),
    )
  })

  app.get(`${base}/subscriptions/timeseries`, async (c) => {
    const { siteId } = c.get('membership')
    return c.json(
      await service.subscriptionTimeseries({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        reportingCurrency: c.get('siteReportingCurrency'),
        connection: await readConnection(db, siteId),
        ...parseRange(c.req.query()),
      }),
    )
  })

  app.get(`${base}/transactions`, async (c) => {
    const { siteId } = c.get('membership')
    const query = c.req.query()
    const range = parseRange(query)
    return c.json(
      await service.revenueTransactions({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        reportingCurrency: c.get('siteReportingCurrency'),
        connection: await readConnection(db, siteId),
        ...range,
        cursor: parseCursor(query),
        limit: parseLimit(query),
      }),
    )
  })

  app.get(`${base}/transactions/:object_id/journey`, async (c) => {
    const { siteId } = c.get('membership')
    const query = c.req.query()
    const range = parseRange(query)
    const objectId = c.req.param('object_id') ?? ''
    if (objectId.length === 0 || objectId.length > 255) {
      throw new ApiError('NOT_FOUND', 'No such revenue transaction on this site')
    }
    return c.json(
      await service.revenueTransactionJourney({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        reportingCurrency: c.get('siteReportingCurrency'),
        connection: await readConnection(db, siteId),
        ...range,
        objectId,
      }),
    )
  })

  return app
}
