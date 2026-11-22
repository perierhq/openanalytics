import { and, eq, inArray, sql } from 'drizzle-orm'
import { ACCOUNT_DELETION_TARGETS } from '@openanalytics/domain'
import type { Database, Executor } from '../client.ts'
import { newId } from '../ids.ts'
import { applyDepartureToApiKeys } from './api-keys.ts'
import { writeAudit } from './audit.ts'
import { ACCOUNT_DELETION_JOB_TYPE, enqueueJob } from './jobs.ts'
import { enqueueOutbox } from './outbox.ts'
import { revokeAccountRevenueCredentials } from './revenue-credentials.ts'
import { assistantUsageLedger } from '../schema/assistant-usage.ts'
import { accounts, sessions, users, verifications } from '../schema/auth.ts'
import { chartNotes } from '../schema/chart-notes.ts'
import { credentialSources } from '../schema/credential-sources.ts'
import { idempotencyKeys } from '../schema/idempotency.ts'
import { deviceCodes, oauthAccessTokens, oauthConsents } from '../schema/oauth.ts'
import {
  deletionRequests,
  deletionTargets,
  jobs,
  type DeletionStatus,
} from '../schema/lifecycle.ts'
import { siteInvites, siteMembers, sites, type SiteStatus } from '../schema/sites.ts'

/**
 * Account deletion's Postgres half (ADR-0030, decision 8).
 *
 * The shape mirrors `site-deletion.ts` — a small synchronous start transaction
 * owned by the API, a teardown transaction owned by the worker, and the reads
 * the phases between them need — because they are the same kind of object: a
 * durable, resumable erasure whose progress lives in `deletion_requests` and
 * `deletion_targets` rather than in a process.
 *
 * What is different is that an account owns no data of its own. Every event, row
 * and Redis key belongs to a *site*, and this deletion's first job is therefore
 * not to purge anything but to establish that the sites are already being
 * handled — either handed to somebody else, or deleted by their own jobs with
 * their own targets. That is what the gate below is, and it is the reason
 * account deletion has sixteen Postgres targets in this build and no ClickHouse
 * ones at all.
 *
 * **The users row is scrubbed, not deleted, and that is not a shortcut.**
 * `site_billing_assignments.billing_user_id` is `NOT NULL` with the default
 * `RESTRICT`, and those rows are the billing history of sites that may now
 * belong to somebody else entirely. Deleting the user to free the row would
 * either fail or falsify another customer's record. So the row survives as a
 * tombstone that identifies nobody: `deleted-{id}@tombstone.invalid`, an empty
 * name, no image, no timezone.
 *
 * **Better Auth interplay.** There is no cookie cache in this deployment
 * (`packages/auth/src/better-auth.ts`), so a session is resolved by reading the
 * `sessions` row on every request: deleting those rows ends the session on the
 * caller's very next call, with no window in which a cached cookie still
 * authenticates. The scrubbed email cannot collide with any Better Auth flow —
 * `users_email_key` stays satisfied because the tombstone address embeds the
 * user id, and the `verifications` rows that addressed the old address are
 * removed *before* the scrub, while they can still be found. Signing in
 * afterwards with the original address is a fresh, empty account (the one-door
 * model), and it gets no second free trial: the `trial_claims` row keeps its
 * `identity_hash` forever and only its link to the account is severed (D-021).
 */

/**
 * The topic the finished erasure announces.
 *
 * Observe-only, exactly like `site.deletion_completed` and for the same reason:
 * the customer-facing "your account and its data are gone" mail is the email
 * milestone's, and a topic registered from the start is a table that gets
 * drained rather than one that grows forever.
 */
export const ACCOUNT_DELETION_COMPLETED_TOPIC = 'account.deletion_completed'

/** The typed shape of an `account_deletion` job's payload. */
export interface AccountDeletionJobPayload extends Record<string, unknown> {
  readonly deletion_request_id: string
}

/** Site statuses that no longer hold an account back: their own deletion is
 * already under way, so no invariant depends on this user surviving. */
const RESOLVED_SITE_STATUSES: readonly SiteStatus[] = ['deleting', 'deleted']

function isResolved(status: SiteStatus): boolean {
  return RESOLVED_SITE_STATUSES.includes(status)
}

/**
 * Why a site blocks the deletion.
 *
 * `billing_owner` — this user pays for the site. ADR-0023's handover moves
 * `owner_user_id` away on acceptance, so a site still pointing here has
 * neither been handed over nor deleted, and erasing the payer would leave a live
 * site funded by an account that no longer exists.
 *
 * `sole_owner` — this user is the site's only `owner` member. Teardown deletes
 * every membership this user holds, and doing that to a live site would violate
 * OA001/OA002 at commit (migration 0007's `assert_site_ownership`, whose
 * `deleting`/`deleted` exemption is precisely why a site being deleted does not
 * block).
 */
export type AccountDeletionBlockReason = 'billing_owner' | 'sole_owner'

export interface AccountDeletionBlocker {
  readonly siteId: string
  readonly slug: string
  readonly reason: AccountDeletionBlockReason
}

/**
 * The gate's refusal, carrying every site the caller has to resolve.
 *
 * Every one of them, not the first: a refusal that named one site at a time
 * would make deleting an account with four sites a four-round guessing game.
 */
export class AccountDeletionBlockedError extends Error {
  readonly blockingSites: readonly AccountDeletionBlocker[]

  constructor(blockingSites: readonly AccountDeletionBlocker[]) {
    super(`Account deletion is blocked by ${String(blockingSites.length)} site(s)`)
    this.name = 'AccountDeletionBlockedError'
    this.blockingSites = blockingSites
  }
}

export interface StartAccountDeletionInput {
  readonly userId: string
  /** Test seam only. Omitted in production so `requested_at` keeps the database
   * clock's instant, as the site-deletion start does. */
  readonly now?: Date
}

export interface StartAccountDeletionResult {
  readonly deletionRequestId: string
  readonly jobId: string | null
  /** False when a live request already existed and this call found it. */
  readonly started: boolean
}

interface LockedSiteRow {
  readonly id: string
  readonly slug: string
  readonly status: SiteStatus
}

/**
 * Both gate checks, run inside the caller's transaction (ADR-0030, D8).
 *
 * One function with two callers on purpose. The gate is asked twice — once by
 * `startAccountDeletion`, which refuses the request, and once by
 * `purgeAccountPostgres`, which refuses to *commit* — and the two must ask
 * exactly the same question. A second, drifted copy of these two statements
 * would be a teardown that admits a site shape the start refused, or refuses one
 * it accepted, and either way the discrepancy would only ever be discovered by a
 * customer whose account is stuck.
 *
 * The billed read locks (`FOR UPDATE`, `ORDER BY id` *inside* the locking SELECT
 * per ADR-0030 D4's lock-order canon); the sole-ownership read deliberately does
 * not. Locking the second would drag arbitrarily many other customers' site rows
 * into an account deletion's transaction, for rows whose real enforcement is
 * `assert_site_ownership` at commit anyway.
 */
async function readBlockingSites(tx: Executor, userId: string): Promise<AccountDeletionBlocker[]> {
  const billed = await tx.execute(sql`
    SELECT id, slug, status
      FROM ${sites}
     WHERE owner_user_id = ${userId}::uuid
     ORDER BY id
       FOR UPDATE
  `)

  const blocking = new Map<string, AccountDeletionBlocker>()
  for (const row of (billed as unknown as { rows: LockedSiteRow[] }).rows) {
    if (isResolved(row.status)) continue
    blocking.set(row.id, { siteId: row.id, slug: row.slug, reason: 'billing_owner' })
  }

  const soleOwned = await tx.execute(sql`
    SELECT s.id, s.slug, s.status
      FROM ${siteMembers} m
      JOIN ${sites} s ON s.id = m.site_id
     WHERE m.user_id = ${userId}::uuid
       AND m.role = 'owner'
       AND NOT EXISTS (
         SELECT 1 FROM ${siteMembers} o
          WHERE o.site_id = m.site_id
            AND o.role = 'owner'
            AND o.user_id <> ${userId}::uuid
       )
     ORDER BY s.id
  `)

  for (const row of (soleOwned as unknown as { rows: LockedSiteRow[] }).rows) {
    if (isResolved(row.status)) continue
    // `billing_owner` wins when a site is both, and the contract says why: a
    // successor has to exist before there is anybody to promote, so naming the
    // second reason first would send the caller down a path that cannot be
    // walked yet.
    if (blocking.has(row.id)) continue
    blocking.set(row.id, { siteId: row.id, slug: row.slug, reason: 'sole_owner' })
  }

  return [...blocking.values()]
}

/**
 * Begin an account deletion — the start transaction (ADR-0030, D8).
 *
 * The order inside the single transaction is the guarantee:
 *
 * 1. **Lock the `users` row `FOR UPDATE`.** A new lock point, and the reason it
 *    is safe to add is that nothing else in the codebase locks a `users` row:
 *    there is no existing holder to form a cycle with. It serializes two
 *    concurrent deletions of the same account, which would otherwise both pass
 *    the gate and both write a request.
 * 2. **Take a locking read of the sites this user pays for**, as
 *    `SELECT … WHERE owner_user_id = … ORDER BY id FOR UPDATE`. The
 *    `ORDER BY` is inside the locking SELECT because Postgres acquires row locks
 *    in executor scan order and sorting the result afterwards would order
 *    nothing (ADR-0030, D4's lock-order canon). Without this lock the gate is a
 *    plain read, and a handover-accept committing between the read and this
 *    commit would hand the user a freshly billed site *after* it was checked.
 *    No subscription lock is taken here, so the canon's "subscription before
 *    site" rule has nothing to violate — this transaction simply never appears
 *    in the ordering that rule exists to fix.
 * 3. **Run both gate checks.** Blocked → throw with the full list; nothing has
 *    been written, so the throw is the whole outcome.
 * 4. **Idempotency.** A pending/running account request for this user is
 *    returned as-is. A second `DELETE /v1/me` therefore reports the first
 *    deletion rather than minting a twin whose target snapshot would disagree.
 * 5. **Write the request, the target snapshot and the job in this transaction.**
 *    A request with no job is an erasure nobody is performing and no sweep can
 *    find.
 *
 * Two things are deliberately *not* here. **Sessions are not revoked**: the
 * caller's own session stays valid until `postgres_teardown` deletes the row,
 * seconds later. Revoking here would mean the 202 could not be read by the
 * client that asked for it, and would put a second writer on a table the
 * teardown already owns — for the sake of a window whose only occupant is the
 * person who just asked to be deleted. **Stripe is not called**: an HTTP call to
 * a third party inside a transaction that can still roll back would cancel a
 * subscription for a deletion that never happened.
 */
export async function startAccountDeletion(
  db: Database,
  input: StartAccountDeletionInput,
): Promise<StartAccountDeletionResult> {
  const now = input.now ?? new Date()

  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM ${users} WHERE id = ${input.userId}::uuid FOR UPDATE`)

    // Both checks, under the billed read's `FOR UPDATE` — a handover-accept
    // committing between the read and this commit would otherwise hand the user
    // a freshly billed site *after* it was checked. The sole-ownership half is
    // unlocked and is a friendly early refusal rather than the enforcement: the
    // enforcement is `assert_site_ownership`, which fires at the teardown's
    // commit and refuses to leave a live site ownerless regardless of what
    // raced.
    const blocking = await readBlockingSites(tx, input.userId)
    if (blocking.length > 0) {
      throw new AccountDeletionBlockedError(blocking)
    }

    // Idempotency has two witnesses, and they are asked in this order because
    // the *job* is the thing that will still be doing work when the request row
    // has already settled.
    const [liveJob] = await tx
      .select({ id: jobs.id, payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, ACCOUNT_DELETION_JOB_TYPE),
          eq(jobs.subjectId, input.userId),
          inArray(jobs.status, ['queued', 'running', 'failed_retryable']),
        ),
      )

    const [liveRequest] = await tx
      .select({ id: deletionRequests.id })
      .from(deletionRequests)
      .where(
        and(
          eq(deletionRequests.subjectType, 'account'),
          eq(deletionRequests.subjectId, input.userId),
          inArray(deletionRequests.status, ['pending', 'running']),
        ),
      )
      .orderBy(deletionRequests.requestedAt)

    if (liveJob) {
      // A job in flight owns the deletion, and its payload names the request it
      // is working. Reading that rather than only the live-request query is what
      // stops the narrow window in which the request has just been completed or
      // failed but the job has not yet been settled: writing a *new* request
      // there would produce one the `(type, subject_id)` partial unique then
      // refuses a job for — a deletion nobody is performing.
      const carried = liveJob.payload['deletion_request_id']
      const requestId = typeof carried === 'string' ? carried : liveRequest?.id
      if (requestId !== undefined) {
        return { deletionRequestId: requestId, jobId: liveJob.id, started: false }
      }
    }

    if (liveRequest) {
      // A live request with no live job: the job was settled terminally, or lost
      // in a way nothing re-queued. Enqueueing a new job for the *same* request
      // is the only recovery that does not need a human, and it must not mint a
      // second request — two target snapshots for one account would each answer
      // "is everything completed?" without knowing about the other.
      const revived = await enqueueJob(tx, {
        type: ACCOUNT_DELETION_JOB_TYPE,
        subjectId: input.userId,
        idempotencyKey: `${ACCOUNT_DELETION_JOB_TYPE}:${input.userId}:${newId()}`,
        payload: { deletion_request_id: liveRequest.id } satisfies AccountDeletionJobPayload,
      })
      return { deletionRequestId: liveRequest.id, jobId: revived.id, started: false }
    }

    // Which targets are already settled, decided *now* and recorded in the
    // snapshot rather than re-derived when the phase runs. A surface whose
    // target has nothing to do — an account that never subscribed — says so
    // here, because the rows it would ask about are among the ones this
    // deletion removes, and a phase that asked later could find the answer
    // already erased by its own job.
    const preCompleted = new Map<string, Record<string, unknown>>()
    for (const probe of targetProbes) {
      for (const [target, verification] of Object.entries(
        await probe(tx, { userId: input.userId }),
      )) {
        preCompleted.set(target, verification)
      }
    }

    const requestId = newId()
    await tx.insert(deletionRequests).values({
      id: requestId,
      subjectType: 'account',
      subjectId: input.userId,
      status: 'pending',
      requestedByUserId: input.userId,
      ...(input.now === undefined ? {} : { requestedAt: input.now }),
    })

    // Every target in the vocabulary is written, including one a probe just
    // settled — pre-completed with a verification that says why, rather than
    // omitted. Omitting it would make the vocabulary depend on the account's
    // history, so "did this deletion do that?" could only be answered by the
    // absence of a row, which is indistinguishable from a snapshot written by
    // an older build. A completed row with a reason is a statement; a missing
    // row is a guess.
    await tx.insert(deletionTargets).values(
      ACCOUNT_DELETION_TARGETS.map((target) => {
        const verification = preCompleted.get(target.target)
        return {
          id: newId(),
          deletionRequestId: requestId,
          store: target.store,
          target: target.target,
          phase: verification ? ('completed' as const) : ('pending' as const),
          verified: verification !== undefined,
          ...(verification ? { verification } : {}),
          updatedAt: now,
        }
      }),
    )

    const enqueued = await enqueueJob(tx, {
      type: ACCOUNT_DELETION_JOB_TYPE,
      subjectId: input.userId,
      // A fresh key per attempt; the `(type, subject_id)` partial unique is what
      // actually guarantees one live job, so the key only has to be unique.
      idempotencyKey: `${ACCOUNT_DELETION_JOB_TYPE}:${input.userId}:${newId()}`,
      payload: { deletion_request_id: requestId } satisfies AccountDeletionJobPayload,
    })

    await writeAudit(tx, {
      action: 'account.deletion_requested',
      actorType: 'user',
      actorUserId: input.userId,
      targetType: 'user',
      targetId: input.userId,
      metadata: {
        deletion_request_id: requestId,
        targets: ACCOUNT_DELETION_TARGETS.length,
        pre_completed: [...preCompleted.keys()].sort(),
      },
    })

    return { deletionRequestId: requestId, jobId: enqueued.id, started: true }
  })
}

/**
 * A surface's answer to "is my target already settled for this account?".
 *
 * Returns the targets it can pre-complete, each with the verification that says
 * why. Run inside the request transaction, before the snapshot is written.
 */
export type AccountTargetProbe = (
  tx: Executor,
  input: { readonly userId: string },
) => Promise<Record<string, Record<string, unknown>>>

/** A surface's teardown, run inside the account-teardown transaction. */
export type AccountTeardownStep = (
  tx: Executor,
  input: { readonly userId: string; readonly now: Date },
) => Promise<Record<string, number>>

const targetProbes: AccountTargetProbe[] = []
const teardownSteps: AccountTeardownStep[] = []
const registeredAccountSteps = new Set<string>()

export function registerAccountDeletionExtension(input: {
  readonly name: string
  readonly probe?: AccountTargetProbe
  readonly teardown?: AccountTeardownStep
}): void {
  if (registeredAccountSteps.has(input.name)) return
  registeredAccountSteps.add(input.name)
  if (input.probe) targetProbes.push(input.probe)
  if (input.teardown) teardownSteps.push(input.teardown)
}

export interface AccountDeletionContext {
  readonly userId: string
  readonly requestStatus: DeletionStatus
  readonly requestedAt: Date
  /** Null when the users row is gone entirely — impossible by construction (the
   * tombstone is a scrub), but the join is left honest rather than asserted. */
  readonly email: string | null
}

/** The request row and its subject, in one read. */
export async function readAccountDeletionContext(
  db: Executor,
  deletionRequestId: string,
): Promise<AccountDeletionContext | null> {
  const result = await db.execute(sql`
    SELECT r.subject_id AS user_id,
           r.status      AS request_status,
           r.requested_at,
           u.email
      FROM ${deletionRequests} r
      LEFT JOIN ${users} u ON u.id = r.subject_id
     WHERE r.id = ${deletionRequestId}::uuid
       AND r.subject_type = 'account'
  `)

  const row = (
    result as unknown as {
      rows: {
        user_id: string
        request_status: DeletionStatus
        requested_at: string | Date
        email: string | null
      }[]
    }
  ).rows[0]
  if (!row) return null

  return {
    userId: row.user_id,
    requestStatus: row.request_status,
    // Raw `execute` bypasses drizzle's column mapping: timestamptz arrives as
    // the wire string, so the declared `Date` has to be made true here.
    requestedAt: new Date(row.requested_at),
    email: row.email,
  }
}

export interface BilledSiteState {
  readonly siteId: string
  readonly slug: string
  readonly status: SiteStatus
}

/**
 * The sites this account still pays for, with their statuses — what
 * `await_site_deletions` waits on.
 *
 * Unlocked and outside any transaction: the phase is a poll, and a lock held
 * across a wait that can last as long as a ClickHouse mutation would be a lock
 * held for hours over rows other transactions legitimately need.
 */
export async function listBilledSiteStates(
  db: Executor,
  userId: string,
): Promise<BilledSiteState[]> {
  const rows = await db
    .select({ siteId: sites.id, slug: sites.slug, status: sites.status })
    .from(sites)
    .where(eq(sites.ownerUserId, userId))
    .orderBy(sites.id)
  return rows
}

export interface PurgeAccountPostgresResult {
  /** Rows affected per target, in the target vocabulary's names. */
  readonly affected: Record<string, number>
  /** The address the tombstone replaced, for the audit metadata's shape check.
   * Never logged, never returned to a client. */
  readonly scrubbedFrom: string | null
}

/** The address a deleted account's row carries afterwards. Per-id, so the unique
 * index on `users.email` cannot collide however many accounts are deleted. */
export function accountTombstoneEmail(userId: string): string {
  return `deleted-${userId}@tombstone.invalid`
}

/**
 * The `postgres_teardown` phase (ADR-0030, D8): one transaction, every
 * Postgres target (`ACCOUNT_DELETION_POSTGRES_TARGETS` — sixteen today).
 *
 * One transaction because the ownership triggers are `DEFERRABLE INITIALLY
 * DEFERRED` and fire at commit: the membership deletions and everything that
 * follows them have to be judged together. It is also what makes the phase
 * atomic in the way an erasure has to be — there is no committed state in which
 * the account's sessions are gone but its subscription row survives.
 *
 * **The gate is re-run here, inside this transaction**, and throws
 * `AccountDeletionBlockedError` when the account has become a live site's payer
 * or sole owner since the request was made. The start's check was a different
 * transaction and cannot cover the days in between; this one shares a commit
 * with the deletes, so there is no window between passing it and erasing.
 *
 * The order inside it has exactly one load-bearing step. **`verifications` are
 * deleted first, keyed on the address the account holds right now**, because the
 * scrub at the end rewrites that address and the rows would become unfindable —
 * the table is keyed by identifier, and nothing else records which account a
 * verification belonged to.
 *
 * Two steps are deliberately not deletes:
 *
 * - **Transfer offers are cancelled, not deleted.** A pending offer involving
 *   this account must die — accepting one afterwards would hand a site to, or
 *   take a site from, somebody who no longer exists — but the offer *history* is
 *   the audit trail of who tried to move billing for a site that in most cases
 *   still belongs to somebody else. Setting `status = 'cancelled'` with
 *   `responded_at` satisfies the table's own `responded_check` and keeps the
 *   record; deleting the rows would erase another customer's history to tidy up
 *   this one's.
 * - **Trial claims are unlinked, not deleted.** `identity_hash` is the D-021
 *   one-time-trial tombstone and outlives every account by design. What is
 *   severed is the link: `user_id` and `stripe_subscription_id` both nulled —
 *   the second closes the gap 02 §8 notes, where a deleted account left a live
 *   Stripe id in a table that is supposed to hold no account data.
 *
 * Invitations get the same treatment from two directions. Invitations this
 * account *sent* have `invited_by_user_id` nulled, so no live invitation names a
 * tombstone as its inviter. Invitations sent *to* this account's address are
 * left alone: they are addressed to an email, not to a user, whoever controls
 * that address may still accept them, and they expire on their own. Deleting
 * them would silently cancel another site owner's invitation as a side effect of
 * this account's erasure.
 *
 * `usage_windows`, `usage_batch_deltas`, `site_billing_assignments` and
 * `audit_logs` are untouched — metering, billing and audit history that ADR-0030
 * D8 keeps deliberately, and the reason the users row is a tombstone at all.
 *
 * Every step tolerates a re-run: the deletes remove nothing the second time, the
 * cancellation matches no `pending` rows, the unlink writes the nulls already
 * there, and the scrub rewrites the tombstone address to itself.
 */
export async function purgeAccountPostgres(
  db: Database,
  input: { userId: string; now?: Date },
): Promise<PurgeAccountPostgresResult> {
  const now = input.now ?? new Date()

  return await db.transaction(async (tx) => {
    const affected: Record<string, number> = {}

    const locked = await tx.execute(sql`
      SELECT email FROM ${users} WHERE id = ${input.userId}::uuid FOR UPDATE
    `)
    const email = (locked as unknown as { rows: { email: string }[] }).rows[0]?.email ?? null

    // The gate again, inside the transaction that does the erasing.
    //
    // `startAccountDeletion` proved there was no live site under a locking read,
    // but that was a different transaction, possibly days ago: a transfer-offer
    // acceptance or a new site created between the two makes this account a
    // payer or a sole owner again. `await_site_deletions` catches the billing
    // half at the start of the job and cannot catch anything that lands after
    // it; this is the check that is *in the same transaction* as the deletes, so
    // there is no window at all between passing it and committing. The throw
    // rolls the whole teardown back — nothing is half-erased — and the executor
    // turns it into a terminal settlement, because no amount of retrying makes
    // somebody else's live site go away.
    const blocking = await readBlockingSites(tx, input.userId)
    if (blocking.length > 0) {
      throw new AccountDeletionBlockedError(blocking)
    }

    // Better Auth writes a verification's identifier in three shapes: the bare
    // address, a `prefix:address` / `prefix-address` form, and — for the
    // magic-link plugin — an opaque token whose *value* carries the address.
    // All three are matched here, and none of them with `LIKE`: an email may
    // legitimately contain `_`, which `LIKE` reads as a wildcard, and a wildcard
    // match would delete a different account's live verification. `right()` and
    // `strpos()` are literal comparisons with nothing to escape.
    //
    // Both suffix forms are **delimiter-anchored**, and that is the whole
    // correctness of this statement. `right(identifier, length(email))` alone
    // matches any identifier merely *ending* in the address, so deleting
    // `a@b.com` would take `ba@b.com`'s live rows with it — a different person's
    // sign-in link, cancelled as a side effect. Taking one character more and
    // requiring it to be the delimiter Better Auth actually writes makes the
    // match a statement about this address rather than about its spelling. The
    // `value` match is anchored the same way, on the JSON quotes the magic-link
    // payload puts around the address.
    if (email !== null) {
      const removed = await tx
        .delete(verifications)
        .where(
          sql`${verifications.identifier} = ${email}
              OR right(${verifications.identifier}, length(${email}) + 1)
                 IN (':' || ${email}, '-' || ${email})
              OR strpos(${verifications.value}, '"' || ${email} || '"') > 0`,
        )
        .returning({ id: verifications.id })
      affected['verifications'] = removed.length
    } else {
      affected['verifications'] = 0
    }

    const removedSessions = await tx
      .delete(sessions)
      .where(eq(sessions.userId, input.userId))
      .returning({ id: sessions.id })
    affected['sessions'] = removedSessions.length

    const removedAccounts = await tx
      .delete(accounts)
      .where(eq(accounts.userId, input.userId))
      .returning({ id: accounts.id })
    affected['accounts'] = removedAccounts.length

    // The authorization server's three user-scoped tables, added 2026-08-06 with
    // migration 0045 (ADR-0043 D9).
    //
    // Written here in the same change that created the tables, because the
    // alternative is on file: `idempotency_keys` carried a declared
    // `ON DELETE CASCADE` and outlived account deletion for eight milestones,
    // since the cascade can never fire — `user_tombstone` below scrubs the
    // `users` row rather than deleting it. Migration 0045 therefore declares no
    // cascade at all, and these three statements are what actually removes the
    // rows.
    //
    // Each is a *person's*: an access token that reads their sites' analytics
    // through `/v1/read`, a standing consent naming what they let a client do,
    // and any device authorization in flight. Left alone, a deleted account's
    // CLI keeps reading a live customer's data until the token expires, and its
    // refresh token keeps renewing that for a month.
    //
    // Deleted rather than revoked, unlike `api_keys` two statements below. The
    // distinction is whose history the row is: an `api_keys` row is the *site's*
    // record of who could read it, and the site is still alive. An access token
    // is nobody's record of anything — it is a live credential and its audit
    // trail is the `audit_log`, not the token table.
    const removedTokens = await tx
      .delete(oauthAccessTokens)
      .where(eq(oauthAccessTokens.userId, input.userId))
      .returning({ id: oauthAccessTokens.id })
    affected['oauth_access_tokens'] = removedTokens.length

    const removedConsents = await tx
      .delete(oauthConsents)
      .where(eq(oauthConsents.userId, input.userId))
      .returning({ id: oauthConsents.id })
    affected['oauth_consents'] = removedConsents.length

    const removedDeviceCodes = await tx
      .delete(deviceCodes)
      .where(eq(deviceCodes.userId, input.userId))
      .returning({ id: deviceCodes.id })
    affected['device_codes'] = removedDeviceCodes.length

    // The inbound idempotency ledger, added 2026-08-06.
    //
    // It looks covered and is not. `idempotency_keys.user_id` is
    // `REFERENCES users (id) ON DELETE CASCADE` (migration 0019), but the
    // cascade never fires: the scrub below keeps the `users` row alive, exactly
    // as D8 requires, so there is no delete for it to follow. Left out, a
    // deleted account's rows persist with a `response_body` holding the reply
    // this person was given — for `sites.create`, the created site's slug and
    // name.
    //
    // Deleted rather than scrubbed, unlike the credential rows above: those
    // survive because they are a live site's history and someone else still
    // needs them. Nothing reads a stranger's idempotency claim — the row is
    // keyed `(user_id, scope, key)` and is only ever visible to its own caller
    // — so there is no history to preserve and nothing to break by removing it.
    // The retention sweeper on the same table is not a substitute either: it
    // bounds age, not ownership, and would take up to a day to reach these.
    const removedIdempotency = await tx
      .delete(idempotencyKeys)
      .where(eq(idempotencyKeys.userId, input.userId))
      .returning({ id: idempotencyKeys.id })
    affected['idempotency_keys'] = removedIdempotency.length

    // The third credential family, and the one that outlives the account unless
    // this statement runs. A `private_read` key is a *secret this person minted*
    // — it authenticates read access to a site's analytics on its own, with no
    // session behind it — and the key row is site-scoped, so it survives every
    // other step here: the sites this account merely belonged to are not being
    // deleted, and their rows are not this deletion's to remove. Left alone, a
    // deleted account's API token keeps reading a live customer's data forever.
    //
    // Revoked rather than deleted, for the reason the site purge's own keys are
    // not silently dropped: `api_keys` is what an audit of "who could read this
    // site" is reconstructed from, and a row with `revoked_at` is that history
    // with the access removed. `tracking_write` keys are deliberately untouched
    // — they are the site's public tracker token, not this person's credential,
    // and revoking one would stop a browser posting events to a site that is
    // still very much alive.
    //
    // **That last sentence is now a column, and it applies to private keys too**
    // (ADR-0043, D8). This used to revoke every `private_read` key the account
    // created, which took down any machine they had installed one into — the
    // WordPress plugin on a site that now belongs to somebody else. The rule is
    // the one membership removal uses, and it is the same call: a key they
    // *held* is revoked, a key they installed (`held_by = 'site'`) survives
    // with `rotation_required_at` stamped, so the site's remaining owners see
    // that a departed stranger still knows its value and can rotate it.
    // `created_by_user_id` is `ON DELETE SET NULL`, so a surviving key ends this
    // deletion with no creator at all, which is the honest state for a
    // credential that belongs to the site.
    const keyOutcome = await applyDepartureToApiKeys(tx, {
      userId: input.userId,
      actorUserId: input.userId,
      now,
    })
    affected['api_keys_revoke'] = keyOutcome.revoked
    affected['api_keys_rotation_required'] = keyOutcome.flagged

    // The fourth credential family, and the same argument one milestone later
    // (ADR-0033, D3/D8). A revenue credential this person connected is a
    // *customer's payment-provider key*, stored encrypted on a site that is not
    // being deleted — so nothing else in this teardown reaches it, and the sync
    // loop would keep decrypting and using it forever on behalf of an account
    // that no longer exists.
    //
    // Unscoped by site on purpose: `revokeRevenueCredentialsCreatedBy` is the
    // membership-removal path ("this person left this site"), while this one is
    // "this person is gone", and a per-site loop would need the very
    // `site_members` rows the next statement deletes.
    //
    // Disabled with both ciphertexts erased rather than deleted, for the reason
    // the keys above are revoked rather than dropped: the row is the *site's*
    // connection history and the site is still alive.
    const revokedCredentials = await revokeAccountRevenueCredentials(tx, {
      userId: input.userId,
      now,
    })
    affected['revenue_credentials_revoke'] = revokedCredentials.length

    const removedMemberships = await tx
      .delete(siteMembers)
      .where(eq(siteMembers.userId, input.userId))
      .returning({ id: siteMembers.id })
    affected['memberships'] = removedMemberships.length

    const unlinkedInvites = await tx
      .update(siteInvites)
      .set({ invitedByUserId: null })
      .where(eq(siteInvites.invitedByUserId, input.userId))
      .returning({ id: siteInvites.id })
    affected['invites'] = unlinkedInvites.length

    // The surfaces this deployment mounted, teared down in the same
    // transaction and recording into the same map — see `AccountTeardownStep`.
    for (const step of teardownSteps) {
      Object.assign(affected, await step(tx, { userId: input.userId, now }))
    }

    // The assistant's question ledger (ADR-0046, D5), added 2026-08-08 with
    // migration 0049 — enumerated in the same change that created the table,
    // which is the `idempotency_keys` lesson applied on time for the second
    // milestone running.
    //
    // The rows are counts and nothing else: no message text, no tool arguments,
    // no answers, because the server stores no conversation at all (D12). They
    // are still this person's — a record of how often they asked and what it
    // cost — and the table's `user_id` foreign key declares no `ON DELETE`
    // action precisely because the scrub below keeps the `users` row alive, so
    // this delete is the only thing that removes them.
    //
    // Deleted rather than kept, unlike the metering and billing history two
    // paragraphs down: those are a *billing* record the surviving sites' owners
    // and our own accounting depend on, and a question count is neither.
    const removedAssistantUsage = await tx
      .delete(assistantUsageLedger)
      .where(eq(assistantUsageLedger.userId, input.userId))
      .returning({ userId: assistantUsageLedger.userId })
    affected['assistant_usage_ledger'] = removedAssistantUsage.length

    // Where this person's OAuth grants were used from (ADR-0051, D5; migration
    // 0050) — `credential_sources_user`, and only the rows keyed by `user_id`.
    //
    // The same table's `api_key` rows are site data and are deliberately out of
    // reach here: this teardown *revokes* the person's keys rather than
    // deleting them (`api_keys_revoke` above), and the sites those keys belong
    // to survive this account. Their source rows survive with them, and are
    // removed by the site's own deletion if it ever comes.
    //
    // What goes is a set of keyed hashes of the addresses this person's CLI and
    // MCP clients connected from. Not addresses, and not reversible into any —
    // but a record of one person's machines, which is why it is enumerated
    // rather than left behind as "just telemetry".
    const removedCredentialSources = await tx
      .delete(credentialSources)
      .where(eq(credentialSources.userId, input.userId))
      .returning({ id: credentialSources.id })
    affected['credential_sources_user'] = removedCredentialSources.length

    // The chart notes this person wrote (migration 0050) keep their text and
    // lose their author. The note is the site's record of a moment and the site
    // outlives this account; the authorship is the person's. The column's
    // `ON DELETE SET NULL` cannot do this — the scrub below keeps the `users`
    // row alive — so without this statement every note would go on naming a
    // tombstone as its author.
    const unlinkedNotes = await tx
      .update(chartNotes)
      .set({ createdByUserId: null })
      .where(eq(chartNotes.createdByUserId, input.userId))
      .returning({ id: chartNotes.id })
    affected['chart_notes_unlink'] = unlinkedNotes.length

    const scrubbed = await tx
      .update(users)
      .set({
        email: accountTombstoneEmail(input.userId),
        // The column is `NOT NULL`, so the empty string is the only "no name"
        // this schema admits; a placeholder like 'Deleted user' would be a new
        // piece of content rather than an absence.
        name: '',
        image: null,
        timezone: null,
        updatedAt: now,
      })
      .where(eq(users.id, input.userId))
      .returning({ id: users.id })
    affected['user_tombstone'] = scrubbed.length

    return { affected, scrubbedFrom: email }
  })
}

export interface FinalizeAccountDeletionInput {
  readonly deletionRequestId: string
  readonly userId: string
  readonly now?: Date
}

/**
 * Close the request (ADR-0030, D8 `verify`/`finalize`).
 *
 * One transaction: the audit row, the completed request and the outbox
 * announcement land together, so nothing can announce an erasure that then
 * rolled back. `actorType` is `system` with no actor — the user asked for this,
 * and the request row records that they did, but the act being audited here is
 * the worker's, and naming the user as the actor of a write they did not make is
 * the kind of small lie an audit trail cannot afford.
 */
export async function finalizeAccountDeletion(
  db: Database,
  input: FinalizeAccountDeletionInput,
): Promise<void> {
  const now = input.now ?? new Date()

  await db.transaction(async (tx) => {
    await tx
      .update(deletionRequests)
      .set({ status: 'completed', completedAt: now })
      .where(eq(deletionRequests.id, input.deletionRequestId))

    await writeAudit(tx, {
      action: 'account.deletion_completed',
      actorType: 'system',
      targetType: 'user',
      targetId: input.userId,
      metadata: { deletion_request_id: input.deletionRequestId },
    })

    await enqueueOutbox(tx, {
      topic: ACCOUNT_DELETION_COMPLETED_TOPIC,
      idempotencyKey: `${ACCOUNT_DELETION_COMPLETED_TOPIC}:${input.deletionRequestId}`,
      payload: { deletion_request_id: input.deletionRequestId, user_id: input.userId },
    })
  })
}

/** Move the request to `running` on the first phase that does real work. */
export async function markAccountDeletionRunning(
  db: Executor,
  deletionRequestId: string,
): Promise<void> {
  await db
    .update(deletionRequests)
    .set({ status: 'running' })
    .where(and(eq(deletionRequests.id, deletionRequestId), eq(deletionRequests.status, 'pending')))
}

/**
 * Mark the request `failed` — the settlement for a precondition the gate
 * guaranteed and something then undid.
 *
 * It matters that this exists rather than the job simply going
 * `failed_terminal`. `startAccountDeletion` is idempotent by *finding a
 * pending/running request*, so a dead job whose request stayed `pending` would
 * make every future `DELETE /v1/me` return that request's id forever — an
 * account permanently unable to be deleted, reporting success each time.
 * Leaving `failed` outside the live set lets the next call start a real one.
 */
export async function markAccountDeletionFailed(
  db: Database,
  input: { deletionRequestId: string; userId: string; reason: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    // Guarded on the live statuses: a request that already `completed` must not
    // be rewritten as failed by a job that outlived its own finalization — the
    // runner's terminal hook calls this on an attempts-exhausted job too, and
    // that job's request may have been closed by a previous, successful pass.
    const failed = await tx
      .update(deletionRequests)
      .set({ status: 'failed' })
      .where(
        and(
          eq(deletionRequests.id, input.deletionRequestId),
          inArray(deletionRequests.status, ['pending', 'running']),
        ),
      )
      .returning({ id: deletionRequests.id })

    // Only when something actually moved. The executor marks the request itself
    // on the paths where it knows why, and the runner's terminal hook then calls
    // this again with the same reason; a second audit row would record one
    // failure twice, and a row for a guard that matched nothing would record a
    // write that did not happen.
    if (failed.length === 0) return

    await writeAudit(tx, {
      action: 'account.deletion_failed',
      actorType: 'system',
      targetType: 'user',
      targetId: input.userId,
      metadata: { deletion_request_id: input.deletionRequestId, reason: input.reason },
    })
  })
}
