/**
 * X mentions: the pure half (migration 0048).
 *
 * A worker searches X through a configurable fxtwitter-compatible service for
 * each opted-in site's domain plus a few extra terms, and stores what it finds.
 * Everything here is free of I/O so the poller, the API and the tests share one
 * definition of what a post is, what links to a site, which settings are legal
 * and which queries a site's settings produce.
 *
 * Naming is platform-generic on purpose (`mentions`, `platform`): X is the only
 * platform today, and another one should be a new parser and a new enum value,
 * not a new resource.
 */

/** Where a mention was posted. Mirrors the `mentions.platform` CHECK. */
export const MENTION_PLATFORMS = ['x'] as const
export type MentionPlatform = (typeof MENTION_PLATFORMS)[number]

/** Why the last poll failed. Mirrors the `site_mention_settings.last_error` CHECK. */
export const MENTION_POLL_ERRORS = ['unavailable', 'invalid_response'] as const
export type MentionPollError = (typeof MENTION_POLL_ERRORS)[number]

/** Stored text is cut here; mirrors the `mentions_text_length_check`. */
export const MENTION_TEXT_MAX_LENGTH = 1000
/** A display name is cut here. X caps names at 50; this leaves room. */
export const MENTION_AUTHOR_NAME_MAX_LENGTH = 100

/**
 * The shapes an X handle and post id must have before either is put into a
 * link. Both links are built from them rather than taken from the response,
 * so an upstream `javascript:` or relative URL can never reach an `href`.
 */
const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/u
const POST_ID_PATTERN = /^\d{1,25}$/u

/** C0 controls except tab (U+0009) and newline (U+000A). Postgres refuses
 * U+0000 in `text`, and none of the others belongs in a post. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F]/gu
/** Extra terms per site; mirrors `site_mention_settings_terms_count_check`. */
export const MENTION_TERMS_MAX = 5
export const MENTION_TERM_MIN_LENGTH = 2
export const MENTION_TERM_MAX_LENGTH = 64

/** The int4 ceiling: the per-post counters are `integer` columns. */
const INT4_MAX = 2_147_483_647

/**
 * Author pictures (migration 0049). The poller downloads a small copy once a
 * week at most per author and site, and the API serves it, so a dashboard
 * viewer's browser never contacts X.
 *
 * The one host anything is ever downloaded from. An exact match, never a
 * suffix: the source URL comes from a third-party response, and this is the
 * guard that keeps it from pointing the worker anywhere else.
 */
export const MENTION_AVATAR_HOST = 'pbs.twimg.com'
/** A stored picture is at most this many bytes; mirrors
 * `mention_avatars_bytes_size_check`. The 48 px variant is 1–4 KB. */
export const MENTION_AVATAR_MAX_BYTES = 32_768
/** The types a stored picture may have; mirrors
 * `mention_avatars_content_type_check`. Read from the bytes, never a header. */
export const MENTION_AVATAR_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type MentionAvatarContentType = (typeof MENTION_AVATAR_CONTENT_TYPES)[number]
/** A stored picture older than this is downloaded again. */
export const MENTION_AVATAR_MAX_AGE_MS = 7 * 24 * 60 * 60_000
/** A source URL longer than this is not one X hands out. */
const AVATAR_URL_MAX_LENGTH = 2048
/** X's size suffixes: `_200x200`, `_400x400`, `_bigger`, `_mini`, … */
const AVATAR_SIZE_SUFFIX =
  /_(?:\d{1,4}x\d{1,4}|normal|bigger|mini|reasonably_small|x96)\.([A-Za-z]{3,4})$/u

/**
 * Whether a URL may be downloaded as an author picture: `https:` on exactly
 * `pbs.twimg.com`, on the default port, with no credentials. Checked by the
 * parser and again by the download client, so neither trusts the other.
 */
export function isMentionAvatarUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > AVATAR_URL_MAX_LENGTH) {
    return false
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === MENTION_AVATAR_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  )
}

/**
 * The source URL to store for an author's picture, or null when there is none
 * the worker may fetch. A sized variant is rewritten to the 48 px one
 * (`_400x400.jpg` → `_normal.jpg`); a URL with no recognised suffix is kept as
 * it is.
 */
export function mentionAvatarSourceUrl(raw: unknown): string | null {
  if (!isMentionAvatarUrl(raw)) return null
  const url = new URL(raw)
  url.pathname = url.pathname.replace(AVATAR_SIZE_SUFFIX, '_normal.$1')
  return url.href
}

/**
 * The picture's type from its first bytes: JPEG `FF D8 FF`, PNG
 * `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF....WEBP`. Anything else — HTML, SVG,
 * GIF, an empty body — is null and is never stored.
 */
export function sniffMentionAvatarType(bytes: Uint8Array): MentionAvatarContentType | null {
  const starts = (offset: number, expected: readonly number[]) =>
    bytes.length >= offset + expected.length &&
    expected.every((value, i) => bytes[offset + i] === value)
  if (starts(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  // 'RIFF', a four-byte length, 'WEBP'.
  if (starts(0, [0x52, 0x49, 0x46, 0x46]) && starts(8, [0x57, 0x45, 0x42, 0x50])) {
    return 'image/webp'
  }
  return null
}

/** Whether a string is an X handle: `[A-Za-z0-9_]{1,15}`. */
export function isMentionAuthorHandle(value: string): boolean {
  return HANDLE_PATTERN.test(value)
}

/** One post, as the poller stores it. No language, no raw facets. */
export interface ParsedPost {
  /** Digits only, at most 25. */
  readonly postId: string
  /** Built here as `https://x.com/{handle}/status/{postId}`, never taken from
   * the response. */
  readonly url: string
  /** Shortened links already expanded; cut at `MENTION_TEXT_MAX_LENGTH`. */
  readonly text: string
  /** `[A-Za-z0-9_]{1,15}`. */
  readonly authorHandle: string
  /** Cut at `MENTION_AUTHOR_NAME_MAX_LENGTH`; the handle when there is none. */
  readonly authorName: string
  /** Built here as `https://x.com/{handle}`. */
  readonly authorUrl: string
  readonly authorFollowers: number | null
  readonly likes: number | null
  readonly reposts: number | null
  readonly replies: number | null
  readonly quotes: number | null
  readonly views: number | null
  readonly postedAt: Date
  /** Lowercased hosts of the expanded links in the post. Used for
   * `links_to_site`, never stored. */
  readonly linkHosts: readonly string[]
  /** Where the author's picture may be downloaded from (`https://pbs.twimg.com`
   * only, 48 px variant), or null. Not a column on `mentions`: the poller
   * downloads it into `mention_avatars`, and nothing ever links to it. */
  readonly authorAvatarSourceUrl: string | null
}

export type FxTwitterSearchParse =
  | { readonly ok: true; readonly posts: ParsedPost[]; readonly nextCursor: string | null }
  | { readonly ok: false; readonly detail: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** A string with the control characters removed, or null when nothing is left. */
function cleanString(value: unknown): string | null {
  return typeof value === 'string' ? nonEmptyString(value.replace(CONTROL_CHARS, '')) : null
}

/** Cut at `max` UTF-16 units without leaving half a surrogate pair behind. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  const cut = value.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** A count, or null when it is not a finite non-negative safe integer. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** A count for an `integer` column, clamped at the int4 ceiling. */
function int4Count(value: unknown): number | null {
  const n = count(value)
  return n === null ? null : Math.min(n, INT4_MAX)
}

function linkHostsOf(rawText: unknown): string[] {
  if (!isRecord(rawText) || !Array.isArray(rawText['facets'])) return []
  const hosts: string[] = []
  for (const facet of rawText['facets']) {
    if (!isRecord(facet) || facet['type'] !== 'url') continue
    const replacement = facet['replacement']
    if (typeof replacement !== 'string') continue
    let host: string
    try {
      host = new URL(replacement).hostname.toLowerCase()
    } catch {
      continue
    }
    if (host.length > 0 && !hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

function parseStatus(result: unknown): ParsedPost | null {
  if (!isRecord(result) || result['type'] !== 'status') return null
  const postId = typeof result['id'] === 'string' ? result['id'] : null
  const author = isRecord(result['author']) ? result['author'] : null
  const handle = author && typeof author['screen_name'] === 'string' ? author['screen_name'] : null
  const created = result['created_timestamp']
  if (postId === null || author === null || handle === null) return null
  // The upstream `url` and `author.url` are ignored: both links are built here
  // from a handle and an id that have been held to the platform's shape.
  if (!POST_ID_PATTERN.test(postId) || !HANDLE_PATTERN.test(handle)) return null
  if (typeof created !== 'number' || !Number.isFinite(created) || created <= 0) return null
  const postedAt = new Date(Math.trunc(created) * 1000)
  if (Number.isNaN(postedAt.getTime())) return null

  const text = cleanString(result['text']) ?? ''
  const name = cleanString(author['name'])
  return {
    postId,
    url: `https://x.com/${handle}/status/${postId}`,
    text: truncate(text, MENTION_TEXT_MAX_LENGTH),
    authorHandle: handle,
    authorName: name === null ? handle : truncate(name, MENTION_AUTHOR_NAME_MAX_LENGTH),
    authorUrl: `https://x.com/${handle}`,
    authorFollowers: count(author['followers']),
    likes: int4Count(result['likes']),
    reposts: int4Count(result['reposts']),
    replies: int4Count(result['replies']),
    quotes: int4Count(result['quotes']),
    views: count(result['views']),
    postedAt,
    linkHosts: linkHostsOf(result['raw_text']),
    authorAvatarSourceUrl: mentionAvatarSourceUrl(author['avatar_url']),
  }
}

/**
 * Reads an fxtwitter `/2/search` response body.
 *
 * Strict about the document, tolerant about each result: a body that is not a
 * search response is a failure (so an outage never reads as "no mentions"),
 * while a single result missing its id, handle or timestamp, or whose id or
 * handle is not the platform's shape, is skipped. Every string kept has its
 * control characters removed and is cut to its column's bound.
 */
export function parseFxTwitterSearch(json: unknown): FxTwitterSearchParse {
  if (!isRecord(json)) return { ok: false, detail: 'body is not an object' }
  if (json['code'] !== undefined && json['code'] !== 200) {
    return { ok: false, detail: 'body reports a non-200 code' }
  }
  const results = json['results']
  if (!Array.isArray(results)) return { ok: false, detail: 'body has no results array' }

  const posts: ParsedPost[] = []
  for (const result of results) {
    const post = parseStatus(result)
    if (post) posts.push(post)
  }
  const cursor = isRecord(json['cursor']) ? cleanString(json['cursor']['bottom']) : null
  return { ok: true, posts, nextCursor: cursor }
}

function bareHost(host: string): string {
  const lower = host.trim().toLowerCase()
  return lower.startsWith('www.') ? lower.slice(4) : lower
}

/**
 * Whether any link host is one of the site's domains or a subdomain of one.
 * Case-insensitive, ignoring a leading `www.` on either side. A suffix match
 * needs the dot, so `notexample.com` never matches `example.com`.
 */
export function linksToSite(linkHosts: readonly string[], siteDomains: readonly string[]): boolean {
  const domains = siteDomains.map(bareHost).filter((domain) => domain.length > 0)
  return linkHosts.some((raw) => {
    const host = bareHost(raw)
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
  })
}

/** The patch a mention-settings write may carry; absent means leave it alone. */
export interface MentionSettingsPatch {
  readonly xEnabled?: boolean
  readonly terms?: readonly string[]
}

export interface MentionSettingsIssue {
  readonly field: string
  readonly code: string
}

export type MentionSettingsPatchResult =
  | { readonly ok: true; readonly value: MentionSettingsPatch }
  | { readonly ok: false; readonly issues: readonly MentionSettingsIssue[] }

const PATCH_KEYS = ['x_enabled', 'terms'] as const

/**
 * Normalizes an untrusted `PATCH /mentions/settings` body.
 *
 * Terms replace the whole list: each is trimmed and must then be 2–64
 * characters; duplicates are dropped case-insensitively (first spelling wins);
 * a term equal to the site's domain is dropped, because the domain is always
 * searched. The count bound applies to what the caller sent, matching the
 * contract's `maxItems`.
 */
export function normalizeMentionSettingsPatch(
  input: unknown,
  siteDomain: string | null,
): MentionSettingsPatchResult {
  if (!isRecord(input)) {
    return { ok: false, issues: [{ field: 'body', code: 'not_an_object' }] }
  }
  const issues: MentionSettingsIssue[] = []
  const value: { xEnabled?: boolean; terms?: string[] } = {}

  for (const key of Object.keys(input)) {
    if (!(PATCH_KEYS as readonly string[]).includes(key))
      issues.push({ field: key, code: 'unknown' })
  }

  if (Object.hasOwn(input, 'x_enabled')) {
    const flag = input['x_enabled']
    if (typeof flag !== 'boolean') issues.push({ field: 'x_enabled', code: 'not_a_boolean' })
    else value.xEnabled = flag
  }

  if (Object.hasOwn(input, 'terms')) {
    const raw = input['terms']
    if (!Array.isArray(raw)) {
      issues.push({ field: 'terms', code: 'not_an_array' })
    } else if (raw.length > MENTION_TERMS_MAX) {
      issues.push({ field: 'terms', code: 'too_many' })
    } else {
      const domain = siteDomain === null ? null : bareHost(siteDomain)
      const terms: string[] = []
      const seen = new Set<string>()
      let bad = false
      raw.forEach((entry: unknown, index) => {
        if (typeof entry !== 'string') {
          issues.push({ field: `terms.${String(index)}`, code: 'not_a_string' })
          bad = true
          return
        }
        const term = entry.trim()
        if (term.length < MENTION_TERM_MIN_LENGTH || term.length > MENTION_TERM_MAX_LENGTH) {
          issues.push({ field: `terms.${String(index)}`, code: 'invalid_length' })
          bad = true
          return
        }
        const key = term.toLowerCase()
        if (seen.has(key)) return
        if (domain !== null && domain.length > 0 && bareHost(term) === domain) return
        seen.add(key)
        terms.push(term)
      })
      if (!bad) value.terms = terms
    }
  }

  if (issues.length > 0) return { ok: false, issues }
  if (Object.keys(value).length === 0) {
    return { ok: false, issues: [{ field: 'body', code: 'required_one_of' }] }
  }
  return { ok: true, value }
}

/**
 * The search queries for one site, in order: the bare domain first (X search
 * matches posts whose links contain it), then each extra term as an exact
 * phrase. Double quotes inside a term are removed so the phrase stays one.
 * A site without a domain searches its terms only.
 */
export function mentionQueries(domain: string | null, terms: readonly string[]): string[] {
  const queries: string[] = []
  if (domain !== null && domain.length > 0) queries.push(domain)
  for (const term of terms) {
    const phrase = term.replace(/"/gu, '').trim()
    if (phrase.length > 0) queries.push(`"${phrase}"`)
  }
  return queries
}
