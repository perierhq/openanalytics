import { describe, expect, it } from 'vitest'
import {
  MCP_TOOLS,
  buildToolRequest,
  inputSchema,
  toolArgumentRefusal,
} from '../../apps/api/src/http/mcp.ts'
import { SITE_HEADER } from '../../apps/api/src/http/read-key.ts'

/**
 * The one home for "a tool call is a `Request` against our own read routes"
 * (ADR-0046 D3).
 *
 * MCP built this logic first and the assistant needs exactly it. A copy would be
 * a second place where a path could be named that the first one would never have
 * named, and it would drift the first time somebody adds a parameter to one — the
 * argument `mcp.ts`'s own table comment already makes about eight handlers. So
 * the builder is a function both consumers call, and this file is what pins its
 * behaviour independently of either.
 *
 * The assertion that matters most is the last one: **the dispatched request
 * carries only the caller's own credential, the site selector and `accept`.**
 * The moment it carries an internal marker saying "this came from the
 * assistant", the tool loop stops being the route and starts being a bypass with
 * a header on it (ADR-0046 D4).
 */

const ORIGIN = 'https://api.test'
const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'

/** Every header name on a built request, so "and nothing else" is assertable. */
function headerNames(request: Request): string[] {
  const names: string[] = []
  request.headers.forEach((_value, name) => names.push(name.toLowerCase()))
  return names.sort()
}

const tool = (name: string) => {
  const found = MCP_TOOLS.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

describe('the tool request builder (ADR-0046 D3)', () => {
  it('forwards the declared parameters onto the tool’s own read path', () => {
    const request = buildToolRequest({
      tool: tool('top_pages'),
      args: {
        site_id: SITE,
        from: '2026-07-16T00:00:00.000Z',
        to: '2026-07-23T00:00:00.000Z',
        limit: '5',
      },
      resourceUrl: ORIGIN,
      credential: { header: 'authorization', value: 'Bearer abc' },
    })

    const url = new URL(request.url)
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/v1/read/analytics/pages`)
    expect(url.searchParams.get('from')).toBe('2026-07-16T00:00:00.000Z')
    expect(url.searchParams.get('to')).toBe('2026-07-23T00:00:00.000Z')
    expect(url.searchParams.get('limit')).toBe('5')
  })

  it('cuts a ranged read on the site’s own clock, and adds no timezone where there is no range', () => {
    // ADR-0079 D5: the site's reporting zone is the calendar its owner reads the
    // dashboard on, so "last week" means to a model what it means to them. It
    // used to be a hardcoded `UTC`, which quietly shifted a Kolkata report by a
    // day against the screen it told the reader to open.
    const ranged = buildToolRequest({
      tool: tool('site_overview'),
      args: { site_id: SITE, from: '2026-07-16T00:00:00.000Z', to: '2026-07-23T00:00:00.000Z' },
      resourceUrl: ORIGIN,
      credential: { header: 'cookie', value: 'oa_session=x' },
      siteTimezone: 'Asia/Kolkata',
    })
    expect(new URL(ranged.url).searchParams.get('timezone')).toBe('Asia/Kolkata')

    const listing = buildToolRequest({
      tool: tool('list_sites'),
      args: {},
      resourceUrl: ORIGIN,
      credential: { header: 'cookie', value: 'oa_session=x' },
      siteTimezone: 'Asia/Kolkata',
    })
    expect(new URL(listing.url).searchParams.get('timezone')).toBeNull()
  })

  it('lets the model name a zone, and falls back to UTC when nobody named one', () => {
    // The argument wins: a question about a different calendar is a question the
    // model may legitimately ask, and the answer names the zone it used in
    // `meta.timezone` either way.
    const asked = buildToolRequest({
      tool: tool('site_overview'),
      args: { site_id: SITE, from: 'a', to: 'b', timezone: 'Pacific/Auckland' },
      resourceUrl: ORIGIN,
      credential: { header: 'cookie', value: 'oa_session=x' },
      siteTimezone: 'Asia/Kolkata',
    })
    expect(new URL(asked.url).searchParams.get('timezone')).toBe('Pacific/Auckland')

    // And a caller that could resolve no site zone still names a defined one,
    // rather than sending a read the route would refuse for a missing parameter.
    const unresolved = buildToolRequest({
      tool: tool('site_overview'),
      args: { site_id: SITE, from: 'a', to: 'b' },
      resourceUrl: ORIGIN,
      credential: { header: 'cookie', value: 'oa_session=x' },
    })
    expect(new URL(unresolved.url).searchParams.get('timezone')).toBe('UTC')
  })

  it('names the site in the header for a site tool, and not at all for list_sites', () => {
    const sited = buildToolRequest({
      tool: tool('devices'),
      args: { site_id: SITE, from: 'a', to: 'b' },
      resourceUrl: ORIGIN,
      credential: { header: 'cookie', value: 'oa_session=x' },
    })
    expect(sited.headers.get(SITE_HEADER)).toBe(SITE)
    // Never a query parameter: the selector is a header so it cannot mix with
    // the analytics parameters every read already parses.
    expect(new URL(sited.url).searchParams.get('site_id')).toBeNull()

    const listing = buildToolRequest({
      tool: tool('list_sites'),
      args: { site_id: SITE },
      resourceUrl: ORIGIN,
      credential: { header: 'cookie', value: 'oa_session=x' },
    })
    expect(listing.headers.get(SITE_HEADER)).toBeNull()
  })

  it('drops an argument the tool never declared', () => {
    // The row is the allowlist. A model that invents `raw_sql=` gets a request
    // that does not carry it.
    const request = buildToolRequest({
      tool: tool('site_overview'),
      args: { site_id: SITE, from: 'a', to: 'b', raw_sql: 'select 1', limit: '9' },
      resourceUrl: ORIGIN,
      credential: { header: 'cookie', value: 'oa_session=x' },
    })
    const url = new URL(request.url)
    expect(url.searchParams.get('raw_sql')).toBeNull()
    // `limit` is not a parameter of `site_overview`, only of the top-N reads.
    expect(url.searchParams.get('limit')).toBeNull()
  })

  it('carries the caller’s own credential and no internal marker of any kind', () => {
    const viaCookie = buildToolRequest({
      tool: tool('site_overview'),
      args: { site_id: SITE, from: 'a', to: 'b' },
      resourceUrl: ORIGIN,
      credential: { header: 'cookie', value: 'oa_session=live' },
    })
    expect(viaCookie.headers.get('cookie')).toBe('oa_session=live')
    expect(viaCookie.headers.get('authorization')).toBeNull()
    expect(headerNames(viaCookie)).toEqual(['accept', 'cookie', 'x-oa-site'])

    const viaBearer = buildToolRequest({
      tool: tool('list_sites'),
      args: {},
      resourceUrl: ORIGIN,
      credential: { header: 'authorization', value: 'Bearer abc' },
    })
    expect(viaBearer.headers.get('authorization')).toBe('Bearer abc')
    expect(headerNames(viaBearer)).toEqual(['accept', 'authorization'])
  })

  it('threads a caller abort onto the dispatched request', () => {
    const controller = new AbortController()
    const request = buildToolRequest({
      tool: tool('list_sites'),
      args: {},
      resourceUrl: ORIGIN,
      credential: { header: 'cookie', value: 'oa_session=x' },
      signal: controller.signal,
    })
    expect(request.signal.aborted).toBe(false)
    controller.abort()
    expect(request.signal.aborted).toBe(true)
  })
})

/**
 * The two rows ADR-0049 added, as data.
 *
 * The table is the allowlist and the whole of what a model may reach, so what is
 * asserted here is the row itself: the path it names, the scope it declares, and
 * — the load-bearing one — that no row names a per-customer read. ADR-0043 D15's
 * customer-row half is untouched, and "no such row exists" is a stronger claim
 * than "the route would refuse".
 */
describe('the revenue tool rows (ADR-0049 D2)', () => {
  it('names the two aggregate reads and nothing beside them', () => {
    expect(tool('revenue_summary').path).toBe('/read/revenue/summary')
    expect(tool('revenue_timeseries').path).toBe('/read/revenue/timeseries')
    for (const name of ['revenue_summary', 'revenue_timeseries']) {
      expect(tool(name).scope).toBe('revenue:read')
      expect(tool(name).needsSite).toBe(true)
    }
  })

  it('names the subscription aggregates under the same scope (Perier gap 7)', () => {
    expect(tool('subscription_summary').path).toBe('/read/revenue/subscriptions/summary')
    expect(tool('subscription_timeseries').path).toBe('/read/revenue/subscriptions/timeseries')
    for (const name of ['subscription_summary', 'subscription_timeseries']) {
      expect(tool(name).scope).toBe('revenue:read')
      expect(tool(name).needsSite).toBe(true)
    }
  })

  it('has no row for a per-customer read, on any surface', () => {
    for (const entry of MCP_TOOLS) {
      expect(entry.path, entry.name).not.toContain('transactions')
      expect(entry.path, entry.name).not.toContain('journey')
      // Realtime mints a credential rather than returning a read, and a tool
      // that hands a model a bearer token is a category error.
      expect(entry.path, entry.name).not.toContain('realtime')
    }
  })

  it('names a visitor only in the two person-only visitor reads', () => {
    // The visitor reads are pseudonymous rows (a rotating hash), not customer
    // rows: the row-level revenue half stays out because the read route drops
    // `revenue_events` (api-read-person-routes.test.ts). Any other path naming
    // a visitor would be a read nobody has decided.
    expect(
      MCP_TOOLS.filter((entry) => entry.path.includes('visitor')).map((entry) => entry.path),
    ).toEqual(['/read/analytics/recent-visitors', '/read/analytics/visitor'])
  })

  it('dispatches into the revenue route with the range, the site header and the site’s zone', () => {
    const request = buildToolRequest({
      tool: tool('revenue_summary'),
      args: {
        site_id: SITE,
        from: '2026-07-16T00:00:00.000Z',
        to: '2026-07-23T00:00:00.000Z',
        resolution: 'day',
      },
      resourceUrl: ORIGIN,
      credential: { header: 'cookie', value: 'oa_session=x' },
      siteTimezone: 'Europe/Istanbul',
    })
    const url = new URL(request.url)
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/v1/read/revenue/summary`)
    expect(url.searchParams.get('timezone')).toBe('Europe/Istanbul')
    expect(url.searchParams.get('resolution')).toBe('day')
    expect(request.headers.get(SITE_HEADER)).toBe(SITE)
  })

  it('requires the range, and leaves the grain optional', () => {
    expect(toolArgumentRefusal(tool('revenue_timeseries'), { site_id: SITE })).toBe(
      'revenue_timeseries requires from',
    )
    expect(
      toolArgumentRefusal(tool('revenue_timeseries'), { site_id: SITE, from: 'a', to: 'b' }),
    ).toBeNull()
  })

  it('shows the model the same schema an MCP host is shown', () => {
    const schema = inputSchema(tool('revenue_summary')) as {
      required: string[]
      properties: Record<string, unknown>
    }
    expect(schema.required).toEqual(['site_id', 'from', 'to'])
    expect(Object.keys(schema.properties)).toContain('resolution')
  })
})

describe('the shared argument refusal', () => {
  it('names the missing site, and points at the tool that answers it', () => {
    expect(toolArgumentRefusal(tool('site_overview'), {})).toBe(
      'site_overview requires site_id (see list_sites)',
    )
  })

  it('names a missing required parameter', () => {
    expect(toolArgumentRefusal(tool('site_overview'), { site_id: SITE, from: 'a' })).toBe(
      'site_overview requires to',
    )
  })

  it('says nothing when an optional parameter is absent', () => {
    expect(toolArgumentRefusal(tool('top_pages'), { site_id: SITE, from: 'a', to: 'b' })).toBeNull()
  })
})

describe('a list parameter (funnel_results.steps)', () => {
  const args = {
    site_id: SITE,
    from: '2026-07-16T00:00:00.000Z',
    to: '2026-07-23T00:00:00.000Z',
    steps: ['/pricing', 'signup', '/welcome'],
    window_ms: '86400000',
  }

  it('is an array of strings in the schema, so a model sends the steps as a list', () => {
    const schema = inputSchema(tool('funnel_results')) as {
      properties: Record<string, { type: string; items?: { type: string } }>
      required: string[]
    }
    expect(schema.properties['steps']).toMatchObject({ type: 'array', items: { type: 'string' } })
    expect(schema.properties['funnel_id']?.type).toBe('string')
    // Neither form is required on its own: the route refuses both-or-neither.
    expect(schema.required).not.toContain('steps')
    expect(schema.required).not.toContain('funnel_id')
  })

  it('becomes repeated query parameters, in order', () => {
    const request = buildToolRequest({
      tool: tool('funnel_results'),
      args,
      resourceUrl: ORIGIN,
      credential: { header: 'authorization', value: 'Bearer abc' },
    })
    const url = new URL(request.url)
    expect(url.pathname).toBe('/v1/read/analytics/funnel')
    expect(url.searchParams.getAll('steps')).toEqual(['/pricing', 'signup', '/welcome'])
    expect(url.searchParams.get('window_ms')).toBe('86400000')
    expect(request.headers.get(SITE_HEADER)).toBe(SITE)
  })

  it('is refused when it is not an array of strings, rather than dropped', () => {
    expect(
      toolArgumentRefusal(tool('funnel_results'), { ...args, steps: '/pricing,signup' }),
    ).toContain('array of strings')
    expect(toolArgumentRefusal(tool('funnel_results'), { ...args, steps: ['/a', 2] })).toContain(
      'array of strings',
    )
    expect(toolArgumentRefusal(tool('funnel_results'), args)).toBeNull()
  })
})
