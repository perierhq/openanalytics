import { SITE_DELETION_TARGETS } from '@openanalytics/domain'
import {
  createDatabase,
  createImportRun,
  createPool,
  createSiteWithOwner,
  listDeletionTargets,
  listExpiredImportUploads,
  listImportRuns,
  listSiteImportObjectKeys,
  newId,
  pinUploadEtag,
  purgeSitePostgres,
  readImportRun,
  startSiteDeletion,
  transitionImportRun,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Import runs against a real Postgres (ADR-0032, D3/D6/D9; migration 0030).
 *
 * Everything asserted here is a database fact rather than a TypeScript one, and
 * each is load-bearing somewhere the application cannot compensate:
 *
 * 1. **One non-terminal run per site.** The partial unique is the whole
 *    serialization mechanism — the jobs table's `(type, subject_id)` index is
 *    per type and `import_prepare`/`import_publish` are two types, so it would
 *    happily admit a publish of one run beside a prepare of another. A read-then-
 *    insert in the repository could not do this either: two requests both read
 *    "no live run" and both insert.
 * 2. **The state CHECK.** An unrecognised state would read as "not live" to the
 *    partial index and let a second import start beside the first.
 * 3. **The FK cycle.** `sites.published_import_run_id` points at a run while the
 *    run points at the site (D9). `ON DELETE SET NULL` is the schema backstop;
 *    the purge nulls it explicitly, and both halves are checked.
 * 4. **The deletion snapshot.** 57 targets, and the object target's key list
 *    populated at deletion start — *before* `postgres_purge` removes the rows it
 *    was read from, which is the only reason those keys are ever knowable.
 * 5. **The site row lock.** `createImportRun` takes the same `FOR UPDATE` on
 *    `sites` that `startSiteDeletion` takes, so a run cannot be created into the
 *    window between a deletion's snapshot and its purge. A key created there
 *    would be outside the snapshot, and the port has no `list` to find it again.
 * 6. **The TTL comparison.** The abandoned-upload sweep's deadline is computed
 *    in SQL against `now()`; a JS instant would compare a worker's clock against
 *    a column the database stamped.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('import runs', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m11imp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let ownerId: string

  const makeSite = async (): Promise<string> => {
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: ownerId,
    })
    return siteId
  }

  const startRun = async (siteId: string, bytes = 1_024, provider = 'plausible') =>
    await createImportRun(db, {
      siteId,
      provider,
      declaredBytes: bytes,
      contentType: 'application/zip',
    })

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

  describe('migration 0030 shape', () => {
    it('creates both tables with the columns the repository reads', async () => {
      const columns = async (table: string): Promise<Set<string>> => {
        const r = await pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2`,
          [schemaName, table],
        )
        return new Set(r.rows.map((row) => row.column_name))
      }

      expect([...(await columns('import_runs'))].sort()).toEqual(
        [
          'id',
          'site_id',
          'provider',
          'state',
          'summary',
          'cutover_date',
          'staging_chunk_bytes',
          // Migration 0031 (M11 CP2): the rollback generation, the staging
          // resume point and the cleanup backstop's marker.
          'staging_progress',
          'superseded_run_id',
          'swept_at',
          'error_code',
          'created_at',
          'updated_at',
          'finished_at',
        ].sort(),
      )
      expect([...(await columns('import_uploads'))].sort()).toEqual(
        [
          'id',
          'import_run_id',
          'object_key',
          'declared_bytes',
          'content_type',
          'etag',
          'created_at',
          'completed_at',
        ].sort(),
      )
      expect(await columns('sites')).toContain('published_import_run_id')
    })

    it('refuses a state outside the declared vocabulary', async () => {
      // The CHECK is what stops an unrecognised state from reading as "not
      // live" and letting a second import start beside the first.
      const siteId = await makeSite()
      await expect(
        pool.query(
          `INSERT INTO import_runs (id, site_id, provider, state) VALUES ($1, $2, 'plausible', 'nonsense')`,
          [newId(), siteId],
        ),
      ).rejects.toThrow(/import_runs_state_check/iu)
    })

    it('admits one upload row per run and refuses a second', async () => {
      // v1 mints exactly one single-PUT URL per run. Without the unique,
      // `pinUploadEtag` (which updates *the* row of a run) and
      // `readImportUpload` (which reads *the* row of a run) could disagree about
      // which row they mean, and the fingerprint the worker verifies against
      // would be whichever one the read happened to find.
      const siteId = await makeSite()
      const created = await startRun(siteId)
      if (!created.ok) throw new Error('setup failed')

      await expect(
        pool.query(
          `INSERT INTO import_uploads (id, import_run_id, object_key, declared_bytes, content_type)
           VALUES ($1, $2, 'imports/second', 1, 'application/zip')`,
          [newId(), created.run.id],
        ),
      ).rejects.toThrow(/import_uploads_run_key/iu)
    })

    it('indexes the abandoned-upload sweep on its own predicate', async () => {
      // The sweep reads by `created_at` over the two pre-prepare states. Without
      // the partial index it scans every run the installation ever recorded —
      // a set that only grows — to find the handful that can still expire.
      const indexes = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'import_runs_expiry_idx'`,
        [schemaName],
      )
      const definition = indexes.rows[0]?.indexdef
      expect(definition, 'import_runs_expiry_idx must exist').toBeDefined()
      expect(definition).toContain('created_at')
      expect(definition).toContain("'uploading'")
      expect(definition).toContain("'uploaded'")
    })

    it('enforces one live run per site with a partial unique index', async () => {
      const indexes = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'import_runs_live_site_key'`,
        [schemaName],
      )
      const definition = indexes.rows[0]?.indexdef
      expect(definition, 'import_runs_live_site_key must exist').toBeDefined()
      expect(definition).toContain('UNIQUE')
      // `ready_for_review` is INSIDE the predicate: a review that takes days
      // still holds the site's import slot, even though it holds no job lease.
      expect(definition).toContain("'ready_for_review'")
      // Terminal states are outside it, so history never blocks a later import.
      expect(definition).not.toContain("'published'")
      expect(definition).not.toContain("'discarded'")
    })
  })

  describe('createImportRun', () => {
    it('writes the run and its upload row in one commit, with an id-addressed key', async () => {
      const siteId = await makeSite()
      const created = await startRun(siteId, 4_096)
      expect(created.ok).toBe(true)
      if (!created.ok) return

      expect(created.run.state).toBe('uploading')
      expect(created.upload.objectKey).toBe(`imports/${siteId}/${created.run.id}/archive.zip`)
      expect(created.upload.declaredBytes).toBe(4_096)
      // Null until `complete` observes the object; the worker verifies it before
      // parsing, which is what makes a later re-PUT a failed run.
      expect(created.upload.etag).toBeNull()
    })

    it.each(['plausible', 'umami'])(
      'refuses a second live run and names the one in the way (%s first)',
      async (provider) => {
        // **The predicate is on the site, not the provider.** `import_runs.provider`
        // is free text and the unique index says nothing about it, so a customer
        // migrating from one tool cannot start a second import from another while
        // the first is still live. Parameterised the day a second adapter shipped,
        // because "one live run per site" is the kind of rule a reader assumes is
        // per-provider once there is more than one.
        const siteId = await makeSite()
        const first = await startRun(siteId, 1_024, provider)
        expect(first.ok).toBe(true)

        const second = await startRun(siteId, 1_024, provider === 'umami' ? 'plausible' : 'umami')
        expect(second.ok).toBe(false)
        if (second.ok || second.conflict !== 'live_run')
          throw new Error('expected a live-run refusal')
        // The blocking run is named because the recovery is to publish or discard
        // *that one*; a bare conflict would leave the customer with nothing to do.
        expect(second.runId).toBe(first.ok ? first.run.id : null)
      },
    )

    it('refuses a second run while the first only awaits review', async () => {
      const siteId = await makeSite()
      const first = await startRun(siteId)
      if (!first.ok) throw new Error('setup failed')
      await transitionImportRun(db, {
        importRunId: first.run.id,
        from: ['uploading'],
        to: 'ready_for_review',
      })

      expect((await startRun(siteId)).ok).toBe(false)
    })

    it('allows a new run once the previous one settled', async () => {
      const siteId = await makeSite()
      const first = await startRun(siteId)
      if (!first.ok) throw new Error('setup failed')
      await transitionImportRun(db, {
        importRunId: first.run.id,
        from: ['uploading'],
        to: 'discarded',
        finished: true,
      })

      const second = await startRun(siteId)
      expect(second.ok).toBe(true)
      expect((await listImportRuns(db, { siteId })).map((r) => r.state)).toEqual([
        'uploading',
        'discarded',
      ])
    })

    it("does not let one site's run block another's", async () => {
      const a = await makeSite()
      const b = await makeSite()
      expect((await startRun(a)).ok).toBe(true)
      expect((await startRun(b)).ok).toBe(true)
    })

    it('refuses an import on a site whose deletion has started', async () => {
      // The transaction takes the same `SELECT … FOR UPDATE` on the site row
      // that `startSiteDeletion` takes, which is what makes the two serialize:
      // either the run is created and the deletion's snapshot enumerates its
      // object key, or the deletion wins and this reads `deleting` and refuses.
      // Admitting it here would put an object key outside the snapshot — and the
      // port has no `list`, so those bytes would be unreachable forever.
      const siteId = await makeSite()
      await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })

      const created = await startRun(siteId)
      expect(created.ok).toBe(false)
      if (created.ok) return
      expect(created.conflict).toBe('site_unavailable')
      expect(await listImportRuns(db, { siteId })).toEqual([])
    })

    it('refuses an import on a site that no longer exists', async () => {
      // The same refusal, and deliberately not a different one: the route turns
      // both into `404 SITE_NOT_FOUND`, so a torn-down site is not
      // distinguishable from one that never existed.
      const created = await createImportRun(db, {
        siteId: newId(),
        provider: 'plausible',
        declaredBytes: 1_024,
        contentType: 'application/zip',
      })
      expect(created.ok).toBe(false)
      if (created.ok) return
      expect(created.conflict).toBe('site_unavailable')
    })
  })

  describe('listExpiredImportUploads', () => {
    it('serves only runs past the TTL, and joins the object key through', async () => {
      // The deadline is decided in SQL against `now()` — `created_at` is stamped
      // by the database, and a worker clock running minutes ahead would
      // otherwise delete the archive of an upload still in flight. That is a
      // comparison only a real Postgres can prove, which is why it lives here
      // rather than beside the sweeper's mocked unit suite.
      const staleSite = await makeSite()
      const freshSite = await makeSite()
      const stale = await startRun(staleSite)
      const fresh = await startRun(freshSite)
      if (!stale.ok || !fresh.ok) throw new Error('setup failed')

      await pool.query(
        `UPDATE import_runs SET created_at = now() - interval '8 days' WHERE id = $1`,
        [stale.run.id],
      )

      const due = await listExpiredImportUploads(db, { ttlDays: 7, limit: 50 })
      const ids = due.map((row) => row.importRunId)
      expect(ids).toContain(stale.run.id)
      expect(ids).not.toContain(fresh.run.id)

      const row = due.find((candidate) => candidate.importRunId === stale.run.id)
      expect(row?.siteId).toBe(staleSite)
      // The LEFT JOIN carries the key, which is the only reason the sweep can
      // delete the archive without a second read.
      expect(row?.objectKey).toBe(stale.upload.objectKey)
    })

    it('stops serving a run once it leaves the two pre-prepare states', async () => {
      const siteId = await makeSite()
      const created = await startRun(siteId)
      if (!created.ok) throw new Error('setup failed')
      await pool.query(
        `UPDATE import_runs SET created_at = now() - interval '8 days' WHERE id = $1`,
        [created.run.id],
      )

      await transitionImportRun(db, {
        importRunId: created.run.id,
        from: ['uploading'],
        to: 'processing',
      })

      const due = await listExpiredImportUploads(db, { ttlDays: 7, limit: 50 })
      expect(due.map((row) => row.importRunId)).not.toContain(created.run.id)
    })
  })

  describe('transitions and the etag pin', () => {
    it('moves only from a state the guard names', async () => {
      const siteId = await makeSite()
      const created = await startRun(siteId)
      if (!created.ok) throw new Error('setup failed')

      // Wrong `from`: the guard is in the WHERE, so nothing matches and the
      // caller is told `false` rather than overwriting a state machine somebody
      // else advanced.
      expect(
        await transitionImportRun(db, {
          importRunId: created.run.id,
          from: ['ready_for_review'],
          to: 'published',
        }),
      ).toBe(false)
      expect((await readImportRun(db, { siteId, importRunId: created.run.id }))?.state).toBe(
        'uploading',
      )

      expect(
        await transitionImportRun(db, {
          importRunId: created.run.id,
          from: ['uploading'],
          to: 'uploaded',
        }),
      ).toBe(true)
    })

    it('stamps finished_at and the error code on a terminal move', async () => {
      const siteId = await makeSite()
      const created = await startRun(siteId)
      if (!created.ok) throw new Error('setup failed')

      await transitionImportRun(db, {
        importRunId: created.run.id,
        from: ['uploading'],
        to: 'failed',
        errorCode: 'upload_expired',
        finished: true,
      })

      const row = await readImportRun(db, { siteId, importRunId: created.run.id })
      expect(row?.errorCode).toBe('upload_expired')
      expect(row?.finishedAt).toBeInstanceOf(Date)
    })

    it('pins the etag and completion instant together', async () => {
      // An upload row that claimed to be complete without the fingerprint would
      // leave the worker nothing to verify the downloaded bytes against.
      const siteId = await makeSite()
      const created = await startRun(siteId)
      if (!created.ok) throw new Error('setup failed')

      expect(await pinUploadEtag(db, { importRunId: created.run.id, etag: '"abc"' })).toBe(true)
      const r = await pool.query<{ etag: string; completed_at: Date | null }>(
        `SELECT etag, completed_at FROM import_uploads WHERE import_run_id = $1`,
        [created.run.id],
      )
      expect(r.rows[0]?.etag).toBe('"abc"')
      expect(r.rows[0]?.completed_at).not.toBeNull()
    })

    it("scopes a read by site, so another site's run id reads as absent", async () => {
      const a = await makeSite()
      const b = await makeSite()
      const created = await startRun(a)
      if (!created.ok) throw new Error('setup failed')

      expect(await readImportRun(db, { siteId: b, importRunId: created.run.id })).toBeNull()
    })
  })

  describe('the published pointer (D9 FK cycle)', () => {
    it('references a run and nulls itself when that run is deleted', async () => {
      const siteId = await makeSite()
      const created = await startRun(siteId)
      if (!created.ok) throw new Error('setup failed')

      await pool.query(`UPDATE sites SET published_import_run_id = $1 WHERE id = $2`, [
        created.run.id,
        siteId,
      ])
      await pool.query(`DELETE FROM import_runs WHERE id = $1`, [created.run.id])

      const r = await pool.query<{ published_import_run_id: string | null }>(
        `SELECT published_import_run_id FROM sites WHERE id = $1`,
        [siteId],
      )
      // ON DELETE SET NULL is the schema-level backstop for a path that forgot
      // to null it. The purge does so explicitly; this is what happens if it
      // ever does not.
      expect(r.rows[0]?.published_import_run_id).toBeNull()
    })

    it('refuses a pointer to a run that does not exist', async () => {
      const siteId = await makeSite()
      await expect(
        pool.query(`UPDATE sites SET published_import_run_id = $1 WHERE id = $2`, [
          newId(),
          siteId,
        ]),
      ).rejects.toThrow(/foreign key/iu)
    })
  })

  describe('the deletion snapshot (ADR-0032, D9)', () => {
    it('writes 67 targets with an empty key list for a site that never imported', async () => {
      const siteId = await makeSite()
      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      const targets = await listDeletionTargets(db, {
        deletionRequestId: started.deletionRequestId,
      })

      // 47 was M11's end state; M12 took it to 57 across CP1-CP5 (ADR-0033, D8
      // and its CP3 amendment). The object target deliberately did not multiply
      // and revenue adds none — provider bodies are never persisted.
      // 67, not 68 (62 + the three subscription lifecycle tables of Postgres 0047 and the two of ClickHouse 0030): `billing_transfer_offers` is a target the hosted surface registers (`CLOUD_DELETION_EXTENSION`), so this is the set a build without it erases.
      expect(targets).toHaveLength(67)
      expect(targets).toHaveLength(SITE_DELETION_TARGETS.length)
      const byStore = (store: string) => targets.filter((t) => t.store === store).length
      expect(byStore('clickhouse')).toBe(36)
      expect(byStore('redis')).toBe(5)
      expect(byStore('postgres')).toBe(25)
      expect(byStore('object')).toBe(1)

      // The row exists even with nothing to purge. Omitting it would make the
      // target count vary per site, and "did this deletion cover object
      // storage?" would stop being answerable from the snapshot alone.
      const object = targets.find((t) => t.store === 'object')
      expect(object?.target).toBe('site_objects')
      expect(object?.verification).toEqual({ keys: [] })
    })

    it('snapshots the object keys of a site that has an upload row', async () => {
      const siteId = await makeSite()
      const created = await startRun(siteId)
      if (!created.ok) throw new Error('setup failed')

      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      const targets = await listDeletionTargets(db, {
        deletionRequestId: started.deletionRequestId,
        store: 'object',
      })

      expect(targets).toHaveLength(1)
      // Read at deletion START — before `postgres_purge` removes the
      // `import_uploads` rows they live on. The port has no `list`, so this
      // snapshot is the only enumeration that will ever exist.
      expect(targets[0]?.verification).toEqual({ keys: [created.upload.objectKey] })
    })

    it('purges both import tables and clears the pointer first', async () => {
      const siteId = await makeSite()
      const created = await startRun(siteId)
      if (!created.ok) throw new Error('setup failed')
      await transitionImportRun(db, {
        importRunId: created.run.id,
        from: ['uploading'],
        to: 'published',
      })
      await pool.query(`UPDATE sites SET published_import_run_id = $1 WHERE id = $2`, [
        created.run.id,
        siteId,
      ])
      // The site must be `deleting` for the ownership triggers to allow the
      // membership delete inside the purge (migration 0028's exemption).
      await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })

      const result = await purgeSitePostgres(db, { siteId })

      expect(result.deleted['import_uploads']).toBe(1)
      expect(result.deleted['import_runs']).toBe(1)
      expect(await listSiteImportObjectKeys(db, siteId)).toEqual([])
      const r = await pool.query<{ published_import_run_id: string | null }>(
        `SELECT published_import_run_id FROM sites WHERE id = $1`,
        [siteId],
      )
      expect(r.rows[0]?.published_import_run_id).toBeNull()
    })
  })
})
