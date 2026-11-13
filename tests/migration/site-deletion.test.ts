import { SITE_DELETION_TARGETS } from '@openanalytics/domain'
import {
  countInFlightWriters,
  createDatabase,
  createPool,
  createSiteWithOwner,
  filterFinalizableSites,
  finalizeSiteDeletion,
  listDeletionTargets,
  markSiteDeletionFailed,
  newId,
  purgeSitePostgres,
  SiteDeletionError,
  startSiteDeletion,
  type Database,
} from '@openanalytics/postgres'
import { CLOUD_STREAM_PRESENT, applyPostgresStreams } from '../support/postgres-streams.ts'
import { SITE_DELETION_REGISTRATION } from '../../apps/worker/src/jobs/site-deletion.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Site deletion against a real Postgres (ADR-0030, decisions 4 and 7;
 * migration 0028).
 *
 * Everything here needs a database to be true at all. The start transaction's
 * atomicity, the deferred ownership triggers that migration 0028 amends, the
 * partial unique that stops a second job, the inflight index the drain reads —
 * none of them is a property of TypeScript, and a fake would only prove that the
 * repository calls the functions this test expects.
 *
 * The four claims, in the order the deletion makes them:
 *
 * 1. **The start is one commit.** Request, every target, job, site flip
 *    and key revocation all land together or not at all — a site marked
 *    `deleting` with no job is a site nobody is deleting and no sweep can see.
 * 2. **It is idempotent.** A second call on a `deleting` site finds the live
 *    request instead of minting a twin whose "all targets completed" check
 *    would disagree with the first's.
 * 3. **The drain counts the right rows.** A registration at a superseded
 *    generation blocks; a settled one and a newer one do not.
 * 4. **The purge can commit at all.** Removing every member of a site violates
 *    OA001 at commit for any site that is not exempt; 0028's status exemption is
 *    what lets a deletion finish, and it must still raise for a live site.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('site deletion', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m10del_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let ownerId: string

  const makeUser = async (): Promise<string> => {
    const id = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [id, `${id}@example.com`],
    )
    return id
  }

  const makeSite = async (): Promise<string> => {
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: ownerId,
    })
    return siteId
  }

  const siteRow = async (siteId: string) => {
    const r = await pool.query<{
      status: string
      name: string
      slug: string
      ingest_generation: number
      config_version: number
    }>(`SELECT status, name, slug, ingest_generation, config_version FROM sites WHERE id = $1`, [
      siteId,
    ])
    return r.rows[0]
  }

  const countRows = async (table: string, siteId: string): Promise<number> => {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE site_id = $1`,
      [siteId],
    )
    return Number(r.rows[0]?.n ?? '0')
  }

  /** A manifest and one fence registration for it, at the given generation. */
  const registerWriter = async (
    siteId: string,
    generation: number,
    state: 'registered' | 'settled',
  ): Promise<void> => {
    const batchId = `b-${newId()}`
    await pool.query(
      `INSERT INTO ingest_batches
         (id, batch_id, stream_name, consumer_group, state, message_count, byte_size, payload_hash)
       VALUES ($1, $2, 'event_stream', 'ingest_workers', 'pending', 1, 0, 'h')`,
      [newId(), batchId],
    )
    // 'settled' is written as the real fence vocabulary's 'written' — the CHECK
    // admits registered|written|dropped|abandoned only (0015 + 0020).
    await pool.query(
      `INSERT INTO ingest_batch_sites
         (id, batch_id, site_id, ingest_generation, state, row_count, settled_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6)`,
      [
        newId(),
        batchId,
        siteId,
        generation,
        state === 'settled' ? 'written' : state,
        state === 'settled' ? new Date() : null,
      ],
    )
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }
    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    const scoped = url.toString()
    const { logger } = createCapturedLogger()
    await applyPostgresStreams({ connectionString: scoped, logger })
    pool = createPool(scoped)
    db = createDatabase(pool)
    ownerId = await makeUser()
  })

  afterAll(async () => {
    await pool?.end()
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  describe('migration 0028 shape', () => {
    it('adds the mutation bookkeeping columns to deletion_targets', async () => {
      const r = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'deletion_targets'`,
        [schemaName],
      )
      const columns = new Map(r.rows.map((row) => [row.column_name, row]))
      // Nullable in both cases, and the null is a statement: a Redis or Postgres
      // target has no mutation, and an unsubmitted ClickHouse one has not got
      // there yet — which is exactly the distinction a resumed job reads.
      expect(columns.get('mutation_id')?.is_nullable).toBe('YES')
      expect(columns.get('last_error')?.is_nullable).toBe('YES')
    })

    it('refuses a phase outside pending|running|completed', async () => {
      const requestId = newId()
      await pool.query(
        `INSERT INTO deletion_requests (id, subject_type, subject_id) VALUES ($1, 'site', $2)`,
        [requestId, newId()],
      )
      await expect(
        pool.query(
          `INSERT INTO deletion_targets (id, deletion_request_id, store, target, phase)
           VALUES ($1, $2, 'redis', 'queue_index', 'failed')`,
          [newId(), requestId],
        ),
      ).rejects.toThrow(/deletion_targets_phase_check/iu)
    })

    it('refuses a duplicate (request, store, target) — the snapshot is a set', async () => {
      const requestId = newId()
      await pool.query(
        `INSERT INTO deletion_requests (id, subject_type, subject_id) VALUES ($1, 'site', $2)`,
        [requestId, newId()],
      )
      const insert = () =>
        pool.query(
          `INSERT INTO deletion_targets (id, deletion_request_id, store, target)
           VALUES ($1, $2, 'clickhouse', 'events_raw')`,
          [newId(), requestId],
        )
      await insert()
      await expect(insert()).rejects.toThrow(/deletion_targets_request_store_target_key/iu)
    })

    it('refuses a finalizer row for a site that does not exist', async () => {
      await expect(
        pool.query(`INSERT INTO session_finalizer_state (site_id) VALUES ($1)`, [newId()]),
      ).rejects.toThrow(/session_finalizer_state_site_id_fkey/iu)
    })
  })

  describe('the amended assert_site_ownership', () => {
    it('still raises OA001 when a live site loses its last owner', async () => {
      const siteId = await makeSite()
      await expect(
        pool.query(`DELETE FROM site_members WHERE site_id = $1`, [siteId]),
      ).rejects.toThrow(/must have at least one owner/iu)
    })

    it('lets a deleting site lose every member, and lets the tombstone commit', async () => {
      const siteId = await makeSite()
      await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })

      // Both statements fire the deferred constraint triggers at commit: the
      // membership delete on `site_members`, the tombstone on `sites`, and the
      // second one runs against a row with zero owners.
      await expect(
        pool.query(`DELETE FROM site_members WHERE site_id = $1`, [siteId]),
      ).resolves.toBeDefined()
      await expect(
        pool.query(`UPDATE sites SET status = 'deleted', name = '' WHERE id = $1`, [siteId]),
      ).resolves.toBeDefined()
    })
  })

  describe('startSiteDeletion', () => {
    it('snapshots exactly the ADR-0030 D7 vocabulary', async () => {
      const siteId = await makeSite()
      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })

      const targets = await listDeletionTargets(db, {
        deletionRequestId: started.deletionRequestId,
      })
      // 32 ClickHouse + 5 Redis + 22 Postgres + 1 object (ADR-0032 D9 spent
      // ADR-0030's reservation and CP4 added `export_runs`; ADR-0033 D8 and its
      // CP3 amendment added the revenue ingest family, M12 CP4 added
      // `revenue_attributions` + `revenue_attribution_state`, M12 CP5 added
      // the `revenue_1h`/`revenue_1d` rollups, and M13 CP1 added the event
      // builder's `event_definitions` + `event_definition_versions`).
      // ADR-0034 D9 booked 60 as M13's end state with `events_preview`
      // (ClickHouse migration 0020); ADR-0038 D8 adds the two
      // `custom_event_samples_*` tables (migration 0021) and books 62; ADR-0045
      // D8 adds `widgets` (Postgres migration 0048) and books **63** — one table
      // and not two, because a widget's origin allowlist is a bounded `text[]`
      // on the row rather than a child table. ADR-0068 removes `events_preview`
      // again (migration 0022 drops it), the first shrink: **62**.
      // Still no `stripe` row: a site deletion cancels no subscription, because
      // the site is one of several a payer may fund.
      // 64, not 65: `billing_transfer_offers` is a target the hosted surface registers (`CLOUD_DELETION_EXTENSION`), so this is the set a build without it erases.
      expect(targets).toHaveLength(64)
      const byStore = (store: string) => targets.filter((t) => t.store === store).length
      expect(byStore('clickhouse')).toBe(36)
      expect(byStore('redis')).toBe(5)
      expect(byStore('postgres')).toBe(22)
      expect(byStore('stripe')).toBe(0)
      expect(byStore('object')).toBe(1)

      // The snapshot is the vocabulary, not a subset of it.
      expect(new Set(targets.map((t) => `${t.store}:${t.target}`))).toEqual(
        new Set(SITE_DELETION_TARGETS.map((t) => `${t.store}:${t.target}`)),
      )
      expect(targets.every((t) => t.phase === 'pending' && !t.verified)).toBe(true)
    })

    it('flips the site, bumps both counters and revokes every live key, in one commit', async () => {
      const siteId = await makeSite()
      const before = await siteRow(siteId)

      // Two keys: one live, one already revoked. The already-revoked one must
      // keep its original timestamp — a blanket UPDATE would rewrite history.
      const liveKey = newId()
      const deadKey = newId()
      const revokedAt = new Date('2026-01-01T00:00:00.000Z')
      await pool.query(
        `INSERT INTO api_keys (id, site_id, type, key_prefix, key_hash)
         VALUES ($1, $2, 'tracking_write', 'oa_pk_a', $3)`,
        [liveKey, siteId, `h-${liveKey}`],
      )
      await pool.query(
        `INSERT INTO api_keys (id, site_id, type, key_prefix, key_hash, revoked_at)
         VALUES ($1, $2, 'private_read', 'oa_sk_b', $3, $4)`,
        [deadKey, siteId, `h-${deadKey}`, revokedAt],
      )

      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      expect(started.started).toBe(true)

      const after = await siteRow(siteId)
      expect(after?.status).toBe('deleting')
      expect(after?.ingest_generation).toBe((before?.ingest_generation ?? 0) + 1)
      expect(after?.config_version).toBe((before?.config_version ?? 0) + 1)

      const keys = await pool.query<{ id: string; revoked_at: Date | null }>(
        `SELECT id, revoked_at FROM api_keys WHERE site_id = $1`,
        [siteId],
      )
      expect(keys.rows.every((row) => row.revoked_at !== null)).toBe(true)
      expect(keys.rows.find((row) => row.id === deadKey)?.revoked_at?.toISOString()).toBe(
        revokedAt.toISOString(),
      )

      // The job exists, is live, and carries the request in its payload — the
      // statement that makes the whole commit safe.
      const job = await pool.query<{
        id: string
        status: string
        payload: { [k: string]: unknown }
      }>(`SELECT id, status, payload FROM jobs WHERE subject_id = $1 AND type = 'site_deletion'`, [
        siteId,
      ])
      expect(job.rows).toHaveLength(1)
      expect(job.rows[0]?.status).toBe('queued')
      expect(job.rows[0]?.payload['deletion_request_id']).toBe(started.deletionRequestId)
      expect(job.rows[0]?.id).toBe(started.jobId)

      const audit = await pool.query<{ action: string }>(
        `SELECT action FROM audit_logs WHERE site_id = $1 ORDER BY occurred_at`,
        [siteId],
      )
      expect(audit.rows.map((row) => row.action)).toContain('site.deletion_requested')
    })

    it('enqueues the durable realtime revocation on the reserved site subject', async () => {
      // The route's post-commit epoch bump is best-effort and is lost if Redis is
      // unreachable at that instant — and the retention sweeper runs no route at
      // all. This row is what makes the revocation survive both: the worker's
      // drain replays the bump until the cache acks.
      const siteId = await makeSite()
      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      expect(started.started).toBe(true)

      const generation = (await siteRow(siteId))?.ingest_generation ?? 0
      const rows = await pool.query<{
        idempotency_key: string
        status: string
        payload: Record<string, unknown>
      }>(
        `SELECT idempotency_key, status, payload FROM outbox
          WHERE topic = 'realtime.access_revoked' AND payload->>'site_id' = $1`,
        [siteId],
      )

      expect(rows.rows).toHaveLength(1)
      expect(rows.rows[0]?.status).toBe('pending')
      // The subject is the reserved site-level one (decision 5), so the drain's
      // bump cuts every stream on the site rather than one member's.
      expect(rows.rows[0]?.payload).toEqual({
        site_id: siteId,
        user_id: 'site',
        reason: 'site_deleted',
      })
      // Keyed on the generation this transaction produced, so a retried start
      // cannot enqueue a second row for the same fence bump.
      expect(rows.rows[0]?.idempotency_key).toBe(
        `realtime.access_revoked:site:${siteId}:${String(generation)}`,
      )
    })

    it('stamps requested_at on the database clock when no instant is supplied', async () => {
      // `fence_drain` measures `TTL + margin` from this column against the
      // worker's clock, so the column must carry the database's instant and not
      // the calling host's — `DELETION_ACCEPTANCE_MARGIN_MS` budgets skew for two
      // clocks, and an api-stamped value would make it three.
      const siteId = await makeSite()
      const before = await pool.query<{ at: Date }>(`SELECT now() AS at`)
      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      const after = await pool.query<{ at: Date }>(`SELECT now() AS at`)

      const row = await pool.query<{ requested_at: Date }>(
        `SELECT requested_at FROM deletion_requests WHERE id = $1`,
        [started.deletionRequestId],
      )
      const requestedAt = row.rows[0]?.requested_at as Date
      expect(requestedAt.getTime()).toBeGreaterThanOrEqual(before.rows[0]?.at.getTime() ?? 0)
      expect(requestedAt.getTime()).toBeLessThanOrEqual(after.rows[0]?.at.getTime() ?? 0)
    })

    it('accepts a null requester and audits it as a system action', async () => {
      // The lifecycle sweeper's call: nobody requested this deletion, a promised
      // retention date arrived. Attributing it to a user would name someone who
      // did not act.
      const siteId = await makeSite()
      const started = await startSiteDeletion(db, {
        siteId,
        requestedByUserId: null,
        reason: 'retention_expired',
      })

      const request = await pool.query<{ requested_by_user_id: string | null }>(
        `SELECT requested_by_user_id FROM deletion_requests WHERE id = $1`,
        [started.deletionRequestId],
      )
      expect(request.rows[0]?.requested_by_user_id).toBeNull()

      const audit = await pool.query<{
        actor_type: string
        actor_user_id: string | null
        metadata: Record<string, unknown>
      }>(
        `SELECT actor_type, actor_user_id, metadata FROM audit_logs
          WHERE site_id = $1 AND action = 'site.deletion_requested'`,
        [siteId],
      )
      expect(audit.rows[0]?.actor_type).toBe('system')
      expect(audit.rows[0]?.actor_user_id).toBeNull()
      expect(audit.rows[0]?.metadata).toMatchObject({ reason: 'retention_expired' })
    })

    it('is idempotent: a second call returns the same request and mints no twin', async () => {
      const siteId = await makeSite()
      const first = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      const second = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })

      expect(second.deletionRequestId).toBe(first.deletionRequestId)
      expect(second.started).toBe(false)
      expect(second.jobId).toBe(first.jobId)

      const requests = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM deletion_requests WHERE subject_id = $1`,
        [siteId],
      )
      expect(requests.rows[0]?.n).toBe('1')
      // And the generation is bumped once, not twice: a second start that
      // re-bumped would invalidate the drain's own reference point.
      const after = await siteRow(siteId)
      expect(after?.ingest_generation).toBe(2)
    })

    it('refuses a site that is already a tombstone', async () => {
      const siteId = await makeSite()
      await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      await pool.query(`DELETE FROM site_members WHERE site_id = $1`, [siteId])
      await pool.query(`UPDATE sites SET status = 'deleted' WHERE id = $1`, [siteId])

      await expect(startSiteDeletion(db, { siteId, requestedByUserId: ownerId })).rejects.toThrow(
        SiteDeletionError,
      )
    })

    it('refuses a site that does not exist', async () => {
      await expect(
        startSiteDeletion(db, { siteId: newId(), requestedByUserId: ownerId }),
      ).rejects.toThrow(SiteDeletionError)
    })
  })

  describe('a job the runner gave up on', () => {
    /**
     * The state this whole block exists for: a site left `deleting` with a
     * request nobody is working. Before the terminal hook, `startSiteDeletion`
     * found that `pending` request and answered every later `DELETE` with its
     * id — a site permanently half-deleted, reporting a deletion in progress
     * that nothing was performing.
     */
    const runTerminalHook = async (
      jobId: string,
      siteId: string,
      payload: Record<string, unknown>,
      reason = 'attempts exhausted: clickhouse unavailable',
    ): Promise<void> => {
      await pool.query(`UPDATE jobs SET status = 'failed_terminal' WHERE id = $1`, [jobId])
      await SITE_DELETION_REGISTRATION.onTerminal?.(
        {
          id: jobId,
          type: 'site_deletion',
          subjectId: siteId,
          payload,
          phase: 'clickhouse_purge',
          attempts: 100,
          claimedBy: 'w-1',
          leaseExpiresAt: new Date(),
          createdAt: new Date(),
        },
        reason,
        { db } as unknown as Parameters<
          NonNullable<typeof SITE_DELETION_REGISTRATION.onTerminal>
        >[2],
      )
    }

    const requestRow = async (id: string) => {
      const r = await pool.query<{ status: string; completed_at: Date | null }>(
        `SELECT status, completed_at FROM deletion_requests WHERE id = $1`,
        [id],
      )
      return r.rows[0]
    }

    it('marks the request failed and audits it, leaving the site deleting', async () => {
      const siteId = await makeSite()
      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })

      await runTerminalHook(started.jobId as string, siteId, {
        deletion_request_id: started.deletionRequestId,
        reason: 'user_requested',
      })

      const request = await requestRow(started.deletionRequestId)
      expect(request?.status).toBe('failed')
      // A failure is not a completion, and the column is what an operator's
      // "when did this finish?" read looks at.
      expect(request?.completed_at).toBeNull()

      // The site stays `deleting`: its stores are half-purged and its keys are
      // revoked, so flipping it back to `active` would re-admit events into a
      // site whose ClickHouse rows are partly gone.
      expect((await siteRow(siteId))?.status).toBe('deleting')

      const audit = await pool.query<{ actor_type: string; metadata: Record<string, unknown> }>(
        `SELECT actor_type, metadata FROM audit_logs
          WHERE action = 'site.deletion_failed' AND target_id = $1`,
        [siteId],
      )
      expect(audit.rows).toHaveLength(1)
      expect(audit.rows[0]?.actor_type).toBe('system')
      expect(audit.rows[0]?.metadata).toMatchObject({
        deletion_request_id: started.deletionRequestId,
        reason: 'attempts exhausted: clickhouse unavailable',
      })
    })

    it('settles the site’s live request when the dead job named none', async () => {
      // The bad-row terminal — a job whose payload never carried a request id.
      // There is still a site stuck `deleting`, and its request is still the row
      // that has to stop claiming.
      const siteId = await makeSite()
      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })

      await runTerminalHook(started.jobId as string, siteId, { reason: 'user_requested' })

      expect((await requestRow(started.deletionRequestId))?.status).toBe('failed')
    })

    it('never rewrites an already completed request as failed', async () => {
      // The attempts guard can fire on a job that outlived its own tombstone.
      const siteId = await makeSite()
      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      await purgeSitePostgres(db, { siteId })
      await finalizeSiteDeletion(db, { deletionRequestId: started.deletionRequestId, siteId })

      await markSiteDeletionFailed(db, {
        deletionRequestId: started.deletionRequestId,
        siteId,
        reason: 'attempts exhausted: something',
      })

      expect((await requestRow(started.deletionRequestId))?.status).toBe('completed')
    })

    it('revives the same request on the next DELETE rather than minting a second', async () => {
      // The recovery, and the reason the request is reset instead of replaced: a
      // second request would give one site two target snapshots, each answering
      // "is everything completed?" without knowing about the other — and would
      // throw away every target the dead job had already verified.
      const siteId = await makeSite()
      const first = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      const generationBefore = (await siteRow(siteId))?.ingest_generation

      await runTerminalHook(first.jobId as string, siteId, {
        deletion_request_id: first.deletionRequestId,
        reason: 'user_requested',
      })

      const second = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })

      expect(second.started).toBe(false)
      expect(second.deletionRequestId).toBe(first.deletionRequestId)
      expect(second.jobId).not.toBe(first.jobId)

      // Back in the live set, so the executor will work it again.
      const request = await requestRow(first.deletionRequestId)
      expect(request?.status).toBe('pending')
      expect(request?.completed_at).toBeNull()

      const requests = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM deletion_requests WHERE subject_id = $1`,
        [siteId],
      )
      expect(requests.rows[0]?.n).toBe('1')

      // One snapshot, not two.
      const targets = await listDeletionTargets(db, {
        deletionRequestId: first.deletionRequestId,
      })
      expect(targets).toHaveLength(SITE_DELETION_TARGETS.length)

      // The revived job carries the same request and is queued to run.
      const revived = await pool.query<{ payload: Record<string, unknown>; status: string }>(
        `SELECT payload, status FROM jobs WHERE id = $1`,
        [second.jobId],
      )
      expect(revived.rows[0]?.status).toBe('queued')
      expect(revived.rows[0]?.payload).toMatchObject({
        deletion_request_id: first.deletionRequestId,
      })

      // The generation is not bumped again: the drain measures against the one
      // the first start produced, and re-bumping would move its reference point.
      expect((await siteRow(siteId))?.ingest_generation).toBe(generationBefore)

      const audit = await pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_logs WHERE action = 'site.deletion_revived' AND target_id = $1`,
        [siteId],
      )
      expect(audit.rows).toHaveLength(1)
      expect(audit.rows[0]?.metadata).toMatchObject({
        deletion_request_id: first.deletionRequestId,
        job_id: second.jobId,
      })
    })

    it('revives a still-pending request whose job died without being marked', async () => {
      // The other shape of "nobody is performing this": the job was settled
      // terminally (or lost) and the request was never moved out of the live
      // set. The idempotent read used to return `jobId: null` here — an answer
      // that named a deletion with nothing running it.
      const siteId = await makeSite()
      const first = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      await pool.query(`UPDATE jobs SET status = 'failed_terminal' WHERE id = $1`, [first.jobId])

      const second = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })

      expect(second.started).toBe(false)
      expect(second.deletionRequestId).toBe(first.deletionRequestId)
      expect(second.jobId).not.toBe(first.jobId)
      expect(second.jobId).not.toBeNull()
      expect((await requestRow(first.deletionRequestId))?.status).toBe('pending')
    })

    it('does not revive while the job is still live', async () => {
      // A live job owns the deletion. Enqueueing beside it would be refused by
      // `jobs_live_subject_key` anyway; reporting it is the idempotent answer.
      const siteId = await makeSite()
      const first = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })

      const second = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })

      expect(second.jobId).toBe(first.jobId)
      const audit = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_logs
          WHERE action = 'site.deletion_revived' AND target_id = $1`,
        [siteId],
      )
      expect(audit.rows[0]?.n).toBe('0')
    })
  })

  describe('countInFlightWriters — the drain', () => {
    it('counts a registration at a superseded generation and nothing else', async () => {
      const siteId = await makeSite()
      await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      const generation = (await siteRow(siteId))?.ingest_generation ?? 2

      expect(await countInFlightWriters(db, { siteId, currentGeneration: generation })).toBe(0)

      // A worker that passed the fence before the bump and has not settled.
      await registerWriter(siteId, generation - 1, 'registered')
      expect(await countInFlightWriters(db, { siteId, currentGeneration: generation })).toBe(1)

      // A settled row at the same generation is finished work, not in flight.
      await registerWriter(siteId, generation - 1, 'settled')
      expect(await countInFlightWriters(db, { siteId, currentGeneration: generation })).toBe(1)

      // A registration at the *current* generation cannot block the drain: it
      // is not a writer the bump superseded.
      await registerWriter(siteId, generation, 'registered')
      expect(await countInFlightWriters(db, { siteId, currentGeneration: generation })).toBe(1)
    })

    it('ignores the in-flight writers of another site', async () => {
      const siteId = await makeSite()
      const other = await makeSite()
      await registerWriter(other, 1, 'registered')
      expect(await countInFlightWriters(db, { siteId, currentGeneration: 2 })).toBe(0)
    })
  })

  describe('purgeSitePostgres', () => {
    it('removes the ten targets and leaves audit, fence and billing history', async () => {
      const siteId = await makeSite()
      const memberTwo = await makeUser()

      await pool.query(`INSERT INTO site_domains (id, site_id, domain) VALUES ($1, $2, 'a.test')`, [
        newId(),
        siteId,
      ])
      await pool.query(
        `INSERT INTO site_members (id, site_id, user_id, role) VALUES ($1, $2, $3, 'viewer')`,
        [newId(), siteId, memberTwo],
      )
      await pool.query(
        `INSERT INTO site_invites (id, site_id, email, role, token_hash, invited_by_user_id, expires_at)
         VALUES ($1, $2, 'x@example.com', 'viewer', $3, $4, now() + interval '7 days')`,
        [newId(), siteId, `t-${newId()}`, ownerId],
      )
      await pool.query(
        `INSERT INTO api_keys (id, site_id, type, key_prefix, key_hash)
         VALUES ($1, $2, 'tracking_write', 'oa_pk_c', $3)`,
        [newId(), siteId, `h-${newId()}`],
      )
      await pool.query(`INSERT INTO site_ingest_settings (site_id) VALUES ($1)`, [siteId])
      await pool.query(`INSERT INTO site_public_dashboard_settings (site_id) VALUES ($1)`, [siteId])
      await pool.query(
        `INSERT INTO funnels (id, site_id, name, steps, window_ms, created_by_user_id)
         VALUES ($1, $2, 'F', $3::jsonb, 1800000, $4)`,
        [
          newId(),
          siteId,
          // The 0024 CHECK requires an array of 2-8 STRINGS (strict jsonpath).
          JSON.stringify(['/a', '/b']),
          ownerId,
        ],
      )
      await pool.query(`INSERT INTO session_finalizer_state (site_id) VALUES ($1)`, [siteId])
      // The hosted surface's table, seeded only where its stream has been
      // applied — the claim it supports is that the product purge leaves it be.
      if (CLOUD_STREAM_PRESENT)
        await pool.query(
          `INSERT INTO billing_transfer_offers (id, site_id, from_user_id, to_user_id, expires_at)
           VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
          [newId(), siteId, ownerId, memberTwo],
        )
      const batchId = `b-${newId()}`
      await pool.query(
        `INSERT INTO ingest_batches
           (id, batch_id, stream_name, consumer_group, state, message_count, byte_size, payload_hash)
         VALUES ($1, $2, 'event_stream', 'ingest_workers', 'pending', 1, 0, 'h')`,
        [newId(), batchId],
      )
      await pool.query(
        `INSERT INTO ingest_batch_items
           (id, batch_id, stream_name, message_id, position, site_id, event_id, payload_hash, accepted_at)
         VALUES ($1, $2, 'event_stream', $3, 0, $4, $5, 'h', now())`,
        [newId(), batchId, `m-${newId()}`, siteId, newId()],
      )
      // A widget (migration 0048), which is the ADR-0045 D8 target. It is the
      // one row in this list that is a *live public credential*: its id sits in
      // the HTML of a page that is not ours, so a purge that missed it would
      // leave a deleted site's embed still addressable.
      await pool.query(
        `INSERT INTO widgets (id, site_id, surface, range, row_limit, allowed_origins, created_by_user_id)
         VALUES ($1, $2, 'pages', '7d', 5, ARRAY['https://shop.example.com'], $3)`,
        [`w${newId().replaceAll('-', '').slice(0, 15)}`, siteId, ownerId],
      )
      await registerWriter(siteId, 1, 'settled')

      // The site must be `deleting` first: removing every member is what the
      // 0028 exemption exists for, and without it this transaction cannot commit.
      await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })

      const result = await purgeSitePostgres(db, { siteId })

      expect(result.deleted['site_members']).toBe(2)
      expect(result.deleted['site_domains']).toBe(1)
      expect(result.deleted['session_finalizer_state']).toBe(1)
      expect(result.deleted['ingest_batch_items']).toBe(1)
      expect(result.deleted['widgets']).toBe(1)

      for (const table of [
        'site_domains',
        'site_members',
        'site_invites',
        'api_keys',
        'site_ingest_settings',
        'site_public_dashboard_settings',
        'funnels',
        'session_finalizer_state',
        'ingest_batch_items',
        'widgets',
      ]) {
        expect(await countRows(table, siteId), table).toBe(0)
      }

      // The deliberate survivors: the fence's own ledger and the audit trail.
      // `billing_transfer_offers` joins them in a build that does not mount the
      // hosted surface — it is that surface's target, so nothing here erases the
      // row this fixture wrote. (`site_billing_assignments` was asserted here too;
      // the row is written by the same surface's after-create hook, so a build
      // without it has none to keep.)
      expect(await countRows('ingest_batch_sites', siteId)).toBeGreaterThan(0)
      expect(await countRows('audit_logs', siteId)).toBeGreaterThan(0)
      if (CLOUD_STREAM_PRESENT)
        expect(await countRows('billing_transfer_offers', siteId)).toBeGreaterThan(0)
    })

    it('is idempotent — a re-run after a crash deletes nothing and throws nothing', async () => {
      const siteId = await makeSite()
      await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      await purgeSitePostgres(db, { siteId })

      const again = await purgeSitePostgres(db, { siteId })
      expect(Object.values(again.deleted).every((n) => n === 0)).toBe(true)
    })
  })

  describe('finalizeSiteDeletion', () => {
    it('writes the tombstone, completes the request and frees the slug', async () => {
      const siteId = await makeSite()
      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      const originalSlug = (await siteRow(siteId))?.slug as string
      await purgeSitePostgres(db, { siteId })

      await finalizeSiteDeletion(db, {
        deletionRequestId: started.deletionRequestId,
        siteId,
      })

      const after = await siteRow(siteId)
      expect(after?.status).toBe('deleted')
      expect(after?.name).toBe('')
      expect(after?.slug).toBe(`deleted-${siteId}`)

      // The slug is free again; the id is not, and never will be (ADR-0027).
      await expect(
        createSiteWithOwner(db, { slug: originalSlug, name: 'Reused', ownerUserId: ownerId }),
      ).resolves.toBeDefined()

      const request = await pool.query<{ status: string; completed_at: Date | null }>(
        `SELECT status, completed_at FROM deletion_requests WHERE id = $1`,
        [started.deletionRequestId],
      )
      expect(request.rows[0]?.status).toBe('completed')
      expect(request.rows[0]?.completed_at).not.toBeNull()

      const outbox = await pool.query<{ topic: string }>(
        `SELECT topic FROM outbox WHERE idempotency_key = $1`,
        [`site.deletion_completed:${started.deletionRequestId}`],
      )
      expect(outbox.rows.map((row) => row.topic)).toEqual(['site.deletion_completed'])
    })

    it('removes a session_finalizer_state row that was recreated after the purge', async () => {
      // `claimFinalizerSite` is an UPSERT, so any path that claims the lease
      // after `postgres_purge` verified the row gone puts it back — a row for a
      // site whose events no longer exist, with a watermark nothing can advance,
      // contradicting the `deletion_targets` row that says it was purged. The
      // tombstone is the statement that the site's Postgres rows are gone, so it
      // makes that true rather than merely asserting it.
      const siteId = await makeSite()
      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      await purgeSitePostgres(db, { siteId })
      // An unclaimed row, which is what an UPSERT leaves behind once the lease it
      // took has been released — the residue, not the claim itself.
      await pool.query(`INSERT INTO session_finalizer_state (site_id) VALUES ($1)`, [siteId])
      expect(await countRows('session_finalizer_state', siteId)).toBe(1)

      await finalizeSiteDeletion(db, { deletionRequestId: started.deletionRequestId, siteId })

      expect(await countRows('session_finalizer_state', siteId)).toBe(0)
    })
  })

  describe('the finalizer status fence', () => {
    it('keeps active and suspended sites and drops deleting ones', async () => {
      const active = await makeSite()
      const blocked = await makeSite()
      const deleting = await makeSite()
      await pool.query(`UPDATE sites SET status = 'suspended' WHERE id = $1`, [blocked])
      await startSiteDeletion(db, { siteId: deleting, requestedByUserId: ownerId })

      const kept = await filterFinalizableSites(db, [active, blocked, deleting, newId()])

      // A blocked site keeps finalizing: its data is retained for the whole
      // retention window and has to be correct if the customer reactivates. A
      // site with no Postgres row at all cannot be authorised for anything.
      expect(kept).toEqual([active, blocked])
    })
  })
})
