import {
  SITE_DELETION_TARGETS,
  revenueObservationHash,
  type RevenueNormalizedObject,
  type RevenueObservation,
} from '@openanalytics/domain'
import {
  REVENUE_BACKFILL_JOB_TYPE,
  REVENUE_UNAUTHORIZED_ERROR,
  applyRevenueObservation,
  createDatabase,
  createPool,
  createRevenueCredential,
  createSiteWithOwner,
  disconnectRevenueCredential,
  listDeletionTargets,
  listRevenueCredentialsDueForSync,
  markRevenueProviderEvent,
  mintWebhookToken,
  noteDisabledRevenueDelivery,
  newId,
  purgeSitePostgres,
  readCurrencyRate,
  readLatestCurrencyRateDate,
  readRevenueObject,
  readRevenueProviderEvent,
  readRevenueSyncState,
  recordRevenueProviderEvent,
  requestRevenueBackfill,
  rotateRevenueCredential,
  saveRevenueSyncState,
  startSiteDeletion,
  updateRevenueCredentialState,
  upsertCurrencyRates,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Revenue ingest against a real Postgres (ADR-0033, D4/D8; migration 0034).
 *
 * Everything asserted here is a *database* fact rather than a TypeScript one,
 * and each is load-bearing somewhere the application cannot compensate:
 *
 * 1. **The ledger's uniqueness carries the site dimension.** The same provider
 *    event id on two OA sites is two rows — the property the M3 billing ledger
 *    structurally cannot express, and the reason M12 got its own table.
 * 2. **The object head serializes under concurrency.** Two transactions racing
 *    one object produce two distinct versions in order, never one lost update
 *    and never a duplicate version. This is the half of "duplicate or
 *    out-of-order never counts twice" that a pure test cannot reach.
 * 3. **Cursors upsert.** `(credential, resource)` is the conflict target, so two
 *    writers converge on one row rather than leaving two half-walked cursors.
 * 4. **The purge removes each named table, and a sibling site keeps everything.**
 *    A vocabulary name with no purge statement verifies silently at
 *    `deleted: 0`, so the per-table effect is asserted, not only the count.
 * 5. **`currency_rates` survives a deletion**, because it is global reference
 *    data belonging to every other tenant's conversions.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const cipher = (label: string): string =>
  `k1.AAAAAAAAAAAAAAAA.${Buffer.from(label).toString('base64')}`

function normalized(overrides: Partial<RevenueNormalizedObject> = {}): RevenueNormalizedObject {
  return {
    object_kind: 'charge',
    status: 'succeeded',
    livemode: false,
    currency: 'usd',
    gross_minor: 4999,
    fee_minor: 0,
    net_minor: 4999,
    occurred_at: '2026-07-31T10:00:00.000Z',
    parent_object_id: '',
    order_id: 'pi_1',
    checkout_session_id: '',
    client_reference_id: '',
    subscription_id: '',
    product_id: '',
    product_name: '',
    customer_id: 'cus_1',
    ...overrides,
  } as RevenueNormalizedObject
}

function observation(
  objectId: string,
  at: string,
  overrides: Partial<RevenueNormalizedObject> = {},
): RevenueObservation {
  return {
    objectId,
    objectKind: 'charge',
    snapshotAt: new Date(at),
    normalized: normalized(overrides),
  }
}

describeIfPostgres('revenue ingest', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m12ing_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
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

  const connect = async (siteId: string, provider = 'stripe') => {
    const id = newId()
    const created = await createRevenueCredential(db, {
      id,
      siteId,
      provider,
      encryptedApiKey: cipher(`api:${id}`),
      encryptedWebhookSecret: cipher(`whsec:${id}`),
      keyVersion: 'k1',
      apiKeyLast4: '1234',
      webhookToken: mintWebhookToken(),
      createdByUserId: ownerId,
    })
    if (!created.ok) throw new Error('setup failed: already connected')
    return created.credential
  }

  const countIn = async (table: string, siteId: string): Promise<number> => {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE site_id = $1`,
      [siteId],
    )
    return Number(r.rows[0]?.n ?? '0')
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

  describe('the delivery ledger', () => {
    it('inserts once and reports the existing row on a redelivery', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)

      const first = await recordRevenueProviderEvent(db, {
        siteId,
        credentialId: credential.id,
        provider: 'stripe',
        providerEventId: 'evt_1',
        payloadHash: 'hash-a',
        source: 'webhook',
      })
      expect(first.firstSeen).toBe(true)
      expect(first.status).toBe('received')

      await markRevenueProviderEvent(db, { id: first.id, status: 'processed', result: { n: 1 } })

      const again = await recordRevenueProviderEvent(db, {
        siteId,
        credentialId: credential.id,
        provider: 'stripe',
        providerEventId: 'evt_1',
        // A redelivery carries the same body, but the assertion is about the
        // *key*: even a differing hash must not create a second row.
        payloadHash: 'hash-b',
        source: 'webhook',
      })
      expect(again.firstSeen).toBe(false)
      expect(again.id).toBe(first.id)
      expect(again.status).toBe('processed')
    })

    it('processes the same provider event once PER SITE', async () => {
      // The difference from M3, and the reason this table exists at all: one
      // Stripe account connected to two OA sites must not have the second site
      // silently never ingest.
      const a = await makeSite()
      const b = await makeSite()
      const credentialA = await connect(a)
      const credentialB = await connect(b)

      const first = await recordRevenueProviderEvent(db, {
        siteId: a,
        credentialId: credentialA.id,
        provider: 'stripe',
        providerEventId: 'evt_shared',
        payloadHash: 'h',
        source: 'webhook',
      })
      const second = await recordRevenueProviderEvent(db, {
        siteId: b,
        credentialId: credentialB.id,
        provider: 'stripe',
        providerEventId: 'evt_shared',
        payloadHash: 'h',
        source: 'webhook',
      })

      expect(first.firstSeen).toBe(true)
      expect(second.firstSeen).toBe(true)
      expect(second.id).not.toBe(first.id)
    })

    it('rejects a status or source outside the closed vocabulary', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)
      const recorded = await recordRevenueProviderEvent(db, {
        siteId,
        credentialId: credential.id,
        provider: 'stripe',
        providerEventId: 'evt_vocab',
        payloadHash: 'h',
        source: 'backfill',
      })

      await expect(
        pool.query(`UPDATE revenue_provider_events SET status = 'weird' WHERE id = $1`, [
          recorded.id,
        ]),
      ).rejects.toThrow(/revenue_provider_events_status_check/u)
      await expect(
        pool.query(`UPDATE revenue_provider_events SET source = 'guess' WHERE id = $1`, [
          recorded.id,
        ]),
      ).rejects.toThrow(/revenue_provider_events_source_check/u)
    })

    it('reads a ledger row back by its delivery key', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)
      await recordRevenueProviderEvent(db, {
        siteId,
        credentialId: credential.id,
        provider: 'stripe',
        providerEventId: 'backfill:charges:ch_9',
        payloadHash: 'h',
        source: 'backfill',
      })
      const row = await readRevenueProviderEvent(db, {
        siteId,
        provider: 'stripe',
        providerEventId: 'backfill:charges:ch_9',
      })
      expect(row).toMatchObject({ status: 'received', source: 'backfill' })
    })
  })

  describe('the object head', () => {
    it('inserts at version 1 and advances on a newer snapshot', async () => {
      const siteId = await makeSite()
      await connect(siteId)

      const first = await applyRevenueObservation(db, {
        siteId,
        provider: 'stripe',
        observation: observation('ch_1', '2026-07-31T10:00:00.000Z'),
        payloadHash: 'h1',
      })
      expect(first.decision).toMatchObject({ action: 'apply', version: 1 })

      const second = await applyRevenueObservation(db, {
        siteId,
        provider: 'stripe',
        observation: observation('ch_1', '2026-07-31T10:00:05.000Z', { status: 'refunded' }),
        payloadHash: 'h2',
      })
      expect(second.decision).toMatchObject({ action: 'apply', version: 2 })

      const head = await readRevenueObject(db, { siteId, provider: 'stripe', objectId: 'ch_1' })
      expect(head).toMatchObject({ version: 2, payloadHash: 'h2' })
      expect(head?.normalized.status).toBe('refunded')
    })

    it('skips an out-of-order observation without moving the version', async () => {
      const siteId = await makeSite()
      await connect(siteId)
      await applyRevenueObservation(db, {
        siteId,
        provider: 'stripe',
        observation: observation('ch_2', '2026-07-31T10:00:05.000Z'),
        payloadHash: 'newer',
      })
      const stale = await applyRevenueObservation(db, {
        siteId,
        provider: 'stripe',
        observation: observation('ch_2', '2026-07-31T10:00:00.000Z', { status: 'pending' }),
        payloadHash: 'older',
      })
      expect(stale.decision).toMatchObject({ action: 'skip', reason: 'older_snapshot' })

      const head = await readRevenueObject(db, { siteId, provider: 'stripe', objectId: 'ch_2' })
      expect(head).toMatchObject({ version: 1, payloadHash: 'newer' })
      expect(head?.normalized.status).toBe('succeeded')
    })

    it('asks for a re-fetch on an equal snapshot with a different payload', async () => {
      const siteId = await makeSite()
      await connect(siteId)
      const at = '2026-07-31T10:00:00.000Z'
      await applyRevenueObservation(db, {
        siteId,
        provider: 'stripe',
        observation: observation('ch_3', at),
        payloadHash: revenueObservationHash(normalized()),
      })
      const tie = await applyRevenueObservation(db, {
        siteId,
        provider: 'stripe',
        observation: observation('ch_3', at, { status: 'refunded' }),
        payloadHash: revenueObservationHash(normalized({ status: 'refunded' })),
      })
      expect(tie.decision).toMatchObject({ action: 'refetch_from_provider' })

      // …and the forced re-apply is what actually lands it.
      const forced = await applyRevenueObservation(db, {
        siteId,
        provider: 'stripe',
        observation: observation('ch_3', at, { status: 'refunded' }),
        payloadHash: revenueObservationHash(normalized({ status: 'refunded' })),
        force: true,
      })
      expect(forced.decision).toMatchObject({ action: 'apply', version: 2 })
    })

    it('keeps one head per site for the same provider object id', async () => {
      // Two sites connected to one Stripe account see the same `ch_…`. Each gets
      // its own head, its own versions and its own deletion.
      const a = await makeSite()
      const b = await makeSite()
      await connect(a)
      await connect(b)
      for (const siteId of [a, b]) {
        await applyRevenueObservation(db, {
          siteId,
          provider: 'stripe',
          observation: observation('ch_shared', '2026-07-31T10:00:00.000Z'),
          payloadHash: 'h',
        })
      }
      expect(await countIn('revenue_objects', a)).toBe(1)
      expect(await countIn('revenue_objects', b)).toBe(1)
    })

    it('keeps one head per PROVIDER for a colliding object id', async () => {
      // Only worth asserting now that a second provider is live. The unique is
      // `(site_id, provider, object_id)`, and Polar's ids are UUIDs while
      // Stripe's are `ch_…` — but nothing in the schema makes them disjoint, and
      // a site can connect both at once. If `provider` were ever dropped from
      // that key, one provider's object would silently overwrite the other's.
      const siteId = await makeSite()
      await connect(siteId, 'stripe')
      await connect(siteId, 'polar')

      const stripeHead = await applyRevenueObservation(db, {
        siteId,
        provider: 'stripe',
        observation: observation('obj_collide', '2026-07-31T10:00:00.000Z'),
        payloadHash: 'h',
      })
      const polarHead = await applyRevenueObservation(db, {
        siteId,
        provider: 'polar',
        observation: observation('obj_collide', '2026-07-31T10:00:00.000Z'),
        payloadHash: 'h',
      })

      // Two rows, two first versions — not one row applied then skipped as a
      // duplicate snapshot.
      expect(stripeHead.decision.action).toBe('apply')
      expect(polarHead.decision.action).toBe('apply')
      expect(stripeHead.objectRowId).not.toBe(polarHead.objectRowId)
      expect(await countIn('revenue_objects', siteId)).toBe(2)
    })

    it('ledgers the same provider event id once per PROVIDER', async () => {
      // The ledger's uniqueness has the same shape, and Polar's event id is a
      // `webhook-id` header value rather than an `evt_…` — two providers could
      // hand us the same string.
      const siteId = await makeSite()
      const stripe = await connect(siteId, 'stripe')
      const polar = await connect(siteId, 'polar')

      const first = await recordRevenueProviderEvent(db, {
        siteId,
        credentialId: stripe.id,
        provider: 'stripe',
        providerEventId: 'shared_id',
        payloadHash: 'h',
        source: 'webhook',
      })
      const second = await recordRevenueProviderEvent(db, {
        siteId,
        credentialId: polar.id,
        provider: 'polar',
        providerEventId: 'shared_id',
        payloadHash: 'h',
        source: 'webhook',
      })
      expect(first.firstSeen).toBe(true)
      expect(second.firstSeen).toBe(true)
      expect(first.id).not.toBe(second.id)
    })

    it('serializes two concurrent applies into two ordered versions', async () => {
      // The assertion a pure test cannot make. Both transactions open before
      // either commits; the `FOR UPDATE` on the head is what turns them into a
      // sequence instead of a lost update.
      const siteId = await makeSite()
      await connect(siteId)
      await applyRevenueObservation(db, {
        siteId,
        provider: 'stripe',
        observation: observation('ch_race', '2026-07-31T10:00:00.000Z'),
        payloadHash: 'h0',
      })

      const [left, right] = await Promise.all([
        applyRevenueObservation(db, {
          siteId,
          provider: 'stripe',
          observation: observation('ch_race', '2026-07-31T10:00:01.000Z', { status: 'refunded' }),
          payloadHash: 'h1',
        }),
        applyRevenueObservation(db, {
          siteId,
          provider: 'stripe',
          observation: observation('ch_race', '2026-07-31T10:00:02.000Z', {
            status: 'partially_refunded',
          }),
          payloadHash: 'h2',
        }),
      ])

      const versions = [left.decision, right.decision]
        .filter((decision) => decision.action === 'apply')
        .map((decision) => (decision.action === 'apply' ? decision.version : 0))
        .sort()
      // Either both applied (2 then 3) or the older one lost the race and was
      // skipped — never two writes at the same version.
      expect(new Set(versions).size).toBe(versions.length)

      const head = await readRevenueObject(db, { siteId, provider: 'stripe', objectId: 'ch_race' })
      // The newest snapshot always wins, whichever order they committed in.
      expect(head?.payloadHash).toBe('h2')
      expect(head?.version).toBeGreaterThanOrEqual(2)
    })

    it('resolves a concurrent first-insert race into one head', async () => {
      // `SELECT … FOR UPDATE` locks nothing when the row does not exist, so both
      // transactions legitimately find it absent. The `ON CONFLICT DO NOTHING`
      // plus the second pass is what makes exactly one of them the insert.
      const siteId = await makeSite()
      await connect(siteId)
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          applyRevenueObservation(db, {
            siteId,
            provider: 'stripe',
            observation: observation('ch_new', '2026-07-31T10:00:00.000Z'),
            payloadHash: `h${String(index)}`,
          }),
        ),
      )
      expect(await countIn('revenue_objects', siteId)).toBe(1)
      expect(results.every((result) => result.objectRowId !== null)).toBe(true)
    })

    it('refuses a version below one at the database', async () => {
      const siteId = await makeSite()
      await connect(siteId)
      await applyRevenueObservation(db, {
        siteId,
        provider: 'stripe',
        observation: observation('ch_v', '2026-07-31T10:00:00.000Z'),
        payloadHash: 'h',
      })
      await expect(
        pool.query(`UPDATE revenue_objects SET version = 0 WHERE site_id = $1`, [siteId]),
      ).rejects.toThrow(/revenue_objects_version_check/u)
    })
  })

  describe('sync cursors', () => {
    it('upserts on (credential, resource) rather than appending', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)
      const windowStart = new Date('2026-05-01T00:00:00.000Z')
      const windowEnd = new Date('2026-07-31T23:59:59.999Z')

      await saveRevenueSyncState(db, {
        credentialId: credential.id,
        siteId,
        resource: 'charges',
        cursor: 'ch_100',
        windowStart,
        windowEnd,
        completedAt: null,
      })
      await saveRevenueSyncState(db, {
        credentialId: credential.id,
        siteId,
        resource: 'charges',
        cursor: 'ch_200',
        windowStart,
        windowEnd,
        completedAt: null,
      })

      const rows = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM revenue_sync_state WHERE credential_id = $1`,
        [credential.id],
      )
      expect(rows.rows[0]?.n).toBe('1')
      const state = await readRevenueSyncState(db, {
        credentialId: credential.id,
        resource: 'charges',
      })
      expect(state?.cursor).toBe('ch_200')
    })

    it('clears completed_at when a window re-opens', async () => {
      // The reconcile sweep re-walks a moving window through the same row, so a
      // stale `completed_at` would make a resource look finished before it
      // started.
      const siteId = await makeSite()
      const credential = await connect(siteId)
      const base = {
        credentialId: credential.id,
        siteId,
        resource: 'refunds' as const,
        windowStart: new Date('2026-07-29T00:00:00.000Z'),
        windowEnd: new Date('2026-07-31T00:00:00.000Z'),
      }
      await saveRevenueSyncState(db, { ...base, cursor: null, completedAt: new Date() })
      expect((await readRevenueSyncState(db, base))?.completedAt).not.toBeNull()

      await saveRevenueSyncState(db, {
        ...base,
        windowStart: new Date('2026-07-30T00:00:00.000Z'),
        cursor: 're_1',
        completedAt: null,
      })
      const state = await readRevenueSyncState(db, base)
      expect(state?.completedAt).toBeNull()
      expect(state?.cursor).toBe('re_1')
    })

    it('holds one cursor per resource', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)
      const windowStart = new Date('2026-07-01T00:00:00.000Z')
      const windowEnd = new Date('2026-07-31T00:00:00.000Z')
      for (const resource of ['charges', 'refunds', 'disputes'] as const) {
        await saveRevenueSyncState(db, {
          credentialId: credential.id,
          siteId,
          resource,
          cursor: `${resource}_cursor`,
          windowStart,
          windowEnd,
          completedAt: null,
        })
      }
      const rows = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM revenue_sync_state WHERE credential_id = $1`,
        [credential.id],
      )
      expect(rows.rows[0]?.n).toBe('3')
    })

    it('refuses a resource outside the closed vocabulary', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)
      await expect(
        pool.query(
          `INSERT INTO revenue_sync_state (id, credential_id, site_id, resource)
             VALUES ($1, $2, $3, 'payouts')`,
          [newId(), credential.id, siteId],
        ),
      ).rejects.toThrow(/revenue_sync_state_resource_check/u)
    })
  })

  describe('reconcile discovery', () => {
    it('finds a stale credential and skips a fresh one', async () => {
      const stale = await makeSite()
      const fresh = await makeSite()
      const staleCredential = await connect(stale)
      const freshCredential = await connect(fresh)
      const now = new Date()

      await updateRevenueCredentialState(db, {
        credentialId: staleCredential.id,
        siteId: stale,
        lastSyncedAt: new Date(now.getTime() - 3_600_000),
      })
      await updateRevenueCredentialState(db, {
        credentialId: freshCredential.id,
        siteId: fresh,
        lastSyncedAt: now,
      })

      const due = await listRevenueCredentialsDueForSync(db, {
        staleBefore: new Date(now.getTime() - 900_000),
        limit: 50,
        backfillJobType: REVENUE_BACKFILL_JOB_TYPE,
      })
      const ids = due.map((row) => row.id)
      expect(ids).toContain(staleCredential.id)
      expect(ids).not.toContain(freshCredential.id)
    })

    it('leaves a never-synced credential alone while its backfill job is live', async () => {
      // Connect enqueues the backfill in the same transaction, so a freshly
      // connected credential is exactly this case — and the sweep must not race
      // its own sibling over the same rate budget.
      const siteId = await makeSite()
      const credential = await connect(siteId)

      const due = await listRevenueCredentialsDueForSync(db, {
        staleBefore: new Date(Date.now() - 900_000),
        limit: 50,
        backfillJobType: REVENUE_BACKFILL_JOB_TYPE,
      })
      expect(due.map((row) => row.id)).not.toContain(credential.id)

      // Once the backfill is no longer live, the sweep owns it.
      await pool.query(`UPDATE jobs SET status = 'succeeded' WHERE type = $1 AND subject_id = $2`, [
        REVENUE_BACKFILL_JOB_TYPE,
        credential.id,
      ])
      const after = await listRevenueCredentialsDueForSync(db, {
        staleBefore: new Date(Date.now() - 900_000),
        limit: 50,
        backfillJobType: REVENUE_BACKFILL_JOB_TYPE,
      })
      expect(after.map((row) => row.id)).toContain(credential.id)
    })

    it('includes a degraded credential — that is how an outage is discovered to be over', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)
      await pool.query(`UPDATE jobs SET status = 'succeeded' WHERE subject_id = $1`, [
        credential.id,
      ])
      await updateRevenueCredentialState(db, {
        credentialId: credential.id,
        siteId,
        status: 'degraded',
        // An *outage* category. `unauthorized` is deliberately the one degraded
        // state that is excluded instead — see the rejected-key suite below —
        // because nothing about a revoked key changes on its own.
        lastError: 'provider_unavailable',
        lastSyncedAt: new Date(Date.now() - 3_600_000),
      })
      const found = await listRevenueCredentialsDueForSync(db, {
        staleBefore: new Date(Date.now() - 900_000),
        limit: 50,
        backfillJobType: REVENUE_BACKFILL_JOB_TYPE,
      })
      const row = found.find((candidate) => candidate.id === credential.id)
      expect(row?.status).toBe('degraded')
      // The sweep needs the category to apply the "only a completed walk or a
      // fresh secret clears `unauthorized`" rule without a second read.
      expect(row?.lastError).toBe('provider_unavailable')
    })
  })

  describe('the backfill job and its generation (D4)', () => {
    const backfillJobs = async (credentialId: string) =>
      (
        await pool.query<{
          status: string
          payload: Record<string, unknown>
          idempotency_key: string
        }>(
          `SELECT status, payload, idempotency_key FROM jobs
             WHERE type = $1 AND subject_id = $2 ORDER BY created_at`,
          [REVENUE_BACKFILL_JOB_TYPE, credentialId],
        )
      ).rows

    it('connect enqueues one live job whose subject is the credential', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)
      const jobs = await backfillJobs(credential.id)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]?.status).toBe('queued')
      expect(jobs[0]?.payload['site_id']).toBe(siteId)
      expect(jobs[0]?.payload['generation']).toBe(0)
      expect(jobs[0]?.idempotency_key).toBe(`${REVENUE_BACKFILL_JOB_TYPE}:${credential.id}:0`)
    })

    it('a terminal backfill no longer spends the key forever', async () => {
      // The failure this exists for: a restricted key with `Charges` read but
      // not `Disputes` passes the connect probe and terminals the walk. With a
      // fixed idempotency key that credential could NEVER be backfilled again,
      // while the sweep went on reporting a healthy connection.
      const siteId = await makeSite()
      const credential = await connect(siteId)
      await pool.query(
        `UPDATE jobs SET status = 'failed_terminal', finished_at = now()
           WHERE type = $1 AND subject_id = $2`,
        [REVENUE_BACKFILL_JOB_TYPE, credential.id],
      )

      const rerun = await requestRevenueBackfill(db, { credentialId: credential.id, siteId })
      expect(rerun).toMatchObject({ enqueued: true, generation: 1 })

      const jobs = await backfillJobs(credential.id)
      expect(jobs).toHaveLength(2)
      expect(jobs[1]?.status).toBe('queued')
      expect(jobs[1]?.idempotency_key).toBe(`${REVENUE_BACKFILL_JOB_TYPE}:${credential.id}:1`)
    })

    it('a re-run while one is live starts no second walk', async () => {
      // The safety property the generation must NOT break: the live-subject
      // index still forbids two concurrent walks over the same cursors.
      const siteId = await makeSite()
      const credential = await connect(siteId)
      const rerun = await requestRevenueBackfill(db, { credentialId: credential.id, siteId })
      expect(rerun.enqueued).toBe(false)
      expect(await backfillJobs(credential.id)).toHaveLength(1)
    })

    it('a rotation bumps the generation and enqueues a fresh walk', async () => {
      // The ordinary reason a customer rotates is that the previous key stopped
      // working, so the history it failed to walk has to be walked again.
      const siteId = await makeSite()
      const credential = await connect(siteId)
      await pool.query(`UPDATE jobs SET status = 'failed_terminal' WHERE subject_id = $1`, [
        credential.id,
      ])

      const rotated = await rotateRevenueCredential(db, {
        credentialId: credential.id,
        siteId,
        encryptedApiKey: cipher('rotated'),
        keyVersion: 'k1',
        apiKeyLast4: '9999',
        actorUserId: ownerId,
      })
      expect(rotated?.backfillGeneration).toBe(1)

      const jobs = await backfillJobs(credential.id)
      expect(jobs).toHaveLength(2)
      expect(jobs[1]?.idempotency_key).toBe(`${REVENUE_BACKFILL_JOB_TYPE}:${credential.id}:1`)
    })

    it('refuses a re-run for a disconnected credential', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)
      await disconnectRevenueCredential(db, {
        credentialId: credential.id,
        siteId,
        actorUserId: ownerId,
      })
      const rerun = await requestRevenueBackfill(db, { credentialId: credential.id, siteId })
      expect(rerun).toMatchObject({ enqueued: false, generation: null })
    })
  })

  describe('the rejected-key exclusion (D4)', () => {
    it('drops a degraded+unauthorized credential out of discovery', async () => {
      // Retrying a revoked key every fifteen minutes is ~1,440 refused requests
      // a day against a customer's account, and none of them can succeed.
      const siteId = await makeSite()
      const credential = await connect(siteId)
      await pool.query(`UPDATE jobs SET status = 'succeeded' WHERE subject_id = $1`, [
        credential.id,
      ])
      await updateRevenueCredentialState(db, {
        credentialId: credential.id,
        siteId,
        status: 'degraded',
        lastError: REVENUE_UNAUTHORIZED_ERROR,
        lastSyncedAt: new Date(Date.now() - 3_600_000),
      })

      const due = async () =>
        await listRevenueCredentialsDueForSync(db, {
          staleBefore: new Date(Date.now() - 900_000),
          limit: 50,
          backfillJobType: REVENUE_BACKFILL_JOB_TYPE,
        })
      expect((await due()).map((row) => row.id)).not.toContain(credential.id)

      // A rotation is one of the two things that puts it back: it clears the
      // error, so the row re-enters discovery.
      await rotateRevenueCredential(db, {
        credentialId: credential.id,
        siteId,
        encryptedApiKey: cipher('rotated'),
        keyVersion: 'k1',
        apiKeyLast4: '9999',
        actorUserId: ownerId,
      })
      await pool.query(`UPDATE jobs SET status = 'succeeded' WHERE subject_id = $1`, [
        credential.id,
      ])
      expect((await due()).map((row) => row.id)).toContain(credential.id)
    })
  })

  describe('deliveries to a disconnected credential (D4)', () => {
    it('collapses onto ONE row however many distinct bodies arrive', async () => {
      // The write amplification an unauthenticated caller can cause against a
      // disconnected endpoint. Keying on a payload hash would let one byte of
      // variation add a row; keying on the credential caps it at one.
      const siteId = await makeSite()
      const credential = await connect(siteId)
      await disconnectRevenueCredential(db, {
        credentialId: credential.id,
        siteId,
        actorUserId: ownerId,
      })

      for (const hash of ['h1', 'h2', 'h3', 'h1']) {
        await noteDisabledRevenueDelivery(db, {
          siteId,
          credentialId: credential.id,
          provider: 'stripe',
          payloadHash: hash,
        })
      }

      const rows = await pool.query<{ status: string; result: Record<string, unknown> }>(
        `SELECT status, result FROM revenue_provider_events WHERE site_id = $1`,
        [siteId],
      )
      expect(rows.rows).toHaveLength(1)
      expect(rows.rows[0]?.status).toBe('ignored')
      expect(rows.rows[0]?.result['reason']).toBe('credential_disabled')
      // The counter is what preserves "your old endpoint is still posting, N
      // times now" while the row count stays at one.
      expect(rows.rows[0]?.result['deliveries']).toBe(4)
    })
  })

  describe('currency rates (D2c)', () => {
    it('upserts idempotently, which is what makes a weekend a no-op', async () => {
      const rates = {
        rateDate: '2026-07-31',
        rates: [
          { currency: 'USD', ratePerEur: '1.0876' },
          { currency: 'EUR', ratePerEur: '1' },
        ],
      }
      await upsertCurrencyRates(db, { rates })
      await upsertCurrencyRates(db, { rates })

      const count = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM currency_rates WHERE rate_date = '2026-07-31'`,
      )
      expect(count.rows[0]?.n).toBe('2')
    })

    it('overwrites a corrected rate rather than keeping the first', async () => {
      await upsertCurrencyRates(db, {
        rates: { rateDate: '2026-07-30', rates: [{ currency: 'GBP', ratePerEur: '0.84' }] },
      })
      await upsertCurrencyRates(db, {
        rates: { rateDate: '2026-07-30', rates: [{ currency: 'GBP', ratePerEur: '0.84355' }] },
      })
      const rate = await readCurrencyRate(db, { currency: 'GBP', onOrBefore: '2026-07-30' })
      expect(rate?.ratePerEur).toBe('0.84355')
    })

    it('stores an exact decimal, not a float', async () => {
      // `numeric` in, string out. A `double precision` column would have turned
      // this into 0.844999999… and every conversion after it into a rounding
      // question nobody asked.
      await upsertCurrencyRates(db, {
        rates: { rateDate: '2026-07-29', rates: [{ currency: 'HUF', ratePerEur: '398.4500' }] },
      })
      const rate = await readCurrencyRate(db, { currency: 'HUF', onOrBefore: '2026-07-29' })
      expect(rate?.ratePerEur).toBe('398.4500')
    })

    it('falls back to the last published banking day', async () => {
      // A Sunday transaction has no Sunday rate; the ECB publishes on banking
      // days only, and the returned `rateDate` is what the fact records so a
      // reader can see which day's rate was actually used.
      const rate = await readCurrencyRate(db, { currency: 'USD', onOrBefore: '2026-08-02' })
      expect(rate?.rateDate).toBe('2026-07-31')
    })

    it('returns null for a currency the ECB does not list', async () => {
      // The `conversion_source = 'unavailable'` case: visible, never dropped,
      // never a silent zero.
      expect(await readCurrencyRate(db, { currency: 'XYZ', onOrBefore: '2026-07-31' })).toBeNull()
    })

    it('refuses a zero, negative or malformed row at the database', async () => {
      await expect(
        pool.query(
          `INSERT INTO currency_rates (rate_date, currency, rate_per_eur)
             VALUES ('2026-07-31', 'ZZZ', 0)`,
        ),
      ).rejects.toThrow(/currency_rates_positive/u)
      await expect(
        pool.query(
          `INSERT INTO currency_rates (rate_date, currency, rate_per_eur)
             VALUES ('2026-07-31', 'usd', 1.1)`,
        ),
      ).rejects.toThrow(/currency_rates_currency_format/u)
    })

    it('reports the latest rate date it holds', async () => {
      expect(await readLatestCurrencyRateDate(db)).toBe('2026-07-31')
    })
  })

  describe('site deletion (ADR-0033, D8)', () => {
    it('snapshots 67 targets including the three ingest tables', async () => {
      const siteId = await makeSite()
      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      const targets = await listDeletionTargets(db, {
        deletionRequestId: started.deletionRequestId,
      })
      // 67, not 68 (62 + the three subscription lifecycle tables of Postgres 0047 and the two of ClickHouse 0030): `billing_transfer_offers` is a target the hosted surface registers (`CLOUD_DELETION_EXTENSION`), so this is the set a build without it erases.
      expect(targets).toHaveLength(67)
      expect(targets).toHaveLength(SITE_DELETION_TARGETS.length)
      const names = targets.filter((t) => t.store === 'postgres').map((t) => t.target)
      expect(names).toContain('revenue_provider_events')
      expect(names).toContain('revenue_objects')
      expect(names).toContain('revenue_sync_state')
      // Global reference data: never a target, whatever else grows.
      expect(names).not.toContain('currency_rates')
    })

    it('purges each named table, leaves a sibling and keeps the rates', async () => {
      // A name with no purge statement behind it verifies silently at
      // `deleted: 0`, so the per-table effect is asserted, not only the count.
      const siteId = await makeSite()
      const sibling = await makeSite()
      const credential = await connect(siteId)
      const survivorCredential = await connect(sibling)

      for (const target of [
        { siteId, credentialId: credential.id },
        { siteId: sibling, credentialId: survivorCredential.id },
      ]) {
        await recordRevenueProviderEvent(db, {
          siteId: target.siteId,
          credentialId: target.credentialId,
          provider: 'stripe',
          providerEventId: `evt_purge_${target.siteId}`,
          payloadHash: 'h',
          source: 'webhook',
        })
        await applyRevenueObservation(db, {
          siteId: target.siteId,
          provider: 'stripe',
          observation: observation('ch_purge', '2026-07-31T10:00:00.000Z'),
          payloadHash: 'h',
        })
        await saveRevenueSyncState(db, {
          credentialId: target.credentialId,
          siteId: target.siteId,
          resource: 'charges',
          cursor: 'c1',
          windowStart: new Date('2026-05-01T00:00:00.000Z'),
          windowEnd: new Date('2026-07-31T00:00:00.000Z'),
          completedAt: null,
        })
      }

      const ratesBefore = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM currency_rates`,
      )

      await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      const result = await purgeSitePostgres(db, { siteId })

      expect(result.deleted['revenue_provider_events']).toBe(1)
      expect(result.deleted['revenue_objects']).toBe(1)
      expect(result.deleted['revenue_sync_state']).toBe(1)
      expect(result.deleted['revenue_credentials']).toBe(1)

      expect(await countIn('revenue_provider_events', siteId)).toBe(0)
      expect(await countIn('revenue_objects', siteId)).toBe(0)
      expect(await countIn('revenue_sync_state', siteId)).toBe(0)

      // The sibling keeps all three, which is the half that proves the purge is
      // site-scoped rather than table-scoped.
      expect(await countIn('revenue_provider_events', sibling)).toBe(1)
      expect(await countIn('revenue_objects', sibling)).toBe(1)
      expect(await countIn('revenue_sync_state', sibling)).toBe(1)

      // And the ECB's rates belong to every other tenant.
      const ratesAfter = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM currency_rates`,
      )
      expect(ratesAfter.rows[0]?.n).toBe(ratesBefore.rows[0]?.n)
    })
  })
})
