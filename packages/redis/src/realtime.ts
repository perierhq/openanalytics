import type { Redis } from 'ioredis'
import {
  DAY_IN_SECONDS,
  RATE_LIMIT_WINDOW_TTL_SECONDS,
  botCounterKey,
  dailyBillableKey,
  dailyCeilingKey,
  minuteBucketOf,
  rateLimitIdentityKey,
  rateLimitIpKey,
  rateLimitSiteKey,
  realtimeControlChannel,
  realtimeEpochKey,
  realtimeFeedKey,
  realtimeUpdatesChannel,
  tagSightingKey,
  usageCounterKey,
  utcDayOf,
  visitorMetaKey,
  visitorPagesKey,
  visitorPresenceKey,
} from './keys.ts'

/**
 * Realtime cache contract and adapter (docs snapshot 05, D-205; 02 §5).
 *
 * Deliberately a separate instance from the queue, not a separate logical db:
 * numbered databases share one process, one memory budget and one eviction
 * policy, so an eviction storm driven by realtime state would drop durable queue
 * keys. Everything behind this interface is reconstructible; losing it degrades
 * realtime and abuse limiting and must never touch historical analytics.
 *
 * That asymmetry is why every method here is written to be *skippable*. The
 * collector treats a failure of this instance as a degradation with a metric
 * (G-005's bounded fail-open), never as a reason to refuse an event it could
 * have durably queued — except on the heartbeat path, where this instance is the
 * only destination and a failure is an honest `503` (02 §7.2).
 */

/** New values of the abuse counters, after this request was charged to them. */
export interface ChargedRateLimits {
  readonly ipSite: number
  readonly identity: number
  readonly site: number
  readonly siteDaily: number
}

export interface RateLimitChargeInput {
  readonly siteId: string
  /** Hash of the client address. The raw IP never reaches this package. */
  readonly ipHash: string
  /** Rate-limit bucket for the caller's anonymous identity (D-102). */
  readonly identityHash: string
  readonly at: Date
  /** Events in this request; a batch is charged by its size, not as one hit. */
  readonly cost: number
}

export interface UsageReadInput {
  readonly siteId: string
  readonly billingUserId: string
  /** `starts_at` of the usage window, the natural key of `usage_windows`. */
  readonly usageWindowStart: Date
  readonly at: Date
}

export interface UsageReads {
  /** Billable events counted against this window so far (D-103). */
  readonly billableUsed: number
  /** Billable events this site has spent today, for the G-005 rapid-burn rule. */
  readonly siteDailyBillable: number
}

export interface RecordBillableInput extends UsageReadInput {
  readonly billable: number
  /** `ends_at` of the window; the counter expires with the window it counts. */
  readonly usageWindowEnd: Date
}

export interface WindowUsageKey {
  readonly billingUserId: string
  /** `starts_at` of the usage window, the natural key of `usage_windows`. */
  readonly usageWindowStart: Date
}

export interface RaiseWindowUsageInput extends WindowUsageKey {
  /** `ends_at` of the window; the counter expires with the window it counts. */
  readonly usageWindowEnd: Date
  readonly delta: number
  readonly at: Date
}

/**
 * One origin the site's tag has been seen loading on (ADR-0081, D2).
 *
 * `allowed` is the collector's own `isOriginAllowed` verdict against the site's
 * allowlist at the moment of the sighting, recorded rather than recomputed on
 * read: the dashboard must never disagree with the gate about whether an origin
 * counts, and the allowlist can change between the two.
 */
export interface TagSighting {
  /** The lowercased `Origin` header of the config fetch, or `(none)`. */
  readonly origin: string
  /** ISO instant of the most recent fetch from this origin. */
  readonly at: string
  readonly allowed: boolean
}

export interface RecordTagSightingInput {
  readonly siteId: string
  /** Already lowercased by the caller; `(none)` when the header was absent. */
  readonly origin: string
  readonly allowed: boolean
  readonly at: Date
}

/** Metadata a touch may attach to a visitor. All optional; see `touchVisitor`. */
export interface PresenceTouchInput {
  readonly siteId: string
  /** The anonymous id (hex). Charset-guarded by the key builders. */
  readonly visitorId: string
  readonly at: Date
  /** Sanitized page — a path and an optional title. Never a raw URL or query. */
  readonly page?: { readonly path: string; readonly title?: string }
  /** Two-letter country, or null/undefined when geo is unknown. */
  readonly country?: string | null
  /** `desktop` | `mobile` | `tablet` | `unknown`, from the UA classifier. */
  readonly deviceType?: string
  /** Browser family from the UA classifier — never the user-agent string. */
  readonly browser?: string | null
  /** OS family from the UA classifier — never the user-agent string. */
  readonly os?: string | null
  /**
   * GeoLite2 city name, or null/undefined when geo is unknown (ADR-0024).
   *
   * Private-surface data only: it reaches the private snapshot's city breakdown
   * and nothing else. The public snapshot is a separate schema that carries
   * `active_visitors` alone (D-213), so a city cannot reach it by a shared edit.
   */
  readonly city?: string | null
  /**
   * Makes this touch an entry on the site's rolling page-view feed (ADR-0024).
   *
   * Supplied by the historical path for a touch that carries a page view, and
   * never by the heartbeat: a heartbeat is liveness, not an event, and one on the
   * feed would be an entry with no `event_id` to name it. The rest of the entry
   * is composed from the fields above, so the feed cannot carry anything the
   * presence metadata does not already hold.
   */
  readonly feed?: {
    readonly eventId: string
    /** The *validated* `occurred_at` of the page view, not the touch instant. */
    readonly occurredAt: Date
    /** Referrer domain from the shared sanitizer, or null. Never a raw URL. */
    readonly referrer?: string | null
  }
}

export interface PresenceSnapshotInput {
  readonly siteId: string
  readonly at: Date
  /** Upper bound on visitors aggregated, from `REALTIME_SNAPSHOT_MAX_VISITORS`. */
  readonly maxVisitors: number
}

export interface PresenceCount {
  readonly path: string
  readonly visitors: number
}

export interface PresenceCountry {
  readonly country: string
  readonly visitors: number
}

export interface PresenceDevice {
  readonly deviceType: string
  readonly visitors: number
}

export interface PresenceBrowser {
  readonly browser: string
  readonly visitors: number
}

export interface PresenceOperatingSystem {
  readonly os: string
  readonly visitors: number
}

export interface PresenceCity {
  readonly city: string
  readonly visitors: number
}

/**
 * One page view on the site's rolling feed (ADR-0024).
 *
 * The visitor is the D-102 anonymous identity — the same site-scoped, daily
 * rotating hash every other surface uses. It is deliberately *not* a new
 * identifier: a feed with its own id would be a second identity model to reason
 * about, and this one is already the one the collector derives and discards an
 * IP to produce. A visitor whose session crosses UTC midnight appears under two
 * hashes, which is D-102 working, not a defect.
 */
export interface PresenceFeedEntry {
  readonly eventId: string
  readonly occurredAtMs: number
  readonly visitorId: string
  readonly path: string
  readonly country: string | null
  readonly deviceType: string | null
  readonly browser: string | null
  readonly os: string | null
  readonly referrer: string | null
}

/**
 * One visitor who is present right now (ADR-0035, D3).
 *
 * `activeVisitors` says how many; this says who, which is what lets a board draw
 * a named row for a long reader instead of an anonymous `+1`. Composed entirely
 * from the presence metadata HASH — the same fields the feed is composed from —
 * so this list cannot carry anything presence does not already hold.
 *
 * Deliberately no city. ADR-0024 admitted a city to the private snapshot as an
 * *aggregate*, which names nobody; a per-visitor city beside that visitor's own
 * path, browser and OS is a different disclosure (ADR-0035, D3).
 *
 * `visitor` carries the same D-102 rotation caveat the feed's does: the hash
 * rotates at UTC midnight, so a session crossing it appears under two unlinkable
 * values.
 */
export interface PresenceVisitor {
  readonly visitorId: string
  readonly lastSeenMs: number
  readonly path: string | null
  readonly country: string | null
  readonly deviceType: string | null
  readonly browser: string | null
  readonly os: string | null
}

export interface PresenceSnapshot {
  readonly activeVisitors: number
  /** True when the active set was larger than `maxVisitors` and was sampled. */
  readonly truncated: boolean
  readonly pages: readonly PresenceCount[]
  readonly countries: readonly PresenceCountry[]
  readonly devices: readonly PresenceDevice[]
  readonly browsers: readonly PresenceBrowser[]
  readonly operatingSystems: readonly PresenceOperatingSystem[]
  /** Private-surface breakdown only (ADR-0024); never formatted for the public
   * snapshot, which is a separate schema carrying `active_visitors` alone. */
  readonly cities: readonly PresenceCity[]
  /** Newest first. Private-surface only, for the same reason `cities` is. */
  readonly events: readonly PresenceFeedEntry[]
  /**
   * Who is present, newest last-seen first, bounded by `PRESENCE_PRESENT_MAX`.
   *
   * `activeVisitors` stays authoritative — it is the ZCOUNT over the whole set,
   * and this is a bounded sample of it, so on a busy site the list is shorter
   * than the count and the difference is a real one to state rather than hide.
   */
  readonly present: readonly PresenceVisitor[]
}

export interface EpochRef {
  readonly siteId: string
  /**
   * A user id, the literal `public`, or the reserved literal `site`.
   * Charset-guarded by the key builder.
   */
  readonly subject: string
}

/**
 * The reserved site-level epoch subject (ADR-0030, decision 5).
 *
 * The per-subject epoch cuts one member's streams; this one cuts every stream on
 * the site, which is what a billing block and a deletion start need. `site`
 * cannot collide with a real subject: subjects are user UUIDs or the literal
 * `public`.
 */
export const REALTIME_SITE_EPOCH_SUBJECT = 'site'

/**
 * How long an epoch key survives without being touched.
 *
 * Before this the keys were immortal — one integer per (site, subject) forever,
 * including for members removed years ago. Expiry is fail-closed by
 * construction: a missing epoch reads as `auth_unreachable` at the gateway and
 * the next token mint re-seeds it, so an expired key can never let a revoked
 * subject back in. Refreshed on ensure, get and bump, so a key backing live
 * traffic never ages out under it.
 */
export const REALTIME_EPOCH_TTL_MS = 30 * 86_400_000

/** How many entries a presence page/country top-N returns (docs snapshot 02 §17). */
export const PRESENCE_TOP_N = 10

/** How many pages a single visitor's history list retains. */
export const PRESENCE_PAGE_HISTORY_MAX = 10

/**
 * How many page views the site's rolling feed retains (ADR-0024). Mirrored by
 * `REALTIME_FEED_MAX_EVENTS` in @openanalytics/contracts, which bounds the same
 * list on the wire — the two packages share no import, the same way
 * `PRESENCE_TOP_N` and `REALTIME_SNAPSHOT_TOP_N` already do.
 */
export const PRESENCE_FEED_MAX = 50

/**
 * How long the feed survives without a new page view.
 *
 * The same PEXPIRE-on-every-write discipline as presence — the key cannot outlive
 * the traffic it describes — but deliberately a longer window than
 * `VISITOR_PRESENCE_WINDOW_MS`. The two answer different questions: presence is
 * "who is here", bounded by how long we are willing to call someone here (five
 * minutes, ADR-0035 D1); the feed is "what just happened", and it has to outlast
 * presence so that a visitor still on the board has the page that put them there
 * available to render beside their row. The relation, not either number, is what
 * `tests/unit/presence-aggregation.test.ts` pins.
 */
export const REALTIME_FEED_WINDOW_MS = 15 * 60_000

/**
 * How many present visitors the snapshot names individually (ADR-0035, D3).
 *
 * Deliberately the same 50 as `PRESENCE_FEED_MAX`, and mirrored on the wire by
 * `REALTIME_PRESENT_MAX_VISITORS` in @openanalytics/contracts the way the feed's
 * bound already is — the two packages share no import. Fifty is what a board can
 * render as rows; past it `activeVisitors` is the honest answer and a client
 * states the remainder as a count rather than inventing rows for it.
 */
export const PRESENCE_PRESENT_MAX = 50

/**
 * Aggregates per-visitor metadata into a snapshot. Pure, so the top-N ordering,
 * the tie-break and the "no metadata counts toward active only" rule are unit
 * tested without Redis.
 *
 * Each dimension counts only the visitors that carry it: a visitor whose HASH
 * holds nothing but a `last_seen_ms` contributes to `activeVisitors` and to no
 * page, country or device bucket. Ties break by key ascending, so the snapshot
 * is deterministic for a given set of visitors.
 */
export function aggregatePresenceSnapshot(input: {
  activeVisitors: number
  truncated: boolean
  entries: readonly (Record<string, string> | null)[]
  /** Raw feed entries, newest first, as stored. Omitted by callers with no feed. */
  feed?: readonly string[]
  /**
   * Visitor ids paired with their metadata, **newest last-seen first**, for the
   * `present` list (ADR-0035, D3).
   *
   * Supplied already paired rather than derived from `entries`, because only the
   * adapter that issued the range query knows which metadata belongs to which
   * member — pairing two flat arrays by index here would be an invariant nothing
   * could check. The bound is still re-applied below, the way `parseFeed`
   * re-applies the feed's.
   */
  present?: readonly { readonly visitorId: string; readonly meta: Record<string, string> | null }[]
}): PresenceSnapshot {
  const pages = new Map<string, number>()
  const countries = new Map<string, number>()
  const devices = new Map<string, number>()
  const browsers = new Map<string, number>()
  const operatingSystems = new Map<string, number>()
  const cities = new Map<string, number>()

  const bump = (map: Map<string, number>, keyValue: string): void => {
    map.set(keyValue, (map.get(keyValue) ?? 0) + 1)
  }

  const bumpField = (map: Map<string, number>, meta: Record<string, string>, field: string) => {
    const value = meta[field]
    if (typeof value === 'string' && value.length > 0) bump(map, value)
  }

  for (const meta of input.entries) {
    if (meta === null) continue
    bumpField(pages, meta, 'path')
    bumpField(countries, meta, 'country')
    bumpField(devices, meta, 'device_type')
    bumpField(browsers, meta, 'browser')
    bumpField(operatingSystems, meta, 'os')
    bumpField(cities, meta, 'city')
  }

  return {
    activeVisitors: input.activeVisitors,
    truncated: input.truncated,
    pages: topN(pages, PRESENCE_TOP_N).map(([path, visitors]) => ({ path, visitors })),
    countries: topN(countries, PRESENCE_TOP_N).map(([country, visitors]) => ({
      country,
      visitors,
    })),
    // Devices are a tiny fixed vocabulary; return them all, still ordered.
    devices: topN(devices, Number.POSITIVE_INFINITY).map(([deviceType, visitors]) => ({
      deviceType,
      visitors,
    })),
    // Browser, OS and city are open vocabularies — the UA classifier and GeoLite2
    // both emit long tails — so they take the same bounded top-N as pages and
    // countries rather than the devices' return-everything rule.
    browsers: topN(browsers, PRESENCE_TOP_N).map(([browser, visitors]) => ({ browser, visitors })),
    operatingSystems: topN(operatingSystems, PRESENCE_TOP_N).map(([os, visitors]) => ({
      os,
      visitors,
    })),
    cities: topN(cities, PRESENCE_TOP_N).map(([city, visitors]) => ({ city, visitors })),
    events: parseFeed(input.feed ?? []),
    present: presentVisitors(input.present ?? []),
  }
}

/**
 * Turns paired (id, metadata) rows into the bounded `present` list.
 *
 * A visitor with no metadata HASH is **dropped rather than emitted blank**: the
 * row would carry an id, no `last_seen_at` we could honestly state and no label
 * at all, which is a worse answer than being counted in `activeVisitors` and not
 * named. In practice this is close to unreachable — `touchVisitor` writes
 * `last_seen_ms` on every touch and gives the HASH the same TTL as the ZSET
 * member's own expiry boundary, so the two age out together — and it is handled
 * because "close to unreachable" is where a blank row would come from.
 */
function presentVisitors(
  rows: readonly { readonly visitorId: string; readonly meta: Record<string, string> | null }[],
): PresenceVisitor[] {
  const visitors: PresenceVisitor[] = []

  for (const row of rows) {
    if (visitors.length >= PRESENCE_PRESENT_MAX) break
    if (row.meta === null) continue

    const lastSeenMs = Number(row.meta['last_seen_ms'])
    if (!Number.isFinite(lastSeenMs)) continue

    const label = (field: string): string | null => {
      const value = row.meta?.[field]
      return typeof value === 'string' && value.length > 0 ? value : null
    }

    visitors.push({
      visitorId: row.visitorId,
      lastSeenMs,
      path: label('path'),
      country: label('country'),
      deviceType: label('device_type'),
      browser: label('browser'),
      os: label('os'),
      // No `city`, deliberately — ADR-0035 D3. The metadata holds one; an
      // aggregate over the active set names nobody and a per-visitor one does.
    })
  }

  return visitors
}

/**
 * Decodes stored feed entries, dropping anything that does not decode.
 *
 * Lenient by design, and only here: a feed entry is a display record on a
 * best-effort store, so one malformed line — a truncated write, a value from an
 * older encoding — costs that line and not the whole snapshot. The bound is
 * re-applied on read as well as on write, so a list that somehow grew past the
 * trim still cannot produce an unbounded payload.
 */
function parseFeed(raw: readonly string[]): PresenceFeedEntry[] {
  const entries: PresenceFeedEntry[] = []

  for (const line of raw) {
    if (entries.length >= PRESENCE_FEED_MAX) break

    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null) continue

    const row = value as Record<string, unknown>
    const eventId = row['eventId']
    const occurredAtMs = row['occurredAtMs']
    const visitorId = row['visitorId']
    const path = row['path']
    if (
      typeof eventId !== 'string' ||
      typeof visitorId !== 'string' ||
      typeof path !== 'string' ||
      typeof occurredAtMs !== 'number' ||
      !Number.isFinite(occurredAtMs)
    ) {
      continue
    }

    const optional = (key: string): string | null => {
      const field = row[key]
      return typeof field === 'string' && field.length > 0 ? field : null
    }

    entries.push({
      eventId,
      occurredAtMs,
      visitorId,
      path,
      country: optional('country'),
      deviceType: optional('deviceType'),
      browser: optional('browser'),
      os: optional('os'),
      referrer: optional('referrer'),
    })
  }

  return entries
}

/** Descending by count, then ascending by key, capped at `limit`. */
function topN(counts: Map<string, number>, limit: number): [string, number][] {
  return [...counts.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit)
}

export interface RealtimeCache {
  /**
   * Atomically increments every abuse window and returns the new values.
   *
   * Increment-then-decide, rather than read-then-decide: an abuse limiter counts
   * attempts, and reading first leaves a window where concurrent requests each
   * see a count under the limit and all pass.
   */
  chargeRateLimits(input: RateLimitChargeInput): Promise<ChargedRateLimits>

  /**
   * Reads the near-realtime usage counters (D-103).
   *
   * Read-only, and never Postgres: D-103 puts the limit check on this counter
   * precisely so the collector's hot path holds no database round trip.
   */
  readUsage(input: UsageReadInput): Promise<UsageReads>

  /**
   * Adds to the near-realtime usage counter after a durable enqueue.
   *
   * Only newly enqueued billable events, never duplicates — a retry counted
   * again is the double-billing D-209 exists to prevent. Postgres stays
   * authoritative; the worker reconciles this counter against it (M6).
   */
  recordBillable(input: RecordBillableInput): Promise<void>

  /**
   * Reads only the window counter (D-103), for the worker's reconciliation.
   *
   * Not `readUsage` on purpose: a usage window belongs to a billing user and
   * can span several sites, so a window-level correction has no honest site to
   * attribute — the per-site daily counter must stay out of its reach
   * (ADR-0013 audit fix).
   */
  readWindowUsage(input: WindowUsageKey): Promise<number>

  /**
   * Raises only the window counter by a reconciliation delta.
   *
   * ADR-0009: the collector increments, the worker corrects — and only ever
   * upward, so a correction can close quota early but never reopen it.
   */
  raiseWindowUsage(input: RaiseWindowUsageInput): Promise<void>

  /**
   * The daily accepted-event counts for a site, most recent first, for the
   * whole days *before* `endingBefore`.
   *
   * The G-005 consecutive-ceiling-days alert needs a memory longer than one day,
   * and the collector cannot supply one: it sees a day at a time and may not
   * write Postgres on the ingest path. These are the counters it already
   * maintains — the only change was making them outlive their own day.
   *
   * Today is excluded deliberately. A day still in progress has not hit its
   * ceiling until it has, and counting a partial day would fire the alert a day
   * early roughly half the time.
   */
  readDailyCeilingCounts(input: {
    siteId: string
    endingBefore: Date
    days: number
  }): Promise<number[]>

  /**
   * Records liveness for a visitor; pure realtime state, never billed.
   *
   * Every metadata field is optional so existing callers (a heartbeat with no
   * page, an early batch) compile unchanged. When present, `page`, `country`,
   * `deviceType`, `browser`, `os` and `city` populate the visitor's metadata HASH
   * and page-history LIST, and every touch publishes a tiny "changed" notice on
   * the site's updates channel. No raw IP and no user-agent string is ever
   * accepted here (docs snapshot 02 §17); the city ADR-0024 admits is the coarse
   * GeoLite2 label, and it feeds the private snapshot only.
   */
  touchVisitor(input: PresenceTouchInput): Promise<void>

  /**
   * Computes the bounded active-visitor snapshot for a site (docs snapshot 02
   * §17): one range query for the active set, then a pipelined metadata read,
   * aggregated to totals the gateway serves every subscribed client without
   * re-scanning. `truncated` is set when the active set exceeds `maxVisitors`.
   */
  readPresenceSnapshot(input: PresenceSnapshotInput): Promise<PresenceSnapshot>

  /** Current access epoch for a subject, or `null` when the key is absent. */
  getEpoch(input: EpochRef): Promise<number | null>

  /** Creates the epoch at 0 if absent and returns the current value (SET NX). */
  ensureEpoch(input: EpochRef): Promise<number>

  /**
   * Bumps a subject's access epoch and publishes a disconnect on the site's
   * control channel, atomically. Owner/member removal calls this: the bump
   * invalidates every outstanding token, and the control message disconnects any
   * stream already open before its next keepalive check would (docs snapshot 02
   * §17, D-213). Returns the new epoch.
   */
  bumpEpochAndPublishDisconnect(input: EpochRef): Promise<number>

  /**
   * Counts filtered bot traffic (G-005).
   *
   * Aggregate only, and deliberately so: bot traffic is not billed and does not
   * enter analytics, so the only record is a per-site, per-day, per-signature
   * counter. The signature name is a rule identifier, never the user agent.
   */
  countBot(input: { siteId: string; signature: string; at: Date; cost: number }): Promise<void>

  /**
   * Records that the site's tag fetched its configuration from an origin
   * (ADR-0081, D2).
   *
   * The weaker install signal ADR-0027's `first_event_at` cannot be: it exists
   * precisely when no event has been accepted, which is the case a developer
   * testing on `localhost` or a preview host is standing in. One field per
   * origin, last write wins, the whole hash expiring
   * `TAG_SIGHTING_TTL_SECONDS` after the last one.
   *
   * Best-effort by contract, like every other method here: the caller fires it
   * without awaiting and the config response is unaffected by a failure.
   */
  recordTagSighting(input: RecordTagSightingInput): Promise<void>

  /**
   * The site's sightings, newest first, with malformed entries skipped.
   *
   * An empty array is a measurement — the hash was read and nothing has loaded
   * the tag in 24 hours — and is never how a failed read is reported: this
   * method throws, and the caller decides what "not computed" looks like on its
   * own contract (ADR-0081, D3).
   */
  readTagSightings(input: { siteId: string }): Promise<TagSighting[]>

  /**
   * Records that the collector resolved a visitor's country (server-side
   * exclusions).
   *
   * One deployment-wide key holding an instant, refreshed by the collector at
   * most every few minutes: no site, no address and no country is written, so
   * it states "this install can resolve countries" and nothing else. It is how
   * the settings surface can say whether a country exclusion will match
   * anything — geo is the collector's (a GeoIP database or a platform header),
   * and the api has no other way to know. Best-effort, like the tag sighting
   * it is modelled on.
   */
  markGeoResolved(input: { at: Date }): Promise<void>

  /**
   * The instant a country was last resolved, or `null` when none was in the
   * last `GEO_RESOLVED_TTL_SECONDS`. Throws on a failed read; the caller
   * decides what "unknown" looks like.
   */
  readGeoResolvedAt(): Promise<string | null>
}

/**
 * Increments a set of counters and returns their new values, setting each key's
 * TTL when it is created.
 *
 * The TTL is what makes these windows rather than totals. Setting it only on
 * creation keeps a busy window from being extended indefinitely by its own
 * traffic; the `TTL < 0` branch repairs a key that somehow lost its expiry,
 * which would otherwise be a counter that never resets and a site throttled
 * forever.
 */
export const INCREMENT_WINDOWS_SCRIPT = `
local count = tonumber(ARGV[1])
local values = {}

for i = 1, count do
  local increment = tonumber(ARGV[1 + (i - 1) * 2 + 1])
  local ttl_seconds = tonumber(ARGV[1 + (i - 1) * 2 + 2])
  local value = redis.call('INCRBY', KEYS[i], increment)

  if value == increment or redis.call('TTL', KEYS[i]) < 0 then
    redis.call('EXPIRE', KEYS[i], ttl_seconds)
  end

  values[i] = value
end

return values
`

/**
 * Presence touch, as one atomic script (docs snapshot 02 §17: "the update is
 * made atomic with a pipeline or with Lua").
 *
 * KEYS: presence ZSET, metadata HASH, page-history LIST, updates channel,
 *       site feed LIST.
 * ARGV: [1] visitorId, [2] scoreMs, [3] windowMs, [4] hasPage('0'|'1'),
 *       [5] pagePath, [6] pageHistoryMax, [7] publishPayload,
 *       [8] hasFeed('0'|'1'), [9] feedEntry, [10] feedMax, [11] feedWindowMs,
 *       [12] metaFieldCount, then [13..] flattened field,value pairs for the HASH.
 *
 * The ZSET is scored by time and trimmed on write, so the active set stays
 * bounded without a sweeper. The page list only grows when the newest path
 * differs from its head, so a visitor refreshing one page does not fill the list
 * with duplicates. Every key carries a TTL refreshed on write, and the final
 * PUBLISH is what tells the gateway to recompute.
 *
 * The feed write lives here rather than beside the call for the reason the rest
 * of it does: a visitor's presence and the entry describing what they just did
 * must land together or not at all, or the gateway can recompute between the two
 * and publish a snapshot whose feed disagrees with its own visitor count.
 */
export const TOUCH_VISITOR_SCRIPT = `
local presence = KEYS[1]
local meta = KEYS[2]
local pages = KEYS[3]
local channel = KEYS[4]
local feed = KEYS[5]

local visitor = ARGV[1]
local score = tonumber(ARGV[2])
local window_ms = tonumber(ARGV[3])
local has_page = ARGV[4] == '1'
local page_path = ARGV[5]
local page_max = tonumber(ARGV[6])
local publish_payload = ARGV[7]
local has_feed = ARGV[8] == '1'
local feed_entry = ARGV[9]
local feed_max = tonumber(ARGV[10])
local feed_window_ms = tonumber(ARGV[11])
local meta_field_count = tonumber(ARGV[12])

redis.call('ZADD', presence, score, visitor)
redis.call('ZREMRANGEBYSCORE', presence, '-inf', score - window_ms)
redis.call('PEXPIRE', presence, window_ms)

if meta_field_count > 0 then
  local hset_args = {}
  for i = 1, meta_field_count * 2 do
    hset_args[i] = ARGV[12 + i]
  end
  redis.call('HSET', meta, unpack(hset_args))
  redis.call('PEXPIRE', meta, window_ms)
end

if has_page then
  local head = redis.call('LINDEX', pages, 0)
  if head ~= page_path then
    redis.call('LPUSH', pages, page_path)
    redis.call('LTRIM', pages, 0, page_max - 1)
  end
  redis.call('PEXPIRE', pages, window_ms)
end

if has_feed then
  redis.call('LPUSH', feed, feed_entry)
  redis.call('LTRIM', feed, 0, feed_max - 1)
  redis.call('PEXPIRE', feed, feed_window_ms)
end

redis.call('PUBLISH', channel, publish_payload)
return 1
`

/**
 * Bump a subject's access epoch and announce the disconnect, atomically.
 *
 * KEYS: epoch counter, control channel. ARGV: [1] subject, [2] key TTL in ms.
 * The published message carries the subject and the *new* epoch so a gateway can
 * disconnect exactly the streams that snapshotted an older one. `subject` is
 * charset-guarded upstream, so interpolating it into the JSON cannot break the
 * message.
 *
 * The `PEXPIRE` is inside the script rather than a second round trip: a bump that
 * created the key and then failed to set its TTL would leave exactly the immortal
 * key the TTL exists to stop.
 */
export const BUMP_EPOCH_SCRIPT = `
local epoch = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('PUBLISH', KEYS[2], '{"subject":"' .. ARGV[1] .. '","epoch":' .. epoch .. '}')
return epoch
`

/**
 * How long a tag sighting outlives its last fetch (ADR-0081, D2).
 *
 * Twenty-four hours, refreshed on every write, because the question it answers
 * has a short life: "is the tag loading, right now, while I watch this screen".
 * A day is long enough that an install started on Friday evening still explains
 * itself on Saturday morning, and short enough that nothing here needs a purge —
 * which is why this is a cache key and not a Postgres row (ADR-0081, D6).
 */
export const TAG_SIGHTING_TTL_SECONDS = DAY_IN_SECONDS

/**
 * The deployment-wide "a country was resolved" key (server-side exclusions).
 * Not site-scoped: whether countries resolve is a property of the collector's
 * geo source, which is the same for every site it serves.
 */
export const GEO_RESOLVED_KEY = 'collector_geo_resolved'

/**
 * Seven days: long enough that a quiet weekend does not report geo as off,
 * short enough that removing the GeoIP database shows up within a week.
 */
export const GEO_RESOLVED_TTL_SECONDS = 7 * DAY_IN_SECONDS

/**
 * How many distinct origins one site may record (ADR-0081, D2).
 *
 * The public tracking key is write-only and can be pasted anywhere, so this hash
 * is reachable by anyone holding it. Capping the field count keeps it a
 * diagnostic and not a place to write: past the cap a *new* origin is dropped
 * while the origins already recorded keep refreshing, so the site's real
 * installs stay visible rather than being pushed out by noise.
 */
export const TAG_SIGHTING_MAX_ORIGINS = 20

/**
 * The field a sighting with no `Origin` header is recorded under (ADR-0081, D2).
 *
 * Not the empty string: a hash field that is empty reads as "unset" on every
 * screen that renders it, and "the tag fetched configuration from somewhere that
 * sent no origin" is a fact, not a missing one. Parenthesised so it cannot be
 * confused with a host — no origin can ever spell it.
 */
export const TAG_SIGHTING_ORIGIN_ABSENT = '(none)'

/**
 * Record a tag sighting under the field cap, as one atomic script.
 *
 * KEYS: the site's sighting HASH.
 * ARGV: [1] origin (the field), [2] JSON value, [3] field cap, [4] TTL seconds.
 *
 * `HLEN` and `HSET` have to be one round trip or the cap is decorative: twenty
 * concurrent config fetches from twenty new origins would each read a length
 * under the cap and each write.
 *
 * The cap applies to *new* fields only. An origin already recorded is always
 * updated, so a site that reached the cap keeps reporting fresh instants for the
 * installs it knows about instead of freezing at whichever twenty arrived first.
 *
 * The `EXPIRE` is inside the write branch: a refused write must not extend the
 * life of the hash that refused it, or a stream of unknown origins would keep a
 * full hash alive forever without adding a single fact to it.
 */
export const RECORD_TAG_SIGHTING_SCRIPT = `
local field = ARGV[1]
local value = ARGV[2]
local max_origins = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])

if redis.call('HEXISTS', KEYS[1], field) == 0 and redis.call('HLEN', KEYS[1]) >= max_origins then
  return 0
end

redis.call('HSET', KEYS[1], field, value)
redis.call('EXPIRE', KEYS[1], ttl_seconds)
return 1
`

/**
 * Parses a sighting HASH into the newest-first list the read surface serves.
 *
 * A malformed field is skipped rather than failing the whole read: this is a
 * diagnostic, and one unreadable value must not be able to hide the nineteen
 * that would have told the developer what they need to know. The instant has to
 * parse as well as be a string — an unparseable `at` cannot be ordered, and an
 * entry that cannot be ordered cannot be "the newest sighting", which is the
 * only thing the screens render.
 */
export function parseTagSightings(hash: Record<string, string>): TagSighting[] {
  const sightings: { sighting: TagSighting; atMs: number }[] = []

  for (const [origin, raw] of Object.entries(hash)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue

    const row = parsed as Record<string, unknown>
    const at = row['at']
    const allowed = row['allowed']
    if (typeof at !== 'string' || typeof allowed !== 'boolean') continue

    const atMs = Date.parse(at)
    if (!Number.isFinite(atMs)) continue

    sightings.push({ sighting: { origin, at, allowed }, atMs })
  }

  // Newest first, then by origin: the hash has no order of its own, and two
  // sightings recorded in the same millisecond must still come back in the same
  // order on every read or the screen's "newest sighting" would flicker.
  sightings.sort((a, b) =>
    b.atMs !== a.atMs
      ? b.atMs - a.atMs
      : a.sighting.origin < b.sighting.origin
        ? -1
        : a.sighting.origin > b.sighting.origin
          ? 1
          : 0,
  )

  return sightings.map((entry) => entry.sighting)
}

/** Seconds from an instant to the next UTC midnight, plus `extraDays` of slack. */
function dailyTtlSeconds(at: Date, extraDays = 1): number {
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1)
  return Math.max(1, Math.ceil((midnight - at.getTime()) / 1000)) + extraDays * 86_400
}

/** The UTC day `offset` whole days before `at`, as `YYYY-MM-DD`. */
export function utcDayOffset(at: Date, offset: number): string {
  return new Date(at.getTime() - offset * 86_400_000).toISOString().slice(0, 10)
}

/**
 * A usage counter outlives its window by the lateness horizon, and no longer.
 *
 * Derived rather than chosen: an event accepted at the last instant of a window
 * may still arrive up to `EVENT_MAX_LATENESS_HOURS` late, and after that nothing
 * can be attributed to the window, so the counter has nothing left to count.
 */
function usageTtlSeconds(windowEnd: Date, at: Date, latenessHours: number): number {
  const remaining = Math.ceil((windowEnd.getTime() - at.getTime()) / 1000)
  return Math.max(60, remaining + latenessHours * 3_600)
}

export interface RealtimeCacheOptions {
  readonly client: Redis
  /** Lateness horizon, from `Policy`. Never a literal here (AGENTS.md). */
  readonly eventMaxLatenessHours: number
  /**
   * How many whole days of daily-ceiling history to retain, from
   * `SITE_CEILING_ALERT_CONSECUTIVE_DAYS`. Never a literal here (AGENTS.md).
   *
   * The counter used to expire a day after its own day, which was enough to
   * enforce the ceiling and not enough to notice a streak — so the alert G-005
   * describes had no way to be evaluated (ADR-0009 recorded it as missing). The
   * TTL now spans the alert window plus the day in progress.
   */
  readonly ceilingHistoryDays?: number
  readonly keyPrefix?: string
}

export function createRealtimeCache(options: RealtimeCacheOptions): RealtimeCache {
  const { client } = options
  const prefix = options.keyPrefix ?? ''
  // Plus one for the day in progress, which the streak check excludes but the
  // counter is still accumulating into.
  const ceilingHistoryDays = (options.ceilingHistoryDays ?? 3) + 1
  const key = (name: string): string => `${prefix}${name}`

  const incrementWindows = async (
    entries: readonly { key: string; increment: number; ttlSeconds: number }[],
  ): Promise<number[]> => {
    const argv: string[] = [String(entries.length)]
    for (const entry of entries) {
      argv.push(String(entry.increment), String(entry.ttlSeconds))
    }

    const reply = (await client.eval(
      INCREMENT_WINDOWS_SCRIPT,
      entries.length,
      ...entries.map((entry) => entry.key),
      ...argv,
    )) as unknown

    if (!Array.isArray(reply) || reply.length !== entries.length) {
      throw new Error(`Unexpected counter reply: ${JSON.stringify(reply)}`)
    }
    return reply.map((value) => Number(value))
  }

  return {
    async chargeRateLimits(input: RateLimitChargeInput): Promise<ChargedRateLimits> {
      const minute = minuteBucketOf(input.at)
      const day = utcDayOf(input.at)

      const [ipSite = 0, identity = 0, site = 0, siteDaily = 0] = await incrementWindows([
        {
          key: key(rateLimitIpKey(input.siteId, input.ipHash, minute)),
          increment: input.cost,
          ttlSeconds: RATE_LIMIT_WINDOW_TTL_SECONDS,
        },
        {
          key: key(rateLimitIdentityKey(input.siteId, input.identityHash, minute)),
          increment: input.cost,
          ttlSeconds: RATE_LIMIT_WINDOW_TTL_SECONDS,
        },
        {
          key: key(rateLimitSiteKey(input.siteId, minute)),
          increment: input.cost,
          ttlSeconds: RATE_LIMIT_WINDOW_TTL_SECONDS,
        },
        {
          key: key(dailyCeilingKey(input.siteId, day)),
          increment: input.cost,
          // Longer than the other daily counters: this one is also the streak
          // memory the ceiling alert reads back.
          ttlSeconds: dailyTtlSeconds(input.at, ceilingHistoryDays),
        },
      ])

      return { ipSite, identity, site, siteDaily }
    },

    async readUsage(input: UsageReadInput): Promise<UsageReads> {
      const values = await client.mget(
        key(usageCounterKey(input.billingUserId, input.usageWindowStart)),
        key(dailyBillableKey(input.siteId, utcDayOf(input.at))),
      )

      return {
        billableUsed: Number(values[0] ?? 0),
        siteDailyBillable: Number(values[1] ?? 0),
      }
    },

    async recordBillable(input: RecordBillableInput): Promise<void> {
      if (input.billable <= 0) return

      await incrementWindows([
        {
          key: key(usageCounterKey(input.billingUserId, input.usageWindowStart)),
          increment: input.billable,
          ttlSeconds: usageTtlSeconds(
            input.usageWindowEnd,
            input.at,
            options.eventMaxLatenessHours,
          ),
        },
        {
          key: key(dailyBillableKey(input.siteId, utcDayOf(input.at))),
          increment: input.billable,
          ttlSeconds: dailyTtlSeconds(input.at),
        },
      ])
    },

    async readWindowUsage(input: WindowUsageKey): Promise<number> {
      const value = await client.get(
        key(usageCounterKey(input.billingUserId, input.usageWindowStart)),
      )
      return Number(value ?? 0)
    },

    async raiseWindowUsage(input: RaiseWindowUsageInput): Promise<void> {
      if (input.delta <= 0) return

      await incrementWindows([
        {
          key: key(usageCounterKey(input.billingUserId, input.usageWindowStart)),
          increment: input.delta,
          ttlSeconds: usageTtlSeconds(
            input.usageWindowEnd,
            input.at,
            options.eventMaxLatenessHours,
          ),
        },
      ])
    },

    async readDailyCeilingCounts(input): Promise<number[]> {
      if (input.days <= 0) return []
      const keys = Array.from({ length: input.days }, (_, index) =>
        key(dailyCeilingKey(input.siteId, utcDayOffset(input.endingBefore, index + 1))),
      )
      const values = await client.mget(...keys)
      return values.map((value) => Number(value ?? 0))
    },

    async touchVisitor(input: PresenceTouchInput): Promise<void> {
      const scoreMs = input.at.getTime()

      // `last_seen_ms` is always known; the rest is set only when supplied, so a
      // touch never overwrites a known country/page with a blank.
      const metaFields: string[] = ['last_seen_ms', String(scoreMs)]
      if (input.page?.path) metaFields.push('path', input.page.path)
      if (input.page?.title) metaFields.push('title', input.page.title)
      if (input.country) metaFields.push('country', input.country)
      if (input.deviceType) metaFields.push('device_type', input.deviceType)
      if (input.browser) metaFields.push('browser', input.browser)
      if (input.os) metaFields.push('os', input.os)
      if (input.city) metaFields.push('city', input.city)

      const hasPage = input.page?.path ? '1' : '0'
      const pagePath = input.page?.path ?? ''

      // A feed entry needs a page to describe. `feed` without one would be an
      // event with no path, which the reader would drop anyway.
      const feedEntry =
        input.feed !== undefined && input.page?.path
          ? JSON.stringify({
              eventId: input.feed.eventId,
              occurredAtMs: input.feed.occurredAt.getTime(),
              visitorId: input.visitorId,
              path: input.page.path,
              country: input.country ?? null,
              deviceType: input.deviceType ?? null,
              browser: input.browser ?? null,
              os: input.os ?? null,
              referrer: input.feed.referrer ?? null,
            })
          : null

      await client.eval(
        TOUCH_VISITOR_SCRIPT,
        5,
        key(visitorPresenceKey(input.siteId)),
        key(visitorMetaKey(input.siteId, input.visitorId)),
        key(visitorPagesKey(input.siteId, input.visitorId)),
        key(realtimeUpdatesChannel(input.siteId)),
        key(realtimeFeedKey(input.siteId)),
        input.visitorId,
        String(scoreMs),
        String(VISITOR_PRESENCE_WINDOW_MS),
        hasPage,
        pagePath,
        String(PRESENCE_PAGE_HISTORY_MAX),
        JSON.stringify({ t: scoreMs }),
        feedEntry === null ? '0' : '1',
        feedEntry ?? '',
        String(PRESENCE_FEED_MAX),
        String(REALTIME_FEED_WINDOW_MS),
        String(metaFields.length / 2),
        ...metaFields,
      )
    },

    async readPresenceSnapshot(input: PresenceSnapshotInput): Promise<PresenceSnapshot> {
      const presenceKey = key(visitorPresenceKey(input.siteId))
      const min = input.at.getTime() - VISITOR_PRESENCE_WINDOW_MS

      // The true active count comes from ZCOUNT; the metadata sample is bounded
      // by maxVisitors, so a very busy site's snapshot stays cheap and reports
      // `truncated` rather than scanning everything. The feed is a fixed-length
      // range on a list trimmed at write, so it adds a constant to this read.
      //
      // **Newest-first** (`zrevrangebyscore`), which it was not before ADR-0035.
      // The `present` list has to be the newest N, and taking it from the head
      // of this same sample is what keeps that free: with an oldest-first range
      // on a site past `maxVisitors`, the newest 50 would be exactly the ones the
      // sample excluded, and naming them would have cost a second range plus a
      // second pipeline of HGETALLs. It also makes the truncated *breakdowns*
      // the most recent visitors rather than the ones nearest to expiring, which
      // is the better sample for a surface that says "right now".
      const [activeVisitors, members, feed] = await Promise.all([
        client.zcount(presenceKey, min, '+inf'),
        client.zrevrangebyscore(presenceKey, '+inf', min, 'LIMIT', 0, input.maxVisitors),
        client.lrange(key(realtimeFeedKey(input.siteId)), 0, PRESENCE_FEED_MAX - 1),
      ])

      const entries: (Record<string, string> | null)[] = []
      if (members.length > 0) {
        const pipeline = client.pipeline()
        for (const member of members) {
          pipeline.hgetall(key(visitorMetaKey(input.siteId, member)))
        }
        const replies = (await pipeline.exec()) ?? []
        for (const [error, value] of replies) {
          if (error || value === null || value === undefined) {
            entries.push(null)
            continue
          }
          const hash = value as Record<string, string>
          entries.push(Object.keys(hash).length > 0 ? hash : null)
        }
      }

      return aggregatePresenceSnapshot({
        activeVisitors,
        truncated: activeVisitors > input.maxVisitors,
        entries,
        feed,
        // Paired here, where the pairing is knowable: `entries[i]` is the
        // metadata of `members[i]` by construction of the pipeline above. Only
        // the head of the range is needed, so the slice happens before the map
        // rather than inside the aggregation.
        present: members
          .slice(0, PRESENCE_PRESENT_MAX)
          .map((visitorId, index) => ({ visitorId, meta: entries[index] ?? null })),
      })
    },

    async getEpoch(input: EpochRef): Promise<number | null> {
      const epochKey = key(realtimeEpochKey(input.siteId, input.subject))
      const value = await client.get(epochKey)
      if (value === null) return null
      // Refresh on read: a key backing a live stream is read every
      // REALTIME_EPOCH_CHECK_SECONDS, so it can never age out under traffic.
      // Best-effort — the GET above is the authorization decision and the only
      // call allowed to fail this read closed; a TTL-refresh write rejection
      // (read-only replica, OOM policy) must not cut every stream.
      void client.pexpire(epochKey, REALTIME_EPOCH_TTL_MS).catch(() => undefined)
      return Number(value)
    },

    async ensureEpoch(input: EpochRef): Promise<number> {
      const epochKey = key(realtimeEpochKey(input.siteId, input.subject))
      // SET NX establishes the floor without clobbering a bump that already
      // happened; the GET then reads whatever value is authoritative.
      await client.set(epochKey, '0', 'NX')
      await client.pexpire(epochKey, REALTIME_EPOCH_TTL_MS)
      const value = await client.get(epochKey)
      return Number(value ?? 0)
    },

    async bumpEpochAndPublishDisconnect(input: EpochRef): Promise<number> {
      const reply = (await client.eval(
        BUMP_EPOCH_SCRIPT,
        2,
        key(realtimeEpochKey(input.siteId, input.subject)),
        key(realtimeControlChannel(input.siteId)),
        input.subject,
        String(REALTIME_EPOCH_TTL_MS),
      )) as unknown
      return Number(reply)
    },

    async countBot(input): Promise<void> {
      await incrementWindows([
        {
          key: key(botCounterKey(input.siteId, utcDayOf(input.at), input.signature)),
          increment: input.cost,
          ttlSeconds: dailyTtlSeconds(input.at),
        },
      ])
    },

    async recordTagSighting(input: RecordTagSightingInput): Promise<void> {
      await client.eval(
        RECORD_TAG_SIGHTING_SCRIPT,
        1,
        key(tagSightingKey(input.siteId)),
        input.origin,
        JSON.stringify({ at: input.at.toISOString(), allowed: input.allowed }),
        String(TAG_SIGHTING_MAX_ORIGINS),
        String(TAG_SIGHTING_TTL_SECONDS),
      )
    },

    async readTagSightings(input: { siteId: string }): Promise<TagSighting[]> {
      const hash = await client.hgetall(key(tagSightingKey(input.siteId)))
      return parseTagSightings(hash)
    },

    async markGeoResolved(input: { at: Date }): Promise<void> {
      await client.set(
        key(GEO_RESOLVED_KEY),
        input.at.toISOString(),
        'EX',
        GEO_RESOLVED_TTL_SECONDS,
      )
    },

    async readGeoResolvedAt(): Promise<string | null> {
      return client.get(key(GEO_RESOLVED_KEY))
    },
  }
}

/**
 * How long a visitor stays "active" without another signal (ADR-0035, D1).
 *
 * **Five minutes, because that is what the word "online" promises** — the same
 * window Plausible, Fathom and Umami use (Matomo and GA4 use 30). It was 60 s,
 * which was twice the tracker's default heartbeat interval plus slack: enough to
 * survive one dropped heartbeat and nothing more. The accepted price is stated
 * rather than engineered away: a visitor who closed the tab lingers for up to
 * five minutes, because no browser signal reliably says "gone".
 *
 * Not the session boundary — `SESSION_INACTIVITY_MINUTES` is a different
 * question about a different store (02 §10).
 *
 * **A module constant rather than a policy value, deliberately** (ADR-0035, D4).
 * The distinction is not importance, it is how many processes must agree: the
 * gateway alone reads `REALTIME_SNAPSHOT_CACHE_SECONDS`, but this is a *store
 * format* — the collector writes it as a `PEXPIRE` and a trim bound, the gateway
 * reads it as a `ZCOUNT` min bound, and two services disagreeing would trim the
 * ZSET at one boundary while filtering it at another. As an environment variable
 * in two compose services that disagreement is one forgotten line away, and it
 * is invisible, because both halves keep working. Same class as
 * `PRESENCE_FEED_MAX`: a shape both sides of a key encode identically.
 *
 * Every TTL the touch sets is this value, so the resident key count is
 * `arrival rate x window` — five times what it was, bounded by score and not by
 * count. The snapshot's *metadata sample* is what
 * `REALTIME_SNAPSHOT_MAX_VISITORS` bounds; the ZSET behind it is not bounded at
 * all, and reports `truncated` instead.
 */
export const VISITOR_PRESENCE_WINDOW_MS = 5 * 60_000
