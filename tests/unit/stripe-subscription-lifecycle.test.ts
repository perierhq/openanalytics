import {
  planSubscriptionLifecycle,
  purchaseKindFor,
  subscriptionMrrMinor,
} from '@openanalytics/domain'
import {
  STRIPE_LIFECYCLE_API_VERSION,
  createStripeRevenueAdapter,
} from '@openanalytics/integrations'
import { describe, expect, it } from 'vitest'
import {
  stripeCharge,
  stripeEvent,
  stripeInvoice,
  stripeInvoicePayment,
  stripePrice,
  stripeSubscription,
} from '../support/revenue-fixtures.ts'

/**
 * The Stripe adapter's subscription lifecycle half (Perier gap 7): snapshots
 * from `customer.subscription.*`, the changes `previous_attributes` reveals,
 * invoice hints from both API shapes, and the pinned list/fetch reads.
 *
 * The fixtures are BetterBahn's own catalogue: Pro monthly (€6.99), Pro yearly
 * (€39.99), a trial, a cancel-at-period-end, and the one-off Trip Pass (€3.99),
 * which must never become a subscription.
 */

const adapter = createStripeRevenueAdapter()

function normalize(event: Record<string, unknown>) {
  const outcome = adapter.normalizeEvent(event)
  if (!outcome.ok) throw new Error(`normalize failed: ${outcome.reason}`)
  return outcome.event
}

const iso = (unix: number): string => new Date(unix * 1000).toISOString()

describe('subscription snapshots', () => {
  it('reads a monthly Pro subscription with €6.99 of MRR and no observation', () => {
    const event = normalize(stripeEvent('customer.subscription.created', stripeSubscription()))
    expect(event.observations).toHaveLength(0)
    expect(event.ignored).toBeUndefined()
    const [sub] = event.subscriptions ?? []
    expect(sub?.subscriptionId).toBe('sub_test_1')
    expect(sub?.normalized).toMatchObject({
      status: 'active',
      customer_id: 'cus_test_1',
      currency: 'eur',
      items: [
        {
          price_id: 'price_monthly',
          product_id: 'prod_pro',
          unit_amount_minor: 699,
          quantity: 1,
          interval: 'month',
          interval_count: 1,
        },
      ],
      cancel_at_period_end: false,
      ended_at: null,
    })
    expect(subscriptionMrrMinor(sub?.normalized.items ?? [])).toBe(699)
  })

  it('normalizes a yearly €39.99 plan to 333 cents of MRR', () => {
    const event = normalize(
      stripeEvent('customer.subscription.created', stripeSubscription({}, stripePrice('yearly'))),
    )
    const items = event.subscriptions?.[0]?.normalized.items ?? []
    expect(items[0]?.interval).toBe('year')
    expect(subscriptionMrrMinor(items)).toBe(333)
  })

  it('uses the EVENT created as the snapshot time', () => {
    const event = normalize(
      stripeEvent('customer.subscription.updated', stripeSubscription(), {
        created: 1_900_000_000,
      }),
    )
    expect(event.subscriptions?.[0]?.snapshotAt.getTime()).toBe(1_900_000_000_000)
  })

  it('reads a trial and plans its conversion', () => {
    const trialStart = 1_772_355_600 // 2026-03-01T09:00Z
    const trialEnd = trialStart + 14 * 86_400
    const running = normalize(
      stripeEvent(
        'customer.subscription.created',
        stripeSubscription({ status: 'trialing', trial_start: trialStart, trial_end: trialEnd }),
      ),
    ).subscriptions?.[0]
    expect(running?.normalized).toMatchObject({
      status: 'trialing',
      trial_start: iso(trialStart),
      trial_end: iso(trialEnd),
    })
    const runningFacts = planSubscriptionLifecycle({
      snapshot: running!.normalized,
      snapshotAt: running!.snapshotAt,
      changes: [],
    })
    expect(runningFacts.map((f) => f.kind)).toEqual(['trial_started'])

    const converted = normalize(
      stripeEvent(
        'customer.subscription.updated',
        stripeSubscription({ status: 'active', trial_start: trialStart, trial_end: trialEnd }),
        {
          data: {
            object: stripeSubscription({
              status: 'active',
              trial_start: trialStart,
              trial_end: trialEnd,
            }),
            previous_attributes: { status: 'trialing' },
          },
        },
      ),
    ).subscriptions?.[0]
    const facts = planSubscriptionLifecycle({
      snapshot: converted!.normalized,
      snapshotAt: converted!.snapshotAt,
      changes: [],
    })
    expect(facts.map((f) => f.kind)).toEqual(['trial_started', 'trial_converted', 'started'])
    expect(facts.find((f) => f.kind === 'started')?.mrrDeltaMinor).toBe(699)
  })

  it('reads cancel-at-period-end from previous_attributes as cancel_scheduled', () => {
    const subscription = stripeSubscription({
      cancel_at_period_end: true,
      cancel_at: 1_775_000_000,
      canceled_at: 1_774_000_000,
    })
    const event = normalize(
      stripeEvent('customer.subscription.updated', subscription, {
        id: 'evt_cancel',
        created: 1_774_000_000,
        data: {
          object: subscription,
          previous_attributes: { cancel_at_period_end: false, cancel_at: null, canceled_at: null },
        },
      }),
    )
    expect(event.subscriptionChanges).toEqual([
      {
        subscriptionId: 'sub_test_1',
        providerEventId: 'evt_cancel',
        kind: 'cancel_scheduled',
        occurredAt: new Date(1_774_000_000_000),
        fromMrrMinor: 0,
        toMrrMinor: 0,
      },
    ])
    // Still paying: the cancellation is intent, not churn.
    const facts = planSubscriptionLifecycle({
      snapshot: event.subscriptions![0]!.normalized,
      snapshotAt: event.subscriptions![0]!.snapshotAt,
      changes: event.subscriptionChanges ?? [],
    })
    expect(facts.map((f) => f.kind)).toEqual(['started', 'cancel_scheduled'])
  })

  it('reads an undone cancellation as cancel_undone', () => {
    const subscription = stripeSubscription()
    const event = normalize(
      stripeEvent('customer.subscription.updated', subscription, {
        data: {
          object: subscription,
          previous_attributes: { cancel_at_period_end: true, cancel_at: 1_775_000_000 },
        },
      }),
    )
    expect(event.subscriptionChanges?.map((c) => c.kind)).toEqual(['cancel_undone'])
  })

  it('reads a monthly → yearly switch as a plan change with both MRRs', () => {
    const subscription = stripeSubscription({}, stripePrice('yearly'))
    const event = normalize(
      stripeEvent('customer.subscription.updated', subscription, {
        data: {
          object: subscription,
          previous_attributes: {
            items: {
              object: 'list',
              data: [{ id: 'si_test_1', price: stripePrice('monthly'), quantity: 1 }],
            },
          },
        },
      }),
    )
    expect(event.subscriptionChanges).toMatchObject([
      { kind: 'plan_changed', fromMrrMinor: 699, toMrrMinor: 333 },
    ])
  })

  it('ignores a previous_attributes change that moved no MRR', () => {
    const subscription = stripeSubscription()
    const event = normalize(
      stripeEvent('customer.subscription.updated', subscription, {
        data: { object: subscription, previous_attributes: { metadata: { a: '1' } } },
      }),
    )
    expect(event.subscriptionChanges).toBeUndefined()
    expect(event.subscriptions).toHaveLength(1)
  })

  it('reads customer.subscription.deleted as an ended snapshot', () => {
    const ended = 1_780_000_000
    const event = normalize(
      stripeEvent(
        'customer.subscription.deleted',
        stripeSubscription({ status: 'canceled', ended_at: ended, canceled_at: ended }),
      ),
    )
    const sub = event.subscriptions?.[0]
    expect(sub?.normalized.status).toBe('canceled')
    expect(sub?.normalized.ended_at).toBe(iso(ended))
    const facts = planSubscriptionLifecycle({
      snapshot: sub!.normalized,
      snapshotAt: sub!.snapshotAt,
      changes: [],
    })
    expect(facts.reduce((total, f) => total + f.mrrDeltaMinor, 0)).toBe(0)
    expect(facts.at(-1)?.kind).toBe('ended')
  })

  it('skips metered items and reads the legacy plan field', () => {
    const event = normalize(
      stripeEvent(
        'customer.subscription.created',
        stripeSubscription({
          items: {
            object: 'list',
            data: [
              {
                price: stripePrice('monthly', {
                  id: 'price_metered',
                  recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' },
                }),
                quantity: 1,
              },
              {
                plan: {
                  id: 'plan_legacy',
                  product: 'prod_pro',
                  amount: 500,
                  currency: 'eur',
                  interval: 'month',
                  interval_count: 1,
                },
                quantity: 2,
              },
            ],
          },
        }),
      ),
    )
    const items = event.subscriptions?.[0]?.normalized.items ?? []
    expect(items.map((i) => i.price_id)).toEqual(['plan_legacy'])
    expect(subscriptionMrrMinor(items)).toBe(1000)
  })

  it('reports an unreadable subscription as unsupported_object_shape', () => {
    expect(normalize(stripeEvent('customer.subscription.updated', { id: 'sub_1' })).ignored).toBe(
      'unsupported_object_shape',
    )
  })
})

describe('invoice hints', () => {
  it('reads a basil invoice.paid: subscription from parent, no PaymentIntent yet', () => {
    const event = normalize(stripeEvent('invoice.paid', stripeInvoice()))
    expect(event.observations).toHaveLength(0)
    expect(event.invoiceHints).toEqual([
      {
        invoiceId: 'in_test_1',
        subscriptionId: 'sub_test_1',
        billingReason: 'subscription_create',
        orderId: '',
        chargeId: '',
        customerId: 'cus_test_1',
        occurredAt: new Date((1_772_355_600 + 5) * 1000),
      },
    ])
  })

  it('reads a legacy invoice.payment_succeeded with its PaymentIntent and charge', () => {
    const event = normalize(
      stripeEvent(
        'invoice.payment_succeeded',
        stripeInvoice({ billing_reason: 'subscription_cycle' }, { shape: 'legacy' }),
      ),
    )
    expect(event.invoiceHints?.[0]).toMatchObject({
      subscriptionId: 'sub_test_1',
      billingReason: 'subscription_cycle',
      orderId: 'pi_sub_1',
      chargeId: 'ch_sub_1',
    })
    const hint = event.invoiceHints![0]!
    expect(purchaseKindFor(hint)).toBe('renewal')
  })

  it('reads invoice_payment.paid as the invoice → PaymentIntent link', () => {
    const event = normalize(stripeEvent('invoice_payment.paid', stripeInvoicePayment()))
    expect(event.invoiceHints?.[0]).toMatchObject({
      invoiceId: 'in_test_1',
      orderId: 'pi_sub_1',
      chargeId: '',
      subscriptionId: '',
      billingReason: '',
    })
  })

  it('reads an invoice_payment with a top-level charge (the preview shape)', () => {
    const event = normalize(
      stripeEvent(
        'invoice_payment.paid',
        stripeInvoicePayment({ payment: undefined, charge: 'ch_oob', payment_intent: null }),
      ),
    )
    expect(event.invoiceHints?.[0]).toMatchObject({ chargeId: 'ch_oob', orderId: '' })
  })

  it('labels the one-off Trip Pass invoice one_off, never a subscription', () => {
    // Checkout in payment mode with invoice creation on: a `manual` invoice
    // with no subscription parent.
    const event = normalize(
      stripeEvent(
        'invoice.paid',
        stripeInvoice({ billing_reason: 'manual' }, { subscription: null }),
      ),
    )
    const hint = event.invoiceHints![0]!
    expect(hint.subscriptionId).toBe('')
    expect(purchaseKindFor(hint)).toBe('one_off')
    // And no subscription snapshot exists for it.
    expect(event.subscriptions).toBeUndefined()
  })

  it('normalizes the Trip Pass charge exactly as before', () => {
    const event = normalize(
      stripeEvent(
        'charge.succeeded',
        stripeCharge({ amount: 399, currency: 'eur', payment_intent: 'pi_trip' }),
      ),
    )
    expect(event.subscriptions).toBeUndefined()
    expect(event.invoiceHints).toBeUndefined()
    expect(event.observations[0]?.normalized).toMatchObject({
      gross_minor: 399,
      order_id: 'pi_trip',
      subscription_id: '',
    })
  })
})

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('listLifecycle and fetchSubscription', () => {
  it('lists every subscription status, pinned to the lifecycle API version', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const client = createStripeRevenueAdapter(async (input, init) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
      return jsonResponse({ data: [stripeSubscription()], has_more: true })
    })
    const outcome = await client.listLifecycle('sk_test', 'subscriptions', {
      cursor: 'sub_prev',
      windowStart: new Date(0),
      windowEnd: new Date(2_000_000_000_000),
      pageSize: 100,
    })
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/v1/subscriptions')
    expect(url.searchParams.get('status')).toBe('all')
    expect(url.searchParams.get('starting_after')).toBe('sub_prev')
    expect(calls[0]!.headers['stripe-version']).toBe(STRIPE_LIFECYCLE_API_VERSION)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.page.subscriptions).toHaveLength(1)
    // A listed head carries the subscription's own `created`.
    expect(outcome.page.subscriptions[0]?.snapshotAt.getTime()).toBe(1_772_355_600_000)
    expect(outcome.page.nextCursor).toBe('sub_test_1')
  })

  it('lists paid invoices with their payments expanded', async () => {
    const calls: string[] = []
    const client = createStripeRevenueAdapter(async (input) => {
      calls.push(String(input))
      return jsonResponse({
        data: [stripeInvoice({ billing_reason: 'subscription_cycle' }, { expandPayments: true })],
        has_more: false,
      })
    })
    const outcome = await client.listLifecycle('sk_test', 'invoices', {
      cursor: null,
      windowStart: new Date(0),
      windowEnd: new Date(2_000_000_000_000),
      pageSize: 50,
    })
    const url = new URL(calls[0]!)
    expect(url.pathname).toBe('/v1/invoices')
    expect(url.searchParams.get('status')).toBe('paid')
    expect(url.searchParams.getAll('expand[]')).toEqual(['data.payments'])
    expect(outcome.ok && outcome.page.invoiceHints[0]).toMatchObject({
      invoiceId: 'in_test_1',
      subscriptionId: 'sub_test_1',
      billingReason: 'subscription_cycle',
      orderId: 'pi_sub_1',
    })
    expect(outcome.ok && outcome.page.nextCursor).toBeNull()
  })

  it('reports a restricted key without subscription access as unauthorized', async () => {
    const client = createStripeRevenueAdapter(async () => new Response('{}', { status: 403 }))
    const outcome = await client.listLifecycle('sk_test', 'subscriptions', {
      cursor: null,
      windowStart: new Date(0),
      windowEnd: new Date(1),
      pageSize: 10,
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('fetches one subscription, and treats a 404 as gone', async () => {
    const found = createStripeRevenueAdapter(async () => jsonResponse(stripeSubscription()))
    const outcome = await found.fetchSubscription('sk', 'sub_test_1')
    expect(outcome.ok && outcome.observation?.subscriptionId).toBe('sub_test_1')

    const gone = createStripeRevenueAdapter(async () => new Response('{}', { status: 404 }))
    expect(await gone.fetchSubscription('sk', 'sub_x')).toEqual({ ok: true, observation: null })
  })
})
