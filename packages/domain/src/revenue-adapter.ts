import type {
  RevenueMatchHint,
  RevenueObjectKind,
  RevenueObservation,
  RevenueSyncResource,
} from './revenue-ingest.ts'
import type {
  RevenueInvoiceHint,
  RevenueLifecycleSyncResource,
  RevenueSubscriptionChange,
  RevenueSubscriptionObservation,
} from './subscription-lifecycle.ts'

/**
 * The revenue adapter port (ADR-0033, D1).
 *
 * An adapter owns **provider semantics only**: whether a credential the customer
 * pasted works, whether a delivered body is authentic, what a provider payload
 * means in canonical terms, and how the provider paginates. The ingest pipeline
 * owns everything else — the ledger, object versioning, checkpoints, the rate
 * budget, the ClickHouse writes — which is what makes the second provider an
 * adapter rather than an architecture.
 *
 * CP1 shipped one member (`verifyCredential`) and said the rest would arrive as
 * new members rather than as stubs; this is that widening. It is additive: the
 * registry below did not change shape, and nothing that consumed CP1's interface
 * had to move.
 *
 * Two rules hold across every member added here, and both come from the same
 * place — an adapter runs against a *customer's own* provider account with a
 * *customer's own* key:
 *
 * - **Nothing throws.** Every outcome is typed, including the network ones.
 *   A throw from the webhook path is a 500 on a signed delivery Stripe will
 *   retry forever; a throw from the sync path is an unclassified job failure.
 * - **No provider body leaves the adapter.** `detail` strings are categorized —
 *   a status line, a reason word. The body of a response to a customer's key is
 *   not ours to relay into a log, an error envelope or an audit row.
 */

/**
 * What a live credential probe learned.
 *
 * Three outcomes, and the split is the one the whole milestone is named after: a
 * rejected key is the customer's problem and must be reported as such, while an
 * unreachable provider is *ours* and must never be reported as a bad credential
 * (or, worse, as an empty result — docs snapshot 01 §12.3).
 *
 * `detail` is a safe, categorized string. Never a provider response body: the
 * probe's whole purpose is to touch a customer's account with their own
 * credential, and the body of that response is not ours to relay.
 */
export type RevenueCredentialVerification =
  | { readonly outcome: 'ok' }
  | { readonly outcome: 'unauthorized'; readonly detail: string }
  | { readonly outcome: 'unavailable'; readonly detail: string }

/**
 * The outcome of checking a delivered body's signature.
 *
 * A boolean would have been enough for the route — invalid is 400 either way —
 * but the *reason* is what an operator needs when a customer reports that their
 * webhook "does not work". A wrong secret and a replayed body twelve minutes old
 * have completely different remedies, and the route logs the category (never the
 * body, never the secret).
 */
export type RevenueWebhookVerification =
  { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * The delivery's request headers, lowercased, as the route received them.
 *
 * Added for the second provider, and it is the one thing that provider cost the
 * framework. Stripe puts everything an adapter needs in `stripe-signature` and
 * the event id in the body, so CP2's port could pass a single header string and
 * `revenue-webhook.ts` could keep a provider→header-name map. **Polar cannot be
 * served that way**: it signs Standard Webhooks style over three headers, and
 * its event body carries no id at all — the delivery identity the ledger dedupes
 * on is the `webhook-id` header. A map of header names cannot express that, and
 * growing it would mean the transport layer learning each provider's scheme.
 *
 * So the whole set travels and the adapter picks, which is the split the port
 * already draws everywhere else: transport carries bytes, the adapter owns
 * semantics. The comment in `revenue-webhook.ts` predicted this exact move.
 *
 * Values are `undefined` for absent headers rather than the key being missing,
 * so an adapter reading one it needs gets the same answer either way.
 */
export type RevenueWebhookHeaders = Readonly<Record<string, string | undefined>>

/**
 * What the transport knew about a delivery, beyond its body.
 *
 * Optional, and passed to `normalizeEvent` because for some providers the
 * event's *identity* is not in the event. A backfill has no delivery and passes
 * nothing; an adapter whose provider puts the id in the body ignores it.
 */
export interface RevenueEventContext {
  readonly headers?: RevenueWebhookHeaders
}

/**
 * Why an event carried nothing to ingest.
 *
 * Every one of these is ledgered `ignored` and acked with a 200 (D4): the
 * provider must stop retrying, because retrying will produce the same answer.
 * They are a closed vocabulary rather than free text because they are written
 * into `revenue_provider_events.result` and read back by an operator asking
 * "why is this site's revenue empty?" — a question that free-text reasons make
 * unanswerable in aggregate.
 */
export type RevenueIgnoreReason =
  /** The event type is not on the D4 allowlist. The overwhelming majority. */
  | 'unhandled_event_type'
  /** Allowlisted, but carrying no money object — a context-only event such as a
   * checkout session or a subscription change. Recorded distinctly from the
   * above because it is a *matching signal* CP4 will want to revisit. */
  | 'no_observations'
  /** Allowlisted and expected to carry an object, but the payload's shape was
   * not one this adapter can read. Rare, and worth its own category: a sustained
   * rate means the provider changed a payload and the adapter has not caught up. */
  | 'unsupported_object_shape'

export interface RevenueEventNormalization {
  /** The provider's own delivery id — the ledger's uniqueness key. */
  readonly eventId: string
  readonly eventType: string
  /** The event's own `created`. The ordering input for every observation. */
  readonly eventAt: Date
  readonly observations: readonly RevenueObservation[]
  /**
   * Matching signals the event carried that update no money object (CP3, D6).
   *
   * Separate from `observations` rather than a variant of one, because the two
   * go to different stores under different rules: an observation passes through
   * the object head's ordering decision and can change an amount, a hint is
   * upserted into `revenue_match_hints` and structurally cannot. An event may
   * legitimately produce hints and no observations — `checkout.session.completed`
   * is exactly that — which is why the ledger's "did this event do anything?"
   * question is answered by both lists rather than by the first.
   */
  readonly hints?: readonly RevenueMatchHint[]
  /**
   * Subscription lifecycle outputs (Perier gap 7; `subscription-lifecycle.ts`).
   *
   * Like `hints`, none of these carries money and none passes through the money
   * head: a subscription snapshot has its own head and its own three-way
   * decision, a change and an invoice hint are keyed upserts. An event that
   * produces only these is `processed`, not `ignored`.
   */
  readonly subscriptions?: readonly RevenueSubscriptionObservation[]
  readonly subscriptionChanges?: readonly RevenueSubscriptionChange[]
  readonly invoiceHints?: readonly RevenueInvoiceHint[]
  /** Present exactly when `observations`, `hints` and the three lifecycle lists
   * are all empty. */
  readonly ignored?: RevenueIgnoreReason
}

export type RevenueNormalizeOutcome =
  | { readonly ok: true; readonly event: RevenueEventNormalization }
  /** Not an event at all: no id, no type, no `created`. The route answers 400 —
   * there is nothing to ledger, because the ledger is keyed on an id this body
   * does not have. */
  | { readonly ok: false; readonly reason: 'malformed_event' }

export interface RevenueListPage {
  readonly observations: readonly RevenueObservation[]
  /** The provider's own pagination cursor for the next page, or null at the end.
   * Persisted verbatim in `revenue_sync_state.cursor`; the pipeline never
   * interprets it. */
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

/**
 * A list or fetch outcome.
 *
 * The two failure reasons are the `StripeClientOutcome` split that M3
 * established, and the difference is which side owns the problem:
 * `unauthorized` is the customer's key (the credential flips `degraded` and the
 * job stops), `unavailable` is the provider or the network (the job retries on
 * the runner's backoff and nothing about the credential changes).
 *
 * `retryAfterMs` carries a `429`'s `Retry-After` when the provider sent one, so
 * a rate-limited sync waits the interval the provider asked for instead of the
 * generic backoff. Optional and additive: a caller that ignores it is merely
 * less polite, never incorrect.
 */
export type RevenueSyncFailure = {
  readonly ok: false
  readonly reason:
    | 'unavailable'
    | 'unauthorized'
    /**
     * The **request** was refused, not the credential: a stored pagination
     * cursor the provider no longer recognises.
     *
     * Its own reason because folding it into `unauthorized` would be a
     * misdiagnosis with real consequences. A `starting_after` naming an object
     * that has been deleted, or a cursor persisted before a window changed,
     * makes Stripe answer 400 — and treating that as a rejected key would flip
     * a perfectly good credential to `degraded`, terminal the backfill, and tell
     * the customer to check a key that works. The recovery is to drop the cursor
     * and re-walk the window, which is a decision only the caller holding the
     * cursor can take.
     */
    | 'invalid_cursor'
  readonly detail: string
  readonly retryAfterMs?: number
}

export type RevenueListOutcome =
  { readonly ok: true; readonly page: RevenueListPage } | RevenueSyncFailure

export type RevenueFetchOutcome =
  | { readonly ok: true; readonly observation: RevenueObservation }
  /** The provider has no such object. A *success* for the caller's purpose on
   * the refetch path — an object that does not exist cannot be reconciled — so
   * it is separated from the two failures rather than folded into them. */
  | { readonly ok: true; readonly observation: null; readonly missing: true }
  | RevenueSyncFailure

export interface RevenueListOptions {
  /** The provider cursor from `revenue_sync_state`, or null to start a window. */
  readonly cursor: string | null
  readonly windowStart: Date
  readonly windowEnd: Date
  readonly pageSize: number
}

export interface RevenueAdapter {
  /** Matches a `RevenueProviderDescriptor.id`; the registry is keyed on it. */
  readonly providerId: string

  /**
   * Prove the secret works, before anything is stored.
   *
   * One cheap authenticated read against the provider. Never throws — a network
   * failure is an `unavailable` outcome, because a throw here would surface to
   * the customer as an anonymous 500 on a form they filled in correctly.
   */
  verifyCredential(secretKey: string): Promise<RevenueCredentialVerification>

  /**
   * Is this body authentic, under **this credential's** signing secret?
   *
   * Synchronous and pure: it is HMAC over bytes the caller already has, and
   * making it async would invite a caller to do something else while an
   * unverified body is in flight. The secret is a parameter rather than adapter
   * state because there is one per credential (D1's argument against Connect's
   * single shared platform secret) and the adapter is a process-wide singleton.
   */
  verifyWebhook(input: {
    readonly rawBody: string
    /**
     * One pre-resolved signature header, or `undefined`.
     *
     * The CP2 form, kept because a caller that already holds a single header —
     * a test driving the pipeline directly, a future transport that resolves one
     * itself — should not have to build a map to say so. The **route no longer
     * populates it**: it passes `headers` and lets the adapter choose, which is
     * the whole point of the refactor. An adapter that wants one named header
     * reads this first and falls back to the set.
     */
    readonly signatureHeader: string | undefined
    /**
     * Every header of the delivery.
     *
     * Optional only so that a caller holding a single header stays valid. An
     * adapter that needs more than one — Polar needs three, and one of them is
     * the event id — reads this and fails verification when it is absent, which
     * is the correct direction to fail.
     */
    readonly headers?: RevenueWebhookHeaders
    readonly signingSecret: string
    readonly now?: Date
  }): RevenueWebhookVerification

  /** The provider's event → zero or more canonical observations (D4's allowlist). */
  normalizeEvent(parsedEvent: unknown, context?: RevenueEventContext): RevenueNormalizeOutcome

  /** One page of a list endpoint, for the backfill and the reconcile sweep. */
  listObjects(
    secretKey: string,
    resource: RevenueSyncResource,
    options: RevenueListOptions,
  ): Promise<RevenueListOutcome>

  /**
   * Fetch one object authoritatively — the `refetch_from_provider` path.
   *
   * The tie-break is only worth anything if this reads the object's *current*
   * state rather than replaying what was delivered, which is why it is a real
   * request and not a re-parse.
   */
  fetchObject(
    secretKey: string,
    objectKind: RevenueObjectKind,
    objectId: string,
  ): Promise<RevenueFetchOutcome>
}

/** One page of a lifecycle list (subscriptions or invoices). */
export interface RevenueLifecycleListPage {
  readonly subscriptions: readonly RevenueSubscriptionObservation[]
  readonly invoiceHints: readonly RevenueInvoiceHint[]
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

export type RevenueLifecycleListOutcome =
  { readonly ok: true; readonly page: RevenueLifecycleListPage } | RevenueSyncFailure

export type RevenueSubscriptionFetchOutcome =
  | { readonly ok: true; readonly observation: RevenueSubscriptionObservation | null }
  | RevenueSyncFailure

/**
 * The optional lifecycle half of an adapter (Perier gap 7).
 *
 * Optional because a provider without subscriptions — or one whose lifecycle
 * this build does not read yet — must keep working unchanged: the sync walk
 * and the webhook route both check for these before using them.
 */
export interface RevenueLifecycleAdapter {
  /**
   * One page of subscriptions or invoices. `windowStart` is honoured for
   * invoices and for a reconcile sweep's subscriptions; a backfill passes the
   * epoch for subscriptions, because a subscription created three years ago and
   * still paying is part of today's MRR.
   */
  listLifecycle(
    secretKey: string,
    resource: RevenueLifecycleSyncResource,
    options: RevenueListOptions,
  ): Promise<RevenueLifecycleListOutcome>
  /** The tie-break fetch for a subscription head. `observation: null` = gone. */
  fetchSubscription(
    secretKey: string,
    subscriptionId: string,
  ): Promise<RevenueSubscriptionFetchOutcome>
}

export function hasLifecycleSupport(
  adapter: RevenueAdapter,
): adapter is RevenueAdapter & RevenueLifecycleAdapter {
  const candidate = adapter as Partial<RevenueLifecycleAdapter>
  return (
    typeof candidate.listLifecycle === 'function' &&
    typeof candidate.fetchSubscription === 'function'
  )
}

/**
 * The provider → adapter map, composed at api/worker startup.
 *
 * A `Map` rather than a module-level singleton, so a test composes a registry
 * holding exactly the adapter it means to exercise and production stays the one
 * place a real adapter is switched on. A credential naming a provider with no
 * adapter fails `adapter_unavailable` rather than half-working.
 */
export type RevenueAdapterRegistry = ReadonlyMap<string, RevenueAdapter>

export function createRevenueAdapterRegistry(
  adapters: readonly RevenueAdapter[],
): RevenueAdapterRegistry {
  const registry = new Map<string, RevenueAdapter>()
  for (const adapter of adapters) {
    if (registry.has(adapter.providerId)) {
      // A duplicate would make which adapter runs depend on array order, which
      // is exactly the kind of thing that is discovered by a customer.
      throw new Error(`duplicate revenue adapter for provider "${adapter.providerId}"`)
    }
    registry.set(adapter.providerId, adapter)
  }
  return registry
}
