import { ACCOUNT_DELETION_TARGETS } from '@openanalytics/domain'
import {
  AccountDeletionBlockedError,
  accountTombstoneEmail,
  createDatabase,
  createPool,
  createSiteWithOwner,
  deploymentOperatorUserId,
  finalizeAccountDeletion,
  listBilledSiteStates,
  listDeletionTargets,
  markAccountDeletionFailed,
  newId,
  purgeAccountPostgres,
  readAccountDeletionContext,
  startAccountDeletion,
  type Database,
} from '@openanalytics/postgres'
import { CLOUD_STREAM_PRESENT, applyPostgresStreams } from '../support/postgres-streams.ts'
import { ensureBillingAccount } from '../support/cloud-billing-fixtures.ts'
import { ACCOUNT_DELETION_REGISTRATION } from '../../apps/worker/src/jobs/account-deletion.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Account deletion against a real Postgres (ADR-0030, decision 8).
 *
 * Everything here needs a database to be true at all. The gate is a locking read
 * over two joins; the teardown is one transaction whose commit is judged by the
 * deferred ownership triggers; the tombstone has to survive a unique index that
 * every other account also lives under. None of that is a property of
 * TypeScript, and a fake would only prove that the repository calls the
 * functions this test expects.
 *
 * The claims, in the order the deletion makes them:
 *
 * 1. **The gate refuses with reasons.** A live site this user pays for blocks
 *    with `billing_owner`; a live site they solely own blocks with `sole_owner`;
 *    a site already `deleting` blocks with neither. A refusal writes nothing.
 * 2. **The start is one commit** — request, ten targets, job and audit row land
 *    together — and it is idempotent.
 * 3. **The teardown removes what it promises and keeps what it must.** Sessions,
 *    credentials, memberships gone; offers cancelled rather than deleted; the
 *    trial tombstone unlinked but intact; usage and billing history untouched.
 * 4. **It is re-runnable.** Every step tolerates having already happened, which
 *    is what makes a crashed worker recoverable rather than a half-erased
 *    account.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('account deletion', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m10acc_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database

  const makeUser = async (): Promise<{ id: string; email: string }> => {
    const id = newId()
    const email = `${id}@example.com`
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified, image, timezone)
       VALUES ($1, 'U', $2, true, 'https://img.test/a.png', 'Europe/Baku')`,
      [id, email],
    )
    return { id, email }
  }

  const makeSite = async (ownerUserId: string): Promise<string> => {
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId,
    })
    return siteId
  }

  const setStatus = async (siteId: string, status: string): Promise<void> => {
    await pool.query(`UPDATE sites SET status = $2 WHERE id = $1`, [siteId, status])
  }

  const addMember = async (siteId: string, userId: string, role: string): Promise<void> => {
    await pool.query(
      `INSERT INTO site_members (id, site_id, user_id, role) VALUES ($1, $2, $3, $4)`,
      [newId(), siteId, userId, role],
    )
  }

  const slugOf = async (siteId: string): Promise<string> => {
    const r = await pool.query<{ slug: string }>(`SELECT slug FROM sites WHERE id = $1`, [siteId])
    return r.rows[0]?.slug ?? ''
  }

  const countWhere = async (sql: string, params: unknown[]): Promise<number> => {
    const r = await pool.query<{ n: string }>(sql, params)
    return Number(r.rows[0]?.n ?? '0')
  }

  const requestsFor = async (userId: string): Promise<number> =>
    await countWhere(
      `SELECT count(*)::text AS n FROM deletion_requests
        WHERE subject_type = 'account' AND subject_id = $1`,
      [userId],
    )

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

    // The trial policy every claim below references. Trials are the hosted
    // service's, so this — and every other cloud-table seed in this file — only
    // happens where that stream has been applied.
    if (CLOUD_STREAM_PRESENT)
      await pool.query(
        `INSERT INTO trial_policies (id, version, enabled_at, duration_days, stripe_price_id)
         VALUES ($1, 1, now(), 14, 'price_starter_monthly')`,
        [newId()],
      )
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

  describe('the gate', () => {
    it('refuses while a site the user pays for is still live, naming it', async () => {
      const user = await makeUser()
      const siteId = await makeSite(user.id)

      await expect(startAccountDeletion(db, { userId: user.id })).rejects.toBeInstanceOf(
        AccountDeletionBlockedError,
      )

      try {
        await startAccountDeletion(db, { userId: user.id })
        expect.unreachable('the gate must refuse')
      } catch (error) {
        const blocked = error as AccountDeletionBlockedError
        expect(blocked.blockingSites).toEqual([
          { siteId, slug: await slugOf(siteId), reason: 'billing_owner' },
        ])
      }

      // A refusal writes nothing at all — the throw is the whole outcome.
      expect(await requestsFor(user.id)).toBe(0)
    })

    it('refuses a suspended site too: blocked is not resolved', async () => {
      // Only `deleting`/`deleted` mean somebody is already handling the site.
      // A blocked site is still a site somebody has to pay for.
      const user = await makeUser()
      const siteId = await makeSite(user.id)
      await setStatus(siteId, 'suspended')

      await expect(startAccountDeletion(db, { userId: user.id })).rejects.toBeInstanceOf(
        AccountDeletionBlockedError,
      )
    })

    it('refuses a live site the user solely owns, with reason sole_owner', async () => {
      // This state is unreachable while migration 0007's OA002 holds — the
      // billing owner must itself be an owner member, so today's sole owner is
      // always also the payer and would be reported as `billing_owner`. The
      // check exists for the other invariant, OA001: teardown deletes every one
      // of this user's memberships, and doing that to a live site with no other
      // owner is exactly what the trigger refuses at commit. Constructing it
      // here needs the trigger out of the way, which is the honest way to test a
      // defensive branch: the branch's whole purpose is a row the invariant says
      // cannot exist.
      const payer = await makeUser()
      const user = await makeUser()
      const siteId = await makeSite(payer.id)

      await pool.query(`ALTER TABLE site_members DISABLE TRIGGER site_members_ownership_invariant`)
      try {
        await pool.query(`DELETE FROM site_members WHERE site_id = $1`, [siteId])
        await addMember(siteId, user.id, 'owner')
      } finally {
        await pool.query(`ALTER TABLE site_members ENABLE TRIGGER site_members_ownership_invariant`)
      }

      try {
        await startAccountDeletion(db, { userId: user.id })
        expect.unreachable('the gate must refuse')
      } catch (error) {
        expect((error as AccountDeletionBlockedError).blockingSites).toEqual([
          { siteId, slug: await slugOf(siteId), reason: 'sole_owner' },
        ])
      }
    })

    it('passes when the user is one of several owners', async () => {
      // Teardown removes this member and the site keeps an owner: no invariant
      // depends on the account surviving.
      const payer = await makeUser()
      const user = await makeUser()
      const siteId = await makeSite(payer.id)
      await addMember(siteId, user.id, 'owner')

      const started = await startAccountDeletion(db, { userId: user.id })
      expect(started.started).toBe(true)
    })

    it('passes once every billed site is deleting or deleted', async () => {
      const user = await makeUser()
      const deleting = await makeSite(user.id)
      const deleted = await makeSite(user.id)
      await setStatus(deleting, 'deleting')
      await setStatus(deleted, 'deleted')

      const started = await startAccountDeletion(db, { userId: user.id })
      expect(started.started).toBe(true)
      expect(started.jobId).not.toBeNull()
    })

    it('reports billing_owner rather than sole_owner when a site is both', async () => {
      // A successor has to exist before there is anybody to promote, so naming
      // the second reason first would send the caller down a path that cannot
      // be walked yet.
      const user = await makeUser()
      const siteId = await makeSite(user.id)

      try {
        await startAccountDeletion(db, { userId: user.id })
        expect.unreachable('the gate must refuse')
      } catch (error) {
        const blocking = (error as AccountDeletionBlockedError).blockingSites
        expect(blocking).toHaveLength(1)
        expect(blocking[0]).toMatchObject({ siteId, reason: 'billing_owner' })
      }
    })
  })

  describe('the start transaction', () => {
    it('writes the exact target snapshot, the job and the audit row', async () => {
      const user = await makeUser()
      if (CLOUD_STREAM_PRESENT)
        await pool.query(
          `INSERT INTO subscriptions (id, billing_account_id, entitlement_state, plan_tier,
                                      stripe_subscription_id)
           VALUES ($1, $2, 'active', 'starter', $3)`,
          [
            newId(),
            await ensureBillingAccount(pool, user.id, { stripeCustomerId: `cus_${newId()}` }),
            `sub_${newId()}`,
          ],
        )

      const started = await startAccountDeletion(db, { userId: user.id })

      const targets = await listDeletionTargets(db, {
        deletionRequestId: started.deletionRequestId,
      })
      // The snapshot is the contract: exactly this vocabulary, no ClickHouse and
      // no Redis rows — an account owns no analytics data of its own.
      expect(targets.map((row) => `${row.store}:${row.target}`).sort()).toEqual(
        ACCOUNT_DELETION_TARGETS.map((row) => `${row.store}:${row.target}`).sort(),
      )
      expect(targets.filter((row) => row.store === 'clickhouse')).toEqual([])

      // The `stripe` store is the hosted surface's, and so is the target it
      // snapshots: `tests/migration/cloud/account-deletion-stripe.test.ts` pins
      // both. A build without that surface has neither.
      expect(targets.filter((row) => row.store === 'stripe')).toEqual([])

      const jobs = await pool.query<{ type: string; subject_id: string; status: string }>(
        `SELECT type, subject_id, status FROM jobs WHERE subject_id = $1`,
        [user.id],
      )
      expect(jobs.rows).toEqual([
        { type: 'account_deletion', subject_id: user.id, status: 'queued' },
      ])

      const audit = await pool.query<{ action: string; actor_type: string; target_id: string }>(
        `SELECT action, actor_type, target_id FROM audit_logs WHERE target_id = $1`,
        [user.id],
      )
      expect(audit.rows).toEqual([
        { action: 'account.deletion_requested', actor_type: 'user', target_id: user.id },
      ])
    })

    it('is idempotent: a second call finds the live request and mints no twin', async () => {
      const user = await makeUser()
      const first = await startAccountDeletion(db, { userId: user.id })
      const second = await startAccountDeletion(db, { userId: user.id })

      expect(second.deletionRequestId).toBe(first.deletionRequestId)
      expect(second.started).toBe(false)
      expect(second.jobId).toBe(first.jobId)
      expect(await requestsFor(user.id)).toBe(1)

      // One snapshot, not two — a doubled snapshot would make "every target
      // completed" pass over a half-torn-down account.
      const targets = await listDeletionTargets(db, {
        deletionRequestId: first.deletionRequestId,
      })
      expect(targets).toHaveLength(ACCOUNT_DELETION_TARGETS.length)
    })

    it('exposes the request through the context read the executor uses', async () => {
      const user = await makeUser()
      const started = await startAccountDeletion(db, { userId: user.id })

      const context = await readAccountDeletionContext(db, started.deletionRequestId)
      expect(context).toMatchObject({
        userId: user.id,
        requestStatus: 'pending',
        email: user.email,
      })
      expect(context?.requestedAt).toBeInstanceOf(Date)
    })
  })

  describe('the teardown', () => {
    /** An account with one of everything the teardown touches, plus the things it
     * must leave alone. */
    const populated = async () => {
      const user = await makeUser()
      const other = await makeUser()
      const siteId = await makeSite(user.id)
      // Deleting, so removing every membership is exempt from OA001 (0028's
      // amendment) — the same exemption a site deletion's own purge relies on.
      await setStatus(siteId, 'deleting')
      await addMember(siteId, other.id, 'admin')

      await pool.query(
        `INSERT INTO sessions (id, user_id, token, expires_at)
         VALUES ($1, $2, $3, now() + interval '7 days')`,
        [newId(), user.id, `tok-${newId()}`],
      )
      await pool.query(
        `INSERT INTO accounts (id, user_id, account_id, provider_id)
         VALUES ($1, $2, $3, 'google')`,
        [newId(), user.id, `acc-${newId()}`],
      )
      // Three verification shapes: the bare address, a prefixed identifier, and
      // a magic-link row whose identifier is an opaque token and whose *value*
      // carries the address.
      await pool.query(
        `INSERT INTO verifications (id, identifier, value, expires_at) VALUES
           ($1, $2, 'v1', now() + interval '15 minutes'),
           ($3, $4, 'v2', now() + interval '15 minutes'),
           ($5, $6, $7, now() + interval '15 minutes')`,
        [
          newId(),
          user.email,
          newId(),
          `reset-password:${user.email}`,
          newId(),
          `tok-${newId()}`,
          JSON.stringify({ email: user.email, name: 'U' }),
        ],
      )
      // A decoy belonging to somebody else, which must survive.
      await pool.query(
        `INSERT INTO verifications (id, identifier, value, expires_at)
         VALUES ($1, $2, 'other', now() + interval '15 minutes')`,
        [newId(), other.email],
      )
      await pool.query(
        `INSERT INTO site_invites (id, site_id, email, role, token_hash, invited_by_user_id, expires_at)
         VALUES ($1, $2, 'invitee@example.com', 'viewer', $3, $4, now() + interval '7 days')`,
        [newId(), siteId, `hash-${newId()}`, user.id],
      )
      // A chart note this account wrote, and one by somebody else that must
      // keep its author.
      await pool.query(
        `INSERT INTO chart_notes (id, site_id, at, text, created_by_user_id) VALUES
           ($1, $2, now(), 'mine', $3),
           ($4, $2, now(), 'theirs', $5)`,
        [newId(), siteId, user.id, newId(), other.id],
      )
      // The four rows the hosted surface owns. A build without that stream has
      // nowhere to put them, and the claims that read them back are guarded the
      // same way — what stays asserted here in every build is that the product
      // teardown does not touch tables it does not own.
      const identityHash = `ih-${newId()}`
      const windowId = newId()
      if (CLOUD_STREAM_PRESENT) {
        await pool.query(
          `INSERT INTO billing_transfer_offers (id, site_id, from_user_id, to_user_id, expires_at)
           VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
          [newId(), siteId, user.id, other.id],
        )
        await pool.query(
          `INSERT INTO subscriptions (id, billing_account_id, entitlement_state, plan_tier,
                                      stripe_subscription_id)
           VALUES ($1, $2, 'active', 'starter', $3)`,
          [
            newId(),
            await ensureBillingAccount(pool, user.id, { stripeCustomerId: `cus_${newId()}` }),
            `sub_${newId()}`,
          ],
        )
        await pool.query(
          `INSERT INTO trial_claims
             (id, identity_hash, key_version, normalizer_version, policy_version,
              user_id, stripe_subscription_id)
           VALUES ($1, $2, 1, 1, 1, $3, $4)`,
          [newId(), identityHash, user.id, `sub_trial_${newId()}`],
        )
        await pool.query(
          `INSERT INTO usage_windows
             (id, billing_account_id, kind, plan_tier, event_limit, starts_at, ends_at, quota_anchor_at)
           VALUES ($1, (SELECT id FROM billing_accounts WHERE owner_user_id = $2), 'paid', 'starter', 50000, now(), now() + interval '30 days', now())`,
          [windowId, user.id],
        )
      }

      return { user, other, siteId, identityHash, windowId }
    }

    it('removes, cancels, unlinks and scrubs exactly as the ADR specifies', async () => {
      const world = await populated()
      const { user, other } = world

      const result = await purgeAccountPostgres(db, { userId: user.id })

      expect(result.scrubbedFrom).toBe(user.email)
      // The hosted surface's three keys — `transfer_offers`, `subscriptions` and
      // `trial_claims_unlink` — are its purge step's, and are pinned beside it.
      expect(result.affected).toMatchObject({
        verifications: 3,
        sessions: 1,
        accounts: 1,
        memberships: 1,
        invites: 1,
        chart_notes_unlink: 1,
        user_tombstone: 1,
      })
      expect(result.affected).not.toHaveProperty('subscriptions')

      // Unlinked, not deleted: the note is the site's, the authorship was theirs.
      const notes = await pool.query<{ text: string; created_by_user_id: string | null }>(
        `SELECT text, created_by_user_id FROM chart_notes WHERE site_id = $1 ORDER BY text`,
        [world.siteId],
      )
      expect(notes.rows).toEqual([
        { text: 'mine', created_by_user_id: null },
        { text: 'theirs', created_by_user_id: other.id },
      ])

      // Gone.
      expect(
        await countWhere(`SELECT count(*)::text AS n FROM sessions WHERE user_id = $1`, [user.id]),
      ).toBe(0)
      expect(
        await countWhere(`SELECT count(*)::text AS n FROM accounts WHERE user_id = $1`, [user.id]),
      ).toBe(0)
      expect(
        await countWhere(`SELECT count(*)::text AS n FROM site_members WHERE user_id = $1`, [
          user.id,
        ]),
      ).toBe(0)
      // `subscriptions` is not erased here: the row is the hosted surface's, and so
      // is the purge step that deletes it (`tests/migration/cloud/
      // account-deletion-stripe.test.ts`). A build without that surface leaves the
      // row exactly where it is, which is the honest answer for a table it does not
      // own — and in a build with no such table at all there is nothing to read.
      if (CLOUD_STREAM_PRESENT)
        expect(
          await countWhere(
            `SELECT count(*)::text AS n FROM subscriptions
              WHERE billing_account_id = (SELECT id FROM billing_accounts WHERE owner_user_id = $1)`,
            [user.id],
          ),
        ).toBe(1)

      // The other account's verification is untouched: the match is literal, so
      // an address containing `_` cannot wildcard into somebody else's row.
      expect(
        await countWhere(`SELECT count(*)::text AS n FROM verifications WHERE identifier = $1`, [
          other.email,
        ]),
      ).toBe(1)

      // Unlinked, not deleted.
      const invite = await pool.query<{ invited_by_user_id: string | null; status: string }>(
        `SELECT invited_by_user_id, status FROM site_invites WHERE site_id = $1`,
        [world.siteId],
      )
      expect(invite.rows[0]).toEqual({ invited_by_user_id: null, status: 'pending' })

      if (CLOUD_STREAM_PRESENT) {
        // Cancelled, not deleted: the offer history belongs to a site that in most
        // cases still has another owner. That cancellation is the hosted purge step's
        // — `transfer_offers` is one of the three keys it adds — so a build without
        // that surface leaves the row `pending` and untouched, which is the honest
        // answer for a table it does not own
        // (`tests/migration/cloud/account-deletion-stripe.test.ts` pins the other).
        const offer = await pool.query<{ status: string; responded_at: Date | null }>(
          `SELECT status, responded_at FROM billing_transfer_offers WHERE site_id = $1`,
          [world.siteId],
        )
        expect(offer.rows[0]?.status).toBe('pending')
        expect(offer.rows[0]?.responded_at).toBeNull()

        // The D-021 tombstone. Its *unlinking* is the hosted purge step's third key,
        // so here the claim is simply untouched — identity hash, account link and
        // provider reference all still as they were.
        const claim = await pool.query<{
          identity_hash: string
          user_id: string | null
          stripe_subscription_id: string | null
        }>(
          `SELECT identity_hash, user_id, stripe_subscription_id FROM trial_claims WHERE identity_hash = $1`,
          [world.identityHash],
        )
        expect(claim.rows[0]).toMatchObject({
          identity_hash: world.identityHash,
          user_id: user.id,
        })
        // Still naming the provider subscription it was claimed with: severing that
        // reference is the hosted purge step's `trial_claims_unlink`.
        expect(claim.rows[0]?.stripe_subscription_id).toMatch(/^sub_trial_/u)

        // Metering history survives — it is anti-abuse and billing record, and it
        // is why the users row is a tombstone rather than a deletion.
        expect(
          await countWhere(
            `SELECT count(*)::text AS n FROM usage_windows
              WHERE billing_account_id = (SELECT id FROM billing_accounts WHERE owner_user_id = $1)`,
            [user.id],
          ),
        ).toBe(1)
      }

      // The scrub, exactly.
      const scrubbed = await pool.query<{
        email: string
        name: string
        image: string | null
        timezone: string | null
      }>(`SELECT email, name, image, timezone FROM users WHERE id = $1`, [user.id])
      expect(scrubbed.rows[0]).toEqual({
        email: accountTombstoneEmail(user.id),
        name: '',
        image: null,
        timezone: null,
      })
    })

    it('is safe to run twice — the second pass affects nothing', async () => {
      const world = await populated()
      await purgeAccountPostgres(db, { userId: world.user.id })
      const second = await purgeAccountPostgres(db, { userId: world.user.id })

      expect(second.affected).toMatchObject({
        verifications: 0,
        sessions: 0,
        accounts: 0,
        memberships: 0,
        invites: 0,
        chart_notes_unlink: 0,
        // The scrub is an UPDATE of the tombstone to itself: still one row, and
        // still the same values.
        user_tombstone: 1,
      })
      expect(second.scrubbedFrom).toBe(accountTombstoneEmail(world.user.id))

      const scrubbed = await pool.query<{ email: string }>(
        `SELECT email FROM users WHERE id = $1`,
        [world.user.id],
      )
      expect(scrubbed.rows[0]?.email).toBe(accountTombstoneEmail(world.user.id))
    })

    it('refuses to leave a live site ownerless — the gate now says so first', async () => {
      // This construction used to reach `assert_site_ownership` and fail OA001
      // at the teardown's commit. It no longer gets that far: the teardown
      // re-runs both gate checks inside its own transaction, so the refusal is
      // named ("this site blocks, for this reason") instead of arriving as a
      // deferred trigger's message about an invariant. The trigger is still the
      // last line of defence for whatever commits in the sliver the locking read
      // cannot see — a brand-new site naming this account as its payer — which
      // is why the assertion below is that *nothing committed*, whichever of the
      // two refused.
      const user = await makeUser()
      const siteId = await makeSite(user.id)

      let raised: unknown = null
      try {
        await purgeAccountPostgres(db, { userId: user.id })
      } catch (error) {
        raised = error
      }
      expect(raised).toBeInstanceOf(AccountDeletionBlockedError)
      expect((raised as AccountDeletionBlockedError).blockingSites).toEqual([
        { siteId, slug: await slugOf(siteId), reason: 'billing_owner' },
      ])

      // Nothing committed: the account is intact.
      const intact = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
        user.id,
      ])
      expect(intact.rows[0]?.email).toBe(user.email)
      expect(
        await countWhere(`SELECT count(*)::text AS n FROM site_members WHERE user_id = $1`, [
          user.id,
        ]),
      ).toBe(1)
    })
  })

  describe('the gate, re-run inside the teardown', () => {
    /**
     * The gate the *start* ran was a different transaction, possibly days
     * earlier. Between the two, a transfer offer can be accepted or a site
     * created, and the account becomes a live site's payer or sole owner again.
     * `await_site_deletions` catches the billing half at the start of the job
     * and cannot catch anything that lands after it; the check inside
     * `purgeAccountPostgres` shares a commit with the deletes, so there is no
     * window at all between passing it and erasing.
     */
    it('refuses to erase an account that was re-billed after the request', async () => {
      const user = await makeUser()
      const started = await startAccountDeletion(db, { userId: user.id })
      expect(started.started).toBe(true)

      // Exactly what accepting a handover does: the account becomes an owner
      // member of somebody else's site and then its billing owner.
      const payer = await makeUser()
      const siteId = await makeSite(payer.id)
      await addMember(siteId, user.id, 'owner')
      await pool.query(`UPDATE sites SET owner_user_id = $2 WHERE id = $1`, [siteId, user.id])

      let raised: unknown = null
      try {
        await purgeAccountPostgres(db, { userId: user.id })
      } catch (error) {
        raised = error
      }
      expect(raised).toBeInstanceOf(AccountDeletionBlockedError)
      expect((raised as AccountDeletionBlockedError).blockingSites).toEqual([
        { siteId, slug: await slugOf(siteId), reason: 'billing_owner' },
      ])

      // The throw rolls the whole teardown back: nothing is half-erased.
      const intact = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
        user.id,
      ])
      expect(intact.rows[0]?.email).toBe(user.email)
      expect(
        await countWhere(`SELECT count(*)::text AS n FROM site_members WHERE user_id = $1`, [
          user.id,
        ]),
      ).toBe(1)
    })

    it('refuses on the sole-ownership half too, not only the billing one', async () => {
      // Same construction as the gate's own sole-owner case: the state is
      // unreachable while OA002 holds, so the trigger comes off to build it. The
      // branch's whole purpose is a row the invariant says cannot exist.
      const user = await makeUser()
      await startAccountDeletion(db, { userId: user.id })

      const payer = await makeUser()
      const siteId = await makeSite(payer.id)
      await pool.query(`ALTER TABLE site_members DISABLE TRIGGER site_members_ownership_invariant`)
      try {
        await pool.query(`DELETE FROM site_members WHERE site_id = $1`, [siteId])
        await addMember(siteId, user.id, 'owner')
      } finally {
        await pool.query(`ALTER TABLE site_members ENABLE TRIGGER site_members_ownership_invariant`)
      }

      let raised: unknown = null
      try {
        await purgeAccountPostgres(db, { userId: user.id })
      } catch (error) {
        raised = error
      }
      expect(raised).toBeInstanceOf(AccountDeletionBlockedError)
      expect((raised as AccountDeletionBlockedError).blockingSites).toEqual([
        { siteId, slug: await slugOf(siteId), reason: 'sole_owner' },
      ])
    })

    it('still erases an account whose sites are all deleting or deleted', async () => {
      // The check must not become a second, stricter gate: a site being deleted
      // by its own job is precisely what the account deletion waits for.
      const user = await makeUser()
      const siteId = await makeSite(user.id)
      await setStatus(siteId, 'deleting')

      const result = await purgeAccountPostgres(db, { userId: user.id })
      expect(result.affected['user_tombstone']).toBe(1)
    })
  })

  describe('the verifications match', () => {
    /**
     * The match is delimiter-anchored, and this is the scenario that proves why.
     * `right(identifier, length(email))` alone matches any identifier merely
     * *ending* in the address, so erasing `a@…` would delete `ba@…`'s live
     * sign-in rows — a different person's magic link, cancelled as a side effect
     * of somebody else's deletion.
     */
    const seedVerifications = async (address: string): Promise<void> => {
      await pool.query(
        `INSERT INTO verifications (id, identifier, value, expires_at) VALUES
           ($1, $2, 'bare', now() + interval '15 minutes'),
           ($3, $4, 'prefixed', now() + interval '15 minutes'),
           ($5, $6, $7, now() + interval '15 minutes')`,
        [
          newId(),
          address,
          newId(),
          `reset-password:${address}`,
          newId(),
          `tok-${newId()}`,
          JSON.stringify({ email: address, name: 'U' }),
        ],
      )
    }

    const verificationsFor = async (address: string): Promise<number> =>
      await countWhere(
        `SELECT count(*)::text AS n FROM verifications
          WHERE identifier = $1 OR identifier = $2 OR value LIKE $3`,
        [address, `reset-password:${address}`, `%"${address}"%`],
      )

    it('leaves an address that merely ends with the deleted one completely alone', async () => {
      const tag = newId().slice(0, 8)
      const email = `a${tag}@example.com`
      const neighbour = `ba${tag}@example.com`

      const userId = newId()
      await pool.query(
        `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
        [userId, email],
      )
      await seedVerifications(email)
      await seedVerifications(neighbour)

      expect(await verificationsFor(email)).toBe(3)
      expect(await verificationsFor(neighbour)).toBe(3)

      const result = await purgeAccountPostgres(db, { userId })

      // All three of the deleted account's shapes are gone — the anchoring did
      // not cost the match it exists to make.
      expect(result.affected['verifications']).toBe(3)
      expect(await verificationsFor(email)).toBe(0)
      // …and every one of the neighbour's survives, including the magic-link row
      // whose *value* embeds an address ending in the deleted one.
      expect(await verificationsFor(neighbour)).toBe(3)
    })
  })

  describe('the api_keys_revoke target', () => {
    /**
     * A `private_read` key is a secret this person minted, and the row is
     * site-scoped — it lives on a site that is not being deleted, so nothing
     * else in the teardown would ever touch it. Left alone, a deleted account's
     * token keeps reading a live customer's analytics.
     */
    const insertKey = async (
      siteId: string,
      userId: string,
      type: 'private_read' | 'tracking_write',
      revokedAt: Date | null,
    ): Promise<string> => {
      const id = newId()
      await pool.query(
        `INSERT INTO api_keys (id, site_id, type, key_prefix, key_hash, public_token,
                               created_by_user_id, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          siteId,
          type,
          `pk_${id.slice(0, 6)}`,
          `hash-${id}`,
          type === 'tracking_write' ? `tok-${id}` : null,
          userId,
          revokedAt,
        ],
      )
      return id
    }

    it('revokes the account’s live private keys and preserves an earlier revocation', async () => {
      const payer = await makeUser()
      const user = await makeUser()
      const siteId = await makeSite(payer.id)
      // A member of somebody else's live site: the site survives this deletion,
      // which is exactly the case where a surviving key would still work.
      await addMember(siteId, user.id, 'admin')

      const live = await insertKey(siteId, user.id, 'private_read', null)
      const alreadyRevoked = new Date('2026-07-01T00:00:00.000Z')
      const old = await insertKey(siteId, user.id, 'private_read', alreadyRevoked)
      const tracking = await insertKey(siteId, user.id, 'tracking_write', null)

      const result = await purgeAccountPostgres(db, { userId: user.id })
      expect(result.affected['api_keys_revoke']).toBe(1)

      const rows = await pool.query<{ id: string; revoked_at: Date | null }>(
        `SELECT id, revoked_at FROM api_keys WHERE id = ANY($1::uuid[])`,
        [[live, old, tracking]],
      )
      const byId = new Map(rows.rows.map((row) => [row.id, row.revoked_at]))
      expect(byId.get(live)).not.toBeNull()
      // An earlier revocation is a fact about when access ended; overwriting it
      // with now() would move an event that already happened.
      expect(byId.get(old)?.toISOString()).toBe(alreadyRevoked.toISOString())
      // The site's public tracker token is the *site's* credential, not this
      // person's: revoking it would stop a live site collecting events.
      expect(byId.get(tracking)).toBeNull()
    })

    it('counts zero rather than omitting the target for an account with no keys', async () => {
      const user = await makeUser()
      const result = await purgeAccountPostgres(db, { userId: user.id })
      expect(result.affected['api_keys_revoke']).toBe(0)
      expect(result.affected['api_keys_rotation_required']).toBe(0)
    })

    /**
     * ADR-0043 D8. This target used to be the whole story and it took too much
     * with it: a key this person *installed into a machine* — the WordPress
     * plugin's — lives on a site that now belongs to somebody else, and
     * revoking it turns "delete my account" into a way to break a former
     * employer's site.
     *
     * The key survives and says so. That is not a free pass: the departed
     * person still knows its value, which is why `rotation_required_at` is
     * stamped and reported rather than the exposure being left silent.
     */
    it('keeps a key the account installed into a machine, and reports it as needing rotation', async () => {
      const payer = await makeUser()
      const user = await makeUser()
      const siteId = await makeSite(payer.id)
      await addMember(siteId, user.id, 'admin')

      const personal = await insertKey(siteId, user.id, 'private_read', null)
      const installed = newId()
      await pool.query(
        `INSERT INTO api_keys (id, site_id, type, key_prefix, key_hash, created_by_user_id, held_by)
         VALUES ($1, $2, 'private_read', $3, $4, $5, 'site')`,
        [installed, siteId, `pk_${installed.slice(0, 6)}`, `hash-${installed}`, user.id],
      )

      const result = await purgeAccountPostgres(db, { userId: user.id })
      // The two counts partition the person's live keys; neither alone would
      // describe what happened.
      expect(result.affected['api_keys_revoke']).toBe(1)
      expect(result.affected['api_keys_rotation_required']).toBe(1)

      const rows = await pool.query<{
        id: string
        revoked_at: Date | null
        rotation_required_at: Date | null
        created_by_user_id: string | null
      }>(
        `SELECT id, revoked_at, rotation_required_at, created_by_user_id
           FROM api_keys WHERE id = ANY($1::uuid[])`,
        [[personal, installed]],
      )
      const byId = new Map(rows.rows.map((row) => [row.id, row]))
      expect(byId.get(personal)?.revoked_at).not.toBeNull()
      expect(byId.get(installed)?.revoked_at).toBeNull()
      expect(byId.get(installed)?.rotation_required_at).not.toBeNull()
      // `created_by_user_id` is ON DELETE SET NULL, but the account row is
      // scrubbed rather than deleted, so the surviving key still names who
      // installed it — which is what makes the rotation prompt answerable.
      expect(byId.get(installed)?.created_by_user_id).toBe(user.id)
    })
  })

  describe('the idempotency_keys target', () => {
    /**
     * Added 2026-08-06. The table looks covered by its own foreign key and is
     * not: `idempotency_keys.user_id` is `REFERENCES users (id) ON DELETE
     * CASCADE` (migration 0019), but the teardown scrubs the `users` row rather
     * than deleting it (D8), so the cascade has no delete to follow and never
     * fires. That is what makes this worth a test of its own — the mechanism
     * that appears to handle it is the one that cannot.
     */
    const insertKey = async (userId: string, key: string): Promise<void> => {
      await pool.query(
        `INSERT INTO idempotency_keys (id, user_id, scope, key, request_hash,
                                       response_status, response_body, completed_at)
         VALUES ($1, $2, 'sites.create', $3, 'h', 201, $4, now())`,
        [newId(), userId, key, JSON.stringify({ slug: 'acme', name: 'Acme' })],
      )
    }

    it('erases the account’s claims and leaves another caller’s alone', async () => {
      const user = await makeUser()
      const other = await makeUser()
      await insertKey(user.id, 'k-1')
      await insertKey(user.id, 'k-2')
      // The same key string from a different caller. The grain is
      // (user_id, scope, key), so this row is a stranger's and must survive.
      await insertKey(other.id, 'k-1')

      const result = await purgeAccountPostgres(db, { userId: user.id })
      expect(result.affected['idempotency_keys']).toBe(2)

      const mine = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM idempotency_keys WHERE user_id = $1`,
        [user.id],
      )
      expect(Number(mine.rows[0]?.n)).toBe(0)
      const theirs = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM idempotency_keys WHERE user_id = $1`,
        [other.id],
      )
      expect(Number(theirs.rows[0]?.n)).toBe(1)
    })

    it('leaves no row behind for the surviving users tombstone to cascade from', async () => {
      // The scrub keeps the `users` row alive on purpose, so this asserts the
      // rows are gone *and* that the row they referenced still exists — the
      // exact combination that made the declared cascade dead.
      const user = await makeUser()
      await insertKey(user.id, 'k-1')

      await purgeAccountPostgres(db, { userId: user.id })

      const survivor = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM users WHERE id = $1`,
        [user.id],
      )
      expect(Number(survivor.rows[0]?.n), 'the users row is scrubbed, not deleted').toBe(1)
      const rows = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM idempotency_keys WHERE user_id = $1`,
        [user.id],
      )
      expect(Number(rows.rows[0]?.n)).toBe(0)
    })

    it('counts zero rather than omitting the target for an account that sent no keys', async () => {
      const user = await makeUser()
      const result = await purgeAccountPostgres(db, { userId: user.id })
      expect(result.affected['idempotency_keys']).toBe(0)
    })
  })

  describe('the authorization server’s three targets (ADR-0043, D9)', () => {
    /**
     * Added 2026-08-06 with migration 0045, in the same change that created the
     * tables rather than eight milestones later.
     *
     * This is the `idempotency_keys` lesson applied at the right moment. Better
     * Auth's declared schema puts `ON DELETE CASCADE` on every one of these
     * `user_id` columns; migration 0045 deliberately omits it, because the
     * teardown scrubs the `users` row and a cascade with no delete to follow
     * never fires. So the coverage has to be these three statements, and the
     * assertion below is the one that would have caught the old bug: the rows
     * are gone **and** the `users` row they referenced is still there.
     */
    const insertToken = async (userId: string, tag: string): Promise<void> => {
      await pool.query(
        `INSERT INTO oauth_access_tokens (id, access_token, refresh_token,
                                          access_token_expires_at, refresh_token_expires_at,
                                          client_id, user_id, scopes)
         VALUES ($1, $2, $3, now() + interval '1 hour', now() + interval '30 days',
                 'oa-cli', $4, 'site:read analytics:read')`,
        [newId(), `at-${tag}`, `rt-${tag}`, userId],
      )
    }

    const insertConsent = async (userId: string): Promise<void> => {
      await pool.query(
        `INSERT INTO oauth_consents (id, client_id, user_id, scopes, consent_given)
         VALUES ($1, 'oa-mcp', $2, 'site:read', true)`,
        [newId(), userId],
      )
    }

    const insertDeviceCode = async (userId: string | null, tag: string): Promise<void> => {
      await pool.query(
        `INSERT INTO device_codes (id, device_code, user_code, user_id, expires_at,
                                   status, client_id, scope)
         VALUES ($1, $2, $3, $4, now() + interval '10 minutes', $5, 'oa-cli', 'site:read')`,
        [newId(), `dc-${tag}`, `uc-${tag}`, userId, userId === null ? 'pending' : 'approved'],
      )
    }

    it('erases this account’s tokens, consents and device codes, and no stranger’s', async () => {
      const user = await makeUser()
      const other = await makeUser()
      await insertToken(user.id, 'mine-1')
      await insertToken(user.id, 'mine-2')
      await insertToken(other.id, 'theirs')
      await insertConsent(user.id)
      await insertConsent(other.id)
      await insertDeviceCode(user.id, 'mine')
      await insertDeviceCode(other.id, 'theirs')
      // An unapproved code belongs to nobody yet — `user_id` is null until
      // somebody approves it — so it is not this account's to erase.
      await insertDeviceCode(null, 'unclaimed')

      const result = await purgeAccountPostgres(db, { userId: user.id })
      expect(result.affected['oauth_access_tokens']).toBe(2)
      expect(result.affected['oauth_consents']).toBe(1)
      expect(result.affected['device_codes']).toBe(1)

      const count = async (table: string, userId: string): Promise<number> => {
        const rows = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${table} WHERE user_id = $1`,
          [userId],
        )
        return Number(rows.rows[0]?.n)
      }
      expect(await count('oauth_access_tokens', user.id)).toBe(0)
      expect(await count('oauth_consents', user.id)).toBe(0)
      expect(await count('device_codes', user.id)).toBe(0)
      expect(await count('oauth_access_tokens', other.id)).toBe(1)
      expect(await count('oauth_consents', other.id)).toBe(1)
      expect(await count('device_codes', other.id)).toBe(1)

      const unclaimed = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM device_codes WHERE user_id IS NULL`,
      )
      expect(Number(unclaimed.rows[0]?.n)).toBe(1)
    })

    it('leaves no row behind for the surviving users tombstone to cascade from', async () => {
      // The combination that made `idempotency_keys`' declared cascade dead: the
      // rows are gone and the `users` row is still alive. If these deletes were
      // ever removed in the belief that a foreign key handles it, this fails.
      const user = await makeUser()
      await insertToken(user.id, 'live')

      await purgeAccountPostgres(db, { userId: user.id })

      const survivor = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM users WHERE id = $1`,
        [user.id],
      )
      expect(Number(survivor.rows[0]?.n), 'the users row is scrubbed, not deleted').toBe(1)
      const tokens = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM oauth_access_tokens WHERE user_id = $1`,
        [user.id],
      )
      expect(Number(tokens.rows[0]?.n)).toBe(0)
    })

    it('counts zero rather than omitting the targets for an account that never used OAuth', async () => {
      const user = await makeUser()
      const result = await purgeAccountPostgres(db, { userId: user.id })
      expect(result.affected['oauth_access_tokens']).toBe(0)
      expect(result.affected['oauth_consents']).toBe(0)
      expect(result.affected['device_codes']).toBe(0)
    })
  })

  describe('the revenue_credentials_revoke target (ADR-0033, D3/D8)', () => {
    /**
     * The same argument as `api_keys_revoke`, one milestone later, and the
     * stakes are higher: the row holds a **customer's payment-provider key**,
     * encrypted, on a site that is not being deleted. Nothing else in an account
     * teardown reaches it — the site's own purge is a different deletion with a
     * different snapshot — so without this target the sync loop would keep
     * decrypting and using that key forever on behalf of an account that no
     * longer exists.
     */
    const connectCredential = async (
      siteId: string,
      userId: string,
      provider = 'stripe',
    ): Promise<string> => {
      const id = newId()
      await pool.query(
        `INSERT INTO revenue_credentials
           (id, site_id, provider, encrypted_api_key, encrypted_webhook_secret,
            key_version, api_key_last4, webhook_token, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, 'k1', '1234', $6, $7)`,
        [id, siteId, provider, `k1.nonce.api-${id}`, `k1.nonce.whsec-${id}`, `tok-${id}`, userId],
      )
      return id
    }

    const credentialRow = async (id: string) =>
      (
        await pool.query<{
          status: string
          encrypted_api_key: string | null
          encrypted_webhook_secret: string | null
          disabled_at: Date | null
        }>(
          `SELECT status, encrypted_api_key, encrypted_webhook_secret, disabled_at
             FROM revenue_credentials WHERE id = $1`,
          [id],
        )
      ).rows[0]

    it('disables the credentials the account connected and erases both ciphertexts', async () => {
      const payer = await makeUser()
      const admin = await makeUser()
      const sibling = await makeUser()
      // Somebody else's live site the account merely administers — exactly the
      // case where a surviving credential would keep syncing.
      const siteId = await makeSite(payer.id)
      await addMember(siteId, admin.id, 'admin')
      await addMember(siteId, sibling.id, 'admin')

      const theirs = await connectCredential(siteId, admin.id)
      // A second site, so "unscoped by site" is asserted rather than assumed: a
      // per-site loop would need the membership rows the teardown deletes.
      const otherSite = await makeSite(payer.id)
      await addMember(otherSite, admin.id, 'admin')
      const alsoTheirs = await connectCredential(otherSite, admin.id)
      // Same site, different provider — the live unique is per (site, provider),
      // and using a second provider is what makes this row prove the filter is
      // `created_by_user_id` rather than the site.
      const notTheirs = await connectCredential(otherSite, sibling.id, 'polar')

      const result = await purgeAccountPostgres(db, { userId: admin.id })
      expect(result.affected['revenue_credentials_revoke']).toBe(2)

      for (const id of [theirs, alsoTheirs]) {
        const row = await credentialRow(id)
        expect(row?.status).toBe('disabled')
        expect(row?.encrypted_api_key).toBeNull()
        expect(row?.encrypted_webhook_secret).toBeNull()
        expect(row?.disabled_at).not.toBeNull()
      }

      // A sibling user's credential on the same site is not collateral damage —
      // and it is still *decryptable*, not merely present.
      const survivor = await credentialRow(notTheirs)
      expect(survivor?.status).toBe('active')
      expect(survivor?.encrypted_api_key).not.toBeNull()
      expect(survivor?.encrypted_webhook_secret).not.toBeNull()
    })

    it('counts zero rather than omitting the target for an account with none', async () => {
      const user = await makeUser()
      const result = await purgeAccountPostgres(db, { userId: user.id })
      expect(result.affected['revenue_credentials_revoke']).toBe(0)
    })

    it('is safe to run twice', async () => {
      // The second pass finds the row already disabled and the erase statement's
      // `status <> 'disabled'` guard skips it, so the count drops to zero rather
      // than rewriting a `disabled_at` that already records when access ended.
      const payer = await makeUser()
      const admin = await makeUser()
      const siteId = await makeSite(payer.id)
      await addMember(siteId, admin.id, 'admin')
      const credentialId = await connectCredential(siteId, admin.id)

      const first = await purgeAccountPostgres(db, { userId: admin.id })
      expect(first.affected['revenue_credentials_revoke']).toBe(1)
      const disabledAt = (await credentialRow(credentialId))?.disabled_at

      const second = await purgeAccountPostgres(db, { userId: admin.id })
      expect(second.affected['revenue_credentials_revoke']).toBe(0)
      expect((await credentialRow(credentialId))?.disabled_at?.toISOString()).toBe(
        disabledAt?.toISOString(),
      )
    })
  })

  describe('the assistant_usage_ledger target (ADR-0046, D5)', () => {
    /**
     * The seventeenth Postgres target, added with migration 0049.
     *
     * The table holds no message text, no tool arguments and no answers — only
     * counts — and it would still be wrong to leave it. Counts under a user id
     * are that user's data, and the registry is the mechanism for saying so.
     * The contrast worth being exact about is `read_cost_ledger`, which is in
     * *neither* registry: that table is keyed by a credential, and what remains
     * after the credential is deleted "is a number that describes nothing about
     * anybody". This one is keyed by a person.
     *
     * It is also the `idempotency_keys` lesson applied at the moment the table
     * was written rather than eight milestones later: migration 0049 declares
     * the foreign key with no action at all, because `user_tombstone` scrubs the
     * `users` row and a cascade that can never fire reads as coverage.
     */
    const charge = async (userId: string, hoursAgo: number): Promise<void> => {
      await pool.query(
        `INSERT INTO assistant_usage_ledger
           (user_id, hour_bucket, question_count, input_tokens, output_tokens)
         VALUES ($1, date_trunc('hour', now()) - make_interval(hours => $2::int), 1, 500, 120)`,
        [userId, hoursAgo],
      )
    }

    it('erases this account’s buckets and leaves another user’s alone', async () => {
      const user = await makeUser()
      const other = await makeUser()
      await charge(user.id, 0)
      await charge(user.id, 3)
      await charge(other.id, 0)

      const result = await purgeAccountPostgres(db, { userId: user.id })
      expect(result.affected['assistant_usage_ledger']).toBe(2)

      expect(
        await countWhere(
          `SELECT count(*)::text AS n FROM assistant_usage_ledger WHERE user_id = $1`,
          [user.id],
        ),
      ).toBe(0)
      expect(
        await countWhere(
          `SELECT count(*)::text AS n FROM assistant_usage_ledger WHERE user_id = $1`,
          [other.id],
        ),
      ).toBe(1)
    })

    it('leaves no row behind for the surviving users tombstone to cascade from', async () => {
      // The combination that made `idempotency_keys`' declared cascade dead: the
      // rows are gone *and* the `users` row they referenced is still there.
      const user = await makeUser()
      await charge(user.id, 0)

      await purgeAccountPostgres(db, { userId: user.id })

      expect(
        await countWhere(`SELECT count(*)::text AS n FROM users WHERE id = $1`, [user.id]),
      ).toBe(1)
      expect(
        await countWhere(
          `SELECT count(*)::text AS n FROM assistant_usage_ledger WHERE user_id = $1`,
          [user.id],
        ),
      ).toBe(0)
    })

    it('counts zero rather than omitting the target for an account that never asked', async () => {
      const user = await makeUser()
      const result = await purgeAccountPostgres(db, { userId: user.id })
      expect(result.affected['assistant_usage_ledger']).toBe(0)
    })
  })

  describe('a job the runner gave up on', () => {
    /** What the runner does after a terminal settlement: the registration's own
     * hook, against the same database. */
    const runTerminalHook = async (
      jobId: string,
      userId: string,
      payload: Record<string, unknown>,
      reason: string,
    ): Promise<void> => {
      await pool.query(`UPDATE jobs SET status = 'failed_terminal' WHERE id = $1`, [jobId])
      await ACCOUNT_DELETION_REGISTRATION.onTerminal?.(
        {
          id: jobId,
          type: 'account_deletion',
          subjectId: userId,
          payload,
          phase: 'postgres_teardown',
          attempts: 100,
          claimedBy: 'w-1',
          leaseExpiresAt: new Date(),
          createdAt: new Date(),
        },
        reason,
        { db } as unknown as Parameters<
          NonNullable<typeof ACCOUNT_DELETION_REGISTRATION.onTerminal>
        >[2],
      )
    }

    it('marks the request failed, audits it, and lets the next request start a real one', async () => {
      // The defect this closes: a `pending` request behind a dead job made every
      // later DELETE /v1/me return that request's id — an account permanently
      // unable to be deleted, reporting success each time.
      const user = await makeUser()
      const first = await startAccountDeletion(db, { userId: user.id })

      await runTerminalHook(
        first.jobId as string,
        user.id,
        { deletion_request_id: first.deletionRequestId },
        'attempts exhausted: deadlock detected',
      )

      const request = await pool.query<{ status: string; completed_at: Date | null }>(
        `SELECT status, completed_at FROM deletion_requests WHERE id = $1`,
        [first.deletionRequestId],
      )
      expect(request.rows[0]?.status).toBe('failed')
      expect(request.rows[0]?.completed_at).toBeNull()

      const audit = await pool.query<{ actor_type: string; metadata: Record<string, unknown> }>(
        `SELECT actor_type, metadata FROM audit_logs
          WHERE action = 'account.deletion_failed' AND target_id = $1`,
        [user.id],
      )
      expect(audit.rows).toHaveLength(1)
      expect(audit.rows[0]?.actor_type).toBe('system')
      expect(audit.rows[0]?.metadata).toMatchObject({
        deletion_request_id: first.deletionRequestId,
        reason: 'attempts exhausted: deadlock detected',
      })

      // The executor marks the request itself on the paths where it knows why —
      // a re-acquired site, a blocked purge — and the runner's hook then calls
      // again with the same reason. One failure, one audit row.
      await markAccountDeletionFailed(db, {
        deletionRequestId: first.deletionRequestId,
        userId: user.id,
        reason: 'attempts exhausted: deadlock detected',
      })
      expect(
        await countWhere(
          `SELECT count(*)::text AS n FROM audit_logs
            WHERE action = 'account.deletion_failed' AND target_id = $1`,
          [user.id],
        ),
      ).toBe(1)

      // A `failed` request is not live, so the next call starts a real deletion
      // with its own snapshot rather than reporting the dead one.
      const second = await startAccountDeletion(db, { userId: user.id })
      expect(second.started).toBe(true)
      expect(second.deletionRequestId).not.toBe(first.deletionRequestId)
      expect(second.jobId).not.toBe(first.jobId)
      expect(await requestsFor(user.id)).toBe(2)
    })

    it('never rewrites an already completed request as failed', async () => {
      // The attempts guard can fire on a job that outlived its own successful
      // finalization. Saying a completed erasure failed would be a lie the audit
      // trail cannot afford.
      const user = await makeUser()
      const started = await startAccountDeletion(db, { userId: user.id })
      await finalizeAccountDeletion(db, {
        deletionRequestId: started.deletionRequestId,
        userId: user.id,
      })

      await markAccountDeletionFailed(db, {
        deletionRequestId: started.deletionRequestId,
        userId: user.id,
        reason: 'attempts exhausted: something',
      })

      const request = await pool.query<{ status: string }>(
        `SELECT status FROM deletion_requests WHERE id = $1`,
        [started.deletionRequestId],
      )
      expect(request.rows[0]?.status).toBe('completed')
    })
  })

  describe('the reads the phases make', () => {
    it('reports every billed site with its status, for the await phase', async () => {
      const user = await makeUser()
      const a = await makeSite(user.id)
      const b = await makeSite(user.id)
      await setStatus(a, 'deleting')
      await setStatus(b, 'deleted')

      const states = await listBilledSiteStates(db, user.id)
      expect(states.map((row) => row.status).sort()).toEqual(['deleted', 'deleting'])
      expect(states.map((row) => row.siteId).sort()).toEqual([a, b].sort())
    })
  })

  describe('finalize', () => {
    it('completes the request, audits it as the system, and announces it once', async () => {
      const user = await makeUser()
      const started = await startAccountDeletion(db, { userId: user.id })

      await finalizeAccountDeletion(db, {
        deletionRequestId: started.deletionRequestId,
        userId: user.id,
      })

      const request = await pool.query<{ status: string; completed_at: Date | null }>(
        `SELECT status, completed_at FROM deletion_requests WHERE id = $1`,
        [started.deletionRequestId],
      )
      expect(request.rows[0]?.status).toBe('completed')
      expect(request.rows[0]?.completed_at).not.toBeNull()

      const audit = await pool.query<{ actor_type: string; actor_user_id: string | null }>(
        `SELECT actor_type, actor_user_id FROM audit_logs
          WHERE action = 'account.deletion_completed' AND target_id = $1`,
        [user.id],
      )
      // System, with no actor: the user asked for this and the request row
      // records that, but the write being audited here is the worker's.
      expect(audit.rows).toEqual([{ actor_type: 'system', actor_user_id: null }])

      const outbox = await pool.query<{ topic: string; payload: Record<string, unknown> }>(
        `SELECT topic, payload FROM outbox WHERE idempotency_key = $1`,
        [`account.deletion_completed:${started.deletionRequestId}`],
      )
      expect(outbox.rows).toHaveLength(1)
      expect(outbox.rows[0]?.payload).toEqual({
        deletion_request_id: started.deletionRequestId,
        user_id: user.id,
      })

      // Keyed on the request id, so a re-run of an already completed job finds
      // the row already enqueued rather than announcing twice.
      await finalizeAccountDeletion(db, {
        deletionRequestId: started.deletionRequestId,
        userId: user.id,
      })
      expect(
        await countWhere(`SELECT count(*)::text AS n FROM outbox WHERE idempotency_key = $1`, [
          `account.deletion_completed:${started.deletionRequestId}`,
        ]),
      ).toBe(1)
    })

    it('reports the in-flight job’s request while the job is still live', async () => {
      // The narrow window between `finalizeAccountDeletion` committing and the
      // runner settling the job. A call landing here must not mint a second
      // request: the `(type, subject_id)` partial unique would then refuse a job
      // for it, leaving a deletion nobody is performing.
      const user = await makeUser()
      const first = await startAccountDeletion(db, { userId: user.id })
      await finalizeAccountDeletion(db, {
        deletionRequestId: first.deletionRequestId,
        userId: user.id,
      })

      const second = await startAccountDeletion(db, { userId: user.id })
      expect(second.started).toBe(false)
      expect(second.deletionRequestId).toBe(first.deletionRequestId)
      expect(second.jobId).toBe(first.jobId)
      expect(await requestsFor(user.id)).toBe(1)
    })

    it('lets a settled deletion be superseded by a fresh one', async () => {
      const user = await makeUser()
      const first = await startAccountDeletion(db, { userId: user.id })
      await finalizeAccountDeletion(db, {
        deletionRequestId: first.deletionRequestId,
        userId: user.id,
      })
      // What the runner does after the executor returns `succeeded`.
      await pool.query(`UPDATE jobs SET status = 'succeeded' WHERE id = $1`, [first.jobId])

      const second = await startAccountDeletion(db, { userId: user.id })
      expect(second.started).toBe(true)
      expect(second.deletionRequestId).not.toBe(first.deletionRequestId)
      expect(second.jobId).not.toBe(first.jobId)
    })

    it('revives a live request whose job died terminally, without a second request', async () => {
      // A request with no live job is a deletion nobody is performing. Enqueuing
      // a new job for the *same* request is the only recovery that needs no
      // human; a second request would give one account two target snapshots,
      // each answering "is everything completed?" without knowing about the
      // other.
      const user = await makeUser()
      const first = await startAccountDeletion(db, { userId: user.id })
      await pool.query(`UPDATE jobs SET status = 'failed_terminal' WHERE id = $1`, [first.jobId])

      const second = await startAccountDeletion(db, { userId: user.id })
      expect(second.started).toBe(false)
      expect(second.deletionRequestId).toBe(first.deletionRequestId)
      expect(second.jobId).not.toBe(first.jobId)
      expect(await requestsFor(user.id)).toBe(1)

      const revived = await pool.query<{ payload: Record<string, unknown>; status: string }>(
        `SELECT payload, status FROM jobs WHERE id = $1`,
        [second.jobId],
      )
      expect(revived.rows[0]?.status).toBe('queued')
      expect(revived.rows[0]?.payload).toEqual({ deletion_request_id: first.deletionRequestId })
    })
  })

  /**
   * Who administers a self-hosted deployment, once somebody has been deleted.
   *
   * `deploymentOperatorUserId` is the oldest account, because migration 0043
   * stores the SMTP password and the model-provider key against the deployment
   * and there is no role above a site to ask. The rule collides with the one
   * this file exists to prove: an erasure **scrubs** the `users` row into a
   * tombstone rather than removing it, and leaves `created_at` alone, so the
   * deleted account stays the oldest row forever.
   *
   * That needs a real database to be true at all. The purge above is one
   * transaction judged by deferred triggers, and the tombstone survives a unique
   * index; a stubbed `select().limit()` would prove only that the repository
   * calls the function the test expects, which is exactly what the route-level
   * suite already stubs.
   *
   * `created_at` is set explicitly rather than left to `now()`: the claim is
   * about ordering, and two inserts a millisecond apart make it a claim about
   * timing instead.
   */
  describe('the deployment operator, after a deletion', () => {
    const makeUserAt = async (createdAt: string): Promise<string> => {
      const id = newId()
      await pool.query(
        `INSERT INTO users (id, name, email, email_verified, created_at)
         VALUES ($1, 'U', $2, true, $3)`,
        [id, `${id}@example.com`, createdAt],
      )
      return id
    }

    it('moves to the oldest surviving account, not the tombstone that outranks it', async () => {
      const first = await makeUserAt('2020-01-01T00:00:00Z')
      const second = await makeUserAt('2021-01-01T00:00:00Z')

      expect(await deploymentOperatorUserId(db)).toBe(first)

      await purgeAccountPostgres(db, { userId: first })

      // The row is still there and still the oldest — that is the whole reason
      // this can go wrong.
      const rows = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
        first,
      ])
      expect(rows.rows[0]?.email).toBe(accountTombstoneEmail(first))

      // Without the filter this answers `first`: the role settles on an identity
      // that can never sign in again, every live account reads `not_operator`,
      // and the deployment's stored mail and model settings can never be edited
      // or cleared from the dashboard again.
      expect(await deploymentOperatorUserId(db)).toBe(second)
    })
  })
})
