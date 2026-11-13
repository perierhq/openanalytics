import {
  REVENUE_BACKFILL_JOB_TYPE,
  readRevenueCredential,
  updateRevenueCredentialState,
  type RevenueCredentialRow,
} from '@openanalytics/postgres'
import { decryptRevenueApiKey, syncAllRevenueResources } from '../revenue/sync.ts'
import type { JobExecutor, JobExecutorContext, JobOutcome, JobRegistration } from './runner.ts'

/**
 * The `revenue_backfill` executor (ADR-0033, D2e/D4).
 *
 * On connect, walk ninety days of the customer's provider history — charges,
 * then refunds, then disputes — through the same ledger and the same object head
 * every webhook uses, so the dashboard has substance from the first minute
 * rather than from the first future sale.
 *
 * ## The subject is a credential, not a site
 *
 * The runner's `(type, subject_id)` liveness index therefore means **one live
 * backfill per credential**, which is the right grain in both directions: a site
 * that connects a second provider gets a second walk, and a
 * disconnect-and-reconnect gets a fresh one under a new credential id (a new
 * connection whose history has not been walked) rather than adopting the
 * previous connection's cursors.
 *
 * ## Resume, not restart
 *
 * `revenue_sync_state` is written after **every page** — cursor, window, and
 * whether the resource finished. This executor walks a bounded number of pages
 * and then returns a retry, so a ninety-day backfill of a busy account is a
 * sequence of short claims rather than one claim that outlives its lease. A
 * worker killed mid-walk changes nothing: the next claim reads the cursor and
 * continues from the page boundary it last recorded.
 *
 * That is also why the page budget exists at all. Walking until the provider
 * says `has_more: false` would make the job's runtime a function of a customer's
 * transaction volume, and the first thing to break would be the lease.
 *
 * ## Failure, and which kind it is
 *
 * The split is the one every executor in this directory draws:
 *
 * - **`unauthorized`** — the customer revoked or narrowed their key. Terminal,
 *   and it flips the credential to `degraded` with a categorized `last_error`.
 *   Retrying is pointless (the answer will not change) and harmful (a hundred
 *   attempts against a rejecting provider looks like an attack from their side).
 *   `last_synced_at` is deliberately **not** touched — a degraded credential
 *   must keep reporting when its data was last actually correct.
 * - **`unavailable`** — the provider or the network. Thrown, so the runner's own
 *   exponential backoff handles it and the credential's status is untouched: an
 *   outage that lasts an hour must not read as a bad credential for a week.
 * - **A missing keyring or adapter** — infrastructure this deployment does not
 *   have. A **counting** retry, for the export job's reason: nothing about it
 *   resolves on its own, and a non-counting retry would be an immortal job
 *   holding the credential's only backfill slot forever.
 */

/** Long, because what is being waited on is a redeploy or a provisioning step. */
const RESOURCE_RETRY_MS = 30_000
/** Short: a stolen lease means another worker is already walking this. */
const LEASE_LOST_RETRY_MS = 5_000
/** Immediate-ish: the walk is not finished, and nothing is waiting on anything. */
const CONTINUE_RETRY_MS = 1_000

/**
 * Every retry that is not "more pages to walk" counts against
 * `JOB_MAX_ATTEMPTS`.
 *
 * The continuation retry deliberately does **not**: it is progress, not failure,
 * and counting it would terminal a healthy ninety-day walk the moment it needed
 * more than a hundred pages. The runner's `counts` flag exists for exactly this
 * distinction (`JobOutcome`).
 */
const COUNTING_RETRY = true

/**
 * Pages per claim — **one budget shared by all three resources**, not one each.
 *
 * Twenty pages at a hundred objects is two thousand objects per claim: well
 * inside a lease at any plausible provider latency, and enough that a typical
 * ninety-day history finishes in one or two claims while a very large one still
 * makes visible progress on each. Granting it per resource would make the real
 * ceiling sixty pages, which is exactly the number the lease was *not* sized
 * against.
 */
const PAGES_PER_CLAIM = 20

/** The safe failure categories a credential may end up carrying. Rendered to
 * the customer, so never a raw message and never a provider string. */
type RevenueFailureCode = 'unauthorized' | 'adapter_unavailable' | 'credential_undecryptable'

const executeRevenueBackfill: JobExecutor = async (context) => {
  const credentialId = context.job.subjectId
  if (credentialId === null) {
    return { terminal: { reason: 'revenue_backfill job has no subject credential' } }
  }
  const siteId = context.job.payload['site_id']
  if (typeof siteId !== 'string' || siteId.length === 0) {
    // Nothing will ever add the field, so waiting cannot help. Loud, because it
    // means a producer wrote a bad row.
    return { terminal: { reason: 'revenue_backfill payload has no site_id' } }
  }

  const credential = await findCredential(context, siteId, credentialId)
  if (!credential) {
    // Purged with the site, or disconnected under the job. There is no work and
    // no state to record having done none.
    context.logger.info('revenue_backfill_credential_absent', {
      site_id: siteId,
      credential_id: credentialId,
    })
    return 'succeeded'
  }

  // A job from a superseded generation. A rotation bumps the counter and
  // enqueues a fresh walk; if this claim is an old job that was still
  // `failed_retryable` when that happened, its window and its cursors belong to
  // a key that has since been replaced. Finishing quietly rather than racing the
  // new job over the same `revenue_sync_state` rows.
  const generation = context.job.payload['generation']
  if (typeof generation === 'number' && generation < credential.backfillGeneration) {
    context.logger.info('revenue_backfill_superseded', {
      site_id: siteId,
      credential_id: credentialId,
      job_generation: generation,
      credential_generation: credential.backfillGeneration,
    })
    return 'succeeded'
  }

  if (credential.status === 'disabled') {
    context.logger.info('revenue_backfill_credential_disabled', {
      site_id: siteId,
      credential_id: credentialId,
    })
    return 'succeeded'
  }

  const revenue = context.resources?.revenue
  if (!revenue) {
    context.logger.error('revenue_backfill_resources_missing', {
      site_id: siteId,
      credential_id: credentialId,
      reason: 'OA_CREDENTIAL_KEYRING missing',
      retryable: true,
    })
    return { retry: { delayMs: RESOURCE_RETRY_MS, counts: COUNTING_RETRY } }
  }

  const adapter = revenue.adapters.get(credential.provider)
  if (!adapter) {
    // A build packaging mistake rather than anything the customer did, and it is
    // not a wait: this build will never grow an adapter. Terminal with a
    // category the read surface can render.
    await degrade(context, credential, 'adapter_unavailable')
    return { terminal: { reason: `no revenue adapter for ${credential.provider}` } }
  }

  const apiKey = decryptRevenueApiKey(revenue.vault, credential)
  if (apiKey === null) {
    // The ciphertext is present and unreadable — a key removed from the ring, or
    // a rewritten row. Terminal rather than retried: a ring that lost a key does
    // not grow it back, and a hundred attempts would only delay the operator
    // seeing the category on the credential.
    await degrade(context, credential, 'credential_undecryptable')
    return { terminal: { reason: 'revenue credential could not be decrypted' } }
  }

  if (!(await context.updatePhase('walking'))) {
    return leaseLost(context, siteId, credentialId)
  }

  const now = new Date()
  const windowEnd = now
  const windowStart = new Date(now.getTime() - revenue.policy.backfillDays * DAY_MS)

  const outcome = await syncAllRevenueResources(
    { db: context.db, logger: context.logger, metrics: context.metrics },
    {
      target: {
        credentialId: credential.id,
        siteId: credential.siteId,
        provider: credential.provider,
        apiKey,
      },
      adapter,
      mode: 'backfill',
      // Quantized to the UTC day so the window is byte-identical across claims —
      // which is what lets the persisted cursor be resumed rather than
      // discarded. See `startOfUtcDay`.
      windowStart: startOfUtcDay(windowStart),
      windowEnd: endOfUtcDay(windowEnd),
      pageSize: revenue.policy.pageSize,
      maxPages: PAGES_PER_CLAIM,
      heartbeat: () => context.extendLease(),
    },
  )

  const fields = {
    site_id: siteId,
    credential_id: credentialId,
    provider: credential.provider,
    pages: outcome.counts.pages,
    observations: outcome.counts.observations,
    applied: outcome.counts.applied,
    skipped: outcome.counts.skipped,
    ties_resolved: outcome.counts.tiesResolved,
    cursors_reset: outcome.counts.cursorsReset,
    subscriptions: outcome.counts.subscriptions,
    invoice_hints: outcome.counts.invoiceHints,
    generation: credential.backfillGeneration,
  }

  if (!outcome.ok) {
    if (outcome.reason === 'lease_lost') {
      context.logger.warn('revenue_backfill_lease_lost', { ...fields, retryable: true })
      return { retry: { delayMs: LEASE_LOST_RETRY_MS, counts: COUNTING_RETRY } }
    }
    if (outcome.reason === 'unauthorized') {
      // Terminal, and the state it leaves is the important half. `degraded` +
      // `last_error = 'unauthorized'` is a state **only a rotation or a
      // reconnect clears**: the reconcile sweep excludes it from discovery
      // rather than retrying a rejected key 1,440 times a day, and it will not
      // clear an error it never diagnosed. So a partial-permission key —
      // `Charges` read but not `Disputes`, which passes the connect probe and
      // fails here — surfaces to the customer as a degraded connection with an
      // actionable category, instead of a job that gave up behind a connection
      // reporting itself healthy.
      //
      // The generational idempotency key is the other half: a rotation mints a
      // new job, so this terminal is recoverable rather than permanent.
      await degrade(context, credential, 'unauthorized')
      context.logger.warn('revenue_backfill_unauthorized', { ...fields, retryable: false })
      return { terminal: { reason: 'provider rejected the credential' } }
    }
    // `unavailable`. Thrown so the runner's backoff schedules it, which is
    // strictly better than an in-job sleep holding a lease — except when the
    // provider asked for a specific wait, in which case honouring it is the
    // polite thing and the runner's own delay would be a guess.
    if (outcome.retryAfterMs !== undefined) {
      context.logger.warn('revenue_backfill_rate_limited', {
        ...fields,
        retry_in_ms: outcome.retryAfterMs,
        retryable: true,
      })
      return { retry: { delayMs: outcome.retryAfterMs } }
    }
    context.logger.warn('revenue_backfill_unavailable', { ...fields, retryable: true })
    throw new Error(`revenue provider unavailable: ${outcome.detail}`)
  }

  if (!outcome.completed) {
    // Progress, not failure — a non-counting retry, so a large history cannot
    // exhaust the attempt guard without a single error having occurred.
    context.logger.info('revenue_backfill_continuing', fields)
    return { retry: { delayMs: CONTINUE_RETRY_MS } }
  }

  // The walk finished. `last_synced_at` moves *here* and nowhere else on this
  // path: the whole ninety-day window has been read, so the freshness the read
  // surface reports is earned rather than assumed.
  //
  // A credential that arrived `degraded` is cleared **whatever the category**,
  // including `unauthorized` — and this is the only place in the system besides
  // a rotation where that is allowed. It is earned here in a way no sweep can
  // earn it: a completed walk read every page of all three resources with *this
  // key*, which is a strictly stronger test than the connect probe's single
  // `GET /v1/charges?limit=1` that let the partial-permission key through in the
  // first place.
  await updateRevenueCredentialState(context.db, {
    credentialId: credential.id,
    siteId: credential.siteId,
    lastSyncedAt: new Date(),
    ...(credential.status === 'degraded' ? { status: 'active' as const, lastError: null } : {}),
  })
  context.logger.info('revenue_backfill_completed', fields)
  return 'succeeded'
}

/**
 * The credential this job is about.
 *
 * Read by `(site, id)` rather than by id alone: the job's payload names the site
 * it believes it is acting on, and demanding both means a job row whose subject
 * and payload disagree finds nothing instead of walking one site's history under
 * another site's credential.
 */
async function findCredential(
  context: JobExecutorContext,
  siteId: string,
  credentialId: string,
): Promise<RevenueCredentialRow | null> {
  const credential = await readRevenueCredential(context.db, { siteId })
  if (!credential || credential.id !== credentialId) return null
  return credential
}

/**
 * Record why this credential stopped working.
 *
 * `last_synced_at` is untouched, always. A degraded credential has to keep
 * reporting when its data was last actually correct — that is what lets the read
 * surface say `stale` instead of implying that a zero is fresh, which is the
 * failure mode this milestone is named after (snapshot 01 §12.3).
 */
async function degrade(
  context: JobExecutorContext,
  credential: RevenueCredentialRow,
  code: RevenueFailureCode,
): Promise<void> {
  await updateRevenueCredentialState(context.db, {
    credentialId: credential.id,
    siteId: credential.siteId,
    status: 'degraded',
    lastError: code,
  })
}

function leaseLost(context: JobExecutorContext, siteId: string, credentialId: string): JobOutcome {
  context.logger.warn('revenue_backfill_lease_lost', {
    site_id: siteId,
    credential_id: credentialId,
    retryable: true,
  })
  return { retry: { delayMs: LEASE_LOST_RETRY_MS, counts: COUNTING_RETRY } }
}

const DAY_MS = 86_400_000

/**
 * Both window bounds are quantized to the UTC day, and that is what makes the
 * cursor resumable across claims.
 *
 * `syncRevenueResource` resumes a cursor only when the window it was taken in is
 * *identical*, because a provider cursor is a position inside a filtered
 * sequence and resuming it under a different filter would page through something
 * else entirely. A window recomputed from `Date.now()` on each claim moves its
 * end by seconds every time, which would fail that test and restart the walk on
 * every continuation — a backfill that can never finish, doing more work each
 * time it tries.
 *
 * Quantizing makes both bounds stable for the whole UTC day the backfill runs
 * in. A walk still going at midnight restarts once, which costs a re-list of
 * pages whose objects are all already in the head (every one of them skips), and
 * is paid only by an account large enough for the restart to be the smaller of
 * its problems.
 */
function startOfUtcDay(at: Date): Date {
  return new Date(Math.floor(at.getTime() / DAY_MS) * DAY_MS)
}

/** The last instant of the UTC day `at` falls in. */
function endOfUtcDay(at: Date): Date {
  return new Date(startOfUtcDay(at).getTime() + DAY_MS - 1)
}

export const REVENUE_BACKFILL_REGISTRATION: JobRegistration = {
  type: REVENUE_BACKFILL_JOB_TYPE,
  execute: executeRevenueBackfill,
  /**
   * No `onTerminal` hook, and the absence is a decision.
   *
   * The hook exists for job types whose *subject row* would otherwise stay
   * pinned — an import run stuck `validating` holds its site's only import slot,
   * an export run stuck `running` holds the export slot. A revenue credential
   * pins nothing: a dead backfill leaves a credential that is `active` (or
   * `degraded`, which the failure paths above set explicitly and for a reason
   * the customer can read), the webhook path keeps working, and the reconcile
   * sweep picks it up on its own schedule because a `last_synced_at` of null
   * with no live job is exactly what that loop looks for.
   *
   * So a lost backfill degrades to "no history, but everything from now on",
   * which is a state the read surface can already express — and
   * `enqueueRevenueBackfill` is the re-run hook when somebody wants the history
   * back.
   */
  /** Two at a time: each holds a provider connection and a page buffer, and the
   * page executes serially anyway. */
  limit: 2,
}

export { executeRevenueBackfill }
