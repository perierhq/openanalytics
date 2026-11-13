import { createHash } from 'node:crypto'

/**
 * The revenue ingest vocabulary and the object-head decision (ADR-0033, D4).
 *
 * This module is the CP2 twin of `stripe-reconcile.ts`, and deliberately so: the
 * M3 billing webhook taught the repository that provider deliveries are neither
 * ordered nor exactly-once, and the answer it arrived at — a delivery ledger for
 * *redelivery* plus a three-way ordering decision for *out-of-order* — is
 * repeated here rather than re-invented. What changed is the grain. Billing
 * reconciles one subscription row per account; revenue reconciles one **object
 * head** per `(site, provider, object_id)`, because a Stripe account connected
 * to two OA sites must process the same charge once per site.
 *
 * ## Why a locally minted `version` exists at all
 *
 * `revenue_objects.version` is a monotonic counter this decision hands out, and
 * CP3's ClickHouse fact is `ReplacingMergeTree(version)` ordered by
 * `(site_id, provider, object_id)`. That is the entire reason it exists:
 *
 * - ClickHouse never needs a read-modify-write. The writer already knows which
 *   generation it is inserting, because Postgres decided it under a row lock.
 * - A duplicate insert of the *same* state is harmless — same version, same
 *   values, `argMax` picks either.
 * - An out-of-order insert cannot win. A stale observation is either skipped
 *   here (so it never reaches ClickHouse) or, if it somehow did, carries a lower
 *   version than the state that superseded it.
 *
 * Provider timestamps cannot do that job. Stripe's `created` is second-granular,
 * so two observations of one charge routinely share a second, and a version
 * derived from a timestamp would make two genuinely different states
 * indistinguishable. Hence the same equal-timestamp rule M3 landed on: **equal
 * time with a different payload is not a tie to be broken by guessing, it is a
 * re-fetch from the provider.**
 *
 * ## The decision is pure
 *
 * Nothing here reads or writes. The repository
 * (`packages/postgres/src/repositories/revenue-objects.ts`) holds the row
 * `FOR UPDATE`, calls this, and applies the answer inside the same transaction —
 * which is what makes "decide then write" atomic rather than merely sequential.
 * A decision taken from a read in an earlier transaction is exactly the race
 * ADR-0021 fixed on the billing side.
 */

// --- Vocabulary --------------------------------------------------------------

/**
 * The three money objects a provider reports, and the only three CP3's fact
 * carries (D5).
 *
 * Deliberately not "payment", "invoice" or "payout": those are provider
 * *context* rather than money movement, and D2d's rule — a refund lands in the
 * refund's own bucket — needs the three that actually move an amount. Anything
 * else an allowlisted event carries is normalized into the fields of one of
 * these (an invoice's subscription id, a checkout session's reference) rather
 * than becoming a fourth kind.
 */
export const REVENUE_OBJECT_KINDS = ['charge', 'refund', 'dispute'] as const
export type RevenueObjectKind = (typeof REVENUE_OBJECT_KINDS)[number]

export function isRevenueObjectKind(value: unknown): value is RevenueObjectKind {
  return typeof value === 'string' && (REVENUE_OBJECT_KINDS as readonly string[]).includes(value)
}

/**
 * How an observation reached us. One ledger holds both (D4), so this is a
 * column rather than two tables — the overlap between a webhook and the
 * reconcile sweep is the *point* of the design, and it is only free if both
 * land in the same uniqueness domain.
 */
export const REVENUE_INGEST_SOURCES = ['webhook', 'backfill'] as const
export type RevenueIngestSource = (typeof REVENUE_INGEST_SOURCES)[number]

/** The delivery ledger's states, copied verbatim from the M3 ledger. */
export const REVENUE_LEDGER_STATUSES = ['received', 'processed', 'ignored', 'failed'] as const
export type RevenueLedgerStatus = (typeof REVENUE_LEDGER_STATUSES)[number]

/**
 * The list resources the backfill and the reconcile sweep walk, in the order
 * they must be walked (D4).
 *
 * Charges first is not cosmetic: a refund and a dispute both name a parent
 * charge, and a matching layer that meets the child first has a dangling
 * `parent_object_id` until the parent arrives. The object head tolerates it —
 * heads are independent rows — but the order costs nothing and makes an
 * interrupted backfill's intermediate state readable.
 */
export const REVENUE_SYNC_RESOURCES = ['charges', 'refunds', 'disputes'] as const
export type RevenueSyncResource = (typeof REVENUE_SYNC_RESOURCES)[number]

export function isRevenueSyncResource(value: unknown): value is RevenueSyncResource {
  return typeof value === 'string' && (REVENUE_SYNC_RESOURCES as readonly string[]).includes(value)
}

/** The object kind each list resource produces. */
export const REVENUE_SYNC_RESOURCE_KINDS: Readonly<Record<RevenueSyncResource, RevenueObjectKind>> =
  {
    charges: 'charge',
    refunds: 'refund',
    disputes: 'dispute',
  }

// --- The canonical snapshot --------------------------------------------------

/**
 * The provider-agnostic snapshot of one money object.
 *
 * Stored as `revenue_objects.normalized` jsonb and read by CP3 to build the
 * ClickHouse fact. Three rules hold and each is a privacy or correctness
 * boundary rather than a preference:
 *
 * - **No raw provider body.** The ledger stores a `payload_hash`; the body it
 *   hashed is never persisted (D5's privacy boundary). What survives is this
 *   structure, whose every field is here because a read surface needs it.
 * - **No raw email, ever.** `customer_id` is the provider's own opaque customer
 *   id (`cus_…`), which CP3 turns into a site-scoped `customer_hash`. An email
 *   address never enters this structure in any form — see `external_hint` below
 *   for why the hashed form is absent too.
 * - **Integer minor units only.** Every amount comes from the provider's own
 *   integer field. Nothing here is ever parsed from a decimal string or
 *   multiplied by 100; `packages/contracts/src/money.ts` has forbidden float
 *   money since M0 and 03 §6.5 restates it.
 *
 * Field names are snake_case because this is a stored JSON document read by SQL
 * and by CP3's writer, not a TypeScript interface that happens to be persisted.
 */
export interface RevenueNormalizedObject {
  readonly object_kind: RevenueObjectKind
  /** Provider status, normalized to the D5 vocabulary for the kind. */
  readonly status: string
  readonly livemode: boolean
  /** Lowercase ISO-4217, as the provider reports it. */
  readonly currency: string
  /** Magnitude in minor units. The row's *sign* is a function of `object_kind`
   * and is applied at rollup/read time (D2d), never stored negative. */
  readonly gross_minor: number
  /**
   * Provider fee in minor units, denominated in `fee_currency` — **not
   * necessarily in `currency`**. Magnitude, like `gross_minor`.
   *
   * Read off the provider's settlement record (Stripe: the balance
   * transaction), which is the only place a fee exists. It is 0 both when the
   * fee is genuinely zero and when it could not be read, and those two are not
   * the same fact — `fee_currency` is what tells them apart. See its comment.
   */
  readonly fee_minor: number
  /**
   * The currency `fee_minor` is in, lowercase ISO-4217, or `''` when no fee
   * was readable.
   *
   * Three states, and the reason this field exists rather than a bare
   * `fee_minor` that is sometimes a lie:
   *
   * - `''` — **unknown**. The settlement record was not read (a webhook payload
   *   cannot expand it) or does not exist yet (an unsettled charge). `fee_minor`
   *   is 0 and `net_minor` equals `gross_minor`, because deducting a fee we have
   *   not seen would be a confident zero of exactly the kind this milestone is
   *   named after.
   * - equal to `currency` — the ordinary case. `net_minor = gross_minor -
   *   fee_minor` holds inside the row, which is the invariant the reporting
   *   conversion and the rollup's `fee = reporting_gross - reporting_net`
   *   identity both stand on.
   * - different from `currency` — the account settles in a currency it did not
   *   charge in. The fee is real and is recorded in its own currency, but it
   *   cannot be subtracted from a gross denominated in another one without an
   *   FX rate, so `net_minor` stays at `gross_minor` and the mismatch is visible
   *   rather than silently folded in. Converting it belongs to the reporting
   *   layer, which already owns rates; the ADR-0033 D2d amendment records that
   *   it is not done yet.
   */
  readonly fee_currency: string
  /**
   * `gross_minor - fee_minor` when the fee is known and same-currency, else
   * `gross_minor`. Always in `currency`.
   */
  readonly net_minor: number
  /** ISO-8601 UTC. The bucket the amount lands in (D2d). */
  readonly occurred_at: string
  /** Refund/dispute → the charge it belongs to. Empty when not applicable. */
  readonly parent_object_id: string
  /** PaymentIntent — order identity across charge retries (D6 signal 1). */
  readonly order_id: string
  readonly checkout_session_id: string
  /** The Checkout `client_reference_id` (D6 signal 2), raw. It is the site's own
   * user id, and hashing it needs a secret this service does not hold — see the
   * note on `external_hint` below. */
  readonly client_reference_id: string
  readonly subscription_id: string
  readonly product_id: string
  readonly product_name: string
  /** The provider's opaque customer id. Never an email. */
  readonly customer_id: string
  /**
   * **Deliberately absent, and this comment is the record of why.**
   *
   * D5 wants an `external_user_hash` on the ClickHouse fact: the `identify()`
   * derivation (`externalUserIdHash`) applied to `metadata.oa_external_id` or
   * the customer's email. That derivation needs `ANONYMOUS_IDENTITY_SECRET`,
   * which is on the **api's and the worker's `FORBIDDEN_KEYS` lists** — it lives
   * only on the collector, because the collector is the one service that sees a
   * raw IP and a key that can re-derive an anonymous id has no business anywhere
   * else (`packages/domain/src/env.ts`).
   *
   * So CP2 stores **nothing**: not the raw email (D-102 forbids it outright),
   * not a hash under an improvised second secret (AGENTS.md: never fabricate a
   * value a gate has not decided).
   *
   * **CP3 answered the secret question and this field is still absent.** The
   * ADR-0033 D6 amendment moved `ANONYMOUS_IDENTITY_SECRET` onto the *worker*,
   * so the derivation now happens at projection time in the one service that
   * both holds the key and never sees a raw IP — and the value lands on the
   * ClickHouse fact as `external_user_hash`, not in this stored snapshot. That
   * is the right home for it: the hash is a *projection* of the head, so a key
   * rotation or a widened resolution order is a recompute over stored facts
   * rather than a re-ingest, which is exactly the separation D6 was built to
   * preserve. `resolveRevenueExternalUserId` below is where the order is
   * decided, and it records which of D5's sources are still out of reach.
   */
  readonly external_hint?: never
}

/**
 * One observation of one object: what the pipeline hands to the object head.
 *
 * `snapshotAt` is the ordering input and its meaning differs by source, which is
 * the whole reason it is a separate field from `normalized.occurred_at`:
 *
 * - **webhook** — the *event's* `created`. When the provider said this state was
 *   true, not when the money moved.
 * - **backfill/reconcile** — the object's own `created`. A listed row carries no
 *   event time, and using the *fetch* time would make every sweep look newer
 *   than every webhook and let a stale list row overwrite a live update. With
 *   the object's own creation time, a backfill row can never outrank a webhook
 *   for an object that has since changed, by construction of the three-way rule.
 */
export interface RevenueObservation {
  readonly objectId: string
  readonly objectKind: RevenueObjectKind
  readonly snapshotAt: Date
  readonly normalized: RevenueNormalizedObject
}

// --- Matching hints (CP3) ----------------------------------------------------

/**
 * A matching signal that carries **no money**, lifted out of an event that
 * updates no object head (ADR-0033, D6 signal 2).
 *
 * The concrete case is `checkout.session.completed`: it carries the Checkout
 * Session id, the `client_reference_id` the site passed (the same stable user id
 * it gives `identify()`), the customer, and the PaymentIntent the session
 * created — and the charge that eventually settles carries **none of the first
 * three**. Stripe does not put them on the charge, so without somewhere to keep
 * them the strongest non-event matching signal in the design is simply lost.
 *
 * CP2 kept nothing from that event and said so in the adapter, for a reason that
 * has now changed: the hashing needs `ANONYMOUS_IDENTITY_SECRET`, which the
 * worker holds as of CP3 (D6 amendment). What has *not* changed is that the
 * **api** does not hold it, so a hint travels from the webhook to Postgres in
 * its raw provider form and is hashed by the worker at projection time.
 *
 * ## Why this is not an observation
 *
 * An observation goes through the object head's three-way decision, which
 * assumes one payload hash describes one complete state. A hints-only
 * observation would carry the checkout event's `created` — equal to the charge's
 * in the ordinary case, because the charge is created *by* the checkout — so it
 * would land on the equal-time-different-payload branch and spend a provider
 * request per checkout resolving a tie that is not about money. And if it
 * applied, it would bump `version` and rewrite the document that holds the
 * amounts. Neither is acceptable, so hints live in their own table with no money
 * column at all: a wrong hint changes an attribution, never a total.
 */
/**
 * ## Note for CP4's matcher: one hint can serve two charges
 *
 * A PaymentIntent may produce **several charges** — a declined attempt followed
 * by a successful retry is the ordinary case, and each is its own object with
 * its own head and its own fact row. All of them carry the same `order_id`, so
 * all of them join the *same* hint and all of them will carry the same
 * `external_user_hash` and `checkout_session_id`.
 *
 * That is correct at the fact grain: each charge really did belong to that
 * checkout. It is **not** correct to aggregate over — a matcher that counted one
 * attributed conversion per matched fact row would report two purchases for one
 * session, and a journey view would show the visitor buying twice. CP4 must
 * attribute at the `(session, order)` grain and pick a single charge per order
 * (the succeeded one; deterministically by `(occurred_at, object_id)` if more
 * than one qualifies), not per fact row.
 *
 * Recorded here rather than in CP4's future file because this is where the
 * one-hint-many-charges shape originates.
 */
export interface RevenueMatchHint {
  /** The hint's own identity — a session completes once. */
  readonly checkoutSessionId: string
  /** The PaymentIntent, which is the charge's `order_id`. Empty when the session
   * completed without a payment (zero-amount or async): the hint is kept anyway
   * and joins to nothing until a payment appears. */
  readonly orderId: string
  /** The site's own opaque user id, raw. `revenue_objects.normalized` has held
   * the same value raw since CP2; hashing happens in the worker. */
  readonly clientReferenceId: string
  /** The provider's opaque customer id. **Never an email.** */
  readonly customerId: string
  readonly occurredAt: Date
}

/**
 * Which value becomes `external_user_hash` on the ClickHouse fact, and in what
 * order (ADR-0033, D5/D6).
 *
 * D5 words it as "`metadata.oa_external_id` when present, else the customer
 * email". Neither of those is reachable from what CP2 stores, and pretending
 * otherwise would be a matching signal that silently never fires:
 *
 * - **`metadata.oa_external_id`** lives on the Stripe *Customer*, which is a
 *   separate object. `RevenueNormalizedObject` carries no metadata, and the sync
 *   walk lists charges, refunds and disputes — never customers. Reading it needs
 *   a Customer fetch, which belongs with CP4's matcher (the worker holds both
 *   the credential keyring and the identity secret, so it can fetch and hash
 *   without anything at rest seeing the value).
 * - **The customer email** is worse: D-102 forbids storing it raw, and CP2
 *   deliberately refused to. So it can only ever be hashed *in flight*, from a
 *   payload that carries it inline, by a service holding the secret. The api
 *   holds no secret and the worker sees no payload, so in CP3 that path is
 *   structurally unavailable. **Recorded as CP4's gap**, not papered over.
 *
 * What *is* available is `client_reference_id` — D6's own signal 2, present on
 * the object head when the charge carried it and otherwise on the checkout hint.
 * So the resolution order below is the ADR's order restricted to what exists,
 * with the two absent sources kept as explicit optional inputs so CP4 can supply
 * them without changing a caller.
 *
 * Returns the empty string when nothing identifying is available, which is a
 * first-class outcome: an unmatched transaction still appears in every total
 * (D6's "unmatched is a first-class outcome"), it simply has no journey.
 */
export function resolveRevenueExternalUserId(input: {
  /** From a Stripe Customer's `metadata.oa_external_id`. Unavailable in CP3. */
  readonly externalIdMetadata?: string | undefined
  /** From the object head's normalized snapshot. */
  readonly clientReferenceId?: string | undefined
  /** From a `revenue_match_hints` row joined on `order_id`. */
  readonly hintClientReferenceId?: string | undefined
  /** Only ever passed in flight, never read from storage. Unavailable in CP3. */
  readonly customerEmail?: string | undefined
}): string {
  const candidates = [
    input.externalIdMetadata,
    input.clientReferenceId,
    input.hintClientReferenceId,
    input.customerEmail,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

// --- The object head decision ------------------------------------------------

/** The stored head, as the repository reads it under `FOR UPDATE`. */
export interface RevenueObjectHead {
  readonly snapshotAt: Date
  readonly payloadHash: string
  readonly version: number
}

export type RevenueObjectDecision =
  | {
      readonly action: 'skip'
      readonly reason: 'older_snapshot' | 'duplicate_snapshot' | 'newer_version_stored'
    }
  | {
      readonly action: 'refetch_from_provider'
      readonly reason: 'equal_snapshot_differing_payload'
    }
  | {
      readonly action: 'apply'
      readonly version: number
      readonly reason: 'first_observation' | 'newer_snapshot' | 'forced'
    }

/**
 * The three-way decision, M3's rule at the object grain.
 *
 * | stored          | incoming                     | decision                |
 * | --------------- | ---------------------------- | ----------------------- |
 * | absent          | anything                     | apply, `version = 1`    |
 * | older           | strictly newer               | apply, `version + 1`    |
 * | equal           | **same** payload hash        | skip (pure duplicate)   |
 * | equal           | **different** payload hash   | re-fetch from provider  |
 * | newer           | strictly older               | skip                    |
 * | any             | forced and strictly older    | skip                    |
 *
 * The equal-and-different branch is the one that carries the milestone's
 * acceptance criterion. Provider event timestamps are second-granular, so two
 * genuinely different states of one charge can share a second — dropping the
 * second one silently loses it, and applying it blindly can revert the newer
 * one. Neither is decidable from the payloads we hold, so the caller asks the
 * provider what is true *now* and force-applies that answer.
 *
 * `force` bypasses the ambiguity, **not the ordering**. The authoritative fetch
 * happens after the lock is released, so the row may have moved on in between; a
 * forced snapshot strictly older than what is stored is still skipped. That is
 * ADR-0021's fix to `reconcileAndApplySubscription`, applied here from the start
 * rather than after a production incident.
 */
export function decideRevenueObject(
  stored: RevenueObjectHead | null,
  incoming: { readonly snapshotAt: Date; readonly payloadHash: string },
  options: { readonly force?: boolean } = {},
): RevenueObjectDecision {
  if (!stored) {
    return { action: 'apply', version: 1, reason: 'first_observation' }
  }

  const applied = stored.snapshotAt.getTime()
  const arriving = incoming.snapshotAt.getTime()

  if (options.force === true) {
    if (arriving < applied) {
      return { action: 'skip', reason: 'newer_version_stored' }
    }
    return { action: 'apply', version: stored.version + 1, reason: 'forced' }
  }

  if (arriving < applied) {
    return { action: 'skip', reason: 'older_snapshot' }
  }

  if (arriving === applied) {
    // Byte-identical restatement of a state we already hold. A redelivery, a
    // reconcile sweep re-listing the same row, or both — and none of them is
    // worth a version bump, because a new version means a new ClickHouse row.
    if (incoming.payloadHash === stored.payloadHash) {
      return { action: 'skip', reason: 'duplicate_snapshot' }
    }
    return { action: 'refetch_from_provider', reason: 'equal_snapshot_differing_payload' }
  }

  return { action: 'apply', version: stored.version + 1, reason: 'newer_snapshot' }
}

// --- Hashing -----------------------------------------------------------------

/**
 * Canonical JSON: object keys sorted, arrays in order, no whitespace.
 *
 * The hash is a *decision input* — it is what makes "equal timestamp, same
 * state" distinguishable from "equal timestamp, different state" — so it must
 * not depend on key insertion order. `JSON.stringify` preserves insertion order,
 * and two normalizations of the same object built by different code paths (the
 * webhook's event shape and the list endpoint's row shape) would otherwise hash
 * differently while being identical, turning every reconcile sweep into a
 * spurious re-fetch.
 */
/** Key-sorted, `undefined`-free copy; the hash input. Shared with the
 * subscription heads (`revenueSubscriptionHash`). */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue
      out[key] = canonicalize(record[key])
    }
    return out
  }
  return value
}

/** The stored `payload_hash` for an observation. */
export function revenueObservationHash(normalized: RevenueNormalizedObject): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(normalized)))
    .digest('hex')
}

/**
 * The synthetic ledger id a **backfill/reconcile** row is recorded under.
 *
 * A list endpoint's rows carry no event id — there is no `evt_…` to dedupe on,
 * because nothing was delivered. Without an id the ledger could not hold the
 * sync path at all, and D4's "one ledger for both paths" would collapse into
 * two.
 *
 * Deterministic per `(resource, object_id)` rather than per run, and that is the
 * property that makes the reconcile sweep's 48-hour overlap free: re-listing the
 * same charge on the next sweep produces the same id, hits the unique index and
 * inserts nothing. A per-run id would make the ledger grow with every sweep
 * while proving nothing, and a random one would make it grow *and* lie.
 *
 * The `backfill:` prefix cannot collide with a provider event id: Stripe's are
 * `evt_…`, and any provider whose ids could start with `backfill:` would be
 * caught by the `(site, provider, event_id)` uniqueness being per provider.
 */
export function revenueBackfillEventId(input: {
  readonly resource: RevenueSyncResource
  readonly objectId: string
}): string {
  return `backfill:${input.resource}:${input.objectId}`
}
