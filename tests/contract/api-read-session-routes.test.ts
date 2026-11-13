import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { AnalyticsGateway } from '../../apps/api/src/gateway-client.ts'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The third arm of `ReadPrincipal` — the session (ADR-0046 D4).
 *
 * The claim this file holds is D4's, and it is a claim about *sameness*: a
 * browser with a session cookie reaching `/v1/read` gets exactly what that user
 * could already read, through the same middleware, under the same gates, with
 * one more prefix on the same budget. So most of these tests are comparisons
 * between the session arm and the OAuth arm rather than assertions about the
 * session arm alone — a second read path would pass the second kind and fail the
 * first.
 *
 * The one asymmetry is deliberate and is the security condition of D4: **a
 * present-but-invalid `Authorization` header never falls back to the cookie.**
 * Falling back would mean a withdrawn token silently keeps working in a browser
 * that also has a session.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const OTHER_SITE = '8b7c6d55-1111-4222-8333-444455556666'
const OAUTH_TOKEN = 'AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD'
/** The same person, through a client whose grant never mentioned revenue. */
const OAUTH_TOKEN_NO_REVENUE = 'EEEEEEEEFFFFFFFFGGGGGGGGHHHHHHHH'
const COOKIE = 'oa_session=live-session-value'
const USER = 'ff33a1c0-1111-4222-8333-999900001111'
const RANGE = 'from=2026-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC'
/** Wider than the ceiling `buildApp` wires, so the gate has something to refuse. */
const WIDE_RANGE = 'from=2020-07-16T00:00:00.000Z&to=2026-07-23T00:00:00.000Z&timezone=UTC'

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
const sitesForUser = {
  value: [] as { siteId: string; slug: string; name: string; status: string; role: string }[],
}
const spentMs = { value: 0 }
const charges: string[] = []
/**
 * The caller's role on `SITE`, moved per test.
 *
 * It is one holder for both arms deliberately: after ADR-0049 the session and
 * the token reach the revenue capability by the same path, so a viewer must be
 * refused identically whichever credential they present.
 */
const membershipRole = { value: 'owner' as 'owner' | 'admin' | 'viewer' }

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    resolveReadApiKey: async () => null,
    resolveOAuthAccessToken: async (_db: unknown, token: string) => {
      if (token === OAUTH_TOKEN) {
        return { id: 'grant-1', userId: USER, scopes: 'site:read analytics:read revenue:read' }
      }
      if (token === OAUTH_TOKEN_NO_REVENUE) {
        return { id: 'grant-2', userId: USER, scopes: 'site:read analytics:read' }
      }
      return null
    },
    // Live membership, per request, exactly as both other arms read it. The
    // session arm must not get a cheaper answer to "may this person read this
    // site" than the token arm does.
    getMembership: async (_db: unknown, input: { siteId: string; userId: string }) =>
      input.siteId === SITE && input.userId === USER
        ? { role: membershipRole.value, isBillingOwner: true }
        : null,
    getSiteBasics: async () => siteBasics.value,
    getFinalizerState: async () => null,
    getLiveTrackingToken: async () => null,
    listSitesForUser: async () => sitesForUser.value,
    // Revenue's connection row: absent, so `meta.revenue.connection_status` is
    // `not_connected` — the state that makes a zero interpretable, and the one
    // ADR-0049 D4 tells the model to read.
    readRevenueCredential: async () => null,
    getRevenueAttributionState: async () => null,
    readCostSpent: async () => spentMs.value,
    chargeReadCost: async (_db: unknown, input: { credentialKey: string }) => {
      charges.push(input.credentialKey)
    },
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')
const { AnalyticsService } = await import('../../apps/api/src/analytics/service.ts')

/**
 * A session resolver that answers from the request's own headers, the way
 * `sessionAuth` does — so "the cookie is the credential" is exercised rather
 * than assumed. A request with no cookie gets no session, which is what makes
 * the 401 cases mean anything.
 */
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

function buildApp(options: { maxRangeDays?: number; dailyBudgetMs?: number } = {}) {
  const gateway: AnalyticsGateway = {
    query: <TRow = Record<string, unknown>>(operation: string) => {
      let rows: Record<string, unknown>[]
      if (operation === 'analytics.freshness') {
        rows = [{ watermark: '2026-07-23 14:35:00.000', buckets: '5' }]
      } else if (operation.startsWith('analytics.revenue_summary')) {
        rows = [REVENUE_ROW]
      } else if (operation.startsWith('analytics.revenue_timeseries')) {
        rows = [{ bucket: '2026-07-20 10:00:00', ...REVENUE_ROW }]
      } else if (operation === 'analytics.revenue_unconverted') {
        rows = []
      } else {
        rows = [{ events: '10', pageviews: '8', visitors: '4', billable_events: '9' }]
      }
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
    // A frozen clock, so two reads of the same window are byte-identical: the
    // freshness block carries `as_of`, which is `now()`.
    analytics: new AnalyticsService(gateway, {
      now: () => new Date('2026-07-23T15:00:00.000Z'),
    }),
    readKey: {
      rateLimiter: { check: () => ({ allowed: true, retryAfterSeconds: 0 }) },
      cost: {
        maxRangeDays: options.maxRangeDays ?? 400,
        dailyBudgetMs: options.dailyBudgetMs ?? 600_000,
      },
    },
  })
}

/** One revenue rollup row, in the shape `mapRevenueTotals` reads. */
const REVENUE_ROW = {
  charge_gross_minor: '120000',
  refund_minor: '20000',
  dispute_withdrawn_minor: '5000',
  dispute_reinstated_minor: '0',
  fee_minor: '4000',
  net_minor: '91000',
  charge_count: '12',
  refund_count: '2',
  dispute_count: '1',
  unconverted_count: '0',
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

const asSession = (siteId?: string): Record<string, string> => ({
  cookie: COOKIE,
  ...(siteId === undefined ? {} : { 'x-oa-site': siteId }),
})

const asToken = (siteId?: string): Record<string, string> => ({
  authorization: `Bearer ${OAUTH_TOKEN}`,
  ...(siteId === undefined ? {} : { 'x-oa-site': siteId }),
})

async function get(
  app: ReturnType<typeof buildApp>,
  path: string,
  headers: Record<string, string>,
): Promise<Response> {
  return app.fetch(new Request(`http://api.test${path}`, { headers }))
}

beforeEach(() => {
  siteBasics.value = activeSite()
  sitesForUser.value = [
    { siteId: SITE, slug: 's', name: 'S', status: 'active', role: 'owner' },
    { siteId: OTHER_SITE, slug: 'o', name: 'O', status: 'deleting', role: 'viewer' },
  ]
  spentMs.value = 0
  charges.length = 0
  membershipRole.value = 'owner'
})

describe('the session is a read credential (ADR-0046 D4)', () => {
  it('answers a session read byte for byte as it answers the OAuth arm', async () => {
    const app = buildApp()
    const viaSession = await get(app, `/v1/read/analytics/overview?${RANGE}`, asSession(SITE))
    const viaToken = await get(app, `/v1/read/analytics/overview?${RANGE}`, asToken(SITE))

    expect(viaSession.status).toBe(200)
    expect(viaToken.status).toBe(200)
    // The whole of D4's "it grants nothing new; it removes a reason the surface
    // refused". A second read path would produce a shape that merely resembles
    // this one.
    expect(await viaSession.text()).toBe(await viaToken.text())
  })

  it('never falls back to a live cookie when an Authorization header is present', async () => {
    // D4's exact condition. A revoked token plus a live session in the same
    // browser must stay a refusal, or a withdrawn credential silently keeps
    // working for anybody who is also signed in.
    const app = buildApp()
    const res = await get(app, `/v1/read/analytics/overview?${RANGE}`, {
      ...asSession(SITE),
      authorization: 'Bearer REVOKEDREVOKEDREVOKEDREVOKED',
    })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED')
  })

  it('still refuses a caller with neither credential', async () => {
    const app = buildApp()
    const res = await get(app, `/v1/read/analytics/overview?${RANGE}`, { 'x-oa-site': SITE })
    expect(res.status).toBe(401)
  })

  it('charges the cost ledger under user:{id} — one row per read', async () => {
    // The structural proof D4 names: the session arm draws on the same
    // `read_cost_ledger` as the other two, under a third prefix, once.
    const app = buildApp()
    expect((await get(app, `/v1/read/analytics/overview?${RANGE}`, asSession(SITE))).status).toBe(
      200,
    )
    expect(charges).toEqual([`user:${USER}`])
  })

  it('gives a site the session user is not a member of the not-found answer', async () => {
    const app = buildApp()
    const res = await get(app, `/v1/read/analytics/overview?${RANGE}`, asSession(OTHER_SITE))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SITE_NOT_FOUND')
    // Nothing was charged: the refusal happens before the cost gate.
    expect(charges).toEqual([])
  })

  it('applies the declared-range ceiling to the session arm', async () => {
    const app = buildApp({ maxRangeDays: 31 })
    const res = await get(app, `/v1/read/analytics/overview?${WIDE_RANGE}`, asSession(SITE))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('RANGE_TOO_LARGE')
  })

  it('applies the cost budget to the session arm, with a Retry-After', async () => {
    spentMs.value = 900_000
    const app = buildApp({ dailyBudgetMs: 600_000 })
    const res = await get(app, `/v1/read/analytics/overview?${RANGE}`, asSession(SITE))
    expect(res.status).toBe(429)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED')
    expect(res.headers.get('Retry-After')).not.toBeNull()
  })

  it('lists the session user’s live memberships at /v1/read/sites', async () => {
    // What makes `list_sites` work for the assistant, and what makes "the model
    // chooses the site" possible without the client naming one.
    const app = buildApp()
    const res = await get(app, '/v1/read/sites', { cookie: COOKIE })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { site_id: string; role: string | null }[] }
    // A `deleting` site is filtered out on this arm exactly as it is on the
    // token arm — one route, one answer.
    expect(body.items).toEqual([
      { site_id: SITE, slug: 's', name: 'S', status: 'active', role: 'owner' },
    ])
  })

  it('requires the site selector, naming it, exactly as the token arm does', async () => {
    const app = buildApp()
    const res = await get(app, '/v1/read/site', { cookie: COOKIE })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.message).toContain('X-OA-Site')
  })
})

/**
 * Revenue aggregates on the session arm (ADR-0049).
 *
 * The claim under test is a *ceiling and floor* claim, and it takes both halves
 * to state it: the session's scope list now permits the question (D3), and the
 * owner-only capability is what answers it (D2). Moving one without the other
 * would either refuse an owner or serve a viewer, and only one of those failures
 * is loud.
 */
describe('the session may read revenue aggregates (ADR-0049 D2, D3)', () => {
  const revenue = (path: string, headers: Record<string, string>) =>
    get(buildApp(), `/v1/read/revenue/${path}?${RANGE}`, headers)

  const failure = async (res: Response): Promise<{ code: string; message: string }> =>
    ((await res.json()) as { error: { code: string; message: string } }).error

  it('answers an owner session byte for byte as it answers the OAuth arm', async () => {
    const app = buildApp()
    const viaSession = await get(app, `/v1/read/revenue/summary?${RANGE}`, asSession(SITE))
    const viaToken = await get(app, `/v1/read/revenue/summary?${RANGE}`, asToken(SITE))

    expect(viaSession.status).toBe(200)
    expect(viaToken.status).toBe(200)
    expect(await viaSession.text()).toBe(await viaToken.text())
  })

  it('carries the totals in minor units and the connection status a zero needs', async () => {
    const res = await revenue('summary', asSession(SITE))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      meta: { revenue: { connection_status: string } }
      totals: { net_minor: number; currency: string }
    }
    expect(body.totals.net_minor).toBe(91_000)
    expect(body.totals.currency).toBe('USD')
    // What D4 tells the model to read before it reports a number.
    expect(body.meta.revenue.connection_status).toBe('not_connected')
  })

  it('serves the timeseries to an owner session too', async () => {
    const res = await revenue('timeseries', asSession(SITE))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { series: { net_minor: number }[] }
    expect(body.series).toHaveLength(1)
  })

  it('serves the subscription reads to an owner, and refuses them to an admin', async () => {
    for (const path of ['subscriptions/summary', 'subscriptions/timeseries']) {
      membershipRole.value = 'owner'
      const ok = await revenue(path, asToken(SITE))
      expect(ok.status, path).toBe(200)
      membershipRole.value = 'admin'
      const refused = await revenue(path, asSession(SITE))
      expect(refused.status, path).toBe(403)
      expect((await failure(refused)).message).toBe('Revenue is available to a site owner only')
    }
  })

  for (const role of ['admin', 'viewer'] as const) {
    it(`refuses a ${role} session at the capability, not at the scope`, async () => {
      // The distinction is the whole of D3's ceiling/floor argument, and the two
      // refusals are the same status — so the message is what separates them.
      // A scope refusal here would mean the ceiling had done the capability's
      // job, and would go on doing it wrongly the day the ceiling moved again.
      membershipRole.value = role
      const res = await revenue('summary', asSession(SITE))
      expect(res.status).toBe(403)
      const error = await failure(res)
      expect(error.code).toBe('FORBIDDEN')
      expect(error.message).toBe('Revenue is available to a site owner only')
      expect(error.message).not.toContain('scope')
    })

    it(`refuses a ${role} OAuth token the same way, from the same check`, async () => {
      membershipRole.value = role
      const res = await revenue('summary', asToken(SITE))
      expect(res.status).toBe(403)
      expect((await failure(res)).message).toBe('Revenue is available to a site owner only')
    })
  }

  it('refuses a credential without the scope with the scope’s own message', async () => {
    const res = await revenue('summary', {
      authorization: `Bearer ${OAUTH_TOKEN_NO_REVENUE}`,
      'x-oa-site': SITE,
    })
    expect(res.status).toBe(403)
    expect((await failure(res)).message).toContain('revenue:read scope')
  })

  it('leaves the per-customer rows off the surface — 404, not 403', async () => {
    // ADR-0043 D15's other half is untouched by ADR-0049, and the answer proves
    // it is untouched *structurally*: a 403 would mean the route exists and this
    // caller may not have it. There is no route.
    const app = buildApp()
    for (const path of [
      '/v1/read/revenue/transactions',
      '/v1/read/revenue/transactions/ch_1/journey',
    ]) {
      const res = await get(app, `${path}?${RANGE}`, asSession(SITE))
      expect(res.status, path).toBe(404)
      expect((await failure(res)).code, path).toBe('NOT_FOUND')
    }
  })
})

/**
 * The same two rows, reached the way an MCP host reaches them (ADR-0049 D2).
 *
 * One table, two consumers: the tools are visible to a host, and the route is
 * what refuses. A token that lacks `revenue:read` gets a `403` **as tool
 * content** rather than as a transport error, because the model has to read it.
 */
describe('revenue tools are the read route, for MCP too (ADR-0049 D2)', () => {
  const call = async (token: string, name: string): Promise<Record<string, unknown>> => {
    const res = await buildApp().fetch(
      new Request('http://api.test/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name,
            arguments: {
              site_id: SITE,
              from: '2026-07-16T00:00:00.000Z',
              to: '2026-07-23T00:00:00.000Z',
            },
          },
        }),
      }),
    )
    expect(res.status).toBe(200)
    return ((await res.json()) as { result: Record<string, unknown> }).result
  }

  it('lists the two revenue tools', async () => {
    const res = await buildApp().fetch(
      new Request('http://api.test/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${OAUTH_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )
    const tools = (
      (await res.json()) as { result: { tools: { name: string }[] } }
    ).result.tools.map((tool) => tool.name)
    expect(tools).toContain('revenue_summary')
    expect(tools).toContain('revenue_timeseries')
    // Realtime is still not a tool: it mints a credential rather than reading.
    expect(tools.some((name) => name.includes('realtime'))).toBe(false)
    // And the per-customer reads never became rows.
    expect(tools.some((name) => name.includes('transaction'))).toBe(false)
    expect(tools.some((name) => name.includes('journey'))).toBe(false)
  })

  it('serves an owner token’s revenue_summary through the route', async () => {
    const result = await call(OAUTH_TOKEN, 'revenue_summary')
    expect(result['isError']).toBe(false)
    const text = (result['content'] as { text: string }[])[0]?.text ?? ''
    expect(text).toContain('"net_minor":91000')
  })

  it('delivers a missing scope as tool content the model must read', async () => {
    const result = await call(OAUTH_TOKEN_NO_REVENUE, 'revenue_summary')
    expect(result['isError']).toBe(true)
    const text = (result['content'] as { text: string }[])[0]?.text ?? ''
    expect(text).toContain('FORBIDDEN')
    expect(text).toContain('revenue:read')
  })

  it('delivers a non-owner’s capability refusal as tool content too', async () => {
    membershipRole.value = 'viewer'
    const result = await call(OAUTH_TOKEN, 'revenue_summary')
    expect(result['isError']).toBe(true)
    const text = (result['content'] as { text: string }[])[0]?.text ?? ''
    expect(text).toContain('site owner only')
  })
})
