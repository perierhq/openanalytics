/**
 * Subscription lifecycle and new-vs-renewal revenue (Perier fork, DataFast gap 7).
 *
 * Pure. No I/O, no clock, no secret — the same split as `revenue-ingest.ts` and
 * `revenue-attribution.ts`: the adapter normalizes, the repository stores, the
 * worker projects, and every decision in between is a function here.
 *
 * ## What this adds, and what it deliberately does not touch
 *
 * The money pipeline (`revenue_objects` → `revenue_events` → `revenue_15m/_1d`)
 * is unchanged. A renewal is still a charge, and its amount still lands in every
 * revenue total. What this module adds sits **beside** money, never inside it:
 *
 * - **Invoice hints.** A Stripe invoice carries `billing_reason`
 *   (`subscription_create`, `subscription_cycle`, …), which is the only place
 *   Stripe says whether a charge is the first payment of a subscription or a
 *   renewal. The charge itself does not say (and since API version
 *   2025-03-31.basil it no longer even names its invoice). So the invoice is kept
 *   as a hint keyed on its PaymentIntent and charge, exactly like the checkout
 *   match hint, and a charge is classified at READ time by joining it. A hint
 *   can change a label; it can never change an amount.
 * - **Subscription heads and lifecycle facts.** The provider's subscription
 *   object, normalized, under the same three-way ordering decision the money
 *   heads use (`decideRevenueObject`), plus the changes only an event can tell us
 *   (a plan change, an undone cancellation). `planSubscriptionLifecycle` turns
 *   both into an ordered list of lifecycle facts with MRR movements, which is
 *   what MRR, churn and trial conversion are computed from.
 *
 * ## Why a read-time join rather than a column on the charge
 *
 * `invoice.paid` routinely arrives *after* `charge.succeeded`. A purchase kind
 * written onto the charge's fact at projection time would therefore be wrong
 * for exactly the ordinary case, and fixing it would need the charge re-projected
 * at a new version — a version the three-way decision mints only for a new
 * provider state, which a late invoice is not. Joining at read time has no
 * ordering problem at all: the label is right the moment both facts exist.
 *
 * ## MRR is normalized, rounded per subscription, and list-price
 *
 * - Normalized to a month: a yearly price is divided by twelve, a weekly one
 *   multiplied by 52/12, a daily one by 365/12. The division happens once per
 *   subscription and is rounded half-up to the minor unit, so €39.99/year is
 *   333 cents of MRR, not 333.25 — a total over many subscriptions can differ
 *   from "sum the yearly prices and divide" by under one minor unit each.
 * - List price × quantity of the **licensed** recurring items. Metered items
 *   have no knowable amount before the invoice, and discounts are not read: a
 *   `once` coupon (a launch code) touches only the first invoice, which is
 *   revenue and not MRR, and a `forever` coupon is recorded as a known
 *   limitation rather than guessed at.
 * - One-off purchases never enter this module. They have no subscription, so
 *   they produce no head, no lifecycle fact and no MRR — a trip pass bought in
 *   Checkout's payment mode is a charge, labelled `one_off`, and nothing else.
 */

import { createHash } from 'node:crypto'
import { canonicalize } from './revenue-ingest.ts'

// --- Vocabulary --------------------------------------------------------------

/**
 * The list resources the lifecycle walk adds to the money walk, in order.
 *
 * Kept apart from `REVENUE_SYNC_RESOURCES` on purpose: that constant is the
 * money walk every provider must answer, and adding to it would hand Polar a
 * resource it has no list for. A provider opts in to these by implementing
 * `RevenueAdapter.listLifecycle`.
 */
export const REVENUE_LIFECYCLE_SYNC_RESOURCES = ['subscriptions', 'invoices'] as const
export type RevenueLifecycleSyncResource = (typeof REVENUE_LIFECYCLE_SYNC_RESOURCES)[number]

export function isRevenueLifecycleSyncResource(
  value: unknown,
): value is RevenueLifecycleSyncResource {
  return (
    typeof value === 'string' &&
    (REVENUE_LIFECYCLE_SYNC_RESOURCES as readonly string[]).includes(value)
  )
}

/** The synthetic ledger id a listed lifecycle row is recorded under. */
export function revenueLifecycleBackfillEventId(input: {
  readonly resource: RevenueLifecycleSyncResource
  readonly objectId: string
}): string {
  return `backfill:${input.resource}:${input.objectId}`
}

export const SUBSCRIPTION_INTERVALS = ['day', 'week', 'month', 'year'] as const
export type SubscriptionInterval = (typeof SUBSCRIPTION_INTERVALS)[number]

export function isSubscriptionInterval(value: unknown): value is SubscriptionInterval {
  return typeof value === 'string' && (SUBSCRIPTION_INTERVALS as readonly string[]).includes(value)
}

/**
 * How a charge relates to a subscription, read off its invoice.
 *
 * - `new` — the first payment of a subscription (`subscription_create`). A new
 *   conversion.
 * - `renewal` — a recurring cycle (`subscription_cycle`, `subscription_threshold`).
 *   Revenue, but **not** a new conversion.
 * - `plan_change` — a proration invoice from an upgrade or downgrade
 *   (`subscription_update`). Revenue, not a new conversion.
 * - `one_off` — no subscription invoice: a one-time purchase, or a manual
 *   invoice. Counts as a conversion, never as a subscription.
 */
export const PURCHASE_KINDS = ['new', 'renewal', 'plan_change', 'one_off'] as const
export type PurchaseKind = (typeof PURCHASE_KINDS)[number]

/**
 * The purchase kind for an invoice's `billing_reason`.
 *
 * An invoice with no subscription is `one_off` whatever its reason says, which
 * is the guarantee the trip-pass case rests on: a Checkout in payment mode with
 * invoice creation on produces a `manual` invoice with no subscription, and that
 * must never be counted as a subscription event.
 *
 * `subscription` (a legacy reason Stripe still documents for invoices created by
 * the pre-2019 API) and any reason this build does not know are classified by
 * the subscription's presence alone as a `renewal` — the conservative choice,
 * since it keeps an unknown recurring payment out of the new-conversion count.
 */
export function purchaseKindFor(input: {
  readonly billingReason: string
  readonly subscriptionId: string
}): PurchaseKind {
  if (input.subscriptionId === '') return 'one_off'
  switch (input.billingReason) {
    case 'subscription_create':
      return 'new'
    case 'subscription_update':
      return 'plan_change'
    case 'subscription_cycle':
    case 'subscription_threshold':
      return 'renewal'
    case 'manual':
    case 'upcoming':
    case 'quote_accept':
    case 'automatic_pending_invoice_item_invoice':
      // Created against a customer that happens to have a subscription, but not
      // by the subscription's own billing. Not a subscription payment.
      return 'one_off'
    default:
      return 'renewal'
  }
}

/** Purchase kinds that count as a new conversion. */
export function isNewConversion(kind: PurchaseKind): boolean {
  return kind === 'new' || kind === 'one_off'
}

// --- The normalized snapshots ------------------------------------------------

/** One licensed recurring item of a subscription. */
export interface RevenueSubscriptionItem {
  readonly price_id: string
  readonly product_id: string
  /** Per-unit list price in minor units, per `interval_count` × `interval`. */
  readonly unit_amount_minor: number
  readonly quantity: number
  readonly interval: SubscriptionInterval
  readonly interval_count: number
}

/**
 * The provider-agnostic snapshot of one subscription.
 *
 * Stored as `revenue_subscriptions.normalized` jsonb and hashed for the
 * three-way decision, so every field is always present (`''`, `null` or `0`,
 * never `undefined`) — the rule `RevenueNormalizedObject` states for the same
 * reason. Timestamps are ISO-8601 UTC strings or `null`.
 *
 * No email, no name, no address: the customer is the provider's opaque id, which
 * the worker turns into the same site-scoped `customer_hash` the money facts
 * carry.
 */
export interface RevenueSubscriptionSnapshot {
  /** Provider status, lowercased: `trialing`, `active`, `past_due`, `unpaid`,
   * `canceled`, `incomplete`, `incomplete_expired`, `paused`. */
  readonly status: string
  readonly livemode: boolean
  readonly customer_id: string
  /** Lowercase ISO-4217. */
  readonly currency: string
  /** Licensed recurring items, sorted by `price_id` so the hash is stable. */
  readonly items: readonly RevenueSubscriptionItem[]
  readonly created_at: string
  /** When billing started (`start_date`). */
  readonly started_at: string
  readonly trial_start: string | null
  readonly trial_end: string | null
  readonly cancel_at_period_end: boolean
  /** A scheduled cancellation instant, when one is set. */
  readonly cancel_at: string | null
  /** When the cancellation was REQUESTED (Stripe sets it on scheduling too). */
  readonly canceled_at: string | null
  /** When the subscription actually ended. */
  readonly ended_at: string | null
}

/**
 * The stored `payload_hash` of a subscription head: the same canonical JSON
 * hash the money heads use, so the three-way decision means the same thing for
 * both.
 */
export function revenueSubscriptionHash(snapshot: RevenueSubscriptionSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(snapshot)))
    .digest('hex')
}

export interface RevenueSubscriptionObservation {
  readonly subscriptionId: string
  /** Webhook: the event's `created`. Backfill: the subscription's own `created`
   * — the same rule the money heads follow, so a listed row can never outrank a
   * newer webhook. */
  readonly snapshotAt: Date
  readonly normalized: RevenueSubscriptionSnapshot
}

/**
 * A change only an event can tell us about.
 *
 * A snapshot says what a subscription is now; it cannot say that it was on a
 * cheaper plan last week, or that a cancellation was scheduled and then undone.
 * Stripe's `customer.subscription.updated` carries `previous_attributes`, and
 * these are read from it. Keyed by the provider event id, so a redelivery is a
 * no-op.
 */
export const SUBSCRIPTION_CHANGE_KINDS = [
  'plan_changed',
  'cancel_scheduled',
  'cancel_undone',
] as const
export type SubscriptionChangeKind = (typeof SUBSCRIPTION_CHANGE_KINDS)[number]

export interface RevenueSubscriptionChange {
  readonly subscriptionId: string
  readonly providerEventId: string
  readonly kind: SubscriptionChangeKind
  readonly occurredAt: Date
  /** Monthly-normalized MRR before and after, original currency. Zero for the
   * cancellation kinds. */
  readonly fromMrrMinor: number
  readonly toMrrMinor: number
}

/**
 * An invoice, reduced to the link between a payment and its subscription.
 *
 * No amount: the money is on the charge. `orderId` and `chargeId` are both
 * kept because which of the two an invoice names depends on the account's API
 * version (pre-basil: `payment_intent` and `charge` on the invoice; basil: an
 * `invoice_payment` naming one or the other), and the hint is filled forward
 * from whichever events arrive.
 */
export interface RevenueInvoiceHint {
  readonly invoiceId: string
  readonly subscriptionId: string
  readonly billingReason: string
  /** PaymentIntent — the charge's `order_id`. */
  readonly orderId: string
  readonly chargeId: string
  readonly customerId: string
  readonly occurredAt: Date
}

// --- MRR normalization -------------------------------------------------------

/**
 * Monthly-normalized amount of one recurring price, in minor units.
 *
 * Integer arithmetic only, rounded half-up once: `amount × num / den` with
 * `num/den` the months-per-interval inverse. Returns 0 for a non-positive count
 * or amount rather than a negative or a NaN that would poison every sum.
 */
export function monthlyAmountMinor(input: {
  readonly amountMinor: number
  readonly interval: SubscriptionInterval
  readonly intervalCount: number
}): number {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) return 0
  if (!Number.isSafeInteger(input.intervalCount) || input.intervalCount <= 0) return 0
  // amount per month = amount × per-month factor / interval_count
  const [num, den] = MONTH_FACTOR[input.interval]
  const numerator = BigInt(input.amountMinor) * BigInt(num) * 2n
  const denominator = BigInt(den) * BigInt(input.intervalCount)
  // Half-up: floor((2·n + d) / 2d).
  return Number((numerator + denominator) / (2n * denominator))
}

/** Months-per-interval inverse, as an exact fraction `[num, den]`. */
const MONTH_FACTOR: Readonly<Record<SubscriptionInterval, readonly [number, number]>> = {
  day: [365, 12],
  week: [52, 12],
  month: [1, 1],
  year: [1, 12],
}

/** The subscription's MRR: the sum of its items' monthly amounts. */
export function subscriptionMrrMinor(items: readonly RevenueSubscriptionItem[]): number {
  let total = 0
  for (const item of items) {
    total += monthlyAmountMinor({
      amountMinor: item.unit_amount_minor * Math.max(item.quantity, 0),
      interval: item.interval,
      intervalCount: item.interval_count,
    })
  }
  return total
}

/**
 * The interval a subscription is labelled with.
 *
 * The first item's, which is the only item for every single-price subscription.
 * A mixed-interval subscription is labelled by its first item, and its MRR is
 * still exact because MRR is summed per item.
 */
export function subscriptionInterval(
  items: readonly RevenueSubscriptionItem[],
): SubscriptionInterval | '' {
  return items[0]?.interval ?? ''
}

// --- Lifecycle planning ------------------------------------------------------

/**
 * The lifecycle fact kinds.
 *
 * - `trial_started`, `trial_converted`, `trial_expired` — the trial's arc. A
 *   trial that is still running has only the first.
 * - `started` — the subscription began PAYING: at trial conversion, or at its
 *   start when there was no trial. This is the new-MRR movement.
 * - `plan_changed` — expansion or contraction, signed by `mrr_delta_minor`.
 * - `cancel_scheduled`, `cancel_undone` — intent, no MRR movement.
 * - `ended` — churn: the subscription stopped, and its running MRR leaves.
 */
export const SUBSCRIPTION_LIFECYCLE_KINDS = [
  'trial_started',
  'trial_converted',
  'trial_expired',
  'started',
  'plan_changed',
  'cancel_scheduled',
  'cancel_undone',
  'ended',
] as const
export type SubscriptionLifecycleKind = (typeof SUBSCRIPTION_LIFECYCLE_KINDS)[number]

export interface SubscriptionLifecycleFact {
  readonly kind: SubscriptionLifecycleKind
  readonly occurredAt: Date
  /** MRR movement in the subscription's own currency, minor units, signed. */
  readonly mrrDeltaMinor: number
  /** +1 when the subscription becomes paying, −1 when it churns. */
  readonly activeDelta: number
  /** +1 when a trial starts, −1 when it converts or expires. */
  readonly trialDelta: number
}

/** Statuses of a subscription that never collected a first payment. */
const NEVER_PAID_STATUSES: ReadonlySet<string> = new Set(['incomplete', 'incomplete_expired'])

/** Kinds that sort first within one instant, so a running sum never dips below
 * zero between two facts stamped the same millisecond. */
const KIND_ORDER: Readonly<Record<SubscriptionLifecycleKind, number>> = {
  trial_started: 0,
  trial_converted: 1,
  trial_expired: 2,
  started: 3,
  plan_changed: 4,
  cancel_undone: 5,
  cancel_scheduled: 6,
  ended: 7,
}

/** How close an event-derived cancellation must be to the snapshot's
 * `canceled_at` to be the same scheduling, not a second one. */
const CANCEL_SAME_INSTANT_MS = 60_000

const toDate = (value: string | null): Date | null => {
  if (value === null || value === '') return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}

/**
 * The lifecycle facts of one subscription, in order.
 *
 * Deterministic in `(snapshot, snapshotAt, changes)`, so the projection that
 * writes them can replay a batch and produce byte-identical rows. The rules:
 *
 * 1. **Trial.** `trial_started` at `trial_start`. While the status is still
 *    `trialing` the trial is running and nothing else is said about it. Once it
 *    is not: if the subscription never paid (`incomplete*`, `paused` — Stripe's
 *    status for a trial that ended without a payment method) or ended at or
 *    before the trial's end, `trial_expired`; otherwise `trial_converted` at
 *    `trial_end`, and paying starts there.
 * 2. **Started.** At conversion, else at `started_at` — never for a
 *    subscription that never paid. Its MRR is the plan in force at that moment:
 *    the `from` side of the first plan change after it, else the current plan.
 * 3. **Plan changes** after the start and before the end move MRR by
 *    `to − running`. If the running MRR still differs from the current plan
 *    afterwards (a change we never saw, e.g. before the backfill reached back),
 *    one reconciling `plan_changed` at the snapshot time closes the gap, so the
 *    sum of a live subscription's movements always equals its current MRR.
 * 4. **Ended** removes the running MRR, so the movements of an ended
 *    subscription sum to exactly zero whatever happened in between.
 * 5. **Cancellations** carry no MRR. Event-derived ones are used as they are;
 *    the snapshot adds one at `canceled_at` when a cancellation is scheduled (or
 *    was, before the end) and no event already says so — which is how a
 *    backfilled subscription with a pending cancellation is counted.
 */
export function planSubscriptionLifecycle(input: {
  readonly snapshot: RevenueSubscriptionSnapshot
  readonly snapshotAt: Date
  readonly changes: readonly RevenueSubscriptionChange[]
}): SubscriptionLifecycleFact[] {
  const s = input.snapshot
  const facts: SubscriptionLifecycleFact[] = []
  const push = (
    kind: SubscriptionLifecycleKind,
    occurredAt: Date,
    deltas: { mrr?: number; active?: number; trial?: number } = {},
  ): void => {
    facts.push({
      kind,
      occurredAt,
      mrrDeltaMinor: deltas.mrr ?? 0,
      activeDelta: deltas.active ?? 0,
      trialDelta: deltas.trial ?? 0,
    })
  }

  const status = s.status.toLowerCase()
  const startedAt = toDate(s.started_at) ?? toDate(s.created_at)
  const trialStart = toDate(s.trial_start)
  const trialEnd = toDate(s.trial_end)
  const endedAt = toDate(s.ended_at)
  const canceledAt = toDate(s.canceled_at)
  const currentMrr = subscriptionMrrMinor(s.items)

  // 1. Trial.
  let paidStart: Date | null = null
  const neverPaid = NEVER_PAID_STATUSES.has(status)
  if (trialStart !== null && trialEnd !== null && trialEnd.getTime() > trialStart.getTime()) {
    push('trial_started', trialStart, { trial: 1 })
    if (status === 'trialing' && endedAt === null) {
      // Running. Nothing more is known.
    } else if (
      neverPaid ||
      status === 'paused' ||
      (endedAt !== null && endedAt.getTime() <= trialEnd.getTime())
    ) {
      const expiredAt =
        endedAt !== null && endedAt.getTime() < trialEnd.getTime() ? endedAt : trialEnd
      push('trial_expired', expiredAt, { trial: -1 })
    } else {
      push('trial_converted', trialEnd, { trial: -1 })
      paidStart = trialEnd
    }
  } else if (!neverPaid && startedAt !== null) {
    paidStart = startedAt
  }

  // 2–4. Paying arc.
  if (paidStart !== null) {
    const endMs = endedAt?.getTime() ?? Number.POSITIVE_INFINITY
    const planChanges = input.changes
      .filter(
        (c) =>
          c.kind === 'plan_changed' &&
          c.occurredAt.getTime() > paidStart.getTime() &&
          c.occurredAt.getTime() < endMs,
      )
      .slice()
      .sort(byTimeThenId)

    const opening = planChanges[0]?.fromMrrMinor ?? currentMrr
    push('started', paidStart, { mrr: opening, active: 1 })
    let running = opening
    let lastAt = paidStart.getTime()
    for (const change of planChanges) {
      if (change.toMrrMinor !== running) {
        push('plan_changed', change.occurredAt, { mrr: change.toMrrMinor - running })
        running = change.toMrrMinor
      }
      lastAt = Math.max(lastAt, change.occurredAt.getTime())
    }
    if (endedAt === null && running !== currentMrr) {
      const at = new Date(Math.max(lastAt, input.snapshotAt.getTime()))
      push('plan_changed', at, { mrr: currentMrr - running })
      running = currentMrr
    }
    if (endedAt !== null) {
      push('ended', endedAt, { mrr: -running, active: -1 })
    }
  }

  // 5. Cancellations.
  const eventCancels = input.changes.filter((c) => c.kind === 'cancel_scheduled')
  for (const change of eventCancels) push('cancel_scheduled', change.occurredAt)
  for (const change of input.changes) {
    if (change.kind === 'cancel_undone') push('cancel_undone', change.occurredAt)
  }
  const scheduledNow = s.cancel_at_period_end || s.cancel_at !== null
  const scheduledBeforeEnd =
    endedAt !== null && canceledAt !== null && canceledAt.getTime() < endedAt.getTime() - 1000
  if (canceledAt !== null && ((endedAt === null && scheduledNow) || scheduledBeforeEnd)) {
    const alreadySaid = eventCancels.some(
      (c) => Math.abs(c.occurredAt.getTime() - canceledAt.getTime()) <= CANCEL_SAME_INSTANT_MS,
    )
    if (!alreadySaid) push('cancel_scheduled', canceledAt)
  }

  return facts.sort(
    (a, b) =>
      a.occurredAt.getTime() - b.occurredAt.getTime() || KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  )
}

function byTimeThenId(a: RevenueSubscriptionChange, b: RevenueSubscriptionChange): number {
  return (
    a.occurredAt.getTime() - b.occurredAt.getTime() ||
    (a.providerEventId < b.providerEventId ? -1 : a.providerEventId > b.providerEventId ? 1 : 0)
  )
}

/**
 * Whether a snapshot describes a subscription that is paying right now, as the
 * provider last reported it. Diagnostic for the dashboard's "active" count is
 * NOT this — that count is the running sum of `activeDelta`, which also answers
 * "how many were active on 1 March" — but this is what a test or an operator
 * compares it against.
 */
export function isPayingStatus(status: string): boolean {
  return status === 'active' || status === 'past_due' || status === 'unpaid'
}
