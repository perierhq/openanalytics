import type { Logger, Metrics } from '@openanalytics/observability'
import {
  REVENUE_BACKFILL_JOB_TYPE,
  REVENUE_UNAUTHORIZED_ERROR,
  failStuckRevenueDeliveries,
  listRevenueCredentialsDueForSync,
  updateRevenueCredentialState,
  type Database,
  type DueRevenueCredential,
} from '@openanalytics/postgres'
import { WORKER_METRICS } from '../ingest/metrics.ts'
import type { RevenueResources } from '../jobs/resources.ts'
import { decryptRevenueApiKey, syncAllRevenueResources } from './sync.ts'

/**
 * The revenue reconcile sweep (ADR-0033, D4).
 *
 * The webhook safety net. Webhooks are the fast path and they are not
 * guaranteed: a delivery can be dropped, answered 5xx until the provider gives
 * up, or lost while our endpoint was down. This loop re-lists a trailing window
 * for every credential whose data has gone stale, so a missed event is caught by
 * the next sweep rather than never.
 *
 * The overlap is **free**, which is the whole reason the design is allowed to be
 * this simple: both paths land in the same ledger and the same object head, so
 * re-listing an object we already hold produces an identical payload hash at an
 * identical snapshot time and the three-way rule skips it without a write.
 *
 * ## The freshness rules, which are the point of the whole loop
 *
 * 1. **`last_synced_at` moves only on a walk that reached the end of every
 *    resource.** Not on a failure, and — the subtler half — not on a *partial*
 *    success either. The page budget bounds a tick, so a large account is
 *    routinely `ok` with `completed: false`; stamping freshness there would
 *    report a credential as current while objects beyond the budget had never
 *    been read.
 * 2. **A failure never touches it at all.** A degraded credential keeps
 *    reporting when its data was last actually correct — plan 04's third
 *    acceptance criterion, and the behaviour snapshot 01 §12.3 records legacy
 *    getting wrong.
 * 3. **Nothing is ever zeroed.** An outage produces a status and a categorized
 *    `last_error`, never an empty result.
 *
 * ## The window is quantized, and that is what makes deep objects reachable
 *
 * `syncRevenueResource` resumes a stored cursor only when the window it was
 * taken in is *identical* — a provider cursor is a position inside a filtered
 * sequence. A window ending at `Date.now()` therefore changes on every tick, the
 * cursor is discarded every time, and the sweep re-reads the newest page
 * forever: an account with more objects in the window than one tick's budget
 * would have its older objects **never** re-listed.
 *
 * So the window end is floored to the staleness interval. Every tick inside one
 * interval computes the same bounds, the cursor survives, and successive ticks
 * walk deeper until the window completes — at which point `last_synced_at`
 * moves, the credential drops out of discovery, and the next interval opens a
 * fresh window.
 *
 * ## Why this cannot fight a running backfill
 *
 * **Writes are serialized by the object head.** Every observation from either
 * path goes through one `SELECT … FOR UPDATE` on `(site, provider, object_id)`
 * and is decided against what is actually stored at that moment. A backfill page
 * and a sweep page touching the same charge queue on that lock, and the loser
 * re-decides against the winner's write rather than against a stale read. The
 * worst case is a redundant version bump, which is harmless by construction:
 * versions are monotonic and CP3's `ReplacingMergeTree(version)` keeps the
 * highest.
 *
 * **Cursors cannot collide either.** Discovery excludes a never-synced
 * credential while a backfill job is live for it, which is exactly the window in
 * which the two would otherwise share `revenue_sync_state` rows; after the
 * backfill completes it sets `last_synced_at`, and the staleness rule keeps them
 * apart from then on.
 */

const DEFAULT_INTERVAL_MS = 60_000
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

/**
 * Pages one credential may walk per tick, shared across all three resources.
 *
 * Small on purpose. This is a 48-hour window on a site that is already
 * backfilled, so one page per resource is the ordinary case; the budget is what
 * stops one enormous account consuming a tick that other credentials are waiting
 * in. An account that needs more than this gets it over successive ticks, which
 * the quantized window is what makes possible.
 */
const PAGES_PER_TICK = 6

/**
 * How long a credential is left alone when the provider failed without saying
 * when to come back.
 *
 * One tick, so the behaviour with and without a `Retry-After` header differs in
 * duration rather than in kind.
 */
const DEFAULT_PROVIDER_BACKOFF_MS = 60_000

export interface RevenueReconcileDeps {
  readonly db: Database
  readonly logger: Logger
  readonly metrics: Metrics
  readonly revenue: RevenueResources
  /** `REVENUE_RECONCILE_STALE_MINUTES`. Doubles as the window quantum. */
  readonly staleMinutes: number
  /** `REVENUE_RECONCILE_BATCH`. */
  readonly batchSize: number
  readonly intervalMs?: number
  /**
   * Cooperative cancellation, checked between credentials.
   *
   * A `SIGTERM` during a provider outage would otherwise have to wait out a full
   * batch of 30-second timeouts, holding the shutdown sequence ahead of
   * `jobs.stop()` — whose leases are the thing actually worth draining. Stopping
   * mid-batch loses nothing: every cursor is persisted page by page.
   */
  readonly stopped?: () => boolean
}

/**
 * How long a ledger row may sit at `received` before the sweep settles it.
 *
 * Twenty-four hours, which is comfortably past Stripe's own retry horizon for a
 * failing endpoint. The point is that the row is only interesting *after* the
 * provider has given up — before that, the 5xx-and-redeliver path is working as
 * designed and marking the row would destroy the very state that makes the
 * redelivery reprocess it.
 */
const STUCK_DELIVERY_AGE_MS = 24 * 3_600_000

/** Deliveries the sweep may settle per tick. Bounded like every other sweep
 * here: a backlog accumulated over a weekend must not turn one tick into a
 * table-length transaction inside a process that is also ingesting events. */
const STUCK_DELIVERY_LIMIT = 200

export interface RevenueReconcileResult {
  readonly discovered: number
  /** Walks that reached the end of every resource. Only these move freshness. */
  readonly synced: number
  /** Walks that ran out of page budget. Freshness deliberately untouched. */
  readonly partial: number
  readonly failed: number
  readonly recovered: number
  /** Credentials not attempted: the loop is stopping, or the provider asked us
   * to wait. */
  readonly skipped: number
  /** Ledger rows settled `failed` by the stuck-delivery sweep. Visibility, not
   * repair — see `sweepStuckDeliveries`. */
  readonly stuckSettled: number
}

/**
 * The provider-requested backoff, in memory.
 *
 * A `Map` on the module rather than a column, deliberately. What it holds is
 * advice with a lifetime measured in seconds — "come back in 17 s" — and a
 * column for it would mean a migration, a write on every 429, and a stored value
 * that outlives its own meaning across a deploy. Losing it on restart costs one
 * extra request against a provider that will answer 429 again and re-arm it.
 *
 * Bounded by the discovery batch: only credentials the sweep actually touched
 * can be in it, and an entry is deleted the moment it expires.
 */
const backoffs = new Map<string, number>()

/** One tick. Extracted so tests drive it directly rather than through a timer. */
export async function reconcileRevenueOnce(
  deps: RevenueReconcileDeps,
  now: Date = new Date(),
): Promise<RevenueReconcileResult> {
  // Before the per-credential walk, and independent of it: the sweep is global
  // and needs no provider contact, so it must not be starved by a batch of
  // credentials that are all backing off.
  const stuckSettled = await sweepStuckDeliveries(deps, now)

  const due = await listRevenueCredentialsDueForSync(deps.db, {
    staleBefore: new Date(now.getTime() - deps.staleMinutes * MINUTE_MS),
    limit: deps.batchSize,
    backfillJobType: REVENUE_BACKFILL_JOB_TYPE,
  })

  publishLag(deps, due, now)
  if (due.length === 0) {
    return {
      discovered: 0,
      synced: 0,
      partial: 0,
      failed: 0,
      recovered: 0,
      skipped: 0,
      stuckSettled,
    }
  }

  let synced = 0
  let partial = 0
  let failed = 0
  let recovered = 0
  let skipped = 0

  for (const credential of due) {
    // Between credentials, never inside one: a walk mid-flight has already
    // persisted its cursor page by page, so stopping here loses nothing.
    if (deps.stopped?.() === true) {
      skipped += 1
      continue
    }

    const until = backoffs.get(credential.id)
    if (until !== undefined) {
      if (until > now.getTime()) {
        skipped += 1
        continue
      }
      backoffs.delete(credential.id)
    }

    const outcome = await reconcileOne(deps, credential, now)
    if (outcome === 'synced') synced += 1
    else if (outcome === 'recovered') {
      synced += 1
      recovered += 1
    } else if (outcome === 'partial') partial += 1
    else failed += 1
  }

  return { discovered: due.length, synced, partial, failed, recovered, skipped, stuckSettled }
}

/**
 * Settle deliveries stuck at `received` past the provider's retry horizon
 * (CP3, closing the gap CP2 recorded).
 *
 * **This is visibility, not repair, and the distinction is the whole design.**
 * The repair path is the sweep this function sits inside: it re-lists a trailing
 * window on a timer, both paths land in the same object head, so an object whose
 * delivery got stuck is repaired by the next pass as long as it is inside that
 * window. Re-driving the delivery from here could not work even if it were
 * wanted — the ledger stores a `payload_hash` and never the body (D5's privacy
 * boundary), so there is nothing left to reprocess.
 *
 * What was missing was knowing it happened. A row left `received` because a
 * tie-break re-fetch failed and the provider eventually stopped retrying was,
 * until now, invisible: no scan, no metric, no alert. Now it becomes a `failed`
 * row with a categorized result and a counter, which is exactly as much as this
 * loop honestly knows.
 *
 * Attached to the reconcile tick rather than given a loop of its own because it
 * is the same subsystem, the same interval is right for it, and a third revenue
 * timer would be a third thing to start, stop and reason about at shutdown for
 * one bounded UPDATE.
 */
async function sweepStuckDeliveries(deps: RevenueReconcileDeps, now: Date): Promise<number> {
  try {
    const swept = await failStuckRevenueDeliveries(deps.db, {
      olderThan: new Date(now.getTime() - STUCK_DELIVERY_AGE_MS),
      limit: STUCK_DELIVERY_LIMIT,
      now,
    })
    if (swept.failed > 0) {
      deps.metrics.increment(WORKER_METRICS.revenueStuckDeliveries, {}, swept.failed)
      deps.logger.warn('revenue_stuck_deliveries_settled', {
        settled: swept.failed,
        sites: new Set(swept.siteIds).size,
        // The reconcile sweep this function is part of is the repair path, so
        // there is nothing for an operator to re-drive by hand.
        repair: 'reconcile_sweep',
        retryable: false,
      })
    }
    return swept.failed
  } catch (err) {
    // Never fails the tick. The credential walk below is the loop's actual job
    // and a bookkeeping UPDATE must not be able to stop it.
    deps.logger.error('revenue_stuck_delivery_sweep_failed', { err, retryable: true })
    return 0
  }
}

type OneOutcome = 'synced' | 'recovered' | 'partial' | 'failed'

async function reconcileOne(
  deps: RevenueReconcileDeps,
  credential: DueRevenueCredential,
  now: Date,
): Promise<OneOutcome> {
  const adapter = deps.revenue.adapters.get(credential.provider)
  if (!adapter) {
    await degrade(deps, credential, 'adapter_unavailable')
    return 'failed'
  }

  const apiKey = decryptRevenueApiKey(deps.revenue.vault, credential)
  if (apiKey === null) {
    // The one place this loop writes `degraded` for a reason that is *ours*
    // rather than the provider's — and it is the right owner for it: the webhook
    // route deliberately refuses to make this transition, because it is
    // reachable by anyone who learns a token, while this loop is reachable only
    // by the clock.
    deps.metrics.increment(WORKER_METRICS.revenueSyncFailed, {
      reason: 'undecryptable',
      mode: 'reconcile',
    })
    await degrade(deps, credential, 'credential_undecryptable')
    return 'failed'
  }

  // Quantized, which is what lets the cursor survive from one tick to the next.
  const windowEnd = quantize(now, deps.staleMinutes * MINUTE_MS)
  const windowStart = new Date(
    windowEnd.getTime() - deps.revenue.policy.reconcileWindowHours * HOUR_MS,
  )

  const outcome = await syncAllRevenueResources(
    { db: deps.db, logger: deps.logger, metrics: deps.metrics },
    {
      target: {
        credentialId: credential.id,
        siteId: credential.siteId,
        provider: credential.provider,
        apiKey,
      },
      adapter,
      mode: 'reconcile',
      windowStart,
      windowEnd,
      pageSize: deps.revenue.policy.pageSize,
      maxPages: PAGES_PER_TICK,
    },
  )

  const fields = {
    site_id: credential.siteId,
    credential_id: credential.id,
    provider: credential.provider,
    pages: outcome.counts.pages,
    observations: outcome.counts.observations,
    applied: outcome.counts.applied,
    skipped: outcome.counts.skipped,
    ties_resolved: outcome.counts.tiesResolved,
    cursors_reset: outcome.counts.cursorsReset,
    subscriptions: outcome.counts.subscriptions,
    invoice_hints: outcome.counts.invoiceHints,
  }

  if (!outcome.ok) {
    // `last_synced_at` is untouched, always. That is rule 2, and it is why this
    // branch does not share a code path with the success below.
    if (outcome.reason === 'unavailable') {
      // Honour the provider's own asking time when it gave one; otherwise back
      // off a tick. Either way the credential is left alone rather than retried
      // on the very next beat, which for a rate-limited account is what turns a
      // sweep into a hammer.
      backoffs.set(
        credential.id,
        now.getTime() + (outcome.retryAfterMs ?? DEFAULT_PROVIDER_BACKOFF_MS),
      )
    }
    await degrade(
      deps,
      credential,
      outcome.reason === 'unauthorized' ? REVENUE_UNAUTHORIZED_ERROR : 'provider_unavailable',
    )
    deps.logger.warn('revenue_reconcile_failed', {
      ...fields,
      reason: outcome.reason,
      ...(outcome.retryAfterMs === undefined ? {} : { retry_after_ms: outcome.retryAfterMs }),
      // `unauthorized` is not retryable *by this loop* at all: discovery excludes
      // the row until a rotation or a reconnect touches it.
      retryable: outcome.reason !== 'unauthorized',
    })
    return 'failed'
  }

  if (!outcome.completed) {
    // Progress without completion. **Nothing is stamped**: the budget ran out
    // with objects still unread, and the next tick continues from the persisted
    // cursor under the same quantized window.
    deps.logger.info('revenue_reconcile_partial', fields)
    return 'partial'
  }

  // A completed walk. Freshness is earned, and a credential degraded for a
  // reason this loop can retest is demonstrably working again.
  //
  // `unauthorized` is deliberately excluded from the recovery. It cannot reach
  // here anyway — discovery filters it out — and the rule is stated in code
  // rather than left to that filter so the two cannot drift apart. A rejected
  // key is cleared by exactly two things: a rotation, which saw a live probe
  // succeed with a *new* secret, and a completed backfill, which read the whole
  // window with the key in question. A sweep clearing it would be this loop
  // asserting something it never tested.
  const recovering =
    credential.status === 'degraded' && credential.lastError !== REVENUE_UNAUTHORIZED_ERROR
  await updateRevenueCredentialState(deps.db, {
    credentialId: credential.id,
    siteId: credential.siteId,
    lastSyncedAt: new Date(),
    ...(recovering ? { status: 'active' as const, lastError: null } : {}),
  })
  if (recovering) {
    deps.metrics.increment(WORKER_METRICS.revenueCredentialRecovered, {
      provider: credential.provider,
    })
    deps.logger.info('revenue_credential_recovered', fields)
  }

  // Only when something moved: a healthy sweep over a quiet account is the
  // ordinary case and logging it every interval per credential would bury the
  // lines that matter.
  if (outcome.counts.applied > 0) deps.logger.info('revenue_reconcile_applied', fields)
  return recovering ? 'recovered' : 'synced'
}

/**
 * Floor an instant to a multiple of `quantumMs`, in UTC.
 *
 * This is what makes the sweep's cursor resumable across ticks: every tick
 * inside one quantum computes byte-identical window bounds, so
 * `syncRevenueResource` adopts the stored cursor instead of discarding it. The
 * quantum is the staleness interval, which is also the rate at which a completed
 * credential becomes due again — so a window is walked to the end and then
 * replaced, never half-walked forever.
 */
function quantize(at: Date, quantumMs: number): Date {
  return new Date(Math.floor(at.getTime() / quantumMs) * quantumMs)
}

/**
 * Publish the lag gauge, zero-filled.
 *
 * Zero when nothing is due, for the reason every other backlog gauge in this
 * worker is zero-filled (`publishJobsBacklog`): a series that exists only while
 * the loop is behind is indistinguishable from a loop that stopped running, and
 * an alert on it would stay lit on an empty queue.
 *
 * A never-synced credential contributes no age rather than an infinite one — its
 * backfill is what will set the first `last_synced_at`, and reporting "infinite
 * lag" for a connection made ninety seconds ago would page somebody about a
 * feature working correctly.
 */
function publishLag(
  deps: RevenueReconcileDeps,
  due: readonly DueRevenueCredential[],
  now: Date,
): void {
  let oldest = 0
  for (const credential of due) {
    if (credential.lastSyncedAt === null) continue
    oldest = Math.max(oldest, now.getTime() - credential.lastSyncedAt.getTime())
  }
  deps.metrics.gauge(WORKER_METRICS.revenueReconcileLagMs, oldest, {})
}

async function degrade(
  deps: RevenueReconcileDeps,
  credential: DueRevenueCredential,
  code: string,
): Promise<void> {
  await updateRevenueCredentialState(deps.db, {
    credentialId: credential.id,
    siteId: credential.siteId,
    status: 'degraded',
    lastError: code,
  })
}

export interface RevenueReconcileLoop {
  stop(): Promise<void>
}

/**
 * The interval loop, in the `email-drain.ts` shape: a re-entrancy guard, an
 * unref'd timer so the loop alone never keeps the process alive, and a `stop`
 * that drains an in-flight tick.
 *
 * The stop flag is threaded *into* the tick rather than only guarding its start,
 * so a shutdown during a provider outage cuts the batch between credentials
 * instead of waiting out a batch of 30-second timeouts.
 */
export function startRevenueReconcile(deps: RevenueReconcileDeps): RevenueReconcileLoop {
  let running = false
  let stopped = false

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const result = await reconcileRevenueOnce({ ...deps, stopped: () => stopped })
      if (result.discovered > 0 || result.stuckSettled > 0) {
        deps.logger.info('revenue_reconcile_swept', { ...result })
      }
    } catch (err) {
      // A throw here is a bug or a database outage. Logged and swallowed: this
      // loop shares a process with batch ingest and email delivery, and an
      // unhandled rejection would take both down over a provider sweep.
      deps.logger.error('revenue_reconcile_tick_failed', { err, retryable: true })
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS)
  timer.unref()

  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
  }
}

/**
 * Test seam: the backoff map is module state, and a suite that exercises rate
 * limiting has to be able to start from a known one.
 */
export function resetRevenueBackoffs(): void {
  backoffs.clear()
}
