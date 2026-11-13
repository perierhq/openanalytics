import {
  SITE_DELETION_TARGETS,
  revenueObservationHash,
  type RevenueNormalizedObject,
  type RevenueObservation,
} from '@openanalytics/domain'
import {
  advanceRevenueAttributionWatermark,
  applyRevenueObservation,
  claimRevenueAttributionSite,
  createDatabase,
  createPool,
  createSiteWithOwner,
  getRevenueAttributionState,
  listDeletionTargets,
  listSitesForRevenueAttribution,
  newId,
  purgeSitePostgres,
  readOldestChangedRevenueChargeOccurrence,
  readOldestRevenueAttributionWatermark,
  recordRevenueMatchHints,
  releaseRevenueAttributionSite,
  startSiteDeletion,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The attribution job's control state against a real Postgres (ADR-0033, D6/D8;
 * migration 0036). Milestone 12 CP4.
 *
 * Five things, each a *database* fact the application cannot compensate for:
 *
 * 1. **The lease is exclusive.** Two workers racing on one site cannot both come
 *    out holding it — the loser's `ON CONFLICT` predicate matches nothing. This
 *    is the whole mutual-exclusion mechanism; the planner's purity is the second
 *    line of defence, not the only one.
 * 2. **An expired lease is reclaimable**, or a worker that died mid-run would
 *    pin a site forever.
 * 3. **The watermark is monotonic**, enforced with `GREATEST` in the statement
 *    rather than in the caller, and **only the lease holder may advance** — a
 *    run whose lease was stolen must not clobber the newer holder's state.
 * 4. **Discovery finds what it must and goes quiet when it should**: a new
 *    charge head, a new hint, and a stale watermark each pull a site in; a site
 *    whose watermark is fresh and whose inputs have not moved is left alone.
 * 5. **The row is purged with the site** and the count moved to 55 (CP5 then took it to 57). A
 *    vocabulary name with no purge statement behind it verifies silently at
 *    `deleted: 0`, so the per-table effect is asserted, not only the count.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

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

describeIfPostgres('revenue attribution state', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m12attr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
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

  const applyCharge = async (
    siteId: string,
    objectId: string,
    at: string,
    occurredAt = at,
  ): Promise<void> => {
    const observation: RevenueObservation = {
      objectId,
      objectKind: 'charge',
      snapshotAt: new Date(at),
      normalized: normalized({ occurred_at: occurredAt }),
    }
    await applyRevenueObservation(db, {
      siteId,
      provider: 'stripe',
      observation,
      payloadHash: revenueObservationHash(observation.normalized),
    })
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

  describe('the lease', () => {
    it('creates the row on first claim, at the epoch watermark', async () => {
      const siteId = await makeSite()
      const claim = await claimRevenueAttributionSite(db, {
        siteId,
        claimedBy: 'w1',
        leaseTtlMs: 60_000,
      })

      expect(claim).not.toBeNull()
      // Epoch, which is what makes a fresh site's first horizon cover its whole
      // history including a backfill that predates the job.
      expect(claim?.computedThrough.getTime()).toBe(0)
      expect(claim?.runSeq).toBe(0)
    })

    it('refuses a second worker while the lease is live', async () => {
      const siteId = await makeSite()
      const first = await claimRevenueAttributionSite(db, {
        siteId,
        claimedBy: 'w1',
        leaseTtlMs: 60_000,
      })
      const second = await claimRevenueAttributionSite(db, {
        siteId,
        claimedBy: 'w2',
        leaseTtlMs: 60_000,
      })

      expect(first).not.toBeNull()
      expect(second).toBeNull()
    })

    it('lets the same worker re-claim, so a retried tick is not deadlocked by itself', async () => {
      const siteId = await makeSite()
      await claimRevenueAttributionSite(db, { siteId, claimedBy: 'w1', leaseTtlMs: 60_000 })
      const again = await claimRevenueAttributionSite(db, {
        siteId,
        claimedBy: 'w1',
        leaseTtlMs: 60_000,
      })
      expect(again).not.toBeNull()
    })

    it('reclaims an expired lease, so a dead worker cannot pin a site forever', async () => {
      const siteId = await makeSite()
      // A lease that expired a minute ago.
      await claimRevenueAttributionSite(db, {
        siteId,
        claimedBy: 'w1',
        leaseTtlMs: -60_000,
      })
      const reclaimed = await claimRevenueAttributionSite(db, {
        siteId,
        claimedBy: 'w2',
        leaseTtlMs: 60_000,
      })
      expect(reclaimed).not.toBeNull()
    })

    it('releases without advancing, which is what a failed run does', async () => {
      const siteId = await makeSite()
      await claimRevenueAttributionSite(db, { siteId, claimedBy: 'w1', leaseTtlMs: 60_000 })
      await releaseRevenueAttributionSite(db, { siteId, claimedBy: 'w1' })

      const state = await getRevenueAttributionState(db, siteId)
      expect(state?.claimedBy).toBeNull()
      // Unmoved: the next pass retries the identical horizon.
      expect(state?.computedThrough.getTime()).toBe(0)
      expect(state?.runSeq).toBe(0)

      // And the site is immediately claimable by anybody.
      const next = await claimRevenueAttributionSite(db, {
        siteId,
        claimedBy: 'w2',
        leaseTtlMs: 60_000,
      })
      expect(next).not.toBeNull()
    })

    it('holds the lease constraint: a claimed row names its holder and an expiry', async () => {
      const siteId = await makeSite()
      await claimRevenueAttributionSite(db, { siteId, claimedBy: 'w1', leaseTtlMs: 60_000 })
      // Half-releasing must be impossible, or the reclaim predicate would read a
      // half-released lease as live forever.
      await expect(
        pool.query(`UPDATE revenue_attribution_state SET claimed_by = NULL WHERE site_id = $1`, [
          siteId,
        ]),
      ).rejects.toThrow(/revenue_attribution_state_lease_check/)
    })
  })

  describe('the watermark', () => {
    it('advances, counts the run and clears the lease', async () => {
      const siteId = await makeSite()
      await claimRevenueAttributionSite(db, { siteId, claimedBy: 'w1', leaseTtlMs: 60_000 })
      const at = new Date('2026-07-31T09:00:00.000Z')
      await advanceRevenueAttributionWatermark(db, {
        siteId,
        claimedBy: 'w1',
        computedThrough: at,
      })

      const state = await getRevenueAttributionState(db, siteId)
      expect(state?.computedThrough.getTime()).toBe(at.getTime())
      expect(state?.runSeq).toBe(1)
      expect(state?.claimedBy).toBeNull()
      expect(state?.lastRunAt).not.toBeNull()
    })

    it('never moves backwards, even when a caller regresses', async () => {
      const siteId = await makeSite()
      const forward = new Date('2026-07-31T09:00:00.000Z')
      await claimRevenueAttributionSite(db, { siteId, claimedBy: 'w1', leaseTtlMs: 60_000 })
      await advanceRevenueAttributionWatermark(db, {
        siteId,
        claimedBy: 'w1',
        computedThrough: forward,
      })

      await claimRevenueAttributionSite(db, { siteId, claimedBy: 'w1', leaseTtlMs: 60_000 })
      await advanceRevenueAttributionWatermark(db, {
        siteId,
        claimedBy: 'w1',
        computedThrough: new Date('2026-07-01T00:00:00.000Z'),
      })

      const state = await getRevenueAttributionState(db, siteId)
      // `GREATEST` in the statement, not a guard in the caller.
      expect(state?.computedThrough.getTime()).toBe(forward.getTime())
      expect(state?.runSeq).toBe(2)
    })

    it('refuses an advance from a worker that no longer holds the lease', async () => {
      const siteId = await makeSite()
      await claimRevenueAttributionSite(db, { siteId, claimedBy: 'w1', leaseTtlMs: -60_000 })
      // w2 stole the expired lease while w1 was still running.
      await claimRevenueAttributionSite(db, { siteId, claimedBy: 'w2', leaseTtlMs: 60_000 })

      await advanceRevenueAttributionWatermark(db, {
        siteId,
        claimedBy: 'w1',
        computedThrough: new Date('2026-07-31T09:00:00.000Z'),
      })

      const state = await getRevenueAttributionState(db, siteId)
      expect(state?.computedThrough.getTime()).toBe(0)
      expect(state?.claimedBy).toBe('w2')
    })

    it('reports the oldest watermark for the lag gauge, and null when there is none', async () => {
      const before = await readOldestRevenueAttributionWatermark(db)
      // Rows already exist from the tests above, so the only assertion that
      // holds unconditionally is that it is a real instant.
      expect(before === null || before instanceof Date).toBe(true)

      const siteId = await makeSite()
      await claimRevenueAttributionSite(db, { siteId, claimedBy: 'w1', leaseTtlMs: 60_000 })
      const oldest = await readOldestRevenueAttributionWatermark(db)
      // A freshly created row sits at the epoch, which is the oldest possible.
      expect(oldest?.getTime()).toBe(0)
    })
  })

  describe('discovery', () => {
    it('returns a site with a charge head and no state row at all', async () => {
      const siteId = await makeSite()
      await applyCharge(siteId, `ch_${newId()}`, '2026-07-31T10:00:00.000Z')

      const sites = await listSitesForRevenueAttribution(db, {
        staleBefore: new Date('2026-07-31T08:45:00.000Z'),
        limit: 100,
      })
      expect(sites).toContain(siteId)
    })

    it('goes quiet once the watermark is past the head and inside the refresh interval', async () => {
      // **Every instant here is relative to the run's own clock**, and that is a
      // correction rather than a style. This case used to pin
      // `computed_through` to the literal `2026-08-01T00:00:00Z` while
      // `applyRevenueObservation` stamps `revenue_objects.updated_at` with
      // `now()`. The two agree only while that literal is in the future, so the
      // assertion became false the moment the calendar reached 2026-08-01 —
      // clause 2 (`updated_at > computed_through`) fired and the site was, quite
      // correctly, no longer quiet. A date-shaped time bomb, not a defect in the
      // predicate, and it is anchored to `now` so it cannot be one again.
      const siteId = await makeSite()
      await applyCharge(siteId, `ch_${newId()}`, '2026-07-31T10:00:00.000Z')
      await claimRevenueAttributionSite(db, { siteId, claimedBy: 'w1', leaseTtlMs: 60_000 })

      const anchor = Date.now()
      await advanceRevenueAttributionWatermark(db, {
        siteId,
        claimedBy: 'w1',
        // Strictly after the head's own `updated_at`, which is what "the
        // watermark is past the head" means.
        computedThrough: new Date(anchor + 60_000),
      })

      const quiet = await listSitesForRevenueAttribution(db, {
        staleBefore: new Date(anchor - 15 * 60_000),
        limit: 100,
      })
      expect(quiet).not.toContain(siteId)

      // ...until the refresh interval elapses, which is the ONLY way a late
      // conversion event or a late-finalized session is ever noticed, both
      // living in ClickHouse where a Postgres query cannot see them.
      const stale = await listSitesForRevenueAttribution(db, {
        staleBefore: new Date(anchor + 60 * 60_000),
        limit: 100,
      })
      expect(stale).toContain(siteId)
    })

    it('returns a site whose checkout hint landed after its watermark', async () => {
      // Clock-relative for the reason the case above records.
      const siteId = await makeSite()
      await applyCharge(siteId, `ch_${newId()}`, '2026-07-31T10:00:00.000Z')
      await claimRevenueAttributionSite(db, { siteId, claimedBy: 'w1', leaseTtlMs: 60_000 })

      const anchor = Date.now()
      await advanceRevenueAttributionWatermark(db, {
        siteId,
        claimedBy: 'w1',
        computedThrough: new Date(anchor + 60_000),
      })
      expect(
        await listSitesForRevenueAttribution(db, {
          staleBefore: new Date(anchor - 15 * 60_000),
          limit: 100,
        }),
      ).not.toContain(siteId)

      // `checkout.session.completed` arrives late and nothing on the charge side
      // moves when it does — this clause is what makes it matchable.
      await recordRevenueMatchHints(db, {
        siteId,
        provider: 'stripe',
        hints: [
          {
            checkoutSessionId: `cs_${newId()}`,
            orderId: 'pi_1',
            clientReferenceId: 'u-77',
            customerId: 'cus_1',
            occurredAt: new Date('2026-07-31T10:00:00.000Z'),
          },
        ],
        // After the watermark, so the hint clause is what returns the site.
        now: new Date(anchor + 120_000),
      })

      expect(
        await listSitesForRevenueAttribution(db, {
          staleBefore: new Date(anchor - 15 * 60_000),
          limit: 100,
        }),
      ).toContain(siteId)
    })
  })

  describe('the horizon escape hatch', () => {
    it('reports the oldest occurrence among charge heads changed since the watermark', async () => {
      const siteId = await makeSite()
      // A backfill landing now, carrying charges from months ago.
      await applyCharge(
        siteId,
        `ch_${newId()}`,
        '2026-08-01T00:00:00.000Z',
        '2026-05-02T10:00:00.000Z',
      )
      await applyCharge(
        siteId,
        `ch_${newId()}`,
        '2026-08-01T00:00:00.000Z',
        '2026-06-02T10:00:00.000Z',
      )

      const oldest = await readOldestChangedRevenueChargeOccurrence(db, {
        siteId,
        changedAfter: new Date('2026-07-01T00:00:00.000Z'),
      })
      // The OCCURRENCE, read out of the normalized snapshot — not `snapshot_at`,
      // which is when the observation was taken. The horizon has to be anchored
      // on the value the fact is partitioned and queried by.
      expect(oldest?.toISOString()).toBe('2026-05-02T10:00:00.000Z')
    })

    it('is null when nothing changed since the watermark', async () => {
      const siteId = await makeSite()
      await applyCharge(siteId, `ch_${newId()}`, '2026-07-31T10:00:00.000Z')

      const oldest = await readOldestChangedRevenueChargeOccurrence(db, {
        siteId,
        changedAfter: new Date('2027-01-01T00:00:00.000Z'),
      })
      expect(oldest).toBeNull()
    })
  })

  describe('deletion (D8)', () => {
    it('snapshots 67 targets including `revenue_attribution_state`', () => {
      const names = SITE_DELETION_TARGETS.map((target) => `${target.store}:${target.target}`)
      expect(names).toContain('postgres:revenue_attribution_state')
      expect(names).toContain('clickhouse:revenue_attributions')
      expect(SITE_DELETION_TARGETS).toHaveLength(67)
    })

    it('purges the control row with the site and leaves another site alone', async () => {
      const doomed = await makeSite()
      const survivor = await makeSite()
      for (const siteId of [doomed, survivor]) {
        await claimRevenueAttributionSite(db, { siteId, claimedBy: 'w1', leaseTtlMs: 60_000 })
        await releaseRevenueAttributionSite(db, { siteId, claimedBy: 'w1' })
      }
      expect(await getRevenueAttributionState(db, doomed)).not.toBeNull()

      const started = await startSiteDeletion(db, { siteId: doomed, requestedByUserId: ownerId })
      const targets = await listDeletionTargets(db, {
        deletionRequestId: started.deletionRequestId,
      })
      // 67, not 68 (62 + the three subscription lifecycle tables of Postgres 0047 and the two of ClickHouse 0030): `billing_transfer_offers` is a target the hosted surface registers (`CLOUD_DELETION_EXTENSION`), so this is the set a build without it erases.
      expect(targets).toHaveLength(67)

      const result = await purgeSitePostgres(db, { siteId: doomed })

      // The per-table effect, not only the count: a name with no purge statement
      // behind it verifies silently at `deleted: 0`, which is the failure mode
      // D8 warns about.
      expect(result.deleted['revenue_attribution_state']).toBe(1)
      expect(await getRevenueAttributionState(db, doomed)).toBeNull()
      expect(await getRevenueAttributionState(db, survivor)).not.toBeNull()
    })
  })
})
