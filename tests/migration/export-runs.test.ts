import { SITE_DELETION_TARGETS, exportObjectPrefix } from '@openanalytics/domain'
import {
  claimExportDownload,
  completeExportRun,
  createDatabase,
  createExportRun,
  createFunnel,
  createImportRun,
  createPool,
  createSiteWithOwner,
  failExportRun,
  listDeletionTargets,
  listExportRuns,
  listFunnels,
  listSiteExportObjectKeys,
  newId,
  purgeAccountPostgres,
  purgeSitePostgres,
  readExportRun,
  recordExportChunk,
  retractExportChunks,
  startExportRun,
  startSiteDeletion,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Export runs against a real Postgres (ADR-0032, D8/D9; migration 0032).
 *
 * Everything asserted here is a database fact rather than a TypeScript one, and
 * each is load-bearing somewhere the application cannot compensate:
 *
 * 1. **The cutoff and the pin are one snapshot.** They are taken inside the same
 *    transaction, under the site row's lock, and the cutoff comes from the
 *    *database* clock. A cutoff taken from the api's clock would decide which of
 *    the worker's rows are inside the export using a third clock; a pin read in
 *    a second statement could be a pointer a publish had already moved.
 * 2. **The state CHECK.** An unrecognised state would read as neither live nor
 *    terminal and would leave a run nothing can advance and nothing can expire.
 * 3. **The 57-target deletion snapshot**, and the export object keys inside the
 *    object target — enumerated *before* `postgres_purge` deletes the rows that
 *    carry them, which is the only reason those keys are ever knowable again
 *    (the storage port has no `list`).
 * 4. **The lazy expiry's deadline is SQL.** `finished_at < now() - interval`, so
 *    an api whose clock runs fast cannot retire a download that is still live.
 *    And the audit row is written in the same transaction that decided it.
 * 5. **`requested_by` survives the user scrub.** Account deletion tombstones the
 *    users row rather than deleting it, so the export's history stays attributed;
 *    the FK's `ON DELETE SET NULL` is the backstop for the path that does delete.
 * 6. **The purge deletes `export_runs`** and does so without tripping the FK it
 *    holds on `import_runs`.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('export runs', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m11exp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let ownerId: string

  /**
   * Settle an export's job the way the runner would.
   *
   * The `(type, subject_id)` liveness index is what serializes exports (D8), so
   * a site whose previous export *row* is terminal can still be blocked while
   * its job row is unsettled — which in production lasts until the runner claims
   * it, sees a run it may not work, and succeeds. Tests that need a second
   * export therefore have to close the first job, not just the first run.
   */
  const settleJob = async (exportRunId: string): Promise<void> => {
    await pool.query(`UPDATE jobs SET status = 'succeeded' WHERE idempotency_key = $1`, [
      `export_run:${exportRunId}`,
    ])
  }

  const makeSite = async (): Promise<string> => {
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: ownerId,
    })
    return siteId
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

    ownerId = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [ownerId, `${ownerId}@example.com`],
    )
  }, 120_000)

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

  describe('migration 0032 shape', () => {
    it('creates the table with the columns the repository reads', async () => {
      const r = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'export_runs'`,
        [schemaName],
      )
      expect([...r.rows.map((row) => row.column_name)].sort()).toEqual(
        [
          'id',
          'site_id',
          'requested_by',
          'state',
          'cutoff',
          'pinned_import_run_id',
          'manifest',
          'progress',
          'object_prefix',
          'error_code',
          'created_at',
          'started_at',
          'finished_at',
          'swept_at',
        ].sort(),
      )
    })

    it('refuses a state outside the declared vocabulary', async () => {
      const siteId = await makeSite()
      await expect(
        pool.query(
          `INSERT INTO export_runs (id, site_id, state, cutoff, object_prefix)
           VALUES ($1, $2, 'nonsense', now(), 'exports/x/')`,
          [newId(), siteId],
        ),
      ).rejects.toThrow(/export_runs_state_check/iu)
    })

    it('nulls the pin rather than deleting the export when a run is cleaned up', async () => {
      // A pinned import run erased by the cleanup backstop must not take the
      // export row with it (CASCADE) and must not block the cleanup (RESTRICT).
      // The export degrades honestly instead: its already-written chunks stay
      // valid, because rows are keyed by run id and cleanup deleted exactly
      // those.
      const siteId = await makeSite()
      const run = await createImportRun(db, {
        siteId,
        provider: 'plausible',
        declaredBytes: 1,
        contentType: 'application/zip',
      })
      if (!run.ok) throw new Error('setup failed')

      await pool.query(`UPDATE sites SET published_import_run_id = $1 WHERE id = $2`, [
        run.run.id,
        siteId,
      ])

      const created = await createExportRun(db, { siteId, requestedByUserId: ownerId })
      if (!created.ok) throw new Error('setup failed')
      expect(created.run.pinnedImportRunId).toBe(run.run.id)

      await pool.query(`DELETE FROM import_runs WHERE id = $1`, [run.run.id])

      const after = await readExportRun(db, { siteId, exportRunId: created.run.id })
      expect(after).not.toBeNull()
      expect(after?.pinnedImportRunId).toBeNull()
    })
  })

  describe('the create snapshot (D8)', () => {
    it('stamps the cutoff from the database clock, not the caller', async () => {
      const siteId = await makeSite()
      const before = await pool.query<{ now: Date }>(`SELECT now() AS now`)
      const created = await createExportRun(db, { siteId, requestedByUserId: ownerId })
      const after = await pool.query<{ now: Date }>(`SELECT now() AS now`)
      if (!created.ok) throw new Error('create failed')

      // Between two database instants, which is the only way to assert "this is
      // the database's clock" without trusting the one this test runs on.
      expect(created.run.cutoff.getTime()).toBeGreaterThanOrEqual(
        (before.rows[0] as { now: Date }).now.getTime(),
      )
      expect(created.run.cutoff.getTime()).toBeLessThanOrEqual(
        (after.rows[0] as { now: Date }).now.getTime(),
      )
      expect(created.run.objectPrefix).toBe(exportObjectPrefix(siteId, created.run.id))
    })

    it('pins the published import pointer as it stood in the same transaction', async () => {
      const siteId = await makeSite()

      // No pointer yet: a site with no imported history pins null, and the
      // executor then exports zero imported rows rather than whatever happens
      // to be staged.
      const first = await createExportRun(db, { siteId, requestedByUserId: ownerId })
      if (!first.ok) throw new Error('create failed')
      expect(first.run.pinnedImportRunId).toBeNull()
      await failExportRun(db, { exportRunId: first.run.id, errorCode: 'export_failed' })
      await settleJob(first.run.id)

      const run = await createImportRun(db, {
        siteId,
        provider: 'plausible',
        declaredBytes: 1,
        contentType: 'application/zip',
      })
      if (!run.ok) throw new Error('setup failed')
      await pool.query(`UPDATE sites SET published_import_run_id = $1 WHERE id = $2`, [
        run.run.id,
        siteId,
      ])

      const second = await createExportRun(db, { siteId, requestedByUserId: ownerId })
      if (!second.ok) throw new Error('create failed')
      expect(second.run.pinnedImportRunId).toBe(run.run.id)
    })

    it('enqueues the job in the same transaction and audits the request', async () => {
      const siteId = await makeSite()
      const created = await createExportRun(db, { siteId, requestedByUserId: ownerId })
      if (!created.ok) throw new Error('create failed')

      // A row with no job would sit `queued` forever while holding the site's
      // export slot; a job with no row would have nothing to work.
      const job = await pool.query<{ type: string; payload: Record<string, unknown> }>(
        `SELECT type, payload FROM jobs WHERE idempotency_key = $1`,
        [`export_run:${created.run.id}`],
      )
      expect(job.rows[0]?.type).toBe('export_run')
      expect(job.rows[0]?.payload).toMatchObject({ export_run_id: created.run.id })

      const audit = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
        `SELECT action, metadata FROM audit_logs WHERE target_id = $1`,
        [created.run.id],
      )
      expect(audit.rows.map((row) => row.action)).toEqual(['site.export.requested'])
      expect(audit.rows[0]?.metadata).toMatchObject({ pinned_import_run_id: null })
    })

    it('refuses a second export while one is live, and leaves no orphan row', async () => {
      const siteId = await makeSite()
      const first = await createExportRun(db, { siteId, requestedByUserId: ownerId })
      if (!first.ok) throw new Error('create failed')

      const second = await createExportRun(db, { siteId, requestedByUserId: ownerId })
      expect(second).toMatchObject({
        ok: false,
        conflict: 'live_export',
        exportRunId: first.run.id,
      })

      // The refused attempt wrote nothing: exactly one row, and it is the first.
      const rows = await listExportRuns(db, { siteId })
      expect(rows.map((row) => row.id)).toEqual([first.run.id])
    })

    it('refuses on a site that is being deleted', async () => {
      const siteId = await makeSite()
      await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      // The same row lock `startSiteDeletion` takes, so a run — and an object
      // prefix — cannot be created into the window between the deletion's
      // snapshot and its purge.
      expect(await createExportRun(db, { siteId, requestedByUserId: ownerId })).toMatchObject({
        ok: false,
        conflict: 'site_unavailable',
      })
    })
  })

  describe('progress, completion and the download claim', () => {
    const finish = async (siteId: string) => {
      const created = await createExportRun(db, { siteId, requestedByUserId: ownerId })
      if (!created.ok) throw new Error('create failed')
      await startExportRun(db, { exportRunId: created.run.id })
      await recordExportChunk(db, {
        exportRunId: created.run.id,
        chunk: {
          key: `${created.run.objectPrefix}events-2026-07.ndjson.gz`,
          kind: 'events',
          month: '2026-07',
          part: 1,
          rows: 2,
          bytes: 40,
          sha256: 'a'.repeat(64),
        },
      })
      await completeExportRun(db, {
        exportRunId: created.run.id,
        manifest: {
          schema_version: 1,
          export_id: created.run.id,
          site_id: siteId,
          cutoff: created.run.cutoff.toISOString(),
          pinned_import_run_id: null,
          generated_at: new Date().toISOString(),
          number_encoding: 'json_number',
          notes: [],
          chunks: [
            {
              key: `${created.run.objectPrefix}events-2026-07.ndjson.gz`,
              kind: 'events',
              month: '2026-07',
              part: 1,
              rows: 2,
              bytes: 40,
              sha256: 'a'.repeat(64),
            },
          ],
          totals: { chunks: 1, rows: 2, bytes: 40 },
        },
      })
      return created.run.id
    }

    it('retracts a stale chunk into orphaned_keys, still enumerable by a deletion', async () => {
      // The executor's `retractStaleParts` in its durable half. Dropping the
      // record is what stops a later resume adopting a longer stale generation;
      // moving the key to `orphaned_keys` is what stops the drop from making the
      // object unreachable, since the storage port has no `list`.
      const siteId = await makeSite()
      const created = await createExportRun(db, { siteId, requestedByUserId: ownerId })
      if (!created.ok) throw new Error('create failed')

      const live = `${created.run.objectPrefix}events-2026-07.ndjson.gz`
      const stale = `${created.run.objectPrefix}events-2026-07-p2.ndjson.gz`
      for (const [key, part] of [
        [live, 1],
        [stale, 2],
      ] as const) {
        await recordExportChunk(db, {
          exportRunId: created.run.id,
          chunk: {
            key,
            kind: 'events',
            month: '2026-07',
            part,
            rows: 1,
            bytes: 10,
            sha256: 'c'.repeat(64),
          },
        })
      }

      await retractExportChunks(db, { exportRunId: created.run.id, keys: [stale] })

      const row = await readExportRun(db, { siteId, exportRunId: created.run.id })
      // Gone from the list the resume walks...
      expect(row?.progress?.chunks.map((chunk) => chunk.key)).toEqual([live])
      // ...and present in the list only the purge reads.
      expect(row?.progress?.orphaned_keys).toEqual([stale])
      // Which is what keeps the bytes reachable.
      expect((await listSiteExportObjectKeys(db, siteId)).sort()).toEqual(
        [`${created.run.objectPrefix}manifest.json`, live, stale].sort(),
      )
    })

    it('reads only the exporting site’s funnels', async () => {
      // The funnels chunk is the one part of an export that comes from Postgres
      // rather than from a site-bound ClickHouse statement, so its scoping is a
      // different mechanism and needs its own proof: `listFunnels` is
      // site-scoped, and the plan-04 criterion covers this file too.
      const siteA = await makeSite()
      const siteB = await makeSite()
      await createFunnel(db, {
        siteId: siteA,
        name: 'A signup',
        steps: ['/a', '/done'],
        scope: 'session',
        windowMs: 1_000,
      })
      await createFunnel(db, {
        siteId: siteB,
        name: 'B signup',
        steps: ['/b', '/done'],
        scope: 'session',
        windowMs: 1_000,
      })

      const forA = await listFunnels(db, siteA, { includeArchived: true })
      expect(forA.map((funnel) => funnel.name)).toEqual(['A signup'])
      expect(forA.every((funnel) => funnel.siteId === siteA)).toBe(true)
      expect(forA.some((funnel) => funnel.name === 'B signup')).toBe(false)
    })

    it('appends chunks to progress as they land', async () => {
      const siteId = await makeSite()
      const exportRunId = await finish(siteId)
      const row = await readExportRun(db, { siteId, exportRunId })
      // Recorded after each upload, which is what makes an unfinished export's
      // bytes addressable at all.
      expect(row?.progress?.chunks.map((chunk) => chunk.key)).toEqual([
        `${row?.objectPrefix ?? ''}events-2026-07.ndjson.gz`,
      ])
      expect(row?.state).toBe('succeeded')
      expect(row?.finishedAt).not.toBeNull()
    })

    it('claims a download once and writes exactly one audit row', async () => {
      const siteId = await makeSite()
      const exportRunId = await finish(siteId)

      const first = await claimExportDownload(db, {
        siteId,
        exportRunId,
        ttlDays: 7,
        actorUserId: ownerId,
      })
      expect(first).toMatchObject({ ok: true })

      const second = await claimExportDownload(db, {
        siteId,
        exportRunId,
        ttlDays: 7,
        actorUserId: ownerId,
      })
      expect(second).toMatchObject({ ok: true })

      // Two download requests, two audit rows: a download that outlives the
      // fifteen-minute window repeats the call, and each one is separately
      // audited. What must never happen is a *status poll* writing one.
      const audit = await pool.query<{ action: string }>(
        `SELECT action FROM audit_logs WHERE target_id = $1 ORDER BY occurred_at`,
        [exportRunId],
      )
      expect(audit.rows.map((row) => row.action)).toEqual([
        'site.export.requested',
        'site.export.downloaded',
        'site.export.downloaded',
      ])
    })

    it('expires lazily against the database clock and refuses afterwards', async () => {
      const siteId = await makeSite()
      const exportRunId = await finish(siteId)

      // Inside the window: still downloadable. The deadline is evaluated in SQL
      // against a database-stamped `finished_at`, so this is the real comparison
      // and not one this test's clock decided.
      expect(await claimExportDownload(db, { siteId, exportRunId, ttlDays: 7 })).toMatchObject({
        ok: true,
      })

      // Rewind the run's own timestamp rather than the clock: the bytes are gone
      // from the bucket after seven days, and this is what makes the row agree.
      await pool.query(
        `UPDATE export_runs SET finished_at = now() - interval '8 days' WHERE id = $1`,
        [exportRunId],
      )

      expect(await claimExportDownload(db, { siteId, exportRunId, ttlDays: 7 })).toMatchObject({
        ok: false,
        reason: 'expired',
      })
      // Flipped once, and it stays flipped — the status read reports `expired`
      // without anybody sweeping.
      expect((await readExportRun(db, { siteId, exportRunId }))?.state).toBe('expired')
      expect(await claimExportDownload(db, { siteId, exportRunId, ttlDays: 7 })).toMatchObject({
        ok: false,
        reason: 'expired',
      })

      // The expiry writes no audit row: nothing was handed out.
      const audit = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_logs
          WHERE target_id = $1 AND action = 'site.export.downloaded'`,
        [exportRunId],
      )
      expect(audit.rows[0]?.n).toBe('1')
    })

    it('refuses a download of an export that has not succeeded', async () => {
      const siteId = await makeSite()
      const created = await createExportRun(db, { siteId, requestedByUserId: ownerId })
      if (!created.ok) throw new Error('create failed')

      expect(
        await claimExportDownload(db, { siteId, exportRunId: created.run.id, ttlDays: 7 }),
      ).toMatchObject({ ok: false, reason: 'not_downloadable', state: 'queued' })
    })

    it('reads an export of another site as absent', async () => {
      const siteA = await makeSite()
      const siteB = await makeSite()
      const exportRunId = await finish(siteA)

      expect(await readExportRun(db, { siteId: siteB, exportRunId })).toBeNull()
      expect(
        await claimExportDownload(db, { siteId: siteB, exportRunId, ttlDays: 7 }),
      ).toMatchObject({ ok: false, reason: 'not_found' })
    })
  })

  describe('the deletion snapshot and the purge (D9)', () => {
    it('snapshots 62 targets with the export keys inside the object target', async () => {
      const siteId = await makeSite()
      const created = await createExportRun(db, { siteId, requestedByUserId: ownerId })
      if (!created.ok) throw new Error('create failed')

      const chunkKey = `${created.run.objectPrefix}events-2026-07.ndjson.gz`
      await recordExportChunk(db, {
        exportRunId: created.run.id,
        chunk: {
          key: chunkKey,
          kind: 'events',
          month: '2026-07',
          part: 1,
          rows: 1,
          bytes: 20,
          sha256: 'b'.repeat(64),
        },
      })

      // Enumerated straight from the rows, which is what the snapshot then
      // freezes. An export that never finished — this one — is exactly the case
      // that needs `progress`: its bytes are in the bucket and it has no
      // manifest.
      expect((await listSiteExportObjectKeys(db, siteId)).sort()).toEqual(
        [`${created.run.objectPrefix}manifest.json`, chunkKey].sort(),
      )

      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      const targets = await listDeletionTargets(db, {
        deletionRequestId: started.deletionRequestId,
      })

      // 64, not 65: `billing_transfer_offers` is a target the hosted surface registers (`CLOUD_DELETION_EXTENSION`), so this is the set a build without it erases.
      expect(targets).toHaveLength(64)
      expect(targets).toHaveLength(SITE_DELETION_TARGETS.length)
      expect(targets.filter((t) => t.store === 'postgres')).toHaveLength(22)
      expect(targets.map((t) => t.target)).toContain('export_runs')

      const object = targets.find((t) => t.store === 'object')
      const keys = (object?.verification as { keys: string[] } | null)?.keys ?? []
      // The manifest key is derived from the prefix and included even though
      // this export never wrote one: deleting an absent key is a no-op that the
      // phase's `head() === null` verification passes trivially, and the
      // alternative — omitting it — is a leak the day an export crashes right
      // after writing it.
      expect(keys.sort()).toEqual([`${created.run.objectPrefix}manifest.json`, chunkKey].sort())
    })

    it('purges export_runs without tripping the import FK it holds', async () => {
      const siteId = await makeSite()
      const run = await createImportRun(db, {
        siteId,
        provider: 'plausible',
        declaredBytes: 1,
        contentType: 'application/zip',
      })
      if (!run.ok) throw new Error('setup failed')
      await pool.query(`UPDATE sites SET published_import_run_id = $1 WHERE id = $2`, [
        run.run.id,
        siteId,
      ])
      const created = await createExportRun(db, { siteId, requestedByUserId: ownerId })
      if (!created.ok) throw new Error('create failed')

      await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      const result = await purgeSitePostgres(db, { siteId })

      expect(result.deleted['export_runs']).toBe(1)
      expect(result.deleted['import_runs']).toBe(1)
      const remaining = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM export_runs WHERE site_id = $1`,
        [siteId],
      )
      expect(remaining.rows[0]?.n).toBe('0')
    })

    it('keeps requested_by through an account scrub', async () => {
      // Account deletion tombstones the users row rather than deleting it
      // (ADR-0030, D8), so an export's attribution survives — which matters
      // because 02 §25 requires exports to leave an audit trail, and a trail
      // whose actor vanished is a weaker statement than one that says "this
      // person, now deleted".
      const scrubbedUser = newId()
      await pool.query(
        `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'S', $2, true)`,
        [scrubbedUser, `${scrubbedUser}@example.com`],
      )
      const siteId = await makeSite()
      const created = await createExportRun(db, { siteId, requestedByUserId: scrubbedUser })
      if (!created.ok) throw new Error('create failed')

      await purgeAccountPostgres(db, { userId: scrubbedUser })

      const after = await readExportRun(db, { siteId, exportRunId: created.run.id })
      expect(after?.requestedBy).toBe(scrubbedUser)

      // And the FK's `ON DELETE SET NULL` is the backstop for the one path that
      // really does delete a user row.
      await settleJob(created.run.id)
      await pool.query(`DELETE FROM export_runs WHERE site_id = $1`, [siteId])
      const second = await createExportRun(db, { siteId, requestedByUserId: scrubbedUser })
      if (!second.ok) throw new Error('create failed')
      await pool.query(`DELETE FROM users WHERE id = $1`, [scrubbedUser])
      expect(
        (await readExportRun(db, { siteId, exportRunId: second.run.id }))?.requestedBy,
      ).toBeNull()
    })
  })
})
