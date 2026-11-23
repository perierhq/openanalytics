import { ApiError } from '@openanalytics/contracts'
import {
  type ImportPointer,
  MAX_REFERRER_PATH_LENGTH,
  REFERRER_PATHS_MAX_HOSTS,
  referrerPathForDisplay,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'
import { AnalyticsService } from '../../apps/api/src/analytics/service.ts'
import type { AnalyticsGateway, GatewayResult } from '../../apps/api/src/gateway-client.ts'
import { findOperation } from '../../apps/query-gateway/src/operations.ts'

/**
 * Sources by channel, and the referring pages behind one referrer.
 *
 * Channels are computed at read time from the rollup's own tuple (the
 * classifier is `packages/domain/src/channel.ts`, tested in `channel.test.ts`),
 * so what is pinned here is the plumbing: every row carries one, the rollup
 * statement is unchanged, and `group_by=channel` collapses the tuples into one
 * row per channel without a second query.
 *
 * Referrer paths read `events_raw`, so the operation is pinned the way every raw
 * reader is: site-scoped, range-capped, row-capped, and it never returns a query
 * string or a fragment even if one was stored.
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

const tuple = (
  referrer_domain: string,
  utm_source: string,
  utm_medium: string,
  views: number,
  visitors: number,
) => ({ referrer_domain, utm_source, utm_medium, utm_campaign: '', views, visitors })

const SOURCE_ROWS = [
  tuple('google.com', '', '', 100, 60),
  tuple('', '', '', 90, 50),
  tuple('chatgpt.com', 'chatgpt.com', '', 40, 20),
  tuple('', 'mailchimp', 'email', 30, 18),
  tuple('x.com', '', '', 20, 12),
  tuple('t.co', '', '', 10, 6),
  tuple('lobste.rs', '', '', 8, 5),
  tuple('google.com', 'google', 'cpc', 7, 4),
]

describe('sources rows carry their channel', () => {
  it('labels every row with the domain classifier’s answer', async () => {
    const { service } = serviceWith((operation) =>
      operation === 'analytics.freshness'
        ? FRESH
        : operation === 'analytics.sources_hour'
          ? SOURCE_ROWS
          : [],
    )
    const { items } = await service.sources(base)
    expect(items.map((row) => [row.referrer_domain, row.utm_medium, row.channel])).toEqual([
      ['google.com', '', 'organic_search'],
      ['', '', 'direct'],
      ['chatgpt.com', '', 'ai'],
      ['', 'email', 'email'],
      ['x.com', '', 'social'],
      ['t.co', '', 'social'],
      ['lobste.rs', '', 'referral'],
      ['google.com', 'cpc', 'paid'],
    ])
  })

  it('computes channels at read time: the rollup statement selects no channel', () => {
    for (const id of ['analytics.sources_hour', 'analytics.sources_day']) {
      expect(findOperation(id)!.sql).not.toMatch(/channel/i)
    }
  })

  it('collapses the tuples into one row per channel with group_by=channel', async () => {
    const { service, gateway } = serviceWith((operation) =>
      operation === 'analytics.freshness'
        ? FRESH
        : operation === 'analytics.sources_hour'
          ? SOURCE_ROWS
          : [],
    )
    const { items } = await service.sources({ ...base, groupBy: 'channel' })
    expect(items).toEqual([
      {
        referrer_domain: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        channel: 'organic_search',
        views: 100,
        visitors: 60,
      },
      {
        referrer_domain: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        channel: 'direct',
        views: 90,
        visitors: 50,
      },
      {
        referrer_domain: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        channel: 'ai',
        views: 40,
        visitors: 20,
      },
      // A tie breaks on channel precedence, so the order is stable.
      {
        referrer_domain: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        channel: 'email',
        views: 30,
        visitors: 18,
      },
      {
        referrer_domain: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        channel: 'social',
        views: 30,
        visitors: 18,
      },
      {
        referrer_domain: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        channel: 'referral',
        views: 8,
        visitors: 5,
      },
      {
        referrer_domain: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        channel: 'paid',
        views: 7,
        visitors: 4,
      },
    ])
    // The collapse reads the deepest tuple list the gateway serves, so the
    // channel totals are not the totals of whatever the caller's limit kept.
    const call = gateway.calls.find((c) => c.operation === 'analytics.sources_hour')
    expect(call?.params['limit']).toBe(500)
  })

  describe('over a range that blends live and imported days', () => {
    const POINTER: ImportPointer = {
      runId: '9f0f6f2e-6b32-4f0b-9e0a-6d1f0f6c2b41',
      cutoverDate: '2026-06-01',
    }
    const BLENDED = { from: '2026-05-20T00:00:00.000Z', to: '2026-06-10T00:00:00.000Z' }
    const hosts = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => tuple(`${prefix}${i}.example`, '', '', 2, 1))

    it('sums every merged tuple, not the top 500 of the merge', async () => {
      // 300 live tuples and 300 imported ones, no key in common: 600 tuples, all
      // referral. A merge cut at 500 before the collapse drops 100 of them from
      // the channel's total without saying so.
      const { service } = serviceWith((operation) =>
        operation === 'analytics.freshness'
          ? FRESH
          : operation === 'analytics.imported_sources'
            ? hosts('imported', 300)
            : operation.startsWith('analytics.sources_')
              ? hosts('live', 300)
              : [],
      )
      const response = await service.sources({
        ...base,
        ...BLENDED,
        importPointer: POINTER,
        groupBy: 'channel',
      })
      expect(response.items.map((row) => [row.channel, row.visitors, row.views])).toEqual([
        ['referral', 600, 1200],
      ])
      expect(response.meta.truncated).toBe(false)
    })

    it('says truncated when a tuple list the channels sum filled the read', async () => {
      // 500 live tuples is the deepest read the gateway serves: there may be
      // more, so the channel totals are a floor and the response says so.
      const { service } = serviceWith((operation) =>
        operation === 'analytics.freshness'
          ? FRESH
          : operation === 'analytics.imported_sources'
            ? hosts('imported', 10)
            : operation.startsWith('analytics.sources_')
              ? hosts('live', 500)
              : [],
      )
      const response = await service.sources({
        ...base,
        ...BLENDED,
        importPointer: POINTER,
        groupBy: 'channel',
      })
      expect(response.items[0]?.visitors).toBe(510)
      expect(response.meta.truncated).toBe(true)
    })
  })

  it('reads a campaign-only tag as Direct: the classifier reads no campaign', async () => {
    // A link tagged with nothing but `utm_campaign` names no sender and no
    // medium, and the browser sent no referrer, so it stays Direct.
    const { service } = serviceWith((operation) =>
      operation === 'analytics.freshness'
        ? FRESH
        : operation === 'analytics.sources_hour'
          ? [{ ...tuple('', '', '', 3, 2), utm_campaign: 'spring-launch' }]
          : [],
    )
    const { items } = await service.sources(base)
    expect(items.map((row) => row.channel)).toEqual(['direct'])
  })

  it('takes the same filters with group_by=channel', async () => {
    const { service, gateway } = serviceWith((operation) =>
      operation === 'analytics.freshness' ? FRESH : [],
    )
    await service.sources({ ...base, groupBy: 'channel', filters: US })
    expect(gateway.calls.map((call) => call.operation)).toContain('analytics.filtered_sources_hour')
  })
})

describe('referrerPathForDisplay', () => {
  it('drops the query string and the fragment', () => {
    expect(referrerPathForDisplay('/s/abc123/some-story?token=secret')).toBe('/s/abc123/some-story')
    expect(referrerPathForDisplay('/a#comment-7')).toBe('/a')
    expect(referrerPathForDisplay('/a?x=1#y')).toBe('/a')
  })

  it('truncates to the display length', () => {
    const long = `/${'a'.repeat(400)}`
    expect(referrerPathForDisplay(long)).toHaveLength(MAX_REFERRER_PATH_LENGTH)
    expect(MAX_REFERRER_PATH_LENGTH).toBe(200)
  })

  it('cuts at a matrix parameter too', () => {
    expect(referrerPathForDisplay('/app;jsessionid=0123456789ABCDEF')).toBe('/app')
    expect(referrerPathForDisplay('/a/b;v=1?x=2')).toBe('/a/b')
  })

  it('cuts a query string that sits after a newline', () => {
    expect(referrerPathForDisplay('/a?token=x\ny')).toBe('/a')
  })

  it('redacts a token, an email or a magic link in any segment', () => {
    expect(referrerPathForDisplay('/reset/Xk29dLq0vB7mN3pR8sT1wY5zA6cE4fG')).toBe(
      '/reset/[redacted]',
    )
    expect(referrerPathForDisplay('/u/jane@x.com')).toBe('/u/[redacted]')
    expect(referrerPathForDisplay('/u/jane%40x.com/settings')).toBe('/u/[redacted]/settings')
    expect(
      referrerPathForDisplay(
        '/auth/magic/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5lIn0.c2lnbmF0dXJlLXZhbHVl',
      ),
    ).toBe('/auth/magic/[redacted]')
    expect(referrerPathForDisplay('/login/callback/sk_live_abcdefgh12345678/done')).toBe(
      '/login/callback/[redacted]/done',
    )
    // A readable path is shown as it came.
    expect(referrerPathForDisplay('/s/abc123/why_we_left')).toBe('/s/abc123/why_we_left')
  })

  it('truncates by character, never splitting a surrogate pair', () => {
    const cut = referrerPathForDisplay(`/${'a'.repeat(198)}😀😀`)
    expect(Array.from(cut)).toHaveLength(MAX_REFERRER_PATH_LENGTH)
    expect(cut.endsWith('😀')).toBe(true)
  })

  it('treats the bare origin as no path at all', () => {
    expect(referrerPathForDisplay('')).toBe('')
    expect(referrerPathForDisplay('/')).toBe('')
    expect(referrerPathForDisplay('/?q=1')).toBe('')
    expect(referrerPathForDisplay('  ')).toBe('')
  })
})

describe('the referrer-paths operation', () => {
  const unfiltered = () => findOperation('analytics.referrer_paths')!
  const filtered = () => findOperation('analytics.filtered_referrer_paths')!
  const params = { site_id: SITE, ...RANGE, referrer_domains: ['lobste.rs'] }

  it('exists in both forms and reads the raw table on purpose', () => {
    expect(unfiltered().sql).toMatch(/\bevents_raw\b/)
    expect(filtered().sql).toMatch(/\bevents_raw\b/)
    expect(filtered().sql).toContain('session_facts_versions')
    expect(unfiltered().sql).not.toContain('session_facts_versions')
  })

  it('is site-scoped and counts landing page views only', () => {
    for (const op of [unfiltered(), filtered()]) {
      expect(op.requiresSiteScope).toBe(true)
      expect(op.sql).toContain('er.site_id = {site_id:UUID}')
      expect(op.sql).toContain("er.type = 'page_view'")
      expect(op.sql).toContain('er.referrer_domain IN {referrer_domains:Array(String)}')
    }
  })

  it('strips the query string and fragment and truncates in the statement itself', () => {
    // Grouping happens on the stripped path, so two links to one page with
    // different query strings are one row — and a stored token never leaves.
    const sql = unfiltered().sql
    // `(?s)` lets `.` cross a newline (RE2 does not by default), and `;` cuts a
    // matrix parameter (`;jsessionid=…`) the same as a query string. The `;` is
    // the ClickHouse escape `\x3B`: a statement may not contain a literal `;`.
    expect(sql).toContain("replaceRegexpOne(er.referrer_path, '(?s)[?#\\x3B].*', '')")
    expect(sql).toContain('substringUTF8(')
    expect(sql).toContain(', 1, 200)')
    expect(sql).toContain("NOT IN ('', '/')")
  })

  it('caps rows per host and in total', () => {
    const sql = unfiltered().sql
    expect(sql).toContain('LIMIT {limit:UInt32} BY referrer_domain')
    expect(unfiltered().maxRows).toBe(REFERRER_PATHS_MAX_HOSTS * 20)
  })

  it('binds the hosts as an array and defaults the per-host limit', () => {
    const bound = unfiltered().bindParams(params)
    expect(bound['referrer_domains']).toBe("['lobste.rs']")
    expect(bound['limit']).toBe(10)
  })

  it('refuses a range over 92 days, an unaligned range, no host and too many hosts', () => {
    const refuses = (input: Record<string, unknown>) =>
      expect(() => unfiltered().bindParams(input)).toThrow(ApiError)
    refuses({ ...params, from: '2026-01-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' })
    refuses({ ...params, from: '2026-07-01T00:07:00.000Z' })
    refuses({ ...params, referrer_domains: [] })
    refuses({
      ...params,
      referrer_domains: Array.from({ length: REFERRER_PATHS_MAX_HOSTS + 1 }, (_, i) => `h${i}.com`),
    })
    refuses({ ...params, limit: 21 })
  })

  it('the filtered form requires a filter set', () => {
    expect(() => filtered().bindParams(params)).toThrow(ApiError)
    const bound = filtered().bindParams({
      ...params,
      filters: [{ dimension: 'country', operator: 'eq', values: ['US'] }],
    })
    expect(bound['f_country_on']).toBe(1)
  })
})

describe('the referrer-paths read', () => {
  const PATH_ROWS = [
    { referrer_domain: 'lobste.rs', ref_path: '/s/abc123/why_we_left', views: '9', visitors: '7' },
    { referrer_domain: 'lobste.rs', ref_path: '/s/def456?x=1', views: '3', visitors: '2' },
  ]

  it('routes an unfiltered read to the unfiltered operation', async () => {
    const { service, gateway } = serviceWith((operation) =>
      operation === 'analytics.freshness'
        ? FRESH
        : operation === 'analytics.referrer_paths'
          ? PATH_ROWS
          : [],
    )
    const response = await service.referrerPaths({
      ...base,
      referrerDomains: ['lobste.rs'],
      limit: 10,
    })
    expect(response.items).toEqual([
      { referrer_domain: 'lobste.rs', path: '/s/abc123/why_we_left', views: 9, visitors: 7 },
      // Stripped again on the way out, whatever the statement returned.
      { referrer_domain: 'lobste.rs', path: '/s/def456', views: 3, visitors: 2 },
    ])
    expect(gateway.calls.map((call) => call.operation)).not.toContain(
      'analytics.filtered_referrer_paths',
    )
  })

  it('merges the rows redaction makes identical', async () => {
    // Two reset links, one email in a path: each token is its own row in
    // ClickHouse, and after redaction they are one page each.
    const { service } = serviceWith((operation) =>
      operation === 'analytics.freshness'
        ? FRESH
        : operation === 'analytics.referrer_paths'
          ? [
              {
                referrer_domain: 'app.example',
                ref_path: '/reset/Xk29dLq0vB7mN3pR8sT1wY5zA6cE4fG',
                views: '2',
                visitors: '2',
              },
              {
                referrer_domain: 'app.example',
                ref_path: '/reset/Pq81mZ0vB7nN3pR8sT1wY5zA6cE4fHj',
                views: '3',
                visitors: '1',
              },
              { referrer_domain: 'app.example', ref_path: '/docs', views: '1', visitors: '1' },
              {
                referrer_domain: 'app.example',
                ref_path: '/u/jane@x.com',
                views: '1',
                visitors: '1',
              },
            ]
          : [],
    )
    const response = await service.referrerPaths({
      ...base,
      referrerDomains: ['app.example'],
      limit: 10,
    })
    expect(response.items).toEqual([
      { referrer_domain: 'app.example', path: '/reset/[redacted]', views: 5, visitors: 3 },
      { referrer_domain: 'app.example', path: '/docs', views: 1, visitors: 1 },
      { referrer_domain: 'app.example', path: '/u/[redacted]', views: 1, visitors: 1 },
    ])
    expect(JSON.stringify(response)).not.toContain('jane@')
    expect(JSON.stringify(response)).not.toContain('Xk29dLq0')
  })

  it('routes a filtered read to the filtered operation', async () => {
    const { service, gateway } = serviceWith((operation) =>
      operation === 'analytics.freshness' ? FRESH : [],
    )
    await service.referrerPaths({ ...base, referrerDomains: ['lobste.rs'], limit: 10, filters: US })
    expect(gateway.calls.map((call) => call.operation)).toContain(
      'analytics.filtered_referrer_paths',
    )
  })

  it('refuses a range over 92 days by name before any query', async () => {
    const { service, gateway } = serviceWith(() => [])
    await expect(
      service.referrerPaths({
        ...base,
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-07-01T00:00:00.000Z',
        referrerDomains: ['lobste.rs'],
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: 'RANGE_TOO_LARGE' })
    expect(gateway.calls.filter((c) => c.operation.includes('referrer_paths'))).toEqual([])
  })
})
