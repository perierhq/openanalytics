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
/** The same person, through a client that also asked for `revenue:read`. */
const OAUTH_TOKEN_REVENUE = 'IIIIIIIIJJJJJJJJKKKKKKKKLLLLLLLL'
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
const STORED_FUNNEL = '0190f0aa-1111-7222-8333-444455556666'
/** The stored funnel, as `getFunnel` returns it for `SITE` and no other site. */
const storedFunnel = {
  id: STORED_FUNNEL,
  siteId: SITE,
  name: 'Checkout',
  steps: ['/cart', 'checkout_started', '/thanks'],
  scope: 'session' as const,
  windowMs: 3_600_000,
  createdByUserId: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  archivedAt: null,
}
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
      if (token === OAUTH_TOKEN_REVENUE) {
        return { id: 'grant-3', userId: USER, scopes: 'site:read analytics:read revenue:read' }
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
    getFunnel: async (_db: unknown, input: { id: string; siteId: string }) =>
      input.id === STORED_FUNNEL && input.siteId === SITE ? storedFunnel : null,
    getEventPropertyAllowlist: async (_db: unknown, input: { eventName: string }) =>
      input.eventName === 'plan_selected' ? ['plan'] : null,
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
  if (operation === 'analytics.recent_visitors') {
    return [
      {
        visitor: 'v-1',
        user_id: '',
        country: 'DE',
        device_type: 'desktop',
        browser: 'Firefox',
        os: 'Linux',
        first_seen: '2026-07-23 14:00:00.000',
        last_seen: '2026-07-23 14:30:00.000',
        pageviews: '3',
      },
    ]
  }
  if (operation === 'analytics.visitor_revenue') {
    return [{ visitor_key: 'v-1', amount_minor: '4200', currency: 'EUR', transaction_count: '1' }]
  }
  if (operation === 'analytics.visitor_trail') {
    return [
      {
        session_id: 's-1',
        event_id: 'e-1',
        occurred_at: '2026-07-23 14:00:00.000',
        page_path: '/',
        page_title: 'Home',
        referrer_domain: '',
      },
    ]
  }
  if (operation === 'analytics.visitor_revenue_entries') {
    return [
      {
        object_id: 'ch_secret_order',
        occurred_at: '2026-07-23 14:10:00.000',
        status: 'succeeded',
        currency: 'EUR',
        gross_minor: '4200',
        reporting_currency: 'EUR',
        reporting_gross_minor: '4200',
        conversion_source: 'identity',
        session_id: 's-1',
      },
    ]
  }
  if (operation.startsWith('analytics.custom_event_properties')) {
    return [
      { property_key: 'plan', property_value: 'yearly', is_other: 0, events: '7', visitors: '6' },
      { property_key: 'plan', property_value: 'monthly', is_other: 0, events: '3', visitors: '3' },
      { property_key: 'plan', property_value: '', is_other: 1, events: '2', visitors: '2' },
    ]
  }
  if (operation.startsWith('analytics.funnel_')) {
    return [
      {
        step_1: '10',
        step_2: '4',
        step_3: '1',
        buyers_1: '2',
        buyers_2: '2',
        buyers_3: '1',
        revenue_1: '7998',
        revenue_2: '7998',
        revenue_3: '3999',
        currency: 'EUR',
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

  it('breaks one event down by property value, under its definition’s allowlist', async () => {
    const app = buildApp()
    const res = await get(
      app,
      `/v1/read/analytics/custom-events/properties?${RANGE}&event_name=plan_selected&limit=2`,
      asToken(OAUTH_TOKEN),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      event_name: string
      properties: {
        key: string
        values: { value: string; events: number }[]
        other: { events: number } | null
      }[]
    }
    expect(body.event_name).toBe('plan_selected')
    expect(body.properties).toEqual([
      {
        key: 'plan',
        values: [
          { value: 'yearly', events: 7, visitors: 6 },
          { value: 'monthly', events: 3, visitors: 3 },
        ],
        other: { events: 2, visitors: 2 },
      },
    ])
    const op = gatewayCalls.find((call) => call.startsWith('analytics.custom_event_properties'))!
    expect(gatewayParams[op]).toMatchObject({
      site_id: SITE,
      event_name: 'plan_selected',
      all_keys: false,
      keys: ['plan'],
      limit: 2,
    })
    expect(charges).toEqual(['oauth:grant-1'])
  })

  it('reads every key of an event no definition restricts, and refuses a bad name', async () => {
    const app = buildApp()
    const res = await get(
      app,
      `/v1/read/analytics/custom-events/properties?${RANGE}&event_name=signup`,
      asSession(),
    )
    expect(res.status).toBe(200)
    const op = gatewayCalls.find((call) => call.startsWith('analytics.custom_event_properties'))!
    expect(gatewayParams[op]).toMatchObject({ all_keys: true, keys: [], limit: 10 })

    for (const query of ['', '&event_name=%20bad', '&event_name=ok&limit=51']) {
      gatewayCalls = []
      const bad = await get(
        buildApp(),
        `/v1/read/analytics/custom-events/properties?${RANGE}${query}`,
        asSession(),
      )
      expect(bad.status, query).toBe(400)
      expect(gatewayCalls, query).toHaveLength(0)
    }
  })

  it('refuses a token without analytics:read, before the gateway', async () => {
    for (const path of ['custom-events', 'custom-events/properties', 'performance', 'funnel']) {
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
    for (const path of ['custom-events', 'performance', 'funnel']) {
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

describe('funnels, stored or ad hoc', () => {
  it('runs a stored funnel with its own steps, scope and window', async () => {
    const app = buildApp()
    const res = await get(
      app,
      `/v1/read/analytics/funnel?${RANGE}&funnel_id=${STORED_FUNNEL}`,
      asToken(OAUTH_TOKEN),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      meta: { scope: string; window_ms: number }
      steps: { key: string; count: number; conversion_rate: number }[]
    }
    expect(body.steps.map((step) => [step.key, step.count, step.conversion_rate])).toEqual([
      ['/cart', 10, 1],
      ['checkout_started', 4, 0.4],
      ['/thanks', 1, 0.1],
    ])
    expect(body.meta).toMatchObject({ scope: 'session', window_ms: 3_600_000 })
    expect(gatewayParams['analytics.funnel_session']).toMatchObject({
      site_id: SITE,
      steps: ['/cart', 'checkout_started', '/thanks'],
      window_ms: 3_600_000,
    })
  })

  it('runs ad-hoc steps, as the dashboard route does', async () => {
    const app = buildApp()
    const res = await get(
      app,
      `/v1/read/analytics/funnel?${RANGE}&steps=%2Fpricing&steps=signup&window_ms=86400000`,
      asSession(),
    )
    expect(res.status).toBe(200)
    expect(gatewayParams['analytics.funnel_visitor']).toMatchObject({
      steps: ['/pricing', 'signup'],
      window_ms: 86_400_000,
    })
  })

  it('refuses a stored id together with ad-hoc steps, naming the conflict', async () => {
    const app = buildApp()
    const res = await get(
      app,
      `/v1/read/analytics/funnel?${RANGE}&funnel_id=${STORED_FUNNEL}&steps=%2Fa&steps=%2Fb`,
      asToken(OAUTH_TOKEN),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.message).toContain('not both')
    expect(gatewayCalls).toHaveLength(0)
  })

  it('answers another site’s funnel, an unknown id and a malformed one alike', async () => {
    for (const id of ['0190f0aa-9999-7222-8333-444455556666', 'not-a-uuid']) {
      const app = buildApp()
      const res = await get(
        app,
        `/v1/read/analytics/funnel?${RANGE}&funnel_id=${id}`,
        asToken(OAUTH_TOKEN),
      )
      expect(res.status, id).toBe(404)
      expect(((await res.json()) as { error: { code: string } }).error.code, id).toBe('NOT_FOUND')
      expect(gatewayCalls, id).toHaveLength(0)
    }
  })

  it('serves buyers and revenue per step to an owner whose grant asked for revenue', async () => {
    const app = buildApp()
    const res = await get(
      app,
      `/v1/read/analytics/funnel?${RANGE}&funnel_id=${STORED_FUNNEL}`,
      asToken(OAUTH_TOKEN_REVENUE),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      steps: { buyers?: number; revenue_minor?: number }[]
      currency?: string | null
    }
    expect(body.steps.map((step) => [step.buyers, step.revenue_minor])).toEqual([
      [2, 7998],
      [2, 7998],
      [1, 3999],
    ])
    expect(body.currency).toBe('EUR')
    expect(gatewayParams['analytics.funnel_session']).toMatchObject({ with_revenue: true })
  })

  it('withholds funnel revenue without the scope or without the owner role', async () => {
    for (const [role, token] of [
      ['owner', OAUTH_TOKEN],
      ['admin', OAUTH_TOKEN_REVENUE],
    ] as const) {
      membershipRole.value = role
      const app = buildApp()
      const res = await get(
        app,
        `/v1/read/analytics/funnel?${RANGE}&funnel_id=${STORED_FUNNEL}`,
        asToken(token),
      )
      expect(res.status, role).toBe(200)
      const body = (await res.json()) as { steps: Record<string, unknown>[] }
      expect(body.steps[0], role).not.toHaveProperty('buyers')
      expect(body, role).not.toHaveProperty('currency')
      // Not computed and then hidden: the gateway is told not to read money.
      expect(gatewayParams['analytics.funnel_session'], role).toMatchObject({
        with_revenue: false,
      })
    }
  })

  it('refuses ad-hoc steps without a window, through the domain schema', async () => {
    const app = buildApp()
    const res = await get(
      app,
      `/v1/read/analytics/funnel?${RANGE}&steps=%2Fa&steps=%2Fb`,
      asToken(OAUTH_TOKEN),
    )
    expect(res.status).toBe(400)
    expect(gatewayCalls).toHaveLength(0)
  })
})

describe('recent visitors and one visitor’s trail', () => {
  const HASH = 'hash=v-1&timezone=UTC'

  it('serves the rows, with the revenue marker for an owner whose grant asked for revenue', async () => {
    const app = buildApp()
    const res = await get(
      app,
      '/v1/read/analytics/recent-visitors?timezone=UTC',
      asToken(OAUTH_TOKEN_REVENUE),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { visitor: string; revenue?: unknown }[] }
    expect(body.items).toEqual([
      expect.objectContaining({
        visitor: 'v-1',
        pageviews: 3,
        revenue: { amount_minor: 4200, currency: 'EUR', transaction_count: 1 },
      }),
    ])
  })

  it('withholds revenue from an owner whose grant did not ask for it — the scope is a ceiling', async () => {
    const app = buildApp()
    const res = await get(
      app,
      '/v1/read/analytics/recent-visitors?timezone=UTC',
      asToken(OAUTH_TOKEN),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Record<string, unknown>[] }
    expect(body.items[0]).not.toHaveProperty('revenue')
    // Not computed and then hidden: the revenue query is never made.
    expect(gatewayCalls).not.toContain('analytics.visitor_revenue')
  })

  it('withholds revenue from a non-owner who holds the scope — the role is the floor', async () => {
    membershipRole.value = 'admin'
    const app = buildApp()
    const res = await get(
      app,
      '/v1/read/analytics/recent-visitors?timezone=UTC',
      asToken(OAUTH_TOKEN_REVENUE),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Record<string, unknown>[] }
    expect(body.items[0]).not.toHaveProperty('revenue')
    expect(gatewayCalls).not.toContain('analytics.visitor_revenue')
  })

  it('serves an owner’s session the marker, as the dashboard does', async () => {
    const app = buildApp()
    const res = await get(app, '/v1/read/analytics/recent-visitors?timezone=UTC', asSession())
    const body = (await res.json()) as { items: Record<string, unknown>[] }
    expect(body.items[0]).toHaveProperty('revenue')
  })

  it('serves the trail with the summed marker and never the journey entries', async () => {
    const app = buildApp()
    const res = await get(app, `/v1/read/analytics/visitor?${HASH}`, asToken(OAUTH_TOKEN_REVENUE))
    expect(res.status).toBe(200)
    const text = await res.text()
    const body = JSON.parse(text) as Record<string, unknown>
    expect(body['visitor']).toBe('v-1')
    expect(body['revenue']).toEqual({ amount_minor: 4200, currency: 'EUR', transaction_count: 1 })
    expect(body).not.toHaveProperty('revenue_events')
    // The provider's object id rides only in the journey entries.
    expect(text).not.toContain('ch_secret_order')
  })

  it('refuses a missing hash and a window past a day, before the gateway', async () => {
    for (const query of ['timezone=UTC', `${HASH}&hours=25`]) {
      const app = buildApp()
      const res = await get(app, `/v1/read/analytics/visitor?${query}`, asToken(OAUTH_TOKEN))
      expect(res.status, query).toBe(400)
      expect(gatewayCalls, query).toHaveLength(0)
    }
  })
})

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

  it('funnel_results runs a stored funnel and ad-hoc steps exactly as the route does', async () => {
    const stored = await callTool(buildApp(), 'funnel_results', {
      site_id: SITE,
      ...range,
      funnel_id: STORED_FUNNEL,
    })
    expect(stored.isError).toBe(false)
    const storedRoute = await get(
      buildApp(),
      `/v1/read/analytics/funnel?${RANGE}&funnel_id=${STORED_FUNNEL}`,
      asToken(OAUTH_TOKEN),
    )
    expect(stored.body).toEqual(await storedRoute.json())

    const adHoc = await callTool(buildApp(), 'funnel_results', {
      site_id: SITE,
      ...range,
      steps: ['/pricing', 'signup'],
      window_ms: '86400000',
    })
    expect(adHoc.isError).toBe(false)
    const adHocRoute = await get(
      buildApp(),
      `/v1/read/analytics/funnel?${RANGE}&steps=%2Fpricing&steps=signup&window_ms=86400000`,
      asToken(OAUTH_TOKEN),
    )
    expect(adHoc.body).toEqual(await adHocRoute.json())
  })

  it('recent_visitors and visitor answer what the routes answer, in the site’s zone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-23T15:00:00.000Z'))
    try {
      const list = await callTool(buildApp(), 'recent_visitors', { site_id: SITE, timezone: 'UTC' })
      expect(list.isError).toBe(false)
      const listRoute = await get(
        buildApp(),
        '/v1/read/analytics/recent-visitors?timezone=UTC',
        asToken(OAUTH_TOKEN),
      )
      expect(list.body).toEqual(await listRoute.json())

      const trail = await callTool(buildApp(), 'visitor', {
        site_id: SITE,
        hash: 'v-1',
        hours: '6',
        timezone: 'UTC',
      })
      expect(trail.isError).toBe(false)
      const trailRoute = await get(
        buildApp(),
        '/v1/read/analytics/visitor?hash=v-1&hours=6&timezone=UTC',
        asToken(OAUTH_TOKEN),
      )
      expect(trail.body).toEqual(await trailRoute.json())
    } finally {
      vi.useRealTimers()
    }
  })

  it('visitor refuses a call without the hash, naming it', async () => {
    const res = await buildApp().fetch(
      new Request('http://api.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${OAUTH_TOKEN}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'visitor', arguments: { site_id: SITE } },
        }),
      }),
    )
    const envelope = (await res.json()) as { error?: { message: string } }
    expect(envelope.error?.message).toBe('visitor requires hash')
  })
})
