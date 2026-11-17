import {
  createApiKey,
  createDatabase,
  createPool,
  createSiteWithOwner,
  newId,
  readSiteIngestSettings,
  resolveIngestConfig,
  upsertSiteIngestSettings,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { MAX_HEARTBEAT_INTERVAL_SECONDS } from '@openanalytics/contracts'
import {
  DEFAULT_TRACKER_SETTINGS,
  EMPTY_INGEST_EXCLUSIONS,
  InvalidHeartbeatIntervalError,
  decideIngestAdmission,
} from '@openanalytics/domain'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Tracking key → versioned site ingest config (migration 0014; plan 04
 * Milestone 5 item 2, docs snapshot 02 §7.1 item 3).
 *
 * The lookup the collector performs before it accepts anything. What is proven
 * here is what a unit test with a fake store cannot: that only a live public key
 * resolves, that a site with no settings row still answers, and that a settings
 * write moves `config_version` — the value the ETag, the CDN copy and the
 * collector's ingest-config cache are all keyed by.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('site ingest config resolution', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m5ingest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database

  const newUser = async (): Promise<string> => {
    const userId = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [userId, `${userId}@example.com`],
    )
    return userId
  }

  const newSiteWithKey = async (): Promise<{
    siteId: string
    userId: string
    trackingKey: string
  }> => {
    const userId = await newUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'Shop',
      ownerUserId: userId,
    })
    const key = await createApiKey(db, {
      siteId,
      type: 'tracking_write',
      createdByUserId: userId,
    })
    return { siteId, userId, trackingKey: key.rawToken }
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

  it('resolves a live public key to a versioned ingest config', async () => {
    const { siteId, userId, trackingKey } = await newSiteWithKey()

    const resolved = await resolveIngestConfig(db, trackingKey)

    expect(resolved).not.toBeNull()
    expect(resolved?.config.siteId).toBe(siteId)
    expect(resolved?.config.billingUserId).toBe(userId)
    expect(resolved?.config.status).toBe('active')
    expect(resolved?.config.ingestGeneration).toBe(1)
    expect(resolved?.config.configVersion).toBe(1)
    // The version the worker corrects a stale snapshot against (02 §7.1 item 10).
    // Zero from the product read: there is no assignment history to version, and
    // the surface that keeps one replaces both this and `billingUserId` in its own
    // config decorator (`apps/collector/src/cloud/index.ts`).
    expect(resolved?.config.billingAssignmentVersion).toBe(0)
  })

  it('serves the documented defaults for a site with no settings row', async () => {
    // Migration 0014 is a pure expand with no backfill, so most sites have no
    // row. If this returned nulls instead of the defaults, every existing site's
    // tracker would receive a malformed configuration the moment 0014 landed.
    const { trackingKey } = await newSiteWithKey()

    const resolved = await resolveIngestConfig(db, trackingKey)

    expect(resolved?.settings).toEqual(DEFAULT_TRACKER_SETTINGS)
  })

  it('returns a site with no subscription row rather than dropping it', async () => {
    // A site whose owner has bought nothing resolves, and the read never names a
    // subscription: it joins no such table since the open-core split, so there is
    // no inner join left that could resolve the key to nothing and make the
    // collector answer SITE_NOT_FOUND for a site that plainly exists.
    const { trackingKey } = await newSiteWithKey()

    const resolved = await resolveIngestConfig(db, trackingKey)

    expect(resolved).not.toBeNull()
    expect(resolved?.config.status).toBe('active')
    // The payer, filled from the site's owner of record; a deployment that keeps
    // assignment history corrects it in its own decorator.
    expect(resolved?.config.billingUserId).not.toBe('')
    expect(resolved?.config.billingAssignmentVersion).toBe(0)
  })

  it('refuses a private read key on the ingest path', async () => {
    // Docs snapshot 01 §3.2: the public tracking key is write-only, and the
    // converse holds too — a private read key is not an ingest credential.
    const userId = await newUser()
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'Shop',
      ownerUserId: userId,
    })
    const privateKey = await createApiKey(db, {
      siteId,
      type: 'private_read',
      createdByUserId: userId,
    })

    expect(await resolveIngestConfig(db, privateKey.rawToken)).toBeNull()
  })

  it('refuses a revoked key', async () => {
    const { siteId, trackingKey } = await newSiteWithKey()
    await pool.query(`UPDATE api_keys SET revoked_at = now() WHERE site_id = $1`, [siteId])

    expect(await resolveIngestConfig(db, trackingKey)).toBeNull()
  })

  it('refuses an expired key, and carries the expiry so a cache cannot outlive it', async () => {
    const { siteId, trackingKey } = await newSiteWithKey()

    // Still live, but with an expiry: the resolved config has to carry it, so a
    // cached entry is refused by `decideIngestAdmission` once the key lapses
    // even if the cache entry itself has not yet aged out (02 §7.2).
    const soon = new Date(Date.now() + 60_000)
    await pool.query(`UPDATE api_keys SET expires_at = $2 WHERE site_id = $1`, [siteId, soon])

    const resolved = await resolveIngestConfig(db, trackingKey)
    expect(resolved?.config.keyExpiresAt?.getTime()).toBe(soon.getTime())

    const afterExpiry = decideIngestAdmission({
      config: resolved!.config,
      now: new Date(soon.getTime() + 1),
    })
    expect(afterExpiry.admitted).toBe(false)
    expect(afterExpiry.admitted === false && afterExpiry.reason).toBe('key_expired')

    // And once it has actually lapsed, the query itself stops resolving it.
    await pool.query(
      `UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE site_id = $1`,
      [siteId],
    )
    expect(await resolveIngestConfig(db, trackingKey)).toBeNull()
  })

  it('resolves nothing for a key that was never issued', async () => {
    expect(await resolveIngestConfig(db, 'oa_pk_not-a-real-key')).toBeNull()
  })

  it('carries the site origin allowlist', async () => {
    const { siteId, trackingKey } = await newSiteWithKey()
    await pool.query(`INSERT INTO site_domains (id, site_id, domain) VALUES ($1, $2, $3)`, [
      newId(),
      siteId,
      'Shop.Example.COM',
    ])

    const resolved = await resolveIngestConfig(db, trackingKey)
    expect(resolved?.config.allowedDomains).toEqual(['shop.example.com'])
  })

  it('bumps config_version when settings are written, in the same transaction', async () => {
    // The version is what invalidates the CDN copy, the tracker's local copy and
    // the collector's ingest-config cache together (ADR-0008). A settings write
    // that left it alone would leave every browser on the old configuration.
    const { siteId, trackingKey } = await newSiteWithKey()

    const first = await upsertSiteIngestSettings(db, {
      siteId,
      timezone: 'Asia/Baku',
      redactQueryKeys: ['token', 'email'],
      interactionSampling: 0.25,
      features: { web_vitals: false },
    })
    expect(first.configVersion).toBe(2)

    const resolved = await resolveIngestConfig(db, trackingKey)
    expect(resolved?.config.configVersion).toBe(2)
    expect(resolved?.settings.timezone).toBe('Asia/Baku')
    expect(resolved?.settings.redactQueryKeys).toEqual(['token', 'email'])
    expect(resolved?.settings.interactionSampling).toBeCloseTo(0.25)
    expect(resolved?.settings.features.web_vitals).toBe(false)
    // Unstated flags keep their defaults rather than being reset.
    expect(resolved?.settings.features.heartbeat).toBe(true)

    const second = await upsertSiteIngestSettings(db, { siteId, timezone: 'Europe/Berlin' })
    expect(second.configVersion).toBe(3)

    const again = await resolveIngestConfig(db, trackingKey)
    expect(again?.settings.timezone).toBe('Europe/Berlin')
    // A partial update must not silently discard the rest of the row.
    expect(again?.settings.redactQueryKeys).toEqual(['token', 'email'])
  })

  it('reads a site settings by id, defaults and all (ADR-0064 F4)', async () => {
    // The management surface's read. Separate from `resolveIngestConfig`, which
    // is keyed by a public tracking key — this one is keyed by site id and also
    // carries `config_version`, because the settings screen needs to see that
    // its own write is the one browsers will now fetch.
    const { siteId } = await newSiteWithKey()

    // A site with no settings ROW is not an error and is not a 404: it is the
    // state most sites are in, and it answers with the product defaults.
    const before = await readSiteIngestSettings(db, siteId)
    expect(before?.settings).toEqual(DEFAULT_TRACKER_SETTINGS)
    expect(before?.configVersion).toBe(1)

    const written = await upsertSiteIngestSettings(db, {
      siteId,
      timezone: 'Asia/Baku',
      interactionSampling: 0.5,
      features: { interactions: false },
      attributedRevenue: true,
    })

    const after = await readSiteIngestSettings(db, siteId)
    expect(after?.configVersion).toBe(written.configVersion)
    expect(after?.settings.timezone).toBe('Asia/Baku')
    expect(after?.settings.interactionSampling).toBeCloseTo(0.5)
    expect(after?.settings.attributedRevenue).toBe(true)
    // An unnamed flag keeps its value rather than being reset by the write.
    expect(after?.settings.features).toEqual({
      web_vitals: true,
      engagement: true,
      interactions: false,
      heartbeat: true,
    })

    expect(await readSiteIngestSettings(db, newId())).toBeNull()
  })

  it('serves attributed revenue off until a site opts in (ADR-0064 D4a)', async () => {
    // The one column in this table whose default is `false`, and the reason is
    // the whole of D4a: with it off the browser sends no revenue-linking hint at
    // all, so a site that never chose attribution cannot be attributing by
    // accident. A site with no settings row at all must read the same way.
    const { siteId, trackingKey } = await newSiteWithKey()

    const beforeAnyRow = await resolveIngestConfig(db, trackingKey)
    expect(beforeAnyRow?.settings.attributedRevenue).toBe(false)

    // A write that says nothing about it must not turn it on either.
    await upsertSiteIngestSettings(db, { siteId, timezone: 'Asia/Baku' })
    expect((await resolveIngestConfig(db, trackingKey))?.settings.attributedRevenue).toBe(false)

    const opted = await upsertSiteIngestSettings(db, { siteId, attributedRevenue: true })
    const resolved = await resolveIngestConfig(db, trackingKey)
    expect(resolved?.settings.attributedRevenue).toBe(true)
    // And it moves the version, because the browser has to hear about it.
    expect(resolved?.config.configVersion).toBe(opted.configVersion)
  })

  it('refuses a settings row outside the contract bounds', async () => {
    const { siteId } = await newSiteWithKey()

    // The CHECK constraints mirror the M4 contract's own bounds, so a bad value
    // cannot reach a browser as a configuration the tracker would clamp anyway.
    await expect(
      upsertSiteIngestSettings(db, { siteId, interactionSampling: 1.5 }),
    ).rejects.toThrow()
    await expect(
      upsertSiteIngestSettings(db, { siteId, heartbeatIntervalSeconds: 1 }),
    ).rejects.toThrow()
  })

  it('refuses a heartbeat interval the presence window cannot hold (ADR-0035 D8)', async () => {
    const { siteId, trackingKey } = await newSiteWithKey()

    // 300 s used to be the ceiling — the whole presence window — so every
    // visitor's presence expired exactly as their next beat arrived. The
    // rejection is the repository's, not the driver's: a constraint violation
    // would say the row was invalid and not why, and the thing this prevents is
    // a board that flickers, which reads as a bug in everything except the
    // setting that caused it.
    await expect(
      upsertSiteIngestSettings(db, {
        siteId,
        heartbeatIntervalSeconds: MAX_HEARTBEAT_INTERVAL_SECONDS + 1,
      }),
    ).rejects.toBeInstanceOf(InvalidHeartbeatIntervalError)

    // Refused before the transaction opens, so nothing was written and
    // config_version did not move — a rejected write must not invalidate every
    // browser's cached tracker config for a change that never happened.
    const before = await resolveIngestConfig(db, trackingKey)
    expect(before?.settings.heartbeatIntervalSeconds).toBe(
      DEFAULT_TRACKER_SETTINGS.heartbeatIntervalSeconds,
    )

    // The boundary itself is allowed: three of it fit exactly in the window.
    await expect(
      upsertSiteIngestSettings(db, {
        siteId,
        heartbeatIntervalSeconds: MAX_HEARTBEAT_INTERVAL_SECONDS,
      }),
    ).resolves.toBeDefined()

    // And the column's own CHECK is the backstop for a writer that is not this
    // function — a hand-run UPDATE during an incident, say (migration 0039).
    await expect(
      pool.query(
        `UPDATE site_ingest_settings SET heartbeat_interval_seconds = 300 WHERE site_id = $1`,
        [siteId],
      ),
    ).rejects.toThrow()
  })

  it('stores exclusions, replaces them whole, and bumps config_version (migration 0051)', async () => {
    const { siteId, trackingKey } = await newSiteWithKey()

    // No row: nothing excluded, and the read surface says so explicitly.
    expect((await resolveIngestConfig(db, trackingKey))?.exclusions).toEqual(
      EMPTY_INGEST_EXCLUSIONS,
    )
    expect((await readSiteIngestSettings(db, siteId))?.exclusions).toEqual(EMPTY_INGEST_EXCLUSIONS)

    const first = await upsertSiteIngestSettings(db, {
      siteId,
      exclusions: {
        ipRanges: ['203.0.113.0/24'],
        paths: ['/admin/*'],
        countries: ['DE'],
        hostnames: ['*.staging.example.com'],
      },
    })
    const resolved = await resolveIngestConfig(db, trackingKey)
    expect(resolved?.exclusions).toEqual({
      ipRanges: ['203.0.113.0/24'],
      paths: ['/admin/*'],
      countries: ['DE'],
      hostnames: ['*.staging.example.com'],
    })
    // The collector's cache is keyed by the version, so the write has to move it.
    expect(resolved?.config.configVersion).toBe(first.configVersion)

    // A write that does not mention exclusions leaves them alone…
    await upsertSiteIngestSettings(db, { siteId, timezone: 'Asia/Baku' })
    expect((await readSiteIngestSettings(db, siteId))?.exclusions.paths).toEqual(['/admin/*'])

    // …and one that does replaces all four lists.
    await upsertSiteIngestSettings(db, {
      siteId,
      exclusions: { ipRanges: [], paths: ['/preview'], countries: [], hostnames: [] },
    })
    expect((await readSiteIngestSettings(db, siteId))?.exclusions).toEqual({
      ipRanges: [],
      paths: ['/preview'],
      countries: [],
      hostnames: [],
    })
  })

  it('refuses an exclusion list over its bound at the column', async () => {
    const { siteId } = await newSiteWithKey()
    await upsertSiteIngestSettings(db, { siteId, timezone: 'UTC' })
    await expect(
      pool.query(`UPDATE site_ingest_settings SET exclude_hostnames = $2 WHERE site_id = $1`, [
        siteId,
        Array.from({ length: 21 }, (_, index) => `h${index}.example.com`),
      ]),
    ).rejects.toThrow()
  })

  it('removes the settings row along with the site', async () => {
    const { siteId } = await newSiteWithKey()
    await upsertSiteIngestSettings(db, { siteId, timezone: 'Asia/Baku' })

    await pool.query(`DELETE FROM sites WHERE id = $1`, [siteId])

    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM site_ingest_settings WHERE site_id = $1`,
      [siteId],
    )
    expect(rows[0]?.n).toBe(0)
  })
})
