import {
  decideRevenueObject,
  type RevenueLifecycleSyncResource,
  type RevenueIngestSource,
  type RevenueLedgerStatus,
  type RevenueObjectDecision,
  type RevenueObservation,
  type RevenueSyncResource,
} from '@openanalytics/domain'
import { and, asc, eq, inArray, isNull, lt, ne, notExists, or, sql } from 'drizzle-orm'
import type { Database, Executor } from '../client.ts'
import { newId } from '../ids.ts'
import { enqueueJob } from './jobs.ts'
import { jobs } from '../schema/lifecycle.ts'
import { sites } from '../schema/sites.ts'
import {
  revenueCredentials,
  revenueObjects,
  revenueProviderEvents,
  revenueSyncState,
} from '../schema/revenue.ts'

/**
 * Revenue ingest storage — the delivery ledger, the object head and the sync
 * cursors (ADR-0033, D4; migration 0034).
 *
 * Three write paths live here and they are deliberately in one module, because
 * they are one guarantee spelled three ways. The acceptance criterion this
 * milestone is graded on — *a duplicate or out-of-order provider event never
 * counts twice* — is enforced at two independent layers that compose:
 *
 * 1. **Delivery idempotency** (`recordRevenueProviderEvent`). `(site, provider,
 *    event_id)` is unique; a redelivery of an already-`processed` event
 *    short-circuits without redoing the work. A row a crash left `received` is
 *    safely reprocessed, because layer 2 is itself idempotent.
 * 2. **State idempotency and ordering** (`applyRevenueObservation`). The object
 *    head is read `FOR UPDATE`, the pure three-way decision runs against it, and
 *    the write happens in the *same* transaction. Deciding from a read taken in
 *    an earlier transaction is precisely the race ADR-0021 had to fix on the
 *    billing side; it is not repeated here.
 *
 * The site dimension is what separates this from M3's ledger: the same Stripe
 * account connected to two OA sites processes one `evt_…` once **per site**.
 *
 * Nothing in this module ever sees a plaintext credential, a provider response
 * body or a raw email. It stores hashes, canonical snapshots and categorized
 * results.
 *
 * ## Known gap: a delivery stuck at `received` (CP2, recorded not fixed)
 *
 * When the tie-break re-fetch fails, the route answers 5xx and deliberately
 * leaves the ledger row `received` so the provider redelivers. That recovery
 * depends on the provider *continuing to retry*, and Stripe eventually stops —
 * after which the row stays `received` with nothing scanning for it.
 *
 * The consequence is bounded and is not silent data loss: the object head is
 * updated by every later observation of the same object, and the reconcile
 * sweep re-lists a trailing window regardless of the ledger, so a charge whose
 * delivery got stuck is repaired by the next sweep as long as it is inside that
 * window. What is genuinely lost is a *late* update to an object created outside
 * the sweep's window (see the note in the worker's `sync.ts`).
 *
 * `revenue_provider_events_unsettled_idx` exists so the sweep that closes this
 * is a cheap query rather than a table scan; it has **no consumer in CP2**, and
 * writing one now would mean deciding a re-drive policy before CP3's fact writer
 * exists to say what re-driving should produce.
 *
 * **Closed in CP3 as visibility rather than repair** (`failStuckRevenueDeliveries`
 * below, driven by the reconcile tick). The re-drive policy the note was waiting
 * on turned out to be "there is none, and there cannot be": the ledger stores a
 * `payload_hash` and never the body, so nothing is left to reprocess — and the
 * reconcile sweep already re-lists a trailing window regardless of the ledger,
 * which is the actual repair. What was missing was a row nobody counted, so the
 * sweep settles it `failed` with a categorized result and emits a metric.
 */

/**
 * The backfill job type (ADR-0033, D4).
 *
 * Named here rather than at either end, the reason `SITE_DELETION_JOB_TYPE`
 * gives: the api's connect handler enqueues it and the worker's registry
 * executes it, and a literal in two places is a registry entry that silently
 * never fires.
 *
 * Its subject is a **credential** id, not a site id. The `jobs` table admits
 * that without change — `subject_id` is an untyped uuid — and the partial unique
 * on `(type, subject_id)` then means exactly what it should: **one live backfill
 * per credential**. Keying it on the site would have been wrong the day a site
 * connects a second provider, and keying it on nothing would let a reconnect
 * start a second ninety-day walk beside the first.
 */
export const REVENUE_BACKFILL_JOB_TYPE = 'revenue_backfill'

/**
 * Enqueue a 90-day backfill for a credential at a given generation (D2e/D4).
 *
 * Takes an `Executor` so it composes into the connect and rotate transactions:
 * the credential row and the job that fills it commit together, and a crash
 * between them cannot leave a connected provider whose history nobody is
 * walking.
 *
 * ## The generation is the whole point of the signature
 *
 * `enqueueJob`'s idempotency key is permanent — it matches a job in *any*
 * status, including `failed_terminal`. A key of `revenue_backfill:{credential}`
 * would therefore be **spent forever** the first time a walk gave up, and
 * `enqueued: false` would then be indistinguishable from "already running". That
 * is not a theoretical failure: a restricted key created with `Charges` read but
 * not `Disputes` passes the connect probe (which reads charges) and terminals
 * the walk on the third resource, at which point the customer's ninety days
 * become unrecoverable while the read surface still reports a connection.
 *
 * So the key carries `revenue_credentials.backfill_generation`, and the counter
 * is bumped by every event that means "try again with something new": a key
 * rotation, and `requestRevenueBackfill` below. What still holds is the *safety*
 * property — `jobs_live_subject_key` is a partial unique on
 * `(type, subject_id)` over the live statuses, so a bump while a walk is running
 * enqueues nothing rather than starting a second concurrent walk over the same
 * cursors.
 *
 * A disconnect-and-reconnect needs no bump: it mints a new credential id, which
 * is a different subject and a different key.
 */
export async function enqueueRevenueBackfill(
  db: Executor,
  input: {
    readonly credentialId: string
    readonly siteId: string
    readonly provider: string
    readonly generation: number
  },
): Promise<{ readonly enqueued: boolean; readonly id: string | null }> {
  return await enqueueJob(db, {
    type: REVENUE_BACKFILL_JOB_TYPE,
    subjectId: input.credentialId,
    payload: {
      site_id: input.siteId,
      provider: input.provider,
      generation: input.generation,
    },
    idempotencyKey: `${REVENUE_BACKFILL_JOB_TYPE}:${input.credentialId}:${String(input.generation)}`,
  })
}

export interface RequestRevenueBackfillResult {
  readonly enqueued: boolean
  readonly jobId: string | null
  readonly generation: number | null
}

/**
 * The manual re-run hook: bump the generation and enqueue, in one transaction.
 *
 * This is what an operator — or a later customer-facing "resync" button — calls
 * to recover a backfill that gave up. It exists as a separate function from
 * `enqueueRevenueBackfill` because the two answer different questions: that one
 * is "enqueue the walk for *this* generation" and composes into a transaction
 * that has already decided the generation, while this one is "start a walk that
 * has not been tried yet" and has to mint the generation itself.
 *
 * Guarded on the credential being live: a disconnected credential holds no
 * ciphertext, so a walk enqueued for it could only fail on decryption.
 *
 * Idempotent in the way that matters rather than in the trivial way: calling it
 * twice in a row *does* bump twice, but the second enqueue is refused by the
 * live-job index, so the outcome is one walk either way.
 */
export async function requestRevenueBackfill(
  db: Database,
  input: { readonly credentialId: string; readonly siteId: string },
): Promise<RequestRevenueBackfillResult> {
  return await db.transaction(async (tx) => {
    const [bumped] = await tx
      .update(revenueCredentials)
      .set({
        backfillGeneration: sql`${revenueCredentials.backfillGeneration} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(revenueCredentials.id, input.credentialId),
          eq(revenueCredentials.siteId, input.siteId),
          ne(revenueCredentials.status, 'disabled'),
        ),
      )
      .returning({
        id: revenueCredentials.id,
        provider: revenueCredentials.provider,
        generation: revenueCredentials.backfillGeneration,
      })

    if (!bumped) return { enqueued: false, jobId: null, generation: null }

    const enqueued = await enqueueRevenueBackfill(tx, {
      credentialId: bumped.id,
      siteId: input.siteId,
      provider: bumped.provider,
      generation: bumped.generation,
    })
    return { enqueued: enqueued.enqueued, jobId: enqueued.id, generation: bumped.generation }
  })
}

// --- The delivery ledger -----------------------------------------------------

export interface RecordRevenueEventInput {
  readonly siteId: string
  readonly credentialId: string
  readonly provider: string
  /** A provider delivery id, or the deterministic synthetic id a sync row uses
   * (`revenueBackfillEventId`). */
  readonly providerEventId: string
  readonly payloadHash: string
  readonly source: RevenueIngestSource
  readonly now?: Date
}

export interface RecordedRevenueEvent {
  readonly id: string
  /** False when this `(site, provider, event id)` was already in the ledger. */
  readonly firstSeen: boolean
  readonly status: RevenueLedgerStatus
}

/**
 * Insert the delivery, or report the one already there.
 *
 * `ON CONFLICT DO NOTHING` followed by a read, exactly as `recordWebhookEvent`
 * does. The conflict is decided by the unique index rather than by a preceding
 * `SELECT`: two concurrent deliveries of one event — ordinary provider traffic,
 * and the normal shape of a retry that overlaps its original — would otherwise
 * both find no row and both process it.
 */
export async function recordRevenueProviderEvent(
  db: Executor,
  input: RecordRevenueEventInput,
): Promise<RecordedRevenueEvent> {
  const inserted = await db
    .insert(revenueProviderEvents)
    .values({
      id: newId(),
      siteId: input.siteId,
      credentialId: input.credentialId,
      provider: input.provider,
      providerEventId: input.providerEventId,
      payloadHash: input.payloadHash,
      source: input.source,
      status: 'received',
      ...(input.now === undefined ? {} : { receivedAt: input.now }),
    })
    .onConflictDoNothing({
      target: [
        revenueProviderEvents.siteId,
        revenueProviderEvents.provider,
        revenueProviderEvents.providerEventId,
      ],
    })
    .returning({ id: revenueProviderEvents.id, status: revenueProviderEvents.status })

  const row = inserted[0]
  if (row) return { id: row.id, firstSeen: true, status: row.status }

  const [existing] = await db
    .select({ id: revenueProviderEvents.id, status: revenueProviderEvents.status })
    .from(revenueProviderEvents)
    .where(
      and(
        eq(revenueProviderEvents.siteId, input.siteId),
        eq(revenueProviderEvents.provider, input.provider),
        eq(revenueProviderEvents.providerEventId, input.providerEventId),
      ),
    )
  if (!existing) throw new Error('revenue ledger row vanished after conflict')
  return { id: existing.id, firstSeen: false, status: existing.status }
}

/**
 * Settle a ledger row.
 *
 * `received` is deliberately unreachable from here: it is the *insert's* state,
 * and a settler that could write it back would be a path that un-processes a
 * delivery — after which the provider would never redeliver it, because it was
 * already acknowledged.
 */
export async function markRevenueProviderEvent(
  db: Executor,
  input: {
    readonly id: string
    readonly status: Exclude<RevenueLedgerStatus, 'received'>
    readonly result?: Record<string, unknown>
    readonly now?: Date
  },
): Promise<void> {
  await db
    .update(revenueProviderEvents)
    .set({
      status: input.status,
      processedAt: input.now ?? new Date(),
      ...(input.result === undefined ? {} : { result: input.result }),
    })
    .where(eq(revenueProviderEvents.id, input.id))
}

/**
 * The `last_error` a credential carries when the provider rejected its key.
 *
 * A shared literal because three places must agree on it: the sync path writes
 * it, the reconcile discovery below *excludes* on it, and the recovery rule
 * ("only a completed walk or a fresh secret clears it") is stated against it. A
 * typo in any one of them would produce a credential that is retried 1,440 times
 * a day against a provider that has already said no.
 */
export const REVENUE_UNAUTHORIZED_ERROR = 'unauthorized'

/**
 * Record a delivery to a **disconnected** credential, bounded to one row.
 *
 * A disabled credential has no signing secret left (disconnect erases both
 * ciphertexts in one UPDATE), so nothing about the body can be verified — and
 * yet the endpoint must answer 200, or the provider disables it and emails the
 * customer about an integration they deliberately switched off.
 *
 * The bound is the point. Keying the row on a *payload* hash would let anyone
 * holding the old URL write one ledger row per distinct body, forever, by
 * varying a single byte. **The chosen rule is at most one row per credential**,
 * ever: the id is `unverified:disabled:{credential_id}`, so the first delivery
 * inserts and every later one increments a counter in `result`. What an operator
 * needs to know — "your disconnected provider is still posting, and it has done
 * so N times" — survives intact, and the write amplification an unauthenticated
 * caller can cause is one UPDATE of one row.
 *
 * One statement, so a burst cannot interleave into a lost count.
 */
export async function noteDisabledRevenueDelivery(
  db: Executor,
  input: {
    readonly siteId: string
    readonly credentialId: string
    readonly provider: string
    readonly payloadHash: string
    readonly now?: Date
  },
): Promise<{ readonly deliveries: number }> {
  const now = input.now ?? new Date()
  const rows = await db
    .insert(revenueProviderEvents)
    .values({
      id: newId(),
      siteId: input.siteId,
      credentialId: input.credentialId,
      provider: input.provider,
      providerEventId: `unverified:disabled:${input.credentialId}`,
      payloadHash: input.payloadHash,
      source: 'webhook',
      status: 'ignored',
      receivedAt: now,
      processedAt: now,
      result: { reason: 'credential_disabled', deliveries: 1 },
    })
    .onConflictDoUpdate({
      target: [
        revenueProviderEvents.siteId,
        revenueProviderEvents.provider,
        revenueProviderEvents.providerEventId,
      ],
      set: {
        processedAt: now,
        status: 'ignored',
        result: sql`jsonb_build_object(
          'reason', 'credential_disabled',
          'deliveries', COALESCE((${revenueProviderEvents.result} ->> 'deliveries')::bigint, 0) + 1
        )`,
      },
    })
    .returning({ result: revenueProviderEvents.result })

  const deliveries = rows[0]?.result?.['deliveries']
  return { deliveries: typeof deliveries === 'number' ? deliveries : 1 }
}

/** Reconciliation and test helper: the ledger row for a delivery, if present. */
export async function readRevenueProviderEvent(
  db: Executor,
  input: { readonly siteId: string; readonly provider: string; readonly providerEventId: string },
): Promise<{ id: string; status: RevenueLedgerStatus; source: RevenueIngestSource } | null> {
  const [row] = await db
    .select({
      id: revenueProviderEvents.id,
      status: revenueProviderEvents.status,
      source: revenueProviderEvents.source,
    })
    .from(revenueProviderEvents)
    .where(
      and(
        eq(revenueProviderEvents.siteId, input.siteId),
        eq(revenueProviderEvents.provider, input.provider),
        eq(revenueProviderEvents.providerEventId, input.providerEventId),
      ),
    )
  return row ?? null
}

// --- The object head ---------------------------------------------------------

export interface ApplyRevenueObservationInput {
  readonly siteId: string
  readonly provider: string
  readonly observation: RevenueObservation
  readonly payloadHash: string
  /**
   * The tie-break's second pass: the caller has re-fetched the authoritative
   * object from the provider and is applying what the provider says is true.
   *
   * It bypasses the *ambiguity*, never the ordering — the pure decision still
   * refuses a snapshot strictly older than the stored one, because the lock was
   * released for the network round-trip and the row may have moved on.
   */
  readonly force?: boolean
  readonly now?: Date
}

export interface AppliedRevenueObservation {
  readonly decision: RevenueObjectDecision
  /** The head row's id, when one exists after this call. */
  readonly objectRowId: string | null
}

/**
 * Decide and write one observation, in one transaction with the head locked.
 *
 * The `SELECT … FOR UPDATE` is the serialization point for everything that can
 * touch this object: the webhook route, the backfill job and the reconcile
 * sweep. That is *why* those three need no coordination of their own — a
 * backfill page and a webhook delivery for the same charge queue on this row
 * lock, and whichever loses the race then re-decides against what the winner
 * wrote rather than against a stale read. It is also why the reconcile loop and
 * a running backfill for one credential cannot interleave destructively: they do
 * not share a cursor row per resource *and* per direction, and every write they
 * both make funnels through here, where the three-way rule refuses the older of
 * two observations whichever of them arrived first.
 *
 * The insert path is a retry loop rather than a single statement, and the reason
 * is a genuine gap in `FOR UPDATE`: locking a row that does not exist locks
 * nothing, so two transactions can both find the head absent. The insert
 * therefore takes `ON CONFLICT DO NOTHING`, and a refused insert means somebody
 * else created the head between the read and the write — at which point the
 * second pass finds a real row, takes a real lock and decides properly. Two
 * passes suffice: a head is never deleted except by a site purge, so the second
 * read cannot find it absent again.
 */
export async function applyRevenueObservation(
  db: Database,
  input: ApplyRevenueObservationInput,
): Promise<AppliedRevenueObservation> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await applyOnce(db, input, attempt === 1)
    if (result) return result
  }
  // Unreachable: the second pass is forced to take the update branch.
  throw new Error('revenue object head could not be materialized')
}

async function applyOnce(
  db: Database,
  input: ApplyRevenueObservationInput,
  final: boolean,
): Promise<AppliedRevenueObservation | null> {
  const now = input.now ?? new Date()
  const { observation } = input

  return await db.transaction(async (tx) => {
    const [stored] = await tx
      .select({
        id: revenueObjects.id,
        snapshotAt: revenueObjects.snapshotAt,
        payloadHash: revenueObjects.payloadHash,
        version: revenueObjects.version,
      })
      .from(revenueObjects)
      .where(
        and(
          eq(revenueObjects.siteId, input.siteId),
          eq(revenueObjects.provider, input.provider),
          eq(revenueObjects.objectId, observation.objectId),
        ),
      )
      .for('update')

    const decision = decideRevenueObject(
      stored
        ? {
            snapshotAt: stored.snapshotAt,
            payloadHash: stored.payloadHash,
            version: stored.version,
          }
        : null,
      { snapshotAt: observation.snapshotAt, payloadHash: input.payloadHash },
      input.force === true ? { force: true } : {},
    )

    if (decision.action !== 'apply') {
      return { decision, objectRowId: stored?.id ?? null }
    }

    if (stored) {
      await tx
        .update(revenueObjects)
        .set({
          objectKind: observation.objectKind,
          snapshotAt: observation.snapshotAt,
          payloadHash: input.payloadHash,
          version: decision.version,
          normalized: observation.normalized,
          updatedAt: now,
        })
        // Guarded on the version the decision was taken against. Redundant while
        // the row lock is held — and kept anyway, because it is the assertion
        // that the lock is doing what this function claims it does.
        .where(and(eq(revenueObjects.id, stored.id), eq(revenueObjects.version, stored.version)))
      return { decision, objectRowId: stored.id }
    }

    const id = newId()
    const inserted = await tx
      .insert(revenueObjects)
      .values({
        id,
        siteId: input.siteId,
        provider: input.provider,
        objectId: observation.objectId,
        objectKind: observation.objectKind,
        snapshotAt: observation.snapshotAt,
        payloadHash: input.payloadHash,
        version: decision.version,
        normalized: observation.normalized,
        firstSeenAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [revenueObjects.siteId, revenueObjects.provider, revenueObjects.objectId],
      })
      .returning({ id: revenueObjects.id })

    const row = inserted[0]
    if (row) return { decision, objectRowId: row.id }
    if (final) {
      // Would mean the head vanished between the two passes, which only a site
      // purge does — and a purge racing an ingest is a site whose observation
      // has nowhere to go. Loud rather than silently dropped.
      throw new Error('revenue object head conflicted twice')
    }
    return null
  })
}

export interface RevenueObjectHeadRow {
  readonly id: string
  readonly siteId: string
  readonly provider: string
  readonly objectId: string
  readonly objectKind: RevenueObservation['objectKind']
  readonly snapshotAt: Date
  readonly payloadHash: string
  readonly version: number
  readonly normalized: RevenueObservation['normalized']
  readonly firstSeenAt: Date
  readonly updatedAt: Date
  readonly projectedVersion: number
  readonly projectionEpoch: number
}

/** The stored head, for CP3's writer and for the tests that assert versioning. */
export async function readRevenueObject(
  db: Executor,
  input: { readonly siteId: string; readonly provider: string; readonly objectId: string },
): Promise<RevenueObjectHeadRow | null> {
  const [row] = await db
    .select()
    .from(revenueObjects)
    .where(
      and(
        eq(revenueObjects.siteId, input.siteId),
        eq(revenueObjects.provider, input.provider),
        eq(revenueObjects.objectId, input.objectId),
      ),
    )
  return row ?? null
}

// --- The projection queue (CP3) ----------------------------------------------

/**
 * A head the projection loop has not yet written to ClickHouse.
 *
 * Everything the row builder needs, in one read: the identity, the version being
 * projected, and the normalized snapshot the fact's columns come from.
 * `ingestedVia` is derived rather than stored — see below.
 */
export interface UnprojectedRevenueObject {
  readonly id: string
  readonly siteId: string
  readonly provider: string
  readonly objectId: string
  readonly objectKind: RevenueObservation['objectKind']
  readonly version: number
  readonly normalized: RevenueObservation['normalized']
  readonly firstSeenAt: Date
  /**
   * Stable per `(head, version)` — the object head rewrites it only when it
   * applies a new version.
   *
   * That is what makes it usable as the fact's `ingested_at`, and the projection
   * uses it for exactly that reason: the row builder has to be a pure function
   * of the head, or a crash-retry rebuilds a different row, hashes to a
   * different deduplication token, and writes a duplicate fact at the same
   * version.
   */
  readonly updatedAt: Date
  /** The re-materialization epoch, carried so the mark can require it to be
   * unchanged — see `markRevenueObjectsProjected`. */
  readonly projectionEpoch: number
}

/**
 * Sites with at least one head that has moved since it was last projected.
 *
 * Per site rather than a flat row scan, because the projection is per site by
 * necessity: it needs `sites.reporting_currency` and a per-site rate plan, and
 * interleaving two sites' rows would mean re-reading both on every batch.
 *
 * `DISTINCT` over the partial index (`WHERE projected_version < version`), so on
 * a steady-state installation this reads an empty index and returns nothing.
 * Ordered by site id so successive ticks are deterministic — an arbitrary order
 * would make a starved site's starvation depend on physical layout.
 */
export async function listSitesWithUnprojectedRevenue(
  db: Executor,
  input: { readonly limit: number },
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ siteId: revenueObjects.siteId })
    .from(revenueObjects)
    .where(sql`${revenueObjects.projectedVersion} < ${revenueObjects.version}`)
    .orderBy(asc(revenueObjects.siteId))
    .limit(input.limit)
  return rows.map((row) => row.siteId)
}

/**
 * One site's unprojected heads, oldest change first.
 *
 * Oldest-first is the property that makes a large backfill drain in arrival
 * order rather than physical order: a ninety-day walk produces thousands of
 * heads at once, and a projection that took them in whatever order the heap
 * offered would fill the dashboard's recent buckets last.
 *
 * `(updated_at, id)` rather than `updated_at` alone. Two heads written in one
 * transaction can share a timestamp to the microsecond, and an unstable tie
 * would let a bounded batch return one of them twice across ticks while never
 * returning the other — the classic keyset bug, and here it would look like a
 * charge that simply never reached ClickHouse.
 */
export async function listUnprojectedRevenueObjects(
  db: Executor,
  input: { readonly siteId: string; readonly limit: number },
): Promise<UnprojectedRevenueObject[]> {
  const rows = await db
    .select({
      id: revenueObjects.id,
      siteId: revenueObjects.siteId,
      provider: revenueObjects.provider,
      objectId: revenueObjects.objectId,
      objectKind: revenueObjects.objectKind,
      version: revenueObjects.version,
      normalized: revenueObjects.normalized,
      firstSeenAt: revenueObjects.firstSeenAt,
      updatedAt: revenueObjects.updatedAt,
      projectionEpoch: revenueObjects.projectionEpoch,
    })
    .from(revenueObjects)
    .where(
      and(
        eq(revenueObjects.siteId, input.siteId),
        sql`${revenueObjects.projectedVersion} < ${revenueObjects.version}`,
      ),
    )
    .orderBy(asc(revenueObjects.updatedAt), asc(revenueObjects.id))
    .limit(input.limit)
  return rows as UnprojectedRevenueObject[]
}

/**
 * The site's reporting currency (ADR-0033, D2c; migration 0033).
 *
 * Lives here rather than on the `sites` repository because it is a *projection*
 * input and reads better beside the queue it feeds — the alternative was
 * widening `getSiteBasics`, which every dashboard read already calls, to carry a
 * column only the revenue projection wants.
 *
 * Null when the site does not exist, which is not a theoretical case: a
 * projection tick can discover a site from `revenue_objects` and reach this read
 * after a purge deleted the `sites` row. The caller skips the site rather than
 * defaulting to `USD`, because materializing a whole site's reporting amounts
 * under a guessed currency is worse than not materializing them.
 */
export async function readSiteReportingCurrency(
  db: Executor,
  siteId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ reportingCurrency: sites.reportingCurrency })
    .from(sites)
    .where(eq(sites.id, siteId))
  return row?.reportingCurrency ?? null
}

/**
 * Record that a set of heads has been projected at the versions given.
 *
 * **Called after the ClickHouse insert has resolved, never before.** A crash
 * between the two re-projects heads whose rows are already in ClickHouse, where
 * the content-derived deduplication token drops them; the reverse ordering would
 * mark heads whose rows were never written, and a marker — unlike a watermark —
 * never comes back on its own.
 *
 * Three properties make the statement race-free, against two different racers:
 *
 * 1. The **literal** version that was projected is written, not the column. If
 *    the head moved to `version + 1` between the read and this call, writing the
 *    column would mark the *new* version as projected and lose it silently.
 * 2. The update is guarded `WHERE projected_version < literal`, so a marker can
 *    only ever move forward. A retry of the same batch after a later batch
 *    already advanced the row is a no-op rather than a rewind.
 * 3. The update additionally requires **`projection_epoch` to be unchanged**,
 *    which is what stops a re-materialization that landed mid-batch from being
 *    silently undone. Property 2 alone does not cover it:
 *    `resetRevenueProjection` zeroes the marker, and `0 < 3` satisfies that
 *    guard perfectly, so the batch would mark a head it had projected under the
 *    *old* reporting currency and nothing would ever pick it up again. Migration
 *    0035 walks the interleaving through step by step.
 *
 * Returns how many rows actually moved, which is what the caller reports: a
 * batch whose marks all no-op is a duplicate run or a reset that overtook it,
 * and that is worth being able to see.
 */
export async function markRevenueObjectsProjected(
  db: Executor,
  input: {
    readonly marks: readonly {
      readonly id: string
      readonly version: number
      /** The epoch read alongside the head. A mark whose epoch has since moved
       * is refused: the head was re-queued for re-materialization under it. */
      readonly epoch: number
    }[]
  },
): Promise<{ readonly marked: number }> {
  if (input.marks.length === 0) return { marked: 0 }

  let marked = 0
  for (const mark of input.marks) {
    const updated = await db
      .update(revenueObjects)
      .set({ projectedVersion: mark.version })
      .where(
        and(
          eq(revenueObjects.id, mark.id),
          lt(revenueObjects.projectedVersion, mark.version),
          eq(revenueObjects.projectionEpoch, mark.epoch),
        ),
      )
      .returning({ id: revenueObjects.id })
    marked += updated.length
  }
  return { marked }
}

/**
 * Reset a site's projection markers — the D2c re-materialization hook, **now
 * complete** (CP5 closes CP3's `TODO(CP5)`).
 *
 * Changing a site's `reporting_currency` makes every stored reporting amount
 * wrong, and D2c is explicit that the remedy is a **recompute, not a
 * re-ingest**: the heads are untouched and correct, only their projection is
 * stale. One statement expresses that exactly, because the marker is per row —
 * a timestamp watermark would have needed a rewind whose meaning depends on
 * clocks that were never reliable in the first place.
 *
 * ## The version bump is the whole reason this was not callable before
 *
 * CP3 shipped this function with no caller, and said why in as many words: it
 * reset the marker without bumping `version`, so a re-materialized fact **tied**
 * with the row it was meant to replace. A tie under `ReplacingMergeTree(version)`
 * is not merely "an arbitrary winner" — `argMax` is evaluated **per column**, so
 * one read could resolve `reporting_currency` from one version and
 * `reporting_gross_minor` from the other and return a row that never existed: a
 * EUR label beside a USD amount, with the answer free to change between two
 * identical queries as parts merge. That is a fabricated number, not a cosmetic
 * race.
 *
 * The `version + 1` below is what removes the hazard. It is safe against the
 * head's own writer: `applyRevenueObservation` mints `stored.version + 1` under
 * a `FOR UPDATE` lock and compares **snapshot times**, never versions, so a
 * version that jumped by one out from under it changes nothing about which
 * observation wins. Monotonicity — the only property ClickHouse cares about — is
 * preserved, and it is preserved per row rather than per site, so heads that
 * disagreed about their version before this call still disagree by the same
 * amount after it.
 *
 * ## Three writes, one statement, and each is load-bearing
 *
 * - `version + 1` — the restated fact supersedes rather than ties (above).
 * - `projected_version = 0` — the head becomes due again, under a predicate with
 *   no clock in it.
 * - `projection_epoch + 1` — refuses the mark of a batch that read these heads
 *   *before* the reset and would otherwise re-mark them as projected under the
 *   superseded currency.
 *
 * `updated_at` moves with them (the head is genuinely a new document from the
 * projection's point of view), which is also what makes the site discoverable by
 * the attribution job on its next tick.
 *
 * ## What it still does not do, by design
 *
 * It does not re-roll buckets older than the attribution job's rolling horizon.
 * Facts are the projection's problem; buckets are the rollup's, and the caller
 * must set `revenue_attribution_state.rollup_recompute_from` in the same
 * transaction (`markRevenueRollupRecompute`) or a year of history keeps its
 * amounts in the previous currency forever. Migration 0037 argues that at
 * length, including why the horizon's oldest-changed-head escape hatch is a race
 * rather than a free answer.
 *
 * ## Cost, and the operational caveat CP7 inherits
 *
 * This is one `UPDATE` over every head a site owns, inside the HTTP transaction
 * that changed the setting. Two things keep it as small as it can be: it counts
 * rows through the driver's `rowCount` rather than `RETURNING` every id (a large
 * account would otherwise ship a hundred thousand uuids back to a request that
 * wants a number), and the caller runs it **last**, after the `sites` row is
 * already updated, so the `FOR UPDATE` lock on that row is held for the shortest
 * span the ordering allows.
 *
 * What is NOT solved here: on a very large account this is a multi-second — in
 * the limit, multi-minute — transaction on a synchronous request. Moving it to
 * the job runner would be the real fix and would also break the "both halves or
 * neither" guarantee that makes the currency change safe at all, so it stays
 * transactional and the cost is recorded as a CP7 operational caveat rather than
 * redesigned under a review deadline. A currency change is a rare, deliberate,
 * owner-initiated action.
 */
export async function resetRevenueProjection(
  db: Executor,
  input: { readonly siteId: string; readonly now?: Date },
): Promise<{ readonly reset: number }> {
  const result = await db
    .update(revenueObjects)
    .set({
      // CP5. A restated row must WIN, not tie — see the header. Per row, so the
      // heads' relative versions are untouched.
      version: sql`${revenueObjects.version} + 1`,
      projectedVersion: 0,
      // The epoch bump is not bookkeeping: it is what refuses the mark of a batch
      // that read these heads before the reset and would otherwise re-mark them as
      // projected under the superseded currency.
      projectionEpoch: sql`${revenueObjects.projectionEpoch} + 1`,
      // The caller's clock, not this function's. Every other write in the
      // transaction carries one instant, and a second `new Date()` inside it
      // would stamp these heads a few milliseconds after the audit row that
      // explains them (the M10 database-clock rule).
      updatedAt: input.now ?? new Date(),
    })
    .where(eq(revenueObjects.siteId, input.siteId))
  // `rowCount` rather than `RETURNING id`: the caller wants a count, and a
  // site with a hundred thousand heads should not send a hundred thousand uuids
  // across the wire to produce one.
  return { reset: (result as unknown as { rowCount: number | null }).rowCount ?? 0 }
}

/**
 * The oldest unprojected change, as an instant — the projection lag gauge's
 * input.
 *
 * `min(updated_at)` over the unprojected set rather than `max`: what an operator
 * needs to know is how far *behind* the loop is, which is the age of the oldest
 * thing it has not done. The newest unprojected change is always roughly now and
 * would report a healthy loop and a stalled one identically.
 *
 * Null when nothing is pending, and the caller publishes zero rather than
 * omitting the series — a lag gauge that exists only while the loop is behind
 * cannot be told apart from a loop that stopped running.
 */
export async function readOldestUnprojectedRevenueChange(db: Executor): Promise<Date | null> {
  const [row] = await db
    .select({ oldest: sql<Date | string | null>`min(${revenueObjects.updatedAt})` })
    .from(revenueObjects)
    .where(sql`${revenueObjects.projectedVersion} < ${revenueObjects.version}`)

  const oldest = row?.oldest
  if (oldest === null || oldest === undefined) return null
  // A raw `sql` expression carries no Drizzle column mapper, so the driver's
  // value arrives as whatever it decoded — a `Date` for a `timestamptz` column
  // reference, but a **string** for an aggregate over one, which is what this
  // is. Normalized here rather than at the call site: the caller subtracts it
  // from `Date.now()` to publish a gauge, and a string would silently produce
  // `NaN` milliseconds — a lag series that exists, looks alive, and means
  // nothing.
  return oldest instanceof Date ? oldest : new Date(oldest)
}

// --- The stuck-delivery sweep (CP3) ------------------------------------------

/** The `result.reason` a swept delivery carries. Shared so the sweep, its
 * metric label and the tests cannot drift apart. */
export const REVENUE_STUCK_DELIVERY_REASON = 'stuck_delivery'

/**
 * Settle deliveries that have sat at `received` past the provider's own retry
 * horizon (CP2's recorded gap, closed here as **visibility, not repair**).
 *
 * ## What leaves a row `received`
 *
 * The webhook route answers 5xx and deliberately does not settle the ledger row
 * when a tie-break re-fetch fails, so the provider redelivers and the redelivery
 * finds an unsettled row and tries again. That recovery depends on the provider
 * *continuing* to retry, and Stripe eventually stops — after which the row stays
 * `received` with nothing scanning for it. `revenue_provider_events_unsettled_idx`
 * has existed since CP2 for exactly this scan and had no consumer until now.
 *
 * ## Why this does not re-drive anything
 *
 * **The reconcile sweep is the repair path.** It re-lists a trailing window on a
 * timer, both paths land in the same object head, and an object whose delivery
 * got stuck is repaired by the next sweep as long as it is inside that window.
 * Re-driving from here would be a second writer racing the first for no gain,
 * and it could not succeed anyway: the ledger stores a `payload_hash`, never the
 * body (D5's privacy boundary), so there is nothing left to reprocess. What was
 * missing was not a repair, it was *knowing it happened* — a row nobody counts.
 *
 * So the sweep marks the row `failed` with a categorized result and the caller
 * emits a metric. A sustained non-zero rate means tie-break re-fetches are
 * failing faster than the provider retries, which is a credential or a provider
 * problem an operator can act on; a zero rate means the 5xx path is doing what
 * it was designed to do.
 *
 * Bounded by `limit` for the reason every sweep in this repository is bounded: a
 * backlog that accumulated over a weekend must not turn one tick into a
 * table-length transaction inside a process that is also ingesting events.
 */
export async function failStuckRevenueDeliveries(
  db: Executor,
  input: {
    readonly olderThan: Date
    readonly limit: number
    readonly now?: Date
  },
): Promise<{ readonly failed: number; readonly siteIds: readonly string[] }> {
  const now = input.now ?? new Date()

  // A subselect over the partial index rather than a bare `UPDATE ... WHERE
  // status = 'received'`: the `LIMIT` is the bound, and `LIMIT` is not
  // expressible on an `UPDATE` directly. `FOR UPDATE SKIP LOCKED` so two workers
  // running the sweep in the same second settle disjoint sets instead of one
  // waiting out the other's transaction.
  const candidates = db
    .select({ id: revenueProviderEvents.id })
    .from(revenueProviderEvents)
    .where(
      and(
        eq(revenueProviderEvents.status, 'received'),
        lt(revenueProviderEvents.receivedAt, input.olderThan),
      ),
    )
    .orderBy(asc(revenueProviderEvents.receivedAt))
    .limit(input.limit)
    .for('update', { skipLocked: true })

  const updated = await db
    .update(revenueProviderEvents)
    .set({
      status: 'failed',
      processedAt: now,
      result: {
        reason: REVENUE_STUCK_DELIVERY_REASON,
        // Stated on the row so an operator reading it does not have to know the
        // sweep's policy: this is a record, not an attempted fix.
        repair: 'reconcile_sweep',
      },
    })
    .where(sql`${revenueProviderEvents.id} IN (${candidates})`)
    .returning({ id: revenueProviderEvents.id, siteId: revenueProviderEvents.siteId })

  return { failed: updated.length, siteIds: updated.map((row) => row.siteId) }
}

// --- Sync cursors ------------------------------------------------------------

export interface RevenueSyncStateRow {
  readonly id: string
  readonly credentialId: string
  readonly siteId: string
  readonly resource: RevenueSyncResource | RevenueLifecycleSyncResource
  readonly cursor: string | null
  readonly windowStart: Date | null
  readonly windowEnd: Date | null
  readonly completedAt: Date | null
  readonly updatedAt: Date
}

export async function readRevenueSyncState(
  db: Executor,
  input: {
    readonly credentialId: string
    readonly resource: RevenueSyncResource | RevenueLifecycleSyncResource
  },
): Promise<RevenueSyncStateRow | null> {
  const [row] = await db
    .select()
    .from(revenueSyncState)
    .where(
      and(
        eq(revenueSyncState.credentialId, input.credentialId),
        eq(revenueSyncState.resource, input.resource),
      ),
    )
  return row ?? null
}

export interface SaveRevenueSyncStateInput {
  readonly credentialId: string
  readonly siteId: string
  readonly resource: RevenueSyncResource | RevenueLifecycleSyncResource
  /** The provider's own cursor. Null both to *open* a window and to close one. */
  readonly cursor: string | null
  readonly windowStart: Date
  readonly windowEnd: Date
  /** Set when the resource's window has been walked to its end; explicit null
   * re-opens it, which is how the reconcile sweep re-walks its trailing window
   * without a second state machine. */
  readonly completedAt: Date | null
  readonly now?: Date
}

/**
 * Write the cursor, upserting on `(credential, resource)`.
 *
 * Called after **every page**, which is the property the resume story rests on:
 * a worker killed mid-backfill resumes at the page boundary it last recorded
 * rather than at the top of the resource. Every field is written on conflict —
 * a partial update would let a re-opened window keep a `completed_at` from the
 * previous pass and make the resource look finished before it started.
 */
export async function saveRevenueSyncState(
  db: Executor,
  input: SaveRevenueSyncStateInput,
): Promise<void> {
  const now = input.now ?? new Date()
  await db
    .insert(revenueSyncState)
    .values({
      id: newId(),
      credentialId: input.credentialId,
      siteId: input.siteId,
      resource: input.resource,
      cursor: input.cursor,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      completedAt: input.completedAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [revenueSyncState.credentialId, revenueSyncState.resource],
      set: {
        cursor: input.cursor,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        completedAt: input.completedAt,
        updatedAt: now,
      },
    })
}

// --- Discovery ---------------------------------------------------------------

/** The statuses a sync may run under. `disabled` has no ciphertext to decrypt. */
const SYNCABLE_STATUSES = ['active', 'degraded'] as const

export interface DueRevenueCredential {
  readonly id: string
  readonly siteId: string
  readonly provider: string
  readonly encryptedApiKey: string | null
  readonly keyVersion: string
  readonly status: 'active' | 'degraded'
  /** Carried so the sweep can apply the "only a completed walk or a fresh
   * secret clears `unauthorized`" rule without a second read. */
  readonly lastError: string | null
  readonly lastSyncedAt: Date | null
}

/**
 * Credentials the reconcile sweep should touch (D4's finalizer-style discovery).
 *
 * Three exclusions, and each one is a decision:
 *
 * - **`disabled`** — no ciphertext to decrypt, so a sweep could only fail.
 * - **Never-synced with a live backfill job.** The backfill is walking ninety
 *   days; a sweep starting a trailing 48-hour window beside it would not corrupt
 *   anything — the object head serializes both — but it would spend the same
 *   rate budget racing its own sibling, and `last_synced_at` set by the sweep
 *   would make a still-running backfill look finished.
 * - **`degraded` with `last_error = 'unauthorized'`.** The provider has said the
 *   key does not work. Retrying it every fifteen minutes is roughly 1,440
 *   rejected requests a day, forever, against a customer's account — which looks
 *   like an attack from their side and cannot possibly succeed, because nothing
 *   about a revoked key changes on its own.
 *
 *   The row re-enters discovery the moment somebody *does* something about it: a
 *   rotation clears `last_error` and enqueues a fresh backfill, and a reconnect
 *   makes a new credential entirely. So the recovery is customer-driven, which
 *   is correct — only the customer can issue a working key.
 *
 * `degraded` rows with any *other* error stay in: an outage is exactly the state
 * the sweep exists to discover has ended, and excluding those would make
 * `degraded` a one-way door.
 */
export async function listRevenueCredentialsDueForSync(
  db: Executor,
  input: {
    readonly staleBefore: Date
    readonly limit: number
    readonly backfillJobType: string
  },
): Promise<DueRevenueCredential[]> {
  const liveBackfill = db
    .select({ one: sql<number>`1` })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, input.backfillJobType),
        eq(jobs.subjectId, revenueCredentials.id),
        inArray(jobs.status, ['queued', 'running', 'failed_retryable']),
      ),
    )

  const rows = await db
    .select({
      id: revenueCredentials.id,
      siteId: revenueCredentials.siteId,
      provider: revenueCredentials.provider,
      encryptedApiKey: revenueCredentials.encryptedApiKey,
      keyVersion: revenueCredentials.keyVersion,
      status: revenueCredentials.status,
      lastError: revenueCredentials.lastError,
      lastSyncedAt: revenueCredentials.lastSyncedAt,
    })
    .from(revenueCredentials)
    .where(
      and(
        inArray(revenueCredentials.status, [...SYNCABLE_STATUSES]),
        // A disabled credential's ciphertexts are erased; a live one whose key
        // is somehow absent cannot be decrypted either, and picking it up would
        // be a guaranteed failure that flips it degraded for no new information.
        sql`${revenueCredentials.encryptedApiKey} IS NOT NULL`,
        // The rejected-key exclusion (see the doc comment): retrying a revoked
        // key on a timer is thousands of refused requests a day that cannot
        // succeed. A rotation or a reconnect is what puts the row back in.
        sql`NOT (${revenueCredentials.status} = 'degraded'
              AND ${revenueCredentials.lastError} = ${REVENUE_UNAUTHORIZED_ERROR})`,
        or(
          lt(revenueCredentials.lastSyncedAt, input.staleBefore),
          and(isNull(revenueCredentials.lastSyncedAt), notExists(liveBackfill)),
        ),
      ),
    )
    // Oldest first, nulls first: a never-synced credential with no live backfill
    // is the most urgent thing this loop can find.
    .orderBy(sql`${revenueCredentials.lastSyncedAt} ASC NULLS FIRST`, asc(revenueCredentials.id))
    .limit(input.limit)

  return rows as DueRevenueCredential[]
}
