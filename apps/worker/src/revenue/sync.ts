import {
  REVENUE_LIFECYCLE_SYNC_RESOURCES,
  REVENUE_SYNC_RESOURCES,
  hasLifecycleSupport,
  revenueBackfillEventId,
  revenueCredentialAad,
  revenueLifecycleBackfillEventId,
  revenueObservationHash,
  revenueSubscriptionHash,
  type RevenueAdapter,
  type RevenueLifecycleAdapter,
  type RevenueLifecycleSyncResource,
  type RevenueSyncResource,
} from '@openanalytics/domain'
import type { CredentialVault } from '@openanalytics/integrations'
import type { Logger, Metrics } from '@openanalytics/observability'
import {
  applyRevenueObservation,
  applyRevenueSubscriptionObservation,
  markRevenueProviderEvent,
  readRevenueSyncState,
  recordRevenueInvoiceHints,
  recordRevenueProviderEvent,
  saveRevenueSyncState,
  type Database,
} from '@openanalytics/postgres'
import { WORKER_METRICS } from '../ingest/metrics.ts'

/**
 * The provider-list walk shared by the backfill job and the reconcile sweep
 * (ADR-0033, D4).
 *
 * One implementation, two callers, and that is the point rather than a
 * convenience: the ADR's promise is that *both paths land in the same ledger and
 * the same object head, so overlap is free*. Two implementations would make that
 * a claim rather than a property — the moment one of them normalized a snapshot
 * time differently, a reconcile sweep would start overwriting webhook state.
 *
 * ## Where the idempotency actually lives
 *
 * On the **webhook** path the ledger is a short-circuit: the same `evt_…`
 * redelivered is the same delivery, so a row already `processed` ends the work.
 *
 * On the **sync** path it is not, and treating it as one would be a bug. A list
 * row has no delivery identity — it is recorded under a deterministic synthetic
 * id (`backfill:{resource}:{object_id}`) precisely so re-listing an object
 * produces *one* ledger row instead of one per sweep — but the object's *state*
 * legitimately changes between sweeps. Short-circuiting on the row's status
 * would mean a charge refunded on Tuesday never updated, because Monday's sweep
 * had already marked its receipt `processed`.
 *
 * So the sync path always runs the observation through the object head, and the
 * **object head is what dedupes**: an unchanged object produces an identical
 * payload hash at an identical snapshot time and the three-way rule skips it
 * without a write. The ledger row is a per-object receipt, bounded in count by
 * the deterministic id, and it records the last decision worth recording.
 *
 * ## Why a list row can force-apply its own tie
 *
 * The three-way rule answers `refetch_from_provider` when an incoming snapshot
 * ties an existing one on time but differs in payload — "ask the provider what
 * is true now", because neither payload can be ordered against the other.
 *
 * On this path that request has **already happened**: the observation came out
 * of a `GET` against the provider moments ago, so it *is* the authoritative
 * answer the tie-break would go and fetch. Issuing a second request for the same
 * object would return the same bytes, cost a rate-limit unit per tied object,
 * and on a large account would spend the whole budget re-reading things it had
 * just read. So the tie resolves in place with a forced apply — and `force`
 * still refuses a strictly older snapshot, so this cannot revert anything.
 *
 * The tie is not hypothetical: a webhook head stores the *event's* `created`
 * while a list row stores the *object's*, and for a charge whose first event
 * fired at creation the two are equal — with a different payload the moment that
 * charge is later refunded.
 *
 * ## The inherent limit of a `created`-filtered sweep (recorded, not fixable here)
 *
 * Stripe's list endpoints filter on the object's **`created`**, not on when it
 * last changed. So the reconcile sweep's trailing window catches every object
 * *created* inside it — and cannot see a late change to an object created before
 * it. A `charge.updated` dropped for a charge created three days ago is not
 * repaired by any sweep short of re-walking all of history.
 *
 * What that costs is bounded, and it is worth being precise about which part of
 * the number is at risk. **Money stays correct**, because a refund and a dispute
 * are their own objects with their own `created` — they land in their own
 * buckets by D2d, inside the window, whatever happened to the parent charge's
 * update. What can go stale is the parent charge's *status* string
 * (`refunded` / `partially_refunded`) if its update event was lost. Such a
 * charge still carries its full gross and the refund row still carries the
 * reduction, so totals and time series are unaffected; a transaction list could
 * show a status one revision old. Closing it properly means listing `events`
 * over the window — which the restricted key already permits — and is recorded
 * as a follow-up rather than guessed at here.
 */

export interface RevenueSyncTarget {
  readonly credentialId: string
  readonly siteId: string
  readonly provider: string
  /** Already decrypted by the caller. Never logged, never returned. */
  readonly apiKey: string
}

export type RevenueSyncMode = 'backfill' | 'reconcile'

export interface RevenueSyncDeps {
  readonly db: Database
  readonly logger: Logger
  readonly metrics: Metrics
}

export interface RevenueSyncCounts {
  pages: number
  observations: number
  applied: number
  skipped: number
  /** Ties resolved in place by force-applying the authoritative list row. */
  tiesResolved: number
  /** Cursors the provider refused and this walk dropped. */
  cursorsReset: number
  /** Subscription heads listed by the lifecycle walk (Perier gap 7). */
  subscriptions: number
  /** Invoice hints listed by the lifecycle walk. */
  invoiceHints: number
}

export type RevenueSyncOutcome =
  | { readonly ok: true; readonly counts: RevenueSyncCounts; readonly completed: boolean }
  | {
      readonly ok: false
      readonly reason: 'unauthorized' | 'unavailable' | 'lease_lost'
      readonly detail: string
      readonly retryAfterMs?: number
      readonly counts: RevenueSyncCounts
    }

export interface RevenueSyncInput {
  readonly target: RevenueSyncTarget
  readonly adapter: RevenueAdapter
  readonly mode: RevenueSyncMode
  readonly windowStart: Date
  readonly windowEnd: Date
  readonly pageSize: number
  /**
   * Pages this **call** may walk, across every resource it touches.
   *
   * A bound rather than "walk it all", because a leased job that runs until the
   * provider says `has_more: false` is a job whose runtime is a customer's
   * transaction volume. Returning early with the cursor persisted lets the
   * runner re-claim, re-lease and continue — and makes an interrupted backfill
   * indistinguishable from a bounded one, which is exactly the property that
   * makes crash-resume boring.
   *
   * `syncAllRevenueResources` spends it as **one shared budget** across charges,
   * refunds and disputes rather than granting it to each: a per-resource bound
   * would make the real ceiling three times the documented one, and the whole
   * reason to bound it is that the number is what a lease is sized against.
   */
  readonly maxPages: number
  /**
   * Called between pages. `false` means the lease is somebody else's now and the
   * walk must stop — the cursor is already durable, so whoever holds it resumes
   * from the same place. Absent for the reconcile loop, which holds no lease.
   */
  readonly heartbeat?: () => Promise<boolean>
  readonly now?: () => Date
}

const emptyCounts = (): RevenueSyncCounts => ({
  pages: 0,
  observations: 0,
  applied: 0,
  skipped: 0,
  tiesResolved: 0,
  cursorsReset: 0,
  subscriptions: 0,
  invoiceHints: 0,
})

/**
 * A page budget spent across a whole call rather than per resource.
 *
 * Mutable and passed by reference on purpose: `syncAllRevenueResources` hands
 * the *same* object to three walks, so the third resource sees what the first
 * two spent. Handing each of them `maxPages` would have made the effective bound
 * `3 × maxPages`, which is the kind of budget error that only shows up as a lost
 * lease on the one account large enough to reach it.
 */
export interface RevenuePageBudget {
  remaining: number
}

/**
 * Walk one resource's list endpoint, page by page, persisting after each page.
 *
 * The cursor write is **after** the page's observations are applied and in a
 * statement of its own. That ordering is what makes a crash safe in the only
 * direction that matters: a crash between the applies and the cursor write
 * re-walks a page whose objects are already in the head, where the three-way
 * rule skips every one of them. The reverse ordering would skip a page whose
 * objects were never applied, and nothing downstream would ever notice.
 */
export async function syncRevenueResource(
  deps: RevenueSyncDeps,
  resource: RevenueSyncResource,
  input: RevenueSyncInput,
  budget: RevenuePageBudget = { remaining: input.maxPages },
): Promise<RevenueSyncOutcome> {
  const clock = input.now ?? (() => new Date())
  const counts = emptyCounts()
  const { target } = input

  const stored = await readRevenueSyncState(deps.db, {
    credentialId: target.credentialId,
    resource,
  })

  // A cursor is only meaningful inside the window it was taken in: it is a
  // provider position within a `created[gte..lte]` filter, and resuming it under
  // a different window would page through a sequence it never described. Both
  // callers therefore quantize their windows — the backfill to the UTC day, the
  // sweep to its own staleness interval — so consecutive claims and ticks agree
  // on the window and the cursor survives.
  const sameWindow =
    stored !== null &&
    stored.windowStart !== null &&
    stored.windowEnd !== null &&
    stored.windowStart.getTime() === input.windowStart.getTime() &&
    stored.windowEnd.getTime() === input.windowEnd.getTime()

  if (sameWindow && stored.completedAt !== null) {
    // Already walked to the end under exactly this window. Nothing to do, and
    // saying so is different from saying "no objects" — the caller reports a
    // completed resource rather than an empty one.
    return { ok: true, counts, completed: true }
  }

  let cursor = sameWindow ? stored.cursor : null

  while (budget.remaining > 0) {
    budget.remaining -= 1

    const listed = await input.adapter.listObjects(target.apiKey, resource, {
      cursor,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      pageSize: input.pageSize,
    })

    if (!listed.ok) {
      if (listed.reason === 'invalid_cursor') {
        // The provider refused the *stored cursor*, not the key: an object it no
        // longer recognises, or a position from a window that has moved.
        // Dropping it and re-walking is the recovery, and it is cheap — every
        // object re-read is already in the head, where the three-way rule skips
        // it. Degrading the credential here would be a misdiagnosis that
        // terminals the backfill and tells the customer to check a working key.
        if (cursor === null) {
          // No cursor was sent, so the refusal was not about one. Out of
          // explanations, and this is ours rather than the credential's.
          deps.metrics.increment(WORKER_METRICS.revenueSyncFailed, {
            reason: 'invalid_request',
            mode: input.mode,
          })
          return { ok: false, reason: 'unavailable', detail: listed.detail, counts }
        }
        counts.cursorsReset += 1
        cursor = null
        await saveRevenueSyncState(deps.db, {
          credentialId: target.credentialId,
          siteId: target.siteId,
          resource,
          cursor: null,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          completedAt: null,
          now: clock(),
        })
        deps.logger.warn('revenue_sync_cursor_reset', {
          site_id: target.siteId,
          credential_id: target.credentialId,
          resource,
          mode: input.mode,
          retryable: true,
        })
        continue
      }

      deps.metrics.increment(WORKER_METRICS.revenueSyncFailed, {
        reason: listed.reason,
        mode: input.mode,
      })
      return {
        ok: false,
        reason: listed.reason,
        detail: listed.detail,
        ...(listed.retryAfterMs === undefined ? {} : { retryAfterMs: listed.retryAfterMs }),
        counts,
      }
    }

    counts.pages += 1
    deps.metrics.increment(WORKER_METRICS.revenueSyncPages, { resource, mode: input.mode })

    for (const observation of listed.page.observations) {
      counts.observations += 1
      const payloadHash = revenueObservationHash(observation.normalized)
      const now = clock()

      // The per-object receipt. Deterministic id, so a re-listed object updates
      // no count and adds no row; `firstSeen` is what says this object had never
      // been seen through the sync path before.
      const recorded = await recordRevenueProviderEvent(deps.db, {
        siteId: target.siteId,
        credentialId: target.credentialId,
        provider: target.provider,
        providerEventId: revenueBackfillEventId({ resource, objectId: observation.objectId }),
        payloadHash,
        source: 'backfill',
        now,
      })

      let decided = await applyRevenueObservation(deps.db, {
        siteId: target.siteId,
        provider: target.provider,
        observation,
        payloadHash,
        now,
      })

      if (decided.decision.action === 'refetch_from_provider') {
        // Resolved in place — the observation already came from an authoritative
        // read (see the module header). `force` still refuses a strictly older
        // snapshot, so this can add a version but never revert one.
        counts.tiesResolved += 1
        deps.metrics.increment(WORKER_METRICS.revenueObservations, {
          decision: 'refetch',
          mode: input.mode,
        })
        decided = await applyRevenueObservation(deps.db, {
          siteId: target.siteId,
          provider: target.provider,
          observation,
          payloadHash,
          force: true,
          now,
        })
      }

      const applied = decided.decision.action === 'apply'
      if (applied) counts.applied += 1
      else counts.skipped += 1
      deps.metrics.increment(WORKER_METRICS.revenueObservations, {
        decision: applied ? 'apply' : 'skip',
        mode: input.mode,
      })

      // Settled only when something happened. A sweep over an unchanged window
      // is thousands of skips, and rewriting every receipt to say "still the
      // same" would be a write amplification with no reader.
      if (applied || recorded.firstSeen) {
        await markRevenueProviderEvent(deps.db, {
          id: recorded.id,
          status: applied ? 'processed' : 'ignored',
          result: {
            resource,
            mode: input.mode,
            decision: decided.decision.action,
            reason: 'reason' in decided.decision ? decided.decision.reason : undefined,
          },
          now,
        })
      }
    }

    cursor = listed.page.nextCursor
    const completed = !listed.page.hasMore
    await saveRevenueSyncState(deps.db, {
      credentialId: target.credentialId,
      siteId: target.siteId,
      resource,
      cursor,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      completedAt: completed ? clock() : null,
      now: clock(),
    })

    if (completed) return { ok: true, counts, completed: true }

    if (input.heartbeat) {
      const held = await input.heartbeat()
      if (!held) {
        return { ok: false, reason: 'lease_lost', detail: 'revenue sync lease lost', counts }
      }
    }
  }

  // The page budget ran out with more to walk. The cursor is durable, so the
  // caller comes back and continues rather than restarting.
  return { ok: true, counts, completed: false }
}

/**
 * Walk every resource in order (D4: charges → refunds → disputes).
 *
 * The order is not cosmetic: a refund and a dispute each name a parent charge,
 * so meeting the child first leaves a dangling `parent_object_id` until the
 * parent arrives. Nothing breaks — heads are independent rows and the matching
 * layer reads them at query time — but the order costs nothing and makes an
 * interrupted walk's intermediate state readable by a human.
 *
 * **One shared page budget** across the three. A per-resource bound would make
 * the real ceiling three times `maxPages`, and the whole reason the number
 * exists is that a lease is sized against it. The consequence is that a large
 * charges backlog can consume a whole call and leave refunds untouched — which
 * is correct, and is why the cursors are per resource: the next call resumes
 * charges where it stopped and reaches refunds once charges is done.
 *
 * A resource that fails stops the walk. Continuing to the next one would spend
 * budget on requests that are about to fail the same way, and would report a
 * partial sweep as a success — after which `last_synced_at` would be moved
 * forward over data that was never read, which is the fabricated freshness D4
 * forbids.
 */
export async function syncAllRevenueResources(
  deps: RevenueSyncDeps,
  input: RevenueSyncInput,
): Promise<RevenueSyncOutcome> {
  const totals = emptyCounts()
  const budget: RevenuePageBudget = { remaining: input.maxPages }
  let allCompleted = true

  for (const [index, resource] of REVENUE_SYNC_RESOURCES.entries()) {
    const outcome = await syncRevenueResource(deps, resource, input, budget)
    add(totals, outcome.counts)
    if (!outcome.ok) return { ...outcome, counts: totals }
    if (!outcome.completed) allCompleted = false

    // Out of budget with resources left: those are not "completed", they are
    // *untouched*, and reporting the call complete would let the caller stamp
    // freshness over data it never read. A resource already finished under this
    // window costs no budget on the next call (its stored `completed_at` short-
    // circuits it), so the walk converges rather than starving the tail.
    const isLast = index === REVENUE_SYNC_RESOURCES.length - 1
    if (budget.remaining <= 0 && !isLast) {
      allCompleted = false
      break
    }
  }

  // The subscription lifecycle, after money and within the same page budget
  // (Perier gap 7). Only for an adapter that has a lifecycle half.
  if (hasLifecycleSupport(input.adapter)) {
    const lifecycleInput = { ...input, adapter: input.adapter }
    for (const resource of REVENUE_LIFECYCLE_SYNC_RESOURCES) {
      if (budget.remaining <= 0) {
        // Untouched, so not complete: the next call resumes here, and a
        // finished resource costs no budget then.
        allCompleted = false
        break
      }
      const outcome = await syncRevenueLifecycleResource(deps, resource, lifecycleInput, budget)
      add(totals, outcome.counts)
      if (!outcome.ok) {
        if (outcome.reason === 'lease_lost') return { ...outcome, counts: totals }
        // A lifecycle failure never fails the money sync. Logged and counted
        // here, and the walk moves on: the next pass tries again.
        deps.metrics.increment(WORKER_METRICS.revenueLifecycleSyncFailed, {
          resource,
          reason: outcome.reason,
          mode: input.mode,
        })
        deps.logger.warn('revenue_lifecycle_sync_failed', {
          site_id: input.target.siteId,
          credential_id: input.target.credentialId,
          resource,
          mode: input.mode,
          reason: outcome.reason,
          retryable: outcome.reason !== 'unauthorized',
        })
        continue
      }
      if (!outcome.completed) allCompleted = false
    }
  }

  return { ok: true, counts: totals, completed: allCompleted }
}

/**
 * One lifecycle resource (`subscriptions` or `invoices`), paged exactly like a
 * money resource: same budget, same persisted cursor, same `invalid_cursor`
 * recovery, cursor saved after the page's rows are written.
 *
 * **The subscriptions window starts at the epoch on a backfill.** MRR is the
 * sum over every subscription still paying, and one created three years ago is
 * part of today's MRR; a backfill that read only the money window would start
 * every MRR line at a fraction of the truth. A reconcile sweep keeps its own
 * trailing window — the webhook is the fast path for state changes, and the
 * sweep's job is a missed creation, not a full re-read every quarter hour.
 * Invoices always use the money window: they label charges, and a charge
 * outside the window is not being read either.
 *
 * Subscriptions are ledgered like money heads (`backfill:subscriptions:<id>`),
 * so "why is this head at this version" has the same answer for both. Invoice
 * hints are not — they are one fill-forward statement per page, and a hint, like
 * a checkout hint, has no version decision to explain.
 */
export async function syncRevenueLifecycleResource(
  deps: RevenueSyncDeps,
  resource: RevenueLifecycleSyncResource,
  input: RevenueSyncInput & { readonly adapter: RevenueAdapter & RevenueLifecycleAdapter },
  budget: RevenuePageBudget,
): Promise<RevenueSyncOutcome> {
  const clock = input.now ?? (() => new Date())
  const counts = emptyCounts()
  const { target } = input
  const windowStart =
    resource === 'subscriptions' && input.mode === 'backfill' ? new Date(0) : input.windowStart
  const window = { windowStart, windowEnd: input.windowEnd }

  const stored = await readRevenueSyncState(deps.db, {
    credentialId: target.credentialId,
    resource,
  })
  const sameWindow =
    stored !== null &&
    stored.windowStart?.getTime() === windowStart.getTime() &&
    stored.windowEnd?.getTime() === input.windowEnd.getTime()
  if (sameWindow && stored.completedAt !== null) return { ok: true, counts, completed: true }

  let cursor = sameWindow ? stored.cursor : null
  const save = async (completedAt: Date | null) =>
    await saveRevenueSyncState(deps.db, {
      credentialId: target.credentialId,
      siteId: target.siteId,
      resource,
      cursor,
      ...window,
      completedAt,
      now: clock(),
    })

  while (budget.remaining > 0) {
    budget.remaining -= 1
    const listed = await input.adapter.listLifecycle(target.apiKey, resource, {
      cursor,
      ...window,
      pageSize: input.pageSize,
    })
    if (!listed.ok) {
      if (listed.reason === 'invalid_cursor' && cursor !== null) {
        counts.cursorsReset += 1
        cursor = null
        await save(null)
        continue
      }
      return {
        ok: false,
        reason: listed.reason === 'invalid_cursor' ? 'unavailable' : listed.reason,
        detail: listed.detail,
        ...(listed.retryAfterMs === undefined ? {} : { retryAfterMs: listed.retryAfterMs }),
        counts,
      }
    }

    counts.pages += 1
    deps.metrics.increment(WORKER_METRICS.revenueSyncPages, { resource, mode: input.mode })

    if (listed.page.invoiceHints.length > 0) {
      await recordRevenueInvoiceHints(deps.db, {
        siteId: target.siteId,
        provider: target.provider,
        hints: listed.page.invoiceHints,
        now: clock(),
      })
      counts.invoiceHints += listed.page.invoiceHints.length
    }

    for (const observation of listed.page.subscriptions) {
      counts.subscriptions += 1
      const payloadHash = revenueSubscriptionHash(observation.normalized)
      const now = clock()
      const recorded = await recordRevenueProviderEvent(deps.db, {
        siteId: target.siteId,
        credentialId: target.credentialId,
        provider: target.provider,
        providerEventId: revenueLifecycleBackfillEventId({
          resource,
          objectId: observation.subscriptionId,
        }),
        payloadHash,
        source: 'backfill',
        now,
      })
      let decided = await applyRevenueSubscriptionObservation(deps.db, {
        siteId: target.siteId,
        provider: target.provider,
        observation,
        payloadHash,
        now,
      })
      if (decided.decision.action === 'refetch_from_provider') {
        // The listed row IS the provider's current answer, fetched moments ago
        // — the same in-place resolution the money walk uses.
        counts.tiesResolved += 1
        decided = await applyRevenueSubscriptionObservation(deps.db, {
          siteId: target.siteId,
          provider: target.provider,
          observation,
          payloadHash,
          force: true,
          now,
        })
      }
      const applied = decided.decision.action === 'apply'
      if (applied) counts.applied += 1
      else counts.skipped += 1
      if (applied || recorded.firstSeen) {
        await markRevenueProviderEvent(deps.db, {
          id: recorded.id,
          status: applied ? 'processed' : 'ignored',
          result: { resource, mode: input.mode, decision: decided.decision.action },
          now,
        })
      }
    }

    cursor = listed.page.nextCursor
    const completed = !listed.page.hasMore
    await save(completed ? clock() : null)
    if (completed) return { ok: true, counts, completed: true }

    if (input.heartbeat) {
      const held = await input.heartbeat()
      if (!held) {
        return { ok: false, reason: 'lease_lost', detail: 'revenue sync lease lost', counts }
      }
    }
  }
  return { ok: true, counts, completed: false }
}

function add(into: RevenueSyncCounts, from: RevenueSyncCounts): void {
  into.pages += from.pages
  into.observations += from.observations
  into.applied += from.applied
  into.skipped += from.skipped
  into.tiesResolved += from.tiesResolved
  into.cursorsReset += from.cursorsReset
  into.subscriptions += from.subscriptions
  into.invoiceHints += from.invoiceHints
}

/**
 * Decrypt a credential's API key, or null.
 *
 * The AAD is built from the row's *own* `(credential_id, site_id)`, which is
 * what makes a ciphertext lifted onto another row undecryptable rather than
 * usable. Shared by the job and the loop so there is exactly one place that
 * derives it on this side — the api derives the identical string when it
 * encrypts, and the two agreeing is the whole guarantee.
 */
export function decryptRevenueApiKey(
  vault: CredentialVault,
  credential: {
    readonly id: string
    readonly siteId: string
    readonly encryptedApiKey: string | null
  },
): string | null {
  if (credential.encryptedApiKey === null) return null
  const outcome = vault.decrypt(
    credential.encryptedApiKey,
    revenueCredentialAad({ credentialId: credential.id, siteId: credential.siteId }),
  )
  return outcome.ok ? outcome.plaintext : null
}
