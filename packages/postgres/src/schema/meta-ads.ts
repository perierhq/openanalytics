import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import { idColumn, instant } from './_shared.ts'
import { sites } from './sites.ts'

/**
 * Meta Ads (mirror of migration 0052).
 *
 * `meta_ads_connections` is one row per site that connected an ad account: the
 * account id, what the connect probe read back, the token's ciphertext and the
 * sync state. `meta_ads_daily_spend` is what the worker read: one row per
 * campaign per day, in minor units of the ad account's currency.
 */

export type MetaAdsStatusColumn = 'active' | 'needs_reconnect'
export type MetaAdsErrorColumn =
  'unauthorized' | 'credential_undecryptable' | 'rate_limited' | 'unavailable' | 'invalid_response'

export const metaAdsConnections = pgTable(
  'meta_ads_connections',
  {
    siteId: idColumn('site_id')
      .primaryKey()
      .references(() => sites.id, { onDelete: 'cascade' }),
    adAccountId: text('ad_account_id').notNull(),
    adAccountName: text('ad_account_name').notNull().default(''),
    currency: text('currency').notNull(),
    accountStatus: integer('account_status'),
    encryptedToken: text('encrypted_token').notNull(),
    keyVersion: text('key_version').notNull(),
    tokenLast4: text('token_last4').notNull().default(''),
    status: text('status').$type<MetaAdsStatusColumn>().notNull().default('active'),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    nextSyncAt: timestamp('next_sync_at', { withTimezone: true }).notNull().defaultNow(),
    lastAttemptedAt: instant('last_attempted_at'),
    lastSyncedAt: instant('last_synced_at'),
    backfillCursor: date('backfill_cursor'),
    lastError: text('last_error').$type<MetaAdsErrorColumn>(),
  },
  (t) => [
    index('meta_ads_connections_due_idx')
      .on(t.nextSyncAt, t.siteId)
      .where(sql`status = 'active'`),
    index('meta_ads_connections_key_version_idx').on(t.keyVersion),
    check('meta_ads_connections_ad_account_id_check', sql`${t.adAccountId} ~ '^act_[0-9]{1,20}$'`),
    check('meta_ads_connections_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('meta_ads_connections_name_length_check', sql`char_length(${t.adAccountName}) <= 200`),
    check('meta_ads_connections_status_check', sql`${t.status} IN ('active', 'needs_reconnect')`),
    check(
      'meta_ads_connections_last_error_check',
      sql`${t.lastError} IS NULL OR ${t.lastError} IN ('unauthorized', 'credential_undecryptable', 'rate_limited', 'unavailable', 'invalid_response')`,
    ),
  ],
)

export const metaAdsDailySpend = pgTable(
  'meta_ads_daily_spend',
  {
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id').notNull(),
    campaignName: text('campaign_name').notNull(),
    day: date('day').notNull(),
    spendMinor: bigint('spend_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'meta_ads_daily_spend_pkey', columns: [t.siteId, t.campaignId, t.day] }),
    index('meta_ads_daily_spend_site_day_idx').on(t.siteId, t.day),
    check('meta_ads_daily_spend_campaign_id_check', sql`${t.campaignId} ~ '^[0-9]{1,32}$'`),
    check('meta_ads_daily_spend_name_length_check', sql`char_length(${t.campaignName}) <= 400`),
    check('meta_ads_daily_spend_spend_check', sql`${t.spendMinor} >= 0`),
    check('meta_ads_daily_spend_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
)
