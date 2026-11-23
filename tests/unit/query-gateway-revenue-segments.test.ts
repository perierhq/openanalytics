import { REVENUE_SEGMENT_MIN_VISITORS, REVENUE_SEGMENT_PRIOR_K } from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'
import { findOperation } from '../../apps/query-gateway/src/operations.ts'

/**
 * The two gateway operations behind revenue by segment: their parameters,
 * their caps and the shape of their SQL. What they answer against a real
 * ClickHouse is `tests/migration/query-gateway-revenue-segments.test.ts`.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const RANGE = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' }
const DAY_MS = 86_400_000

function op(id: string) {
  const operation = findOperation(id)
  if (!operation) throw new Error(`missing operation ${id}`)
  return operation
}

/** The validation messages a refused binding carried. */
function issuesOf(fn: () => unknown): string[] {
  try {
    fn()
  } catch (error) {
    const details = (error as { details?: { issues?: { message: string }[] } }).details
    return (details?.issues ?? []).map((issue) => issue.message)
  }
  throw new Error('expected the binding to be refused')
}

const totals = () => op('analytics.revenue_segment_totals')
const segments = () => op('analytics.revenue_segments')

const range = (days: number) => ({
  from: RANGE.from,
  to: new Date(Date.parse(RANGE.from) + days * DAY_MS).toISOString(),
})

describe('parameters and caps', () => {
  it('binds the site, the range and, for the rows, the prior and the limit', () => {
    expect(totals().bindParams({ site_id: SITE, ...RANGE })).toEqual({
      site_id: SITE,
      from: '2026-07-01 00:00:00.000',
      to: '2026-07-08 00:00:00.000',
    })
    expect(
      segments().bindParams({ site_id: SITE, ...RANGE, prior_value_minor: 12.5, limit: 7 }),
    ).toEqual({
      site_id: SITE,
      from: '2026-07-01 00:00:00.000',
      to: '2026-07-08 00:00:00.000',
      prior_value_minor: 12.5,
      limit: 7,
    })
  })

  it('reads at most 92 days, like every other session-fact read', () => {
    for (const operation of [totals(), segments()]) {
      const extra = operation === segments() ? { prior_value_minor: 0, limit: 10 } : {}
      expect(() => operation.bindParams({ site_id: SITE, ...range(92), ...extra })).not.toThrow()
      expect(
        issuesOf(() => operation.bindParams({ site_id: SITE, ...range(93), ...extra })),
      ).toEqual([
        expect.stringMatching(/revenue segments range span exceeds the 7948800000ms maximum/),
      ])
    }
  })

  it('refuses an empty, inverted or unaligned range', () => {
    for (const operation of [totals(), segments()]) {
      const extra = operation === segments() ? { prior_value_minor: 0, limit: 10 } : {}
      expect(() =>
        operation.bindParams({ site_id: SITE, from: RANGE.to, to: RANGE.from, ...extra }),
      ).toThrow()
      expect(() =>
        operation.bindParams({ site_id: SITE, from: RANGE.from, to: RANGE.from, ...extra }),
      ).toThrow()
      expect(() =>
        operation.bindParams({
          site_id: SITE,
          from: '2026-07-01T00:07:00.000Z',
          to: RANGE.to,
          ...extra,
        }),
      ).toThrow()
    }
  })

  it('caps the limit at 500 and wants a finite, non-negative prior', () => {
    const base = { site_id: SITE, ...RANGE, prior_value_minor: 1 }
    expect(() => segments().bindParams({ ...base, limit: 0 })).toThrow()
    expect(() => segments().bindParams({ ...base, limit: 501 })).toThrow()
    expect(() => segments().bindParams({ ...base, limit: 500 })).not.toThrow()
    expect(() => segments().bindParams({ ...base, limit: 5, prior_value_minor: -1 })).toThrow()
    expect(() =>
      segments().bindParams({ ...base, limit: 5, prior_value_minor: Number.POSITIVE_INFINITY }),
    ).toThrow()
  })

  it('takes no stray parameter and needs a site', () => {
    expect(() => totals().bindParams({ site_id: SITE, ...RANGE, limit: 5 })).toThrow()
    expect(() => totals().bindParams({ ...RANGE })).toThrow()
    expect(totals().requiresSiteScope).toBe(true)
    expect(segments().requiresSiteScope).toBe(true)
  })
})

describe('the SQL', () => {
  const both = () => [totals().sql, segments().sql]

  it('reads the session facts, the charges and their attributions, never raw events', () => {
    for (const sql of both()) {
      expect(sql).toMatch(/FROM session_facts_versions AS sfv/)
      expect(sql).toMatch(/FROM revenue_events AS re/)
      expect(sql).toMatch(/FROM revenue_attributions AS ra/)
      expect(sql).not.toMatch(/events_raw/)
      expect(sql).not.toMatch(/\bFINAL\b/)
      // Current truth by argMax, retraction after the version pick.
      expect(sql).toMatch(/argMax\(sfv\.retracted, sfv\.version\)/)
      expect(sql).toMatch(/argMax\(ra\.visitor_id, ra\.version\)/)
    }
  })

  it('keys a segment on the session entry: referrer, country, device', () => {
    for (const sql of both()) {
      expect(sql).toMatch(/argMax\(sfv\.referrer_domain, sfv\.version\)/)
      expect(sql).toMatch(/argMax\(sfv\.country, sfv\.version\)/)
      expect(sql).toMatch(/argMax\(sfv\.device_type, sfv\.version\)/)
      // A buyer's segment is their last touch: its referrer off the
      // attribution, its country and device off that session.
      expect(sql).toMatch(/argMax\(ra\.lt_referrer_domain, ra\.version\)/)
      expect(sql).toMatch(/argMax\(ra\.lt_session_id, ra\.version\)/)
    }
  })

  it('counts conversions only, converted revenue only, attributed buyers only', () => {
    for (const sql of both()) {
      expect(sql).toMatch(/cur\.is_conversion = 1/)
      expect(sql).toMatch(/conversion_source != 'unavailable'/)
      expect(sql).toMatch(/countIf\([^)]*conversion_source = 'unavailable'\)/)
      expect(sql).toMatch(/att\.visitor_id != ''/)
      expect(sql).toMatch(/cur\.status NOT IN \('failed', 'canceled', 'cancelled'\)/)
    }
  })

  it('scopes every table read to the site', () => {
    for (const sql of both()) {
      const reads =
        sql.match(/FROM (session_facts_versions|revenue_events|revenue_attributions) AS \w+/g) ?? []
      const scoped = sql.match(/WHERE \w+\.site_id = \{site_id:UUID\}/g) ?? []
      expect(reads.length).toBeGreaterThan(0)
      expect(scoped.length).toBeGreaterThanOrEqual(reads.length)
    }
  })

  it('hides segments under the threshold in the rows, and counts them in the totals', () => {
    expect(segments().sql).toContain(`HAVING visitors >= ${REVENUE_SEGMENT_MIN_VISITORS}`)
    expect(totals().sql).toMatch(
      new RegExp(`countIf\\([^\\n]*seg\\.visitors < ${REVENUE_SEGMENT_MIN_VISITORS}\\)`),
    )
  })

  it('orders by smoothed value per visitor with the documented k, before the limit', () => {
    const sql = segments().sql
    const k = REVENUE_SEGMENT_PRIOR_K
    expect(sql).toContain(
      `ORDER BY (revenue_minor + ${k} * {prior_value_minor:Float64}) / (visitors + ${k}) DESC`,
    )
    expect(sql.indexOf('ORDER BY')).toBeLessThan(sql.indexOf('LIMIT {limit:UInt32}'))
    expect(segments().maxRows).toBe(500)
    expect(totals().maxRows).toBe(1)
  })

  it('counts a purchase only when its last visit started in the range: no lookback', () => {
    for (const sql of both()) {
      expect(sql).toContain(
        "argMax(ra.lt_session_start, ra.version) >= toDateTime64({from:String}, 3, 'UTC')",
      )
      // No lookback on the session facts: a last touch before `from` is left out.
      expect(sql).not.toMatch(/session_start [^\n]*INTERVAL/)
    }
    // The totals say how many buyers that left out, and why.
    expect(totals().sql).toMatch(/AS buyers_last_visit_before_range\b/)
    expect(totals().sql).toMatch(/AS buyers_last_visit_missing\b/)
  })

  it('reads the session facts twice, not four times: visitors and last touches in one pass each', () => {
    for (const sql of both()) {
      // Once for the visitors, site-wide and per segment together; once,
      // by session id, for the last-touch sessions of the purchases.
      expect(sql.match(/FROM session_facts_versions\b/g) ?? []).toHaveLength(2)
      expect(sql.match(/FROM revenue_events\b/g) ?? []).toHaveLength(1)
      expect(sql.match(/GROUP BY GROUPING SETS \(\(src, ctry, dev\), \(\)\)/g) ?? []).toHaveLength(
        2,
      )
    }
  })

  it('caches like the other revenue reads', () => {
    expect(totals().cacheProfile).toBe('default')
    expect(segments().cacheProfile).toBe('default')
    expect(totals().cacheable).toBe(true)
  })
})
