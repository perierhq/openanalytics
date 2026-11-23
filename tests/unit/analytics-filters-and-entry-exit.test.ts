import { ApiError } from '@openanalytics/contracts'
import { FILTER_DIMENSIONS, normalizeFilters, parseAnalyticsFilters } from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'
import { AnalyticsService } from '../../apps/api/src/analytics/service.ts'
import { MCP_TOOLS } from '../../apps/api/src/http/mcp.ts'
import type { AnalyticsGateway, GatewayResult } from '../../apps/api/src/gateway-client.ts'

/**
 * The filter grammar and the pages report's session columns (ADR-0075).
 *
 * Three properties are pinned here that nothing else can prove, because each is
 * about a *routing* decision rather than about a number:
 *
 * - **An unfiltered read still costs what it cost.** D-F4 is a promise about
 *   money, and the only way to keep a promise about money is to assert which
 *   operation ran.
 * - **A filtered read is refused, not hung.** D-F5: an unknown dimension is
 *   named, a too-long range is named, and neither becomes a timeout.
 * - **An absent measurement is `null` and a measured absence is `0`.** The pages
 *   decoration reads a bounded window, so "this path was not in it" and "no
 *   session began here" are different answers and must not print the same.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const NOW = new Date('2026-07-23T14:40:00.000Z')
const RANGE = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' }
const FRESH = [{ watermark: '2026-07-23 14:35:00.000', buckets: '42' }]

type Responder = (operation: string, params: Record<string, unknown>) => unknown[]

class FakeGateway implements AnalyticsGateway {
  readonly calls: { operation: string; params: Record<string, unknown> }[] = []
  readonly #responder: Responder
  constructor(responder: Responder) {
    this.#responder = responder
  }
  query<TRow = Record<string, unknown>>(
    operation: string,
    params: Record<string, unknown>,
  ): Promise<GatewayResult<TRow>> {
    this.calls.push({ operation, params })
    const rows = this.#responder(operation, params) as readonly TRow[]
    return Promise.resolve({
      operation,
      rows,
      meta: { row_count: rows.length, truncated: false, elapsed_ms: 1, cached: false },
    })
  }
}

function serviceWith(responder: Responder) {
  const gateway = new FakeGateway(responder)
  return { gateway, service: new AnalyticsService(gateway, { now: () => NOW }) }
}

const base = { siteId: SITE, timezone: 'UTC', limit: 100, ...RANGE }
const US = [{ dimension: 'country' as const, operator: 'eq' as const, values: ['US'] }]

// ---------------------------------------------------------------------------
// The grammar
// ---------------------------------------------------------------------------

describe('the filter grammar (D-F2, D-F5)', () => {
  it('treats an absent parameter as the unfiltered read', () => {
    // Not an error, deliberately: every caller written before filters existed
    // keeps working, and an unfiltered read must stay on the rollups.
    expect(parseAnalyticsFilters(undefined)).toEqual({ ok: true, filters: [] })
    expect(parseAnalyticsFilters('')).toEqual({ ok: true, filters: [] })
  })

  it('refuses an unknown dimension BY NAME and says what it does have', () => {
    const parsed = parseAnalyticsFilters('[{"dimension":"browser","values":["Chrome"]}]')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.dimension).toBe('browser')
    expect(parsed.supported).toContain('country')
    // A silently dropped clause answers a question nobody asked with numbers
    // that look right, which is worse than a refusal a client can render.
    expect(parsed.message).toContain('browser')
  })

  it('refuses an unknown operator and an eq with two values', () => {
    expect(
      parseAnalyticsFilters('[{"dimension":"country","operator":"gt","values":["US"]}]').ok,
    ).toBe(false)
    expect(
      parseAnalyticsFilters('[{"dimension":"country","operator":"eq","values":["US","CA"]}]').ok,
    ).toBe(false)
  })

  it('merges two clauses on one dimension instead of intersecting them to nothing', () => {
    // AND-only across dimensions, OR within one. `country = US AND country = CA`
    // is empty and is never what a chip row meant.
    const parsed = parseAnalyticsFilters(
      '[{"dimension":"country","values":["CA"]},{"dimension":"country","values":["US"]}]',
    )
    expect(parsed).toEqual({
      ok: true,
      filters: [{ dimension: 'country', operator: 'in', values: ['CA', 'US'] }],
    })
  })

  it('normalizes to one form so two chip orders are one cache entry', () => {
    // The gateway keys its cache on the bound parameter map, so a shared
    // filtered link has to reduce to the same bytes however the chips were
    // clicked — otherwise the second reader pays for the first reader's query
    // all over again.
    const a = normalizeFilters([
      { dimension: 'device_type', operator: 'eq', values: ['mobile'] },
      { dimension: 'country', operator: 'in', values: ['US', 'CA', 'US'] },
    ])
    const b = normalizeFilters([
      { dimension: 'country', operator: 'in', values: ['CA', 'US'] },
      { dimension: 'device_type', operator: 'eq', values: ['mobile'] },
    ])
    expect(a).toEqual(b)
    expect(a).toEqual([
      { dimension: 'country', operator: 'in', values: ['CA', 'US'] },
      { dimension: 'device_type', operator: 'eq', values: ['mobile'] },
    ])
  })
})

// ---------------------------------------------------------------------------
// Routing (D-F4)
// ---------------------------------------------------------------------------

describe('what an unfiltered read costs (D-F4)', () => {
  it('routes to the rollup operation and never touches the filtered family', async () => {
    // The promise this test exists to keep: a dashboard with no chips is
    // byte-identical in cost to what it was before ADR-0075. A future edit that
    // sent an unfiltered read down the raw path fails here.
    const { service, gateway } = serviceWith((operation) =>
      operation === 'analytics.freshness' ? FRESH : [],
    )

    await service.sources(base)
    await service.overview({ ...base, compare: false })
    await service.timeseries({ ...base, compare: false })

    const operations = gateway.calls.map((call) => call.operation)
    expect(operations).toContain('analytics.sources_hour')
    expect(operations).toContain('analytics.overview_hour')
    expect(operations.filter((id) => id.startsWith('analytics.filtered_'))).toEqual([])
  })

  it('treats an empty filter list exactly as no filter at all', async () => {
    const { service, gateway } = serviceWith((operation) =>
      operation === 'analytics.freshness' ? FRESH : [],
    )
    await service.geography({ ...base, filters: [] })
    expect(gateway.calls.map((call) => call.operation)).toContain('analytics.geography_hour')
    expect(
      gateway.calls.filter((call) => call.operation.startsWith('analytics.filtered_')),
    ).toEqual([])
  })
})

describe('what a filtered read routes to', () => {
  it('runs the filtered operation and no imported one', async () => {
    // A staged provider day carries no session, so a session-scoped filter has
    // nothing to select in it — there is no imported half to merge.
    const { service, gateway } = serviceWith((operation) =>
      operation === 'analytics.freshness' ? FRESH : [],
    )
    await service.sources({ ...base, filters: US })

    const operations = gateway.calls.map((call) => call.operation)
    expect(operations).toContain('analytics.filtered_sources_hour')
    expect(operations).not.toContain('analytics.sources_hour')
    expect(operations).not.toContain('analytics.imported_sources')
  })

  it('passes the normalized filter set through as a bound parameter', async () => {
    const { service, gateway } = serviceWith((operation) =>
      operation === 'analytics.freshness' ? FRESH : [],
    )
    await service.geography({
      ...base,
      filters: [
        { dimension: 'device_type', operator: 'eq', values: ['mobile'] },
        { dimension: 'country', operator: 'in', values: ['US', 'CA'] },
      ],
    })

    const call = gateway.calls.find((c) => c.operation === 'analytics.filtered_geography_hour')
    expect(call?.params['filters']).toEqual([
      { dimension: 'country', operator: 'in', values: ['CA', 'US'] },
      { dimension: 'device_type', operator: 'eq', values: ['mobile'] },
    ])
  })

  it('reads the filtered entry/exit twin so one row describes one population', async () => {
    // Filtering `views` but not `entrances` would put two numbers in one table
    // that quietly mean different things.
    const { service, gateway } = serviceWith((operation) =>
      operation === 'analytics.freshness' ? FRESH : [],
    )
    await service.pages({ ...base, filters: US, sessionMetrics: true })

    const operations = gateway.calls.map((call) => call.operation)
    expect(operations).toContain('analytics.filtered_pages_hour')
    expect(operations).toContain('analytics.filtered_page_sessions_hour')
    expect(operations).not.toContain('analytics.page_sessions_hour')
  })
})

describe('a filtered read that cannot be served is refused, not hung (D-F5)', () => {
  it('names the report that has no filtered operation', async () => {
    const { service } = serviceWith((operation) =>
      operation === 'analytics.freshness' ? FRESH : [],
    )
    await expect(service.customEvents({ ...base, filters: US })).rejects.toThrow(ApiError)
    await expect(service.customEvents({ ...base, filters: US })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })

  it('names a range wider than the raw path can serve, with the cap in it', async () => {
    // `RANGE_TOO_LARGE` rather than `VALIDATION_FAILED`: the request is
    // well-formed and the recovery is exact — ask for less — which is what that
    // code already means everywhere else in this contract.
    const { service, gateway } = serviceWith((operation) =>
      operation === 'analytics.freshness' ? FRESH : [],
    )
    const wide = {
      ...base,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      filters: US,
    }
    await expect(service.pages(wide)).rejects.toMatchObject({ code: 'RANGE_TOO_LARGE' })
    // And it is refused BEFORE any query is signed — a cap that is discovered by
    // waiting is not a cap.
    expect(gateway.calls.filter((c) => c.operation.startsWith('analytics.filtered_'))).toEqual([])
  })

  it('serves the same wide range happily when it is unfiltered', async () => {
    // The cap belongs to the raw path, not to the report — otherwise ADR-0075
    // would have quietly narrowed a report that has always answered a year.
    const { service } = serviceWith((operation) =>
      operation === 'analytics.freshness' ? FRESH : [],
    )
    await expect(
      service.pages({ ...base, from: '2026-01-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' }),
    ).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Entry, exit and bounce (D-E1, D-E2)
// ---------------------------------------------------------------------------

const PAGE_ROWS = [
  { page_path: '/', views: '100', visitors: '60' },
  { page_path: '/pricing', views: '40', visitors: '30' },
  { page_path: '/docs', views: '10', visitors: '8' },
]

describe('entry, exit and bounce on the pages report (D-E1)', () => {
  it('decorates only when asked, so the public surface still runs one query', async () => {
    const { service, gateway } = serviceWith((operation) =>
      operation === 'analytics.freshness' ? FRESH : PAGE_ROWS,
    )
    const result = await service.publicPages(base)

    expect(gateway.calls.map((call) => call.operation)).not.toContain(
      'analytics.page_sessions_hour',
    )
    // `null` is "not measured on this response", which is a different fact from
    // zero and a client renders it differently.
    expect(result.items[0]).toMatchObject({ entrances: null, bounce_rate: null })
  })

  it('joins the session measures onto the report by path', async () => {
    const { service } = serviceWith((operation) => {
      if (operation === 'analytics.freshness') return FRESH
      if (operation === 'analytics.page_sessions_hour') {
        return [
          { page_path: '/', entrances: '50', exits: '20', bounces: '10', sessions: '55' },
          { page_path: '/pricing', entrances: '4', exits: '30', bounces: '0', sessions: '33' },
        ]
      }
      return PAGE_ROWS
    })

    const result = await service.pages({ ...base, sessionMetrics: true })

    expect(result.items[0]).toEqual({
      page_path: '/',
      views: 100,
      visitors: 60,
      entrances: 50,
      exits: 20,
      bounces: 10,
      // The denominator is `entrances` on this same row, never an implied one.
      bounce_rate: 10 / 50,
    })
    // A path the complete decoration did not mention is a measured zero: no
    // session began or ended there.
    expect(result.items[2]).toMatchObject({
      page_path: '/docs',
      entrances: 0,
      exits: 0,
      bounces: 0,
      // A rate with no denominator is not zero.
      bounce_rate: null,
    })
  })

  it('reports null rather than zero when the decoration read was cut short', async () => {
    // The distinction the whole `complete` flag exists for. The decoration is
    // asked for `2 x limit` rows; when it comes back full the list may be
    // truncated, and a confident `0` on a busy page would be a wrong answer
    // rather than a missing one.
    const many = Array.from({ length: 200 }, (_, index) => ({
      page_path: `/p${index}`,
      entrances: '1',
      exits: '1',
      bounces: '0',
      sessions: '1',
    }))
    const { service } = serviceWith((operation) => {
      if (operation === 'analytics.freshness') return FRESH
      if (operation === 'analytics.page_sessions_hour') return many
      return PAGE_ROWS
    })

    const result = await service.pages({ ...base, sessionMetrics: true })
    expect(result.items[0]).toMatchObject({ page_path: '/', entrances: null, bounce_rate: null })
  })
})

describe('sorting is a server decision (D-E2)', () => {
  it('leaves a views sort byte-identical to the pre-D-E2 read', async () => {
    const { service, gateway } = serviceWith((operation) =>
      operation === 'analytics.freshness' ? FRESH : PAGE_ROWS,
    )
    await service.pages({ ...base, limit: 25 })

    const call = gateway.calls.find((c) => c.operation === 'analytics.pages_hour')
    // The caller's own limit, not a deepened one: one read, one cut, unchanged.
    expect(call?.params['limit']).toBe(25)
  })

  it('cuts by the requested measure and lets a thin page in on its exits', async () => {
    // The row a client-side sort could never show: `/checkout/done` is a busy
    // exit and a quiet view, so a top-N-by-views page does not contain it — and
    // re-sorting that page by exits would present the busiest exits it happens
    // to hold as the site's busiest exits.
    const { service } = serviceWith((operation) => {
      if (operation === 'analytics.freshness') return FRESH
      if (operation === 'analytics.page_sessions_hour') {
        return [
          {
            page_path: '/checkout/done',
            entrances: '1',
            exits: '90',
            bounces: '0',
            sessions: '90',
          },
          { page_path: '/', entrances: '50', exits: '20', bounces: '10', sessions: '55' },
        ]
      }
      return PAGE_ROWS
    })

    const result = await service.pages({ ...base, sessionMetrics: true, sort: 'exits' })

    expect(result.items[0]).toMatchObject({ page_path: '/checkout/done', exits: 90, views: 0 })
    expect(result.items[1]).toMatchObject({ page_path: '/', exits: 20 })
  })

  it('cuts by entrances when asked for entrances', async () => {
    const { service } = serviceWith((operation) => {
      if (operation === 'analytics.freshness') return FRESH
      if (operation === 'analytics.page_sessions_hour') {
        return [
          { page_path: '/pricing', entrances: '80', exits: '1', bounces: '4', sessions: '80' },
          { page_path: '/', entrances: '50', exits: '20', bounces: '10', sessions: '55' },
        ]
      }
      return PAGE_ROWS
    })

    const result = await service.pages({ ...base, sessionMetrics: true, sort: 'entrances' })
    expect(result.items.map((row) => row.page_path)).toEqual(['/pricing', '/', '/docs'])
  })
})

// ---------------------------------------------------------------------------
// One grammar, three surfaces (D-F1)
// ---------------------------------------------------------------------------

describe('every read surface can ask the same question', () => {
  /** The six reports D-F2 makes filterable, by the `/v1/read` path they mount at. */
  const FILTERABLE_PATHS = [
    '/read/analytics/overview',
    '/read/analytics/timeseries',
    '/read/analytics/pages',
    '/read/analytics/sources',
    '/read/analytics/sources/referrer-paths',
    '/read/analytics/geography',
    '/read/analytics/devices',
  ]

  it('offers `filters` on every filterable MCP tool, and on no other', () => {
    // The ADR says the grain rule is "identical across the dashboard, /v1/read
    // and MCP". For the first two that is a routing fact; for MCP it is a
    // DECLARATION — a tool forwards only the parameters its definition names, so
    // a filter the table does not declare is a filter a model cannot send, and
    // the sentence would have been an overclaim. This is what keeps it true.
    for (const tool of MCP_TOOLS) {
      const declares = tool.params.some((param) => param.name === 'filters')
      const filterable = FILTERABLE_PATHS.includes(tool.path)
      expect(declares, `${tool.name} (${tool.path})`).toBe(filterable)
    }
  })

  it('teaches the grain rule in the tool description, not just the schema', () => {
    // The part a model gets wrong is not the syntax, it is what a filter
    // SELECTS. "Sessions from google.com" and "pageviews whose referrer was
    // google.com" are different questions, and a model that assumes the second
    // will report a customer's paid channel as bouncing.
    const pages = MCP_TOOLS.find((tool) => tool.path === '/read/analytics/pages')
    const filters = pages?.params.find((param) => param.name === 'filters')
    expect(filters?.description).toMatch(/SESSIONS/)
    // And every dimension the grammar accepts is named, so a model does not have
    // to discover the closed vocabulary by being refused.
    for (const dimension of FILTER_DIMENSIONS) {
      expect(filters?.description, dimension).toContain(dimension)
    }
  })
})
