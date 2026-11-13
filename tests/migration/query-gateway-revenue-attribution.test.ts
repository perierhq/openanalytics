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
 * Revenue by source / entry page and the events before a purchase, against a
 * live, migrated ClickHouse (Perier fork, DataFast gaps 3 and 4).
 *
 * What only a real server can answer:
 *
 *   1. **The breakdown reads current truth.** A re-versioned attribution moves
 *      its charge to the new source under the argMax read, before any merge.
 *   2. **Unattributed charges are one NULL row, ordered first**, whether the
 *      attribution row says `none` or does not exist yet; failed charges and
 *      refunds are not orders; an unconverted charge is an order with no
 *      revenue.
 *   3. **The visitors denominator is the session entry** with retraction
 *      applied after the version selection, and a dimension value carrying a
 *      quote and a backslash survives the array parameter.
 *   4. **Events before purchase** count a buyer's pre-sign-in event through the
 *      identify linkage, stop at the first charge, ignore what is outside the
 *      window, and baseline non-buyers inside the range only.
 *   5. Cross-site isolation.
 *   6. **Renewals and plan changes are revenue, not conversions** (gap 7's
 *      purchase-kind join, by charge id and by PaymentIntent): they stay in
 *      `revenue_minor` and show in `recurring_revenue_minor`, but are not
 *      orders or buyers; a buyer's purchase instant is their first new or
 *      one-off charge even when a renewal came earlier; and a customer who
 *      only renewed is neither a buyer nor in the non-buyer baseline.
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
const ODD_REFERRER = "x'y\\z.com"

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
    identity_scope: 'identified',
    journey: '[]',
    computed_at: '2026-07-10 00:00:00.000',
    ...over,
  }
}

describeIfClickHouse('revenue attribution and events-before-purchase operations', () => {
  const url = URL_ as string
  const database = `ra_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
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

    await client.insert({
      table: 'revenue_events',
      format: 'JSONEachRow',
      values: [
        charge({
          site_id: site,
          object_id: 'ch_a',
          occurred_at: '2026-07-03 12:00:00.000',
          gross_minor: 1000,
        }),
        charge({
          site_id: site,
          object_id: 'ch_b',
          occurred_at: '2026-07-05 12:00:00.000',
          gross_minor: 500,
        }),
        charge({
          site_id: site,
          object_id: 'ch_c',
          occurred_at: '2026-07-04 09:00:00.000',
          gross_minor: 2000,
        }),
        charge({
          site_id: site,
          object_id: 'ch_d',
          occurred_at: '2026-07-02 09:00:00.000',
          gross_minor: 300,
        }),
        charge({
          site_id: site,
          object_id: 'ch_e',
          occurred_at: '2026-07-02 10:00:00.000',
          gross_minor: 700,
        }),
        charge({
          site_id: site,
          object_id: 'ch_f',
          occurred_at: '2026-07-02 11:00:00.000',
          gross_minor: 9999,
          status: 'failed',
        }),
        charge({
          site_id: site,
          object_id: 'ch_g',
          occurred_at: '2026-07-06 11:00:00.000',
          currency: 'xyz',
          gross_minor: 4200,
          reporting_gross_minor: 0,
          conversion_source: 'unavailable',
        }),
        charge({
          site_id: site,
          object_id: 're_a',
          object_kind: 'refund',
          parent_object_id: 'ch_a',
          occurred_at: '2026-07-06 12:00:00.000',
          gross_minor: 1000,
        }),
        // Gap 7: A2 renewed an older subscription before buying ch_c, by
        // PaymentIntent join; R1 only changed plan (by charge id).
        charge({
          site_id: site,
          object_id: 'ch_i',
          order_id: 'pi_i',
          occurred_at: '2026-07-04 07:00:00.000',
          gross_minor: 100,
        }),
        charge({
          site_id: site,
          object_id: 'ch_h',
          occurred_at: '2026-07-03 15:00:00.000',
          gross_minor: 250,
        }),
        // Outside the range.
        charge({
          site_id: site,
          object_id: 'ch_old',
          occurred_at: '2026-06-20 12:00:00.000',
          gross_minor: 8888,
        }),
        charge({
          site_id: otherSite,
          object_id: 'ch_x',
          occurred_at: '2026-07-03 12:00:00.000',
          gross_minor: 7777,
        }),
      ],
    })

    await client.insert({
      table: 'revenue_attributions',
      format: 'JSONEachRow',
      values: [
        // Version 1 said bing; version 2 says google and must win before any merge.
        attribution({
          site_id: site,
          object_id: 'ch_a',
          occurred_at: '2026-07-03 12:00:00.000',
          visitor_id: 'U1',
          user_id: 'U1',
          ft_referrer_domain: 'bing.com',
          lt_referrer_domain: 'bing.com',
        }),
        attribution({
          site_id: site,
          object_id: 'ch_a',
          version: 2,
          occurred_at: '2026-07-03 12:00:00.000',
          visitor_id: 'U1',
          user_id: 'U1',
          ft_referrer_domain: 'google.com',
          ft_utm_campaign: 'summer',
          ft_entry_page: '/pricing',
          lt_referrer_domain: '',
          lt_entry_page: '/discount',
        }),
        attribution({
          site_id: site,
          object_id: 'ch_b',
          occurred_at: '2026-07-05 12:00:00.000',
          visitor_id: 'U1',
          user_id: 'U1',
          ft_referrer_domain: 'google.com',
          ft_entry_page: '/pricing',
          lt_referrer_domain: '',
          lt_entry_page: '/discount',
        }),
        attribution({
          site_id: site,
          object_id: 'ch_c',
          occurred_at: '2026-07-04 09:00:00.000',
          visitor_id: 'A2',
          identity_scope: 'anonymous_day',
          ft_referrer_domain: 'google.com',
          ft_entry_page: '/',
          lt_referrer_domain: 'google.com',
          lt_entry_page: '/',
        }),
        // Unmatched: a row exists, it says none.
        attribution({
          site_id: site,
          object_id: 'ch_d',
          occurred_at: '2026-07-02 09:00:00.000',
          matched_via: 'none',
          confidence: 'none',
          identity_scope: '',
        }),
        // ch_e has no attribution row at all.
        attribution({
          site_id: site,
          object_id: 'ch_f',
          occurred_at: '2026-07-02 11:00:00.000',
          visitor_id: 'U1',
          ft_referrer_domain: 'google.com',
        }),
        attribution({
          site_id: site,
          object_id: 'ch_g',
          occurred_at: '2026-07-06 11:00:00.000',
          visitor_id: 'A3',
          ft_referrer_domain: ODD_REFERRER,
          lt_referrer_domain: ODD_REFERRER,
        }),
        attribution({
          site_id: site,
          object_id: 'ch_i',
          occurred_at: '2026-07-04 07:00:00.000',
          visitor_id: 'A2',
          identity_scope: 'anonymous_day',
          ft_referrer_domain: 'google.com',
          ft_entry_page: '/',
          lt_referrer_domain: 'google.com',
          lt_entry_page: '/',
        }),
        attribution({
          site_id: site,
          object_id: 'ch_h',
          occurred_at: '2026-07-03 15:00:00.000',
          visitor_id: 'R1',
          identity_scope: 'anonymous_day',
          ft_referrer_domain: 'google.com',
          lt_referrer_domain: 'google.com',
        }),
        attribution({
          site_id: otherSite,
          object_id: 'ch_x',
          occurred_at: '2026-07-03 12:00:00.000',
          visitor_id: 'U1',
          ft_referrer_domain: 'google.com',
        }),
      ],
    })

    // Gap 7's purchase kinds (ClickHouse 0031). ch_b is U1's renewal, joined
    // by charge id; ch_i is A2's renewal, joined by PaymentIntent; ch_h is a
    // plan change. ch_a's invoice says new. The other site's ch_x is labelled
    // a renewal on ITS site only, which must not leak.
    const invoice = (over: Record<string, unknown>): Record<string, unknown> => ({
      provider: 'stripe',
      generation: 1,
      subscription_id: 'sub_1',
      billing_reason: 'subscription_cycle',
      purchase_kind: 'renewal',
      order_id: '',
      charge_id: '',
      ingested_at: '2026-07-10 00:00:00.000',
      ...over,
    })
    await client.insert({
      table: 'subscription_invoices',
      format: 'JSONEachRow',
      values: [
        invoice({
          site_id: site,
          invoice_id: 'in_a',
          billing_reason: 'subscription_create',
          purchase_kind: 'new',
          charge_id: 'ch_a',
          occurred_at: '2026-07-03 12:00:00.000',
        }),
        invoice({
          site_id: site,
          invoice_id: 'in_b',
          charge_id: 'ch_b',
          occurred_at: '2026-07-05 12:00:00.000',
        }),
        invoice({
          site_id: site,
          invoice_id: 'in_i',
          subscription_id: 'sub_2',
          order_id: 'pi_i',
          occurred_at: '2026-07-04 07:00:00.000',
        }),
        invoice({
          site_id: site,
          invoice_id: 'in_h',
          subscription_id: 'sub_3',
          billing_reason: 'subscription_update',
          purchase_kind: 'plan_change',
          charge_id: 'ch_h',
          occurred_at: '2026-07-03 15:00:00.000',
        }),
        invoice({
          site_id: otherSite,
          invoice_id: 'in_x',
          charge_id: 'ch_c',
          occurred_at: '2026-07-04 09:00:00.000',
        }),
      ],
    })

    const fact = (over: Record<string, unknown>): Record<string, unknown> => ({
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
      ...over,
    })
    await client.insert({
      table: 'session_facts_versions',
      format: 'JSONEachRow',
      values: [
        fact({
          site_id: site,
          session_id: 's1',
          visitor_id: 'U1',
          session_start: '2026-07-03 09:00:00.000',
          referrer_domain: 'google.com',
          entry_page_path: '/pricing',
        }),
        fact({
          site_id: site,
          session_id: 's1b',
          visitor_id: 'U1',
          session_start: '2026-07-04 09:00:00.000',
          referrer_domain: 'google.com',
          entry_page_path: '/pricing',
        }),
        fact({
          site_id: site,
          session_id: 's2',
          visitor_id: 'A2',
          session_start: '2026-07-04 08:00:00.000',
          referrer_domain: 'google.com',
        }),
        fact({
          site_id: site,
          session_id: 's3',
          visitor_id: 'V9',
          session_start: '2026-07-02 09:00:00.000',
          referrer_domain: 'google.com',
        }),
        // Retracted by its latest version: must not count.
        fact({
          site_id: site,
          session_id: 's4',
          visitor_id: 'V10',
          session_start: '2026-07-02 09:00:00.000',
          referrer_domain: 'google.com',
        }),
        fact({
          site_id: site,
          session_id: 's4',
          version: 2,
          retracted: 1,
          visitor_id: 'V10',
          session_start: '2026-07-02 09:00:00.000',
          referrer_domain: 'google.com',
        }),
        fact({
          site_id: site,
          session_id: 's5',
          visitor_id: 'A3',
          session_start: '2026-07-06 09:00:00.000',
          referrer_domain: ODD_REFERRER,
        }),
        // Outside the range.
        fact({
          site_id: site,
          session_id: 's6',
          visitor_id: 'V12',
          session_start: '2026-06-20 09:00:00.000',
          referrer_domain: 'google.com',
        }),
        fact({
          site_id: otherSite,
          session_id: 'sx',
          visitor_id: 'VX',
          session_start: '2026-07-02 09:00:00.000',
          referrer_domain: 'google.com',
        }),
      ],
    })

    const raw = (over: Record<string, unknown>): Record<string, unknown> => ({
      schema_version: 1,
      event_id: randomUUID(),
      batch_id: 'b',
      type: 'custom_event',
      name: '',
      billable: 1,
      anonymous_id: '',
      user_id: '',
      properties: '{}',
      ...over,
    })
    await client.insert({
      table: 'events_raw',
      format: 'JSONEachRow',
      values: [
        // U1 before sign-in, on anonymous id AN1, then identify pairs AN1 with U1.
        raw({
          site_id: site,
          anonymous_id: 'AN1',
          name: 'paywall_viewed',
          occurred_at: '2026-07-03 10:00:00.000',
        }),
        raw({
          site_id: site,
          anonymous_id: 'AN1',
          user_id: 'U1',
          type: 'identify',
          occurred_at: '2026-07-03 10:30:00.000',
        }),
        raw({
          site_id: site,
          anonymous_id: 'AN1',
          user_id: 'U1',
          name: 'price_alert_created',
          occurred_at: '2026-07-03 11:00:00.000',
        }),
        // After the first charge: not "before purchase".
        raw({
          site_id: site,
          anonymous_id: 'AN1',
          user_id: 'U1',
          name: 'ben_chat',
          occurred_at: '2026-07-03 13:00:00.000',
        }),
        // Outside the 7-day window before the first charge.
        raw({
          site_id: site,
          anonymous_id: 'AN0',
          user_id: 'U1',
          name: 'split_found',
          occurred_at: '2026-06-25 10:00:00.000',
        }),
        raw({
          site_id: site,
          anonymous_id: 'A2',
          name: 'paywall_viewed',
          occurred_at: '2026-07-04 08:00:00.000',
        }),
        raw({
          site_id: site,
          anonymous_id: 'A2',
          name: 'paywall_viewed',
          occurred_at: '2026-07-04 08:10:00.000',
        }),
        // Non-buyers: V9 inside the range, V11 before it.
        raw({
          site_id: site,
          anonymous_id: 'V9',
          name: 'paywall_viewed',
          occurred_at: '2026-07-02 09:01:00.000',
        }),
        raw({
          site_id: site,
          anonymous_id: 'V9',
          name: 'ben_chat',
          occurred_at: '2026-07-02 09:02:00.000',
        }),
        raw({
          site_id: site,
          anonymous_id: 'V9',
          type: 'page_view',
          occurred_at: '2026-07-02 09:00:00.000',
        }),
        // R1 only changed plan: a payer, so neither a buyer nor a non-buyer.
        raw({
          site_id: site,
          anonymous_id: 'R1',
          name: 'paywall_viewed',
          occurred_at: '2026-07-03 14:00:00.000',
        }),
        raw({
          site_id: site,
          anonymous_id: 'R1',
          name: 'plan_compared',
          occurred_at: '2026-07-03 14:30:00.000',
        }),
        raw({
          site_id: site,
          anonymous_id: 'V11',
          name: 'paywall_viewed',
          occurred_at: '2026-06-30 09:00:00.000',
        }),
        raw({
          site_id: otherSite,
          anonymous_id: 'VX',
          name: 'paywall_viewed',
          occurred_at: '2026-07-02 09:00:00.000',
        }),
      ],
    })
  }, 120_000)

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await client.close()
    }
  })

  it('groups converted charges by first-touch referrer, unattributed first', async () => {
    const rows = await run('analytics.revenue_attribution_first_referrer_domain', {
      site_id: site,
      from: FROM,
      to: TO,
      limit: 10,
    })
    // UInt64 arrives as a number or a string depending on the server's JSON
    // settings, so every measure is compared as a number.
    expect(
      rows.map((r) => [
        r['value'],
        Number(r['revenue_minor']),
        Number(r['recurring_revenue_minor']),
        Number(r['orders']),
        Number(r['unconverted_orders']),
        Number(r['buyers']),
      ]),
    ).toEqual([
      [null, 1000, 0, 2, 0, 0],
      // ch_a (new) and ch_c (no invoice: one-off) are the orders, U1 and A2
      // the buyers. ch_b and ch_i (renewals) and ch_h (plan change) are 850
      // of the 3850 revenue, and R1, who only changed plan, is not a buyer.
      ['google.com', 3850, 850, 2, 0, 2],
      [ODD_REFERRER, 0, 0, 1, 1, 1],
    ])
  })

  it('reads the last touch and other dimensions from their own columns', async () => {
    const last = await run('analytics.revenue_attribution_last_entry_page', {
      site_id: site,
      from: FROM,
      to: TO,
    })
    expect(last.map((r) => [r['value'], Number(r['revenue_minor'])])).toEqual([
      [null, 1000],
      ['/', 2100],
      ['/discount', 1500],
      ['', 250],
    ])
    const campaign = await run('analytics.revenue_attribution_first_utm_campaign', {
      site_id: site,
      from: FROM,
      to: TO,
    })
    expect(campaign.map((r) => [r['value'], Number(r['revenue_minor'])])).toEqual([
      [null, 1000],
      ['', 2850],
      ['summer', 1000],
    ])
  })

  it('counts visitors per session entry value, retraction after the version, odd values intact', async () => {
    const rows = await run('analytics.revenue_attribution_visitors_referrer_domain', {
      site_id: site,
      from: FROM,
      to: TO,
      values: ['google.com', ODD_REFERRER, 'nobody.example'],
    })
    const byValue = new Map(rows.map((r) => [r['value'], Number(r['visitors'])]))
    expect(byValue).toEqual(
      new Map<unknown, number>([
        ['google.com', 3],
        [ODD_REFERRER, 1],
      ]),
    )
    const pages = await run('analytics.revenue_attribution_visitors_entry_page', {
      site_id: site,
      from: FROM,
      to: TO,
      values: ['/pricing'],
    })
    expect(pages.map((r) => [r['value'], Number(r['visitors'])])).toEqual([['/pricing', 1]])
  })

  it('counts the custom events in a bounded window before each buyer’s first charge', async () => {
    const rows = await run('analytics.revenue_events_before_purchase', {
      site_id: site,
      from: FROM,
      to: TO,
      window_ms: 7 * 86_400_000,
    })
    expect(
      rows.map((r) => [
        r['event_name'],
        Number(r['buyers']),
        Number(r['events']),
        Number(r['non_buyer_visitors']),
      ]),
    ).toEqual([
      // U1 through the AN1 linkage, and A2 (twice): A2's 07:00 renewal is not
      // their purchase, ch_c at 09:00 is. R1 (plan change only) is in neither
      // column, so plan_compared has no row at all.
      ['paywall_viewed', 2, 3, 1],
      ['price_alert_created', 1, 1, 0],
      // U1's ben_chat came after the purchase; V9 is the baseline.
      ['ben_chat', 0, 0, 1],
    ])
  })

  it('narrows to the window', async () => {
    const rows = await run('analytics.revenue_events_before_purchase', {
      site_id: site,
      from: FROM,
      to: TO,
      window_ms: 90 * 60_000,
    })
    // 90 minutes before 12:00 reaches 10:30: the 10:00 paywall view drops out.
    const paywall = rows.find((r) => r['event_name'] === 'paywall_viewed')
    expect(Number(paywall?.['buyers'])).toBe(1)
  })

  it('reports the buyer and visitor population', async () => {
    const rows = await run('analytics.revenue_purchase_population', {
      site_id: site,
      from: FROM,
      to: TO,
    })
    expect(rows).toHaveLength(1)
    // U1, A2 and A3 bought; R1 only changed plan, so is a payer, not a buyer.
    expect(Number(rows[0]?.['buyers_total'])).toBe(3)
    expect(Number(rows[0]?.['payers_total'])).toBe(4)
    // AN1, U1, A2, V9 and R1 have events in the range.
    expect(Number(rows[0]?.['visitors_total'])).toBe(5)
  })

  it('refuses a scan wider than 92 days and a window over 30 days', () => {
    const operation = findOperation('analytics.revenue_events_before_purchase')
    expect(() =>
      operation?.bindParams({
        site_id: site,
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-07-01T00:00:00.000Z',
        window_ms: 86_400_000,
      }),
    ).toThrow()
    expect(() =>
      operation?.bindParams({ site_id: site, from: FROM, to: TO, window_ms: 31 * 86_400_000 }),
    ).toThrow()
  })
})
