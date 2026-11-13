import { planCurrencyConversion, type CurrencyConversionPlan } from '@openanalytics/domain'
import type { RevenueInvoiceRow, RevenueSubscriptionHeadRow } from '@openanalytics/postgres'
import { describe, expect, it } from 'vitest'
import {
  buildSubscriptionInvoiceRow,
  buildSubscriptionLifecycleRows,
} from '../../apps/worker/src/revenue/project-lifecycle.ts'

/**
 * The lifecycle projection's row builders (Perier gap 7). Pure, so the
 * properties MRR rests on are checked here without a database: the reporting
 * deltas of an ended subscription sum to exactly zero, a live one's to exactly
 * its converted MRR, and a plan with no facts still writes a row that
 * supersedes an earlier generation.
 */

const KEY = { secret: 'x'.repeat(32), keyVersion: 1 }

function head(overrides: Partial<RevenueSubscriptionHeadRow['normalized']> = {}, version = 3) {
  return {
    id: 'h1',
    siteId: '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77',
    provider: 'stripe',
    subscriptionId: 'sub_1',
    snapshotAt: new Date('2026-06-01T00:00:00.000Z'),
    payloadHash: 'h',
    version,
    firstSeenAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:01.000Z'),
    projectedVersion: 0,
    normalized: {
      status: 'active',
      livemode: true,
      customer_id: 'cus_1',
      currency: 'usd',
      items: [
        {
          price_id: 'price_y',
          product_id: 'prod',
          unit_amount_minor: 3999,
          quantity: 1,
          interval: 'year' as const,
          interval_count: 1,
        },
      ],
      created_at: '2026-03-01T00:00:00.000Z',
      started_at: '2026-03-01T00:00:00.000Z',
      trial_start: null,
      trial_end: null,
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      ended_at: null,
      ...overrides,
    },
  } satisfies RevenueSubscriptionHeadRow
}

/** USD → EUR at an awkward rate, so per-delta rounding would drift. */
const usdToEur: CurrencyConversionPlan = planCurrencyConversion({
  fromCurrency: 'USD',
  toCurrency: 'EUR',
  fromRate: { ratePerEur: '1.0837', rateDate: '2026-05-29' },
  toRate: { ratePerEur: '1', rateDate: '2026-05-29' },
})

const sum = (rows: { reporting_mrr_delta_minor: number }[]) =>
  rows.reduce((total, row) => total + row.reporting_mrr_delta_minor, 0)

describe('buildSubscriptionLifecycleRows', () => {
  it('numbers the facts, stamps the head version and converts the running MRR', () => {
    const rows = buildSubscriptionLifecycleRows({
      head: head(),
      changes: [],
      reportingCurrency: 'EUR',
      conversion: usdToEur,
      identityKey: KEY,
    })
    expect(rows.map((r) => [r.seq, r.kind, r.generation])).toEqual([[0, 'started', 3]])
    expect(rows[0]).toMatchObject({
      mrr_delta_minor: 333,
      currency: 'usd',
      reporting_currency: 'eur',
      billing_interval: 'year',
      active_delta: 1,
      occurred_at: '2026-03-01 00:00:00.000',
      ingested_at: '2026-06-01 00:00:01.000',
    })
    expect(rows[0]?.customer_hash).toMatch(/^[0-9a-f]+$/u)
    expect(rows[0]?.reporting_mrr_delta_minor).toBe(307) // 333 / 1.0837
  })

  it('sums an ended subscription to exactly zero in both currencies', () => {
    const rows = buildSubscriptionLifecycleRows({
      head: head({
        status: 'canceled',
        ended_at: '2026-05-01T00:00:00.000Z',
        items: [
          {
            price_id: 'p',
            product_id: 'prod',
            unit_amount_minor: 1001,
            quantity: 1,
            interval: 'month',
            interval_count: 1,
          },
        ],
      }),
      changes: [
        {
          subscriptionId: 'sub_1',
          providerEventId: 'evt_1',
          kind: 'plan_changed',
          occurredAt: new Date('2026-04-01T00:00:00.000Z'),
          fromMrrMinor: 699,
          toMrrMinor: 1001,
        },
      ],
      reportingCurrency: 'EUR',
      conversion: usdToEur,
      identityKey: KEY,
    })
    expect(rows.map((r) => r.kind)).toEqual(['started', 'plan_changed', 'ended'])
    expect(rows.every((r) => r.conversion_source === 'ecb')).toBe(true)
    expect(rows[0]?.reporting_mrr_delta_minor).not.toBe(0)
    expect(rows.reduce((t, r) => t + r.mrr_delta_minor, 0)).toBe(0)
    expect(sum(rows)).toBe(0)
  })

  it('writes one `none` row for a subscription that never paid', () => {
    const rows = buildSubscriptionLifecycleRows({
      head: head({ status: 'incomplete_expired' }),
      changes: [],
      reportingCurrency: 'USD',
      conversion: planCurrencyConversion({
        fromCurrency: 'USD',
        toCurrency: 'USD',
        fromRate: null,
        toRate: null,
      }),
      identityKey: KEY,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ seq: 0, kind: 'none', mrr_delta_minor: 0, active_delta: 0 })
  })
})

describe('buildSubscriptionInvoiceRow', () => {
  const invoice = (overrides: Partial<RevenueInvoiceRow> = {}): RevenueInvoiceRow => ({
    id: 'i1',
    siteId: 's',
    provider: 'stripe',
    invoiceId: 'in_1',
    subscriptionId: 'sub_1',
    billingReason: 'subscription_cycle',
    orderId: 'pi_1',
    chargeId: '',
    customerId: 'cus_1',
    occurredAt: new Date('2026-04-01T00:00:00.000Z'),
    version: 2,
    projectedVersion: 0,
    updatedAt: new Date('2026-04-01T00:00:05.000Z'),
    ...overrides,
  })

  it('derives the purchase kind from the billing reason', () => {
    expect(buildSubscriptionInvoiceRow(invoice())).toMatchObject({
      purchase_kind: 'renewal',
      generation: 2,
      order_id: 'pi_1',
    })
    expect(
      buildSubscriptionInvoiceRow(invoice({ billingReason: 'subscription_create' })).purchase_kind,
    ).toBe('new')
    expect(
      buildSubscriptionInvoiceRow(invoice({ billingReason: 'manual', subscriptionId: '' }))
        .purchase_kind,
    ).toBe('one_off')
  })

  it('leaves the kind empty while the billing reason is unknown', () => {
    expect(buildSubscriptionInvoiceRow(invoice({ billingReason: '' })).purchase_kind).toBe('')
  })
})
