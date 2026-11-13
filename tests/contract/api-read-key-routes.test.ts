import { loadServiceEnv } from '@openanalytics/domain'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { AnalyticsGateway } from '../../apps/api/src/gateway-client.ts'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The key-authenticated read surface, driven through the real app (ADR-0042).
 *
 * The invariant this file exists to hold: **no read reaches the query gateway
 * without a resolvable key, the scope it needs, and the site's own gates
 * passing** — and the gateway-call log is what proves the "without" half, not
 * the status code alone. A route that authorizes late looks identical from the
 * outside until you ask whether it queried first.
 */

const resolvedKey = {
  value: null as { id: string; siteId: string; type: string; scopes: string[] } | null,
}
const siteBasics = {
  value: null as {
    siteId: string
    slug: string
    name: string
    status: string
    configVersion: number
    publishedImportRunId: string | null
    importCutoverDate: string | null
    reportingCurrency: string
  } | null,
}
const finalizerState = { value: null as { finalizedThrough: Date } | null }
const liveTrackingToken = { value: null as string | null }
const touches: string[] = []
const charges: string[] = []

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    resolveReadApiKey: async () => resolvedKey.value,
    getSiteBasics: async () => siteBasics.value,
    getFinalizerState: async () => finalizerState.value,
    getLiveTrackingToken: async () => liveTrackingToken.value,
    touchApiKeyUsage: async (_db: unknown, input: { id: string }) => {
      touches.push(input.id)
      return { touched: true }
    },
    // The cost ledger (ADR-0043 D7). Stubbed rather than disabled, so this file
    // keeps exercising the gate's ordering — check before, charge after — while
    // its numbers and its SQL are proven against a real database elsewhere. The
    // spend is reported as zero, which is "this credential is under budget".
    readCostSpent: async () => 0,
    chargeReadCost: async (_db: unknown, input: { credentialKey: string }) => {
      charges.push(input.credentialKey)
    },
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')
const { AnalyticsService } = await import('../../apps/api/src/analytics/service.ts')
const { InProcessRateLimiter } = await import('../../apps/api/src/http/rate-limit.ts')

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const KEY = 'oa_sk_ZmFrZS10ZXN0LWtleQ'
const RANGE = 'from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC'

let gatewayCalls: string[] = []
let gatewayParams: Record<string, Record<string, unknown>> = {}
/** The gateway's third argument, where `cacheEpoch` travels (not in `params`). */
let gatewayOptions: Record<string, Record<string, unknown>> = {}

/**
 * A session stub that never has a session — enough for `createApp` to mount the
 * business subtree, which is what puts the blanket `401` guard behind the read
 * surface. Only the not-found test needs it.
 */
const noSessionAuth = {
  api: { getSession: async () => null },
  handler: async () => new Response(null),
} as unknown as NonNullable<Parameters<typeof createApp>[0]['auth']>

function buildApp(
  options: {
    withGateway?: boolean
    requestsPerMinute?: number
    withBusinessSubtree?: boolean
  } = {},
) {
  gatewayCalls = []
  gatewayParams = {}
  gatewayOptions = {}
  const gateway: AnalyticsGateway = {
    query: <TRow = Record<string, unknown>>(
      operation: string,
      params?: unknown,
      queryOptions?: unknown,
    ) => {
      gatewayCalls.push(operation)
      gatewayParams[operation] = (params ?? {}) as Record<string, unknown>
      gatewayOptions[operation] = (queryOptions ?? {}) as Record<string, unknown>
      const rows =
        operation === 'analytics.freshness'
          ? [{ watermark: '2026-07-23 14:35:00.000', buckets: '5' }]
          : [{ events: '10', pageviews: '8', visitors: '4', billable_events: '9' }]
      return Promise.resolve({
        operation,
        rows: rows as unknown as readonly TRow[],
        meta: { row_count: rows.length, truncated: false, elapsed_ms: 1, cached: false },
      })
    },
  }
  const { logger } = createCapturedLogger()
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv('api', { ...testEnv(), COLLECTOR_BASE_URL: 'https://c.test' }),
    // No `auth` by default: the read-key surface must not need one, and mounting
    // the business subtree would only give a failure a second way to look right.
    ...(options.withBusinessSubtree ? { auth: noSessionAuth } : {}),
    db: {} as Database,
    ...(options.withGateway === false ? {} : { analytics: new AnalyticsService(gateway) }),
    ...(options.requestsPerMinute === undefined
      ? {}
      : {
          readKey: {
            rateLimiter: new InProcessRateLimiter({
              requestsPerMinute: options.requestsPerMinute,
              burst: options.requestsPerMinute,
            }),
          },
        }),
  })
}

const get = (path: string, token: string | null = KEY, app = buildApp()) =>
  app.fetch(
    new Request(`http://api.test${path}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    }),
  )

const activeSite = () => ({
  siteId: SITE,
  slug: 's',
  name: 'S',
  status: 'active',
  configVersion: 3,
  publishedImportRunId: null,
  importCutoverDate: null,
  reportingCurrency: 'USD',
})

const ANALYTICS_READS = [
  'overview',
  'timeseries',
  'pages',
  'sources',
  'geography',
  'devices',
  'sessions',
] as const

beforeEach(() => {
  resolvedKey.value = null
  siteBasics.value = null
  finalizerState.value = null
  liveTrackingToken.value = null
  touches.length = 0
})

describe('the key is the credential', () => {
  it('401s with no Authorization header, and never touches the gateway', async () => {
    const app = buildApp()
    const res = await get(`/v1/read/analytics/overview?${RANGE}`, null, app)
    expect(res.status).toBe(401)
    expect(gatewayCalls).toHaveLength(0)
  })

  it('refuses a token that is not a private key before it costs a lookup', async () => {
    // A public tracking key is write-only and is accepted on no read endpoint
    // (docs snapshot 02 §20). Here it does not even reach the resolver: the
    // scheme prefix is wrong, so the cheapest flood costs no query at all.
    resolvedKey.value = null
    const app = buildApp()
    const res = await get(`/v1/read/analytics/overview?${RANGE}`, 'oa_pk_public', app)
    expect(res.status).toBe(401)
    expect(gatewayCalls).toHaveLength(0)
  })

  it('401s when the key does not resolve', async () => {
    resolvedKey.value = null
    const app = buildApp()
    expect((await get(`/v1/read/analytics/overview?${RANGE}`, KEY, app)).status).toBe(401)
    expect(gatewayCalls).toHaveLength(0)
  })

  it('records the use of a key that did resolve, once per request', async () => {
    resolvedKey.value = { id: 'key-1', siteId: SITE, type: 'private_read', scopes: ['site:read'] }
    siteBasics.value = activeSite()
    await get('/v1/read/site')
    expect(touches).toEqual(['key-1'])
  })
})

describe('scopes decide what a key may read (D3)', () => {
  it('403s — not 401 — on a key without analytics:read, before the gateway', async () => {
    resolvedKey.value = { id: 'key-1', siteId: SITE, type: 'private_read', scopes: ['site:read'] }
    siteBasics.value = activeSite()

    for (const surface of ANALYTICS_READS) {
      const app = buildApp()
      const res = await get(`/v1/read/analytics/${surface}?${RANGE}`, KEY, app)
      expect(res.status, surface).toBe(403)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code, surface).toBe('FORBIDDEN')
      expect(gatewayCalls, surface).toHaveLength(0)
    }
  })

  it('charges the cost ledger under the credential that made the read (ADR-0043 D7)', async () => {
    // The charge is in a `finally`, so it lands whether the read succeeded or
    // not — a query that failed still spent the time, and not charging it would
    // make failure the cheapest way to hold the gateway open.
    charges.length = 0
    resolvedKey.value = {
      id: 'key-1',
      siteId: SITE,
      type: 'private_read',
      scopes: ['site:read', 'analytics:read'],
    }
    siteBasics.value = activeSite()
    const app = buildApp()
    await app.fetch(
      new Request(
        `http://api.test/v1/read/analytics/overview?from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC`,
        { headers: { authorization: `Bearer ${KEY}` } },
      ),
    )
    // The same spelling the rate limiter charges, so the two gates cannot
    // disagree about who a caller is.
    expect(charges).toEqual(['key:key-1'])
  })

  it('serves every read once the scope is there', async () => {
    resolvedKey.value = {
      id: 'key-1',
      siteId: SITE,
      type: 'private_read',
      scopes: ['site:read', 'analytics:read'],
    }
    siteBasics.value = activeSite()
    finalizerState.value = { finalizedThrough: new Date('2026-07-22T00:00:00.000Z') }

    for (const surface of ANALYTICS_READS) {
      const app = buildApp()
      const res = await get(`/v1/read/analytics/${surface}?${RANGE}`, KEY, app)
      expect(res.status, surface).toBe(200)
      expect(gatewayCalls.length, surface).toBeGreaterThan(0)
    }
  })

  it('lets the minimum scope read the site context but nothing else', async () => {
    resolvedKey.value = { id: 'key-1', siteId: SITE, type: 'private_read', scopes: ['site:read'] }
    siteBasics.value = activeSite()
    expect((await get('/v1/read/site')).status).toBe(200)
  })
})

describe('the person-only reads refuse a key (ADR-0042 D4)', () => {
  it('403s a key holding analytics:read, before the ledger and the gateway', async () => {
    resolvedKey.value = {
      id: 'key-1',
      siteId: SITE,
      type: 'private_read',
      scopes: ['site:read', 'analytics:read'],
    }
    siteBasics.value = activeSite()

    for (const surface of [
      'custom-events',
      'custom-events/properties',
      'performance',
      'funnel',
      'recent-visitors',
      'visitor',
    ]) {
      charges.length = 0
      const app = buildApp({ withBusinessSubtree: true })
      const res = await get(`/v1/read/analytics/${surface}?${RANGE}`, KEY, app)
      expect(res.status, surface).toBe(403)
      const body = (await res.json()) as { error: { code: string; message: string } }
      expect(body.error.code, surface).toBe('FORBIDDEN')
      expect(body.error.message, surface).toContain('belongs to a person')
      expect(gatewayCalls, surface).toHaveLength(0)
      expect(charges, surface).toEqual([])
    }
  })
})

describe('the site is the key’s, and its gates are the site’s (D5)', () => {
  it('never accepts a site id from the caller', async () => {
    resolvedKey.value = {
      id: 'key-1',
      siteId: SITE,
      type: 'private_read',
      scopes: ['site:read', 'analytics:read'],
    }
    siteBasics.value = activeSite()
    // The path that would exist if the surface were site-addressed. It must not.
    const res = await get(`/v1/read/analytics/${SITE}/overview?${RANGE}`)
    expect(res.status).toBe(404)
  })

  it('closes a suspended site with 403, before the gateway', async () => {
    resolvedKey.value = {
      id: 'key-1',
      siteId: SITE,
      type: 'private_read',
      scopes: ['site:read', 'analytics:read'],
    }
    siteBasics.value = { ...activeSite(), status: 'suspended' }
    const app = buildApp()
    const res = await get(`/v1/read/analytics/overview?${RANGE}`, KEY, app)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('SITE_SUSPENDED')
    expect(gatewayCalls).toHaveLength(0)
  })

  it('reports a deleting site as SITE_NOT_FOUND, like every other surface', async () => {
    resolvedKey.value = {
      id: 'key-1',
      siteId: SITE,
      type: 'private_read',
      scopes: ['site:read', 'analytics:read'],
    }
    siteBasics.value = { ...activeSite(), status: 'deleting' }
    const app = buildApp()
    const res = await get(`/v1/read/analytics/overview?${RANGE}`, KEY, app)
    expect(res.status).toBe(404)
    expect(gatewayCalls).toHaveLength(0)
  })

  /**
   * The cache epoch is what makes every entry cached under a previous
   * `config_version` unreachable after a lifecycle transition (ADR-0030, D6).
   * A door that resolved its own site but forgot the epoch would serve stale
   * numbers from a site that had just been blocked and restored — so this
   * asserts the value reached the gateway, not merely that the read succeeded.
   */
  it('passes the site’s config_version to the gateway as the cache epoch', async () => {
    resolvedKey.value = {
      id: 'key-1',
      siteId: SITE,
      type: 'private_read',
      scopes: ['site:read', 'analytics:read'],
    }
    siteBasics.value = { ...activeSite(), configVersion: 9 }
    const app = buildApp()
    expect((await get(`/v1/read/analytics/overview?${RANGE}`, KEY, app)).status).toBe(200)

    const operation = gatewayParams['analytics.overview_day']
      ? 'analytics.overview_day'
      : 'analytics.overview_hour'
    expect(gatewayParams[operation]?.['site_id']).toBe(SITE)
    expect(gatewayOptions[operation]?.['cacheEpoch']).toBe(9)
  })
})

describe('the install block (D8)', () => {
  it('hands back the tracking key and both URLs derived from one origin', async () => {
    resolvedKey.value = { id: 'key-1', siteId: SITE, type: 'private_read', scopes: ['site:read'] }
    siteBasics.value = activeSite()
    liveTrackingToken.value = 'oa_pk_live'

    const body = (await (await get('/v1/read/site')).json()) as {
      site_id: string
      install: {
        tracking_key: string | null
        script_url: string | null
        collector_url: string | null
      }
    }
    expect(body.site_id).toBe(SITE)
    expect(body.install).toEqual({
      tracking_key: 'oa_pk_live',
      script_url: 'https://c.test/oa.js',
      collector_url: 'https://c.test',
    })
  })

  it('says null rather than guessing when the site has no live tracking key', async () => {
    resolvedKey.value = { id: 'key-1', siteId: SITE, type: 'private_read', scopes: ['site:read'] }
    siteBasics.value = activeSite()
    liveTrackingToken.value = null

    const body = (await (await get('/v1/read/site')).json()) as {
      install: { tracking_key: string | null }
    }
    expect(body.install.tracking_key).toBeNull()
  })
})

describe('the budget is the credential’s, not the address’s (D6)', () => {
  it('429s a key that spends its budget, and leaves another key’s untouched', async () => {
    const app = buildApp({ requestsPerMinute: 2 })
    siteBasics.value = activeSite()
    const scopes = ['site:read', 'analytics:read']

    resolvedKey.value = { id: 'key-noisy', siteId: SITE, type: 'private_read', scopes }
    expect((await get('/v1/read/site', KEY, app)).status).toBe(200)
    expect((await get('/v1/read/site', KEY, app)).status).toBe(200)

    const limited = await get('/v1/read/site', KEY, app)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).not.toBeNull()

    // The neighbour on the same address. Under an IP-keyed budget this would be
    // refused too, which is the outcome D6 exists to prevent: a WordPress site
    // behind a shared host must not be able to spend its neighbours' quota.
    resolvedKey.value = { id: 'key-quiet', siteId: SITE, type: 'private_read', scopes }
    expect((await get('/v1/read/site', KEY, app)).status).toBe(200)
  })

  it('charges the address, not a key, when nothing resolved', async () => {
    const app = buildApp({ requestsPerMinute: 2 })
    resolvedKey.value = null

    expect((await get('/v1/read/site', KEY, app)).status).toBe(401)
    expect((await get('/v1/read/site', KEY, app)).status).toBe(401)
    // Third refusal in the window: the unauthenticated caller has spent the IP
    // budget, so the flood stops costing a lookup per request.
    expect((await get('/v1/read/site', KEY, app)).status).toBe(429)
  })
})

describe('a path that does not exist says so', () => {
  /**
   * **Built `withBusinessSubtree`, and that is the whole point of the test.**
   *
   * Every other case in this file builds an app with no `auth`, which is the
   * right isolation for them. Here it would make the assertion vacuous: with no
   * business subtree mounted, an unknown `/v1/read/...` reaches Hono's default
   * not-found and answers `404` whether or not the catch-all exists. Production
   * mounts the session guard, and *that* is what turns the same request into a
   * `401`. The first version of this test passed with the catch-all deleted;
   * this one does not.
   */
  it('404s an authenticated caller on an excluded surface, and 401s an anonymous one', async () => {
    resolvedKey.value = {
      id: 'key-1',
      siteId: SITE,
      type: 'private_read',
      scopes: ['site:read', 'analytics:read'],
    }
    siteBasics.value = activeSite()

    for (const excluded of ['revenue', 'revenue/transactions']) {
      const app = buildApp({ withBusinessSubtree: true })
      const res = await get(`/v1/read/analytics/${excluded}?${RANGE}`, KEY, app)
      expect(res.status, excluded).toBe(404)
      expect(gatewayCalls, excluded).toHaveLength(0)
    }

    // The anonymous caller learns nothing about which paths exist.
    const anonymous = await get(
      `/v1/read/analytics/revenue?${RANGE}`,
      null,
      buildApp({ withBusinessSubtree: true }),
    )
    expect(anonymous.status).toBe(401)
  })
})

describe('an unconfigured deployment says so', () => {
  /**
   * Without a query gateway the reads answer `SERVICE_UNAVAILABLE`, not `401`.
   * Not mounting them would send the request to the business subtree's session
   * guard, which would tell a caller holding a valid key to go re-check it.
   */
  it('503s the analytics reads with no gateway, and still serves the site context', async () => {
    resolvedKey.value = {
      id: 'key-1',
      siteId: SITE,
      type: 'private_read',
      scopes: ['site:read', 'analytics:read'],
    }
    siteBasics.value = activeSite()

    const app = buildApp({ withGateway: false })
    const res = await get(`/v1/read/analytics/overview?${RANGE}`, KEY, app)
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE')

    expect((await get('/v1/read/site', KEY, app)).status).toBe(200)
  })
})
