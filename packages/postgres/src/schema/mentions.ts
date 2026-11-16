import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'
import { idColumn, instant, primaryId } from './_shared.ts'
import { users } from './auth.ts'
import { sites } from './sites.ts'

/**
 * X mentions (mirror of migration 0048).
 *
 * `site_mention_settings` is one row per site that has ever saved settings; a
 * site without one reads as the defaults (watching off, no terms).
 * `mentions` holds the posts the poller found, one row per post per site. No
 * avatar URL is stored, so the dashboard cannot hotlink X images; the pictures
 * themselves live in `mention_avatars` (mirror of migration 0049) and the API
 * serves them.
 */

export type MentionPlatformColumn = 'x'
export type MentionPollErrorColumn = 'unavailable' | 'invalid_response'

export const siteMentionSettings = pgTable(
  'site_mention_settings',
  {
    siteId: idColumn('site_id')
      .primaryKey()
      .references(() => sites.id, { onDelete: 'cascade' }),
    xEnabled: boolean('x_enabled').notNull().default(false),
    terms: text('terms')
      .array()
      .notNull()
      .default(sql`'{}'`),
    lastPolledAt: instant('last_polled_at'),
    lastError: text('last_error').$type<MentionPollErrorColumn>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: idColumn('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('site_mention_settings_due_idx')
      .on(t.lastPolledAt.asc().nullsFirst(), t.siteId)
      .where(sql`x_enabled`),
    check('site_mention_settings_terms_count_check', sql`cardinality(${t.terms}) <= 5`),
    check(
      'site_mention_settings_last_error_check',
      sql`${t.lastError} IS NULL OR ${t.lastError} IN ('unavailable', 'invalid_response')`,
    ),
  ],
)

export const mentions = pgTable(
  'mentions',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    platform: text('platform').$type<MentionPlatformColumn>().notNull(),
    postId: text('post_id').notNull(),
    url: text('url').notNull(),
    text: text('text').notNull(),
    authorHandle: text('author_handle').notNull(),
    authorName: text('author_name').notNull(),
    authorUrl: text('author_url').notNull(),
    /** `bigint` in `number` mode: follower counts can pass int4. */
    authorFollowers: bigint('author_followers', { mode: 'number' }),
    likes: integer('likes'),
    reposts: integer('reposts'),
    replies: integer('replies'),
    quotes: integer('quotes'),
    views: bigint('views', { mode: 'number' }),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
    matchedTerm: text('matched_term').notNull(),
    linksToSite: boolean('links_to_site').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('mentions_site_platform_post_key').on(t.siteId, t.platform, t.postId),
    index('mentions_site_posted_idx').on(t.siteId, t.postedAt.desc(), t.id.desc()),
    check('mentions_platform_check', sql`${t.platform} IN ('x')`),
    check('mentions_text_length_check', sql`char_length(${t.text}) <= 1000`),
    check('mentions_url_check', sql`${t.url} ~ '^https://'`),
    check('mentions_author_url_check', sql`${t.authorUrl} ~ '^https://'`),
  ],
)

export type MentionAvatarContentTypeColumn = 'image/jpeg' | 'image/png' | 'image/webp'

/** `bytea`. node-postgres reads it as a `Buffer` and writes a `Buffer` as one. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const mentionAvatars = pgTable(
  'mention_avatars',
  {
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    platform: text('platform').$type<MentionPlatformColumn>().notNull(),
    authorHandle: text('author_handle').notNull(),
    contentType: text('content_type').$type<MentionAvatarContentTypeColumn>().notNull(),
    bytes: bytea('bytes').notNull(),
    sourceUrl: text('source_url').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'mention_avatars_pkey', columns: [t.siteId, t.platform, t.authorHandle] }),
    check('mention_avatars_platform_check', sql`${t.platform} IN ('x')`),
    check('mention_avatars_handle_check', sql`${t.authorHandle} ~ '^[A-Za-z0-9_]{1,15}$'`),
    check(
      'mention_avatars_content_type_check',
      sql`${t.contentType} IN ('image/jpeg', 'image/png', 'image/webp')`,
    ),
    check('mention_avatars_bytes_size_check', sql`octet_length(${t.bytes}) <= 32768`),
    check('mention_avatars_source_url_check', sql`${t.sourceUrl} ~ '^https://pbs\\.twimg\\.com/'`),
  ],
)
