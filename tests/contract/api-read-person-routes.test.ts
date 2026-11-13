import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { AnalyticsGateway } from '../../apps/api/src/gateway-client.ts'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The person-only analytics reads on `/v1/read` (`PERSON_ONLY_ANALYTICS_READS`).
 *
 * ADR-0042 D4 kept these reports off the key surface, and a key is still
 * refused (`api-read-key-routes.test.ts` holds that half). What this file holds
 * is the other half: an OAuth token and a session reach them through the same
 * gates as every other `/v1/read` route — live membership, the scope, the
 * site's lifecycle, the cost ledger — and get the dashboard's own response.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const OTHER_SITE = '8b7c6d55-1111-4222-8333-444455556666'
const OAUTH_TOKEN = 'AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD'
/** The same person, through a client whose grant carries no `analytics:read`. */
const OAUTH_TOKEN_SITE_ONLY = 'EEEEEEEEFFFFFFFFGGGGGGGGHHHHHHHH'
const COOKIE = 'oa_session=live-session-value'
const USER = 'ff33a1c0-1111-4222-8333-999900001111'
const RANGE = 'from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC'

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
const membershipRole = { value: 'owner' as 'owner' | 'admin' | 'viewer' }
const charges: string[] = []

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    resolveReadApiKey: async () => null,
    resolveOAuthAccessToken: async (_db: unknown, token: string) => {
      if (token === OAUTH_TOKEN) {
        return { id: 'grant-1', userId: USER, scopes: 'site:read analytics:read' }
      }
      if (token === OAUTH_TOKEN_SITE_ONLY) {
        return { id: 'grant-2', userId: USER, scopes: 'site:read' }
      }
      return null
    },
    getMembership: async (_db: unknown, input: { siteId: string; userId: string }) =>
      input.siteId === SITE && input.userId === USER
        ? { role: membershipRole.value, isBillingOwner: true }
        : null,
    getSiteBasics: async () => siteBasics.value,
    getFinalizerState: async () => null,
    listEventDisplayNames: async () => [
      { eventName: 'signup', displayName: 'Signed up', displayTemplate: '{{plan}} signup' },
    ],
    readCostSpent: async () => 0,
    chargeReadCost: async (_db: unknown, input: { credentialKey: string }) => {
      charges.push(input.credentialKey)
    },
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')
const { AnalyticsService } = await import('../../apps/api/src/analytics/service.ts')

const sessionAuth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) =>
      headers.get('cookie')?.includes('oa_session=live-session-value') === true
        ? {
            user: {
              id: USER,
              email: 'a@b.test',
              emailVerified: true,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
            },
            session: { createdAt: new Date('2026-07-23T00:00:00.000Z') },
          }
        : null,
  },
  handler: async () => new Response(null),
} as unknown as Auth

let gatewayCalls: string[] = []
let gatewayParams: Record<string, Record<string, unknown>> = {}

/** Rows per operation family, in the shapes the service maps. */
function rowsFor(operation: string): Record<string, unknown>[] {
  if (operation === 'analytics.freshness') {
    return [{ watermark: '2026-07-23 14:35:00.000', buckets: '5' }]
  }
  if (operation.startsWith('analytics.custom_event_samples')) return []
  if (operation.startsWith('analytics.custom_events')) {
    return [
      {
        event_name: 'signup',
        event_type: 'custom',
        events: '3',
        billable_events: '3',
        visitors: '2',
      },
      {
        event_name: 'download',
        event_type: 'custom',
        events: '1',
        billable_events: '1',
        visitors: '1',
      },
    ]
  }
  if (operation.startsWith('analytics.performance')) {
    return [
      {
        metric: 'LCP',
        device_type: 'desktop',
        samples: '4',
        value_sum: '8000',
        percentiles: [1500, 2000, 2500, 2800, 3000],
        good_samples: '3',
        needs_improvement_samples: '1',
        poor_samples: '0',
      },
    ]
  }
  return []
}

function buildApp() {
  gatewayCalls = []
  gatewayParams = {}
  const gateway: AnalyticsGateway = {
    query: <TRow = Record<string, unknown>>(operation: string, params?: unknown) => {
      gatewayCalls.push(operation)
      gatewayParams[operation] = (params ?? {}) as Record<string, unknown>
      const rows = rowsFor(operation)
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
    env: loadServiceEnv('api', testEnv()),
    auth: sessionAuth,
    db: {} as Database,
    analytics: new AnalyticsService(gateway, {
      now: () => new Date('2026-07-23T15:00:00.000Z'),
    }),
    readKey: {
      rateLimiter: { check: () => ({ allowed: true, retryAfterSeconds: 0 }) },
      cost: { maxRangeDays: 400, dailyBudgetMs: 600_000 },
    },
  })
}

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

const asToken = (token: string, siteId: string = SITE): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'x-oa-site': siteId,
})
const asSession = (siteId: string = SITE): Record<string, string> => ({
  cookie: COOKIE,
  'x-oa-site': siteId,
})

const get = (app: ReturnType<typeof buildApp>, path: string, headers: Record<string, string>) =>
  app.fetch(new Request(`http://api.test${path}`, { headers }))

beforeEach(() => {
  siteBasics.value = activeSite()
  membershipRole.value = 'owner'
  charges.length = 0
})

describe('custom events and performance, for a person', () => {
  it('serves custom events with the dashboard labels to an OAuth token', async () => {
    const app = buildApp()
    const res = await get(app, `/v1/read/analytics/custom-events?${RANGE}`, asToken(OAUTH_TOKEN))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: { event_name: string; display_name: string | null; display_template: string | null }[]
    }
    expect(body.items.map((item) => [item.event_name, item.display_name])).toEqual([
      ['signup', 'Signed up'],
      ['download', null],
    ])
    expect(body.items[0]?.display_template).toBe('{{plan}} signup')
    expect(
      gatewayParams[gatewayCalls.find((op) => op.startsWith('analytics.custom_events'))!],
    ).toMatchObject({
      site_id: SITE,
    })
    expect(charges).toEqual(['oauth:grant-1'])
  })

  it('serves web vitals to a session, on the person’s budget', async () => {
    const app = buildApp()
    const res = await get(app, `/v1/read/analytics/performance?${RANGE}`, asSession())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { metric: string; mean: number; p75: number }[] }
    expect(body.items).toEqual([expect.objectContaining({ metric: 'LCP', mean: 2000, p75: 2000 })])
    expect(charges).toEqual([`user:${USER}`])
  })

  it('refuses a token without analytics:read, before the gateway', async () => {
    for (const path of ['custom-events', 'performance']) {
      const app = buildApp()
      const res = await get(
        app,
        `/v1/read/analytics/${path}?${RANGE}`,
        asToken(OAUTH_TOKEN_SITE_ONLY),
      )
      expect(res.status, path).toBe(403)
      expect(gatewayCalls, path).toHaveLength(0)
    }
  })

  it('answers a site the person is not a member of as SITE_NOT_FOUND', async () => {
    for (const path of ['custom-events', 'performance']) {
      const app = buildApp()
      const res = await get(
        app,
        `/v1/read/analytics/${path}?${RANGE}`,
        asToken(OAUTH_TOKEN, OTHER_SITE),
      )
      expect(res.status, path).toBe(404)
      expect(gatewayCalls, path).toHaveLength(0)
    }
  })

  it('closes a suspended site, as every other read does', async () => {
    siteBasics.value = { ...activeSite(), status: 'suspended' }
    const app = buildApp()
    const res = await get(app, `/v1/read/analytics/custom-events?${RANGE}`, asToken(OAUTH_TOKEN))
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SITE_SUSPENDED')
    expect(gatewayCalls).toHaveLength(0)
  })
})

/** One JSON-RPC call against `/mcp`, the way an MCP host makes it. */
async function callTool(
  app: ReturnType<typeof buildApp>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: unknown }> {
  const res = await app.fetch(
    new Request('http://api.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OAUTH_TOKEN}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
  )
  expect(res.status).toBe(200)
  const envelope = (await res.json()) as {
    result: { content: { text: string }[]; isError: boolean }
  }
  return {
    isError: envelope.result.isError,
    body: JSON.parse(envelope.result.content[0]?.text ?? 'null'),
  }
}

describe('the MCP tools are these routes', () => {
  const range = {
    from: '2026-07-16T00:00:00.000Z',
    to: '2026-07-23T00:00:00.000Z',
    timezone: 'UTC',
  }

  it('custom_events and performance answer exactly what the route answers', async () => {
    for (const [tool, path] of [
      ['custom_events', 'custom-events'],
      ['performance', 'performance'],
    ] as const) {
      const viaTool = await callTool(buildApp(), tool, { site_id: SITE, ...range })
      expect(viaTool.isError, tool).toBe(false)
      const viaRoute = await get(
        buildApp(),
        `/v1/read/analytics/${path}?${RANGE}`,
        asToken(OAUTH_TOKEN),
      )
      expect(viaTool.body, tool).toEqual(await viaRoute.json())
    }
  })
})
