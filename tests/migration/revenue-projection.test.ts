import {
  SITE_DELETION_TARGETS,
  revenueObservationHash,
  type RevenueNormalizedObject,
  type RevenueObservation,
} from '@openanalytics/domain'
import {
  REVENUE_STUCK_DELIVERY_REASON,
  applyRevenueObservation,
  createDatabase,
  createPool,
  createRevenueCredential,
  createSiteWithOwner,
  failStuckRevenueDeliveries,
  listDeletionTargets,
  listSitesWithUnprojectedRevenue,
  listUnprojectedRevenueObjects,
  markRevenueObjectsProjected,
  mintWebhookToken,
  newId,
  purgeSitePostgres,
  readOldestUnprojectedRevenueChange,
  readRevenueMatchHint,
  readRevenueMatchHintsByOrder,
  readRevenueProviderEvent,
  readSiteReportingCurrency,
  recordRevenueMatchHints,
  recordRevenueProviderEvent,
  resetRevenueProjection,
  startSiteDeletion,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import {
  revenueEventsToken,
  type RevenueEventRow,
  type RevenueEventsStore,
} from '@openanalytics/clickhouse'
import type { Metrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { projectRevenueOnce } from '../../apps/worker/src/revenue/project.ts'

/**
 * The projection queue, the match hints and the stuck-delivery sweep against a
 * real Postgres (ADR-0033, D5/D6/D8; migration 0035). Milestone 12 CP3.
 *
 * Every assertion here is a *database* fact the application cannot compensate
 * for:
 *
 * 1. **The projection marker is exactly-once and race-free.** A head is due when
 *    `projected_version < version`, and marking writes the literal version that
 *    was projected under a `<` guard — so a concurrent observation that bumped
 *    the head between the read and the mark leaves the row due rather than
 *    losing the bump. This is the property that made a per-row marker preferable
 *    to a timestamp watermark, and only a real database can demonstrate it.
 * 2. **Hints cannot touch money.** A checkout hint is written by its own
 *    statement, and the object head's `version`, `payload_hash` and `normalized`
 *    are byte-identical before and after. The whole reason the hints table
 *    exists is that the alternative could not promise this.
 * 3. **The hint upsert is bounded by session.** A redelivered session updates
 *    one row and fills in what the first delivery lacked, rather than inserting
 *    a second.
 * 4. **The stuck sweep settles and does not repair.** Rows past the horizon
 *    become `failed` with a categorized result; rows inside it are untouched,
 *    because settling them early would destroy the state that makes a
 *    redelivery reprocess them.
 * 5. **`revenue_match_hints` is purged with the site and a sibling keeps its
 *    rows.** A vocabulary name with no purge statement verifies silently at
 *    `deleted: 0`, so the per-table effect is asserted, not only the count.
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

describeIfPostgres('revenue projection state', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m12proj_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
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

  const makeSite = async (reportingCurrency?: string): Promise<string> => {
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: ownerId,
    })
    if (reportingCurrency) {
      await pool.query(`UPDATE sites SET reporting_currency = $2 WHERE id = $1`, [
        siteId,
        reportingCurrency,
      ])
    }
    return siteId
  }

  const connect = async (siteId: string) => {
    const id = newId()
    const created = await createRevenueCredential(db, {
      id,
      siteId,
      provider: 'stripe',
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

  const apply = async (
    siteId: string,
    objectId: string,
    at: string,
    overrides: Partial<RevenueNormalizedObject> = {},
  ) => {
    const obs = observation(objectId, at, overrides)
    return await applyRevenueObservation(db, {
      siteId,
      provider: 'stripe',
      observation: obs,
      payloadHash: revenueObservationHash(obs.normalized),
    })
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

  describe('the projection marker (D5)', () => {
    it('makes a brand-new head due, with no clock involved', async () => {
      const siteId = await makeSite()
      await apply(siteId, 'ch_new', '2026-07-31T10:00:00.000Z')

      expect(await listSitesWithUnprojectedRevenue(db, { limit: 10 })).toContain(siteId)
      const due = await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })
      expect(due.map((row) => row.objectId)).toEqual(['ch_new'])
      // Version 1 and marker 0 — the default is exactly "never projected", which
      // is why the migration needs no backfill.
      expect(due[0]?.version).toBe(1)
    })

    it('drops a head out of the queue once marked, and back in when it moves', async () => {
      const siteId = await makeSite()
      await apply(siteId, 'ch_mark', '2026-07-31T10:00:00.000Z')
      const [due] = await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })
      expect(due).toBeDefined()

      const marked = await markRevenueObjectsProjected(db, {
        marks: [{ id: (due as { id: string }).id, version: 1, epoch: 0 }],
      })
      expect(marked.marked).toBe(1)
      expect(await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })).toHaveLength(0)

      // A later observation bumps the head to version 2 — due again, with no
      // watermark to rewind and no timestamp comparison anywhere.
      await apply(siteId, 'ch_mark', '2026-07-31T11:00:00.000Z', { status: 'refunded' })
      const again = await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })
      expect(again).toHaveLength(1)
      expect(again[0]?.version).toBe(2)
    })

    it('does not lose a bump that landed between the read and the mark', async () => {
      // The race the LITERAL version exists for. If the mark wrote the *column*
      // (`projected_version = version`) it would claim version 2 as projected
      // while only version 1 was ever written to ClickHouse, and that charge's
      // refund would never appear.
      const siteId = await makeSite()
      await apply(siteId, 'ch_race', '2026-07-31T10:00:00.000Z')
      const [read] = await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })
      expect(read?.version).toBe(1)

      await apply(siteId, 'ch_race', '2026-07-31T10:30:00.000Z', { status: 'refunded' })

      await markRevenueObjectsProjected(db, {
        marks: [{ id: (read as { id: string }).id, version: 1, epoch: 0 }],
      })

      const still = await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })
      expect(still).toHaveLength(1)
      expect(still[0]?.version).toBe(2)
    })

    it('refuses to move a marker backwards', async () => {
      // A retried batch arriving after a later batch already advanced the row is
      // a no-op, not a rewind that would re-project everything in between.
      const siteId = await makeSite()
      await apply(siteId, 'ch_back', '2026-07-31T10:00:00.000Z')
      await apply(siteId, 'ch_back', '2026-07-31T10:30:00.000Z', { status: 'refunded' })
      const [row] = await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })
      const id = (row as { id: string }).id

      expect(
        (await markRevenueObjectsProjected(db, { marks: [{ id, version: 2, epoch: 0 }] })).marked,
      ).toBe(1)
      expect(
        (await markRevenueObjectsProjected(db, { marks: [{ id, version: 1, epoch: 0 }] })).marked,
      ).toBe(0)
      expect(await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })).toHaveLength(0)
    })

    it('refuses a marker above the head version at the database', async () => {
      // The CHECK is the backstop for a caller that computed a version wrongly:
      // a marker claiming more than was ever minted would silently retire a head
      // forever.
      const siteId = await makeSite()
      await apply(siteId, 'ch_check', '2026-07-31T10:00:00.000Z')
      await expect(
        pool.query(
          `UPDATE revenue_objects SET projected_version = 99 WHERE site_id = $1 AND object_id = 'ch_check'`,
          [siteId],
        ),
      ).rejects.toThrow(/revenue_objects_projected_version_check/u)
    })

    it('returns heads oldest-changed first', async () => {
      // A ninety-day backfill produces thousands of heads at once; taking them in
      // physical order would fill the dashboard's recent buckets last.
      const siteId = await makeSite()
      await apply(siteId, 'ch_a', '2026-07-31T10:00:00.000Z')
      await apply(siteId, 'ch_b', '2026-07-31T10:00:00.000Z')
      await apply(siteId, 'ch_c', '2026-07-31T10:00:00.000Z')
      const ids = (await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })).map(
        (row) => row.objectId,
      )
      expect(new Set(ids)).toEqual(new Set(['ch_a', 'ch_b', 'ch_c']))
      // Stable across calls: `(updated_at, id)` breaks the tie deterministically,
      // so a bounded batch cannot return one row twice while never returning
      // another.
      const again = (await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })).map(
        (row) => row.objectId,
      )
      expect(again).toEqual(ids)
    })

    it('reports the oldest pending change as a real Date, not a driver string', async () => {
      // An aggregate over a `timestamptz` carries no Drizzle column mapper, so
      // the driver hands back a string rather than a `Date`. The gauge subtracts
      // this from `Date.now()`, and a string would publish `NaN` milliseconds —
      // a lag series that exists, looks alive and means nothing. Found by this
      // test against a real Postgres, which is the only place it is visible.
      const siteId = await makeSite()
      await apply(siteId, 'ch_lag', '2026-07-31T10:00:00.000Z')
      const oldest = await readOldestUnprojectedRevenueChange(db)
      expect(oldest).toBeInstanceOf(Date)
      expect(Number.isNaN((oldest as Date).getTime())).toBe(false)
      expect(Date.now() - (oldest as Date).getTime()).toBeGreaterThanOrEqual(0)
    })

    it('refuses a mark whose epoch a re-materialization has moved (the S1 race)', async () => {
      // The interleaving that would otherwise lose a head permanently:
      //
      //   1. the projection reads H at version 3,
      //   2. a re-materialization zeroes every marker for the site,
      //   3. the batch finishes and marks H at 3 — and `0 < 3` satisfies the
      //      version guard perfectly.
      //
      // H would then be recorded as projected while ClickHouse still held the
      // row built under the OLD reporting currency, with nothing ever picking it
      // up again. The epoch is what makes step 3 match nothing.
      const siteId = await makeSite()
      await apply(siteId, 'ch_epoch', '2026-07-31T10:00:00.000Z')

      // 1. read
      const [read] = await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })
      expect(read?.projectionEpoch).toBe(0)

      // 2. reset
      await resetRevenueProjection(db, { siteId })

      // 3. the in-flight batch marks with the epoch it READ
      const marked = await markRevenueObjectsProjected(db, {
        marks: [
          {
            id: (read as { id: string }).id,
            version: (read as { version: number }).version,
            epoch: (read as { projectionEpoch: number }).projectionEpoch,
          },
        ],
      })
      expect(marked.marked).toBe(0)

      // The head is still due, so the re-materialization completes.
      const still = await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })
      expect(still).toHaveLength(1)
      expect(still[0]?.projectionEpoch).toBe(1)

      // And the batch that reads the NEW epoch marks normally.
      const after = await markRevenueObjectsProjected(db, {
        marks: [
          {
            id: (still[0] as { id: string }).id,
            version: (still[0] as { version: number }).version,
            epoch: (still[0] as { projectionEpoch: number }).projectionEpoch,
          },
        ],
      })
      expect(after.marked).toBe(1)
      expect(await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })).toHaveLength(0)
    })

    it('re-queues a whole site for the D2c re-materialization', async () => {
      const siteId = await makeSite()
      await apply(siteId, 'ch_remat_1', '2026-07-31T10:00:00.000Z')
      await apply(siteId, 'ch_remat_2', '2026-07-31T10:00:00.000Z')
      const due = await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })
      await markRevenueObjectsProjected(db, {
        marks: due.map((row) => ({ id: row.id, version: row.version, epoch: row.projectionEpoch })),
      })
      expect(await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })).toHaveLength(0)

      const reset = await resetRevenueProjection(db, { siteId })
      expect(reset.reset).toBe(2)
      expect(await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })).toHaveLength(2)
    })

    it('reads the site reporting currency, and null for a site that is gone', async () => {
      const siteId = await makeSite('JPY')
      expect(await readSiteReportingCurrency(db, siteId)).toBe('JPY')
      expect(await readSiteReportingCurrency(db, newId())).toBeNull()
    })

    it('defaults a site to USD', async () => {
      expect(await readSiteReportingCurrency(db, await makeSite())).toBe('USD')
    })
  })

  describe('checkout match hints (D6)', () => {
    it('records a hint and leaves the money state byte-identical', async () => {
      // The assertion the whole design is for. A hints-only observation would
      // have had to pass through the object head, where it would either tie on
      // snapshot time or rewrite the document holding the amounts.
      const siteId = await makeSite()
      await apply(siteId, 'ch_hint', '2026-07-31T10:00:00.000Z')

      const before = await pool.query<{
        version: string
        payload_hash: string
        normalized: RevenueNormalizedObject
      }>(
        `SELECT version::text, payload_hash, normalized FROM revenue_objects
          WHERE site_id = $1 AND object_id = 'ch_hint'`,
        [siteId],
      )

      await recordRevenueMatchHints(db, {
        siteId,
        provider: 'stripe',
        hints: [
          {
            checkoutSessionId: 'cs_1',
            orderId: 'pi_1',
            clientReferenceId: 'user-42',
            customerId: 'cus_hint',
            occurredAt: new Date('2026-07-31T09:59:00.000Z'),
          },
        ],
      })

      const after = await pool.query<{
        version: string
        payload_hash: string
        normalized: RevenueNormalizedObject
      }>(
        `SELECT version::text, payload_hash, normalized FROM revenue_objects
          WHERE site_id = $1 AND object_id = 'ch_hint'`,
        [siteId],
      )
      expect(after.rows[0]).toEqual(before.rows[0])

      const stored = await readRevenueMatchHint(db, {
        siteId,
        provider: 'stripe',
        checkoutSessionId: 'cs_1',
      })
      expect(stored).toMatchObject({ orderId: 'pi_1', clientReferenceId: 'user-42' })
    })

    it('upserts on the session, filling in what the first delivery lacked', async () => {
      // The async-payment case: the session completes before the PaymentIntent
      // has a charge, and Stripe redelivers with more of it filled in. `DO
      // NOTHING` would pin the first, emptiest version of the row forever.
      const siteId = await makeSite()
      await recordRevenueMatchHints(db, {
        siteId,
        provider: 'stripe',
        hints: [
          {
            checkoutSessionId: 'cs_async',
            orderId: '',
            clientReferenceId: 'user-9',
            customerId: '',
            occurredAt: new Date('2026-07-31T09:00:00.000Z'),
          },
        ],
      })
      await recordRevenueMatchHints(db, {
        siteId,
        provider: 'stripe',
        hints: [
          {
            checkoutSessionId: 'cs_async',
            orderId: 'pi_async',
            clientReferenceId: 'user-9',
            customerId: 'cus_async',
            occurredAt: new Date('2026-07-31T11:00:00.000Z'),
          },
        ],
      })

      expect(await countIn('revenue_match_hints', siteId)).toBe(1)
      expect(
        await readRevenueMatchHint(db, {
          siteId,
          provider: 'stripe',
          checkoutSessionId: 'cs_async',
        }),
      ).toMatchObject({ orderId: 'pi_async', customerId: 'cus_async' })
    })

    it('never lets a later delivery blank out a populated field', async () => {
      // The other direction of the upsert, and the one that loses data. Provider
      // payloads are not monotone: a redelivery of an older event, or a
      // reconcile re-observation, can arrive with an empty field where the
      // stored row has a real one. A plain `SET x = excluded.x` would overwrite
      // a matched hint with a blank and the charge would silently stop being
      // attributable.
      const siteId = await makeSite()
      const base = {
        checkoutSessionId: 'cs_ff',
        orderId: 'pi_ff',
        clientReferenceId: 'user-ff',
        customerId: 'cus_ff',
        occurredAt: new Date('2026-07-31T11:00:00.000Z'),
      }
      await recordRevenueMatchHints(db, { siteId, provider: 'stripe', hints: [base] })

      // Everything blank except the key, and an OLDER timestamp.
      await recordRevenueMatchHints(db, {
        siteId,
        provider: 'stripe',
        hints: [
          {
            checkoutSessionId: 'cs_ff',
            orderId: '',
            clientReferenceId: '',
            customerId: '',
            occurredAt: new Date('2026-07-31T09:00:00.000Z'),
          },
        ],
      })

      const stored = await readRevenueMatchHint(db, {
        siteId,
        provider: 'stripe',
        checkoutSessionId: 'cs_ff',
      })
      expect(stored).toMatchObject({
        orderId: 'pi_ff',
        clientReferenceId: 'user-ff',
        customerId: 'cus_ff',
      })
      // `occurred_at` takes the later of the two, so an out-of-order redelivery
      // is a no-op on it rather than a rewind.
      expect(stored?.occurredAt.toISOString()).toBe('2026-07-31T11:00:00.000Z')
    })

    it('still fills a blank field forward when the later delivery has it', async () => {
      // Fill-forward has to remain an upsert, not a freeze: the async-payment
      // case above is the whole reason `DO NOTHING` was rejected.
      const siteId = await makeSite()
      await recordRevenueMatchHints(db, {
        siteId,
        provider: 'stripe',
        hints: [
          {
            checkoutSessionId: 'cs_mixed',
            orderId: '',
            clientReferenceId: 'user-m',
            customerId: '',
            occurredAt: new Date('2026-07-31T09:00:00.000Z'),
          },
        ],
      })
      await recordRevenueMatchHints(db, {
        siteId,
        provider: 'stripe',
        hints: [
          {
            checkoutSessionId: 'cs_mixed',
            orderId: 'pi_mixed',
            clientReferenceId: '',
            customerId: 'cus_mixed',
            occurredAt: new Date('2026-07-31T12:00:00.000Z'),
          },
        ],
      })

      // Each field independently: the new order id and customer land, the
      // existing client reference survives the blank that came with them.
      expect(
        await readRevenueMatchHint(db, {
          siteId,
          provider: 'stripe',
          checkoutSessionId: 'cs_mixed',
        }),
      ).toMatchObject({
        orderId: 'pi_mixed',
        clientReferenceId: 'user-m',
        customerId: 'cus_mixed',
      })
    })

    it('looks hints up by order id, batched, and never matches an empty one', async () => {
      const siteId = await makeSite()
      await recordRevenueMatchHints(db, {
        siteId,
        provider: 'stripe',
        hints: [
          {
            checkoutSessionId: 'cs_x',
            orderId: 'pi_x',
            clientReferenceId: 'user-x',
            customerId: '',
            occurredAt: new Date('2026-07-31T09:00:00.000Z'),
          },
          {
            checkoutSessionId: 'cs_none',
            orderId: '',
            clientReferenceId: 'user-none',
            customerId: '',
            occurredAt: new Date('2026-07-31T09:00:00.000Z'),
          },
        ],
      })

      const found = await readRevenueMatchHintsByOrder(db, {
        siteId,
        provider: 'stripe',
        // The empty string is filtered out before the query: a charge with no
        // PaymentIntent must not silently adopt the first paymentless session.
        orderIds: ['pi_x', '', 'pi_missing'],
      })
      expect(found.size).toBe(1)
      expect(found.get('pi_x')).toMatchObject({ clientReferenceId: 'user-x' })
      expect(
        await readRevenueMatchHintsByOrder(db, { siteId, provider: 'stripe', orderIds: [] }),
      ).toEqual(new Map())
    })

    it('does not leak a hint across providers', async () => {
      const siteId = await makeSite()
      await recordRevenueMatchHints(db, {
        siteId,
        provider: 'stripe',
        hints: [
          {
            checkoutSessionId: 'cs_p',
            orderId: 'pi_p',
            clientReferenceId: 'user-p',
            customerId: '',
            occurredAt: new Date('2026-07-31T09:00:00.000Z'),
          },
        ],
      })
      const other = await readRevenueMatchHintsByOrder(db, {
        siteId,
        provider: 'paddle',
        orderIds: ['pi_p'],
      })
      expect(other.size).toBe(0)
    })

    it('does not leak a hint across sites', async () => {
      const siteId = await makeSite()
      const sibling = await makeSite()
      await recordRevenueMatchHints(db, {
        siteId,
        provider: 'stripe',
        hints: [
          {
            checkoutSessionId: 'cs_s',
            orderId: 'pi_s',
            clientReferenceId: 'user-s',
            customerId: '',
            occurredAt: new Date('2026-07-31T09:00:00.000Z'),
          },
        ],
      })
      expect(
        (
          await readRevenueMatchHintsByOrder(db, {
            siteId: sibling,
            provider: 'stripe',
            orderIds: ['pi_s'],
          })
        ).size,
      ).toBe(0)
      // Two sites may hold the same session id — the unique index is per site.
      await recordRevenueMatchHints(db, {
        siteId: sibling,
        provider: 'stripe',
        hints: [
          {
            checkoutSessionId: 'cs_s',
            orderId: 'pi_s',
            clientReferenceId: 'user-other',
            customerId: '',
            occurredAt: new Date('2026-07-31T09:00:00.000Z'),
          },
        ],
      })
      expect(await countIn('revenue_match_hints', sibling)).toBe(1)
    })

    it('stores no email column at all', async () => {
      // D-102 as a schema fact rather than a code review note: there is nowhere
      // for one to go.
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'revenue_match_hints'`,
        [schemaName],
      )
      const names = columns.rows.map((row) => row.column_name)
      expect(names.some((name) => /mail/i.test(name))).toBe(false)
    })
  })

  describe('the stuck-delivery sweep (CP2 gap, closed as visibility)', () => {
    it('settles a row past the horizon and leaves a fresh one alone', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)

      const stuck = await recordRevenueProviderEvent(db, {
        siteId,
        credentialId: credential.id,
        provider: 'stripe',
        providerEventId: 'evt_stuck',
        payloadHash: 'h1',
        source: 'webhook',
        now: new Date('2026-07-01T00:00:00.000Z'),
      })
      expect(stuck.status).toBe('received')

      const fresh = await recordRevenueProviderEvent(db, {
        siteId,
        credentialId: credential.id,
        provider: 'stripe',
        providerEventId: 'evt_fresh',
        payloadHash: 'h2',
        source: 'webhook',
        now: new Date('2026-07-31T09:00:00.000Z'),
      })
      expect(fresh.status).toBe('received')

      const swept = await failStuckRevenueDeliveries(db, {
        olderThan: new Date('2026-07-30T00:00:00.000Z'),
        limit: 50,
        now: new Date('2026-07-31T10:00:00.000Z'),
      })
      expect(swept.failed).toBe(1)
      expect(swept.siteIds).toEqual([siteId])

      expect(
        (
          await readRevenueProviderEvent(db, {
            siteId,
            provider: 'stripe',
            providerEventId: 'evt_stuck',
          })
        )?.status,
      ).toBe('failed')
      // Untouched: settling it early would destroy the state that makes the
      // provider's own redelivery reprocess it.
      expect(
        (
          await readRevenueProviderEvent(db, {
            siteId,
            provider: 'stripe',
            providerEventId: 'evt_fresh',
          })
        )?.status,
      ).toBe('received')
    })

    it('categorizes the result as stuck_delivery and names the repair path', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)
      await recordRevenueProviderEvent(db, {
        siteId,
        credentialId: credential.id,
        provider: 'stripe',
        providerEventId: 'evt_cat',
        payloadHash: 'h',
        source: 'webhook',
        now: new Date('2026-07-01T00:00:00.000Z'),
      })
      await failStuckRevenueDeliveries(db, {
        olderThan: new Date('2026-07-30T00:00:00.000Z'),
        limit: 50,
      })

      const row = await pool.query<{ result: Record<string, unknown> }>(
        `SELECT result FROM revenue_provider_events
          WHERE site_id = $1 AND provider_event_id = 'evt_cat'`,
        [siteId],
      )
      expect(row.rows[0]?.result).toMatchObject({
        reason: REVENUE_STUCK_DELIVERY_REASON,
        repair: 'reconcile_sweep',
      })
    })

    it('never touches a settled row', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)
      await recordRevenueProviderEvent(db, {
        siteId,
        credentialId: credential.id,
        provider: 'stripe',
        providerEventId: 'evt_done',
        payloadHash: 'h',
        source: 'backfill',
        now: new Date('2026-07-01T00:00:00.000Z'),
      })
      await pool.query(
        `UPDATE revenue_provider_events SET status = 'processed' WHERE provider_event_id = 'evt_done'`,
      )
      const swept = await failStuckRevenueDeliveries(db, {
        olderThan: new Date('2026-07-30T00:00:00.000Z'),
        limit: 50,
      })
      expect(swept.siteIds).not.toContain(siteId)
      expect(
        (
          await readRevenueProviderEvent(db, {
            siteId,
            provider: 'stripe',
            providerEventId: 'evt_done',
          })
        )?.status,
      ).toBe('processed')
    })

    it('respects its bound', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)
      for (const n of [1, 2, 3]) {
        await recordRevenueProviderEvent(db, {
          siteId,
          credentialId: credential.id,
          provider: 'stripe',
          providerEventId: `evt_bound_${String(n)}`,
          payloadHash: 'h',
          source: 'webhook',
          now: new Date('2026-07-01T00:00:00.000Z'),
        })
      }
      const first = await failStuckRevenueDeliveries(db, {
        olderThan: new Date('2026-07-30T00:00:00.000Z'),
        limit: 2,
      })
      expect(first.failed).toBe(2)
      const second = await failStuckRevenueDeliveries(db, {
        olderThan: new Date('2026-07-30T00:00:00.000Z'),
        limit: 10,
      })
      expect(second.failed).toBeGreaterThanOrEqual(1)
    })
  })

  describe('the projection loop — one bad head must not stall the rest (S3)', () => {
    /** A `RevenueEventsStore` that records what it was handed. */
    const createFakeStore = () => {
      const batches: RevenueEventRow[][] = []
      return {
        batches,
        store: {
          async insertRows(rows: readonly RevenueEventRow[]) {
            if (rows.length === 0) return { token: null }
            batches.push([...rows])
            return { token: revenueEventsToken(rows) }
          },
          async readCurrentRows() {
            return []
          },
          async listOldestOccurrencePerSite() {
            // The projection loop never calls this — it belongs to the 15m
            // re-roll seeding (ADR-0079 step 2) — but the double implements the
            // whole port rather than a cast-away subset, so a real method
            // arriving here is a compile error rather than a runtime undefined.
            return []
          },
          async ping() {
            return true
          },
          async close() {
            /* nothing to close */
          },
        } as RevenueEventsStore,
      }
    }

    const createFakeMetrics = () => {
      const counters: { name: string; labels: Record<string, string> }[] = []
      return {
        counters,
        metrics: {
          increment(name: string, labels: Record<string, string>) {
            counters.push({ name, labels })
          },
          gauge() {
            /* not asserted here */
          },
          observe() {
            /* not asserted here */
          },
        } as unknown as Metrics,
      }
    }

    const identityKey = { keyVersion: 1, secret: 'test-identity-secret-000000000000' }

    it('skips the poisoned site, drains every other one, and leaves the bad head due', async () => {
      // Row building runs `new Date(normalized.occurred_at)` and BigInt
      // arithmetic over the stored amounts, so a malformed snapshot throws
      // BEFORE any insert. Uncaught, that throw escapes the per-tick loop — and
      // because discovery is `ORDER BY site_id LIMIT 25`, the same poisoned site
      // is rediscovered every tick and **every site sorting after it never
      // projects again**. One customer's bad row would freeze an unbounded set
      // of other customers' revenue, permanently and silently.
      const healthyA = await makeSite()
      const healthyB = await makeSite()
      const poisoned = await makeSite()

      await apply(healthyA, 'ch_ok_a', '2026-07-31T10:00:00.000Z')
      await apply(healthyB, 'ch_ok_b', '2026-07-31T10:00:00.000Z')
      await apply(poisoned, 'ch_bad', '2026-07-31T10:00:00.000Z')

      // Corrupt the stored snapshot the way a provider or adapter change could:
      // an `occurred_at` no `Date` can parse. Written straight to the column,
      // because the normalizers would never produce it — which is the point,
      // the loop must survive data it did not write.
      await pool.query(
        `UPDATE revenue_objects
            SET normalized = jsonb_set(normalized, '{occurred_at}', '"not-a-timestamp"')
          WHERE site_id = $1 AND object_id = 'ch_bad'`,
        [poisoned],
      )

      const { logger } = createCapturedLogger()
      const fake = createFakeStore()
      const meters = createFakeMetrics()

      const result = await projectRevenueOnce({
        db,
        logger,
        metrics: meters.metrics,
        store: fake.store,
        identityKey,
        siteLimit: 50,
        batchSize: 100,
      })

      // Both healthy sites drained; only the poisoned one failed.
      expect(result.failed).toBe(1)
      const projected = fake.batches.flat().map((row) => row.object_id)
      expect(projected).toContain('ch_ok_a')
      expect(projected).toContain('ch_ok_b')
      expect(projected).not.toContain('ch_bad')

      expect(await listUnprojectedRevenueObjects(db, { siteId: healthyA, limit: 10 })).toHaveLength(
        0,
      )
      expect(await listUnprojectedRevenueObjects(db, { siteId: healthyB, limit: 10 })).toHaveLength(
        0,
      )
      // Nothing was marked for the poisoned site, so the moment the data or the
      // code is fixed it projects — no backfill needed.
      expect(await listUnprojectedRevenueObjects(db, { siteId: poisoned, limit: 10 })).toHaveLength(
        1,
      )

      // Counted, with the site-level reason, so an operator sees it.
      expect(
        meters.counters.filter(
          (counter) =>
            counter.name === 'worker_revenue_projection_failed' &&
            counter.labels['reason'] === 'site',
        ),
      ).toHaveLength(1)
    })

    it('projects a healthy site end to end, marking only after the insert resolves', async () => {
      const siteId = await makeSite('EUR')
      await pool.query(
        `INSERT INTO currency_rates (rate_date, currency, rate_per_eur)
           VALUES ('2026-07-31', 'USD', 1.0850), ('2026-07-31', 'EUR', 1)
         ON CONFLICT DO NOTHING`,
      )
      await apply(siteId, 'ch_loop', '2026-07-31T10:00:00.000Z')

      const { logger } = createCapturedLogger()
      const fake = createFakeStore()
      const meters = createFakeMetrics()

      const result = await projectRevenueOnce({
        db,
        logger,
        metrics: meters.metrics,
        store: fake.store,
        identityKey,
        siteLimit: 50,
        batchSize: 100,
      })

      expect(result.rows).toBeGreaterThanOrEqual(1)
      const row = fake.batches.flat().find((entry) => entry.object_id === 'ch_loop')
      expect(row).toBeDefined()
      // Lowercase on both currency columns, and the reporting side really was
      // converted rather than passed through.
      expect(row?.currency).toBe('usd')
      expect(row?.reporting_currency).toBe('eur')
      expect(row?.conversion_source).toBe('ecb')
      expect(await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })).toHaveLength(0)
    })

    it('marks nothing when the ClickHouse insert fails, so the head stays due', async () => {
      // The insert-then-mark ordering, from the failing side: a marker never
      // comes back on its own, so it must not move for rows that were not
      // written.
      const siteId = await makeSite()
      await apply(siteId, 'ch_insert_fail', '2026-07-31T10:00:00.000Z')

      const { logger } = createCapturedLogger()
      const meters = createFakeMetrics()
      const failing = {
        async insertRows() {
          throw new Error('ACCESS_DENIED: oa_ingest lacks INSERT on revenue_events')
        },
        async readCurrentRows() {
          return []
        },
        async ping() {
          return true
        },
        async close() {
          /* nothing to close */
        },
      } as unknown as RevenueEventsStore

      const result = await projectRevenueOnce({
        db,
        logger,
        metrics: meters.metrics,
        store: failing,
        identityKey,
        siteLimit: 50,
        batchSize: 100,
      })

      expect(result.failed).toBeGreaterThanOrEqual(1)
      expect(await listUnprojectedRevenueObjects(db, { siteId, limit: 10 })).toHaveLength(1)
    })
  })

  describe('deletion (D8, CP3 amendment)', () => {
    it('snapshots 65 targets including revenue_events and revenue_match_hints', async () => {
      const siteId = await makeSite()
      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      const targets = await listDeletionTargets(db, {
        deletionRequestId: started.deletionRequestId,
      })
      // 65, not 66 (62 + the three subscription lifecycle tables of migration 0047): `billing_transfer_offers` is a target the hosted surface registers (`CLOUD_DELETION_EXTENSION`), so this is the set a build without it erases.
      expect(targets).toHaveLength(65)
      expect(targets).toHaveLength(SITE_DELETION_TARGETS.length)
      expect(targets.filter((t) => t.store === 'clickhouse').map((t) => t.target)).toContain(
        'revenue_events',
      )
      expect(targets.filter((t) => t.store === 'postgres').map((t) => t.target)).toContain(
        'revenue_match_hints',
      )
    })

    it('purges the hints and leaves a sibling site intact', async () => {
      // A name with no purge statement behind it verifies silently at
      // `deleted: 0`, so the per-table effect is asserted, not only the count.
      const siteId = await makeSite()
      const sibling = await makeSite()
      for (const target of [siteId, sibling]) {
        await recordRevenueMatchHints(db, {
          siteId: target,
          provider: 'stripe',
          hints: [
            {
              checkoutSessionId: `cs_${target}`,
              orderId: `pi_${target}`,
              clientReferenceId: 'user',
              customerId: 'cus',
              occurredAt: new Date('2026-07-31T09:00:00.000Z'),
            },
          ],
        })
      }
      expect(await countIn('revenue_match_hints', siteId)).toBe(1)

      await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      const purged = await purgeSitePostgres(db, { siteId })

      expect(purged.deleted['revenue_match_hints']).toBe(1)
      expect(await countIn('revenue_match_hints', siteId)).toBe(0)
      expect(await countIn('revenue_match_hints', sibling)).toBe(1)
    })
  })
})
