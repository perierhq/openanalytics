import {
  isNewConversion,
  monthlyAmountMinor,
  planSubscriptionLifecycle,
  purchaseKindFor,
  subscriptionMrrMinor,
  type RevenueSubscriptionChange,
  type RevenueSubscriptionItem,
  type RevenueSubscriptionSnapshot,
  type SubscriptionLifecycleFact,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * Subscription lifecycle planning (Perier gap 7). The invariants that matter
 * for MRR and churn: the movements of a live subscription sum to its current
 * MRR, the movements of an ended one sum to zero, and a one-off purchase never
 * becomes a subscription.
 */

const monthly: RevenueSubscriptionItem = {
  price_id: 'price_monthly',
  product_id: 'prod_pro',
  unit_amount_minor: 699,
  quantity: 1,
  interval: 'month',
  interval_count: 1,
}
const yearly: RevenueSubscriptionItem = {
  price_id: 'price_yearly',
  product_id: 'prod_pro',
  unit_amount_minor: 3999,
  quantity: 1,
  interval: 'year',
  interval_count: 1,
}

const snapshot = (
  overrides: Partial<RevenueSubscriptionSnapshot> = {},
): RevenueSubscriptionSnapshot => ({
  status: 'active',
  livemode: true,
  customer_id: 'cus_1',
  currency: 'eur',
  items: [monthly],
  created_at: '2026-01-01T00:00:00.000Z',
  started_at: '2026-01-01T00:00:00.000Z',
  trial_start: null,
  trial_end: null,
  cancel_at_period_end: false,
  cancel_at: null,
  canceled_at: null,
  ended_at: null,
  ...overrides,
})

const AT = (iso: string): Date => new Date(iso)
const SNAP_AT = AT('2026-06-01T00:00:00.000Z')

const change = (
  overrides: Partial<RevenueSubscriptionChange> & Pick<RevenueSubscriptionChange, 'kind'>,
): RevenueSubscriptionChange => ({
  subscriptionId: 'sub_1',
  providerEventId: 'evt_1',
  occurredAt: AT('2026-03-01T00:00:00.000Z'),
  fromMrrMinor: 0,
  toMrrMinor: 0,
  ...overrides,
})

const kinds = (facts: readonly SubscriptionLifecycleFact[]) => facts.map((f) => f.kind)
const sum = (facts: readonly SubscriptionLifecycleFact[], key: keyof SubscriptionLifecycleFact) =>
  facts.reduce((total, f) => total + (f[key] as number), 0)

describe('purchaseKindFor', () => {
  it('labels the first payment, renewals and plan changes from billing_reason', () => {
    expect(purchaseKindFor({ billingReason: 'subscription_create', subscriptionId: 'sub_1' })).toBe(
      'new',
    )
    expect(purchaseKindFor({ billingReason: 'subscription_cycle', subscriptionId: 'sub_1' })).toBe(
      'renewal',
    )
    expect(
      purchaseKindFor({ billingReason: 'subscription_threshold', subscriptionId: 'sub_1' }),
    ).toBe('renewal')
    expect(purchaseKindFor({ billingReason: 'subscription_update', subscriptionId: 'sub_1' })).toBe(
      'plan_change',
    )
  })

  it('never labels an invoice without a subscription as a subscription payment', () => {
    // The trip pass: Checkout in payment mode with invoice creation on.
    expect(purchaseKindFor({ billingReason: 'manual', subscriptionId: '' })).toBe('one_off')
    expect(purchaseKindFor({ billingReason: 'subscription_create', subscriptionId: '' })).toBe(
      'one_off',
    )
  })

  it('treats a manual invoice on a subscribed customer as one-off and an unknown reason as renewal', () => {
    expect(purchaseKindFor({ billingReason: 'manual', subscriptionId: 'sub_1' })).toBe('one_off')
    expect(purchaseKindFor({ billingReason: 'subscription', subscriptionId: 'sub_1' })).toBe(
      'renewal',
    )
    expect(purchaseKindFor({ billingReason: 'something_new', subscriptionId: 'sub_1' })).toBe(
      'renewal',
    )
  })

  it('counts new and one-off purchases as conversions, renewals and plan changes not', () => {
    expect(isNewConversion('new')).toBe(true)
    expect(isNewConversion('one_off')).toBe(true)
    expect(isNewConversion('renewal')).toBe(false)
    expect(isNewConversion('plan_change')).toBe(false)
  })
})

describe('monthlyAmountMinor', () => {
  it('normalizes each interval to a month, rounding half-up once', () => {
    expect(monthlyAmountMinor({ amountMinor: 699, interval: 'month', intervalCount: 1 })).toBe(699)
    // 3999 / 12 = 333.25 → 333.
    expect(monthlyAmountMinor({ amountMinor: 3999, interval: 'year', intervalCount: 1 })).toBe(333)
    // 18 / 12 = 1.5 → 2 (half-up).
    expect(monthlyAmountMinor({ amountMinor: 18, interval: 'year', intervalCount: 1 })).toBe(2)
    // 1000 × 52 / 12 = 4333.33 → 4333.
    expect(monthlyAmountMinor({ amountMinor: 1000, interval: 'week', intervalCount: 1 })).toBe(4333)
    // 100 × 365 / 12 = 3041.67 → 3042.
    expect(monthlyAmountMinor({ amountMinor: 100, interval: 'day', intervalCount: 1 })).toBe(3042)
    // Every three months: 3000 / 3.
    expect(monthlyAmountMinor({ amountMinor: 3000, interval: 'month', intervalCount: 3 })).toBe(
      1000,
    )
  })

  it('returns zero for a non-positive or non-integer input instead of poisoning a sum', () => {
    expect(monthlyAmountMinor({ amountMinor: 0, interval: 'month', intervalCount: 1 })).toBe(0)
    expect(monthlyAmountMinor({ amountMinor: -5, interval: 'month', intervalCount: 1 })).toBe(0)
    expect(monthlyAmountMinor({ amountMinor: 1.5, interval: 'month', intervalCount: 1 })).toBe(0)
    expect(monthlyAmountMinor({ amountMinor: 100, interval: 'month', intervalCount: 0 })).toBe(0)
  })

  it('sums per item and multiplies by quantity', () => {
    expect(subscriptionMrrMinor([monthly, { ...yearly, quantity: 2 }])).toBe(699 + 667)
    expect(subscriptionMrrMinor([{ ...monthly, quantity: -1 }])).toBe(0)
    expect(subscriptionMrrMinor([])).toBe(0)
  })
})

describe('planSubscriptionLifecycle', () => {
  it('starts a monthly subscription with its MRR and nothing else', () => {
    const facts = planSubscriptionLifecycle({
      snapshot: snapshot(),
      snapshotAt: SNAP_AT,
      changes: [],
    })
    expect(facts).toEqual([
      {
        kind: 'started',
        occurredAt: AT('2026-01-01T00:00:00.000Z'),
        mrrDeltaMinor: 699,
        activeDelta: 1,
        trialDelta: 0,
      },
    ])
  })

  it('normalizes a yearly subscription to a month', () => {
    const facts = planSubscriptionLifecycle({
      snapshot: snapshot({ items: [yearly] }),
      snapshotAt: SNAP_AT,
      changes: [],
    })
    expect(kinds(facts)).toEqual(['started'])
    expect(sum(facts, 'mrrDeltaMinor')).toBe(333)
  })

  it('says only trial_started while a trial is running', () => {
    const facts = planSubscriptionLifecycle({
      snapshot: snapshot({
        status: 'trialing',
        trial_start: '2026-05-25T00:00:00.000Z',
        trial_end: '2026-06-08T00:00:00.000Z',
      }),
      snapshotAt: SNAP_AT,
      changes: [],
    })
    expect(kinds(facts)).toEqual(['trial_started'])
    expect(sum(facts, 'trialDelta')).toBe(1)
    expect(sum(facts, 'mrrDeltaMinor')).toBe(0)
    expect(sum(facts, 'activeDelta')).toBe(0)
  })

  it('converts a trial at trial_end and starts paying there', () => {
    const facts = planSubscriptionLifecycle({
      snapshot: snapshot({
        trial_start: '2026-01-01T00:00:00.000Z',
        trial_end: '2026-01-15T00:00:00.000Z',
      }),
      snapshotAt: SNAP_AT,
      changes: [],
    })
    expect(kinds(facts)).toEqual(['trial_started', 'trial_converted', 'started'])
    expect(facts[2]?.occurredAt).toEqual(AT('2026-01-15T00:00:00.000Z'))
    expect(sum(facts, 'trialDelta')).toBe(0)
    expect(sum(facts, 'mrrDeltaMinor')).toBe(699)
  })

  it('expires a trial that ended without paying and never starts MRR', () => {
    const facts = planSubscriptionLifecycle({
      snapshot: snapshot({
        status: 'canceled',
        trial_start: '2026-01-01T00:00:00.000Z',
        trial_end: '2026-01-15T00:00:00.000Z',
        canceled_at: '2026-01-15T00:00:00.000Z',
        ended_at: '2026-01-15T00:00:00.000Z',
      }),
      snapshotAt: SNAP_AT,
      changes: [],
    })
    expect(kinds(facts)).toEqual(['trial_started', 'trial_expired'])
    expect(sum(facts, 'mrrDeltaMinor')).toBe(0)
    expect(sum(facts, 'activeDelta')).toBe(0)
  })

  it('expires a paused trial (no payment method at trial end)', () => {
    const facts = planSubscriptionLifecycle({
      snapshot: snapshot({
        status: 'paused',
        trial_start: '2026-01-01T00:00:00.000Z',
        trial_end: '2026-01-15T00:00:00.000Z',
      }),
      snapshotAt: SNAP_AT,
      changes: [],
    })
    expect(kinds(facts)).toEqual(['trial_started', 'trial_expired'])
  })

  it('adds a cancel_scheduled at canceled_at for a pending cancel-at-period-end', () => {
    const facts = planSubscriptionLifecycle({
      snapshot: snapshot({
        cancel_at_period_end: true,
        cancel_at: '2026-07-01T00:00:00.000Z',
        canceled_at: '2026-05-10T00:00:00.000Z',
      }),
      snapshotAt: SNAP_AT,
      changes: [],
    })
    expect(kinds(facts)).toEqual(['started', 'cancel_scheduled'])
    expect(facts[1]?.occurredAt).toEqual(AT('2026-05-10T00:00:00.000Z'))
    expect(sum(facts, 'mrrDeltaMinor')).toBe(699)
  })

  it('does not double a cancellation an event already reported', () => {
    const facts = planSubscriptionLifecycle({
      snapshot: snapshot({
        cancel_at_period_end: true,
        canceled_at: '2026-05-10T00:00:00.000Z',
      }),
      snapshotAt: SNAP_AT,
      changes: [change({ kind: 'cancel_scheduled', occurredAt: AT('2026-05-10T00:00:30.000Z') })],
    })
    expect(kinds(facts)).toEqual(['started', 'cancel_scheduled'])
  })

  it('ends a cancelled-at-period-end subscription with churn summing to zero', () => {
    const facts = planSubscriptionLifecycle({
      snapshot: snapshot({
        status: 'canceled',
        canceled_at: '2026-05-10T00:00:00.000Z',
        ended_at: '2026-06-01T00:00:00.000Z',
      }),
      snapshotAt: SNAP_AT,
      changes: [],
    })
    expect(kinds(facts)).toEqual(['started', 'cancel_scheduled', 'ended'])
    expect(sum(facts, 'mrrDeltaMinor')).toBe(0)
    expect(sum(facts, 'activeDelta')).toBe(0)
  })

  it('does not invent a scheduled cancellation for an immediate cancel', () => {
    const facts = planSubscriptionLifecycle({
      snapshot: snapshot({
        status: 'canceled',
        canceled_at: '2026-04-01T00:00:00.000Z',
        ended_at: '2026-04-01T00:00:00.000Z',
      }),
      snapshotAt: SNAP_AT,
      changes: [],
    })
    expect(kinds(facts)).toEqual(['started', 'ended'])
  })

  it('moves MRR on plan changes and closes on the current plan', () => {
    // Monthly → yearly on 1 March.
    const facts = planSubscriptionLifecycle({
      snapshot: snapshot({ items: [yearly] }),
      snapshotAt: SNAP_AT,
      changes: [change({ kind: 'plan_changed', fromMrrMinor: 699, toMrrMinor: 333 })],
    })
    expect(kinds(facts)).toEqual(['started', 'plan_changed'])
    expect(facts.map((f) => f.mrrDeltaMinor)).toEqual([699, -366])
    expect(sum(facts, 'mrrDeltaMinor')).toBe(333)
  })

  it('reconciles a plan change it never saw at the snapshot time', () => {
    const facts = planSubscriptionLifecycle({
      snapshot: snapshot({ items: [yearly] }),
      snapshotAt: SNAP_AT,
      changes: [change({ kind: 'plan_changed', fromMrrMinor: 699, toMrrMinor: 1000 })],
    })
    expect(kinds(facts)).toEqual(['started', 'plan_changed', 'plan_changed'])
    expect(facts[2]?.occurredAt).toEqual(SNAP_AT)
    expect(sum(facts, 'mrrDeltaMinor')).toBe(333)
  })

  it('removes the running MRR on end whatever happened in between', () => {
    const facts = planSubscriptionLifecycle({
      snapshot: snapshot({
        status: 'canceled',
        items: [yearly],
        canceled_at: '2026-05-01T00:00:00.000Z',
        ended_at: '2026-05-01T00:00:00.000Z',
      }),
      snapshotAt: SNAP_AT,
      changes: [change({ kind: 'plan_changed', fromMrrMinor: 699, toMrrMinor: 333 })],
    })
    expect(kinds(facts)).toEqual(['started', 'plan_changed', 'ended'])
    expect(sum(facts, 'mrrDeltaMinor')).toBe(0)
  })

  it('records an undone cancellation as intent only', () => {
    const facts = planSubscriptionLifecycle({
      snapshot: snapshot(),
      snapshotAt: SNAP_AT,
      changes: [
        change({
          kind: 'cancel_scheduled',
          providerEventId: 'evt_a',
          occurredAt: AT('2026-03-01T00:00:00Z'),
        }),
        change({
          kind: 'cancel_undone',
          providerEventId: 'evt_b',
          occurredAt: AT('2026-03-02T00:00:00Z'),
        }),
      ],
    })
    expect(kinds(facts)).toEqual(['started', 'cancel_scheduled', 'cancel_undone'])
    expect(sum(facts, 'mrrDeltaMinor')).toBe(699)
  })

  it('says nothing for a subscription that never paid', () => {
    expect(
      planSubscriptionLifecycle({
        snapshot: snapshot({ status: 'incomplete_expired' }),
        snapshotAt: SNAP_AT,
        changes: [],
      }),
    ).toEqual([])
  })

  it('is deterministic, so a replay writes identical rows', () => {
    const input = {
      snapshot: snapshot({
        trial_start: '2026-01-01T00:00:00Z',
        trial_end: '2026-01-15T00:00:00Z',
      }),
      snapshotAt: SNAP_AT,
      changes: [change({ kind: 'plan_changed', fromMrrMinor: 699, toMrrMinor: 333 })],
    }
    expect(planSubscriptionLifecycle(input)).toEqual(planSubscriptionLifecycle(input))
  })
})
