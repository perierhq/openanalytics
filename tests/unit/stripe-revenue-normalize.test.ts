import { createStripeRevenueAdapter } from '@openanalytics/integrations'
import { signStripeWebhook } from '@openanalytics/testkit'
import { describe, expect, it, vi } from 'vitest'
import {
  stripeBalanceTransaction,
  stripeCharge,
  stripeDispute,
  stripeEvent,
  stripeRefund,
} from '../support/revenue-fixtures.ts'

/**
 * The Stripe revenue adapter's semantics (ADR-0033, D1/D4/D5).
 *
 * Three things are proven here and each is load-bearing somewhere else:
 *
 * 1. **The consumed allowlist is exactly D4's**, and everything outside it is
 *    `ignored` with a *category* rather than an error. An unknown type answered
 *    with a 4xx would make a customer's Stripe dashboard show a permanently
 *    failing endpoint for events we correctly do not care about.
 * 2. **Amounts are integer passthrough.** Every amount comes from one of
 *    Stripe's own integer minor-unit fields; nothing is parsed from a decimal or
 *    multiplied by 100, and a non-integer is refused rather than rounded. A
 *    rounded amount is a wrong number that looks exactly like a right one.
 * 3. **The snapshot time is the event's, not the object's** — for webhooks. That
 *    is what lets two states of one charge be ordered at all; the object's
 *    `created` never moves, so using it would collapse every update into a
 *    permanent equal-timestamp tie.
 */

const adapter = createStripeRevenueAdapter()

/** The normalized snapshot of the sole observation, or a failure. */
function normalizeOne(event: Record<string, unknown>) {
  const outcome = adapter.normalizeEvent(event)
  if (!outcome.ok) throw new Error(`normalize failed: ${outcome.reason}`)
  return outcome.event
}

describe('normalizeEvent — charges', () => {
  it('reads charge.succeeded into the canonical snapshot', () => {
    const event = normalizeOne(stripeEvent('charge.succeeded', stripeCharge()))
    expect(event.observations).toHaveLength(1)
    const [observation] = event.observations
    expect(observation?.objectId).toBe('ch_test_1')
    expect(observation?.objectKind).toBe('charge')
    expect(observation?.normalized).toMatchObject({
      object_kind: 'charge',
      status: 'succeeded',
      livemode: false,
      // Lowercased: D5 stores ISO-4217 lowercase and Stripe is inconsistent
      // about the case it sends back on older API versions.
      currency: 'usd',
      gross_minor: 4999,
      fee_minor: 0,
      net_minor: 4999,
      order_id: 'pi_test_1',
      customer_id: 'cus_test_1',
      parent_object_id: '',
    })
  })

  it('uses the EVENT created as the snapshot time, not the object created', () => {
    const event = normalizeOne(
      stripeEvent('charge.updated', stripeCharge({ created: 1_000 }), { created: 2_000 }),
    )
    expect(event.observations[0]?.snapshotAt.getTime()).toBe(2_000_000)
    // …while `occurred_at` — the bucket the money lands in — stays the object's.
    expect(event.observations[0]?.normalized.occurred_at).toBe(new Date(1_000_000).toISOString())
  })

  it('derives refunded and partially_refunded, which Stripe does not report', () => {
    // Stripe keeps a refunded charge's `status` at `succeeded` and records the
    // refund separately. A dashboard reading the raw status would be telling the
    // truth about the payment and lying about the money.
    const full = normalizeOne(
      stripeEvent('charge.refunded', stripeCharge({ refunded: true, amount_refunded: 4999 })),
    )
    expect(full.observations[0]?.normalized.status).toBe('refunded')

    const partial = normalizeOne(
      stripeEvent('charge.refunded', stripeCharge({ amount_refunded: 1500 })),
    )
    expect(partial.observations[0]?.normalized.status).toBe('partially_refunded')
    // D2d: the charge keeps its FULL gross. The refund's own bucket carries the
    // reduction; retroactively shrinking the charge would make a July report
    // change in September.
    expect(partial.observations[0]?.normalized.gross_minor).toBe(4999)
  })

  it('reads an expanded reference as well as an id string', () => {
    // Which form arrives depends on the account's API version and on whether
    // another integration requested expansion. Reading only the string form is
    // the exact bug that made every invoice.paid "unhandled" in production.
    const event = normalizeOne(
      stripeEvent(
        'charge.captured',
        stripeCharge({ customer: { id: 'cus_expanded', object: 'customer' } }),
      ),
    )
    expect(event.observations[0]?.normalized.customer_id).toBe('cus_expanded')
  })
})

describe('normalizeEvent — refunds and disputes', () => {
  it('reads refund.updated with its parent charge', () => {
    const event = normalizeOne(stripeEvent('refund.updated', stripeRefund()))
    expect(event.observations[0]?.objectKind).toBe('refund')
    expect(event.observations[0]?.normalized).toMatchObject({
      status: 'succeeded',
      gross_minor: 1500,
      parent_object_id: 'ch_test_1',
      order_id: 'pi_test_1',
    })
  })

  it('reads every dispute lifecycle event and preserves the provider status', () => {
    // Collapsing dispute statuses into three buckets would destroy the
    // distinction between "we are still arguing" and "we lost", which is the
    // only thing a dispute screen is for.
    const lifecycle: readonly (readonly [string, string])[] = [
      ['charge.dispute.created', 'needs_response'],
      ['charge.dispute.funds_withdrawn', 'under_review'],
      ['charge.dispute.funds_reinstated', 'won'],
      ['charge.dispute.closed', 'lost'],
    ]
    for (const [type, status] of lifecycle) {
      const event = normalizeOne(stripeEvent(type, stripeDispute({ status })))
      expect(event.observations[0]?.objectKind).toBe('dispute')
      expect(event.observations[0]?.normalized.status).toBe(status)
      expect(event.observations[0]?.normalized.parent_object_id).toBe('ch_test_1')
    }
  })
})

describe('normalizeEvent — the ignore vocabulary', () => {
  it('turns checkout.session.completed into a HINT and no observation', () => {
    // D4 consumes it as a matching signal. CP2 stored nothing from it; CP3
    // stores a hint, because the ADR-0033 D6 amendment gave the worker the
    // identity secret. The event still produces **no observation** — a payload
    // with no money fields must never reach the object head, where it would tie
    // the charge's snapshot second and, if applied, rewrite the document holding
    // the amounts.
    const event = normalizeOne(
      stripeEvent('checkout.session.completed', {
        id: 'cs_1',
        client_reference_id: 'u_1',
        payment_intent: 'pi_1',
        customer: 'cus_1',
      }),
    )
    expect(event.observations).toHaveLength(0)
    expect(event.ignored).toBeUndefined()
    expect(event.hints).toEqual([
      {
        checkoutSessionId: 'cs_1',
        orderId: 'pi_1',
        clientReferenceId: 'u_1',
        customerId: 'cus_1',
        occurredAt: event.eventAt,
      },
    ])
  })

  it('reads an expanded payment_intent and customer, not only the id form', () => {
    // The production lesson from `stripe.ts`: which form arrives depends on the
    // ACCOUNT's API version and on whether another integration requested
    // expansion, and reading only the string form made every `invoice.paid`
    // ignored in production on 2026-07-26.
    const event = normalizeOne(
      stripeEvent('checkout.session.completed', {
        id: 'cs_2',
        payment_intent: { id: 'pi_2', object: 'payment_intent' },
        customer: { id: 'cus_2', object: 'customer' },
      }),
    )
    expect(event.hints?.[0]).toMatchObject({ orderId: 'pi_2', customerId: 'cus_2' })
  })

  it('keeps a session that completed without a payment', () => {
    // An async payment method (SEPA, iDEAL) completes the session before the
    // PaymentIntent has a charge. Dropping the hint would make that later charge
    // permanently unmatchable; kept, it simply joins to nothing until the
    // payment appears and a redelivery fills the order id in.
    const event = normalizeOne(
      stripeEvent('checkout.session.completed', { id: 'cs_3', client_reference_id: 'u_3' }),
    )
    expect(event.hints?.[0]).toMatchObject({ checkoutSessionId: 'cs_3', orderId: '' })
  })

  it('acks a session with no id as understood-but-empty', () => {
    // The session id is the hint's uniqueness key. Without it a redelivery would
    // insert a second row rather than update the first, and the bound that keeps
    // provider retries from becoming unbounded rows would be gone.
    const event = normalizeOne(stripeEvent('checkout.session.completed', { object: 'session' }))
    expect(event.hints).toBeUndefined()
    expect(event.ignored).toBe('no_observations')
  })

  it('never reads an email off the session', () => {
    // D-102 forbids storing it and the api cannot hash it (the api holds no
    // identity secret and must keep holding none). A field read here would be a
    // field one refactor away from a column.
    const event = normalizeOne(
      stripeEvent('checkout.session.completed', {
        id: 'cs_4',
        customer_details: { email: 'someone@example.com' },
      }),
    )
    expect(JSON.stringify(event.hints)).not.toContain('example.com')
  })

  it('reports an unreadable subscription event as unsupported_object_shape', () => {
    // Subscription events are lifecycle inputs since Perier gap 7 (see
    // stripe-subscription-lifecycle.test.ts); one whose object cannot be read
    // is no longer "understood and empty".
    for (const type of [
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ]) {
      const event = normalizeOne(stripeEvent(type, { id: 'sub_1' }))
      expect(event.ignored).toBe('unsupported_object_shape')
      expect(event.observations).toHaveLength(0)
    }
  })

  it('separates "we do not read this type" from "this carried no money"', () => {
    // Two categories, because an operator asking why a site's revenue looks thin
    // needs to tell them apart in aggregate.
    const unknown = normalizeOne(stripeEvent('payout.paid', { id: 'po_1' }))
    expect(unknown.ignored).toBe('unhandled_event_type')
    expect(unknown.observations).toHaveLength(0)
  })

  it('reports an allowlisted event whose object it cannot read', () => {
    const broken = normalizeOne(stripeEvent('charge.succeeded', { id: 'ch_1' }))
    expect(broken.ignored).toBe('unsupported_object_shape')
  })

  it('refuses a body that is not an event at all', () => {
    // No id means no ledger key, so there is nothing to record — the route
    // answers 400 rather than creating a row a redelivery could never match.
    expect(adapter.normalizeEvent({ type: 'charge.succeeded' }).ok).toBe(false)
    expect(adapter.normalizeEvent(null).ok).toBe(false)
    expect(adapter.normalizeEvent('{}').ok).toBe(false)
  })
})

/**
 * Fees (ADR-0033, D2d amendment).
 *
 * The whole point of `fee_currency` is that `fee_minor: 0` is not one fact. It
 * is "we did not look", "the provider charged nothing", and — once the currency
 * differs — "there is a fee but not one this row can subtract". These prove the
 * three stay distinguishable, because a fee silently defaulted to zero is the
 * confident zero the milestone is named after.
 */
describe('fees — the three states of fee_minor', () => {
  it('leaves the fee UNKNOWN when the balance transaction is an id string', () => {
    // The webhook path. Stripe sends the object as it stood and `expand` is a
    // request parameter, so `balance_transaction` arrives as `txn_…` and there
    // is no fee in the payload at all. It must not read as a zero fee.
    const event = normalizeOne(stripeEvent('charge.succeeded', stripeCharge()))
    expect(event.observations[0]?.normalized).toMatchObject({
      gross_minor: 4999,
      fee_minor: 0,
      fee_currency: '',
      // Not deducted: subtracting a fee we have never seen is the failure.
      net_minor: 4999,
    })
  })

  it('reads the fee off an EXPANDED balance transaction and deducts it', async () => {
    const client = createStripeRevenueAdapter(async () =>
      jsonResponse({
        data: [stripeCharge({ balance_transaction: stripeBalanceTransaction() })],
        has_more: false,
      }),
    )
    const outcome = await client.listObjects('sk', 'charges', {
      cursor: null,
      windowStart: new Date(0),
      windowEnd: new Date(9_000_000),
      pageSize: 10,
    })

    expect(outcome.ok && outcome.page.observations[0]?.normalized).toMatchObject({
      currency: 'usd',
      gross_minor: 4999,
      fee_minor: 175,
      fee_currency: 'usd',
      // Derived from the row's own two numbers, so the reporting layer's
      // `fee = gross - net` identity closes exactly.
      net_minor: 4824,
    })
  })

  it('records a settlement-currency fee WITHOUT deducting it from another currency', async () => {
    // A EUR charge on an account that settles in USD. The fee is real and is
    // kept, but `gross - fee` across two currencies is not a smaller number —
    // it is a meaningless one — so the net stays at gross and `fee_currency`
    // is what makes the mismatch visible instead of silent.
    const client = createStripeRevenueAdapter(async () =>
      jsonResponse({
        data: [
          stripeCharge({
            currency: 'eur',
            amount: 10_000,
            balance_transaction: stripeBalanceTransaction({
              currency: 'usd',
              fee: 350,
              amount: 10_800,
              net: 10_450,
            }),
          }),
        ],
        has_more: false,
      }),
    )
    const outcome = await client.listObjects('sk', 'charges', {
      cursor: null,
      windowStart: new Date(0),
      windowEnd: new Date(9_000_000),
      pageSize: 10,
    })

    expect(outcome.ok && outcome.page.observations[0]?.normalized).toMatchObject({
      currency: 'eur',
      gross_minor: 10_000,
      fee_minor: 350,
      fee_currency: 'usd',
      net_minor: 10_000,
    })
  })

  it('keeps an OBSERVED zero fee distinct from an unread one', async () => {
    // A refund. Stripe reverses no fee when one is issued, so the balance
    // transaction genuinely reports 0 — and that is a different fact from
    // "we did not look", which is why the currency is set and the fee is not.
    const client = createStripeRevenueAdapter(async () =>
      jsonResponse({
        data: [
          stripeRefund({
            balance_transaction: stripeBalanceTransaction({ id: 'txn_re_1', fee: 0, net: 4999 }),
          }),
        ],
        has_more: false,
      }),
    )
    const outcome = await client.listObjects('sk', 'refunds', {
      cursor: null,
      windowStart: new Date(0),
      windowEnd: new Date(9_000_000),
      pageSize: 10,
    })

    expect(outcome.ok && outcome.page.observations[0]?.normalized).toMatchObject({
      object_kind: 'refund',
      fee_minor: 0,
      fee_currency: 'usd',
    })
  })

  it('refuses a non-integer fee rather than rounding it', async () => {
    // Same rule as every other amount: a rounded fee is a wrong number that
    // looks exactly like a right one. An unreadable fee is an unknown one.
    const client = createStripeRevenueAdapter(async () =>
      jsonResponse({
        data: [stripeCharge({ balance_transaction: stripeBalanceTransaction({ fee: 175.5 }) })],
        has_more: false,
      }),
    )
    const outcome = await client.listObjects('sk', 'charges', {
      cursor: null,
      windowStart: new Date(0),
      windowEnd: new Date(9_000_000),
      pageSize: 10,
    })

    expect(outcome.ok && outcome.page.observations[0]?.normalized).toMatchObject({
      fee_minor: 0,
      fee_currency: '',
      net_minor: 4999,
    })
  })

  it('expands the balance transaction on the paths that can carry one', async () => {
    // Expansion is resolved inside the response Stripe was already sending, so
    // a page of a hundred charges costs exactly one request either way. This is
    // what makes reading fees affordable across a ninety-day backfill, and it is
    // the assumption the whole amendment rests on.
    const calls: string[] = []
    const client = createStripeRevenueAdapter(async (input) => {
      calls.push(String(input))
      return jsonResponse({ data: [], has_more: false })
    })
    const window = { cursor: null, windowStart: new Date(0), windowEnd: new Date(1), pageSize: 10 }

    await client.listObjects('sk', 'charges', window)
    await client.listObjects('sk', 'refunds', window)
    await client.listObjects('sk', 'disputes', window)

    const expands = calls.map((call) => new URL(call).searchParams.getAll('expand[]'))
    expect(expands[0]).toEqual(['data.balance_transaction'])
    expect(expands[1]).toEqual(['data.balance_transaction'])
    // A dispute's settlement records are an ARRAY under a different field, and
    // reading them is a recorded follow-up rather than a guess. Asking for the
    // singular field here would be asking for something that does not exist.
    expect(expands[2]).toEqual([])
  })

  it('expands on the tie-break fetch too, which is the one that force-applies', async () => {
    // This fetch's answer is written with `force`, so a fee missing from it
    // would overwrite a fee the sweep had already learned.
    const calls: string[] = []
    const client = createStripeRevenueAdapter(async (input) => {
      calls.push(String(input))
      return jsonResponse(stripeCharge())
    })

    await client.fetchObject('sk', 'charge', 'ch_test_1')
    await client.fetchObject('sk', 'dispute', 'du_test_1')

    expect(new URL(calls[0] as string).searchParams.getAll('expand[]')).toEqual([
      'balance_transaction',
    ])
    expect(new URL(calls[1] as string).searchParams.getAll('expand[]')).toEqual([])
  })
})

describe('amount integrity', () => {
  it('passes integers through untouched, including zero and large values', () => {
    for (const amount of [0, 1, 99, 4999, 2_147_483_647]) {
      const event = normalizeOne(stripeEvent('charge.succeeded', stripeCharge({ amount })))
      expect(event.observations[0]?.normalized.gross_minor).toBe(amount)
      expect(event.observations[0]?.normalized.net_minor).toBe(amount)
    }
  })

  it('refuses a non-integer amount rather than rounding it', () => {
    // A rounded amount is indistinguishable from a correct one for the rest of
    // its life. Refusing produces an `unsupported_object_shape` ledger row an
    // operator can actually find.
    const fractional = normalizeOne(
      stripeEvent('charge.succeeded', stripeCharge({ amount: 49.99 })),
    )
    expect(fractional.ignored).toBe('unsupported_object_shape')

    const stringly = normalizeOne(stripeEvent('charge.succeeded', stripeCharge({ amount: '4999' })))
    expect(stringly.ignored).toBe('unsupported_object_shape')
  })
})

describe('verifyWebhook', () => {
  const SECRET = 'whsec_test_credential_secret'
  const body = JSON.stringify(stripeEvent('charge.succeeded', stripeCharge()))

  it('accepts a signature made with THIS credential secret', () => {
    // The per-credential secret is a parameter, which is what let M12 reuse M3's
    // verifier unchanged — the security-critical code needed no edit at all.
    const header = signStripeWebhook({ payload: body, secret: SECRET })
    const at = new Date(Number(header.split(',')[0]?.slice(2)) * 1000)
    expect(
      adapter.verifyWebhook({
        rawBody: body,
        signatureHeader: header,
        signingSecret: SECRET,
        now: at,
      }),
    ).toEqual({ ok: true })
  })

  it('rejects a signature made with another credential secret', () => {
    // The blast radius property D1 chose over Connect: one site's leaked secret
    // verifies nothing on another site's endpoint.
    const header = signStripeWebhook({ payload: body, secret: 'whsec_other_site' })
    const at = new Date(Number(header.split(',')[0]?.slice(2)) * 1000)
    const result = adapter.verifyWebhook({
      rawBody: body,
      signatureHeader: header,
      signingSecret: SECRET,
      now: at,
    })
    expect(result).toEqual({ ok: false, reason: 'no_matching_signature' })
  })

  it('reports a missing header and a replayed timestamp distinctly', () => {
    expect(
      adapter.verifyWebhook({ rawBody: body, signatureHeader: undefined, signingSecret: SECRET }),
    ).toEqual({ ok: false, reason: 'malformed_header' })

    const header = signStripeWebhook({ payload: body, secret: SECRET, timestamp: 1_000 })
    expect(
      adapter.verifyWebhook({
        rawBody: body,
        signatureHeader: header,
        signingSecret: SECRET,
        now: new Date(9_999_999_000),
      }),
    ).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' })
  })
})

// --- Network-facing members --------------------------------------------------

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('listObjects', () => {
  it('binds the window, the page size and the cursor into the query', async () => {
    const calls: string[] = []
    const client = createStripeRevenueAdapter(async (input) => {
      calls.push(String(input))
      return jsonResponse({ data: [stripeCharge()], has_more: true })
    })

    const outcome = await client.listObjects('sk_test', 'charges', {
      cursor: 'ch_prev',
      windowStart: new Date(1_000_000),
      windowEnd: new Date(2_000_000),
      pageSize: 100,
    })

    expect(outcome.ok).toBe(true)
    const url = new URL(calls[0] as string)
    expect(url.pathname).toBe('/v1/charges')
    expect(url.searchParams.get('created[gte]')).toBe('1000')
    expect(url.searchParams.get('created[lte]')).toBe('2000')
    expect(url.searchParams.get('starting_after')).toBe('ch_prev')
    expect(url.searchParams.get('limit')).toBe('100')
  })

  it('uses the OBJECT created as a list row snapshot time', async () => {
    // The property that makes a backfill row structurally unable to outrank a
    // newer webhook: a webhook head carries the event's time, a list row carries
    // the object's, and the object's never moves forward.
    const client = createStripeRevenueAdapter(async () =>
      jsonResponse({ data: [stripeCharge({ created: 1_234 })], has_more: false }),
    )
    const outcome = await client.listObjects('sk_test', 'charges', {
      cursor: null,
      windowStart: new Date(0),
      windowEnd: new Date(9_000_000),
      pageSize: 100,
    })
    expect(outcome.ok && outcome.page.observations[0]?.snapshotAt.getTime()).toBe(1_234_000)
  })

  it('reports the next cursor only while there is more, and nulls it at the end', async () => {
    // A cursor stored at the end of a walk would be a position the next pass
    // resumes from and re-reads. Null records "finished".
    const more = createStripeRevenueAdapter(async () =>
      jsonResponse({
        data: [stripeCharge({ id: 'ch_a' }), stripeCharge({ id: 'ch_b' })],
        has_more: true,
      }),
    )
    const first = await more.listObjects('sk', 'charges', {
      cursor: null,
      windowStart: new Date(0),
      windowEnd: new Date(1),
      pageSize: 2,
    })
    expect(first.ok && first.page).toMatchObject({ nextCursor: 'ch_b', hasMore: true })

    const done = createStripeRevenueAdapter(async () =>
      jsonResponse({ data: [stripeCharge()], has_more: false }),
    )
    const last = await done.listObjects('sk', 'charges', {
      cursor: null,
      windowStart: new Date(0),
      windowEnd: new Date(1),
      pageSize: 2,
    })
    expect(last.ok && last.page).toMatchObject({ nextCursor: null, hasMore: false })
  })

  it('advances the cursor past a row it cannot read', async () => {
    // Otherwise the walk loops on that row forever: the cursor is Stripe's
    // pagination position, not our success marker.
    const client = createStripeRevenueAdapter(async () =>
      jsonResponse({ data: [{ id: 'ch_broken' }], has_more: true }),
    )
    const outcome = await client.listObjects('sk', 'charges', {
      cursor: null,
      windowStart: new Date(0),
      windowEnd: new Date(1),
      pageSize: 2,
    })
    expect(outcome.ok && outcome.page.observations).toHaveLength(0)
    expect(outcome.ok && outcome.page.nextCursor).toBe('ch_broken')
  })
})

describe('adapter outcomes', () => {
  it('401 and 403 are unauthorized — the customer’s key, the customer’s fix', async () => {
    for (const status of [401, 403]) {
      const client = createStripeRevenueAdapter(async () => new Response('{}', { status }))
      const outcome = await client.listObjects('sk', 'charges', {
        cursor: null,
        windowStart: new Date(0),
        windowEnd: new Date(1),
        pageSize: 1,
      })
      expect(outcome).toMatchObject({ ok: false, reason: 'unauthorized' })
    }
  })

  it('429 is unavailable and carries Retry-After so the job can wait', async () => {
    const client = createStripeRevenueAdapter(
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '17' } }),
    )
    const outcome = await client.listObjects('sk', 'charges', {
      cursor: null,
      windowStart: new Date(0),
      windowEnd: new Date(1),
      pageSize: 1,
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable', retryAfterMs: 17_000 })
  })

  it('caps an absurd Retry-After rather than sleeping on a leased job', async () => {
    const client = createStripeRevenueAdapter(
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '86400' } }),
    )
    const outcome = await client.listObjects('sk', 'charges', {
      cursor: null,
      windowStart: new Date(0),
      windowEnd: new Date(1),
      pageSize: 1,
    })
    expect(outcome).toMatchObject({ ok: false, retryAfterMs: 300_000 })
  })

  it('5xx is unavailable — ours, not the credential’s', async () => {
    const client = createStripeRevenueAdapter(async () => new Response('{}', { status: 503 }))
    const outcome = await client.listObjects('sk', 'charges', {
      cursor: null,
      windowStart: new Date(0),
      windowEnd: new Date(1),
      pageSize: 1,
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('a timeout or a dead socket is unavailable, never a thrown error', async () => {
    // A throw inside a leased job is an unclassified failure with no credential
    // state behind it — the outcome type exists precisely so that cannot happen.
    const client = createStripeRevenueAdapter(async () => {
      throw new DOMException('The operation was aborted.', 'TimeoutError')
    })
    const outcome = await client.listObjects('sk', 'charges', {
      cursor: null,
      windowStart: new Date(0),
      windowEnd: new Date(1),
      pageSize: 1,
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('never puts a provider response body in the detail', async () => {
    const secretish = 'cus_real_customer_email@example.com'
    const client = createStripeRevenueAdapter(
      async () => new Response(JSON.stringify({ error: { message: secretish } }), { status: 400 }),
    )
    const outcome = await client.listObjects('sk', 'charges', {
      cursor: null,
      windowStart: new Date(0),
      windowEnd: new Date(1),
      pageSize: 1,
    })
    expect(outcome.ok).toBe(false)
    expect(JSON.stringify(outcome)).not.toContain(secretish)
  })
})

describe('fetchObject — the tie-break path', () => {
  it('returns the authoritative observation', async () => {
    const client = createStripeRevenueAdapter(async () =>
      jsonResponse(stripeCharge({ amount_refunded: 4999, refunded: true })),
    )
    const outcome = await client.fetchObject('sk', 'charge', 'ch_test_1')
    expect(outcome.ok && outcome.observation?.normalized.status).toBe('refunded')
  })

  it('treats a 404 as a success with no object, not as a failure', async () => {
    // "This object does not exist" is an answer to "what is true now". Reporting
    // it as a failure would leave the ledger row `received` and make Stripe
    // redeliver forever over an object it has itself forgotten.
    const client = createStripeRevenueAdapter(async () => new Response('{}', { status: 404 }))
    const outcome = await client.fetchObject('sk', 'charge', 'ch_gone')
    expect(outcome).toEqual({ ok: true, observation: null, missing: true })
  })

  it('addresses the right endpoint per object kind', async () => {
    const calls: string[] = []
    const client = createStripeRevenueAdapter(async (input) => {
      calls.push(new URL(String(input)).pathname)
      return jsonResponse(stripeRefund())
    })
    await client.fetchObject('sk', 'refund', 're_test_1')
    await client.fetchObject('sk', 'dispute', 'du_test_1')
    expect(calls).toEqual(['/v1/refunds/re_test_1', '/v1/disputes/du_test_1'])
  })

  it('sends the credential key as a bearer token and nothing else', async () => {
    const seen = vi.fn<(init: RequestInit | undefined) => void>()
    const client = createStripeRevenueAdapter(async (_input, init) => {
      seen(init)
      return jsonResponse(stripeCharge())
    })
    await client.fetchObject('sk_live_customer_key', 'charge', 'ch_1')
    const init = seen.mock.calls[0]?.[0]
    expect((init?.headers as Record<string, string>)['authorization']).toBe(
      'Bearer sk_live_customer_key',
    )
  })
})
