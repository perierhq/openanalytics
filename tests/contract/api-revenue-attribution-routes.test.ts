import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { AnalyticsGateway } from '../../apps/api/src/gateway-client.ts'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Revenue by source / entry page and the events before a purchase (Perier
 * fork, DataFast gaps 3 and 4), through the real app and its middleware.
 *
 * - **Owner-only on both surfaces.** The session routes sit behind
 *   `requireCapability('revenue:read')`; the `/v1/read/revenue` twins behind the
 *   scope-and-role intersection. An admin and a viewer are refused on both.
 * - **The visitors denominator is optional and says so.** Up to 92 days the
 *   breakdown carries visitors, conversion rate and revenue per visitor; above
 *   it the three are `null` with `visitors_available: false`, and the visitors
 *   read is never sent. A failed visitors read keeps the revenue answer and
 *   marks the response `partial`.
 * - **Unattributed revenue keeps its row** (`value: null`), with no visitors.
 * - **The raw-event read is bounded in the api too**: over 92 days is a named
 *   `RANGE_TOO_LARGE`, before the gateway is asked.
 * - **The two MCP tools are the read routes**, and the assistant does not get
 *   them.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const USER = 'ff33a1c0-1111-4222-8333-999900001111'
const COOKIE = 'oa_session=live-session-value'
const OAUTH_TOKEN = 'AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD'
const RANGE = 'from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC'
/** 120 days: inside the breakdown's cap, over the visitors and raw-event caps. */
const LONG_RANGE = 'from=2026-03-25T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC'

const membershipRole = { value: 'owner' as 'owner' | 'admin' | 'viewer' }
const world = {
  visitorsFail: false,
  calls: [] as { operation: string; params: Record<string, unknown> }[],
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    resolveReadApiKey: async () => null,
    resolveOAuthAccessToken: async (_db: unknown, token: string) =>
      token === OAUTH_TOKEN
        ? { id: 'grant-1', userId: USER, scopes: 'site:read analytics:read revenue:read' }
        : null,
    getMembership: async (_db: unknown, input: { siteId: string; userId: string }) =>
      input.siteId === SITE && input.userId === USER
        ? { role: membershipRole.value, isBillingOwner: true }
        : null,
    getSiteBasics: async () => ({
      siteId: SITE,
      slug: 's',
      name: 'S',
      status: 'active',
      configVersion: 3,
      publishedImportRunId: null,
      importCutoverDate: null,
      reportingCurrency: 'EUR',
    }),
    getFinalizerState: async () => null,
    readRevenueCredential: async () => null,
    getRevenueAttributionState: async () => null,
    readCostSpent: async () => 0,
    chargeReadCost: async () => undefined,
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')
const { AnalyticsService } = await import('../../apps/api/src/analytics/service.ts')
const { ASSISTANT_TOOLS } = await import('../../apps/api/src/http/assistant.ts')

const ATTRIBUTION_ROWS = [
  { value: null, revenue_minor: '1000', orders: '2', unconverted_orders: '0', buyers: '0' },
  { value: 'google.com', revenue_minor: '3500', orders: '3', unconverted_orders: '0', buyers: '2' },
  { value: '', revenue_minor: '0', orders: '1', unconverted_orders: '1', buyers: '1' },
]

const EVENT_ROWS = [
  {
    event_name: 'paywall_viewed',
    event_type: 'custom',
    buyers: '2',
    events: '3',
    non_buyer_visitors: '5',
  },
  {
    event_name: 'ben_chat',
    event_type: 'custom',
    buyers: '0',
    events: '0',
    non_buyer_visitors: '1',
  },
]

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

function buildApp() {
  const gateway: AnalyticsGateway = {
    query: <TRow = Record<string, unknown>>(operation: string, params?: unknown) => {
      world.calls.push({ operation, params: (params ?? {}) as Record<string, unknown> })
      let rows: unknown[] = []
      if (operation === 'analytics.freshness') {
        rows = [{ watermark: '2026-07-23 14:35:00.000', buckets: '5' }]
      } else if (operation.startsWith('analytics.revenue_attribution_visitors_')) {
        if (world.visitorsFail) return Promise.reject(new Error('gateway said no'))
        rows = [{ value: 'google.com', visitors: '40' }]
      } else if (operation.startsWith('analytics.revenue_attribution_')) {
        rows = ATTRIBUTION_ROWS
      } else if (operation === 'analytics.revenue_events_before_purchase') {
        rows = EVENT_ROWS
      } else if (operation === 'analytics.revenue_purchase_population') {
        rows = [{ buyers_total: '4', visitors_total: '54' }]
      }
      return Promise.resolve({
        operation,
        rows: rows as TRow[],
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

async function get(path: string, headers: Record<string, string>): Promise<Response> {
  return buildApp().fetch(new Request(`http://api.test${path}`, { headers }))
}

const session = { cookie: COOKIE }
const sessionRead = { cookie: COOKIE, 'x-oa-site': SITE }
const tokenRead = { authorization: `Bearer ${OAUTH_TOKEN}`, 'x-oa-site': SITE }

const sitePath = (name: string, query = RANGE) => `/v1/sites/${SITE}/revenue/${name}?${query}`
const readPath = (name: string, query = RANGE) => `/v1/read/revenue/${name}?${query}`

const operations = () => world.calls.map((call) => call.operation)
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error

interface AttributionBody {
  meta: { partial: boolean; revenue: { connection_status: string } }
  touch: string
  dimension: string
  currency: string
  visitors_available: boolean
  rows: {
    value: string | null
    revenue_minor: number
    orders: number
    unconverted_orders: number
    buyers: number
    visitors: number | null
    conversion_rate: number | null
    revenue_per_visitor_minor: number | null
  }[]
}

interface EventsBody {
  window_ms: number
  totals: { buyers: number; visitors: number }
  rows: {
    event_name: string
    buyers: number
    events: number
    buyer_rate: number | null
    non_buyer_visitors: number
    non_buyer_rate: number | null
  }[]
}

beforeEach(() => {
  membershipRole.value = 'owner'
  world.visitorsFail = false
  world.calls = []
})

describe('revenue by source (gap 3)', () => {
  it('groups by the first-touch referrer by default, with visitors and rates', async () => {
    const res = await get(sitePath('attribution'), session)
    expect(res.status).toBe(200)
    const body = (await res.json()) as AttributionBody
    expect(body.touch).toBe('first')
    expect(body.dimension).toBe('referrer_domain')
    expect(body.currency).toBe('EUR')
    expect(body.visitors_available).toBe(true)
    expect(body.meta.revenue.connection_status).toBe('not_connected')
    expect(body.rows).toEqual([
      {
        value: null,
        revenue_minor: 1000,
        orders: 2,
        unconverted_orders: 0,
        buyers: 0,
        visitors: null,
        conversion_rate: null,
        revenue_per_visitor_minor: null,
      },
      {
        value: 'google.com',
        revenue_minor: 3500,
        orders: 3,
        unconverted_orders: 0,
        buyers: 2,
        visitors: 40,
        conversion_rate: 0.05,
        revenue_per_visitor_minor: 87.5,
      },
      {
        // A value with no session entry in the range: zero visitors, and the
        // rates are null rather than infinite.
        value: '',
        revenue_minor: 0,
        orders: 1,
        unconverted_orders: 1,
        buyers: 1,
        visitors: 0,
        conversion_rate: null,
        revenue_per_visitor_minor: null,
      },
    ])
    expect(operations()).toContain('analytics.revenue_attribution_first_referrer_domain')
    const visitors = world.calls.find(
      (call) => call.operation === 'analytics.revenue_attribution_visitors_referrer_domain',
    )
    // Bound to the rows shown, the unattributed one left out.
    expect(visitors?.params['values']).toEqual(['google.com', ''])
  })

  it('picks the operation from touch and dimension, and passes the limit', async () => {
    const res = await get(
      sitePath('attribution', `${RANGE}&touch=last&dimension=entry_page&limit=7`),
      session,
    )
    expect(res.status).toBe(200)
    const call = world.calls.find(
      (c) => c.operation === 'analytics.revenue_attribution_last_entry_page',
    )
    expect(call?.params['limit']).toBe(7)
    expect(operations()).toContain('analytics.revenue_attribution_visitors_entry_page')
  })

  it('leaves visitors out above 92 days, as null, without asking for them', async () => {
    const res = await get(sitePath('attribution', LONG_RANGE), session)
    expect(res.status).toBe(200)
    const body = (await res.json()) as AttributionBody
    expect(body.visitors_available).toBe(false)
    for (const row of body.rows) {
      expect(row.visitors).toBeNull()
      expect(row.conversion_rate).toBeNull()
      expect(row.revenue_per_visitor_minor).toBeNull()
    }
    expect(operations().some((op) => op.includes('_visitors_'))).toBe(false)
  })

  it('keeps the revenue answer when the visitors read fails, and says partial', async () => {
    world.visitorsFail = true
    const res = await get(sitePath('attribution'), session)
    expect(res.status).toBe(200)
    const body = (await res.json()) as AttributionBody
    expect(body.visitors_available).toBe(false)
    expect(body.meta.partial).toBe(true)
    expect(body.rows[1]?.revenue_minor).toBe(3500)
  })

  it('snaps an unaligned range outward to quarter hours', async () => {
    const res = await get(
      sitePath(
        'attribution',
        'from=2026-07-16T00:07:00.000Z&to=2026-07-23T10:01:00.000Z&timezone=UTC',
      ),
      session,
    )
    expect(res.status).toBe(200)
    const call = world.calls.find((c) => c.operation.startsWith('analytics.revenue_attribution_'))
    expect(call?.params['from']).toBe('2026-07-16T00:00:00.000Z')
    expect(call?.params['to']).toBe('2026-07-23T10:15:00.000Z')
  })

  it('refuses an unknown touch, dimension or limit by name', async () => {
    for (const [query, path] of [
      ['touch=middle', 'touch'],
      ['dimension=country', 'dimension'],
      ['limit=0', 'limit'],
      ['limit=501', 'limit'],
    ] as const) {
      const res = await get(sitePath('attribution', `${RANGE}&${query}`), session)
      expect(res.status, query).toBe(400)
      const body = (await res.json()) as {
        error: { code: string; details: { issues: { path: string }[] } }
      }
      expect(body.error.code).toBe('VALIDATION_FAILED')
      expect(body.error.details.issues[0]?.path).toBe(path)
    }
  })
})

describe('events before purchase (gap 4)', () => {
  it('returns per-event buyer and non-buyer counts with their rates', async () => {
    const res = await get(sitePath('events-before-purchase'), session)
    expect(res.status).toBe(200)
    const body = (await res.json()) as EventsBody
    expect(body.window_ms).toBe(7 * 86_400_000)
    expect(body.totals).toEqual({ buyers: 4, visitors: 54 })
    expect(body.rows[0]).toEqual({
      event_name: 'paywall_viewed',
      event_type: 'custom',
      buyers: 2,
      events: 3,
      buyer_rate: 0.5,
      non_buyer_visitors: 5,
      non_buyer_rate: 0.1,
    })
    const call = world.calls.find((c) => c.operation === 'analytics.revenue_events_before_purchase')
    expect(call?.params['window_ms']).toBe(7 * 86_400_000)
    expect(call?.params['limit']).toBe(50)
  })

  it('passes window_ms and limit through, and refuses them out of bounds', async () => {
    const ok = await get(
      sitePath('events-before-purchase', `${RANGE}&window_ms=3600000&limit=5`),
      session,
    )
    expect(ok.status).toBe(200)
    const call = world.calls.find((c) => c.operation === 'analytics.revenue_events_before_purchase')
    expect(call?.params['window_ms']).toBe(3_600_000)
    expect(call?.params['limit']).toBe(5)

    for (const query of ['window_ms=59999', 'window_ms=2592000001', 'limit=201', 'window_ms=abc']) {
      const res = await get(sitePath('events-before-purchase', `${RANGE}&${query}`), session)
      expect(res.status, query).toBe(400)
      expect((await errorOf(res)).code, query).toBe('VALIDATION_FAILED')
    }
  })

  it('refuses more than 92 days by name, before the gateway is asked', async () => {
    const res = await get(sitePath('events-before-purchase', LONG_RANGE), session)
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe('RANGE_TOO_LARGE')
    expect(operations().some((op) => op.startsWith('analytics.revenue_'))).toBe(false)
  })
})

describe('owner-only, on both surfaces', () => {
  for (const name of ['attribution', 'events-before-purchase']) {
    for (const role of ['admin', 'viewer'] as const) {
      it(`refuses a ${role} on the session route for ${name}`, async () => {
        membershipRole.value = role
        const res = await get(sitePath(name), session)
        expect(res.status).toBe(403)
        expect((await errorOf(res)).code).toBe('FORBIDDEN')
      })

      it(`refuses a ${role} on /v1/read for ${name}`, async () => {
        membershipRole.value = role
        const res = await get(readPath(name), tokenRead)
        expect(res.status).toBe(403)
        expect((await errorOf(res)).message).toBe('Revenue is available to a site owner only')
      })
    }

    it(`answers /v1/read/revenue/${name} as the session route does`, async () => {
      const viaSite = await get(sitePath(name), session)
      const viaRead = await get(readPath(name), sessionRead)
      const viaToken = await get(readPath(name), tokenRead)
      expect(viaSite.status).toBe(200)
      expect(viaRead.status).toBe(200)
      expect(viaToken.status).toBe(200)
      const site = await viaSite.text()
      expect(await viaRead.text()).toBe(site)
      expect(await viaToken.text()).toBe(site)
    })
  }
})

describe('the MCP tools are the read routes', () => {
  async function mcp(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await buildApp().fetch(
      new Request('http://api.test/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${OAUTH_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
      }),
    )
    expect(res.status).toBe(200)
    return ((await res.json()) as { result: Record<string, unknown> }).result
  }

  it('lists both tools', async () => {
    const result = await mcp({ method: 'tools/list' })
    const names = (result['tools'] as { name: string }[]).map((tool) => tool.name)
    expect(names).toContain('revenue_by_source')
    expect(names).toContain('events_before_purchase')
  })

  it('serves revenue_by_source through /v1/read/revenue/attribution', async () => {
    const result = await mcp({
      method: 'tools/call',
      params: {
        name: 'revenue_by_source',
        arguments: {
          site_id: SITE,
          from: '2026-07-16T00:00:00.000Z',
          to: '2026-07-23T00:00:00.000Z',
          touch: 'last',
          dimension: 'utm_campaign',
        },
      },
    })
    expect(result['isError']).toBe(false)
    expect(operations()).toContain('analytics.revenue_attribution_last_utm_campaign')
  })

  it('serves events_before_purchase through its read route', async () => {
    const result = await mcp({
      method: 'tools/call',
      params: {
        name: 'events_before_purchase',
        arguments: {
          site_id: SITE,
          from: '2026-07-16T00:00:00.000Z',
          to: '2026-07-23T00:00:00.000Z',
          window_ms: '86400000',
        },
      },
    })
    expect(result['isError']).toBe(false)
    const text = (result['content'] as { text: string }[])[0]?.text ?? ''
    expect(text).toContain('"event_name":"paywall_viewed"')
    const call = world.calls.find((c) => c.operation === 'analytics.revenue_events_before_purchase')
    expect(call?.params['window_ms']).toBe(86_400_000)
  })

  it('hands both tools to the assistant (Perier fork decision)', () => {
    const names = ASSISTANT_TOOLS.map((tool) => tool.name)
    expect(names).toContain('revenue_by_source')
    expect(names).toContain('events_before_purchase')
  })
})
