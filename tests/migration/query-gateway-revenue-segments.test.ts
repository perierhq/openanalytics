import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import { migrateClickHouse } from '@openanalytics/clickhouse'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpClickHouseReader } from '../../apps/query-gateway/src/clickhouse-http.ts'
import type { QueryParameterValue } from '../../apps/query-gateway/src/clickhouse.ts'
import { findOperation } from '../../apps/query-gateway/src/operations.ts'

/**
 * Revenue by segment (referrer × country × device) against a live, migrated
 * ClickHouse.
 *
 * What only a real server can answer:
 *
 *   1. **Visitors are the session entries**, current version only, retraction
 *      applied after the version pick, and a visitor with two sessions in one
 *      segment counts once.
 *   2. **A buyer's segment is the last touch**: the referrer the current
 *      attribution names, the country and device of that session, found even
 *      when the session started before the range. A retracted last-touch
 *      session leaves the purchase in the empty country/device segment.
 *   3. **Conversions only**: renewals, failed charges and unattributed
 *      charges count nowhere; an unconverted order is an order with no
 *      revenue.
 *   4. **Totals and the hidden count**: the site's own uniqExact visitors and
 *      buyers, and segments under 20 visitors counted rather than returned.
 *   5. **Ranking** by smoothed value per visitor, before the limit.
 *   6. Cross-site isolation.
 *
 * Skipped without TEST_CLICKHOUSE_URL; CI always provides one.
 */

const URL_ = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''

const describeIfClickHouse = URL_ ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

const FROM = '2026-07-01T00:00:00.000Z'
const TO = '2026-07-08T00:00:00.000Z'

function charge(over: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: 'stripe',
    object_kind: 'charge',
    version: 1,
    status: 'succeeded',
    livemode: 1,
    currency: 'eur',
    gross_minor: 0,
    reporting_currency: 'EUR',
    conversion_source: 'identity',
    conversion_rate: 1,
    ingested_via: 'webhook',
    ingested_at: '2026-07-10 00:00:00.000',
    ...over,
    reporting_gross_minor: over['reporting_gross_minor'] ?? over['gross_minor'] ?? 0,
  }
}

function attribution(over: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: 'stripe',
    version: 1,
    model_version: 1,
    window_days: 30,
    matched_via: 'client_reference',
    confidence: 'linked',
    identity_scope: 'anonymous_day',
    journey: '[]',
    computed_at: '2026-07-10 00:00:00.000',
    // The start of the last-touch session; every fixture session but two starts here.
    lt_session_start: '2026-07-02 09:00:00.000',
    ...over,
  }
}

function fact(over: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    user_id: '',
    anonymous_id: '',
    session_hint: '',
    session_hints: [],
    midnight_bridged: 0,
    session_end: '2026-07-02 10:05:00.000',
    pageviews: 1,
    engaged: 1,
    active_duration_ms: 0,
    session_duration_ms: 0,
    entry_page_path: '/',
    exit_page_path: '/',
    finalized: 1,
    retracted: 0,
    computed_at: '2026-07-03 00:00:00.000',
    session_start: '2026-07-02 09:00:00.000',
    referrer_domain: 'google.com',
    country: 'DE',
    device_type: 'desktop',
    ...over,
  }
}

describeIfClickHouse('revenue segment operations', () => {
  const url = URL_ as string
  const database = `rs_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>
  const reader = createHttpClickHouseReader({
    url,
    database,
    username: USERNAME,
    password: PASSWORD,
  })

  const run = async (
    operationId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> => {
    const operation = findOperation(operationId)
    if (!operation) throw new Error(`no such operation ${operationId}`)
    const parameters = operation.bindParams(input) as Record<string, QueryParameterValue>
    const result = await reader.query({
      sql: operation.sql,
      parameters,
      signal: new AbortController().signal,
      queryId: randomUUID(),
      settings: { max_execution_time: 20, max_result_rows: 200_000, result_overflow_mode: 'throw' },
    })
    return [...result.rows]
  }

  const site = randomUUID()
  const otherSite = randomUUID()

  beforeAll(async () => {
    const { logger } = createCapturedLogger()
    await migrateClickHouse({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
      directory: MIGRATIONS_DIR,
      logger,
    })
    client = createClient({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
      clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 },
    })

    const sessions: Record<string, unknown>[] = []
    // 25 Google visitors from Germany on a desktop; G1 came twice.
    for (let i = 1; i <= 25; i++) {
      sessions.push(fact({ site_id: site, session_id: `s_g${i}`, visitor_id: `G${i}` }))
    }
    sessions.push(
      fact({
        site_id: site,
        session_id: 's_g1_again',
        visitor_id: 'G1',
        session_start: '2026-07-05 09:00:00.000',
      }),
    )
    // Re-versioned: v1 said Bing from France, v2 says Google from Germany.
    sessions.push(
      fact({
        site_id: site,
        session_id: 's_v',
        visitor_id: 'V1',
        referrer_domain: 'bing.com',
        country: 'FR',
      }),
      fact({ site_id: site, session_id: 's_v', version: 2, visitor_id: 'V1' }),
    )
    // Retracted by its latest version: counts nowhere.
    sessions.push(
      fact({ site_id: site, session_id: 's_x', visitor_id: 'X1' }),
      fact({ site_id: site, session_id: 's_x', version: 2, visitor_id: 'X1', retracted: 1 }),
    )
    // Three direct visitors from the US on a phone: under the threshold.
    for (let i = 1; i <= 3; i++) {
      sessions.push(
        fact({
          site_id: site,
          session_id: `s_d${i}`,
          visitor_id: `D${i}`,
          referrer_domain: '',
          country: 'US',
          device_type: 'mobile',
        }),
      )
    }
    // Twenty direct visitors from Poland on a desktop, none of whom bought.
    for (let i = 1; i <= 20; i++) {
      sessions.push(
        fact({
          site_id: site,
          session_id: `s_p${i}`,
          visitor_id: `P${i}`,
          referrer_domain: '',
          country: 'PL',
        }),
      )
    }
    // Before the range: not a visitor of it, but the last touch of a purchase in it.
    sessions.push(
      fact({
        site_id: site,
        session_id: 's_old',
        visitor_id: 'B_OLD',
        session_start: '2026-06-28 09:00:00.000',
        referrer_domain: 'twitter.com',
        country: 'GB',
        device_type: 'tablet',
      }),
    )
    sessions.push(fact({ site_id: otherSite, session_id: 's_other', visitor_id: 'G1' }))
    await client.insert({
      table: 'session_facts_versions',
      format: 'JSONEachRow',
      values: sessions,
    })

    await client.insert({
      table: 'revenue_events',
      format: 'JSONEachRow',
      values: [
        charge({
          site_id: site,
          object_id: 'ch1',
          occurred_at: '2026-07-02 12:00:00.000',
          gross_minor: 1000,
        }),
        charge({
          site_id: site,
          object_id: 'ch2',
          occurred_at: '2026-07-02 13:00:00.000',
          gross_minor: 2000,
        }),
        charge({
          site_id: site,
          object_id: 'ch3',
          occurred_at: '2026-07-05 12:00:00.000',
          gross_minor: 500,
        }),
        // No usable rate: an order, never zero revenue.
        charge({
          site_id: site,
          object_id: 'ch4',
          occurred_at: '2026-07-03 12:00:00.000',
          currency: 'xyz',
          gross_minor: 4200,
          reporting_gross_minor: 0,
          conversion_source: 'unavailable',
        }),
        // A renewal (the invoice below says so): not a conversion.
        charge({
          site_id: site,
          object_id: 'ch5',
          occurred_at: '2026-07-04 12:00:00.000',
          gross_minor: 2000,
        }),
        charge({
          site_id: site,
          object_id: 'ch6',
          occurred_at: '2026-07-04 13:00:00.000',
          gross_minor: 9000,
          status: 'failed',
        }),
        charge({
          site_id: site,
          object_id: 'ch7',
          occurred_at: '2026-07-02 08:00:00.000',
          gross_minor: 700,
        }),
        // No attribution row at all.
        charge({
          site_id: site,
          object_id: 'ch8',
          occurred_at: '2026-07-02 08:30:00.000',
          gross_minor: 9999,
        }),
        charge({
          site_id: site,
          object_id: 'ch9',
          occurred_at: '2026-07-02 14:00:00.000',
          gross_minor: 300,
        }),
        charge({
          site_id: site,
          object_id: 'ch10',
          occurred_at: '2026-07-02 15:00:00.000',
          gross_minor: 400,
        }),
        // G3 again, after a visit before the range: G3 is still a buyer (ch4).
        charge({
          site_id: site,
          object_id: 'ch13',
          occurred_at: '2026-07-03 15:00:00.000',
          gross_minor: 800,
        }),
        // Its last-touch session was never recorded.
        charge({
          site_id: site,
          object_id: 'ch11',
          occurred_at: '2026-07-03 12:00:00.000',
          gross_minor: 600,
        }),
        charge({
          site_id: otherSite,
          object_id: 'ch_other',
          occurred_at: '2026-07-02 12:00:00.000',
          gross_minor: 7777,
        }),
      ],
    })

    await client.insert({
      table: 'revenue_attributions',
      format: 'JSONEachRow',
      values: [
        attribution({
          site_id: site,
          object_id: 'ch1',
          occurred_at: '2026-07-02 12:00:00.000',
          visitor_id: 'G1',
          lt_referrer_domain: 'google.com',
          lt_session_id: 's_g1',
        }),
        attribution({
          site_id: site,
          object_id: 'ch2',
          occurred_at: '2026-07-02 13:00:00.000',
          visitor_id: 'G2',
          lt_referrer_domain: 'google.com',
          lt_session_id: 's_g2',
        }),
        attribution({
          site_id: site,
          object_id: 'ch3',
          occurred_at: '2026-07-05 12:00:00.000',
          visitor_id: 'G1',
          lt_referrer_domain: 'google.com',
          lt_session_id: 's_g1_again',
          lt_session_start: '2026-07-05 09:00:00.000',
        }),
        attribution({
          site_id: site,
          object_id: 'ch4',
          occurred_at: '2026-07-03 12:00:00.000',
          visitor_id: 'G3',
          lt_referrer_domain: 'google.com',
          lt_session_id: 's_g3',
        }),
        attribution({
          site_id: site,
          object_id: 'ch5',
          occurred_at: '2026-07-04 12:00:00.000',
          visitor_id: 'G2',
          lt_referrer_domain: 'google.com',
          lt_session_id: 's_g2',
        }),
        attribution({
          site_id: site,
          object_id: 'ch6',
          occurred_at: '2026-07-04 13:00:00.000',
          visitor_id: 'G4',
          lt_referrer_domain: 'google.com',
          lt_session_id: 's_g4',
        }),
        attribution({
          site_id: site,
          object_id: 'ch7',
          occurred_at: '2026-07-02 08:00:00.000',
          visitor_id: 'B_OLD',
          lt_referrer_domain: 'twitter.com',
          lt_session_id: 's_old',
          lt_session_start: '2026-06-28 09:00:00.000',
        }),
        // Version 1 said Bing; version 2 says Google and must win before any merge.
        attribution({
          site_id: site,
          object_id: 'ch9',
          occurred_at: '2026-07-02 14:00:00.000',
          visitor_id: 'V1',
          lt_referrer_domain: 'bing.com',
          lt_session_id: 's_v',
        }),
        attribution({
          site_id: site,
          object_id: 'ch9',
          version: 2,
          occurred_at: '2026-07-02 14:00:00.000',
          visitor_id: 'V1',
          lt_referrer_domain: 'google.com',
          lt_session_id: 's_v',
        }),
        // Last touch is a retracted session: no country, no device.
        attribution({
          site_id: site,
          object_id: 'ch10',
          occurred_at: '2026-07-02 15:00:00.000',
          visitor_id: 'X1',
          lt_referrer_domain: 'google.com',
          lt_session_id: 's_x',
        }),
        attribution({
          site_id: site,
          object_id: 'ch13',
          occurred_at: '2026-07-03 15:00:00.000',
          visitor_id: 'G3',
          lt_referrer_domain: 'google.com',
          lt_session_id: 's_old_g3',
          lt_session_start: '2026-06-29 09:00:00.000',
        }),
        attribution({
          site_id: site,
          object_id: 'ch11',
          occurred_at: '2026-07-03 12:00:00.000',
          visitor_id: 'M1',
          lt_referrer_domain: 'google.com',
          lt_session_id: 's_missing',
        }),
        attribution({
          site_id: otherSite,
          object_id: 'ch_other',
          occurred_at: '2026-07-02 12:00:00.000',
          visitor_id: 'G1',
          lt_referrer_domain: 'google.com',
          lt_session_id: 's_other',
        }),
      ],
    })

    await client.insert({
      table: 'subscription_invoices',
      format: 'JSONEachRow',
      values: [
        {
          site_id: site,
          provider: 'stripe',
          invoice_id: 'in_5',
          generation: 1,
          subscription_id: 'sub_1',
          billing_reason: 'subscription_cycle',
          purchase_kind: 'renewal',
          order_id: '',
          charge_id: 'ch5',
          occurred_at: '2026-07-04 12:00:00.000',
          ingested_at: '2026-07-10 00:00:00.000',
        },
      ],
    })
  }, 120_000)

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await client.close()
    }
  })

  const segmentKey = (row: Record<string, unknown>) =>
    `${String(row['source'])}|${String(row['country'])}|${String(row['device'])}`

  it('totals the site and counts the hidden segments', async () => {
    const rows = await run('analytics.revenue_segment_totals', {
      site_id: site,
      from: FROM,
      to: TO,
    })
    expect(rows).toHaveLength(1)
    const row = rows[0] ?? {}
    // G1–G25, V1, D1–D3, P1–P20. X1 is retracted and B_OLD's visit was before the range.
    expect(Number(row['visitors'])).toBe(49)
    // G1, G2, G3 (unconverted), V1. Not G4 (failed), not the renewal, and not
    // B_OLD, X1 or M1, whose last visit is not a visit of the range.
    expect(Number(row['buyers'])).toBe(4)
    // ch1, ch2, ch3, ch4, ch9.
    expect(Number(row['orders'])).toBe(5)
    expect(Number(row['revenue_minor'])).toBe(1000 + 2000 + 500 + 300)
    expect(Number(row['unconverted_orders'])).toBe(1)
    // google/DE/desktop, direct/PL/desktop shown; direct/US/mobile hidden.
    // No bing/FR row, and no row for a purchase whose last visit is left out.
    expect(Number(row['segments'])).toBe(3)
    expect(Number(row['hidden_segments'])).toBe(1)
  })

  it('leaves out a buyer whose last visit was before the range, and counts them', async () => {
    const [row = {}] = await run('analytics.revenue_segment_totals', {
      site_id: site,
      from: FROM,
      to: TO,
    })
    // B_OLD bought in the range (ch7, 700) after a visit on 28 June: not a
    // visitor of the range, so not a buyer of it either, and the site rate
    // stays buyers over visitors of the same population.
    expect(Number(row['buyers_last_visit_before_range'])).toBe(1)
    expect(Number(row['buyers']) / Number(row['visitors'])).toBe(4 / 49)
    expect(Number(row['revenue_minor'])).not.toBeGreaterThan(3800)
    const segments = await run('analytics.revenue_segments', {
      site_id: site,
      from: FROM,
      to: TO,
      prior_value_minor: 0,
      limit: 50,
    })
    expect(segments.map(segmentKey)).not.toContain('twitter.com|GB|tablet')
  })

  it('leaves out a purchase whose last-touch session is retracted or missing, and counts it', async () => {
    const [row = {}] = await run('analytics.revenue_segment_totals', {
      site_id: site,
      from: FROM,
      to: TO,
    })
    // X1's last touch (s_x) is retracted; M1's (s_missing) was never recorded.
    expect(Number(row['buyers_last_visit_missing'])).toBe(2)
  })

  it('counts a buyer in one place: a visit in the range wins over an older one', async () => {
    // G3 bought once after a visit in the range (ch4) and once after one
    // before it (ch13): a buyer, and not also a buyer left out. The three
    // counts add up to every attributed buyer: G1, G2, G3, V1, B_OLD, X1, M1.
    const [row = {}] = await run('analytics.revenue_segment_totals', {
      site_id: site,
      from: FROM,
      to: TO,
    })
    expect(
      Number(row['buyers']) +
        Number(row['buyers_last_visit_before_range']) +
        Number(row['buyers_last_visit_missing']),
    ).toBe(7)
  })

  it('returns the shown segments with their counts, ranked', async () => {
    const rows = await run('analytics.revenue_segments', {
      site_id: site,
      from: FROM,
      to: TO,
      prior_value_minor: 100,
      limit: 50,
    })
    expect(rows.map(segmentKey)).toEqual(['google.com|DE|desktop', '|PL|desktop'])
    const google = rows[0] ?? {}
    expect(Number(google['visitors'])).toBe(26)
    expect(Number(google['buyers'])).toBe(4)
    expect(Number(google['orders'])).toBe(5)
    expect(Number(google['revenue_minor'])).toBe(3800)
    expect(Number(google['unconverted_orders'])).toBe(1)
    const direct = rows[1] ?? {}
    expect(Number(direct['visitors'])).toBe(20)
    expect(Number(direct['buyers'])).toBe(0)
    expect(Number(direct['revenue_minor'])).toBe(0)
  })

  it('ranks before the limit cuts', async () => {
    const top = await run('analytics.revenue_segments', {
      site_id: site,
      from: FROM,
      to: TO,
      prior_value_minor: 100,
      limit: 1,
    })
    expect(top.map(segmentKey)).toEqual(['google.com|DE|desktop'])
  })

  it('ranks by the smoothed value, not by visitors or revenue', async () => {
    // With a site value of 1,000,000 per visitor the prior dominates, and the
    // smaller segment is pulled up further: google (3,800 + 200 × 1e6) / 226
    // ≈ 884,973 against Direct/PL (0 + 200 × 1e6) / 220 ≈ 909,091. An order
    // by visitors or by revenue would put google first.
    const top = await run('analytics.revenue_segments', {
      site_id: site,
      from: FROM,
      to: TO,
      prior_value_minor: 1_000_000,
      limit: 1,
    })
    expect(top.map(segmentKey)).toEqual(['|PL|desktop'])
  })

  it('keeps one site out of another', async () => {
    const rows = await run('analytics.revenue_segment_totals', {
      site_id: otherSite,
      from: FROM,
      to: TO,
    })
    expect(Number(rows[0]?.['visitors'])).toBe(1)
    expect(Number(rows[0]?.['buyers'])).toBe(1)
    expect(Number(rows[0]?.['revenue_minor'])).toBe(7777)
  })
})
