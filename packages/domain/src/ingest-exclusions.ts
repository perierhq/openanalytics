import { EXCLUSION_COUNTRY_CODES } from './iso-countries.ts'

/**
 * Server-side ingest exclusions: traffic a site's owner asked not to count.
 *
 * Four lists, each a different question about one request or one event:
 *
 * - **IP ranges** — the office, the owner's own devices. Matched against the
 *   client address the collector already reads for geo and rate limiting, in
 *   memory only. The address is never stored, logged or returned, and neither
 *   is the fact that it matched. An IPv4 client is matched as IPv4 even when a
 *   proxy reports it as `::ffff:a.b.c.d`, so an IPv6 rule never matches an
 *   IPv4 client; an IPv6 range wide enough to cover `::ffff:0:0/96` is refused
 *   rather than stored, because it would read as "everything" and match none
 *   of them.
 * - **Paths** — `/admin/*`. Matched against each event's page path.
 * - **Countries** — matched against the country geo resolved for the request,
 *   which is why it has no effect on an install that resolves no countries.
 * - **Hostnames** — `staging.example.com`, `*.preview.example.com`. Matched
 *   against each event's page host, which a URL carries in ASCII — so a rule
 *   typed as `bücher.de` is stored as `xn--bcher-kva.de`.
 *
 * Normalisation (what may be stored) and matching (what the collector drops)
 * live together so the API that validates and the collector that matches can
 * never read `10.0.0.0/8` or `/admin/*` two different ways.
 *
 * Independent of the tracker's browser-side opt-out (`#oa-ignore`): that one
 * is a visitor's choice and runs before anything is sent; this one is the
 * site's choice and runs where the browser cannot opt out of it.
 */

/** A site's exclusions as stored: normalised, de-duplicated. */
export interface IngestExclusions {
  /** CIDR, canonical spelling: `10.0.0.0/8`, `2001:db8::/32`, `198.51.100.4/32`. */
  readonly ipRanges: readonly string[]
  /** Each starts with `/`; `*` matches any run of characters, including `/`. */
  readonly paths: readonly string[]
  /** ISO 3166-1 alpha-2, uppercase. */
  readonly countries: readonly string[]
  /** Lowercase hosts, optionally with a leading `*.` for subdomains. */
  readonly hostnames: readonly string[]
}

export const EMPTY_INGEST_EXCLUSIONS: IngestExclusions = {
  ipRanges: [],
  paths: [],
  countries: [],
  hostnames: [],
}

/**
 * The bounds, mirrored by the published contract and by the column CHECKs in
 * Postgres migration 0051. 250 countries is "every country", so that limit
 * exists only to bound the request body.
 */
export const INGEST_EXCLUSION_LIMITS = {
  ipRanges: 50,
  paths: 50,
  pathMaxLength: 200,
  /** `*` per path rule: bounds the matcher's worst case per event. */
  pathMaxWildcards: 10,
  countries: 250,
  hostnames: 20,
  hostnameMaxLength: 253,
} as const

/** Why an event was dropped. The metric label, and nothing more specific. */
export type ExclusionReason = 'ip' | 'country' | 'hostname' | 'path'

export const EXCLUSION_REASONS: readonly ExclusionReason[] = ['ip', 'country', 'hostname', 'path']

/* ------------------------------------------------------------------ */
/* Addresses                                                          */
/* ------------------------------------------------------------------ */

interface ParsedAddress {
  readonly version: 4 | 6
  readonly value: bigint
}

interface CidrRange {
  readonly version: 4 | 6
  readonly network: bigint
  readonly prefix: number
}

const IPV4_BITS = 32
const IPV6_BITS = 128
/** `::ffff:0:0/96`, the IPv4-mapped block. */
const MAPPED_PREFIX = 0xffffn << 32n

function parseIpv4(text: string): bigint | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    // Decimal only, and no leading zero: `010` is octal to some parsers and
    // decimal to others, and an exclusion must not mean two things.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

function parseIpv6(text: string): bigint | null {
  if (text.length === 0 || text.length > 45) return null
  let head = text
  let tailV4: bigint | null = null
  // An embedded IPv4 tail (`::ffff:1.2.3.4`) occupies the last two groups.
  const lastColon = text.lastIndexOf(':')
  if (lastColon !== -1 && text.slice(lastColon + 1).includes('.')) {
    tailV4 = parseIpv4(text.slice(lastColon + 1))
    if (tailV4 === null) return null
    head = text.slice(0, lastColon + 1)
    // `::1.2.3.4` leaves `::`; `a:b::1.2.3.4` leaves `a:b::`; `a:1.2.3.4` is
    // short, and the group count below refuses it.
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1)
  }

  const groupLimit = tailV4 === null ? 8 : 6
  const doubles = head.split('::')
  if (doubles.length > 2) return null

  const readGroups = (segment: string): number[] | null => {
    if (segment === '') return []
    const groups: number[] = []
    for (const group of segment.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
      groups.push(parseInt(group, 16))
    }
    return groups
  }

  let groups: number[]
  if (doubles.length === 2) {
    const left = readGroups(doubles[0] ?? '')
    const right = readGroups(doubles[1] ?? '')
    if (left === null || right === null) return null
    const missing = groupLimit - left.length - right.length
    // `::` stands for at least one group.
    if (missing < 1) return null
    groups = [...left, ...Array<number>(missing).fill(0), ...right]
  } else {
    const all = readGroups(head)
    if (all === null || all.length !== groupLimit) return null
    groups = all
  }

  let value = 0n
  for (const group of groups) value = (value << 16n) | BigInt(group)
  if (tailV4 !== null) value = (value << 32n) | tailV4
  return value
}

function parseAddress(text: string): ParsedAddress | null {
  if (text.includes(':')) {
    const value = parseIpv6(text)
    return value === null ? null : { version: 6, value }
  }
  const value = parseIpv4(text)
  return value === null ? null : { version: 4, value }
}

function maskOf(bits: number, prefix: number): bigint {
  if (prefix === 0) return 0n
  const all = (1n << BigInt(bits)) - 1n
  return (all >> BigInt(bits - prefix)) << BigInt(bits - prefix)
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.')
}

/** RFC 5952: lowercase, no leading zeros, the longest run of zero groups as `::`. */
function formatIpv6(value: bigint): string {
  const groups: number[] = []
  for (let index = 7; index >= 0; index -= 1) {
    groups.push(Number((value >> BigInt(index * 16)) & 0xffffn))
  }
  let bestStart = -1
  let bestLength = 0
  for (let index = 0; index < 8;) {
    if (groups[index] !== 0) {
      index += 1
      continue
    }
    let end = index
    while (end < 8 && groups[end] === 0) end += 1
    if (end - index > bestLength) {
      bestStart = index
      bestLength = end - index
    }
    index = end
  }
  const hex = groups.map((group) => group.toString(16))
  if (bestLength < 2) return hex.join(':')
  const left = hex.slice(0, bestStart).join(':')
  const right = hex.slice(bestStart + bestLength).join(':')
  return `${left}::${right}`
}

/** An IPv6 value in `::ffff:0:0/96`, read as the IPv4 address it carries. */
function unmapped(address: ParsedAddress): ParsedAddress {
  if (address.version === 6 && address.value >> 32n === MAPPED_PREFIX >> 32n) {
    return { version: 4, value: address.value & 0xffffffffn }
  }
  return address
}

function parseRange(text: string): CidrRange | null {
  const trimmed = text.trim()
  const slash = trimmed.indexOf('/')
  const addressText = slash === -1 ? trimmed : trimmed.slice(0, slash)
  const address = parseAddress(addressText)
  if (address === null) return null

  const bits = address.version === 4 ? IPV4_BITS : IPV6_BITS
  let prefix = bits
  if (slash !== -1) {
    const prefixText = trimmed.slice(slash + 1)
    if (!/^(0|[1-9][0-9]{0,2})$/.test(prefixText)) return null
    prefix = Number(prefixText)
    if (prefix > bits) return null
  }

  // A mapped range narrow enough to sit inside the mapped block is an IPv4
  // range, and is stored as one so it reads the way the owner thinks of it.
  if (address.version === 6 && prefix >= 96) {
    const asV4 = unmapped(address)
    if (asV4.version === 4) {
      const v4Prefix = prefix - 96
      return {
        version: 4,
        network: asV4.value & maskOf(IPV4_BITS, v4Prefix),
        prefix: v4Prefix,
      }
    }
  }

  return { version: address.version, network: address.value & maskOf(bits, prefix), prefix }
}

function formatRange(range: CidrRange): string {
  const address = range.version === 4 ? formatIpv4(range.network) : formatIpv6(range.network)
  return `${address}/${range.prefix}`
}

/**
 * An IPv6 range shorter than /96 that contains `::ffff:0:0/96`. Client
 * addresses in that block are matched as the IPv4 addresses they carry, so
 * such a rule reads as covering IPv4 clients and covers none of them.
 */
function coversMappedBlock(range: CidrRange): boolean {
  return (
    range.version === 6 &&
    range.prefix < 96 &&
    (MAPPED_PREFIX & maskOf(IPV6_BITS, range.prefix)) === range.network
  )
}

type EntryCheck = { readonly value: string } | { readonly code: string }

function checkIpRange(input: string): EntryCheck {
  const range = parseRange(input)
  if (range === null) return { code: 'invalid' }
  if (coversMappedBlock(range)) return { code: 'covers_ipv4_mapped' }
  return { value: formatRange(range) }
}

/**
 * An address or CIDR range in its stored form — always CIDR, host bits
 * cleared, IPv6 in its canonical spelling — or `null` when it is neither, or
 * when it is an IPv6 range that covers the IPv4-mapped block.
 */
export function normalizeExclusionIpRange(input: string): string | null {
  const checked = checkIpRange(input)
  return 'value' in checked ? checked.value : null
}

/**
 * Reads a client address the way a proxy header may carry it: bare, with a
 * port (`1.2.3.4:5678`), or bracketed with one (`[2001:db8::1]:443`). A zone
 * id (`fe80::1%eth0`) is not a public address and never matches.
 */
function parseClientAddress(raw: string): ParsedAddress | null {
  let text = raw.trim()
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text)
  if (bracketed) text = bracketed[1] ?? ''
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(text)) text = text.slice(0, text.lastIndexOf(':'))
  if (text.includes('%')) return null
  const address = parseAddress(text)
  return address === null ? null : unmapped(address)
}

/* ------------------------------------------------------------------ */
/* Paths, hosts, countries                                            */
/* ------------------------------------------------------------------ */

function checkPath(input: string): EntryCheck {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return { code: 'invalid' }
  if (trimmed.length > INGEST_EXCLUSION_LIMITS.pathMaxLength) return { code: 'invalid' }
  // A path, not a URL: the query and fragment never reach the matcher, so a
  // rule that mentions one would silently never match.
  if (/[?#\s]/.test(trimmed)) return { code: 'invalid' }
  if (trimmed.split('*').length - 1 > INGEST_EXCLUSION_LIMITS.pathMaxWildcards) {
    return { code: 'too_many_wildcards' }
  }
  return { value: trimmed }
}

/** A path rule in its stored form, or `null` when it cannot be one. */
export function normalizeExclusionPath(input: string): string | null {
  const checked = checkPath(input)
  return 'value' in checked ? checked.value : null
}

const HOST_LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/

/**
 * A host in the ASCII form a URL carries (`bücher.de` → `xn--bcher-kva.de`),
 * through the platform's own URL parser — the same one that gives the matcher
 * a page's host — or `null`. Anything the parser would read as more than a
 * host (a path, a port, credentials) is refused first, because the parser
 * would otherwise quietly keep only the host part of it.
 */
function asciiHost(host: string): string | null {
  if (/[/\\?#@:[\]%\s]/.test(host)) return null
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return null
  }
}

/** A hostname rule in its stored form, or `null` when it cannot be one. */
export function normalizeExclusionHostname(input: string): string | null {
  let host = input.trim().toLowerCase()
  if (host.endsWith('.')) host = host.slice(0, -1)
  let wildcard = false
  if (host.startsWith('*.')) {
    wildcard = true
    host = host.slice(2)
  }
  if (host === '') return null
  const ascii = asciiHost(host)
  if (ascii === null) return null
  host = ascii.endsWith('.') ? ascii.slice(0, -1) : ascii
  if (host === '' || host.length > INGEST_EXCLUSION_LIMITS.hostnameMaxLength) return null
  const labels = host.split('.')
  if (!labels.every((label) => HOST_LABEL.test(label))) return null
  return wildcard ? `*.${host}` : host
}

/**
 * An ISO 3166-1 alpha-2 code in its stored form, or `null` — for a code that
 * names no country too (`XX`, `T1`), which no GeoIP lookup would ever report.
 */
export function normalizeExclusionCountry(input: string): string | null {
  const code = input.trim().toUpperCase()
  return EXCLUSION_COUNTRY_CODES.has(code) ? code : null
}

/**
 * Whether one hostname rule matches a host. `*.example.com` matches every
 * subdomain at any depth and not `example.com` itself — the apex is its own
 * rule, so excluding previews never quietly excludes production.
 */
export function exclusionHostnameMatches(rule: string, host: string): boolean {
  const candidate = host.toLowerCase().replace(/\.$/, '')
  if (rule.startsWith('*.')) return candidate.endsWith(rule.slice(1))
  return candidate === rule
}

/**
 * Glob match with `*` as the only special character, anchored at both ends.
 *
 * The semantics of `^…$` with every literal escaped and `*` as `.*`, without a
 * regular expression: the pattern is the owner's but the path is whoever sent
 * the request, and `.*a.*a.*a…` against a long path that almost matches is
 * the textbook catastrophic backtrack. This is the linear-backtrack wildcard
 * walk — at most pattern × path steps, whatever the input.
 */
function globMatches(pattern: string, text: string): boolean {
  let p = 0
  let t = 0
  let star = -1
  let resume = 0
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p
      p += 1
      resume = t
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p += 1
      t += 1
    } else if (star !== -1) {
      p = star + 1
      resume += 1
      t = resume
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1
  return p === pattern.length
}

/* ------------------------------------------------------------------ */
/* Validation of an untrusted write                                   */
/* ------------------------------------------------------------------ */

export interface IngestExclusionsIssue {
  readonly field: string
  readonly code: string
}

export type IngestExclusionsResult =
  | { readonly ok: true; readonly exclusions: IngestExclusions }
  | { readonly ok: false; readonly issues: readonly IngestExclusionsIssue[] }

/** A normaliser that only knows "valid or not". */
const plain =
  (normalize: (input: string) => string | null) =>
  (input: string): EntryCheck => {
    const value = normalize(input)
    return value === null ? { code: 'invalid' } : { value }
  }

const LISTS = [
  {
    wire: 'ip_ranges',
    key: 'ipRanges',
    limit: INGEST_EXCLUSION_LIMITS.ipRanges,
    check: checkIpRange,
  },
  {
    wire: 'paths',
    key: 'paths',
    limit: INGEST_EXCLUSION_LIMITS.paths,
    check: checkPath,
  },
  {
    wire: 'countries',
    key: 'countries',
    limit: INGEST_EXCLUSION_LIMITS.countries,
    check: plain(normalizeExclusionCountry),
  },
  {
    wire: 'hostnames',
    key: 'hostnames',
    limit: INGEST_EXCLUSION_LIMITS.hostnames,
    check: plain(normalizeExclusionHostname),
  },
] as const

/**
 * Normalise the `exclusions` member of an ingest-settings write.
 *
 * A write replaces the whole set, so all four lists are required: a body that
 * named only `ip_ranges` would otherwise have to choose between clearing the
 * other three and keeping them, and either guess surprises somebody. Each
 * failure names its field and, for a bad entry, its index — the form puts the
 * message under the list that caused it.
 */
export function normalizeIngestExclusions(input: unknown): IngestExclusionsResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ field: 'exclusions', code: 'not_an_object' }] }
  }
  const body = input as Record<string, unknown>
  const issues: IngestExclusionsIssue[] = []

  for (const name of Object.keys(body)) {
    if (!LISTS.some((list) => list.wire === name)) {
      issues.push({ field: `exclusions.${name}`, code: 'unknown' })
    }
  }

  const out: Record<(typeof LISTS)[number]['key'], string[]> = {
    ipRanges: [],
    paths: [],
    countries: [],
    hostnames: [],
  }

  for (const list of LISTS) {
    const field = `exclusions.${list.wire}`
    if (!Object.hasOwn(body, list.wire)) {
      issues.push({ field, code: 'required' })
      continue
    }
    const value = body[list.wire]
    if (!Array.isArray(value)) {
      issues.push({ field, code: 'not_an_array' })
      continue
    }
    if (value.length > list.limit) {
      issues.push({ field, code: 'too_many' })
      continue
    }
    const kept: string[] = []
    value.forEach((entry: unknown, index) => {
      const checked: EntryCheck =
        typeof entry === 'string' ? list.check(entry) : { code: 'invalid' }
      if ('code' in checked) {
        issues.push({ field: `${field}.${index}`, code: checked.code })
        return
      }
      if (!kept.includes(checked.value)) kept.push(checked.value)
    })
    out[list.key] = kept
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, exclusions: out }
}

/* ------------------------------------------------------------------ */
/* Matching                                                           */
/* ------------------------------------------------------------------ */

/** What one event offers the matcher. */
export interface ExclusionSubject {
  /** The raw client address. Read in memory, never kept. */
  readonly ip: string | null
  /** The country geo resolved for the request, when it resolved one. */
  readonly country: string | null
  /** The event's page URL, when it has a page. */
  readonly url: string | null
  /**
   * The host to test when the event has no page — the request's `Origin`.
   * An event with a page is judged by its page alone.
   */
  readonly fallbackHostname: string | null
}

/**
 * A site's exclusions compiled for matching. Built once per config version
 * and reused for every event under it, so no request pays for parsing.
 */
export interface CompiledIngestExclusions {
  /** True when no list has an entry; the collector skips matching entirely. */
  readonly empty: boolean
  matchesIp(address: string | null): boolean
  matchesCountry(country: string | null): boolean
  matchesHostname(host: string | null): boolean
  matchesPath(path: string | null): boolean
  /**
   * The first reason the subject is excluded, in the order `ip`, `country`,
   * `hostname`, `path`, or `null` when nothing matches.
   */
  reasonFor(subject: ExclusionSubject): ExclusionReason | null
}

function decodedPath(path: string): string | null {
  try {
    const decoded = decodeURIComponent(path)
    return decoded === path ? null : decoded
  } catch {
    return null
  }
}

export function compileIngestExclusions(exclusions: IngestExclusions): CompiledIngestExclusions {
  const ranges = exclusions.ipRanges
    .map((entry) => parseRange(entry))
    .filter((range): range is CidrRange => range !== null)
  const countries = new Set(exclusions.countries.map((code) => code.toUpperCase()))
  const exactHosts = new Set(exclusions.hostnames.filter((rule) => !rule.startsWith('*.')))
  const wildcardHosts = exclusions.hostnames.filter((rule) => rule.startsWith('*.'))
  const paths = [...exclusions.paths]

  const matchesIp = (raw: string | null): boolean => {
    if (raw === null || ranges.length === 0) return false
    const address = parseClientAddress(raw)
    if (address === null) return false
    const bits = address.version === 4 ? IPV4_BITS : IPV6_BITS
    return ranges.some(
      (range) =>
        range.version === address.version &&
        (address.value & maskOf(bits, range.prefix)) === range.network,
    )
  }

  const matchesCountry = (country: string | null): boolean =>
    country !== null && countries.has(country.toUpperCase())

  const matchesHostname = (host: string | null): boolean => {
    if (host === null || host === '') return false
    const candidate = host.toLowerCase().replace(/\.$/, '')
    if (exactHosts.has(candidate)) return true
    return wildcardHosts.some((rule) => exclusionHostnameMatches(rule, candidate))
  }

  const matchesPath = (path: string | null): boolean => {
    if (path === null || paths.length === 0) return false
    if (paths.some((rule) => globMatches(rule, path))) return true
    // A browser sends `/%C3%BCber`; the owner typed `/über`. Both spellings
    // name the same page, so either may match.
    const decoded = decodedPath(path)
    return decoded !== null && paths.some((rule) => globMatches(rule, decoded))
  }

  const empty =
    ranges.length === 0 &&
    countries.size === 0 &&
    exactHosts.size === 0 &&
    wildcardHosts.length === 0 &&
    paths.length === 0

  return {
    empty,
    matchesIp,
    matchesCountry,
    matchesHostname,
    matchesPath,
    reasonFor(subject: ExclusionSubject): ExclusionReason | null {
      if (empty) return null
      if (matchesIp(subject.ip)) return 'ip'
      if (matchesCountry(subject.country)) return 'country'
      let host: string | null = null
      let path: string | null = null
      if (subject.url !== null) {
        try {
          const parsed = new URL(subject.url)
          host = parsed.hostname
          path = parsed.pathname
        } catch {
          // An unparseable page has no host or path to match; the event is
          // judged on what else it carries.
        }
      } else {
        host = subject.fallbackHostname
      }
      if (matchesHostname(host)) return 'hostname'
      if (matchesPath(path)) return 'path'
      return null
    },
  }
}
