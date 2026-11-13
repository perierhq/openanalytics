import { SITE_DELETION_TARGETS, revenueCredentialAad } from '@openanalytics/domain'
import {
  createDatabase,
  createPool,
  createRevenueCredential,
  createSiteWithOwner,
  disconnectRevenueCredential,
  listDeletionTargets,
  mintWebhookToken,
  newId,
  purgeSitePostgres,
  readLiveRevenueCredential,
  readRevenueCredential,
  readRevenueCredentialByWebhookToken,
  removeMember,
  rotateRevenueCredential,
  setRevenueWebhookSecret,
  startSiteDeletion,
  updateRevenueCredentialState,
  addMember,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Revenue credentials against a real Postgres (ADR-0033, D3/D8; migration 0033).
 *
 * Everything asserted here is a database fact rather than a TypeScript one, and
 * each is load-bearing somewhere the application cannot compensate:
 *
 * 1. **Disconnect erases both ciphertexts in the same UPDATE**, and the CHECK
 *    constraint makes that true whatever code path put the row there. A disabled
 *    credential holding a decryptable provider key is the security failure this
 *    table was designed around.
 * 2. **One live credential per (site, provider), partial on `status`.** The row
 *    survives a disconnect for history, and a fresh connect inserts a *new* row
 *    rather than resurrecting one whose `connected_at` would then predate the
 *    disconnection it went through.
 * 3. **A removed owner's credential goes with them** (snapshot 02 §19), in the
 *    removal's own transaction — through both removal paths.
 * 4. **`startSiteDeletion` erases the ciphertexts long before the purge**, so a
 *    site on its way out never holds a decryptable key while ClickHouse rewrites
 *    its parts, and the 57-target snapshot then removes the rows.
 * 5. **A sibling site is untouched by any of it.**
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

/** Stand-ins for real ciphertexts: this suite proves the row's lifecycle, and
 * the cipher has its own unit suite. The shape matches what the vault emits. */
const cipher = (label: string): string =>
  `k1.AAAAAAAAAAAAAAAA.${Buffer.from(label).toString('base64')}`

describeIfPostgres('revenue credentials', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m12cred_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
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

  const makeSite = async (owner = ownerId): Promise<string> => {
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: owner,
    })
    return siteId
  }

  const connect = async (
    siteId: string,
    options: { provider?: string; createdBy?: string } = {},
  ) => {
    const id = newId()
    const created = await createRevenueCredential(db, {
      id,
      siteId,
      provider: options.provider ?? 'stripe',
      encryptedApiKey: cipher(`api:${id}`),
      encryptedWebhookSecret: cipher(`whsec:${id}`),
      keyVersion: 'k1',
      apiKeyLast4: '1234',
      webhookToken: mintWebhookToken(),
      createdByUserId: options.createdBy ?? ownerId,
      verifiedAt: new Date('2026-07-31T00:00:00.000Z'),
    })
    if (!created.ok) throw new Error('setup failed: already connected')
    return created.credential
  }

  const rows = async (siteId: string) =>
    (
      await pool.query<{
        id: string
        status: string
        encrypted_api_key: string | null
        encrypted_webhook_secret: string | null
        disabled_at: Date | null
        last_error: string | null
      }>(
        `SELECT id, status, encrypted_api_key, encrypted_webhook_secret, disabled_at, last_error
           FROM revenue_credentials WHERE site_id = $1 ORDER BY connected_at`,
        [siteId],
      )
    ).rows

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

  describe('migration 0033 shape', () => {
    it('creates the table with the columns the repository reads', async () => {
      const r = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'revenue_credentials'`,
        [schemaName],
      )
      expect([...r.rows.map((row) => row.column_name)].sort()).toEqual(
        [
          'id',
          'site_id',
          'provider',
          'encrypted_api_key',
          'encrypted_webhook_secret',
          'key_version',
          'api_key_last4',
          'webhook_token',
          'status',
          'created_by_user_id',
          'connected_at',
          'last_verified_at',
          'last_synced_at',
          'last_webhook_at',
          'last_error',
          'disabled_at',
          // Migration 0034: the counter that makes a terminal backfill
          // recoverable rather than a permanent loss of history (D4).
          'backfill_generation',
          'created_at',
          'updated_at',
        ].sort(),
      )
    })

    it('refuses a disabled row that still holds a ciphertext', async () => {
      // The one guarantee the application must not be trusted with: "disconnect
      // erases the secret" is a database rule.
      const siteId = await makeSite()
      const credential = await connect(siteId)
      await expect(
        pool.query(`UPDATE revenue_credentials SET status = 'disabled' WHERE id = $1`, [
          credential.id,
        ]),
      ).rejects.toThrow(/revenue_credentials_disabled_erased_check/u)
    })

    it('refuses a status outside the vocabulary', async () => {
      // An unrecognised value would read as "not disabled" and let a second
      // connection live beside the first.
      const siteId = await makeSite()
      const credential = await connect(siteId)
      await expect(
        pool.query(`UPDATE revenue_credentials SET status = 'broken' WHERE id = $1`, [
          credential.id,
        ]),
      ).rejects.toThrow(/revenue_credentials_status_check/u)
    })

    it('gives every site a reporting currency, shape-checked', async () => {
      // D2c. The default is USD and the CHECK is ISO-4217 shape only — whether
      // ECB publishes a rate is decided per transaction, not here.
      const siteId = await makeSite()
      const before = await pool.query<{ reporting_currency: string }>(
        `SELECT reporting_currency FROM sites WHERE id = $1`,
        [siteId],
      )
      expect(before.rows[0]?.reporting_currency).toBe('USD')

      await expect(
        pool.query(`UPDATE sites SET reporting_currency = 'EUR' WHERE id = $1`, [siteId]),
      ).resolves.toBeDefined()
      await expect(
        pool.query(`UPDATE sites SET reporting_currency = 'eur' WHERE id = $1`, [siteId]),
      ).rejects.toThrow(/sites_reporting_currency_format/u)
      await expect(
        pool.query(`UPDATE sites SET reporting_currency = 'EURO' WHERE id = $1`, [siteId]),
      ).rejects.toThrow(/sites_reporting_currency_format/u)
    })
  })

  describe('connect', () => {
    it('stores the ciphertexts and reports the connection', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)

      expect(credential.status).toBe('active')
      expect(credential.keyVersion).toBe('k1')
      expect(credential.apiKeyLast4).toBe('1234')
      // 32 random bytes, base64url — one address per site.
      expect(credential.webhookToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)

      // The AAD the api would have bound is derivable from what is stored, which
      // is the property that makes decryption possible at all on the worker.
      expect(revenueCredentialAad({ credentialId: credential.id, siteId })).toContain(credential.id)

      const audits = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
        `SELECT action, metadata FROM audit_logs WHERE site_id = $1 ORDER BY occurred_at`,
        [siteId],
      )
      const connectRow = audits.rows.find((row) => row.action === 'site.revenue.connected')
      expect(connectRow?.metadata['provider']).toBe('stripe')
      // Categorized only: no secret and no webhook token reaches the trail.
      expect(JSON.stringify(connectRow?.metadata)).not.toContain(credential.webhookToken)
    })

    it('refuses a second live connection to the same provider', async () => {
      // Decided by the partial unique rather than by a read, so two concurrent
      // connects cannot each find nothing and both insert.
      const siteId = await makeSite()
      await connect(siteId)
      const second = await createRevenueCredential(db, {
        id: newId(),
        siteId,
        provider: 'stripe',
        encryptedApiKey: cipher('api:2'),
        encryptedWebhookSecret: cipher('whsec:2'),
        keyVersion: 'k1',
        apiKeyLast4: '9999',
        webhookToken: mintWebhookToken(),
        createdByUserId: ownerId,
      })
      expect(second).toEqual({ ok: false, conflict: 'already_connected' })
      expect(await rows(siteId)).toHaveLength(1)
    })

    it('allows a different provider beside it', async () => {
      // The unique is per (site, provider): a site connecting two providers is a
      // supported shape, and only the catalog decides which ones are offered.
      const siteId = await makeSite()
      await connect(siteId)
      const polar = await connect(siteId, { provider: 'polar' })
      expect(polar.provider).toBe('polar')
      expect(await rows(siteId)).toHaveLength(2)
    })

    it('resolves a credential from its webhook token, whatever its status', async () => {
      // CP2's endpoint has to tell a disabled credential from an unknown token:
      // one is acked and ignored, the other is a 404.
      const siteId = await makeSite()
      const credential = await connect(siteId)
      expect((await readRevenueCredentialByWebhookToken(db, credential.webhookToken))?.id).toBe(
        credential.id,
      )

      await disconnectRevenueCredential(db, {
        credentialId: credential.id,
        siteId,
        actorUserId: ownerId,
      })
      expect((await readRevenueCredentialByWebhookToken(db, credential.webhookToken))?.status).toBe(
        'disabled',
      )
      expect(await readRevenueCredentialByWebhookToken(db, 'not-a-token')).toBeNull()
    })
  })

  describe('state updates', () => {
    it('records a degradation without moving last_synced_at', async () => {
      // The outage rule: a degraded credential keeps reporting when its data was
      // last actually correct. Moving the sync instant on a failure is how a
      // dashboard starts implying fresh zeroes.
      const siteId = await makeSite()
      const credential = await connect(siteId)
      const synced = new Date('2026-07-30T12:00:00.000Z')
      await updateRevenueCredentialState(db, {
        credentialId: credential.id,
        siteId,
        lastSyncedAt: synced,
      })
      await updateRevenueCredentialState(db, {
        credentialId: credential.id,
        siteId,
        status: 'degraded',
        lastError: 'provider_unauthorized',
      })

      const after = await readRevenueCredential(db, { siteId })
      expect(after?.status).toBe('degraded')
      expect(after?.lastError).toBe('provider_unauthorized')
      expect(after?.lastSyncedAt?.toISOString()).toBe(synced.toISOString())
    })

    it('never re-arms a disconnected credential', async () => {
      // Its ciphertexts are gone, so a row flipped back to `active` would be a
      // connection that cannot decrypt anything and fails on every sync forever.
      const siteId = await makeSite()
      const credential = await connect(siteId)
      await disconnectRevenueCredential(db, {
        credentialId: credential.id,
        siteId,
        actorUserId: ownerId,
      })
      await updateRevenueCredentialState(db, {
        credentialId: credential.id,
        siteId,
        status: 'active',
      })
      expect((await readRevenueCredential(db, { siteId }))?.status).toBe('disabled')
    })

    it('ignores an update whose site does not match the credential', async () => {
      // The predicate is `(id, site_id)` on purpose. CP2 resolves credentials
      // from an attacker-supplied webhook token, and every writer downstream of
      // that resolution carries the site it believes it is acting on — so a
      // confusion between the two cannot be expressed rather than being
      // prevented by each caller remembering to check.
      const siteId = await makeSite()
      const other = await makeSite()
      const credential = await connect(siteId)

      await updateRevenueCredentialState(db, {
        credentialId: credential.id,
        siteId: other,
        status: 'degraded',
        lastError: 'provider_unauthorized',
      })

      const after = await readRevenueCredential(db, { siteId })
      expect(after?.status).toBe('active')
      expect(after?.lastError).toBeNull()
    })

    it('refuses to disable through the status writer', async () => {
      // A second path to `disabled` that did not erase would be a second way to
      // reach the state the CHECK forbids.
      await expect(
        updateRevenueCredentialState(db, {
          credentialId: newId(),
          siteId: newId(),
          status: 'disabled',
        }),
      ).rejects.toThrow(/disconnectRevenueCredential/u)
    })
  })

  describe('rotate', () => {
    it('swaps the key, its version and its tail together, and clears a degradation', async () => {
      // They describe one secret; a row carrying a new ciphertext under the old
      // version's label would be undecryptable the moment the old key left the
      // ring.
      {
        const siteId = await makeSite()
        const credential = await connect(siteId)
        await updateRevenueCredentialState(db, {
          credentialId: credential.id,
          siteId,
          status: 'degraded',
          lastError: 'provider_unauthorized',
        })

        const rotated = await rotateRevenueCredential(db, {
          credentialId: credential.id,
          siteId,
          encryptedApiKey: 'k2.BBBBBBBBBBBBBBBB.QUJD',
          keyVersion: 'k2',
          apiKeyLast4: '9876',
          actorUserId: ownerId,
          verifiedAt: new Date('2026-07-31T01:00:00.000Z'),
        })

        expect(rotated?.encryptedApiKey).toBe('k2.BBBBBBBBBBBBBBBB.QUJD')
        expect(rotated?.keyVersion).toBe('k2')
        expect(rotated?.apiKeyLast4).toBe('9876')
        expect(rotated?.status).toBe('active')
        expect(rotated?.lastError).toBeNull()
        // The webhook secret is untouched: rotating a provider key does not
        // change the endpoint's signing secret.
        expect(rotated?.encryptedWebhookSecret).toBe(credential.encryptedWebhookSecret)
        expect(rotated?.webhookToken).toBe(credential.webhookToken)
      }
    })

    it('loses to a disconnect rather than resurrecting the credential', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)
      await disconnectRevenueCredential(db, {
        credentialId: credential.id,
        siteId,
        actorUserId: ownerId,
      })

      const rotated = await rotateRevenueCredential(db, {
        credentialId: credential.id,
        siteId,
        encryptedApiKey: 'k1.CCCCCCCCCCCCCCCC.QUJD',
        keyVersion: 'k1',
        apiKeyLast4: '5555',
        actorUserId: ownerId,
      })
      expect(rotated).toBeNull()
      const [row] = await rows(siteId)
      expect(row?.status).toBe('disabled')
      expect(row?.encrypted_api_key).toBeNull()
    })
  })

  describe('the two-step connect (CP6)', () => {
    /** Step one: an API key and no signing secret, which is the ordinary state
     * until the customer has created the provider endpoint. */
    const connectWithoutSecret = async (siteId: string) => {
      const id = newId()
      const created = await createRevenueCredential(db, {
        id,
        siteId,
        provider: 'stripe',
        encryptedApiKey: cipher(`api:${id}`),
        encryptedWebhookSecret: null,
        keyVersion: 'k1',
        apiKeyLast4: '1234',
        webhookToken: mintWebhookToken(),
        createdByUserId: ownerId,
      })
      if (!created.ok) throw new Error('setup failed: already connected')
      return created.credential
    }

    it('stores an active credential with a NULL signing secret', async () => {
      // CP1's CHECK is one-directional — `status <> 'disabled' OR both
      // ciphertexts NULL` — so this row has always been legal and needs no
      // migration. This is the test that says so out loud.
      const siteId = await makeSite()
      const credential = await connectWithoutSecret(siteId)

      expect(credential.encryptedWebhookSecret).toBeNull()
      expect(credential.encryptedApiKey).not.toBeNull()
      // Active, because backfill and reconcile run entirely on the API key. A
      // degraded status here would paint a working connection as broken for as
      // long as the customer took to finish step two.
      expect(credential.status).toBe('active')
      expect(credential.webhookToken).not.toBe('')
      // And it still occupies the live slot, so a second connect conflicts.
      expect(credential.lastWebhookAt).toBeNull()
    })

    it('sets the signing secret afterwards, with its own audit action', async () => {
      const siteId = await makeSite()
      const credential = await connectWithoutSecret(siteId)

      const updated = await setRevenueWebhookSecret(db, {
        credentialId: credential.id,
        siteId,
        encryptedWebhookSecret: 'k2.DDDDDDDDDDDDDDDD.QUJD',
        keyVersion: 'k2',
        actorUserId: ownerId,
      })

      expect(updated?.encryptedWebhookSecret).toBe('k2.DDDDDDDDDDDDDDDD.QUJD')
      // The version label moves with the newest ciphertext on the row, which is
      // what the rotation sweep reads.
      expect(updated?.keyVersion).toBe('k2')
      // Neither the API key nor the token moved.
      expect(updated?.encryptedApiKey).toBe(credential.encryptedApiKey)
      expect(updated?.webhookToken).toBe(credential.webhookToken)

      const audit = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
        `SELECT action, metadata FROM audit_logs WHERE site_id = $1 ORDER BY occurred_at DESC`,
        [siteId],
      )
      expect(audit.rows[0]?.action).toBe('site.revenue.webhook_secret_set')
      // The action, never the secret and never a prefix of it.
      expect(JSON.stringify(audit.rows[0]?.metadata)).not.toContain('DDDD')
    })

    it('does NOT re-enqueue a backfill — that reasoning belongs to a key rotation', async () => {
      // Rotating an API key re-walks ninety days because the ordinary reason to
      // rotate is that the old key had stopped working. Pasting a signing secret
      // says nothing about the key, and re-walking every time somebody finishes
      // the connect guide would be a large, pointless bill.
      const siteId = await makeSite()
      const credential = await connectWithoutSecret(siteId)
      const before = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM jobs WHERE type = 'revenue_backfill' AND subject_id = $1`,
        [credential.id],
      )

      const updated = await setRevenueWebhookSecret(db, {
        credentialId: credential.id,
        siteId,
        encryptedWebhookSecret: 'k1.EEEEEEEEEEEEEEEE.QUJD',
        keyVersion: 'k1',
        actorUserId: ownerId,
      })

      const after = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM jobs WHERE type = 'revenue_backfill' AND subject_id = $1`,
        [credential.id],
      )
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
      expect(updated?.backfillGeneration).toBe(credential.backfillGeneration)
      // And the status is untouched: this write is not evidence about the key.
      expect(updated?.status).toBe(credential.status)
    })

    it('loses to a disconnect rather than writing onto an erased row', async () => {
      const siteId = await makeSite()
      const credential = await connectWithoutSecret(siteId)
      await disconnectRevenueCredential(db, {
        credentialId: credential.id,
        siteId,
        actorUserId: ownerId,
      })

      const updated = await setRevenueWebhookSecret(db, {
        credentialId: credential.id,
        siteId,
        encryptedWebhookSecret: 'k1.FFFFFFFFFFFFFFFF.QUJD',
        keyVersion: 'k1',
        actorUserId: ownerId,
      })
      expect(updated).toBeNull()
      const [row] = await rows(siteId)
      // The disabled-erased invariant still holds: nothing resurrected it.
      expect(row?.status).toBe('disabled')
      expect(row?.encrypted_webhook_secret).toBeNull()
    })
  })

  describe('disconnect', () => {
    it('disables the row and erases both ciphertexts in one write', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)

      expect(
        await disconnectRevenueCredential(db, {
          credentialId: credential.id,
          siteId,
          actorUserId: ownerId,
        }),
      ).toBe(true)

      const [row] = await rows(siteId)
      expect(row?.status).toBe('disabled')
      expect(row?.encrypted_api_key).toBeNull()
      expect(row?.encrypted_webhook_secret).toBeNull()
      expect(row?.disabled_at).not.toBeNull()
      // Cleared with the secret: a stale failure category on a disconnected
      // credential would render as an outage the customer cannot fix.
      expect(row?.last_error).toBeNull()

      const audits = await pool.query<{ action: string }>(
        `SELECT action FROM audit_logs WHERE site_id = $1`,
        [siteId],
      )
      expect(audits.rows.map((r) => r.action)).toContain('site.revenue.disconnected')
    })

    it('keeps the row so history survives, and lets a fresh connect insert a new one', async () => {
      // The whole reason the unique is partial. Resurrection would give the new
      // connection a `connected_at` predating the disconnection it went through.
      const siteId = await makeSite()
      const first = await connect(siteId)
      await disconnectRevenueCredential(db, {
        credentialId: first.id,
        siteId,
        actorUserId: ownerId,
      })

      const second = await connect(siteId)
      expect(second.id).not.toBe(first.id)
      expect(await rows(siteId)).toHaveLength(2)

      // The live read finds the new one; the status read prefers it too.
      expect((await readLiveRevenueCredential(db, { siteId }))?.id).toBe(second.id)
      expect((await readRevenueCredential(db, { siteId }))?.id).toBe(second.id)
    })

    it('is a no-op on an already-disconnected credential', async () => {
      const siteId = await makeSite()
      const credential = await connect(siteId)
      const input = { credentialId: credential.id, siteId, actorUserId: ownerId }
      expect(await disconnectRevenueCredential(db, input)).toBe(true)
      expect(await disconnectRevenueCredential(db, input)).toBe(false)
      // One audit row, not two: a trail recording changes that did not happen is
      // a trail nobody can read.
      const audits = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_logs
          WHERE site_id = $1 AND action = 'site.revenue.disconnected'`,
        [siteId],
      )
      expect(audits.rows[0]?.n).toBe('1')
    })

    it('reports a disconnected site as disabled rather than never-connected', async () => {
      // Different sentences on the empty-state screen, and the API can only
      // distinguish them because the row survives.
      const siteId = await makeSite()
      expect(await readRevenueCredential(db, { siteId })).toBeNull()
      const credential = await connect(siteId)
      await disconnectRevenueCredential(db, {
        credentialId: credential.id,
        siteId,
        actorUserId: ownerId,
      })
      expect((await readRevenueCredential(db, { siteId }))?.status).toBe('disabled')
      expect(await readLiveRevenueCredential(db, { siteId })).toBeNull()
    })
  })

  describe('owner removal (snapshot 02 §19)', () => {
    it('revokes the credentials a removed member connected', async () => {
      const siteId = await makeSite()
      const other = await makeUser()
      await addMember(db, { siteId, userId: other, role: 'admin' })

      const theirs = await connect(siteId, { createdBy: other })
      const mine = await connect(siteId, { provider: 'polar', createdBy: ownerId })

      await removeMember(db, { siteId, userId: other, actorUserId: ownerId })

      const after = await rows(siteId)
      const revoked = after.find((row) => row.id === theirs.id)
      expect(revoked?.status).toBe('disabled')
      expect(revoked?.encrypted_api_key).toBeNull()
      expect(revoked?.encrypted_webhook_secret).toBeNull()
      // Somebody else's connection is not collateral damage.
      expect(after.find((row) => row.id === mine.id)?.status).toBe('active')

      const audits = await pool.query<{ action: string }>(
        `SELECT action FROM audit_logs WHERE site_id = $1`,
        [siteId],
      )
      expect(audits.rows.map((r) => r.action)).toContain('site.revenue.revoked')
    })
  })

  describe('site deletion (ADR-0033, D8)', () => {
    it('erases the ciphertexts at deletion start, phases before the purge', async () => {
      // `clickhouse_purge` polls mutations for as long as ClickHouse takes to
      // rewrite its parts; a decryptable provider key must not survive that.
      const siteId = await makeSite()
      const credential = await connect(siteId)

      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })

      const [row] = await rows(siteId)
      expect(row?.id).toBe(credential.id)
      // The row is still there — the purge has not run — and the secret is gone.
      expect(row?.status).toBe('disabled')
      expect(row?.encrypted_api_key).toBeNull()
      expect(row?.encrypted_webhook_secret).toBeNull()

      const audit = await pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_logs
          WHERE site_id = $1 AND action = 'site.deletion_requested'`,
        [siteId],
      )
      expect(audit.rows[0]?.metadata['revoked_revenue_credentials']).toBe(1)

      const targets = await listDeletionTargets(db, {
        deletionRequestId: started.deletionRequestId,
      })
      // 67, not 68 (62 + the three subscription lifecycle tables of Postgres 0047 and the two of ClickHouse 0030): `billing_transfer_offers` is a target the hosted surface registers (`CLOUD_DELETION_EXTENSION`), so this is the set a build without it erases.
      expect(targets).toHaveLength(67)
      expect(targets).toHaveLength(SITE_DELETION_TARGETS.length)
      expect(targets.filter((t) => t.store === 'postgres')).toHaveLength(25)
      expect(targets.map((t) => t.target)).toContain('revenue_credentials')
    })

    it('purges the rows for the deleted site and leaves a sibling alone', async () => {
      // A vocabulary name with no purge statement behind it verifies silently at
      // `deleted: 0`, so the per-table effect is asserted, not only the count.
      const siteId = await makeSite()
      const sibling = await makeSite()
      await connect(siteId)
      await connect(siteId, { provider: 'polar' })
      const survivor = await connect(sibling)

      // The purge runs as a phase of a started deletion: migration 0028's
      // ownership-trigger exemption is keyed on `sites.status = 'deleting'`, so
      // removing every member row is only committable after the start
      // transaction has flipped it.
      await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })

      const result = await purgeSitePostgres(db, { siteId })
      expect(result.deleted['revenue_credentials']).toBe(2)
      expect(await rows(siteId)).toHaveLength(0)

      const kept = await rows(sibling)
      expect(kept).toHaveLength(1)
      expect(kept[0]?.id).toBe(survivor.id)
      // Untouched, not merely present: the sibling's secret is still there.
      expect(kept[0]?.encrypted_api_key).not.toBeNull()
      expect(kept[0]?.status).toBe('active')
    })
  })
})
