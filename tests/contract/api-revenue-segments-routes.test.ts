import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { AnalyticsGateway } from '../../apps/api/src/gateway-client.ts'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Revenue by segment (referrer × country × device), through the real app and
 * its middleware.
 *
 * - **Owner-only on both surfaces**, like every revenue read: an admin and a
 *   viewer are refused on `/v1/sites/{id}/revenue/segments` and on
 *   `/v1/read/revenue/segments`.
 * - **Smoothed and ranked by the api**: the site rates come from the totals
 *   read, the segments read is ranked against them, and the response carries
 *   raw and smoothed figures with a confidence band.
 * - **Insufficient data** under 10 attributed buyers: no segments read is
 *   sent, and the counts still come back.
 * - **92 days at most**, refused by name before the gateway is asked.
 * - **The MCP tool is the read route**, and the assistant gets it.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const USER = 'ff33a1c0-1111-4222-8333-999900001111'
const COOKIE = 'oa_session=live-session-value'
const OAUTH_TOKEN = 'AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD'
const RANGE = 'from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC'
/** 93 days: one over the cap. */
const LONG_RANGE = 'from=2026-04-21T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC'

const membershipRole = { value: 'owner' as 'owner' | 'admin' | 'viewer' }
const world = {
  totals: {} as Record<string, string>,
  calls: [] as { operation: string; params: Record<string, unknown> }[],
}

const TOTALS = {
  visitors: '2000',
  buyers: '40',
  orders: '44',
  revenue_minor: '100000',
  unconverted_orders: '1',
  // Left out of the buyers: three whose last visit was before the range, one
  // whose last-touch session is retracted or missing.
  buyers_last_visit_before_range: '3',
  buyers_last_visit_missing: '1',
  // Eight segments, six under the threshold: the two rows below are the rest.
  segments: '8',
  hidden_segments: '6',
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

/** In the gateway's order; the api ranks them itself. */
const SEGMENT_ROWS = [
  {
    source: 'google.com',
    country: 'DE',
    device: 'desktop',
    visitors: '1200',
    buyers: '30',
    orders: '33',
    revenue_minor: '90000',
    unconverted_orders: '1',
  },
  {
    source: '',
    country: 'US',
    device: 'mobile',
    visitors: '40',
    buyers: '2',
    orders: '2',
    revenue_minor: '20000',
    unconverted_orders: '0',
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
      } else if (operation === 'analytics.revenue_segment_totals') {
        rows = [world.totals]
      } else if (operation === 'analytics.revenue_segments') {
        rows = SEGMENT_ROWS
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

const sitePath = (query = RANGE) => `/v1/sites/${SITE}/revenue/segments?${query}`
const readPath = (query = RANGE) => `/v1/read/revenue/segments?${query}`

const operations = () => world.calls.map((call) => call.operation)
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error

interface SegmentsBody {
  meta: { truncated: boolean; revenue: { connection_status: string } }
  status: string
  currency: string
  site: Record<string, number | null>
  segments: Record<string, unknown>[]
  hidden_segments: number
  thresholds: { min_buyers: number; min_segment_visitors: number }
  prior: { k: number }
}

beforeEach(() => {
  membershipRole.value = 'owner'
  world.totals = { ...TOTALS }
  world.calls = []
})

describe('revenue by segment', () => {
  it('ranks the segments by smoothed value per visitor, raw and smoothed side by side', async () => {
    const res = await get(sitePath(), session)
    expect(res.status).toBe(200)
    const body = (await res.json()) as SegmentsBody
    expect(body.status).toBe('ok')
    expect(body.currency).toBe('EUR')
    expect(body.meta.revenue.connection_status).toBe('not_connected')
    expect(body.prior).toEqual({ k: 200 })
    expect(body.thresholds).toEqual({ min_buyers: 10, min_segment_visitors: 20 })
    expect(body.hidden_segments).toBe(6)
    expect(body.site).toEqual({
      visitors: 2000,
      buyers: 40,
      orders: 44,
      revenue_minor: 100000,
      unconverted_orders: 1,
      buyers_last_visit_before_range: 3,
      buyers_last_visit_missing: 1,
      conversion_rate: 0.02,
      value_per_visitor_minor: 50,
    })
    // Direct/US/mobile earns 500 per visitor raw over 40 visitors, smoothed to
    // (20,000 + 200 × 50) / 240 = 125; Google/DE/desktop earns 75 raw over
    // 1,200, smoothed to 100,000 / 1,400 ≈ 71.4. The small segment still
    // leads, but by far less than its raw figure claims.
    expect(body.segments).toEqual([
      {
        source: '',
        country: 'US',
        device: 'mobile',
        visitors: 40,
        buyers: 2,
        orders: 2,
        revenue_minor: 20000,
        unconverted_orders: 0,
        conversion_rate: 0.05,
        smoothed_conversion_rate: 6 / 240,
        average_order_value_minor: 10000,
        value_per_visitor_minor: 500,
        smoothed_value_per_visitor_minor: 125,
        confidence: 'low',
      },
      {
        source: 'google.com',
        country: 'DE',
        device: 'desktop',
        visitors: 1200,
        buyers: 30,
        orders: 33,
        revenue_minor: 90000,
        unconverted_orders: 1,
        conversion_rate: 0.025,
        smoothed_conversion_rate: 34 / 1400,
        average_order_value_minor: 90000 / 33,
        value_per_visitor_minor: 75,
        smoothed_value_per_visitor_minor: 100000 / 1400,
        confidence: 'high',
      },
    ])
    const call = world.calls.find((c) => c.operation === 'analytics.revenue_segments')
    // Ranked against the site's value per visitor, before the limit.
    expect(call?.params['prior_value_minor']).toBe(50)
    expect(call?.params['limit']).toBe(100)
    expect(body.meta.truncated).toBe(false)
  })

  it('says insufficient_data under 10 attributed buyers, with the counts, and reads no segments', async () => {
    world.totals = { ...TOTALS, buyers: '9' }
    const res = await get(sitePath(), session)
    expect(res.status).toBe(200)
    const body = (await res.json()) as SegmentsBody
    expect(body.status).toBe('insufficient_data')
    expect(body.segments).toEqual([])
    expect(body.site['buyers']).toBe(9)
    expect(body.site['visitors']).toBe(2000)
    expect(body.site['buyers_last_visit_before_range']).toBe(3)
    expect(operations()).not.toContain('analytics.revenue_segments')
  })

  it('passes the limit, and marks a cut list truncated', async () => {
    const res = await get(sitePath(`${RANGE}&limit=1`), session)
    expect(res.status).toBe(200)
    const body = (await res.json()) as SegmentsBody
    const call = world.calls.find((c) => c.operation === 'analytics.revenue_segments')
    expect(call?.params['limit']).toBe(1)
    // 8 segments, 6 hidden: 2 shown, and the limit kept the first.
    expect(body.segments.map((row) => row['source'])).toEqual([''])
    expect(body.meta.truncated).toBe(true)

    for (const query of ['limit=0', 'limit=501', 'limit=abc']) {
      const refused = await get(sitePath(`${RANGE}&${query}`), session)
      expect(refused.status, query).toBe(400)
      expect((await errorOf(refused)).code, query).toBe('VALIDATION_FAILED')
    }
  })

  it('withholds the smallest shown segment beside a lone hidden one', async () => {
    // Three segments, one under the threshold: Direct/US/mobile (40 visitors)
    // is the smallest shown and goes with it, so the site totals minus the
    // shown rows are never one segment's own counts.
    world.totals = { ...TOTALS, segments: '3', hidden_segments: '1' }
    const res = await get(sitePath(), session)
    expect(res.status).toBe(200)
    const body = (await res.json()) as SegmentsBody
    expect(body.segments.map((row) => row['source'])).toEqual(['google.com'])
    expect(body.hidden_segments).toBe(2)
    expect(body.meta.truncated).toBe(false)
  })

  it('snaps an unaligned range outward to quarter hours', async () => {
    const res = await get(
      sitePath('from=2026-07-16T00:07:00.000Z&to=2026-07-23T10:01:00.000Z&timezone=UTC'),
      session,
    )
    expect(res.status).toBe(200)
    const call = world.calls.find((c) => c.operation === 'analytics.revenue_segment_totals')
    expect(call?.params['from']).toBe('2026-07-16T00:00:00.000Z')
    expect(call?.params['to']).toBe('2026-07-23T10:15:00.000Z')
  })

  it('refuses more than 92 days by name, before the gateway is asked', async () => {
    const res = await get(sitePath(LONG_RANGE), session)
    expect(res.status).toBe(400)
    expect((await errorOf(res)).code).toBe('RANGE_TOO_LARGE')
    expect(operations().some((op) => op.startsWith('analytics.revenue_'))).toBe(false)
  })
})

describe('owner-only, on both surfaces', () => {
  for (const role of ['admin', 'viewer'] as const) {
    it(`refuses a ${role} on the session route`, async () => {
      membershipRole.value = role
      const res = await get(sitePath(), session)
      expect(res.status).toBe(403)
      expect((await errorOf(res)).code).toBe('FORBIDDEN')
      expect(operations().some((op) => op.startsWith('analytics.revenue_'))).toBe(false)
    })

    it(`refuses a ${role} on /v1/read`, async () => {
      membershipRole.value = role
      const res = await get(readPath(), tokenRead)
      expect(res.status).toBe(403)
      expect((await errorOf(res)).message).toBe('Revenue is available to a site owner only')
    })
  }

  it('answers /v1/read/revenue/segments as the session route does', async () => {
    const viaSite = await get(sitePath(), session)
    const viaRead = await get(readPath(), sessionRead)
    const viaToken = await get(readPath(), tokenRead)
    expect(viaSite.status).toBe(200)
    expect(viaRead.status).toBe(200)
    expect(viaToken.status).toBe(200)
    const site = await viaSite.text()
    expect(await viaRead.text()).toBe(site)
    expect(await viaToken.text()).toBe(site)
  })
})

describe('the MCP tool is the read route', () => {
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

  it('lists revenue_segments', async () => {
    const result = await mcp({ method: 'tools/list' })
    const names = (result['tools'] as { name: string }[]).map((tool) => tool.name)
    expect(names).toContain('revenue_segments')
  })

  it('serves revenue_segments through /v1/read/revenue/segments', async () => {
    const result = await mcp({
      method: 'tools/call',
      params: {
        name: 'revenue_segments',
        arguments: {
          site_id: SITE,
          from: '2026-07-16T00:00:00.000Z',
          to: '2026-07-23T00:00:00.000Z',
          limit: '5',
        },
      },
    })
    expect(result['isError']).toBe(false)
    const text = (result['content'] as { text: string }[])[0]?.text ?? ''
    expect(text).toContain('"smoothed_value_per_visitor_minor":125')
    const call = world.calls.find((c) => c.operation === 'analytics.revenue_segments')
    expect(call?.params['limit']).toBe(5)
  })

  it('refuses a non-owner through the tool too', async () => {
    membershipRole.value = 'admin'
    const result = await mcp({
      method: 'tools/call',
      params: {
        name: 'revenue_segments',
        arguments: {
          site_id: SITE,
          from: '2026-07-16T00:00:00.000Z',
          to: '2026-07-23T00:00:00.000Z',
        },
      },
    })
    expect(result['isError']).toBe(true)
  })

  it('hands the tool to the assistant: segment aggregates, no person in them', () => {
    expect(ASSISTANT_TOOLS.map((tool) => tool.name)).toContain('revenue_segments')
  })
})
