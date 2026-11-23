import {
  createDatabase,
  createPool,
  createSiteWithOwner,
  deleteMetaAdsConnection,
  listCurrencyRatesBetween,
  listDueMetaAdsConnections,
  listMetaAdsSpend,
  newId,
  purgeSitePostgres,
  readMetaAdsConnection,
  recordMetaAdsSync,
  saveMetaAdsConnection,
  startSiteDeletion,
  upsertCurrencyRates,
  upsertMetaAdsSpend,
  type Database,
} from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyPostgresStreams } from '../support/postgres-streams.ts'

/**
 * Migration 0052 (Meta Ads) against a real Postgres.
 *
 * 1. Connect, reconnect to the same account (spend and first-sync state kept)
 *    and to another account (spend dropped, first sync again).
 * 2. The due list: active connections on active sites, soonest first.
 * 3. A sync's outcome; `unauthorized` stops polling; an outcome from before a
 *    reconnect is not recorded.
 * 4. Spend upserts overwrite restated days; the range read is inclusive.
 * 5. Disconnect drops the token and the spend; the audit carries neither.
 * 6. Site deletion drops the token at start and the purge counts the rest.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const spend = (
  campaignId: string,
  day: string,
  spendMinor: number,
  campaignName = `C${campaignId}`,
) => ({
  campaignId,
  campaignName,
  day,
  spendMinor,
  currency: 'USD',
})

describeIfPostgres('meta ads (migration 0052)', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `meta_ads_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let scoped: string
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

  const save = (siteId: string, adAccountId = 'act_100', now?: Date) =>
    saveMetaAdsConnection(db, {
      siteId,
      adAccountId,
      adAccountName: 'Acme Ads',
      currency: 'USD',
      accountStatus: 1,
      encryptedToken: 'k1.bm9uY2U=.Y2lwaGVydGV4dA==',
      keyVersion: 'k1',
      tokenLast4: 'abcd',
      actorUserId: ownerId,
      ...(now ? { now } : {}),
    })

  const connect = async (siteId: string, adAccountId = 'act_100', now?: Date) => {
    const saved = await save(siteId, adAccountId, now)
    if (!saved.ok) throw new Error(`connect refused: ${saved.conflict}`)
    return saved
  }

  /** The spend a sync of the site's current connection writes. */
  const writeSpend = async (siteId: string, rows: ReturnType<typeof spend>[]) => {
    const current = await readMetaAdsConnection(db, siteId)
    if (current === null) throw new Error('no connection')
    return await upsertMetaAdsSpend(db, {
      siteId,
      connectedAt: current.connectedAt,
      adAccountId: current.adAccountId,
      rows,
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
    scoped = url.toString()
    const { logger } = createCapturedLogger()
    await applyPostgresStreams({ connectionString: scoped, logger })
    pool = createPool(scoped)
    db = createDatabase(pool)
    ownerId = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'Olga', $2, true)`,
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

  it('connects, audits without identifiers, and reconnects keeping or dropping spend', async () => {
    const siteId = await makeSite()
    const first = await connect(siteId)
    expect(first.accountChanged).toBe(false)
    expect(first.connection).toMatchObject({
      siteId,
      adAccountId: 'act_100',
      adAccountName: 'Acme Ads',
      currency: 'USD',
      status: 'active',
      lastSyncedAt: null,
      lastError: null,
      tokenLast4: 'abcd',
    })

    await writeSpend(siteId, [spend('1', '2026-11-20', 100)])
    const syncedAt = new Date('2026-11-21T00:00:00.000Z')
    await recordMetaAdsSync(db, {
      siteId,
      connectedAt: first.connection.connectedAt,
      at: syncedAt,
      error: null,
      completed: true,
      nextSyncAt: new Date('2026-11-21T06:00:00.000Z'),
    })

    // Same account, new token: spend and the first-sync marker stay.
    const same = await connect(siteId)
    expect(same.accountChanged).toBe(false)
    expect(same.connection.lastSyncedAt?.toISOString()).toBe(syncedAt.toISOString())
    expect(await countIn('meta_ads_daily_spend', siteId)).toBe(1)

    // Another account: the old spend goes and the next sync is a first sync.
    const other = await connect(siteId, 'act_200')
    expect(other.accountChanged).toBe(true)
    expect(other.connection.lastSyncedAt).toBeNull()
    expect(await countIn('meta_ads_daily_spend', siteId)).toBe(0)

    const audit = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_logs WHERE site_id = $1 AND action LIKE 'site.meta_ads.%' ORDER BY occurred_at, id`,
      [siteId],
    )
    expect(audit.rows.map((r) => r.action)).toEqual([
      'site.meta_ads.connected',
      'site.meta_ads.reconnected',
      'site.meta_ads.reconnected',
    ])
    const text = JSON.stringify(audit.rows)
    expect(text).not.toContain('act_')
    expect(text).not.toContain('Y2lwaGVydGV4dA')
  })

  it('lists due active connections on active sites, soonest first', async () => {
    const early = await makeSite()
    const late = await makeSite()
    const notDue = await makeSite()
    const refused = await makeSite()
    const t0 = new Date('2030-01-01T00:00:00.000Z')
    const a = await connect(early, 'act_1', new Date(t0.getTime() - 2 * 3_600_000))
    await connect(late, 'act_2', new Date(t0.getTime() - 3_600_000))
    const c = await connect(notDue, 'act_3', t0)
    await recordMetaAdsSync(db, {
      siteId: notDue,
      connectedAt: c.connection.connectedAt,
      at: t0,
      error: null,
      completed: true,
      nextSyncAt: new Date(t0.getTime() + 6 * 3_600_000),
    })
    const d = await connect(refused, 'act_4', new Date(t0.getTime() - 5 * 3_600_000))
    await recordMetaAdsSync(db, {
      siteId: refused,
      connectedAt: d.connection.connectedAt,
      at: t0,
      error: 'unauthorized',
      completed: false,
      nextSyncAt: t0,
    })

    const due = await listDueMetaAdsConnections(db, { now: t0, limit: 100 })
    const ours = due
      .map((row) => row.siteId)
      .filter((id) => [early, late, notDue, refused].includes(id))
    expect(ours).toEqual([early, late])
    expect(a.connection.status).toBe('active')
    expect((await readMetaAdsConnection(db, refused))?.status).toBe('needs_reconnect')
    expect((await readMetaAdsConnection(db, refused))?.lastError).toBe('unauthorized')
  })

  it('does not record a sync made before a reconnect', async () => {
    const siteId = await makeSite()
    const before = await connect(siteId, 'act_7', new Date('2026-11-01T00:00:00.000Z'))
    await connect(siteId, 'act_7', new Date('2026-11-01T01:00:00.000Z'))
    const recorded = await recordMetaAdsSync(db, {
      siteId,
      connectedAt: before.connection.connectedAt,
      at: new Date('2026-11-01T02:00:00.000Z'),
      error: 'unauthorized',
      completed: false,
      nextSyncAt: new Date('2026-11-01T02:00:00.000Z'),
    })
    expect(recorded).toBe(false)
    expect((await readMetaAdsConnection(db, siteId))?.status).toBe('active')
  })

  it('overwrites restated days and reads an inclusive day range', async () => {
    const siteId = await makeSite()
    await connect(siteId)
    await writeSpend(siteId, [
      spend('1', '2026-11-18', 100),
      spend('1', '2026-11-19', 200),
      spend('2', '2026-11-20', 300),
    ])
    const written = await writeSpend(siteId, [
      spend('1', '2026-11-19', 250, 'Renamed'),
      spend('1', '2026-11-19', 260, 'Renamed'),
    ])
    expect(written).toBe(1)
    const rows = await listMetaAdsSpend(db, { siteId, fromDay: '2026-11-19', toDay: '2026-11-20' })
    expect(rows).toEqual([
      {
        campaignId: '1',
        campaignName: 'Renamed',
        day: '2026-11-19',
        spendMinor: 260,
        currency: 'USD',
      },
      { campaignId: '2', campaignName: 'C2', day: '2026-11-20', spendMinor: 300, currency: 'USD' },
    ])
  })

  it('refuses rows the parser would never write', async () => {
    const siteId = await makeSite()
    await expect(
      pool.query(
        `INSERT INTO meta_ads_daily_spend (site_id, campaign_id, campaign_name, day, spend_minor, currency)
         VALUES ($1, 'abc', 'x', '2026-11-01', 1, 'USD')`,
        [siteId],
      ),
    ).rejects.toThrow(/meta_ads_daily_spend_campaign_id_check/)
    await expect(
      pool.query(
        `INSERT INTO meta_ads_daily_spend (site_id, campaign_id, campaign_name, day, spend_minor, currency)
         VALUES ($1, '1', 'x', '2026-11-01', -1, 'USD')`,
        [siteId],
      ),
    ).rejects.toThrow(/meta_ads_daily_spend_spend_check/)
    await expect(
      pool.query(
        `INSERT INTO meta_ads_connections (site_id, ad_account_id, currency, encrypted_token, key_version)
         VALUES ($1, '123', 'USD', 'x', 'k1')`,
        [siteId],
      ),
    ).rejects.toThrow(/meta_ads_connections_ad_account_id_check/)
  })

  it('disconnects: the token and the spend go, and the audit names neither', async () => {
    const siteId = await makeSite()
    await connect(siteId)
    await writeSpend(siteId, [spend('1', '2026-11-20', 100), spend('2', '2026-11-20', 1)])
    expect(await deleteMetaAdsConnection(db, { siteId, actorUserId: ownerId })).toEqual({
      deleted: true,
      spendRows: 2,
    })
    expect(await readMetaAdsConnection(db, siteId)).toBeNull()
    expect(await countIn('meta_ads_daily_spend', siteId)).toBe(0)
    expect(await deleteMetaAdsConnection(db, { siteId, actorUserId: ownerId })).toEqual({
      deleted: false,
      spendRows: 0,
    })
  })

  it('drops the token when deletion starts, and the purge counts the spend', async () => {
    const siteId = await makeSite()
    const sibling = await makeSite()
    for (const target of [siteId, sibling]) {
      await connect(target)
      await writeSpend(target, [
        spend('1', '2026-11-19', 1),
        spend('1', '2026-11-20', 2),
        spend('2', '2026-11-20', 3),
      ])
    }
    await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
    expect(await readMetaAdsConnection(db, siteId)).toBeNull()
    expect(await countIn('meta_ads_daily_spend', siteId)).toBe(3)

    const purged = await purgeSitePostgres(db, { siteId })
    expect(purged.deleted['meta_ads_connections']).toBe(0)
    expect(purged.deleted['meta_ads_daily_spend']).toBe(3)
    expect(await countIn('meta_ads_daily_spend', siteId)).toBe(0)
    expect(await countIn('meta_ads_daily_spend', sibling)).toBe(3)
    expect(await readMetaAdsConnection(db, sibling)).not.toBeNull()
  })

  it('writes no spend for a connection that was disconnected while the sync ran', async () => {
    const siteId = await makeSite()
    const { connection } = await connect(siteId, 'act_300')

    // The owner's disconnect is mid-transaction, holding the connection row,
    // when the worker's upsert for the sync it started earlier arrives.
    const owner = new Client({ connectionString: scoped })
    await owner.connect()
    try {
      await owner.query('BEGIN')
      await owner.query('DELETE FROM meta_ads_connections WHERE site_id = $1', [siteId])
      await owner.query('DELETE FROM meta_ads_daily_spend WHERE site_id = $1', [siteId])

      const upsert = upsertMetaAdsSpend(db, {
        siteId,
        connectedAt: connection.connectedAt,
        adAccountId: 'act_300',
        rows: [spend('1', '2026-11-20', 100)],
      })
      // Give the upsert time to reach the connection row and queue on it.
      await new Promise((resolve) => setTimeout(resolve, 300))
      await owner.query('COMMIT')

      expect(await upsert).toBeNull()
    } finally {
      await owner.end()
    }
    expect(await countIn('meta_ads_daily_spend', siteId)).toBe(0)
  })

  it('writes no spend for a sync of an account the site no longer holds', async () => {
    const siteId = await makeSite()
    const old = await connect(siteId, 'act_400', new Date('2026-11-01T00:00:00.000Z'))
    await connect(siteId, 'act_401', new Date('2026-11-01T01:00:00.000Z'))

    // The sync that read act_400 finishes after the switch.
    expect(
      await upsertMetaAdsSpend(db, {
        siteId,
        connectedAt: old.connection.connectedAt,
        adAccountId: 'act_400',
        rows: [spend('1', '2026-11-20', 100)],
      }),
    ).toBeNull()
    expect(await countIn('meta_ads_daily_spend', siteId)).toBe(0)
  })

  it('connecting a new account after a disconnect leaves none of the old spend', async () => {
    const siteId = await makeSite()
    const old = await connect(siteId, 'act_500')
    await upsertMetaAdsSpend(db, {
      siteId,
      connectedAt: old.connection.connectedAt,
      adAccountId: 'act_500',
      rows: [spend('1', '2026-11-20', 100)],
    })
    await deleteMetaAdsConnection(db, { siteId, actorUserId: ownerId })
    // A row the old account's sync wrote outside any guard, as an older
    // build could have.
    await pool.query(
      `INSERT INTO meta_ads_daily_spend (site_id, campaign_id, campaign_name, day, spend_minor, currency)
       VALUES ($1, '9', 'Old', '2026-11-21', 5, 'USD')`,
      [siteId],
    )

    await connect(siteId, 'act_501')
    expect(await countIn('meta_ads_daily_spend', siteId)).toBe(0)
  })

  it('keeps the backfill cursor with the spend it covers, and resets it for a new account', async () => {
    const siteId = await makeSite()
    const first = await connect(siteId, 'act_600')
    expect(first.connection.backfillCursor).toBeNull()
    await upsertMetaAdsSpend(db, {
      siteId,
      connectedAt: first.connection.connectedAt,
      adAccountId: 'act_600',
      rows: [],
      backfillCursor: '2026-10-19',
    })
    expect((await readMetaAdsConnection(db, siteId))?.backfillCursor).toBe('2026-10-19')

    // A stale sync moves nothing.
    await upsertMetaAdsSpend(db, {
      siteId,
      connectedAt: new Date('2000-01-01T00:00:00.000Z'),
      adAccountId: 'act_600',
      rows: [],
      backfillCursor: '2026-09-01',
    })
    expect((await readMetaAdsConnection(db, siteId))?.backfillCursor).toBe('2026-10-19')

    // Same account: the backfill resumes where it stopped.
    expect((await connect(siteId, 'act_600')).connection.backfillCursor).toBe('2026-10-19')
    // Another account starts its own.
    expect((await connect(siteId, 'act_601')).connection.backfillCursor).toBeNull()
  })

  it('refuses to connect a site whose deletion has started', async () => {
    const siteId = await makeSite()
    await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
    const saved = await save(siteId)
    expect(saved).toEqual({ ok: false, conflict: 'site_unavailable' })
    expect(await readMetaAdsConnection(db, siteId)).toBeNull()
  })

  it('stores what Meta said about the account status', async () => {
    const siteId = await makeSite()
    const saved = await saveMetaAdsConnection(db, {
      siteId,
      adAccountId: 'act_700',
      adAccountName: 'Paused Co',
      currency: 'USD',
      accountStatus: 2,
      encryptedToken: 'k1.bm9uY2U=.Y2lwaGVydGV4dA==',
      keyVersion: 'k1',
      tokenLast4: 'abcd',
      actorUserId: ownerId,
    })
    expect(saved.ok && saved.connection.accountStatus).toBe(2)
    expect((await readMetaAdsConnection(db, siteId))?.accountStatus).toBe(2)
  })

  it('records an undecryptable token without stopping polling', async () => {
    const siteId = await makeSite()
    const t0 = new Date('2031-01-01T00:00:00.000Z')
    const { connection } = await connect(siteId, 'act_800', t0)
    await recordMetaAdsSync(db, {
      siteId,
      connectedAt: connection.connectedAt,
      at: t0,
      error: 'credential_undecryptable',
      completed: false,
      nextSyncAt: new Date(t0.getTime() + 6 * 3_600_000),
    })
    const row = await readMetaAdsConnection(db, siteId)
    expect(row).toMatchObject({ status: 'active', lastError: 'credential_undecryptable' })

    // Not due on an ordinary tick; due on the first tick after a restart, which
    // is the only time this process's keyring can have changed.
    const later = new Date(t0.getTime() + 3_600_000)
    const ordinary = await listDueMetaAdsConnections(db, { now: later, limit: 1000 })
    expect(ordinary.map((r) => r.siteId)).not.toContain(siteId)
    const afterStart = await listDueMetaAdsConnections(db, {
      now: later,
      limit: 1000,
      includeUndecryptable: true,
    })
    expect(afterStart.map((r) => r.siteId)).toContain(siteId)
  })

  it('lists currency rates in a date range', async () => {
    await upsertCurrencyRates(db, {
      rates: {
        rateDate: '2026-11-18',
        rates: [
          { currency: 'USD', ratePerEur: '1.05' },
          { currency: 'PLN', ratePerEur: '4.3' },
        ],
      },
    })
    await upsertCurrencyRates(db, {
      rates: { rateDate: '2026-11-20', rates: [{ currency: 'USD', ratePerEur: '1.06' }] },
    })
    const rows = await listCurrencyRatesBetween(db, {
      currencies: ['usd'],
      from: '2026-11-17',
      to: '2026-11-20',
    })
    expect(rows.map((row) => [row.rateDate, row.currency, Number(row.ratePerEur)])).toEqual([
      ['2026-11-18', 'USD', 1.05],
      ['2026-11-20', 'USD', 1.06],
    ])
  })
})
