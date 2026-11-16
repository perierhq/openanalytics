import {
  ApiError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  utcInstantSchema,
} from '@openanalytics/contracts'
import {
  MENTION_PLATFORMS,
  isMentionAuthorHandle,
  normalizeMentionSettingsPatch,
  type MentionPlatform,
} from '@openanalytics/domain'
import {
  dbErrorFacts,
  listMentions,
  readMentionAvatar,
  readMentionSettings,
  upsertMentionSettings,
  type Database,
  type MentionRecord,
  type MentionSettingsRecord,
  type StoredMentionSettings,
} from '@openanalytics/postgres'
import { Hono } from 'hono'
import {
  decodeMentionsCursor,
  encodeMentionsCursor,
  type MentionsCursor,
} from '../analytics/mentions-cursor.ts'
import { requireCapability, siteMembership, type ApiVariables } from './middleware.ts'

/**
 * X mentions (migration 0048): the settings and the list; and the authors'
 * pictures (migration 0049).
 *
 * **Reading is membership-only**, viewer included: what was found and what is
 * searched expose nothing a viewer cannot already see on the public web.
 * **Writing the settings requires `site:settings`** (owner or admin), because
 * turning watching on sends the site's domain and terms to a third-party search
 * service on every poll.
 *
 * Both settings routes are session-only: they carry no `GRANT_WRITE_ALLOWLIST`
 * row, so an OAuth grant cannot change what this install sends to a third
 * party. The list has a row (`analytics:read`), which is what the
 * `list_mentions` MCP tool reaches.
 *
 * **The picture route** serves the bytes the worker stored, so a viewer's
 * browser never requests anything from X. Membership-only like the list, and
 * session-only like the settings: it has no grant row, because a picture is
 * for the dashboard and nothing an MCP client needs. The bytes were typed from
 * their magic numbers when stored (JPEG, PNG or WebP only), and the response
 * forbids sniffing and carries a `default-src 'none'` policy, so even a
 * picture opened on its own can never act as a document.
 */

type Env = { Variables: ApiVariables }

function validationFailed(message: string, issues: readonly Record<string, unknown>[]): never {
  throw new ApiError('VALIDATION_FAILED', message, { details: { issues } })
}

function settingsJson(settings: MentionSettingsRecord) {
  return {
    // The contract types `domain` as a string; a site with no domain at all
    // answers the empty string, and the poller searches its terms only.
    domain: settings.domain ?? '',
    x_enabled: settings.xEnabled,
    terms: [...settings.terms],
    last_polled_at: settings.lastPolledAt?.toISOString() ?? null,
    last_error: settings.lastError,
  }
}

/** Where the API serves an author's picture for a site. */
function avatarPath(siteId: string, platform: MentionPlatform, handle: string): string {
  return `/v1/sites/${encodeURIComponent(siteId)}/mentions/avatars/${platform}/${encodeURIComponent(handle)}`
}

function mentionJson(siteId: string, row: MentionRecord) {
  return {
    id: row.id,
    platform: row.platform,
    post_id: row.postId,
    url: row.url,
    text: row.text,
    author: {
      handle: row.authorHandle,
      name: row.authorName,
      followers: row.authorFollowers,
      url: row.authorUrl,
      avatar_url: row.authorHasAvatar ? avatarPath(siteId, row.platform, row.authorHandle) : null,
    },
    posted_at: row.postedAt.toISOString(),
    matched_term: row.matchedTerm,
    links_to_site: row.linksToSite,
    likes: row.likes,
    reposts: row.reposts,
    replies: row.replies,
    quotes: row.quotes,
    views: row.views,
    first_seen_at: row.firstSeenAt.toISOString(),
    refreshed_at: row.refreshedAt.toISOString(),
  }
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'A JSON request body is required')
  }
}

interface ListQuery {
  readonly from: Date
  readonly to: Date
  readonly cursor: MentionsCursor | null
  readonly limit: number
  readonly platform: MentionPlatform | undefined
}

/** Validates the list query; every problem is reported at once as a 400. */
function parseListQuery(query: Record<string, string | undefined>): ListQuery {
  const issues: { path: string; message: string }[] = []

  const from = utcInstantSchema.safeParse(query['from'])
  if (!from.success) issues.push({ path: 'from', message: 'from must be an ISO-8601 UTC instant' })
  const to = utcInstantSchema.safeParse(query['to'])
  if (!to.success) issues.push({ path: 'to', message: 'to must be an ISO-8601 UTC instant' })
  if (from.success && to.success && new Date(from.data) > new Date(to.data)) {
    issues.push({ path: 'to', message: 'to must not be before from' })
  }

  let limit = DEFAULT_PAGE_SIZE
  const rawLimit = query['limit']
  if (rawLimit !== undefined) {
    const n = Number(rawLimit)
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
      issues.push({ path: 'limit', message: `must be an integer in [1, ${String(MAX_PAGE_SIZE)}]` })
    } else {
      limit = n
    }
  }

  let cursor: MentionsCursor | null = null
  const rawCursor = query['cursor']
  if (rawCursor !== undefined && rawCursor !== '') {
    cursor = decodeMentionsCursor(rawCursor)
    if (cursor === null) {
      issues.push({ path: 'cursor', message: 'malformed or from an incompatible version' })
    }
  }

  let platform: MentionPlatform | undefined
  const rawPlatform = query['platform']
  if (rawPlatform !== undefined) {
    if ((MENTION_PLATFORMS as readonly string[]).includes(rawPlatform)) {
      platform = rawPlatform as MentionPlatform
    } else {
      issues.push({ path: 'platform', message: `must be one of ${MENTION_PLATFORMS.join(', ')}` })
    }
  }

  if (issues.length > 0) validationFailed('Invalid mentions query parameters', issues)
  return {
    from: new Date(from.data as string),
    to: new Date(to.data as string),
    cursor,
    limit,
    platform,
  }
}

export function createMentionRoutes(deps: { db: Database }): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()

  const base = '/sites/:site_id/mentions'
  app.use(base, siteMembership(db))
  app.use(`${base}/*`, siteMembership(db))

  app.get(`${base}/settings`, async (c) => {
    const { siteId } = c.get('membership')
    return c.json(settingsJson(await readMentionSettings(db, siteId)))
  })

  app.patch(`${base}/settings`, requireCapability('site:settings'), async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const body = await readJson(c)

    // The domain is needed to drop a term equal to it, so it is read first.
    const before = await readMentionSettings(db, siteId)
    const normalized = normalizeMentionSettingsPatch(body, before.domain)
    if (!normalized.ok) {
      validationFailed(
        'The mention settings patch is not valid',
        normalized.issues.map((issue) => ({ field: issue.field, code: issue.code })),
      )
    }

    // Watching with nothing to search would poll forever and find nothing.
    const xEnabled = normalized.value.xEnabled ?? before.xEnabled
    const terms = normalized.value.terms ?? before.terms
    if (xEnabled && before.domain === null && terms.length === 0) {
      validationFailed('The mention settings patch is not valid', [
        {
          field: 'x_enabled',
          code: 'nothing_to_search',
          message: 'Add a domain to the site or at least one term first.',
        },
      ])
    }

    let stored: StoredMentionSettings
    try {
      stored = await upsertMentionSettings(db, {
        siteId,
        actorUserId: actor.id,
        ...(normalized.value.xEnabled === undefined ? {} : { xEnabled: normalized.value.xEnabled }),
        ...(normalized.value.terms === undefined ? {} : { terms: normalized.value.terms }),
      })
    } catch (err) {
      // Never the error itself: its message carries the statement's
      // parameters, which are the terms. A fresh error goes to the envelope.
      c.get('logger')?.error('mentions_settings_write_failed', {
        site_id: siteId,
        ...dbErrorFacts(err),
        retryable: true,
      })
      throw new ApiError('INTERNAL_ERROR', 'Internal error', { expose: false })
    }
    return c.json(settingsJson({ ...before, ...stored }))
  })

  app.get(base, async (c) => {
    const { siteId } = c.get('membership')
    const query = parseListQuery(c.req.query())

    // Over-fetch by one so `has_more` is exact without a count query.
    const rows = await listMentions(db, {
      siteId,
      from: query.from,
      to: query.to,
      ...(query.platform === undefined ? {} : { platform: query.platform }),
      ...(query.cursor === null
        ? {}
        : { after: { postedAt: new Date(query.cursor.postedAtMs), id: query.cursor.id } }),
      limit: query.limit + 1,
    })

    const hasMore = rows.length > query.limit
    const items = hasMore ? rows.slice(0, query.limit) : rows
    const last = items.at(-1)
    return c.json({
      items: items.map((row) => mentionJson(siteId, row)),
      next_cursor:
        hasMore && last !== undefined
          ? encodeMentionsCursor({ postedAtMs: last.postedAt.getTime(), id: last.id })
          : null,
      has_more: hasMore,
    })
  })

  app.get(`${base}/avatars/:platform/:handle`, async (c) => {
    const { siteId } = c.get('membership')
    const platform = c.req.param('platform')
    const handle = c.req.param('handle')
    const issues: { path: string; message: string }[] = []
    if (!(MENTION_PLATFORMS as readonly string[]).includes(platform)) {
      issues.push({ path: 'platform', message: `must be one of ${MENTION_PLATFORMS.join(', ')}` })
    }
    if (!isMentionAuthorHandle(handle)) {
      issues.push({ path: 'handle', message: 'must match ^[A-Za-z0-9_]{1,15}$' })
    }
    if (issues.length > 0) validationFailed('Invalid mention avatar path', issues)

    const avatar = await readMentionAvatar(db, siteId, platform as MentionPlatform, handle)
    if (avatar === null) throw new ApiError('NOT_FOUND', 'No picture is stored for that author')
    return c.body(avatar.bytes, 200, {
      'content-type': avatar.contentType,
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    })
  })

  return app
}
