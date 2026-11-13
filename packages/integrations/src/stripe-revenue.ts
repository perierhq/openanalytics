import {
  REVENUE_SYNC_RESOURCE_KINDS,
  isSubscriptionInterval,
  revenueObservationHash,
  subscriptionMrrMinor,
  type RevenueAdapter,
  type RevenueInvoiceHint,
  type RevenueLifecycleAdapter,
  type RevenueLifecycleListOutcome,
  type RevenueLifecycleSyncResource,
  type RevenueSubscriptionChange,
  type RevenueSubscriptionFetchOutcome,
  type RevenueSubscriptionItem,
  type RevenueSubscriptionObservation,
  type RevenueCredentialVerification,
  type RevenueFetchOutcome,
  type RevenueIgnoreReason,
  type RevenueListOptions,
  type RevenueListOutcome,
  type RevenueMatchHint,
  type RevenueNormalizeOutcome,
  type RevenueNormalizedObject,
  type RevenueObjectKind,
  type RevenueObservation,
  type RevenueSyncFailure,
  type RevenueSyncResource,
  type RevenueWebhookVerification,
} from '@openanalytics/domain'
import { verifyStripeSignature } from './stripe-signature.ts'

/**
 * The Stripe revenue adapter (ADR-0033, D1/D4).
 *
 * SDK-free like the billing adapter beside it: `fetch`, a typed outcome, and no
 * third-party code on a path that carries a customer's own restricted key.
 *
 * The connection model is a **customer-created restricted key** — every
 * permission Read, nothing writable — plus a webhook endpoint the customer
 * points at their site's own OA URL. Not Stripe Connect: OA only reads, Connect
 * grants account-wide scope with no per-resource narrowing, and its
 * connected-account webhooks all arrive under one shared platform signing
 * secret, so a leaked secret would be every customer's problem rather than one
 * site's.
 *
 * ## What this module is and is not allowed to do
 *
 * - **It never throws.** Every failure — DNS, TLS, a reset socket, our own
 *   deadline, a 500, a 429 — is a typed outcome. A throw on the webhook path
 *   would be a 500 on a signed delivery Stripe retries forever; a throw on the
 *   sync path would be an unclassified job failure with no credential state
 *   behind it.
 * - **No response body leaves it.** `detail` is a status line or a reason word.
 *   These requests are made against a customer's own Stripe account with their
 *   own key, and the body of the answer is not ours to relay into a log line, an
 *   error envelope or an audit row.
 * - **Amounts are integer passthrough.** Every amount here is read from one of
 *   Stripe's own integer minor-unit fields with `asInteger`. Nothing is parsed
 *   from a decimal string, nothing is multiplied by 100, and a field that is not
 *   an integer is rejected rather than coerced — `packages/contracts/src/money.ts`
 *   has forbidden float money since M0, and a `Math.round` here would be the
 *   place a cent goes missing.
 */

export const STRIPE_REVENUE_PROVIDER_ID = 'stripe'

const STRIPE_API_BASE = 'https://api.stripe.com'

/**
 * The probe: `GET /v1/charges?limit=1`.
 *
 * Charges is the first row of D1's required-permission table and the resource
 * every other one hangs off, so a key that can read it is a key the sync path
 * can start with. `limit=1` because the question is "does this key work", not
 * "what is in the account" — the response body is never read.
 */
const PROBE_PATH = '/v1/charges?limit=1'

/**
 * How long the probe may take.
 *
 * A customer is waiting on a form submit, so this is a UX bound rather than the
 * sync path's 30 s budget. A hung socket with no deadline would hold the connect
 * request open until the platform's own timeout and then answer nothing useful.
 */
const PROBE_TIMEOUT_MS = 10_000

/**
 * The sync path's per-request deadline (D4).
 *
 * Three times the probe's, because nobody is waiting: a list page of a hundred
 * objects out of a large account is a real query on Stripe's side, and giving up
 * on it early would turn a slow-but-working account into a permanently degraded
 * credential. It is still a bound — a request with no deadline inside a leased
 * job is a lease that expires while a socket hangs.
 */
const SYNC_TIMEOUT_MS = 30_000

/** D4's page budget. Stripe's own maximum for a list `limit`. */
export const STRIPE_LIST_PAGE_SIZE = 100

/**
 * The consumed event allowlist (D4), exactly as the ADR fixes it.
 *
 * Anything not in this map is ledgered `ignored` and acked — never retried,
 * never an error. That is not laziness about coverage: Stripe sends an account's
 * *entire* event stream to an endpoint that subscribes broadly, and an unknown
 * type answered with a 4xx or 5xx would make a customer's Stripe dashboard show
 * a permanently failing webhook for events we correctly do not care about.
 *
 * The value is which normalizer reads `data.object`, or `null` for an event that
 * is deliberately consumed *for context only* and produces no money object. The
 * two are different ledger outcomes on purpose — `no_observations` says "we
 * understood this and it carried no money", `unhandled_event_type` says "we do
 * not read this type" — and an operator asking why a site's revenue looks thin
 * needs to be able to tell them apart.
 */
const CONSUMED_EVENTS: Readonly<Record<string, RevenueObjectKind | null>> = {
  'charge.succeeded': 'charge',
  'charge.updated': 'charge',
  'charge.captured': 'charge',
  'charge.refunded': 'charge',
  'refund.created': 'refund',
  'refund.updated': 'refund',
  'refund.failed': 'refund',
  'charge.dispute.created': 'dispute',
  'charge.dispute.closed': 'dispute',
  'charge.dispute.funds_withdrawn': 'dispute',
  'charge.dispute.funds_reinstated': 'dispute',
  /**
   * Matching signal only (D4, D6 signal 2). Consumed — meaning acked and
   * ledgered as understood — but carrying no money object, so there is no object
   * head for it to update.
   *
   * **CP2 persisted nothing from it. CP3 persists a HINT.** What changed is the
   * secret question CP2 was blocked on: the ADR-0033 D6 amendment put
   * `ANONYMOUS_IDENTITY_SECRET` on the worker, so the `identify()` derivation
   * now has a home. The api still has none — so the event's raw
   * `client_reference_id` (the site's own opaque user id, exactly the class of
   * value `revenue_objects.normalized` has held raw since CP2) goes into
   * `revenue_match_hints`, and the worker hashes it at projection time.
   *
   * The hint is a **separate write from the object head**, deliberately. Feeding
   * it through `applyRevenueObservation` would put a payload with no money
   * fields on the equal-timestamp branch of the three-way decision — the charge
   * is created *by* this checkout, so their `created` values tie — and, if it
   * applied, would bump the version and rewrite the document holding the
   * amounts. A hint must not be able to touch money, and in its own table it
   * cannot.
   *
   * The customer email is still not read, in any form: D-102 forbids storing it
   * and the api cannot hash it. See `resolveRevenueExternalUserId`.
   */
  'checkout.session.completed': null,
  /**
   * Subscription lifecycle (Perier gap 7). Still `null` — none of them carries
   * money — but no longer context-only: each produces a subscription snapshot
   * (and, for `updated`, the changes `previous_attributes` reveals). See
   * `normalizeLifecycleEvent`.
   */
  'customer.subscription.created': null,
  'customer.subscription.updated': null,
  'customer.subscription.deleted': null,
  /**
   * Invoice hints (Perier gap 7): the only place Stripe says whether a payment
   * is a subscription's first or a renewal (`billing_reason`). `invoice.paid`
   * and `invoice.payment_succeeded` carry the invoice; `invoice_payment.paid`
   * (2025-05-28.basil and later) carries the link from the invoice to its
   * PaymentIntent, which basil removed from the invoice itself.
   */
  'invoice.paid': null,
  'invoice.payment_succeeded': null,
  'invoice_payment.paid': null,
}

/**
 * The API version the lifecycle reads (`listLifecycle`, `fetchSubscription`)
 * pin with a `Stripe-Version` header.
 *
 * The money reads deliberately take whatever the account's default version
 * returns, because the fields they read have not moved in years. The lifecycle
 * fields have: basil (2025-03-31) moved an invoice's subscription under
 * `parent.subscription_details` and replaced its `payment_intent`/`charge` with
 * the includable `payments` list. Pinning makes the listed shape one shape, and
 * lets the invoice list expand `data.payments` — a field an older account
 * version would answer with a 400 for. Webhook payloads arrive in the
 * endpoint's version, which a request header cannot pin, so the webhook
 * normalizers read both shapes.
 */
export const STRIPE_LIFECYCLE_API_VERSION = '2025-03-31.basil'

const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
])
const INVOICE_EVENTS: ReadonlySet<string> = new Set(['invoice.paid', 'invoice.payment_succeeded'])
const INVOICE_PAYMENT_EVENT = 'invoice_payment.paid'

// --- Shape readers -----------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/**
 * A Stripe integer minor-unit amount, or null.
 *
 * `Number.isSafeInteger` rather than `Number.isFinite`: a value Stripe would
 * never send but a corrupted body might — `1234.5`, `1e21` — must be rejected
 * rather than rounded, because a rounded amount is a wrong number that looks
 * exactly like a right one for the rest of its life.
 */
const asInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null

/** Unix seconds → Date. */
const unixToDate = (value: unknown): Date | null =>
  typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000) : null

/**
 * A reference that may be an id string or an expanded object.
 *
 * Stripe returns `"cus_123"` unexpanded and `{ id: "cus_123", … }` expanded, and
 * which one arrives depends on the *account's* API version and on whether some
 * other integration on the same account requested expansion. Reading only the
 * string form is precisely the class of bug that made every `invoice.paid`
 * ignored in production on 2026-07-26 (`stripe.ts`), so both are read here from
 * the start.
 */
function referenceId(value: unknown): string {
  const direct = asString(value)
  if (direct !== null) return direct
  const expanded = asRecord(value)
  return expanded ? (asString(expanded['id']) ?? '') : ''
}

/** Lowercase ISO-4217, as D5 stores it. */
function currencyOf(object: Record<string, unknown>): string | null {
  const raw = asString(object['currency'])
  return raw === null ? null : raw.toLowerCase()
}

/**
 * The fee, read off the balance transaction (ADR-0033 D2d amendment).
 *
 * Stripe puts no fee on a charge or a refund. It puts it on the *balance
 * transaction* — the settlement record — and that object is reachable two ways:
 * a second request per object, or `expand`. This module uses `expand`, so a fee
 * costs **no additional request** on either path that can carry it. That is what
 * retires the original objection to reading fees at all: a ninety-day backfill
 * of a hundred objects per page still costs one request per page.
 *
 * `null` means "not readable here", and it is returned for two genuinely
 * different situations that the caller does not need to tell apart:
 *
 * - the field is an unexpanded id string. Webhook payloads are not expandable
 *   — Stripe sends the object as it stood, and `expand` is a request parameter
 *   — so every fee on the webhook path is unknown until a sweep re-lists it.
 * - the field is absent or null. A charge that has not settled yet has no
 *   balance transaction, which is a real state and not an error.
 *
 * Both become `fee_currency: ''`, which is the honest answer. What must not
 * happen is a `fee_minor: 0` that reads as "this cost nothing".
 */
interface StripeFee {
  /** Magnitude in minor units, in `currency` below. */
  readonly minor: number
  /** The SETTLEMENT currency, which is not always the object's own. */
  readonly currency: string
}

function balanceTransactionFee(object: Record<string, unknown>): StripeFee | null {
  // An unexpanded reference is a string; only the expanded object carries a fee.
  const settlement = asRecord(object['balance_transaction'])
  if (settlement === null) return null

  const fee = asInteger(settlement['fee'])
  const currency = asString(settlement['currency'])
  if (fee === null || currency === null) return null

  return { minor: fee, currency: currency.toLowerCase() }
}

// --- Normalizers -------------------------------------------------------------

/**
 * Build the canonical snapshot with every field present.
 *
 * Absent strings are `''` rather than `undefined`, and that matters twice: the
 * document is hashed for the three-way decision, so a field that is sometimes
 * missing and sometimes empty would hash differently for identical states; and
 * CP3 writes it into ClickHouse `String` columns, which have no null.
 */
function snapshot(
  base: Pick<RevenueNormalizedObject, 'object_kind' | 'status' | 'livemode' | 'currency'>,
  amounts: { gross: number; fee: StripeFee | null },
  occurredAt: Date,
  refs: Partial<
    Pick<
      RevenueNormalizedObject,
      | 'parent_object_id'
      | 'order_id'
      | 'checkout_session_id'
      | 'client_reference_id'
      | 'subscription_id'
      | 'product_id'
      | 'product_name'
      | 'customer_id'
    >
  >,
): RevenueNormalizedObject {
  // The fee is only subtractable from the gross when the two are denominated in
  // the same currency. Stripe's balance transaction is in the account's
  // SETTLEMENT currency, which for a cross-currency charge is not the charge's
  // — and `gross - fee` across two currencies is not a smaller number, it is a
  // meaningless one. See `fee_currency` on `RevenueNormalizedObject`.
  const sameCurrency = amounts.fee !== null && amounts.fee.currency === base.currency

  return {
    object_kind: base.object_kind,
    status: base.status,
    livemode: base.livemode,
    currency: base.currency,
    gross_minor: amounts.gross,
    fee_minor: amounts.fee?.minor ?? 0,
    fee_currency: amounts.fee?.currency ?? '',
    // Derived rather than read: Stripe reports a `net` on the balance
    // transaction, but only the same-currency case guarantees it equals
    // `gross - fee` for the amount THIS row stores, and the row's own invariant
    // is what the reporting conversion and the rollup's
    // `fee = reporting_gross - reporting_net` identity are built on.
    net_minor: sameCurrency ? amounts.gross - (amounts.fee?.minor ?? 0) : amounts.gross,
    occurred_at: occurredAt.toISOString(),
    parent_object_id: refs.parent_object_id ?? '',
    order_id: refs.order_id ?? '',
    checkout_session_id: refs.checkout_session_id ?? '',
    client_reference_id: refs.client_reference_id ?? '',
    subscription_id: refs.subscription_id ?? '',
    product_id: refs.product_id ?? '',
    product_name: refs.product_name ?? '',
    customer_id: refs.customer_id ?? '',
  }
}

/**
 * A charge's status in D5's vocabulary.
 *
 * The refund states are derived rather than read, because Stripe keeps a
 * refunded charge's `status` at `succeeded` and records the refund separately.
 * A dashboard that showed such a charge as plainly `succeeded` would be telling
 * the truth about the payment and lying about the money — and D2d's rule (the
 * refund's own amount lands in the refund's bucket) needs the charge to still
 * carry its full gross, which is why the *amount* is untouched here and only the
 * status changes.
 */
function chargeStatus(object: Record<string, unknown>): string {
  const amount = asInteger(object['amount']) ?? 0
  const refunded = asInteger(object['amount_refunded']) ?? 0
  if (object['refunded'] === true || (refunded > 0 && refunded >= amount)) return 'refunded'
  if (refunded > 0) return 'partially_refunded'
  const status = asString(object['status'])
  return status === null || status === '' ? 'pending' : status
}

function normalizeCharge(object: Record<string, unknown>): RevenueObservation | null {
  const objectId = asString(object['id'])
  const currency = currencyOf(object)
  const gross = asInteger(object['amount'])
  const created = unixToDate(object['created'])
  if (objectId === null || currency === null || gross === null || created === null) return null

  return {
    objectId,
    objectKind: 'charge',
    snapshotAt: created,
    normalized: snapshot(
      {
        object_kind: 'charge',
        status: chargeStatus(object),
        livemode: object['livemode'] === true,
        currency,
      },
      // The charge is the one kind that reliably carries a fee, and the whole
      // reason the fee columns exist.
      { gross, fee: balanceTransactionFee(object) },
      created,
      {
        // The PaymentIntent — order identity across charge retries (D6 signal 1,
        // and what a site's `oa.conversion('purchase', { order_id })` names).
        order_id: referenceId(object['payment_intent']),
        customer_id: referenceId(object['customer']),
        subscription_id: '',
      },
    ),
  }
}

function normalizeRefund(object: Record<string, unknown>): RevenueObservation | null {
  const objectId = asString(object['id'])
  const currency = currencyOf(object)
  const gross = asInteger(object['amount'])
  const created = unixToDate(object['created'])
  if (objectId === null || currency === null || gross === null || created === null) return null

  return {
    objectId,
    objectKind: 'refund',
    snapshotAt: created,
    normalized: snapshot(
      {
        object_kind: 'refund',
        // `succeeded | pending | failed | canceled` (D5). Passed through rather
        // than mapped: the four Stripe emits are already the four D5 names.
        status: asString(object['status']) ?? 'pending',
        livemode: object['livemode'] === true,
        currency,
      },
      // Read rather than assumed to be zero. Stripe reverses no fee when a
      // refund is issued, so this is 0 in practice and the `RevenueTotals`
      // contract says so — but it says so as an observation about the provider,
      // and the field is deliberately general. Reading the refund's own
      // settlement record means a reversed fee lands in the right column on the
      // day some provider starts reporting one, instead of being hardcoded away.
      { gross, fee: balanceTransactionFee(object) },
      created,
      {
        // The charge this refund reduces. D2d does **not** apply it there — the
        // refund's own bucket carries the effect — but the journey shows the
        // refund beside its charge, and that link is this field.
        parent_object_id: referenceId(object['charge']),
        order_id: referenceId(object['payment_intent']),
      },
    ),
  }
}

function normalizeDispute(object: Record<string, unknown>): RevenueObservation | null {
  const objectId = asString(object['id'])
  const currency = currencyOf(object)
  const gross = asInteger(object['amount'])
  const created = unixToDate(object['created'])
  if (objectId === null || currency === null || gross === null || created === null) return null

  return {
    objectId,
    objectKind: 'dispute',
    snapshotAt: created,
    normalized: snapshot(
      {
        object_kind: 'dispute',
        // Stripe's own dispute status, lowercased and otherwise untouched
        // (`needs_response`, `under_review`, `won`, `lost`, …). D5 asks for
        // "provider status normalized" and for disputes that is the whole
        // vocabulary — collapsing it into three buckets here would destroy the
        // distinction between "we are still arguing" and "we lost", which is
        // exactly what a dispute screen is for.
        status: (asString(object['status']) ?? 'needs_response').toLowerCase(),
        livemode: object['livemode'] === true,
        currency,
      },
      // Left unread, and that is a scope decision rather than an oversight. A
      // dispute's fee is not on `balance_transaction` — disputes carry a
      // `balance_transactions` ARRAY (the withdrawal, and the reinstatement if
      // the site wins), and which entry's `fee` is the dispute fee is a claim
      // about Stripe this milestone has not verified against a real dispute.
      // `RevenueTotals` already documents dispute rows as contributing no fee,
      // so this matches the shipped contract; reading the array is a recorded
      // follow-up, not a guess to make here.
      { gross, fee: null },
      created,
      {
        parent_object_id: referenceId(object['charge']),
        order_id: referenceId(object['payment_intent']),
      },
    ),
  }
}

const NORMALIZERS: Readonly<
  Record<RevenueObjectKind, (object: Record<string, unknown>) => RevenueObservation | null>
> = {
  charge: normalizeCharge,
  refund: normalizeRefund,
  dispute: normalizeDispute,
}

/**
 * A completed Checkout Session → a match hint (CP3, D6 signal 2).
 *
 * Returns null when the session carries nothing worth keying on. "Nothing" is
 * strictly the *session id*: without it there is no uniqueness key, so a
 * redelivery would insert a second row rather than update the first, and the
 * bound that keeps provider retries from becoming unbounded rows would be gone.
 *
 * A session with an id but no `client_reference_id` **is** kept, because
 * `customer` alone still yields a `customer_hash` on the charge, and because a
 * session that completed without a PaymentIntent (zero-amount, or an async
 * payment method that settles later) is exactly the case whose charge arrives
 * afterwards and would otherwise have nothing to join to.
 *
 * `customer_details.email` is deliberately not read. D-102 forbids storing it,
 * the api cannot hash it, and a field read here would be a field one refactor
 * away from a column.
 */
function normalizeCheckoutHint(
  object: Record<string, unknown>,
  eventAt: Date,
): RevenueMatchHint | null {
  const checkoutSessionId = asString(object['id'])
  if (checkoutSessionId === null || checkoutSessionId === '') return null

  return {
    checkoutSessionId,
    // The PaymentIntent this session created — the charge's `order_id`, and the
    // only key the two objects share.
    orderId: referenceId(object['payment_intent']),
    clientReferenceId: asString(object['client_reference_id']) ?? '',
    customerId: referenceId(object['customer']),
    // The session's own completion time when Stripe reports one, else the
    // event's. `created` on a Checkout Session is when the session was *opened*,
    // which can be an hour before it completed, so the event time is the more
    // honest stamp for "this is when the match became true".
    occurredAt: eventAt,
  }
}

// --- Lifecycle normalizers (Perier gap 7) ------------------------------------

const toIso = (value: unknown): string | null => unixToDate(value)?.toISOString() ?? null

/**
 * One subscription item → a licensed recurring item, or null.
 *
 * Reads `price` (every current API version) and falls back to the legacy
 * `plan`, whose interval fields sit on the plan itself rather than under
 * `recurring`. Metered items and prices with no integer `unit_amount` (tiered,
 * or a decimal amount) are skipped: their monthly amount is not knowable before
 * the invoice, and a guessed one would be MRR that never existed.
 */
function normalizeSubscriptionItem(item: Record<string, unknown>): RevenueSubscriptionItem | null {
  const price = asRecord(item['price']) ?? asRecord(item['plan'])
  if (!price) return null
  const recurring = asRecord(price['recurring']) ?? price
  if (asString(recurring['usage_type']) === 'metered') return null
  const interval = asString(recurring['interval'])
  const intervalCount = asInteger(recurring['interval_count']) ?? 1
  const unitAmount = asInteger(price['unit_amount']) ?? asInteger(price['amount'])
  const priceId = asString(price['id'])
  if (priceId === null || unitAmount === null || !isSubscriptionInterval(interval)) return null
  return {
    price_id: priceId,
    product_id: referenceId(price['product']),
    unit_amount_minor: unitAmount,
    quantity: asInteger(item['quantity']) ?? 1,
    interval,
    interval_count: intervalCount,
  }
}

/** A subscription's (or a `previous_attributes`') item list, sorted by price. */
function subscriptionItems(itemsField: unknown): RevenueSubscriptionItem[] | null {
  const list = asRecord(itemsField)
  const data = list?.['data']
  if (!Array.isArray(data)) return null
  const items: RevenueSubscriptionItem[] = []
  for (const row of data) {
    const item = asRecord(row)
    const normalized = item === null ? null : normalizeSubscriptionItem(item)
    if (normalized) items.push(normalized)
  }
  return items.sort((a, b) =>
    a.price_id < b.price_id ? -1 : a.price_id > b.price_id ? 1 : a.quantity - b.quantity,
  )
}

/**
 * A Stripe subscription → its normalized snapshot.
 *
 * Null without an id, a `created` or a currency (the subscription's own, else
 * its first price's): none of those can be defaulted honestly. No customer
 * email or name is read — the customer is its opaque `cus_…` id.
 */
function normalizeSubscription(
  object: Record<string, unknown>,
  snapshotAt: Date,
): RevenueSubscriptionObservation | null {
  const subscriptionId = asString(object['id'])
  const created = toIso(object['created'])
  if (subscriptionId === null || created === null) return null

  const itemsList = asRecord(object['items'])?.['data']
  const firstItem = Array.isArray(itemsList) ? asRecord(itemsList[0]) : null
  const firstPrice = asRecord(firstItem?.['price']) ?? asRecord(firstItem?.['plan'])
  const currency = (
    asString(object['currency']) ??
    asString(firstPrice?.['currency']) ??
    ''
  ).toLowerCase()
  if (currency === '') return null

  return {
    subscriptionId,
    snapshotAt,
    normalized: {
      status: (asString(object['status']) ?? 'active').toLowerCase(),
      livemode: object['livemode'] === true,
      customer_id: referenceId(object['customer']),
      currency,
      items: subscriptionItems(object['items']) ?? [],
      created_at: created,
      started_at: toIso(object['start_date']) ?? created,
      trial_start: toIso(object['trial_start']),
      trial_end: toIso(object['trial_end']),
      cancel_at_period_end: object['cancel_at_period_end'] === true,
      cancel_at: toIso(object['cancel_at']),
      canceled_at: toIso(object['canceled_at']),
      ended_at: toIso(object['ended_at']),
    },
  }
}

/**
 * The changes `customer.subscription.updated`'s `previous_attributes` reveals.
 *
 * `previous_attributes` holds the OLD value of every field the update changed,
 * and only those. So:
 *
 * - `items` (or the legacy `plan`) present → the plan moved. A `plan_changed`
 *   is emitted only when the monthly-normalized MRR actually differs: a
 *   quantity-neutral price swap at the same amount is not expansion.
 * - `cancel_at_period_end` or `cancel_at` present → the scheduled-cancellation
 *   state may have flipped. Compared as "was scheduled" vs "is scheduled", so
 *   Stripe setting both fields in one update is one change, not two.
 */
function subscriptionChangesFrom(input: {
  readonly eventId: string
  readonly eventAt: Date
  readonly previous: Record<string, unknown>
  readonly current: RevenueSubscriptionObservation
}): RevenueSubscriptionChange[] {
  const { previous, current } = input
  const snapshot = current.normalized
  const changes: RevenueSubscriptionChange[] = []
  const base = {
    subscriptionId: current.subscriptionId,
    providerEventId: input.eventId,
    occurredAt: input.eventAt,
  }

  let previousItems: RevenueSubscriptionItem[] | null = null
  if ('items' in previous) previousItems = subscriptionItems(previous['items'])
  else if ('plan' in previous) {
    const plan = asRecord(previous['plan'])
    const item = plan === null ? null : normalizeSubscriptionItem({ plan, quantity: 1 })
    previousItems = item === null ? null : [item]
  }
  if (previousItems !== null) {
    const fromMrr = subscriptionMrrMinor(previousItems)
    const toMrr = subscriptionMrrMinor(snapshot.items)
    if (fromMrr !== toMrr) {
      changes.push({ ...base, kind: 'plan_changed', fromMrrMinor: fromMrr, toMrrMinor: toMrr })
    }
  }

  const touchesCancel = 'cancel_at_period_end' in previous || 'cancel_at' in previous
  if (touchesCancel) {
    const isScheduled = snapshot.cancel_at_period_end || snapshot.cancel_at !== null
    const wasScheduled =
      ('cancel_at_period_end' in previous
        ? previous['cancel_at_period_end'] === true
        : snapshot.cancel_at_period_end) ||
      ('cancel_at' in previous ? previous['cancel_at'] !== null : snapshot.cancel_at !== null)
    if (!wasScheduled && isScheduled) {
      changes.push({ ...base, kind: 'cancel_scheduled', fromMrrMinor: 0, toMrrMinor: 0 })
    } else if (wasScheduled && !isScheduled && snapshot.ended_at === null) {
      changes.push({ ...base, kind: 'cancel_undone', fromMrrMinor: 0, toMrrMinor: 0 })
    }
  }
  return changes
}

/** The first paid entry of a basil invoice's expanded `payments` list. */
function paidInvoicePayment(object: Record<string, unknown>): Record<string, unknown> | null {
  const data = asRecord(object['payments'])?.['data']
  if (!Array.isArray(data)) return null
  for (const row of data) {
    const payment = asRecord(row)
    if (payment && asString(payment['status']) === 'paid') return payment
  }
  return null
}

/** PaymentIntent and charge off an InvoicePayment, in either published shape:
 * `payment: { type, payment_intent | charge }` (basil) or top-level fields. */
function invoicePaymentRefs(payment: Record<string, unknown>): {
  orderId: string
  chargeId: string
} {
  const inner = asRecord(payment['payment'])
  return {
    orderId: referenceId(inner?.['payment_intent']) || referenceId(payment['payment_intent']),
    chargeId: referenceId(inner?.['charge']) || referenceId(payment['charge']),
  }
}

/**
 * A paid invoice → the hint linking its payment to its subscription.
 *
 * Reads both shapes: pre-basil (`subscription`, `payment_intent`, `charge` on
 * the invoice) and basil (`parent.subscription_details.subscription`, and the
 * PaymentIntent on an expanded `payments` entry). A basil webhook carries no
 * `payments` (it is includable, and a webhook is not a request), so its hint has
 * no PaymentIntent until `invoice_payment.paid` fills it forward. No amount is
 * read: the money is on the charge.
 */
function normalizeInvoiceHint(
  object: Record<string, unknown>,
  fallbackAt: Date,
): RevenueInvoiceHint | null {
  const invoiceId = asString(object['id'])
  if (invoiceId === null || invoiceId === '') return null
  const subscriptionDetails = asRecord(asRecord(object['parent'])?.['subscription_details'])
  const payment = paidInvoicePayment(object)
  const refs = payment === null ? { orderId: '', chargeId: '' } : invoicePaymentRefs(payment)
  return {
    invoiceId,
    subscriptionId:
      referenceId(object['subscription']) || referenceId(subscriptionDetails?.['subscription']),
    billingReason: asString(object['billing_reason']) ?? '',
    orderId: referenceId(object['payment_intent']) || refs.orderId,
    chargeId: referenceId(object['charge']) || refs.chargeId,
    customerId: referenceId(object['customer']),
    occurredAt: unixToDate(asRecord(object['status_transitions'])?.['paid_at']) ?? fallbackAt,
  }
}

/**
 * `invoice_payment.paid` → a partial hint: the invoice and its PaymentIntent.
 * When the event's `invoice` is expanded, the invoice's own fields come with it.
 */
function normalizeInvoicePaymentHint(
  object: Record<string, unknown>,
  eventAt: Date,
): RevenueInvoiceHint | null {
  const expanded = asRecord(object['invoice'])
  const fromInvoice = expanded === null ? null : normalizeInvoiceHint(expanded, eventAt)
  const invoiceId = fromInvoice?.invoiceId ?? asString(object['invoice'])
  if (invoiceId === null || invoiceId === '') return null
  const refs = invoicePaymentRefs(object)
  return {
    invoiceId,
    subscriptionId: fromInvoice?.subscriptionId ?? '',
    billingReason: fromInvoice?.billingReason ?? '',
    orderId: refs.orderId || (fromInvoice?.orderId ?? ''),
    chargeId: refs.chargeId || (fromInvoice?.chargeId ?? ''),
    customerId: fromInvoice?.customerId ?? '',
    occurredAt: unixToDate(asRecord(object['status_transitions'])?.['paid_at']) ?? eventAt,
  }
}

/**
 * The lifecycle branch of `normalizeEvent`: subscription snapshots, their
 * changes, and invoice hints. Like the checkout hint, nothing here touches a
 * money head, so the event has no observations; it is `processed` when it
 * produced anything and `unsupported_object_shape` when its object was
 * unreadable.
 */
function normalizeLifecycleEvent(
  event: Record<string, unknown>,
  base: { eventId: string; eventType: string; eventAt: Date },
): RevenueNormalizeOutcome {
  const data = asRecord(event['data'])
  const object = asRecord(data?.['object'])
  if (!object) return ignored(base, 'unsupported_object_shape')

  if (SUBSCRIPTION_EVENTS.has(base.eventType)) {
    // The event's `created`, not the subscription's: the webhook ordering
    // input, exactly as for a money head.
    const observation = normalizeSubscription(object, base.eventAt)
    if (!observation) return ignored(base, 'unsupported_object_shape')
    const previous = asRecord(data?.['previous_attributes'])
    const changes =
      base.eventType === 'customer.subscription.updated' && previous !== null
        ? subscriptionChangesFrom({
            eventId: base.eventId,
            eventAt: base.eventAt,
            previous,
            current: observation,
          })
        : []
    return {
      ok: true,
      event: {
        ...base,
        observations: [],
        subscriptions: [observation],
        ...(changes.length === 0 ? {} : { subscriptionChanges: changes }),
      },
    }
  }

  const hint = INVOICE_EVENTS.has(base.eventType)
    ? normalizeInvoiceHint(object, base.eventAt)
    : base.eventType === INVOICE_PAYMENT_EVENT
      ? normalizeInvoicePaymentHint(object, base.eventAt)
      : null
  if (!hint) return ignored(base, 'unsupported_object_shape')
  return { ok: true, event: { ...base, observations: [], invoiceHints: [hint] } }
}

// --- HTTP helpers ------------------------------------------------------------

/**
 * `Retry-After`, in milliseconds.
 *
 * Stripe sends the seconds form. The HTTP-date form is accepted too because the
 * spec allows it and a header we misread is a sync that hammers a rate-limited
 * account. Bounded at five minutes: a header asking a leased job to sleep for an
 * hour is a header to disregard, since the runner's own backoff will bring the
 * job back sooner and more safely than an in-job sleep of that length.
 */
const MAX_RETRY_AFTER_MS = 300_000

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (header === null) return undefined
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
  }
  const at = Date.parse(header)
  if (Number.isNaN(at)) return undefined
  return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS)
}

interface StripeGetSuccess {
  readonly ok: true
  readonly body: Record<string, unknown>
}
interface StripeGetFailure {
  readonly ok: false
  readonly reason: 'unavailable' | 'unauthorized' | 'invalid_cursor'
  readonly detail: string
  readonly retryAfterMs?: number
  /** Stripe answered 404: the object is not there, as opposed to the request
   * being wrong. Only `fetchObject` has a use for the distinction. */
  readonly missing?: boolean
}

/**
 * One authenticated GET, with every failure typed.
 *
 * ## Why a residual 4xx means two different things
 *
 * Every path and query string this module sends is built here, so there is no
 * shape of request a *customer* can make invalid — with exactly one exception,
 * and it is the one that matters. A list request carries `starting_after`, which
 * is a **stored value**: a cursor persisted before a window changed, or one
 * naming an object the account has since deleted, makes Stripe answer 400 or
 * 404 for a request that is otherwise perfect.
 *
 * Folding that into `unauthorized` would be a misdiagnosis with teeth — a good
 * credential flipped to `degraded`, a terminal backfill, and a customer told to
 * check a key that works. So `cursorSensitive` splits the residual 4xx: on a
 * list path it becomes `invalid_cursor` (drop the cursor and re-walk), and
 * everywhere else it stays `unauthorized`, whose recovery — check the key and
 * its permissions — is the actionable one.
 */
async function stripeGet(
  fetchImpl: typeof fetch,
  secretKey: string,
  path: string,
  options: { readonly cursorSensitive?: boolean; readonly stripeVersion?: string } = {},
): Promise<StripeGetSuccess | StripeGetFailure> {
  let response: Response
  try {
    response = await fetchImpl(`${STRIPE_API_BASE}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${secretKey}`,
        ...(options.stripeVersion === undefined ? {} : { 'stripe-version': options.stripeVersion }),
      },
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    })
  } catch {
    // DNS, TLS, a reset socket or our own deadline. All of them mean "we could
    // not ask", and none is evidence about the customer's key.
    return { ok: false, reason: 'unavailable', detail: 'stripe request did not complete' }
  }

  if (response.status === 429) {
    const after = retryAfterMs(response)
    return {
      ok: false,
      reason: 'unavailable',
      detail: 'stripe responded 429',
      ...(after === undefined ? {} : { retryAfterMs: after }),
    }
  }
  if (response.status >= 500) {
    return {
      ok: false,
      reason: 'unavailable',
      detail: `stripe responded ${String(response.status)}`,
    }
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: 'unauthorized',
      detail: `stripe responded ${String(response.status)}`,
    }
  }
  // The residual 4xx. On a list path the only variable the request carries is
  // the stored cursor, so this is a cursor problem; anywhere else it is the key.
  const residual: StripeGetFailure['reason'] =
    options.cursorSensitive === true ? 'invalid_cursor' : 'unauthorized'

  if (response.status === 404) {
    return { ok: false, reason: residual, detail: 'stripe responded 404', missing: true }
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok || body === null) {
    return {
      ok: false,
      reason: residual,
      detail: `stripe responded ${String(response.status)}`,
    }
  }
  return { ok: true, body }
}

/** Unix seconds, for `created[gte]` / `created[lte]`. */
const unixSeconds = (at: Date): number => Math.floor(at.getTime() / 1000)

const LIST_PATHS: Readonly<Record<RevenueSyncResource, string>> = {
  charges: '/v1/charges',
  refunds: '/v1/refunds',
  disputes: '/v1/disputes',
}

const OBJECT_PATHS: Readonly<Record<RevenueObjectKind, string>> = {
  charge: '/v1/charges',
  refund: '/v1/refunds',
  dispute: '/v1/disputes',
}

/**
 * Which kinds carry a `balance_transaction` worth expanding.
 *
 * Expansion is not a second request — Stripe resolves the reference inside the
 * response it was already going to send — so this is the difference between a
 * fee that costs nothing and a fee that costs one request per object. Disputes
 * are excluded because their settlement records are an array under a different
 * field; see `normalizeDispute`.
 *
 * Asking for it on a *list* costs one expansion per row rather than per
 * request, which is exactly the shape a hundred-row page wants.
 */
const FEE_BEARING: Readonly<Record<RevenueObjectKind, boolean>> = {
  charge: true,
  refund: true,
  dispute: false,
}

// --- The adapter -------------------------------------------------------------

export function createStripeRevenueAdapter(
  fetchImpl: typeof fetch = fetch,
): RevenueAdapter & RevenueLifecycleAdapter {
  return {
    providerId: STRIPE_REVENUE_PROVIDER_ID,

    async verifyCredential(secretKey: string): Promise<RevenueCredentialVerification> {
      let response: Response
      try {
        response = await fetchImpl(`${STRIPE_API_BASE}${PROBE_PATH}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${secretKey}` },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
      } catch {
        // DNS, TLS, a reset socket or our own deadline. All of them mean the
        // same thing to the customer — we could not ask — and none of them is
        // evidence about their key.
        return { outcome: 'unavailable', detail: 'stripe probe did not complete' }
      }

      if (response.status === 401 || response.status === 403) {
        // 401 is a key Stripe does not recognise (revoked, mistyped, wrong
        // account); 403 is a restricted key without `Charges` read. Both are the
        // customer's to fix in their own dashboard, which is why they share an
        // outcome — the recovery is one sentence for either.
        return { outcome: 'unauthorized', detail: `stripe responded ${String(response.status)}` }
      }
      if (response.status === 429 || response.status >= 500) {
        return { outcome: 'unavailable', detail: `stripe responded ${String(response.status)}` }
      }
      if (!response.ok) {
        // The request is built entirely by this module, so there is no shape of
        // it a customer could make invalid. A residual 4xx therefore means the
        // key did not buy the read, and `unauthorized` is the outcome whose
        // recovery — check the key and its permissions — is the actionable one.
        return { outcome: 'unauthorized', detail: `stripe responded ${String(response.status)}` }
      }

      // The body is deliberately not read, let alone returned: it is a page of a
      // customer's real charges, and this call's only question is answered by
      // the status line.
      return { outcome: 'ok' }
    },

    /**
     * Signature verification, delegated whole to the M3 verifier.
     *
     * `verifyStripeSignature` already takes the endpoint secret as a parameter —
     * it was written that way in M3 so tests could sign with a test secret — so
     * the per-credential secret this milestone introduced needed no change to
     * the security-critical code at all. Constant-time comparison, multiple `v1`
     * candidates during a rotation, and the replay tolerance all come with it.
     */
    verifyWebhook(input): RevenueWebhookVerification {
      const verified = verifyStripeSignature({
        rawBody: input.rawBody,
        // The pre-resolved header when a caller had one, else this adapter's own
        // header out of the delivery's full set. The route stopped resolving
        // header names when the second provider landed — Polar's signature needs
        // three headers and its event id is one of them, which a provider→name
        // map cannot express — so the set is now what arrives and picking from
        // it is the adapter's job. Byte-identical either way: the same string
        // reaches the same verifier.
        header: input.signatureHeader ?? input.headers?.['stripe-signature'],
        secret: input.signingSecret,
        ...(input.now === undefined ? {} : { now: input.now }),
      })
      return verified.ok ? { ok: true } : { ok: false, reason: verified.reason }
    },

    normalizeEvent(parsedEvent: unknown): RevenueNormalizeOutcome {
      const event = asRecord(parsedEvent)
      const eventId = event ? asString(event['id']) : null
      const eventType = event ? asString(event['type']) : null
      const eventAt = event ? unixToDate(event['created']) : null
      if (!event || eventId === null || eventType === null || eventAt === null) {
        // Nothing to ledger: the ledger's uniqueness key is an id this body does
        // not have, so recording it would create a row a redelivery could never
        // match.
        return { ok: false, reason: 'malformed_event' }
      }

      const base = { eventId, eventType, eventAt }

      if (!(eventType in CONSUMED_EVENTS)) {
        return ignored(base, 'unhandled_event_type')
      }
      const kind = CONSUMED_EVENTS[eventType]
      if (kind === null || kind === undefined) {
        // Understood and carrying no money object — a checkout session or a
        // subscription change. Acked, ledgered, and distinct from "we do not
        // read this type" so the two are separable in the ledger.
        //
        // A completed checkout is the one member of this branch that still
        // carries something worth keeping: the matching hint (D6 signal 2). It
        // updates no object head — see `normalizeCheckoutHint` and the
        // `CONSUMED_EVENTS` entry — so the event stays observation-free and the
        // hint travels in its own list.
        if (eventType === 'checkout.session.completed') {
          const session = asRecord(asRecord(event['data'])?.['object'])
          const hint = session === null ? null : normalizeCheckoutHint(session, eventAt)
          if (hint) {
            return { ok: true, event: { ...base, observations: [], hints: [hint] } }
          }
          return ignored(base, 'no_observations')
        }
        return normalizeLifecycleEvent(event, base)
      }

      const object = asRecord(asRecord(event['data'])?.['object'])
      if (!object) return ignored(base, 'unsupported_object_shape')

      const observation = NORMALIZERS[kind](object)
      if (!observation) return ignored(base, 'unsupported_object_shape')

      return {
        ok: true,
        event: {
          ...base,
          // **The event's `created`, not the object's.** The webhook's ordering
          // input is when the provider said this state was true; the object's
          // own creation time never moves, so using it would make every update
          // to one charge carry the same snapshot time and collapse into a
          // permanent equal-timestamp tie.
          observations: [{ ...observation, snapshotAt: eventAt }],
        },
      }
    },

    /**
     * One page of a list endpoint.
     *
     * ## Deviation from ADR-0033 D4: the walk is newest-first
     *
     * D4 says the backfill walks the window "oldest first". **Stripe cannot do
     * that.** Its list endpoints return in reverse-chronological order and offer
     * no ordering parameter on charges, refunds or disputes; `starting_after` —
     * which the same D4 sentence names as the cursor to persist — paginates
     * *forward through that* order, i.e. newest to oldest. The two halves of the
     * ADR's sentence are not simultaneously satisfiable against this provider.
     *
     * The direction is implemented as Stripe defines it, and nothing depends on
     * it: the object head's three-way decision is order-independent by
     * construction, so a refund met before its parent charge produces a head
     * with a `parent_object_id` that resolves once the charge arrives, and the
     * matching layer reads both at query time. The only thing lost is that an
     * interrupted backfill holds the *newest* slice of the window rather than
     * the oldest — which is, if anything, the more useful half to have first.
     *
     * Recorded as a "Deviation (CP2)" line under ADR-0033 D4; the ADR stays
     * Accepted, because the decision it was making (checkpointed, resumable,
     * cursor-persisted paging) is unaffected.
     */
    async listObjects(
      secretKey: string,
      resource: RevenueSyncResource,
      options: RevenueListOptions,
    ): Promise<RevenueListOutcome> {
      const query = new URLSearchParams({
        limit: String(Math.min(Math.max(options.pageSize, 1), STRIPE_LIST_PAGE_SIZE)),
        'created[gte]': String(unixSeconds(options.windowStart)),
        'created[lte]': String(unixSeconds(options.windowEnd)),
      })
      if (options.cursor !== null && options.cursor !== '') {
        query.set('starting_after', options.cursor)
      }
      // One expansion for the whole page, resolved server-side inside the
      // response this request was already making. `append`, not `set`: the
      // parameter is a list in Stripe's encoding even with a single member.
      if (FEE_BEARING[REVENUE_SYNC_RESOURCE_KINDS[resource]]) {
        query.append('expand[]', 'data.balance_transaction')
      }

      const result = await stripeGet(
        fetchImpl,
        secretKey,
        `${LIST_PATHS[resource]}?${query.toString()}`,
        // The one request this module makes that carries a stored value, so the
        // one whose residual 4xx is a cursor problem rather than a key problem.
        { cursorSensitive: options.cursor !== null && options.cursor !== '' },
      )
      if (!result.ok) return failure(result)

      const data = result.body['data']
      if (!Array.isArray(data)) {
        // A list response with no `data` array is not a page we can walk, and
        // treating it as an empty page would silently complete a resource that
        // was never read. `unavailable` rather than `unauthorized`: the key
        // clearly worked, something else did not.
        return { ok: false, reason: 'unavailable', detail: 'stripe list response has no data' }
      }

      const kind = REVENUE_SYNC_RESOURCE_KINDS[resource]
      const observations: RevenueObservation[] = []
      let lastId: string | null = null
      for (const row of data) {
        const object = asRecord(row)
        if (!object) continue
        // Advanced for every row, including one this build cannot read: the
        // cursor is Stripe's pagination position, not our success marker, and
        // stopping it at an unreadable row would make the walk loop on it
        // forever.
        lastId = asString(object['id']) ?? lastId
        const observation = NORMALIZERS[kind](object)
        // A list row's snapshot time is the OBJECT's own `created` (D4). It is
        // what `NORMALIZERS` already set, so nothing overrides it here — and
        // that is the property that makes a backfill row structurally unable to
        // outrank a newer webhook for the same object.
        if (observation) observations.push(observation)
      }

      const hasMore = result.body['has_more'] === true
      return {
        ok: true,
        page: {
          observations,
          // Null at the end of the walk rather than the last id, so a caller
          // that stores it verbatim records "finished" rather than a position it
          // would resume from and re-read.
          nextCursor: hasMore ? lastId : null,
          hasMore,
        },
      }
    },

    async fetchObject(
      secretKey: string,
      objectKind: RevenueObjectKind,
      objectId: string,
    ): Promise<RevenueFetchOutcome> {
      // The tie-break path. It expands for the same reason the list does — and
      // it matters more here, because this fetch is the authoritative answer
      // that gets force-applied, so a fee missing from it would be written over
      // a fee the sweep had already learned.
      const expand = FEE_BEARING[objectKind] ? '?expand[]=balance_transaction' : ''
      const result = await stripeGet(
        fetchImpl,
        secretKey,
        `${OBJECT_PATHS[objectKind]}/${encodeURIComponent(objectId)}${expand}`,
      )
      if (!result.ok) {
        // A 404 is a *success* for the caller's purpose: the tie-break asks
        // "what is true now", and "this object does not exist" is an answer.
        // Reporting it as a failure would leave the webhook's ledger row
        // `received` and make Stripe redeliver forever over an object it has
        // itself forgotten.
        if (result.missing === true) return { ok: true, observation: null, missing: true }
        return failure(result)
      }

      const observation = NORMALIZERS[objectKind](result.body)
      if (!observation) {
        return { ok: false, reason: 'unavailable', detail: 'stripe object could not be read' }
      }
      return { ok: true, observation }
    },

    /**
     * One page of subscriptions or paid invoices (Perier gap 7), pinned to
     * `STRIPE_LIFECYCLE_API_VERSION`.
     *
     * - Subscriptions are listed with `status=all`: Stripe's default leaves out
     *   canceled subscriptions, and a churned subscription is exactly what
     *   churn is computed from.
     * - Invoices are listed `status=paid` with `data.payments` expanded, so one
     *   request per page yields the full hint — billing reason, subscription and
     *   PaymentIntent — with no request per invoice.
     *
     * Newest first and `starting_after`-paged, exactly like `listObjects`.
     */
    async listLifecycle(
      secretKey: string,
      resource: RevenueLifecycleSyncResource,
      options: RevenueListOptions,
    ): Promise<RevenueLifecycleListOutcome> {
      const query = new URLSearchParams({
        limit: String(Math.min(Math.max(options.pageSize, 1), STRIPE_LIST_PAGE_SIZE)),
        'created[gte]': String(unixSeconds(options.windowStart)),
        'created[lte]': String(unixSeconds(options.windowEnd)),
      })
      if (resource === 'subscriptions') {
        query.set('status', 'all')
      } else {
        query.set('status', 'paid')
        query.append('expand[]', 'data.payments')
      }
      const hasCursor = options.cursor !== null && options.cursor !== ''
      if (hasCursor) query.set('starting_after', options.cursor as string)

      const path = resource === 'subscriptions' ? '/v1/subscriptions' : '/v1/invoices'
      const result = await stripeGet(fetchImpl, secretKey, `${path}?${query.toString()}`, {
        cursorSensitive: hasCursor,
        stripeVersion: STRIPE_LIFECYCLE_API_VERSION,
      })
      if (!result.ok) return failure(result)

      const data = result.body['data']
      if (!Array.isArray(data)) {
        return { ok: false, reason: 'unavailable', detail: 'stripe list response has no data' }
      }

      const subscriptions: RevenueSubscriptionObservation[] = []
      const invoiceHints: RevenueInvoiceHint[] = []
      let lastId: string | null = null
      for (const row of data) {
        const object = asRecord(row)
        if (!object) continue
        lastId = asString(object['id']) ?? lastId
        if (resource === 'subscriptions') {
          // A listed head's snapshot time is the subscription's own `created`
          // — the money heads' backfill rule, so a list row never outranks a
          // newer webhook (and an equal-time differing row is a tie the sync
          // resolves by re-fetching).
          const created = unixToDate(object['created'])
          const observation = created === null ? null : normalizeSubscription(object, created)
          if (observation) subscriptions.push(observation)
        } else {
          const created = unixToDate(object['created'])
          const hint = created === null ? null : normalizeInvoiceHint(object, created)
          if (hint) invoiceHints.push(hint)
        }
      }

      const hasMore = result.body['has_more'] === true
      return {
        ok: true,
        page: { subscriptions, invoiceHints, nextCursor: hasMore ? lastId : null, hasMore },
      }
    },

    async fetchSubscription(
      secretKey: string,
      subscriptionId: string,
    ): Promise<RevenueSubscriptionFetchOutcome> {
      const result = await stripeGet(
        fetchImpl,
        secretKey,
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { stripeVersion: STRIPE_LIFECYCLE_API_VERSION },
      )
      if (!result.ok) {
        if (result.missing === true) return { ok: true, observation: null }
        return failure(result)
      }
      const created = unixToDate(result.body['created'])
      const observation = created === null ? null : normalizeSubscription(result.body, created)
      if (!observation) {
        return { ok: false, reason: 'unavailable', detail: 'stripe subscription could not be read' }
      }
      return { ok: true, observation }
    },
  }
}

function ignored(
  base: { eventId: string; eventType: string; eventAt: Date },
  reason: RevenueIgnoreReason,
): RevenueNormalizeOutcome {
  return { ok: true, event: { ...base, observations: [], ignored: reason } }
}

/** A typed GET failure, narrowed to the adapter's public failure shape. */
function failure(result: StripeGetFailure): RevenueSyncFailure {
  return {
    ok: false,
    reason: result.reason,
    detail: result.detail,
    ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
  }
}

/**
 * The hash the object head compares (`revenueObservationHash`), re-exported from
 * the adapter's own module so a caller assembling an observation has one obvious
 * place to reach for it. It is domain logic — the decision input must be
 * identical no matter which provider produced the snapshot — so it lives there
 * and is only surfaced here.
 */
export { revenueObservationHash }
