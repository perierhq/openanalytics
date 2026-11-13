import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  REALTIME_ACCESS_REVOKED_TOPIC,
  REALTIME_SITE_SUBJECT,
  SITE_DELETION_TARGETS,
  type DeletionStore,
  type RegisteredDeletionStore,
  type RealtimeAccessRevokedPayload,
  type SiteDeletionPhase,
} from '@openanalytics/domain'
import type { Database, Executor } from '../client.ts'
import { newId } from '../ids.ts'
import { writeAudit } from './audit.ts'
import { listSiteExportObjectKeys } from './export-runs.ts'
import { listSiteImportObjectKeys } from './import-runs.ts'
import { SITE_DELETION_JOB_TYPE, enqueueJob } from './jobs.ts'
import { enqueueOutbox } from './outbox.ts'
import { eraseSiteRevenueCredentials } from './revenue-credentials.ts'
import { apiKeys } from '../schema/api-keys.ts'
import { funnels } from '../schema/funnels.ts'
import { eventDefinitionVersions, eventDefinitions } from '../schema/event-definitions.ts'
import { exportRuns } from '../schema/exports.ts'
import { importRuns, importUploads } from '../schema/imports.ts'
import { ingestBatchItems, ingestBatchSites } from '../schema/ingest-batches.ts'
import { siteIngestSettings } from '../schema/ingest.ts'
import {
  deletionRequests,
  deletionTargets,
  jobs,
  type DeletionStatus,
  type DeletionTargetPhase,
  type DeletionTargetStore,
} from '../schema/lifecycle.ts'
import { sitePublicDashboardSettings } from '../schema/public-dashboard.ts'
import {
  revenueAttributionState,
  revenueCredentials,
  revenueMatchHints,
  revenueInvoices,
  revenueSubscriptionChanges,
  revenueSubscriptions,
  revenueObjects,
  revenueProviderEvents,
  revenueSyncState,
} from '../schema/revenue.ts'
import { sessionFinalizerState } from '../schema/session-finalizer.ts'
import { siteDomains, siteInvites, siteMembers, sites, type SiteStatus } from '../schema/sites.ts'
import { widgets } from '../schema/widgets.ts'
import { credentialSources } from '../schema/credential-sources.ts'

/**
 * Site deletion's Postgres half (ADR-0030, decision 4).
 *
 * Two transactions and a handful of reads, split by who runs them:
 *
 * - `startSiteDeletion` is the **API's** transaction. It is small, synchronous
 *   and the only place a site enters `deleting`. Everything it does is a
 *   promise: the site stops accepting events, its credentials stop working, its
 *   caches become unreachable, and a durable job exists to do the rest.
 * - `purgeSitePostgres` is the **worker's** transaction, one phase of the job.
 * - the rest are the reads the phases need — the drain's in-flight count, the
 *   target state machine, the finalizer's status fence — kept here rather than
 *   in the executor so the SQL is testable without a worker.
 *
 * The invariant that ties them together: nothing outside `startSiteDeletion`
 * writes `sites.status = 'deleting'`, and nothing outside `finalizeSiteDeletion`
 * writes `'deleted'`. Two writers of a lifecycle transition is how a site ends
 * up half-deleted with no job to finish it.
 */

/**
 * The topic the completed tombstone announces.
 *
 * Observe-only for now — the dispatcher registers it so the row is drained
 * rather than accumulating, and the real notification (telling the customer the
 * erasure finished) is the email milestone's. The registry entry existing from
 * CP3 is the point: a topic nobody consumes is a table that grows forever.
 */
export const SITE_DELETION_COMPLETED_TOPIC = 'site.deletion_completed'

/** The typed shape of a `site_deletion` job's payload. `reason` is carried for
 * the operator reading the jobs table; the executor works from
 * `deletion_request_id` alone, which is the only field it can act on. */
export interface SiteDeletionJobPayload extends Record<string, unknown> {
  readonly deletion_request_id: string
  readonly reason: SiteDeletionReason
}

/** Who asked, in the audit vocabulary. `retention_expired` is the lifecycle
 * sweeper's: nobody asked, a promised date arrived (ADR-0030, decision 2). */
export type SiteDeletionReason = 'user_requested' | 'retention_expired'

export interface StartSiteDeletionInput {
  readonly siteId: string
  /** Null for a deletion no user requested — the retention sweep's. The column
   * is nullable for exactly this case, and the audit row it produces is written
   * with `actorType: 'system'` and no actor. */
  readonly requestedByUserId: string | null
  readonly reason?: SiteDeletionReason
  /** Test seam only. Omitted in production so `requested_at` keeps the database
   * clock's instant — see the transaction's step 3. */
  readonly now?: Date
}

export interface StartSiteDeletionResult {
  readonly deletionRequestId: string
  /** The job that will execute the phases. Null only if the job row could not be
   * resolved, which the partial unique makes impossible in practice. */
  readonly jobId: string | null
  /** False when the site was already `deleting` and this call found the existing
   * request — the idempotent answer the route returns as a 202 either way. */
  readonly started: boolean
}

export class SiteDeletionError extends Error {
  readonly reason: 'site_not_found' | 'already_deleted'

  constructor(reason: 'site_not_found' | 'already_deleted', message: string) {
    super(message)
    this.name = 'SiteDeletionError'
    this.reason = reason
  }
}

/**
 * Begin a site deletion — the "deletion start" transaction (ADR-0030, D4).
 *
 * One transaction, and the order inside it is the guarantee. If
 * the process dies at any point before the commit, nothing happened; after it,
 * every one of the promises below is durable together:
 *
 * 1. **Lock the site row `FOR UPDATE`.** One site, so the multi-row lock-order
 *    canon (ADR-0030 D4: `ORDER BY id` *inside* the locking SELECT, because
 *    Postgres acquires row locks in executor scan order) has nothing to order
 *    here — but the lock itself is not optional. `registerBatchSites` takes the
 *    same lock before reading `ingest_generation` and writing its fence
 *    registration, so this lock is what makes "bump the generation" and "check
 *    the generation" serialize instead of interleaving. A worker that read the
 *    old generation cannot then register under it after this commits.
 * 2. **Already `deleting` → return the existing request.** The route answers 202
 *    with the same id, so a double-click, a retried request and a sweeper racing
 *    an operator all converge on one deletion. `deleted` is an error the route
 *    turns into a 404: the tombstone is not a site.
 * 3. **Write the request and its full target snapshot.** The snapshot is what
 *    the worker works; see `SITE_DELETION_TARGETS` for why it is snapshotted
 *    rather than derived at execution time. `requested_at` is left to the
 *    column's `DEFAULT now()` — the *database's* clock — because the worker's
 *    `fence_drain` compares it against an elapsed interval. Stamping it from the
 *    calling host's `Date.now()` would put a third clock into a comparison
 *    `DELETION_ACCEPTANCE_MARGIN_MS` only budgets skew for two of, and a fast
 *    api host would shorten a wait that exists to prevent data loss. Tests pass
 *    `now` explicitly and get a deterministic instant.
 * 4. **Enqueue the job in the same transaction.** The one statement that makes
 *    this safe at all: a commit that marked the site `deleting` without a job
 *    would leave a site nobody is deleting, invisible to every sweep (the
 *    retention sweeper only looks at `suspended` rows).
 * 5. **Flip the site.** `status = 'deleting'` stops the collector at the fence,
 *    `ingest_generation + 1` invalidates every config snapshot a request already
 *    holds — which is what the drain then waits out — and `config_version + 1`
 *    makes every cached read (tracker config ETag, collector ingest-config
 *    cache, gateway query cache keyed on `cache_epoch`) unreachable.
 * 6. **Revoke every live key, erase every provider credential, and audit it.** A
 *    tracking key that still worked would keep a browser posting events at a
 *    site being erased; a revenue credential still holding its ciphertext would
 *    leave a decryptable key to a customer's payment provider sitting in a
 *    database for the whole length of a purge (ADR-0033, D8).
 *
 * The realtime epoch bump itself is deliberately *not* here. It is a Redis side
 * effect and must not run inside a transaction that can still roll back; the
 * route does it after the commit, best-effort, exactly as member removal does.
 * What *is* here is the durable half of the same revocation: a
 * `realtime.access_revoked` outbox row on the reserved site subject, written in
 * this transaction so the bump survives an unreachable Redis, a crash between
 * commit and side effect, and a start that no route ran at all (the retention
 * sweeper's). Without it, a deletion started while the cache was down would
 * leave every open stream on the site connected until its token expired.
 */
export async function startSiteDeletion(
  db: Database,
  input: StartSiteDeletionInput,
): Promise<StartSiteDeletionResult> {
  const now = input.now ?? new Date()

  return await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT id, status FROM ${sites} WHERE id = ${input.siteId}::uuid FOR UPDATE
    `)
    const siteRow = (locked as unknown as { rows: { id: string; status: SiteStatus }[] }).rows[0]
    if (!siteRow) {
      throw new SiteDeletionError('site_not_found', `No site ${input.siteId}`)
    }
    if (siteRow.status === 'deleted') {
      throw new SiteDeletionError('already_deleted', `Site ${input.siteId} is already deleted`)
    }

    if (siteRow.status === 'deleting') {
      // Idempotent: find the live request rather than mint a second one. A
      // deletion is a state machine, and starting it twice would give one site
      // two target snapshots whose "all completed" checks disagree.
      //
      // The *job* is asked for first, because it is the thing that will still be
      // doing work when the request row has already settled — the same ordering
      // `startAccountDeletion` uses, and for the same window.
      const [liveJob] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, SITE_DELETION_JOB_TYPE),
            eq(jobs.subjectId, input.siteId),
            inArray(jobs.status, ['queued', 'running', 'failed_retryable']),
          ),
        )

      const [existing] = await tx
        .select({ id: deletionRequests.id })
        .from(deletionRequests)
        .where(
          and(
            eq(deletionRequests.subjectType, 'site'),
            eq(deletionRequests.subjectId, input.siteId),
            inArray(deletionRequests.status, ['pending', 'running']),
          ),
        )
        .orderBy(deletionRequests.requestedAt)

      if (existing && liveJob) {
        // A live request being worked by a live job: the answer is identical to
        // the first call's, which is what makes the route idempotent rather than
        // merely non-destructive.
        return { deletionRequestId: existing.id, jobId: liveJob.id, started: false }
      }

      // Nothing is performing this site's deletion. Two shapes of that, and one
      // recovery for both, because a site left `deleting` forever is the worst
      // outcome available: its events are refused at the fence, its keys are
      // revoked and nothing will ever finish erasing it.
      //
      // - a live request with no live job — the job was settled terminally, or
      //   lost in a way nothing re-queued;
      // - a `failed` request — the same thing, one step later: the runner's
      //   `onTerminal` hook marked it, precisely so it would stop being found by
      //   the live read above and could be revived here.
      //
      // Either way the recovery is a fresh job attached to the *same* request.
      // Minting a second request would give one site two target snapshots, each
      // answering "is everything completed?" without knowing about the other,
      // and would throw away the targets the dead job had already verified.
      const revivable =
        existing ??
        (
          await tx
            .select({ id: deletionRequests.id })
            .from(deletionRequests)
            .where(
              and(
                eq(deletionRequests.subjectType, 'site'),
                eq(deletionRequests.subjectId, input.siteId),
                eq(deletionRequests.status, 'failed'),
              ),
            )
            .orderBy(desc(deletionRequests.requestedAt))
            .limit(1)
        )[0]

      if (revivable) {
        if (liveJob) {
          // A failed request with a live job: whatever that job is working, it
          // owns the site. Reporting it is the honest answer; enqueueing beside
          // it would be refused by `jobs_live_subject_key` anyway.
          return { deletionRequestId: revivable.id, jobId: liveJob.id, started: false }
        }

        // Back to `pending`, guarded on `failed` so a request that is genuinely
        // live is not rewound out of `running` by a re-request.
        await tx
          .update(deletionRequests)
          .set({ status: 'pending', completedAt: null })
          .where(and(eq(deletionRequests.id, revivable.id), eq(deletionRequests.status, 'failed')))

        const revivedReason: SiteDeletionReason = input.reason ?? 'user_requested'
        const revived = await enqueueJob(tx, {
          type: SITE_DELETION_JOB_TYPE,
          subjectId: input.siteId,
          idempotencyKey: `${SITE_DELETION_JOB_TYPE}:${input.siteId}:${newId()}`,
          payload: {
            deletion_request_id: revivable.id,
            reason: revivedReason,
          } satisfies SiteDeletionJobPayload,
        })

        await writeAudit(tx, {
          action: 'site.deletion_revived',
          actorType: input.requestedByUserId === null ? 'system' : 'user',
          actorUserId: input.requestedByUserId,
          siteId: input.siteId,
          targetType: 'site',
          targetId: input.siteId,
          metadata: {
            deletion_request_id: revivable.id,
            job_id: revived.id,
            reason: revivedReason,
          },
        })

        return { deletionRequestId: revivable.id, jobId: revived.id, started: false }
      }
      // A site marked `deleting` with no request at all is a state nothing
      // writes; falling through re-creates the request rather than leaving the
      // site stuck forever, which is the only recovery that does not need a
      // human.
    }

    const requestId = newId()
    await tx.insert(deletionRequests).values({
      id: requestId,
      subjectType: 'site',
      subjectId: input.siteId,
      status: 'pending',
      requestedByUserId: input.requestedByUserId,
      // Omitted unless a test supplied one: the column's `DEFAULT now()` is the
      // database clock, which is the clock `fence_drain` measures against.
      ...(input.now === undefined ? {} : { requestedAt: input.now }),
    })

    // The object store's keys are enumerated **now**, from the rows that carry
    // them, and written into the target's verification (ADR-0032, D9). The port
    // deliberately has no `list`, so this snapshot is the only thing that will
    // know what to delete — and `postgres_purge` removes `import_uploads` and
    // `export_runs` long before anybody could ask again. A site with no objects
    // gets the target row with an empty list, which the phase completes
    // trivially; omitting the row would make the target count vary per site and
    // stop "did this deletion cover object storage?" being answerable from the
    // snapshot alone.
    //
    // **Both halves of M11.** The import archives are one key per run; the
    // exports are a prefix each, whose chunk keys the export job records on its
    // row as it uploads them and whose manifest key is derived from the prefix
    // (`exportObjectKeysOf`). An export that died half way is exactly the case
    // this covers: its bytes are in the bucket, it has no manifest, and its
    // `progress` is the only record of what it wrote.
    const objectKeys = [
      ...(await listSiteImportObjectKeys(tx, input.siteId)),
      ...(await listSiteExportObjectKeys(tx, input.siteId)),
    ]

    await tx.insert(deletionTargets).values(
      SITE_DELETION_TARGETS.map((target) => ({
        id: newId(),
        deletionRequestId: requestId,
        store: target.store,
        target: target.target,
        phase: 'pending' as const,
        ...(target.store === 'object' ? { verification: { keys: objectKeys } } : {}),
        updatedAt: now,
      })),
    )

    // A fresh key per attempt: the previous deletion of this site (if the site
    // was somehow re-entered) has spent `site_deletion:{siteId}`, and a spent key
    // is not an enqueue. The `(type, subject_id)` partial unique is what actually
    // guarantees one live job per site, so the key only has to be unique.
    const reason: SiteDeletionReason = input.reason ?? 'user_requested'

    const enqueued = await enqueueJob(tx, {
      type: SITE_DELETION_JOB_TYPE,
      subjectId: input.siteId,
      idempotencyKey: `${SITE_DELETION_JOB_TYPE}:${input.siteId}:${newId()}`,
      payload: { deletion_request_id: requestId, reason } satisfies SiteDeletionJobPayload,
    })

    const [flipped] = await tx
      .update(sites)
      .set({
        status: 'deleting',
        ingestGeneration: sql`${sites.ingestGeneration} + 1`,
        configVersion: sql`${sites.configVersion} + 1`,
        updatedAt: now,
      })
      .where(eq(sites.id, input.siteId))
      .returning({ ingestGeneration: sites.ingestGeneration })

    // The durable half of the realtime revocation (D-213), on the reserved
    // site-level subject so the drain's bump cuts every stream on the site
    // rather than one member's. Keyed on the generation this transaction just
    // produced: a re-entered deletion of the same site bumps the generation
    // again and therefore enqueues again, while a retried *identical* start
    // (which cannot bump twice — step 2 returns early) collides and is dropped.
    await enqueueOutbox(tx, {
      topic: REALTIME_ACCESS_REVOKED_TOPIC,
      idempotencyKey: `${REALTIME_ACCESS_REVOKED_TOPIC}:site:${input.siteId}:${String(
        flipped?.ingestGeneration ?? 0,
      )}`,
      payload: {
        site_id: input.siteId,
        user_id: REALTIME_SITE_SUBJECT,
        reason: 'site_deleted',
      } satisfies RealtimeAccessRevokedPayload,
    })

    const revoked = await tx
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(and(eq(apiKeys.siteId, input.siteId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id })

    // Every provider credential ciphertext, erased here rather than left to
    // `postgres_purge` (ADR-0033, D8). The purge is phases and possibly hours
    // away — `clickhouse_purge` polls mutations for as long as ClickHouse takes
    // to rewrite its parts — and a site being erased must not hold a decryptable
    // key to a customer's payment provider for any part of that. The rows
    // themselves go with the `revenue_credentials` target.
    const revenueRevoked = await eraseSiteRevenueCredentials(tx, { siteId: input.siteId, now })

    await writeAudit(tx, {
      // A deletion nobody requested is the sweeper's, and recording it against a
      // user would name someone who did not act. `actorType` and the actor move
      // together: 'system' with no actor id, exactly as the tombstone's row does.
      actorType: input.requestedByUserId === null ? 'system' : 'user',
      action: 'site.deletion_requested',
      actorUserId: input.requestedByUserId,
      siteId: input.siteId,
      targetType: 'site',
      targetId: input.siteId,
      metadata: {
        deletion_request_id: requestId,
        reason,
        targets: SITE_DELETION_TARGETS.length,
        revoked_api_keys: revoked.length,
        revoked_revenue_credentials: revenueRevoked,
      },
    })

    return { deletionRequestId: requestId, jobId: enqueued.id, started: true }
  })
}

export interface SiteDeletionContext {
  readonly siteId: string
  readonly status: SiteStatus
  readonly ingestGeneration: number
  readonly requestStatus: DeletionStatus
  readonly requestedAt: Date
}

/** The site row and request row a deletion phase reasons about, in one read. */
export async function readSiteDeletionContext(
  db: Executor,
  deletionRequestId: string,
): Promise<SiteDeletionContext | null> {
  const [row] = await db
    .select({
      siteId: sites.id,
      status: sites.status,
      ingestGeneration: sites.ingestGeneration,
      requestStatus: deletionRequests.status,
      requestedAt: deletionRequests.requestedAt,
    })
    .from(deletionRequests)
    .innerJoin(sites, eq(sites.id, deletionRequests.subjectId))
    .where(eq(deletionRequests.id, deletionRequestId))
  return row ?? null
}

/**
 * In-flight writers at a superseded generation — the drain's whole question
 * (ADR-0030, D4 `fence_drain`).
 *
 * `ingest_batch_sites_inflight_idx (site_id, ingest_generation) WHERE state =
 * 'registered'` gets its first caller here; the predicate matches the index's
 * exactly so the read is an index-only scan over a bounded set.
 *
 * **`<` the current generation, not `!=`.** The column records the generation the
 * *events carried*, snapshotted when the collector accepted them — so a row
 * still `registered` at a lower generation is a worker that passed the fence
 * before this deletion bumped it and has not yet settled. A row at the current
 * generation cannot exist for a `deleting` site (the fence drops it), and a row
 * at a *higher* one cannot exist at all; counting either would make the drain
 * wait on something that can never settle.
 */
export async function countInFlightWriters(
  db: Executor,
  input: { siteId: string; currentGeneration: number },
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(ingestBatchSites)
    .where(
      and(
        eq(ingestBatchSites.siteId, input.siteId),
        sql`${ingestBatchSites.ingestGeneration} < ${input.currentGeneration}`,
        eq(ingestBatchSites.state, 'registered'),
      ),
    )
  return Number(row?.value ?? 0)
}

/**
 * A purge a registered surface contributes, run inside the site-purge
 * transaction and recording its counts through the same `removeFrom`.
 *
 * The targets a surface adds to the deletion dictionary are the *snapshot*; this
 * is what actually empties them. Both have to come from the same place, or a
 * deletion verifies a target nothing purged.
 */
export type SitePurgeStep = (
  tx: Executor,
  input: {
    readonly siteId: string
    readonly removeFrom: (name: string, run: () => Promise<{ id: string }[]>) => Promise<void>
  },
) => Promise<void>

const purgeSteps: SitePurgeStep[] = []
const purgeStepNames = new Set<string>()

export function registerSitePurgeStep(name: string, step: SitePurgeStep): void {
  if (purgeStepNames.has(name)) return
  purgeStepNames.add(name)
  purgeSteps.push(step)
}

export interface DeletionTargetRow {
  readonly id: string
  /** Whatever the snapshot named — a product store or a registered one. */
  readonly store: DeletionTargetStore
  readonly target: string
  readonly phase: DeletionTargetPhase
  readonly attempts: number
  readonly verified: boolean
  readonly mutationId: string | null
  readonly lastError: string | null
  /**
   * What the phase observed — and, for the `object` store, what it must work on:
   * the key list is snapshotted here at deletion start, before `postgres_purge`
   * removes the rows it was read from (ADR-0032, D9). Every other store derives
   * its work from a bounded index it can still reach, so for them this stays
   * purely a record of the outcome.
   */
  readonly verification: Record<string, unknown> | null
}

/** Every target of a request, ordered so a resumed job walks them the same way. */
export async function listDeletionTargets(
  db: Executor,
  input: { deletionRequestId: string; store?: DeletionStore | RegisteredDeletionStore },
): Promise<DeletionTargetRow[]> {
  const where =
    input.store === undefined
      ? eq(deletionTargets.deletionRequestId, input.deletionRequestId)
      : and(
          eq(deletionTargets.deletionRequestId, input.deletionRequestId),
          eq(deletionTargets.store, input.store),
        )

  const rows = await db
    .select({
      id: deletionTargets.id,
      store: deletionTargets.store,
      target: deletionTargets.target,
      phase: deletionTargets.phase,
      attempts: deletionTargets.attempts,
      verified: deletionTargets.verified,
      mutationId: deletionTargets.mutationId,
      lastError: deletionTargets.lastError,
      verification: deletionTargets.verification,
    })
    .from(deletionTargets)
    .where(where)
    .orderBy(deletionTargets.store, deletionTargets.target)

  return rows.map((row) => ({ ...row, attempts: Number(row.attempts) }))
}

export interface UpdateDeletionTargetInput {
  readonly targetId: string
  readonly phase?: DeletionTargetPhase
  readonly verified?: boolean
  readonly verification?: Record<string, unknown>
  /** Explicit null clears a previously recorded mutation or error. */
  readonly mutationId?: string | null
  readonly lastError?: string | null
  /** Adds one to the attempt counter. */
  readonly countAttempt?: boolean
  readonly now?: Date
}

/**
 * Record a target's progress.
 *
 * Every field is optional and only the supplied ones are written, because the
 * phases touch different subsets: ClickHouse writes a mutation id and later a
 * verification, Redis writes counts and completes in one call, Postgres writes
 * deleted-row counts. A single "set everything" update would make each caller
 * restate values it has no opinion about.
 */
export async function updateDeletionTarget(
  db: Executor,
  input: UpdateDeletionTargetInput,
): Promise<void> {
  const now = input.now ?? new Date()
  await db
    .update(deletionTargets)
    .set({
      ...(input.phase === undefined ? {} : { phase: input.phase }),
      ...(input.verified === undefined ? {} : { verified: input.verified }),
      ...(input.verification === undefined ? {} : { verification: input.verification }),
      ...(input.mutationId === undefined ? {} : { mutationId: input.mutationId }),
      ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
      ...(input.countAttempt === true ? { attempts: sql`${deletionTargets.attempts} + 1` } : {}),
      updatedAt: now,
    })
    .where(eq(deletionTargets.id, input.targetId))
}

export interface PurgeSitePostgresResult {
  /** Rows removed per target table, in the target vocabulary's names. */
  readonly deleted: Record<string, number>
}

/**
 * The `postgres_purge` phase (ADR-0030, D4; extended by ADR-0032 D9 and
 * ADR-0033 D8 and ADR-0045 D8): delete the twenty-two site-scoped tables in one
 * transaction.
 *
 * One transaction because the ownership triggers are `DEFERRABLE INITIALLY
 * DEFERRED` constraint triggers — they fire at commit, not per statement — and
 * removing every `site_members` row would violate OA001 at that commit for any
 * site that is not exempt. Migration 0028's amendment is what makes it pass: the
 * site is `deleting`, so `assert_site_ownership` returns early. Splitting this
 * into twenty-two transactions would gain nothing and would leave the site's membership
 * gone while its invites survived, which is a state no reader expects.
 *
 * `ingest_batch_sites`, `audit_logs` and `site_billing_assignments` are
 * deliberately untouched — see `DELETION_POSTGRES_TARGETS` for why each survives.
 *
 * Counts are returned per table so the target rows can record what was actually
 * removed. A zero is a legitimate answer (a site with no invites), which is why
 * verification for this store is "the count was recorded", not "the count was
 * positive".
 */
export async function purgeSitePostgres(
  db: Database,
  input: { siteId: string },
): Promise<PurgeSitePostgresResult> {
  return await db.transaction(async (tx) => {
    const deleted: Record<string, number> = {}

    const removeFrom = async (
      name: string,
      run: () => Promise<{ id: string }[]>,
    ): Promise<void> => {
      const rows = await run()
      deleted[name] = rows.length
    }

    await removeFrom('site_domains', () =>
      tx.delete(siteDomains).where(eq(siteDomains.siteId, input.siteId)).returning({
        id: siteDomains.id,
      }),
    )
    await removeFrom('site_members', () =>
      tx.delete(siteMembers).where(eq(siteMembers.siteId, input.siteId)).returning({
        id: siteMembers.id,
      }),
    )
    await removeFrom('site_invites', () =>
      tx.delete(siteInvites).where(eq(siteInvites.siteId, input.siteId)).returning({
        id: siteInvites.id,
      }),
    )
    await removeFrom('api_keys', () =>
      tx.delete(apiKeys).where(eq(apiKeys.siteId, input.siteId)).returning({ id: apiKeys.id }),
    )
    await removeFrom('site_ingest_settings', () =>
      tx
        .delete(siteIngestSettings)
        .where(eq(siteIngestSettings.siteId, input.siteId))
        .returning({ id: siteIngestSettings.siteId }),
    )
    await removeFrom('site_public_dashboard_settings', () =>
      tx
        .delete(sitePublicDashboardSettings)
        .where(eq(sitePublicDashboardSettings.siteId, input.siteId))
        .returning({ id: sitePublicDashboardSettings.siteId }),
    )
    await removeFrom('funnels', () =>
      tx.delete(funnels).where(eq(funnels.siteId, input.siteId)).returning({ id: funnels.id }),
    )
    // The row whose lease this job has been holding since `finalizer_fence`.
    // Deleting it releases the lease by removing what it was on, which is safe
    // precisely because the site can never be finalized again.
    await removeFrom('session_finalizer_state', () =>
      tx
        .delete(sessionFinalizerState)
        .where(eq(sessionFinalizerState.siteId, input.siteId))
        .returning({ id: sessionFinalizerState.siteId }),
    )
    // The payload-metadata half of the manifest. `ingest_batch_sites` — the
    // fence ledger — is the half that survives.
    // Whatever the surfaces this deployment mounted own, purged through the
    // same recorder so their row counts land in the same snapshot.
    for (const step of purgeSteps) await step(tx, { siteId: input.siteId, removeFrom })

    await removeFrom('ingest_batch_items', () =>
      tx
        .delete(ingestBatchItems)
        .where(eq(ingestBatchItems.siteId, input.siteId))
        .returning({ id: ingestBatchItems.id }),
    )

    // The import pair, and the two statements before them are the FK cycle
    // ADR-0032 D9 describes. `sites.published_import_run_id` points *at* a run,
    // so it has to stop pointing before the runs go; the column's
    // `ON DELETE SET NULL` would cover a path that forgot, but a purge that
    // relies on a cascade to fix its own ordering is a purge whose order is not
    // actually decided. `import_uploads` references `import_runs`, so the child
    // is deleted first — and it is deleted explicitly rather than through the
    // cascade because the target row records how many rows each name removed,
    // and a cascade removes them without telling anybody.
    await tx.update(sites).set({ publishedImportRunId: null }).where(eq(sites.id, input.siteId))

    await removeFrom('import_uploads', () =>
      tx
        .delete(importUploads)
        .where(
          sql`${importUploads.importRunId} IN (
            SELECT id FROM ${importRuns} WHERE site_id = ${input.siteId}::uuid
          )`,
        )
        .returning({ id: importUploads.id }),
    )
    // Exports go **before** the runs they pin (ADR-0032, D8/D9).
    // `export_runs.pinned_import_run_id` is declared `ON DELETE SET NULL`, so
    // the order is not a correctness requirement here — but deleting the
    // pointing rows first means the runs are removed without any row being
    // rewritten on the way, and it keeps this block reading in the direction the
    // FKs point. Their object keys were snapshotted at deletion start, long
    // before this transaction: that is the whole reason `object_purge` runs
    // first.
    await removeFrom('export_runs', () =>
      tx.delete(exportRuns).where(eq(exportRuns.siteId, input.siteId)).returning({
        id: exportRuns.id,
      }),
    )

    await removeFrom('import_runs', () =>
      tx.delete(importRuns).where(eq(importRuns.siteId, input.siteId)).returning({
        id: importRuns.id,
      }),
    )

    // The revenue block (ADR-0033, D3/D8), children before the parent.
    //
    // `revenue_provider_events` and `revenue_sync_state` both reference
    // `revenue_credentials`, so the credential row cannot go first — and while
    // both FKs are `ON DELETE CASCADE`, relying on the cascade is exactly what
    // this loop must not do: a cascade removes the rows without returning them,
    // and the target row's whole job is to record how many each *name* removed.
    // A target that verified at `deleted: 0` while a cascade quietly did the
    // work is the failure mode D8 names — a name with no purge statement behind
    // it — arriving through the back door.
    //
    // `revenue_objects` has no FK to the credential at all (a site's facts
    // outlive a disconnect and a reconnect), so it is ordered here only for
    // readability: the three revenue ingest tables belong together.
    await removeFrom('revenue_provider_events', () =>
      tx
        .delete(revenueProviderEvents)
        .where(eq(revenueProviderEvents.siteId, input.siteId))
        .returning({ id: revenueProviderEvents.id }),
    )
    await removeFrom('revenue_objects', () =>
      tx
        .delete(revenueObjects)
        .where(eq(revenueObjects.siteId, input.siteId))
        .returning({ id: revenueObjects.id }),
    )
    await removeFrom('revenue_sync_state', () =>
      tx
        .delete(revenueSyncState)
        .where(eq(revenueSyncState.siteId, input.siteId))
        .returning({ id: revenueSyncState.id }),
    )
    // The checkout match hints (ADR-0033, D6/D8 amendment; migration 0035).
    //
    // Site-scoped like the rest of the revenue block, and a target of its own
    // rather than a cascade for the reason stated above: a cascade removes the
    // rows without returning them, and this row's whole job is to record how
    // many *this name* removed. It references only `sites`, so it has no
    // ordering constraint against its neighbours.
    await removeFrom('revenue_match_hints', () =>
      tx
        .delete(revenueMatchHints)
        .where(eq(revenueMatchHints.siteId, input.siteId))
        .returning({ id: revenueMatchHints.id }),
    )
    // The subscription lifecycle (Perier gap 7; migration 0047). Each table
    // references only `sites`, so the order among the three is free.
    await removeFrom('revenue_subscription_changes', () =>
      tx
        .delete(revenueSubscriptionChanges)
        .where(eq(revenueSubscriptionChanges.siteId, input.siteId))
        .returning({ id: revenueSubscriptionChanges.id }),
    )
    await removeFrom('revenue_subscriptions', () =>
      tx
        .delete(revenueSubscriptions)
        .where(eq(revenueSubscriptions.siteId, input.siteId))
        .returning({ id: revenueSubscriptions.id }),
    )
    await removeFrom('revenue_invoices', () =>
      tx
        .delete(revenueInvoices)
        .where(eq(revenueInvoices.siteId, input.siteId))
        .returning({ id: revenueInvoices.id }),
    )
    // The attribution job's control row (ADR-0033, D6/D8; migration 0036).
    //
    // `session_finalizer_state`'s neighbour and its exact analogue: the FK to
    // `sites` is integrity only with NO cascade, because the sites row is never
    // hard-deleted, so this row would simply outlive the site if the purge did
    // not name it. Its primary key IS the site id, so the delete returns at most
    // one row -- which is what the target's count records.
    await removeFrom('revenue_attribution_state', () =>
      tx
        .delete(revenueAttributionState)
        .where(eq(revenueAttributionState.siteId, input.siteId))
        // `id` rather than `siteId`, because `removeFrom` counts rows through a
        // uniform `{ id }` shape. The site id IS this table's primary key, so
        // the alias is naming the same column the other targets return.
        .returning({ id: revenueAttributionState.siteId }),
    )

    // The credentials last of the four (ADR-0033, D3/D8). Their ciphertexts were
    // already nulled by `startSiteDeletion`, phases ago; this removes the rows.
    // Stated explicitly rather than left to the `sites` cascade, for the reason
    // above.
    //
    // `currency_rates` is deliberately absent and is not an omission: it holds
    // the ECB's published rates with no site dimension at all, shared by every
    // site's conversions, and D2c rules it global reference data rather than a
    // deletion target.
    await removeFrom('revenue_credentials', () =>
      tx
        .delete(revenueCredentials)
        .where(eq(revenueCredentials.siteId, input.siteId))
        .returning({ id: revenueCredentials.id }),
    )

    // The event builder's two tables (ADR-0034, D9; migration 0038).
    //
    // The published pointer is dropped first. `event_definitions
    // .published_version` is a composite FK *into* the versions table, so
    // deleting a published definition's versions while it still points at one
    // would violate it — the same shape as `sites.published_import_run_id`
    // above, and handled the same way: null the pointer, then delete in
    // child-before-parent order so each delete can report its own row count.
    // Leaving it to the cascade would remove the version rows without telling
    // anybody how many, and the target row's whole job is to record that number.
    await tx
      .update(eventDefinitions)
      .set({ publishedVersion: null })
      .where(eq(eventDefinitions.siteId, input.siteId))

    // Scoped through the parent rather than by a `site_id` column, because a
    // version row deliberately has none: its site is whatever its definition's
    // is, and a second copy of that fact could disagree with the first.
    await removeFrom('event_definition_versions', () =>
      tx
        .delete(eventDefinitionVersions)
        .where(
          inArray(
            eventDefinitionVersions.definitionId,
            tx
              .select({ id: eventDefinitions.id })
              .from(eventDefinitions)
              .where(eq(eventDefinitions.siteId, input.siteId)),
          ),
        )
        .returning({ id: eventDefinitionVersions.id }),
    )
    await removeFrom('event_definitions', () =>
      tx
        .delete(eventDefinitions)
        .where(eq(eventDefinitions.siteId, input.siteId))
        .returning({ id: eventDefinitions.id }),
    )

    // The embeddable widgets (ADR-0045, D8; migration 0048).
    //
    // No ordering constraint: nothing references `widgets`, and its own two
    // references point outward. Named rather than left to the `sites` cascade
    // for the reason every neighbour above is — a cascade removes the rows
    // without returning them, and this target's job is to record how many.
    //
    // What is being removed is a set of live public credentials: every row is
    // an id sitting in the HTML of a page that is not ours, so the count is the
    // only evidence that a deleted site's embeds stopped resolving.
    await removeFrom('widgets', () =>
      tx.delete(widgets).where(eq(widgets.siteId, input.siteId)).returning({ id: widgets.id }),
    )

    // Where this site's API keys were used from (ADR-0051, D5; migration 0050).
    //
    // Scoped by `site_id`, which is set on the `api_key` rows and null on the
    // `oauth_grant` ones — so this removes the site's half of the table and
    // cannot reach a person's. The keys themselves went above, under
    // `api_keys`; this is the telemetry about them, and it has to go with them
    // or a deleted site would leave behind a record of where it was
    // administered from.
    await removeFrom('credential_sources', () =>
      tx
        .delete(credentialSources)
        .where(eq(credentialSources.siteId, input.siteId))
        .returning({ id: credentialSources.id }),
    )

    return { deleted }
  })
}

/**
 * The site ids that are still finalizable (ADR-0030, decision 7).
 *
 * `suspended` is included on purpose: a blocked site's data is retained
 * for the whole retention window and must be *correct* if the customer pays and
 * it reactivates. What is excluded is `deleting`/`deleted`, where a finalizer run
 * would insert fact and rollup rows into tables a purge has already verified as
 * empty.
 *
 * A site with no row at all is excluded too, which matters because
 * `listSitesToFinalize` discovers from ClickHouse: a site whose Postgres row is
 * gone cannot be authorised for anything.
 */
export async function listSiteStatuses(
  db: Executor,
  siteIds: readonly string[],
): Promise<Map<string, SiteStatus>> {
  if (siteIds.length === 0) return new Map()
  const rows = await db
    .select({ id: sites.id, status: sites.status })
    .from(sites)
    .where(inArray(sites.id, [...siteIds]))
  return new Map(rows.map((row) => [row.id, row.status]))
}

/** Statuses whose sites the session finalizer may still process. */
export const FINALIZABLE_SITE_STATUSES: readonly SiteStatus[] = ['active', 'suspended']

export async function filterFinalizableSites(
  db: Executor,
  siteIds: readonly string[],
): Promise<string[]> {
  const statuses = await listSiteStatuses(db, siteIds)
  return siteIds.filter((siteId) => {
    const status = statuses.get(siteId)
    return status !== undefined && FINALIZABLE_SITE_STATUSES.includes(status)
  })
}

export interface FinalizeSiteDeletionInput {
  readonly deletionRequestId: string
  readonly siteId: string
  readonly now?: Date
}

/**
 * The tombstone (ADR-0030, D4 `verify`/`finalize`).
 *
 * One transaction: the site becomes `deleted` with a blank name and a rewritten
 * slug, the request completes, and the audit row lands with them. The slug
 * rewrite is what frees `sites_slug_key` so the customer can create a new site
 * with the old slug — and the id is deliberately *not* freed: ADR-0027's rule is
 * that a deleted site id never returns, which is what keeps the worker's
 * `first_event_at` cache and every recorded fence registration sound.
 *
 * The `sites` UPDATE fires the ownership constraint trigger on a row whose
 * members `postgres_purge` has already removed; migration 0028's status
 * exemption is what lets it commit.
 *
 * It also asserts, by deleting it, that no `session_finalizer_state` row for the
 * site survives — see the statement's own comment for why an UPSERT-shaped lease
 * makes that assertion worth a statement rather than a comment.
 *
 * The `site.deletion_completed` outbox row is written here rather than by the
 * caller so it shares the transaction: an outbox row for a deletion that rolled
 * back would announce something that did not happen.
 */
export async function finalizeSiteDeletion(
  db: Database,
  input: FinalizeSiteDeletionInput,
): Promise<void> {
  const now = input.now ?? new Date()

  await db.transaction(async (tx) => {
    // Defensive, and deliberately not a no-op: `claimFinalizerSite` is an UPSERT,
    // so any path that claims the lease after `postgres_purge` verified the row
    // gone resurrects it — a row for a site whose events no longer exist, with a
    // watermark nothing can advance, and (worse) a `deletion_targets` row that
    // says `session_finalizer_state` was purged. The tombstone is the statement
    // that the site's Postgres rows are gone, so it is the right place to make
    // that true rather than merely assert it. Ordinarily this deletes nothing.
    await tx.delete(sessionFinalizerState).where(eq(sessionFinalizerState.siteId, input.siteId))

    await tx
      .update(sites)
      .set({
        status: 'deleted',
        name: '',
        slug: `deleted-${input.siteId}`,
        updatedAt: now,
      })
      .where(eq(sites.id, input.siteId))

    await tx
      .update(deletionRequests)
      .set({ status: 'completed', completedAt: now })
      .where(eq(deletionRequests.id, input.deletionRequestId))

    await writeAudit(tx, {
      action: 'site.deletion_completed',
      actorType: 'system',
      siteId: input.siteId,
      targetType: 'site',
      targetId: input.siteId,
      metadata: { deletion_request_id: input.deletionRequestId },
    })

    // In the same transaction as the tombstone: an outbox row announcing a
    // deletion that then rolled back would be a statement about something that
    // did not happen. Keyed on the request id, so a re-run of an already
    // completed job finds the row already enqueued.
    await enqueueOutbox(tx, {
      topic: SITE_DELETION_COMPLETED_TOPIC,
      idempotencyKey: `${SITE_DELETION_COMPLETED_TOPIC}:${input.deletionRequestId}`,
      payload: { deletion_request_id: input.deletionRequestId, site_id: input.siteId },
    })
  })
}

export interface MarkSiteDeletionFailedInput {
  /** The request the dead job was working. Omitted when the job's payload never
   * named one — a producer bug — in which case the site's own live request is
   * the only thing that can be settled. */
  readonly deletionRequestId?: string
  readonly siteId: string
  readonly reason: string
}

/**
 * Mark a site's deletion request `failed` — the settlement for a job that will
 * never finish (ADR-0030, decision 3's terminal path).
 *
 * The mirror of `markAccountDeletionFailed`, and it exists for the same reason
 * that one does: `startSiteDeletion` decides what to do by *finding a
 * pending/running request*, so a request left `pending` behind a dead job is a
 * site that reports a deletion in progress forever while nothing is deleting it.
 * Moving it out of the live set is what lets the next call revive it.
 *
 * `completed_at` is explicitly nulled rather than left alone. A failure is not a
 * completion, and the column is what an operator's "when did this finish?" read
 * looks at; a request that had been finalized and then, on some later path,
 * failed would otherwise carry a completion instant beside a failed status.
 *
 * The site row is deliberately *not* touched. It stays `deleting`: its data is
 * still half-purged, its keys are still revoked, and flipping it back to
 * `active` would re-admit events into a site whose ClickHouse rows are partly
 * gone. `deleting` with a failed request is exactly the state the revive path
 * knows how to pick up.
 */
export async function markSiteDeletionFailed(
  db: Database,
  input: MarkSiteDeletionFailedInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Guarded on the live statuses: an already-`completed` request must not be
    // rewritten as failed by a job that outlived its own finalization.
    const failed = await tx
      .update(deletionRequests)
      .set({ status: 'failed', completedAt: null })
      .where(
        and(
          inArray(deletionRequests.status, ['pending', 'running']),
          input.deletionRequestId === undefined
            ? and(
                eq(deletionRequests.subjectType, 'site'),
                eq(deletionRequests.subjectId, input.siteId),
              )
            : eq(deletionRequests.id, input.deletionRequestId),
        ),
      )
      .returning({ id: deletionRequests.id })

    // Only when something actually moved: a row recording a guard that matched
    // nothing would be an audit entry for a write that did not happen.
    if (failed.length === 0) return

    await writeAudit(tx, {
      action: 'site.deletion_failed',
      actorType: 'system',
      siteId: input.siteId,
      targetType: 'site',
      targetId: input.siteId,
      metadata: {
        deletion_request_id: input.deletionRequestId ?? failed[0]?.id ?? null,
        requests_failed: failed.length,
        reason: input.reason,
      },
    })
  })
}

/** Move the request to `running` on the first phase that does real work. */
export async function markDeletionRequestRunning(
  db: Executor,
  deletionRequestId: string,
): Promise<void> {
  await db
    .update(deletionRequests)
    .set({ status: 'running' })
    .where(and(eq(deletionRequests.id, deletionRequestId), eq(deletionRequests.status, 'pending')))
}

/**
 * The site's current members, as realtime-epoch subjects.
 *
 * Read during `redis_purge` and therefore *before* `postgres_purge` deletes the
 * rows — the phase order is what makes the epoch keys enumerable at all. There
 * is no `SCAN` fallback: ADR-0030 decision 5 records the epoch keys of members
 * removed before the TTL deploy as an accepted, bounded, non-secret residue
 * rather than chasing them across the keyspace.
 */
export async function listSiteMemberUserIds(db: Executor, siteId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: siteMembers.userId })
    .from(siteMembers)
    .where(eq(siteMembers.siteId, siteId))
  return rows.map((row) => row.userId)
}

/** Re-exported so the executor's phase vocabulary and the job's `phase` column
 * agree without either side restating the strings. */
export type { SiteDeletionPhase }
