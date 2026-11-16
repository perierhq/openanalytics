import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type {
  MentionAvatarContentType,
  MentionPlatform,
  MentionPollError,
} from '@openanalytics/domain'
import type { Database } from '../client.ts'
import { newId } from '../ids.ts'
import { writeAudit } from './audit.ts'
import { mentionAvatars, mentions, siteMentionSettings } from '../schema/mentions.ts'
import { siteDomains, sites } from '../schema/sites.ts'

/**
 * X mentions (migration 0048): per-site watch settings and the stored posts;
 * and the authors' pictures (migration 0049).
 *
 * Every read and write takes `siteId` and puts it in the `WHERE`, so a caller
 * authorized on one site cannot reach another site's mentions by holding a
 * post id.
 *
 * A site's "domain" here is its first domain by `lower(domain)` — the same
 * stable order the site list and the public dashboard use, because
 * `site_domains` has no primary flag and no ordering column. Only that domain
 * is searched; `links_to_site` is decided against all of them.
 */

export interface MentionSettingsRecord {
  /** The searched domain, or null when the site has no domain at all. */
  readonly domain: string | null
  /** Every domain on the site, lowercased and sorted. */
  readonly domains: readonly string[]
  readonly xEnabled: boolean
  readonly terms: readonly string[]
  readonly lastPolledAt: Date | null
  readonly lastError: MentionPollError | null
}

/** What a log line may say about a failed database call. */
export interface DbErrorFacts {
  readonly category: 'database'
  /** The SQLSTATE, when the driver reported one. */
  readonly db_code?: string
  /** The constraint that refused the write, when there was one. */
  readonly db_constraint?: string
}

const SQLSTATE = /^[0-9A-Z]{5}$/u
const IDENTIFIER = /^[a-z_][a-z0-9_$]{0,62}$/u

/**
 * The loggable facts of a database error: a category, the SQLSTATE and the
 * constraint name, and nothing else.
 *
 * Never log the error itself. drizzle's `DrizzleQueryError` puts the statement
 * and its parameters in `message`, and for the mentions tables the parameters
 * are post text, author names and search terms. The `pg` error carrying `code`
 * and `constraint` hangs off `cause`, so the chain is walked; both values are
 * held to their shapes so nothing else can ride along.
 */
export function dbErrorFacts(err: unknown): DbErrorFacts {
  let code: string | undefined
  let constraint: string | undefined
  let current: unknown = err
  for (let depth = 0; typeof current === 'object' && current !== null && depth < 5; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (code === undefined && typeof candidate.code === 'string' && SQLSTATE.test(candidate.code)) {
      code = candidate.code
    }
    if (
      constraint === undefined &&
      typeof candidate.constraint === 'string' &&
      IDENTIFIER.test(candidate.constraint)
    ) {
      constraint = candidate.constraint
    }
    current = candidate.cause
  }
  return {
    category: 'database',
    ...(code === undefined ? {} : { db_code: code }),
    ...(constraint === undefined ? {} : { db_constraint: constraint }),
  }
}

/** Lowercased, sorted domains of one site, as one aggregated expression. */
const domainsOf = (siteId: unknown) => sql<string[]>`coalesce((
  SELECT array_agg(lower(d.domain) ORDER BY lower(d.domain))
  FROM site_domains d
  WHERE d.site_id = ${siteId}
), '{}')`

/** A site's domains, in the stable order the rest of the product uses. */
async function readSiteDomains(db: Database, siteId: string): Promise<string[]> {
  const rows = await db
    .select({ domain: sql<string>`lower(${siteDomains.domain})` })
    .from(siteDomains)
    .where(eq(siteDomains.siteId, siteId))
    .orderBy(asc(sql`lower(${siteDomains.domain})`))
  return rows.map((row) => row.domain)
}

/**
 * The settings for one site, or the defaults when it has never saved any —
 * never a 404, because "watching is off" is an answer.
 */
export async function readMentionSettings(
  db: Database,
  siteId: string,
): Promise<MentionSettingsRecord> {
  const domains = await readSiteDomains(db, siteId)
  const [row] = await db
    .select({
      xEnabled: siteMentionSettings.xEnabled,
      terms: siteMentionSettings.terms,
      lastPolledAt: siteMentionSettings.lastPolledAt,
      lastError: siteMentionSettings.lastError,
    })
    .from(siteMentionSettings)
    .where(eq(siteMentionSettings.siteId, siteId))
  return {
    domain: domains[0] ?? null,
    domains,
    xEnabled: row?.xEnabled ?? false,
    terms: row?.terms ?? [],
    lastPolledAt: row?.lastPolledAt ?? null,
    lastError: row?.lastError ?? null,
  }
}

export interface UpsertMentionSettingsInput {
  readonly siteId: string
  readonly actorUserId: string
  readonly xEnabled?: boolean
  readonly terms?: readonly string[]
}

/** The settings row as stored, without the site's domains. */
export interface StoredMentionSettings {
  readonly xEnabled: boolean
  readonly terms: readonly string[]
  readonly lastPolledAt: Date | null
  readonly lastError: MentionPollError | null
}

/**
 * Writes the fields the caller sent and leaves the rest alone, with an audit
 * row in the same transaction. The audit records which fields moved, whether
 * watching is on and how many terms there are — not the terms themselves.
 * Returns the row as stored, so the caller need not read it back.
 */
export async function upsertMentionSettings(
  db: Database,
  input: UpsertMentionSettingsInput,
): Promise<StoredMentionSettings> {
  const values = {
    ...(input.xEnabled === undefined ? {} : { xEnabled: input.xEnabled }),
    ...(input.terms === undefined ? {} : { terms: [...input.terms] }),
  }
  const now = new Date()
  return db.transaction(async (tx) => {
    const [stored] = await tx
      .insert(siteMentionSettings)
      .values({
        siteId: input.siteId,
        ...values,
        updatedAt: now,
        updatedByUserId: input.actorUserId,
      })
      .onConflictDoUpdate({
        target: siteMentionSettings.siteId,
        set: { ...values, updatedAt: now, updatedByUserId: input.actorUserId },
      })
      .returning({
        xEnabled: siteMentionSettings.xEnabled,
        terms: siteMentionSettings.terms,
        lastPolledAt: siteMentionSettings.lastPolledAt,
        lastError: siteMentionSettings.lastError,
      })
    if (stored === undefined) throw new Error('mention settings upsert returned no row')

    await writeAudit(tx, {
      action: 'site.mentions.updated',
      actorUserId: input.actorUserId,
      siteId: input.siteId,
      targetType: 'site',
      targetId: input.siteId,
      metadata: {
        fields: Object.keys(values),
        x_enabled: stored.xEnabled,
        term_count: stored.terms.length,
      },
    })
    return stored
  })
}

export interface MentionPollTarget {
  readonly siteId: string
  readonly domain: string | null
  readonly domains: readonly string[]
  readonly terms: readonly string[]
  /** Null before the site's first poll, which pages deeper. */
  readonly lastPolledAt: Date | null
}

/**
 * Active sites with watching on whose last poll is older than `staleBefore`
 * (or that were never polled), least recently polled first.
 */
export async function listSitesDueForMentionPoll(
  db: Database,
  input: { readonly staleBefore: Date; readonly limit: number },
): Promise<MentionPollTarget[]> {
  const rows = await db
    .select({
      siteId: siteMentionSettings.siteId,
      terms: siteMentionSettings.terms,
      lastPolledAt: siteMentionSettings.lastPolledAt,
      domains: domainsOf(siteMentionSettings.siteId),
    })
    .from(siteMentionSettings)
    .innerJoin(sites, eq(sites.id, siteMentionSettings.siteId))
    .where(
      and(
        eq(siteMentionSettings.xEnabled, true),
        eq(sites.status, 'active'),
        or(
          isNull(siteMentionSettings.lastPolledAt),
          lt(siteMentionSettings.lastPolledAt, input.staleBefore),
        ),
      ),
    )
    .orderBy(
      sql`${siteMentionSettings.lastPolledAt} ASC NULLS FIRST`,
      asc(siteMentionSettings.siteId),
    )
    .limit(input.limit)
  return rows.map((row) => {
    const domains = row.domains ?? []
    return {
      siteId: row.siteId,
      domain: domains[0] ?? null,
      domains,
      terms: row.terms,
      lastPolledAt: row.lastPolledAt,
    }
  })
}

/** Stamps a finished poll: when, and why it failed (null on success). */
export async function recordMentionPoll(
  db: Database,
  input: { readonly siteId: string; readonly error: MentionPollError | null; readonly at?: Date },
): Promise<void> {
  await db
    .update(siteMentionSettings)
    .set({ lastPolledAt: input.at ?? new Date(), lastError: input.error })
    .where(eq(siteMentionSettings.siteId, input.siteId))
}

export interface MentionUpsertRow {
  readonly postId: string
  readonly url: string
  readonly text: string
  readonly authorHandle: string
  readonly authorName: string
  readonly authorUrl: string
  readonly authorFollowers: number | null
  readonly likes: number | null
  readonly reposts: number | null
  readonly replies: number | null
  readonly quotes: number | null
  readonly views: number | null
  readonly postedAt: Date
  readonly matchedTerm: string
  readonly linksToSite: boolean
}

/**
 * Inserts new posts and refreshes known ones. A known post gets its counts,
 * text, author fields, link flag and `refreshed_at` updated; `first_seen_at`
 * and the original `matched_term` are kept. Returns the rows written.
 */
export async function upsertMentions(
  db: Database,
  input: {
    readonly siteId: string
    readonly platform: MentionPlatform
    readonly posts: readonly MentionUpsertRow[]
  },
): Promise<number> {
  if (input.posts.length === 0) return 0
  // One row per post id: a duplicate inside one statement would make
  // `ON CONFLICT DO UPDATE` affect the same row twice, which Postgres refuses.
  const unique = new Map<string, MentionUpsertRow>()
  for (const post of input.posts) if (!unique.has(post.postId)) unique.set(post.postId, post)

  const now = new Date()
  const rows = await db
    .insert(mentions)
    .values(
      [...unique.values()].map((post) => ({
        id: newId(),
        siteId: input.siteId,
        platform: input.platform,
        ...post,
        firstSeenAt: now,
        refreshedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [mentions.siteId, mentions.platform, mentions.postId],
      set: {
        url: sql`excluded.url`,
        text: sql`excluded.text`,
        authorHandle: sql`excluded.author_handle`,
        authorName: sql`excluded.author_name`,
        authorUrl: sql`excluded.author_url`,
        authorFollowers: sql`excluded.author_followers`,
        likes: sql`excluded.likes`,
        reposts: sql`excluded.reposts`,
        replies: sql`excluded.replies`,
        quotes: sql`excluded.quotes`,
        views: sql`excluded.views`,
        linksToSite: sql`excluded.links_to_site`,
        refreshedAt: sql`excluded.refreshed_at`,
      },
    })
    .returning({ id: mentions.id })
  return rows.length
}

/** Which of these post ids this site already holds for the platform. */
export async function existingMentionPostIds(
  db: Database,
  siteId: string,
  platform: MentionPlatform,
  postIds: readonly string[],
): Promise<Set<string>> {
  if (postIds.length === 0) return new Set()
  const rows = await db
    .select({ postId: mentions.postId })
    .from(mentions)
    .where(
      and(
        eq(mentions.siteId, siteId),
        eq(mentions.platform, platform),
        inArray(mentions.postId, [...postIds]),
      ),
    )
  return new Set(rows.map((row) => row.postId))
}

export interface MentionRecord {
  readonly id: string
  readonly platform: MentionPlatform
  readonly postId: string
  readonly url: string
  readonly text: string
  readonly authorHandle: string
  readonly authorName: string
  readonly authorUrl: string
  readonly authorFollowers: number | null
  readonly likes: number | null
  readonly reposts: number | null
  readonly replies: number | null
  readonly quotes: number | null
  readonly views: number | null
  readonly postedAt: Date
  readonly matchedTerm: string
  readonly linksToSite: boolean
  readonly firstSeenAt: Date
  readonly refreshedAt: Date
  /** Whether the site holds a picture for this post's author (migration 0049). */
  readonly authorHasAvatar: boolean
}

export interface ListMentionsInput {
  readonly siteId: string
  /** Half-open `[from, to)` on `posted_at`. */
  readonly from: Date
  readonly to: Date
  readonly platform?: MentionPlatform
  /** Resume strictly after this `(posted_at, id)` position. */
  readonly after?: { readonly postedAt: Date; readonly id: string }
  /** Rows to return. The route asks for its page size plus one. */
  readonly limit: number
}

/** A page of mentions, keyset on `(posted_at, id)` descending. */
export async function listMentions(
  db: Database,
  input: ListMentionsInput,
): Promise<MentionRecord[]> {
  const conditions = [
    eq(mentions.siteId, input.siteId),
    sql`${mentions.postedAt} >= ${input.from.toISOString()}::timestamptz`,
    sql`${mentions.postedAt} < ${input.to.toISOString()}::timestamptz`,
  ]
  if (input.platform !== undefined) conditions.push(eq(mentions.platform, input.platform))
  if (input.after !== undefined) {
    conditions.push(
      sql`(${mentions.postedAt}, ${mentions.id}) < (${input.after.postedAt.toISOString()}::timestamptz, ${input.after.id}::uuid)`,
    )
  }
  return db
    .select({
      id: mentions.id,
      platform: mentions.platform,
      postId: mentions.postId,
      url: mentions.url,
      text: mentions.text,
      authorHandle: mentions.authorHandle,
      authorName: mentions.authorName,
      authorUrl: mentions.authorUrl,
      authorFollowers: mentions.authorFollowers,
      likes: mentions.likes,
      reposts: mentions.reposts,
      replies: mentions.replies,
      quotes: mentions.quotes,
      views: mentions.views,
      postedAt: mentions.postedAt,
      matchedTerm: mentions.matchedTerm,
      linksToSite: mentions.linksToSite,
      firstSeenAt: mentions.firstSeenAt,
      refreshedAt: mentions.refreshedAt,
      // A primary-key probe per returned row. In the select list rather than a
      // join so the keyset scan on `mentions_site_posted_idx` and its LIMIT are
      // untouched: only the rows that are returned are probed.
      // Qualified by hand: drizzle prints a column of the single selected
      // table unqualified, which inside this subquery would bind to
      // `mention_avatars` and make every row match itself.
      authorHasAvatar: sql<boolean>`EXISTS (
        SELECT 1 FROM mention_avatars a
        WHERE a.site_id = mentions.site_id
          AND a.platform = mentions.platform
          AND a.author_handle = mentions.author_handle
      )`,
    })
    .from(mentions)
    .where(and(...conditions))
    .orderBy(desc(mentions.postedAt), desc(mentions.id))
    .limit(input.limit)
}

export interface MentionAvatarUpsert {
  readonly siteId: string
  readonly platform: MentionPlatform
  readonly handle: string
  /** From the bytes' magic numbers, never a response header. */
  readonly contentType: MentionAvatarContentType
  readonly bytes: Uint8Array
  readonly sourceUrl: string
  readonly fetchedAt?: Date
}

/** Stores an author's picture for a site, replacing the one held before. */
export async function upsertMentionAvatar(db: Database, input: MentionAvatarUpsert): Promise<void> {
  const values = {
    contentType: input.contentType,
    bytes: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
    sourceUrl: input.sourceUrl,
    fetchedAt: input.fetchedAt ?? new Date(),
  }
  await db
    .insert(mentionAvatars)
    .values({
      siteId: input.siteId,
      platform: input.platform,
      authorHandle: input.handle,
      ...values,
    })
    .onConflictDoUpdate({
      target: [mentionAvatars.siteId, mentionAvatars.platform, mentionAvatars.authorHandle],
      set: values,
    })
}

export interface MentionAvatarState {
  readonly handle: string
  readonly fetchedAt: Date
  readonly sourceUrl: string
}

/**
 * When each of these authors' pictures was last stored for the site, and from
 * where. An author with no picture has no entry. The bytes are not read.
 */
export async function avatarStateForHandles(
  db: Database,
  siteId: string,
  platform: MentionPlatform,
  handles: readonly string[],
): Promise<MentionAvatarState[]> {
  if (handles.length === 0) return []
  return db
    .select({
      handle: mentionAvatars.authorHandle,
      fetchedAt: mentionAvatars.fetchedAt,
      sourceUrl: mentionAvatars.sourceUrl,
    })
    .from(mentionAvatars)
    .where(
      and(
        eq(mentionAvatars.siteId, siteId),
        eq(mentionAvatars.platform, platform),
        inArray(mentionAvatars.authorHandle, [...handles]),
      ),
    )
}

export interface MentionAvatarRecord {
  readonly contentType: MentionAvatarContentType
  /** A copy on a plain `ArrayBuffer`, ready to be a response body. */
  readonly bytes: Uint8Array<ArrayBuffer>
}

/** One author's stored picture for the site, or null when there is none. */
export async function readMentionAvatar(
  db: Database,
  siteId: string,
  platform: MentionPlatform,
  handle: string,
): Promise<MentionAvatarRecord | null> {
  const [row] = await db
    .select({ contentType: mentionAvatars.contentType, bytes: mentionAvatars.bytes })
    .from(mentionAvatars)
    .where(
      and(
        eq(mentionAvatars.siteId, siteId),
        eq(mentionAvatars.platform, platform),
        eq(mentionAvatars.authorHandle, handle),
      ),
    )
  return row === undefined
    ? null
    : { contentType: row.contentType, bytes: new Uint8Array(row.bytes) }
}
