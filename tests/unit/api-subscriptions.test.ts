import { describe, expect, it } from 'vitest'
import {
  buildSubscriptionSeries,
  mapPurchaseKinds,
  mapSubscriptionTotals,
  purchaseKindOrNull,
} from '../../apps/api/src/analytics/subscriptions.ts'

/**
 * The pure half of the subscription reads (Perier fork, gap 7): the gateway rows
 * of ClickHouse 0030's three operations turned into the wire shapes.
 */

describe('mapSubscriptionTotals', () => {
  it('coerces ClickHouse strings and names the reporting currency', () => {
    const totals = mapSubscriptionTotals(
      {
        mrr_start_minor: '1000',
        mrr_end_minor: '1699',
        active_start: '2',
        active_end: '3',
        trialing_start: '1',
        trialing_end: '0',
        new_mrr_minor: '699',
        churned_mrr_minor: '0',
        new_subscriptions: '1',
        trials_converted: '1',
        unconverted_subscriptions: '0',
      },
      'EUR',
    )
    expect(totals).toMatchObject({
      currency: 'EUR',
      mrr_start_minor: 1000,
      mrr_end_minor: 1699,
      active_end: 3,
      new_mrr_minor: 699,
      trials_converted: 1,
      cancels_undone: 0,
    })
  })

  it('answers zeros for a site with no subscription facts', () => {
    const totals = mapSubscriptionTotals(undefined, 'USD')
    expect(totals.mrr_end_minor).toBe(0)
    expect(totals.active_start).toBe(0)
    expect(totals.currency).toBe('USD')
  })
})

describe('purchase kinds', () => {
  it('maps a stored kind and nulls the empty string a refund carries', () => {
    expect(purchaseKindOrNull('renewal')).toBe('renewal')
    expect(purchaseKindOrNull('')).toBeNull()
    expect(purchaseKindOrNull('something_else')).toBeNull()
  })

  it('orders the split by the enum and drops unknown kinds', () => {
    const rows = mapPurchaseKinds([
      {
        purchase_kind: 'one_off',
        charges: '4',
        reporting_gross_minor: '1596',
        unconverted_count: '0',
      },
      {
        purchase_kind: 'renewal',
        charges: '2',
        reporting_gross_minor: '1398',
        unconverted_count: '1',
      },
      { purchase_kind: 'bogus', charges: '9', reporting_gross_minor: '9', unconverted_count: '0' },
      { purchase_kind: 'new', charges: '1', reporting_gross_minor: '3999', unconverted_count: '0' },
    ])
    expect(rows.map((row) => row.purchase_kind)).toEqual(['new', 'renewal', 'one_off'])
    expect(rows[1]).toEqual({
      purchase_kind: 'renewal',
      charges: 2,
      charge_gross_minor: 1398,
      unconverted_count: 1,
    })
  })
})

describe('buildSubscriptionSeries', () => {
  it('runs the levels forward from the start values and fills quiet days', () => {
    const series = buildSubscriptionSeries({
      rows: [
        {
          bucket: '2026-07-02 00:00:00.000',
          net_mrr_minor: '699',
          active_delta: '1',
          trial_delta: '-1',
          new_mrr_minor: '699',
          new_subscriptions: '1',
          trials_converted: '1',
        },
        {
          bucket: '2026-07-04 00:00:00.000',
          net_mrr_minor: '-333',
          active_delta: '-1',
          trial_delta: '0',
          churned_mrr_minor: '333',
          churned_subscriptions: '1',
        },
      ],
      start: { mrr: 1000, active: 2, trialing: 1 },
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-05T00:00:00.000Z',
      timezone: 'UTC',
      currency: 'EUR',
    })
    expect(series.map((p) => p.bucket)).toEqual([
      '2026-07-01T00:00:00.000Z',
      '2026-07-02T00:00:00.000Z',
      '2026-07-03T00:00:00.000Z',
      '2026-07-04T00:00:00.000Z',
    ])
    expect(series.map((p) => p.mrr_minor)).toEqual([1000, 1699, 1699, 1366])
    expect(series.map((p) => p.active)).toEqual([2, 3, 3, 2])
    expect(series.map((p) => p.trialing)).toEqual([1, 0, 0, 0])
    expect(series[2]).toMatchObject({ net_mrr_minor: 0, new_subscriptions: 0, currency: 'EUR' })
    expect(series[3]).toMatchObject({ churned_mrr_minor: 333, churned_subscriptions: 1 })
  })

  it('labels local days across a DST change and matches the gateway bucket', () => {
    // Europe/Berlin leaves summer time on 2026-10-25: that day is 25 hours long.
    const series = buildSubscriptionSeries({
      // The gateway's `toStartOfDay(occurred_at, 'Europe/Berlin')` for the 25th.
      rows: [{ bucket: '2026-10-24 22:00:00.000', net_mrr_minor: '500', active_delta: '1' }],
      start: { mrr: 0, active: 0, trialing: 0 },
      from: '2026-10-23T22:00:00.000Z',
      to: '2026-10-26T23:00:00.000Z',
      timezone: 'Europe/Berlin',
      currency: 'EUR',
    })
    expect(series.map((p) => p.bucket)).toEqual([
      '2026-10-23T22:00:00.000Z',
      '2026-10-24T22:00:00.000Z',
      '2026-10-25T23:00:00.000Z',
    ])
    expect(series.map((p) => p.mrr_minor)).toEqual([0, 500, 500])
    expect(series.map((p) => p.active)).toEqual([0, 1, 1])
  })

  it('starts the first day at local midnight when the range starts mid-day', () => {
    const series = buildSubscriptionSeries({
      rows: [{ bucket: '2026-07-01 00:00:00.000', net_mrr_minor: '100' }],
      start: { mrr: 0, active: 0, trialing: 0 },
      from: '2026-07-01T12:00:00.000Z',
      to: '2026-07-02T12:00:00.000Z',
      timezone: 'UTC',
      currency: 'EUR',
    })
    expect(series.map((p) => [p.bucket, p.mrr_minor])).toEqual([
      ['2026-07-01T00:00:00.000Z', 100],
      ['2026-07-02T00:00:00.000Z', 100],
    ])
  })
})
