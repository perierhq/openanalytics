import { and, asc, eq, gte, lte, or, sql } from 'drizzle-orm'
import type { MetaAdsError, MetaAdsStatus, MetaSpendRow } from '@openanalytics/domain'
import type { Database, Executor } from '../client.ts'
import { writeAudit } from './audit.ts'
import { metaAdsConnections, metaAdsDailySpend } from '../schema/meta-ads.ts'
import { sites, type SiteStatus } from '../schema/sites.ts'

/**
 * Meta Ads (migration 0052): a site's ad account connection and the daily
 * campaign spend read from it.
 *
 * Every read and write takes `siteId` and puts it in the `WHERE`, so a caller
 * authorized on one site cannot reach another's spend.
 *
 * The token's ciphertext is read here (the worker decrypts it) and never
 * leaves this module's callers in a response: the API route renders the
 * connection through a function that names every field it returns, and the
 * ciphertext is not one of them. Audit metadata carries no identifier of the
 * ad account and nothing of the token.
 */

export interface MetaAdsConnectionRecord {
  readonly siteId: string
  readonly adAccountId: string
  readonly adAccountName: string
  readonly currency: string
  /** Meta's `account_status` at connect (1 is active); null when not reported. */
  readonly accountStatus: number | null
  readonly encryptedToken: string
  readonly keyVersion: string
  readonly tokenLast4: string
  readonly status: MetaAdsStatus
  readonly connectedAt: Date
  readonly nextSyncAt: Date
  readonly lastAttemptedAt: Date | null
  readonly lastSyncedAt: Date | null
  /** `YYYY-MM-DD`: the first sync's backfill has stored every day from here on. */
  readonly backfillCursor: string | null
  readonly lastError: MetaAdsError | null
}

export async function readMetaAdsConnection(
  db: Executor,
  siteId: string,
): Promise<MetaAdsConnectionRecord | null> {
  const [row] = await db
    .select()
    .from(metaAdsConnections)
    .where(eq(metaAdsConnections.siteId, siteId))
    .limit(1)
  return (row as MetaAdsConnectionRecord | undefined) ?? null
}

export interface SaveMetaAdsConnectionInput {
  readonly siteId: string
  readonly adAccountId: string
  readonly adAccountName: string
  readonly currency: string
  readonly accountStatus: number | null
  readonly encryptedToken: string
  readonly keyVersion: string
  readonly tokenLast4: string
  readonly actorUserId: string
  readonly now?: Date
}

export type SaveMetaAdsConnectionResult =
  | {
      readonly ok: true
      readonly connection: MetaAdsConnectionRecord
      readonly accountChanged: boolean
    }
  | { readonly ok: false; readonly conflict: 'site_unavailable' }

/**
 * Connect, or reconnect, a site's ad account.
 *
 * One transaction, and it starts by reading the site row `FOR SHARE`: the same
 * row `startSiteDeletion` locks `FOR UPDATE` before it drops the site's token.
 * Either this commits first and the deletion drops the token it wrote, or the
 * deletion commits first and this reads `deleting` and refuses, so a site on
 * its way out never ends up holding a token.
 *
 * A reconnect to the **same** account keeps its spend, its `last_synced_at`
 * and its backfill cursor, so only what is missing is read again. A connect to
 * a **different** account, or any connect with no connection before it (a
 * disconnect may have raced a sync that wrote after it), deletes the site's
 * spend and starts a first sync, so no campaign of another account is ever
 * shown beside the new one. Either way the connection is active, its error is
 * cleared and it is due now.
 */
export async function saveMetaAdsConnection(
  db: Database,
  input: SaveMetaAdsConnectionInput,
): Promise<SaveMetaAdsConnectionResult> {
  const now = input.now ?? new Date()
  return await db.transaction(async (tx): Promise<SaveMetaAdsConnectionResult> => {
    const locked = await tx.execute(sql`
      SELECT status FROM ${sites} WHERE id = ${input.siteId}::uuid FOR SHARE
    `)
    const siteStatus = (locked as unknown as { rows: { status: SiteStatus }[] }).rows[0]?.status
    if (siteStatus === undefined || siteStatus === 'deleting' || siteStatus === 'deleted') {
      return { ok: false, conflict: 'site_unavailable' }
    }

    const [existing] = await tx
      .select({
        adAccountId: metaAdsConnections.adAccountId,
        lastSyncedAt: metaAdsConnections.lastSyncedAt,
        backfillCursor: metaAdsConnections.backfillCursor,
      })
      .from(metaAdsConnections)
      .where(eq(metaAdsConnections.siteId, input.siteId))
      .for('update')
      .limit(1)
    const accountChanged = existing !== undefined && existing.adAccountId !== input.adAccountId
    const sameAccount = existing !== undefined && !accountChanged
    if (!sameAccount) {
      await tx.delete(metaAdsDailySpend).where(eq(metaAdsDailySpend.siteId, input.siteId))
    }
    const values = {
      siteId: input.siteId,
      adAccountId: input.adAccountId,
      adAccountName: input.adAccountName.slice(0, 200),
      currency: input.currency,
      accountStatus: input.accountStatus,
      encryptedToken: input.encryptedToken,
      keyVersion: input.keyVersion,
      tokenLast4: input.tokenLast4,
      status: 'active' as const,
      connectedAt: now,
      nextSyncAt: now,
      lastAttemptedAt: null,
      lastSyncedAt: sameAccount ? existing.lastSyncedAt : null,
      backfillCursor: sameAccount ? existing.backfillCursor : null,
      lastError: null,
    }
    const [row] = await tx
      .insert(metaAdsConnections)
      .values(values)
      .onConflictDoUpdate({ target: metaAdsConnections.siteId, set: values })
      .returning()
    await writeAudit(tx, {
      action: existing === undefined ? 'site.meta_ads.connected' : 'site.meta_ads.reconnected',
      actorUserId: input.actorUserId,
      siteId: input.siteId,
      targetType: 'meta_ads_connection',
      metadata: { account_changed: accountChanged },
    })
    return { ok: true, connection: row as MetaAdsConnectionRecord, accountChanged }
  })
}

/**
 * Disconnect: the connection row goes, and the token's ciphertext with it, in
 * the same transaction as the spend it read. The spend is Meta's data about
 * the account and is read again on a reconnect, so nothing is lost that cannot
 * be fetched back.
 */
export async function deleteMetaAdsConnection(
  db: Database,
  input: { readonly siteId: string; readonly actorUserId: string },
): Promise<{ readonly deleted: boolean; readonly spendRows: number }> {
  return await db.transaction(async (tx) => {
    const removed = await tx
      .delete(metaAdsConnections)
      .where(eq(metaAdsConnections.siteId, input.siteId))
      .returning({ siteId: metaAdsConnections.siteId })
    if (removed.length === 0) return { deleted: false, spendRows: 0 }
    const spend = await tx
      .delete(metaAdsDailySpend)
      .where(eq(metaAdsDailySpend.siteId, input.siteId))
      .returning({ day: metaAdsDailySpend.day })
    await writeAudit(tx, {
      action: 'site.meta_ads.disconnected',
      actorUserId: input.actorUserId,
      siteId: input.siteId,
      targetType: 'meta_ads_connection',
      metadata: { spend_rows: spend.length },
    })
    return { deleted: true, spendRows: spend.length }
  })
}

/**
 * Drop a site's connection, and with it the token, when the site's deletion
 * starts. The purge is hours away and a site being erased must not hold a
 * usable token to somebody's ad account for any of that time. The spend rows
 * stay for the purge, which counts them.
 */
export async function eraseSiteMetaAdsConnection(
  tx: Executor,
  input: { readonly siteId: string },
): Promise<number> {
  const removed = await tx
    .delete(metaAdsConnections)
    .where(eq(metaAdsConnections.siteId, input.siteId))
    .returning({ siteId: metaAdsConnections.siteId })
  return removed.length
}

/**
 * Connections the worker should sync now: active, due, on an active site;
 * soonest first. A `needs_reconnect` connection is never listed.
 *
 * `includeUndecryptable` also lists, due or not, every connection whose last
 * sync could not decrypt its token. The worker passes it on its first tick
 * after a start, the only moment its keyring can have changed, so a restored
 * key is picked up at once instead of at the next scheduled sync.
 */
export async function listDueMetaAdsConnections(
  db: Database,
  input: {
    readonly now: Date
    readonly limit: number
    readonly includeUndecryptable?: boolean
  },
): Promise<MetaAdsConnectionRecord[]> {
  const due = lte(metaAdsConnections.nextSyncAt, input.now)
  const rows = await db
    .select({ connection: metaAdsConnections })
    .from(metaAdsConnections)
    .innerJoin(sites, eq(sites.id, metaAdsConnections.siteId))
    .where(
      and(
        eq(metaAdsConnections.status, 'active'),
        eq(sites.status, 'active'),
        input.includeUndecryptable === true
          ? or(due, eq(metaAdsConnections.lastError, 'credential_undecryptable'))
          : due,
      ),
    )
    .orderBy(asc(metaAdsConnections.nextSyncAt), asc(metaAdsConnections.siteId))
    .limit(input.limit)
  return rows.map((row) => row.connection as MetaAdsConnectionRecord)
}

export interface RecordMetaAdsSyncInput {
  readonly siteId: string
  /** The `connected_at` the sync read. A reconnect in between moves it, and the
   * outcome of a sync made with the old token is then not recorded. */
  readonly connectedAt: Date
  readonly at: Date
  readonly error: MetaAdsError | null
  /** True when the whole window was read: `last_synced_at` moves. */
  readonly completed: boolean
  readonly nextSyncAt: Date
}

/**
 * Record a sync's outcome. An `unauthorized` error flips the connection to
 * `needs_reconnect`, which stops polling until the owner connects again.
 * Returns false when the connection changed (or went) since it was read.
 */
export async function recordMetaAdsSync(
  db: Database,
  input: RecordMetaAdsSyncInput,
): Promise<boolean> {
  const updated = await db
    .update(metaAdsConnections)
    .set({
      lastAttemptedAt: input.at,
      lastError: input.error,
      nextSyncAt: input.nextSyncAt,
      ...(input.completed ? { lastSyncedAt: input.at } : {}),
      ...(input.error === 'unauthorized' ? { status: 'needs_reconnect' as const } : {}),
    })
    .where(
      and(
        eq(metaAdsConnections.siteId, input.siteId),
        eq(metaAdsConnections.connectedAt, input.connectedAt),
      ),
    )
    .returning({ siteId: metaAdsConnections.siteId })
  return updated.length > 0
}

/** Rows per insert statement; well under Postgres's parameter ceiling. */
const SPEND_CHUNK = 500

export interface UpsertMetaAdsSpendInput {
  readonly siteId: string
  /** The connection the sync read: its `connected_at` and its ad account. */
  readonly connectedAt: Date
  readonly adAccountId: string
  readonly rows: readonly MetaSpendRow[]
  readonly fetchedAt?: Date
  /** Moves the first sync's backfill cursor in the same transaction. */
  readonly backfillCursor?: string
}

/**
 * Write campaign-days, replacing what was stored for the same day: Meta
 * restates recent spend, and the newest reading is the one to keep. Returns
 * the rows written, or null when the connection is no longer the one the sync
 * read (the caller then stops: the token it holds was disconnected or
 * replaced).
 *
 * **Only for the connection the sync read.** One transaction that first takes
 * the connection row `FOR SHARE` where `connected_at` and the ad account are
 * still the ones the sync started with, and writes nothing (returns 0) when the
 * row is gone or changed. A disconnect or a connect locks that row to change
 * it, so it either waits for this write and then deletes what it wrote, or
 * commits first and this finds no row: spend read with a token the owner
 * removed, or from an account the site no longer holds, is never stored.
 */
export async function upsertMetaAdsSpend(
  db: Database,
  input: UpsertMetaAdsSpendInput,
): Promise<number | null> {
  // One row per (campaign, day): a duplicate inside one statement would make
  // `ON CONFLICT DO UPDATE` affect the same row twice, which Postgres refuses.
  const unique = new Map<string, MetaSpendRow>()
  for (const row of input.rows) unique.set(`${row.campaignId}|${row.day}`, row)
  const rows = [...unique.values()]
  if (rows.length === 0 && input.backfillCursor === undefined) return 0
  const fetchedAt = input.fetchedAt ?? new Date()

  return await db.transaction(async (tx): Promise<number | null> => {
    const current = await tx
      .select({ siteId: metaAdsConnections.siteId })
      .from(metaAdsConnections)
      .where(
        and(
          eq(metaAdsConnections.siteId, input.siteId),
          eq(metaAdsConnections.connectedAt, input.connectedAt),
          eq(metaAdsConnections.adAccountId, input.adAccountId),
        ),
      )
      .for('share')
      .limit(1)
    if (current.length === 0) return null

    let written = 0
    for (let start = 0; start < rows.length; start += SPEND_CHUNK) {
      const chunk = rows.slice(start, start + SPEND_CHUNK)
      const result = await tx
        .insert(metaAdsDailySpend)
        .values(
          chunk.map((row) => ({
            siteId: input.siteId,
            campaignId: row.campaignId,
            campaignName: row.campaignName,
            day: row.day,
            spendMinor: row.spendMinor,
            currency: row.currency,
            fetchedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [metaAdsDailySpend.siteId, metaAdsDailySpend.campaignId, metaAdsDailySpend.day],
          set: {
            campaignName: sql`excluded.campaign_name`,
            spendMinor: sql`excluded.spend_minor`,
            currency: sql`excluded.currency`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        })
        .returning({ day: metaAdsDailySpend.day })
      written += result.length
    }
    if (input.backfillCursor !== undefined) {
      await tx
        .update(metaAdsConnections)
        .set({ backfillCursor: input.backfillCursor })
        .where(eq(metaAdsConnections.siteId, input.siteId))
    }
    return written
  })
}

/** One site's campaign-days between two days, inclusive. */
export async function listMetaAdsSpend(
  db: Database,
  input: { readonly siteId: string; readonly fromDay: string; readonly toDay: string },
): Promise<MetaSpendRow[]> {
  const rows = await db
    .select({
      campaignId: metaAdsDailySpend.campaignId,
      campaignName: metaAdsDailySpend.campaignName,
      day: metaAdsDailySpend.day,
      spendMinor: metaAdsDailySpend.spendMinor,
      currency: metaAdsDailySpend.currency,
    })
    .from(metaAdsDailySpend)
    .where(
      and(
        eq(metaAdsDailySpend.siteId, input.siteId),
        gte(metaAdsDailySpend.day, input.fromDay),
        lte(metaAdsDailySpend.day, input.toDay),
      ),
    )
    .orderBy(asc(metaAdsDailySpend.day), asc(metaAdsDailySpend.campaignId))
  return rows
}
