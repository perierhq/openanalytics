import { PII_REDACTED, redactSensitiveText, sanitizeUrl } from './event-sanitize.ts'

/**
 * What a client-sent referrer becomes on the way into the pipeline (ADR-0028).
 *
 * Two rules, and one definition of each, because `referrer_domain` is a
 * *grouping key*: it is the ORDER BY prefix of `sources_15m`/`sources_1d`, the
 * first-touch dimension of a session fact, a column of the visitor trail and a
 * field on the realtime feed. Anything that writes it differently from anything
 * else silently splits one acquisition source into several rows that no reader
 * can merge back — the rollups are additive and never rewritten.
 *
 * - **Self-referral is not a source.** A browser sends `document.referrer` on
 *   every navigation, including one from the site's own previous page, and the
 *   tracker forwards the previous URL on SPA route changes too
 *   (`apps/tracker/src/core.ts`). Stored as-is, the customer's own domain
 *   appears in their Sources report as an external referrer — which is what
 *   the 2026-07-28 bug report showed on a live site. An internal navigation has
 *   no acquisition source, so the referrer is NULL: the same value the report
 *   already renders as Direct.
 * - **The key is a domain, not a URL.** `www.google.com`, `google.com` and
 *   `google.com/search?q=…` are one source. The stored key is the lowercase,
 *   `www.`-less, port-less hostname.
 *
 * Why the collector and not the tracker: this must fix sites that are already
 * serving a cached `oa.js`, and the browser is the one participant whose code
 * we cannot re-deploy. Why not the read path: a rollup key that has to be
 * repaired at query time is a key that also has to be repaired in every future
 * reader, and `sources_15m` groups *before* any reader sees a row.
 *
 * What this module deliberately does **not** do: move referrer attribution to
 * the session grain. It makes the per-EVENT value correct and nothing more.
 *
 * **That end state has shipped (M12 CP4, ADR-0033 D6 — the deferral ADR-0028 §8
 * recorded is closed).** "A referrer is attributed once, at session entry" lives
 * in `packages/domain/src/revenue-attribution.ts`, which reads a visitor's
 * session entries out of `session_facts_versions` as the touchpoints of a
 * purchase and writes the first and last of them into `revenue_attributions`'
 * `ft_`/`lt_` blocks. The session fact gained `utm_content` and `utm_term` in
 * ClickHouse migration 0017 so a touchpoint carries the full 02 §13 source
 * vocabulary. The sources **report** stays event-grain on purpose: it answers
 * "where did this pageview come from", which is a different question from "which
 * journey earned this revenue", and this module is the one definition both of
 * them build on.
 */

/** A referrer we resolved, in the exact form the pipeline stores. */
export interface ReferrerAttribution {
  /**
   * The grouping key: canonical host, external only. NULL when the referrer is
   * absent, unusable, or one of the site's own hosts — the three cases a report
   * renders identically as Direct.
   */
  readonly domain: string | null
  /** The referrer path, kept for drill-down. NULL whenever `domain` is. */
  readonly path: string | null
  /** True only when the referrer resolved to one of the site's own hosts. */
  readonly isSelf: boolean
}

/** No usable referrer: absent, unparseable, or not http(s). */
const NO_REFERRER: ReferrerAttribution = { domain: null, path: null, isSelf: false }

/** An internal navigation: the referrer parsed, and it was this site. */
const SELF_REFERRER: ReferrerAttribution = { domain: null, path: null, isSelf: true }

/**
 * A hostname reduced to the form two spellings of one host share.
 *
 * Lowercased, stripped of a port, of a single trailing dot and of one leading
 * `www.`. That is the whole list, and each entry is a spelling of the *same*
 * host rather than a related one: `m.example.com` and `blog.example.com` are
 * different hosts and are left alone (see the subdomain note in ADR-0028).
 *
 * Accepts a bare host, a `host:port`, or a bracketed IPv6 literal — the three
 * shapes it is called with (a configured allowlist entry, a `URL.host`).
 * Returns `''` for anything that reduces to nothing, which no caller may store.
 */
export function canonicalReferrerHost(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '') return ''

  // An IPv6 literal keeps its brackets and may carry `:` inside them, so the
  // port split below cannot be a plain `indexOf(':')`.
  let host: string
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end === -1) return ''
    host = trimmed.slice(0, end + 1)
  } else {
    const colon = trimmed.indexOf(':')
    host = colon === -1 ? trimmed : trimmed.slice(0, colon)
  }

  // `example.com.` and `example.com` are the same host; only one of them can
  // ever match the other side of the comparison.
  if (host.endsWith('.')) host = host.slice(0, -1)

  // One `www.`, and only a leading one: `www.www.example.com` is a real, if
  // unusual, host and `wwwexample.com` is a different site entirely.
  if (host.startsWith('www.') && host.length > 4) host = host.slice(4)

  return host
}

/** The site context a referrer is judged against. No I/O: both fields are
 * already in hand on the ingest path. */
export interface ReferrerContext {
  /**
   * The site's configured domains — `SiteIngestConfig.allowedDomains`, which the
   * collector has already resolved for the origin check. Empty is a legal state
   * (an unconfigured allowlist is not a deny), which is why `pageUrl` also
   * counts.
   */
  readonly siteDomains: readonly string[]
  /**
   * The URL of the page the event happened on. Its host is the site's own host
   * by definition — it is where the tracker is installed — so it catches
   * self-referral for the sites that have configured no allowlist at all. A
   * forged value can only null out the forger's own referrer, so trusting it
   * here costs nothing.
   */
  readonly pageUrl?: string | null | undefined
}

function pageHostOf(pageUrl: string | null | undefined): string {
  if (pageUrl === null || pageUrl === undefined || pageUrl === '') return ''
  try {
    return canonicalReferrerHost(new URL(pageUrl).host)
  } catch {
    return ''
  }
}

/**
 * Resolve a client-sent referrer into the value the pipeline stores.
 *
 * Returns the canonical external domain, or NULL for absent, unusable and
 * self-referrals alike. The three are one value on purpose: a report has one
 * bucket for "arrived with no source", and `isSelf` is carried for tests and
 * diagnostics rather than for storage.
 */
export function resolveReferrer(
  rawReferrer: string | null | undefined,
  context: ReferrerContext,
): ReferrerAttribution {
  if (rawReferrer === null || rawReferrer === undefined || rawReferrer === '') return NO_REFERRER

  const sanitized = sanitizeUrl(rawReferrer)
  if (sanitized === null) return NO_REFERRER

  const domain = canonicalReferrerHost(sanitized.host)
  if (domain === '') return NO_REFERRER

  const pageHost = pageHostOf(context.pageUrl)
  if (pageHost !== '' && pageHost === domain) return SELF_REFERRER

  for (const configured of context.siteDomains) {
    if (canonicalReferrerHost(configured) === domain) return SELF_REFERRER
  }

  return { domain, path: sanitized.path, isSelf: false }
}

// ---------------------------------------------------------------------------
// Referring pages (the Sources card's referrer-path drill-down)
// ---------------------------------------------------------------------------

/** The longest referring path a read returns, in characters. */
export const MAX_REFERRER_PATH_LENGTH = 200

/** How many referrer hosts one referrer-paths read may name. */
export const REFERRER_PATHS_MAX_HOSTS = 20

/** The most paths one referrer-paths read returns per host. */
export const REFERRER_PATHS_MAX_PER_HOST = 20

/**
 * A stored `referrer_path` as a read may show it: the path alone, cut at the
 * first `?`, `#` or `;` (a query string, a fragment, a matrix parameter such as
 * `;jsessionid=…`), every segment run through `redactSensitiveText`, and at
 * most `MAX_REFERRER_PATH_LENGTH` characters long.
 *
 * The path is stored as the referrer's `pathname`, which the collector already
 * cut from its query, and the tracker redacts sensitive values before that. A
 * referring page can still carry a token in its query on a row written by
 * another producer or an older collector, and a token can sit in the path
 * itself (`/reset/<token>`, `/u/jane@example.com`, a magic link), so the read
 * strips and redacts again rather than trusting the write. A segment is
 * checked both as stored and percent-decoded, so `jane%40example.com` is
 * caught as well. Redaction is per segment, so `/reset/<token>` becomes
 * `/reset/[redacted]` and the page stays recognisable; two links that differ
 * only in their token become the same path, and the caller merges them.
 *
 * The bare origin (`/`) is returned as `''`: it names no page, and a list of
 * `/` rows says nothing the host row did not. Truncation counts characters
 * (code points), as `substringUTF8` does in the statement, so it never splits
 * a surrogate pair.
 */
export function referrerPathForDisplay(path: string): string {
  const cut = path.replace(/[?#;].*$/s, '').trim()
  if (cut === '' || cut === '/') return ''
  const redacted = cut.split('/').map(redactPathSegment).join('/')
  return Array.from(redacted).slice(0, MAX_REFERRER_PATH_LENGTH).join('')
}

function redactPathSegment(segment: string): string {
  if (segment === '') return segment
  let decoded = segment
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    // A malformed escape is checked as stored.
  }
  if (decoded !== segment && redactSensitiveText(decoded) !== decoded) return PII_REDACTED
  return redactSensitiveText(segment)
}
