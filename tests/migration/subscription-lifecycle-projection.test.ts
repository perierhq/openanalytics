import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import {
  createSubscriptionLifecycleStore,
  migrateClickHouse,
  type SubscriptionLifecycleStore,
} from '@openanalytics/clickhouse'
import {
  revenueSubscriptionHash,
  type RevenueSubscriptionObservation,
  type RevenueSubscriptionSnapshot,
} from '@openanalytics/domain'
import { NOOP_METRICS } from '@openanalytics/observability'
import {
  applyRevenueSubscriptionObservation,
  createDatabase,
  createPool,
  createSiteWithOwner,
  newId,
  readRevenueInvoice,
  readRevenueSubscription,
  recordRevenueInvoiceHints,
  type Database,
} from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { projectLifecycleOnce } from '../../apps/worker/src/revenue/project-lifecycle.ts'
import { applyPostgresStreams } from '../support/postgres-streams.ts'

/**
 * The lifecycle projection end to end (Perier gap 7): Postgres 0047 heads and
 * invoice hints → ClickHouse 0030, against real stores.
 *
 * The property this file exists for is the read rule 0030 states: a
 * re-planned subscription can have FEWER facts than its previous generation,
 * and the stale tail must not be counted. Reading only each subscription's
 * highest generation is what guarantees it, merged parts or not.
 */

const PG = process.env['TEST_POSTGRES_URL']
const CH = process.env['TEST_CLICKHOUSE_URL']
const CH_USER = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const CH_PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''
const describeIfBoth = PG && CH ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

function snapshot(
  overrides: Partial<RevenueSubscriptionSnapshot> = {},
): RevenueSubscriptionSnapshot {
  return {
    status: 'active',
    livemode: true,
    customer_id: 'cus_1',
    currency: 'eur',
    items: [
      {
        price_id: 'price_monthly',
        product_id: 'prod_pro',
        unit_amount_minor: 699,
        quantity: 1,
        interval: 'month',
        interval_count: 1,
      },
    ],
    created_at: '2026-03-01T09:00:00.000Z',
    started_at: '2026-03-01T09:00:00.000Z',
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    ...overrides,
  }
}

describeIfBoth('subscription lifecycle projection (Postgres 0047 → ClickHouse 0030)', () => {
  const schemaName = `sublcp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const database = `sublcp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let ch: ReturnType<typeof createClient>
  let store: SubscriptionLifecycleStore
  let siteId: string

  const project = async () =>
    await projectLifecycleOnce({
      db,
      logger: createCapturedLogger().logger,
      metrics: NOOP_METRICS,
      store,
      identityKey: { secret: 's'.repeat(32), keyVersion: 1 },
    })

  const apply = async (obs: RevenueSubscriptionObservation) =>
    await applyRevenueSubscriptionObservation(db, {
      siteId,
      provider: 'stripe',
      observation: obs,
      payloadHash: revenueSubscriptionHash(obs.normalized),
    })

  /** The 0030 read rule: per subscription, only its highest generation. */
  const currentFacts = async () => {
    const result = await ch.query({
      query: `
        SELECT cur.subscription_id AS subscription_id, cur.seq AS seq, cur.kind AS kind,
               cur.mrr_delta_minor AS mrr_delta_minor, cur.active_delta AS active_delta
          FROM (
            SELECT sl.provider AS provider, sl.subscription_id AS subscription_id, sl.seq AS seq,
                   max(sl.generation) AS generation,
                   argMax(sl.kind, sl.generation) AS kind,
                   argMax(sl.mrr_delta_minor, sl.generation) AS mrr_delta_minor,
                   argMax(sl.active_delta, sl.generation) AS active_delta
              FROM subscription_lifecycle AS sl
             WHERE sl.site_id = {site:UUID}
             GROUP BY sl.provider, sl.subscription_id, sl.seq
          ) AS cur
          INNER JOIN (
            SELECT h.provider AS provider, h.subscription_id AS subscription_id,
                   max(h.generation) AS head_generation
              FROM subscription_lifecycle AS h
             WHERE h.site_id = {site:UUID}
             GROUP BY h.provider, h.subscription_id
          ) AS heads
            ON heads.provider = cur.provider AND heads.subscription_id = cur.subscription_id
         WHERE cur.generation = heads.head_generation
         ORDER BY subscription_id, seq`,
      query_params: { site: siteId },
      format: 'JSONEachRow',
    })
    return (await result.json<Record<string, string | number>>()).map((row) => ({
      subscription_id: row['subscription_id'],
      seq: Number(row['seq']),
      kind: row['kind'],
      mrr_delta_minor: Number(row['mrr_delta_minor']),
      active_delta: Number(row['active_delta']),
    }))
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString: PG as string })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }
    const url = new URL(PG as string)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    const { logger } = createCapturedLogger()
    await applyPostgresStreams({ connectionString: url.toString(), logger })
    pool = createPool(url.toString())
    db = createDatabase(pool)
    const ownerId = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [ownerId, `${ownerId}@example.com`],
    )
    ;({ siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: ownerId,
    }))
    await pool.query(`UPDATE sites SET reporting_currency = 'EUR' WHERE id = $1`, [siteId])

    await migrateClickHouse({
      url: CH as string,
      username: CH_USER,
      password: CH_PASSWORD,
      database,
      directory: MIGRATIONS_DIR,
      logger,
    })
    ch = createClient({ url: CH as string, username: CH_USER, password: CH_PASSWORD, database })
    store = createSubscriptionLifecycleStore({
      url: CH as string,
      username: CH_USER,
      password: CH_PASSWORD,
      database,
    })
  }, 180_000)

  afterAll(async () => {
    await store?.close()
    await ch?.command({ query: `DROP DATABASE IF EXISTS ${database}` })
    await ch?.close()
    await pool?.end()
    const admin = new Client({ connectionString: PG as string })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  it('projects a head, marks it, and drops the stale tail of a shorter re-plan', async () => {
    // Generation 1: a trial that converted — three facts.
    await apply({
      subscriptionId: 'sub_trial',
      snapshotAt: new Date('2026-03-20T00:00:00.000Z'),
      normalized: snapshot({
        trial_start: '2026-03-01T09:00:00.000Z',
        trial_end: '2026-03-15T09:00:00.000Z',
      }),
    })
    const first = await project()
    expect(first).toMatchObject({ lifecycleRows: 3, failed: 0 })
    expect((await currentFacts()).map((f) => f.kind)).toEqual([
      'trial_started',
      'trial_converted',
      'started',
    ])
    const head = await readRevenueSubscription(db, {
      siteId,
      provider: 'stripe',
      subscriptionId: 'sub_trial',
    })
    expect(head?.projectedVersion).toBe(head?.version)

    // Nothing due: a second pass writes nothing.
    expect(await project()).toMatchObject({ sites: 0, lifecycleRows: 0 })

    // Generation 2: the provider now reports no trial at all (one fact). The
    // generation-1 rows at seq 1 and 2 still sit in the table, unmerged.
    await apply({
      subscriptionId: 'sub_trial',
      snapshotAt: new Date('2026-04-01T00:00:00.000Z'),
      normalized: snapshot(),
    })
    expect(await project()).toMatchObject({ lifecycleRows: 1 })
    const facts = await currentFacts()
    expect(facts).toEqual([
      {
        subscription_id: 'sub_trial',
        seq: 0,
        kind: 'started',
        mrr_delta_minor: 699,
        active_delta: 1,
      },
    ])
  })

  it('projects invoice hints with their purchase kind, re-projecting on fill-forward', async () => {
    await recordRevenueInvoiceHints(db, {
      siteId,
      provider: 'stripe',
      hints: [
        {
          invoiceId: 'in_cycle',
          subscriptionId: '',
          billingReason: '',
          orderId: 'pi_cycle',
          chargeId: '',
          customerId: '',
          occurredAt: new Date('2026-04-01T09:00:00.000Z'),
        },
      ],
    })
    await project()
    await recordRevenueInvoiceHints(db, {
      siteId,
      provider: 'stripe',
      hints: [
        {
          invoiceId: 'in_cycle',
          subscriptionId: 'sub_trial',
          billingReason: 'subscription_cycle',
          orderId: '',
          chargeId: '',
          customerId: 'cus_1',
          occurredAt: new Date('2026-04-01T09:00:00.000Z'),
        },
      ],
    })
    await project()
    const row = await readRevenueInvoice(db, { siteId, provider: 'stripe', invoiceId: 'in_cycle' })
    expect(row?.projectedVersion).toBe(2)

    const result = await ch.query({
      query: `SELECT argMax(si.purchase_kind, si.generation) AS kind,
                     argMax(si.order_id, si.generation) AS order_id,
                     max(si.generation) AS generation
                FROM subscription_invoices AS si
               WHERE si.site_id = {site:UUID} AND si.invoice_id = 'in_cycle'`,
      query_params: { site: siteId },
      format: 'JSONEachRow',
    })
    expect(await result.json()).toEqual([{ kind: 'renewal', order_id: 'pi_cycle', generation: 2 }])
  })
})
