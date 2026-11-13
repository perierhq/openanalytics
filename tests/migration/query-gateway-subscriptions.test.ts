import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import {
  createSubscriptionLifecycleStore,
  migrateClickHouse,
  type RevenueEventRow,
  type SubscriptionInvoiceRow,
  type SubscriptionLifecycleRow,
} from '@openanalytics/clickhouse'
import { planCurrencyConversion, type RevenueSubscriptionSnapshot } from '@openanalytics/domain'
import type { RevenueSubscriptionHeadRow } from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { operationParamsFor } from '../../apps/api/src/analytics/resolve.ts'
import { createHttpClickHouseReader } from '../../apps/query-gateway/src/clickhouse-http.ts'
import type { QueryParameterValue } from '../../apps/query-gateway/src/clickhouse.ts'
import { findOperation } from '../../apps/query-gateway/src/operations.ts'
import { buildSubscriptionLifecycleRows } from '../../apps/worker/src/revenue/project-lifecycle.ts'

/**
 * The subscription reads of the query gateway (Perier gap 7) against a real
 * ClickHouse built from the migrations: lifecycle totals, the local-day
 * timeseries, purchase kinds, and `purchase_kind` on the transactions list.
 *
 * The facts are planned by the worker's own builder from BetterBahn-shaped
 * subscriptions (Pro monthly €6.99, Pro yearly €39.99, a trial), so the SQL is
 * checked against what the projection really writes.
 */

const URL_ = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''
const describeIfClickHouse = URL_ ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

const SITE = randomUUID()
const KEY = { secret: 'k'.repeat(32), keyVersion: 1 }
const EUR = planCurrencyConversion({
  fromCurrency: 'EUR',
  toCurrency: 'EUR',
  fromRate: null,
  toRate: null,
})

const MONTHLY = {
  price_id: 'price_monthly',
  product_id: 'prod_pro',
  unit_amount_minor: 699,
  quantity: 1,
  interval: 'month' as const,
  interval_count: 1,
}
const YEARLY = {
  ...MONTHLY,
  price_id: 'price_yearly',
  unit_amount_minor: 3999,
  interval: 'year' as const,
}

function head(
  subscriptionId: string,
  version: number,
  overrides: Partial<RevenueSubscriptionSnapshot>,
): RevenueSubscriptionHeadRow {
  return {
    id: subscriptionId,
    siteId: SITE,
    provider: 'stripe',
    subscriptionId,
    snapshotAt: new Date('2026-04-25T00:00:00.000Z'),
    payloadHash: 'h',
    version,
    firstSeenAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date(`2026-04-25T00:00:0${version}.000Z`),
    projectedVersion: 0,
    normalized: {
      status: 'active',
      livemode: true,
      customer_id: `cus_${subscriptionId}`,
      currency: 'eur',
      items: [MONTHLY],
      created_at: '2026-03-01T09:00:00.000Z',
      started_at: '2026-03-01T09:00:00.000Z',
      trial_start: null,
      trial_end: null,
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      ended_at: null,
      ...overrides,
    },
  }
}

const rowsFor = (h: RevenueSubscriptionHeadRow): SubscriptionLifecycleRow[] =>
  buildSubscriptionLifecycleRows({
    head: h,
    changes: [],
    reportingCurrency: 'EUR',
    conversion: EUR,
    identityKey: KEY,
  })

function charge(overrides: Partial<RevenueEventRow>): RevenueEventRow {
  return {
    site_id: SITE,
    provider: 'stripe',
    object_id: 'ch_1',
    object_kind: 'charge',
    version: 1,
    occurred_at: '2026-04-15 09:00:00.000',
    status: 'succeeded',
    livemode: 1,
    currency: 'eur',
    gross_minor: 699,
    fee_minor: 0,
    fee_currency: '',
    net_minor: 699,
    reporting_currency: 'eur',
    reporting_gross_minor: 699,
    reporting_net_minor: 699,
    conversion_source: 'none',
    conversion_rate: 1,
    conversion_rate_date: '1970-01-01',
    parent_object_id: '',
    order_id: 'pi_1',
    checkout_session_id: '',
    client_reference_id: '',
    subscription_id: '',
    product_id: '',
    product_name: '',
    customer_hash: '',
    external_user_hash: '',
    ingested_via: 'webhook',
    ingested_at: '2026-04-25 00:00:00.000',
    ...overrides,
  }
}

function invoice(overrides: Partial<SubscriptionInvoiceRow>): SubscriptionInvoiceRow {
  return {
    site_id: SITE,
    provider: 'stripe',
    invoice_id: 'in_1',
    generation: 1,
    subscription_id: 'sub_1',
    billing_reason: 'subscription_create',
    purchase_kind: 'new',
    order_id: '',
    charge_id: '',
    occurred_at: '2026-04-15 09:00:05.000',
    ingested_at: '2026-04-25 00:00:00.000',
    ...overrides,
  }
}

describeIfClickHouse('query gateway — subscription lifecycle reads (ClickHouse 0031)', () => {
  const url = URL_ as string
  const database = `sublcgw_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>
  const reader = createHttpClickHouseReader({
    url,
    database,
    username: USERNAME,
    password: PASSWORD,
  })

  const run = async (operationId: string, input: Record<string, unknown>) => {
    const operation = findOperation(operationId)
    if (!operation) throw new Error(`no such operation ${operationId}`)
    const defaults = operationParamsFor(
      operationId,
      null,
      (input['timezone'] as string | undefined) ?? 'UTC',
    )
    const parameters = operation.bindParams({ site_id: SITE, ...defaults, ...input }) as Record<
      string,
      QueryParameterValue
    >
    const result = await reader.query({
      sql: operation.sql,
      parameters,
      signal: new AbortController().signal,
      queryId: randomUUID(),
      settings: { max_execution_time: 20, max_result_rows: 10_000, result_overflow_mode: 'throw' },
    })
    return [...result.rows] as Record<string, unknown>[]
  }

  const APRIL = { from: '2026-04-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' }

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
    client = createClient({ url, username: USERNAME, password: PASSWORD, database })
    const store = createSubscriptionLifecycleStore({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
    })

    // A stale first generation of sub_m with a plan change it no longer has:
    // it must not count.
    const stale = rowsFor(head('sub_m', 1, { items: [YEARLY] })).concat([
      {
        ...rowsFor(head('sub_m', 1, {}))[0]!,
        seq: 1,
        kind: 'plan_changed',
        occurred_at: '2026-04-10 00:00:00.000',
        mrr_delta_minor: 5000,
        reporting_mrr_delta_minor: 5000,
        active_delta: 0,
      },
    ])
    await store.insertLifecycleRows(stale)
    await store.insertLifecycleRows([
      // Monthly since March, still paying.
      ...rowsFor(head('sub_m', 2, {})),
      // Yearly since 10 March, cancellation scheduled 5 April, ended 20 April.
      ...rowsFor(
        head('sub_y', 1, {
          items: [YEARLY],
          created_at: '2026-03-10T09:00:00.000Z',
          started_at: '2026-03-10T09:00:00.000Z',
          status: 'canceled',
          canceled_at: '2026-04-05T12:00:00.000Z',
          ended_at: '2026-04-20T12:00:00.000Z',
        }),
      ),
      // A trial from 2 April that converted on 15 April (23:30 UTC, which is
      // 16 April in Berlin).
      ...rowsFor(
        head('sub_t', 1, {
          created_at: '2026-04-02T10:00:00.000Z',
          started_at: '2026-04-02T10:00:00.000Z',
          trial_start: '2026-04-02T10:00:00.000Z',
          trial_end: '2026-04-15T23:30:00.000Z',
        }),
      ),
    ])

    await client.insert({
      table: 'revenue_events',
      format: 'JSONEachRow',
      values: [
        charge({ object_id: 'ch_new', order_id: 'pi_new', occurred_at: '2026-04-15 23:30:00.000' }),
        charge({
          object_id: 'ch_renew',
          order_id: 'pi_renew',
          occurred_at: '2026-04-01 09:00:00.000',
        }),
        charge({
          object_id: 'ch_trip',
          order_id: 'pi_trip',
          gross_minor: 399,
          net_minor: 399,
          reporting_gross_minor: 399,
          reporting_net_minor: 399,
          occurred_at: '2026-04-12 09:00:00.000',
        }),
        charge({
          object_id: 're_1',
          object_kind: 'refund',
          parent_object_id: 'ch_trip',
          order_id: 'pi_trip',
          gross_minor: 399,
          reporting_gross_minor: 399,
          occurred_at: '2026-04-13 09:00:00.000',
        }),
      ],
    })
    await store.insertInvoiceRows([
      invoice({ invoice_id: 'in_new', order_id: 'pi_new', occurred_at: '2026-04-15 23:30:05.000' }),
      // A renewal that only names its charge (pre-basil invoice with no PI).
      invoice({
        invoice_id: 'in_renew',
        billing_reason: 'subscription_cycle',
        purchase_kind: 'renewal',
        charge_id: 'ch_renew',
        occurred_at: '2026-04-01 09:00:05.000',
      }),
      // The Trip Pass: a manual invoice with no subscription.
      invoice({
        invoice_id: 'in_trip',
        subscription_id: '',
        billing_reason: 'manual',
        purchase_kind: 'one_off',
        order_id: 'pi_trip',
        occurred_at: '2026-04-12 09:00:05.000',
      }),
    ])
    // A later generation of in_new that still has no billing reason would be
    // ignored by the map, so a charge with only an unknown invoice reads one_off.
    await store.close()
  }, 180_000)

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database}` })
    await client?.close()
  })

  it('totals MRR at both ends of April and the movements inside it', async () => {
    const [row] = await run('analytics.subscription_lifecycle_totals', APRIL)
    expect(row).toMatchObject({
      mrr_start_minor: 699 + 333,
      mrr_end_minor: 699 + 699,
      active_start: 2,
      active_end: 2,
      trialing_start: 0,
      trialing_end: 0,
      new_mrr_minor: 699,
      expansion_mrr_minor: 0,
      contraction_mrr_minor: 0,
      churned_mrr_minor: 333,
      new_subscriptions: 1,
      churned_subscriptions: 1,
      trials_started: 1,
      trials_converted: 1,
      trials_expired: 0,
      cancels_scheduled: 1,
      cancels_undone: 0,
      unconverted_subscriptions: 0,
    })
  })

  it('reads a mid-trial range as trialing, not active', async () => {
    const [row] = await run('analytics.subscription_lifecycle_totals', {
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-10T00:00:00.000Z',
    })
    expect(row).toMatchObject({ trialing_end: 1, active_end: 2, mrr_end_minor: 699 + 333 })
  })

  it('buckets movements by site-local day', async () => {
    const rows = await run('analytics.subscription_timeseries_day', {
      ...APRIL,
      timezone: 'Europe/Berlin',
    })
    const byDay = Object.fromEntries(rows.map((r) => [String(r['bucket']), r] as const))
    // Local midnight of 16 April in Berlin, rendered as UTC.
    expect(Object.keys(byDay)).toEqual([
      '2026-04-01 22:00:00.000',
      '2026-04-04 22:00:00.000',
      '2026-04-15 22:00:00.000',
      '2026-04-19 22:00:00.000',
    ])
    expect(byDay['2026-04-15 22:00:00.000']).toMatchObject({
      new_mrr_minor: 699,
      net_mrr_minor: 699,
      active_delta: 1,
      trial_delta: -1,
      trials_converted: 1,
    })
    expect(byDay['2026-04-19 22:00:00.000']).toMatchObject({
      churned_mrr_minor: 333,
      net_mrr_minor: -333,
      active_delta: -1,
    })
  })

  it('splits April’s charges into new, renewal and one-off', async () => {
    const rows = await run('analytics.revenue_purchase_kinds', APRIL)
    expect(rows).toEqual([
      { purchase_kind: 'new', charges: 1, reporting_gross_minor: 699, unconverted_count: 0 },
      { purchase_kind: 'one_off', charges: 1, reporting_gross_minor: 399, unconverted_count: 0 },
      { purchase_kind: 'renewal', charges: 1, reporting_gross_minor: 699, unconverted_count: 0 },
    ])
  })

  it('labels each transaction with its purchase kind', async () => {
    const rows = await run('analytics.revenue_transactions', {
      ...APRIL,
      cursor_occurred_at: APRIL.to,
      cursor_object_id: '',
      limit: 10,
    })
    expect(Object.fromEntries(rows.map((r) => [r['object_id'], r['purchase_kind']]))).toEqual({
      ch_new: 'new',
      ch_renew: 'renewal',
      ch_trip: 'one_off',
      re_1: '',
    })
  })
})
