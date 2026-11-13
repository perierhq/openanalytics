import {
  revenueSubscriptionHash,
  type RevenueSubscriptionObservation,
  type RevenueSubscriptionSnapshot,
} from '@openanalytics/domain'
import {
  applyRevenueSubscriptionObservation,
  createDatabase,
  createPool,
  createRevenueCredential,
  createSiteWithOwner,
  listSitesWithUnprojectedLifecycle,
  listUnprojectedRevenueInvoices,
  listUnprojectedRevenueSubscriptions,
  markRevenueInvoicesProjected,
  markRevenueSubscriptionsProjected,
  mintWebhookToken,
  newId,
  purgeSitePostgres,
  readRevenueInvoice,
  readRevenueSubscription,
  readRevenueSubscriptionChanges,
  readRevenueSyncState,
  recordRevenueInvoiceHints,
  recordRevenueSubscriptionChanges,
  saveRevenueSyncState,
  startSiteDeletion,
  type Database,
} from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyPostgresStreams } from '../support/postgres-streams.ts'

/**
 * Migration 0047 (Perier gap 7): subscription heads, their changes, invoice
 * hints and the widened sync-state resource check, against a real Postgres.
 *
 * What is proven, and why each matters:
 *
 * 1. A subscription head follows the money head's three-way decision — newer
 *    applies, older skips, an equal-time differing payload asks for a re-fetch.
 * 2. A change is recorded once per (event, kind), and a NEW change re-queues its
 *    head; a redelivered one does not.
 * 3. An invoice hint fills forward across `invoice.paid` and
 *    `invoice_payment.paid`, and its version moves only when the merged row
 *    differs — so a redelivery writes no new ClickHouse generation.
 * 4. The sync state accepts the two lifecycle resources.
 * 5. All three tables are purged with the site, and a sibling keeps its rows.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const cipher = (label: string): string =>
  `k1.AAAAAAAAAAAAAAAA.${Buffer.from(label).toString('base64')}`

function snapshot(
  overrides: Partial<RevenueSubscriptionSnapshot> = {},
): RevenueSubscriptionSnapshot {
  return {
    status: 'active',
    livemode: false,
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

function observation(
  subscriptionId: string,
  at: string,
  overrides: Partial<RevenueSubscriptionSnapshot> = {},
): RevenueSubscriptionObservation {
  return { subscriptionId, snapshotAt: new Date(at), normalized: snapshot(overrides) }
}

describeIfPostgres('revenue subscription lifecycle (migration 0047)', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `sublc_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
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

  const apply = async (siteId: string, obs: RevenueSubscriptionObservation, force = false) =>
    await applyRevenueSubscriptionObservation(db, {
      siteId,
      provider: 'stripe',
      observation: obs,
      payloadHash: revenueSubscriptionHash(obs.normalized),
      ...(force ? { force: true } : {}),
    })

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

  describe('subscription heads', () => {
    it('applies, skips an older snapshot and asks for a re-fetch on a tie', async () => {
      const siteId = await makeSite()
      const first = await apply(siteId, observation('sub_a', '2026-03-01T09:00:00.000Z'))
      expect(first.decision).toMatchObject({ action: 'apply', version: 1 })

      const newer = await apply(
        siteId,
        observation('sub_a', '2026-04-01T09:00:00.000Z', { cancel_at_period_end: true }),
      )
      expect(newer.decision).toMatchObject({ action: 'apply', version: 2 })

      const older = await apply(siteId, observation('sub_a', '2026-03-15T09:00:00.000Z'))
      expect(older.decision.action).toBe('skip')

      const tie = await apply(
        siteId,
        observation('sub_a', '2026-04-01T09:00:00.000Z', { status: 'past_due' }),
      )
      expect(tie.decision.action).toBe('refetch_from_provider')
      const forced = await apply(
        siteId,
        observation('sub_a', '2026-04-01T09:00:00.000Z', { status: 'past_due' }),
        true,
      )
      expect(forced.decision).toMatchObject({ action: 'apply', version: 3 })

      const head = await readRevenueSubscription(db, {
        siteId,
        provider: 'stripe',
        subscriptionId: 'sub_a',
      })
      expect(head?.normalized.status).toBe('past_due')
      expect(head?.version).toBe(3)
      expect(head?.projectedVersion).toBe(0)
    })
  })

  describe('subscription changes', () => {
    it('records a change once and re-queues its head only when it is new', async () => {
      const siteId = await makeSite()
      await apply(siteId, observation('sub_b', '2026-03-01T09:00:00.000Z'))
      const [head] = await listUnprojectedRevenueSubscriptions(db, { siteId, limit: 10 })
      await markRevenueSubscriptionsProjected(db, {
        marks: [{ id: head!.id, version: head!.version }],
      })
      expect(await listUnprojectedRevenueSubscriptions(db, { siteId, limit: 10 })).toHaveLength(0)

      const change = {
        subscriptionId: 'sub_b',
        providerEventId: 'evt_plan',
        kind: 'plan_changed' as const,
        occurredAt: new Date('2026-05-01T00:00:00.000Z'),
        fromMrrMinor: 699,
        toMrrMinor: 333,
      }
      expect(
        await recordRevenueSubscriptionChanges(db, {
          siteId,
          provider: 'stripe',
          changes: [
            change,
            { ...change, kind: 'cancel_scheduled', fromMrrMinor: 0, toMrrMinor: 0 },
          ],
        }),
      ).toEqual({ inserted: 2 })
      const due = await listUnprojectedRevenueSubscriptions(db, { siteId, limit: 10 })
      expect(due).toHaveLength(1)
      expect(due[0]?.version).toBe(2)

      // A redelivery inserts nothing and bumps nothing.
      expect(
        await recordRevenueSubscriptionChanges(db, {
          siteId,
          provider: 'stripe',
          changes: [change],
        }),
      ).toEqual({ inserted: 0 })
      const after = await readRevenueSubscription(db, {
        siteId,
        provider: 'stripe',
        subscriptionId: 'sub_b',
      })
      expect(after?.version).toBe(2)

      const changes = await readRevenueSubscriptionChanges(db, {
        siteId,
        provider: 'stripe',
        subscriptionIds: ['sub_b'],
      })
      expect(changes.get('sub_b')?.map((c) => c.kind)).toEqual(['cancel_scheduled', 'plan_changed'])
    })

    it('refuses an unknown change kind at the schema', async () => {
      const siteId = await makeSite()
      await expect(
        pool.query(
          `INSERT INTO revenue_subscription_changes
             (id, site_id, provider, subscription_id, provider_event_id, kind, occurred_at)
           VALUES ($1, $2, 'stripe', 'sub', 'evt', 'started', now())`,
          [newId(), siteId],
        ),
      ).rejects.toThrow(/revenue_subscription_changes_kind_check/u)
    })
  })

  describe('invoice hints', () => {
    it('fills forward across invoice.paid and invoice_payment.paid', async () => {
      const siteId = await makeSite()
      const paidAt = new Date('2026-03-01T09:00:05.000Z')
      await recordRevenueInvoiceHints(db, {
        siteId,
        provider: 'stripe',
        hints: [
          {
            invoiceId: 'in_1',
            subscriptionId: 'sub_1',
            billingReason: 'subscription_create',
            orderId: '',
            chargeId: '',
            customerId: 'cus_1',
            occurredAt: paidAt,
          },
        ],
      })
      const second = await recordRevenueInvoiceHints(db, {
        siteId,
        provider: 'stripe',
        hints: [
          {
            invoiceId: 'in_1',
            subscriptionId: '',
            billingReason: '',
            orderId: 'pi_1',
            chargeId: '',
            customerId: '',
            occurredAt: new Date('2026-03-01T09:00:07.000Z'),
          },
        ],
      })
      expect(second.written).toBe(1)
      const row = await readRevenueInvoice(db, { siteId, provider: 'stripe', invoiceId: 'in_1' })
      expect(row).toMatchObject({
        subscriptionId: 'sub_1',
        billingReason: 'subscription_create',
        orderId: 'pi_1',
        customerId: 'cus_1',
        version: 2,
      })
      // The earlier paid instant is kept.
      expect(row?.occurredAt.toISOString()).toBe(paidAt.toISOString())
    })

    it('does not move the version for a redelivery that changes nothing', async () => {
      const siteId = await makeSite()
      const hint = {
        invoiceId: 'in_2',
        subscriptionId: 'sub_2',
        billingReason: 'subscription_cycle',
        orderId: 'pi_2',
        chargeId: 'ch_2',
        customerId: 'cus_2',
        occurredAt: new Date('2026-04-01T00:00:00.000Z'),
      }
      await recordRevenueInvoiceHints(db, { siteId, provider: 'stripe', hints: [hint] })
      const [due] = await listUnprojectedRevenueInvoices(db, { siteId, limit: 10 })
      await markRevenueInvoicesProjected(db, { marks: [{ id: due!.id, version: due!.version }] })

      const again = await recordRevenueInvoiceHints(db, {
        siteId,
        provider: 'stripe',
        // An emptier redelivery: fill-forward keeps every stored value.
        hints: [{ ...hint, orderId: '', chargeId: '' }, hint],
      })
      expect(again.written).toBe(0)
      expect(await listUnprojectedRevenueInvoices(db, { siteId, limit: 10 })).toHaveLength(0)
      expect(await listSitesWithUnprojectedLifecycle(db, { limit: 1000 })).not.toContain(siteId)
    })
  })

  describe('sync state', () => {
    it('accepts the subscriptions and invoices resources', async () => {
      const siteId = await makeSite()
      const created = await createRevenueCredential(db, {
        id: newId(),
        siteId,
        provider: 'stripe',
        encryptedApiKey: cipher('api'),
        encryptedWebhookSecret: cipher('whsec'),
        keyVersion: 'k1',
        apiKeyLast4: '1234',
        webhookToken: mintWebhookToken(),
        createdByUserId: ownerId,
      })
      if (!created.ok) throw new Error('setup failed')
      for (const resource of ['subscriptions', 'invoices'] as const) {
        await saveRevenueSyncState(db, {
          credentialId: created.credential.id,
          siteId,
          resource,
          cursor: 'x_1',
          windowStart: new Date(0),
          windowEnd: new Date('2026-06-01T00:00:00.000Z'),
          completedAt: null,
        })
        const state = await readRevenueSyncState(db, {
          credentialId: created.credential.id,
          resource,
        })
        expect(state?.cursor).toBe('x_1')
      }
      await expect(
        pool.query(
          `INSERT INTO revenue_sync_state (id, credential_id, site_id, resource)
           VALUES ($1, $2, $3, 'payouts')`,
          [newId(), created.credential.id, siteId],
        ),
      ).rejects.toThrow(/revenue_sync_state_resource_check/u)
    })
  })

  describe('deletion', () => {
    it('purges all three tables and leaves a sibling site intact', async () => {
      const siteId = await makeSite()
      const sibling = await makeSite()
      for (const target of [siteId, sibling]) {
        await apply(target, observation('sub_del', '2026-03-01T09:00:00.000Z'))
        await recordRevenueSubscriptionChanges(db, {
          siteId: target,
          provider: 'stripe',
          changes: [
            {
              subscriptionId: 'sub_del',
              providerEventId: 'evt_del',
              kind: 'cancel_scheduled',
              occurredAt: new Date('2026-03-02T00:00:00.000Z'),
              fromMrrMinor: 0,
              toMrrMinor: 0,
            },
          ],
        })
        await recordRevenueInvoiceHints(db, {
          siteId: target,
          provider: 'stripe',
          hints: [
            {
              invoiceId: 'in_del',
              subscriptionId: 'sub_del',
              billingReason: 'subscription_create',
              orderId: 'pi_del',
              chargeId: '',
              customerId: 'cus',
              occurredAt: new Date('2026-03-01T09:00:00.000Z'),
            },
          ],
        })
      }

      await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
      const purged = await purgeSitePostgres(db, { siteId })
      for (const table of [
        'revenue_subscriptions',
        'revenue_subscription_changes',
        'revenue_invoices',
      ]) {
        expect(purged.deleted[table]).toBe(1)
        expect(await countIn(table, siteId)).toBe(0)
        expect(await countIn(table, sibling)).toBe(1)
      }
    })
  })
})
