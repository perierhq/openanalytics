import { createHash } from 'node:crypto'

/**
 * Key naming for the durable queue instance (docs snapshot 05, D-205).
 *
 * The names are centralised because two independent processes must agree on
 * them without sharing code paths: the collector writes them from Vercel, the
 * worker and the deletion job read them from the private network. A drifted
 * prefix would not fail loudly — it would produce an empty consumer group and a
 * deletion that reports success having found nothing.
 */

export const EVENT_STREAM_KEY = 'event_stream'
export const EVENT_STREAM_GROUP = 'ingest_workers'
/**
 * Dead-letter stream (docs snapshot 02 §7.4).
 *
 * A separate stream rather than a flag on the entry: a poisoned batch must stop
 * being redelivered to the consumer group while staying readable for the admin
 * view and the manual replay the same section requires.
 */
export const EVENT_STREAM_DLQ_KEY = 'event_stream_dlq'
export const DEDUP_KEY_PREFIX = 'ingest_dedup'
/**
 * Record of an event the site's own exclusions dropped: a payload hash and a
 * time, kept for the dedup window so a retry of it answers `duplicate` and a
 * changed body answers `409`, exactly as a counted event's would.
 */
export const EXCLUDED_RECORD_KEY_PREFIX = 'ingest_excluded'
/** Named by docs snapshot 05, D-209: `site_queue_index:{site}:{utc_day}`. */
export const SITE_QUEUE_INDEX_PREFIX = 'site_queue_index'

/**
 * Identifiers are interpolated into `:`-delimited keys, so a value carrying a
 * separator would let one site address another site's dedup record. Site and
 * event IDs are UUIDs on every path that reaches here, so the narrow charset
 * costs nothing and closes the injection instead of documenting it.
 */
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/

export class InvalidKeyComponentError extends Error {
  readonly component: string

  constructor(component: string, value: string) {
    super(`Invalid ${component} "${value}": expected 1-128 characters of [A-Za-z0-9_-]`)
    this.name = 'InvalidKeyComponentError'
    this.component = component
  }
}

function assertSafe(component: string, value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new InvalidKeyComponentError(component, value)
  }
  return value
}

/**
 * UTC day bucket for a server `accepted_at`.
 *
 * Parsed rather than string-sliced on purpose: `accepted_at` is an instant, and
 * an offset-bearing timestamp such as `2026-07-21T23:30:00+05:00` belongs to the
 * *20th* in UTC. Slicing would file it under the wrong bucket, and deletion
 * would then miss it (docs snapshot 05, D-210).
 */
export function utcDayOf(acceptedAt: string | Date): string {
  const at = acceptedAt instanceof Date ? acceptedAt : new Date(acceptedAt)
  if (Number.isNaN(at.getTime())) {
    throw new RangeError(`Invalid accepted_at timestamp: ${String(acceptedAt)}`)
  }
  return at.toISOString().slice(0, 10)
}

/** Dedup record for one `(site_id, event_id)` pair (docs snapshot 05, D-209 step 1). */
export function dedupKey(siteId: string, eventId: string): string {
  return `${DEDUP_KEY_PREFIX}:${assertSafe('siteId', siteId)}:${assertSafe('eventId', eventId)}`
}

/**
 * Record key for one excluded `(site_id, event_id)` pair.
 *
 * Hashed, unlike the dedup key: nothing else ever needs to find these records
 * by site — they hold no payload, there is no stream entry for deletion to
 * chase, and they expire on the dedup TTL — so the key does not name the site
 * either. A site deleted inside the window leaves keys that say nothing about
 * it and are gone when the window closes.
 */
export function excludedRecordKey(siteId: string, eventId: string): string {
  const digest = createHash('sha256')
    .update(`${assertSafe('siteId', siteId)}:${assertSafe('eventId', eventId)}`)
    .digest('hex')
  return `${EXCLUDED_RECORD_KEY_PREFIX}:${digest}`
}

/**
 * Day bucket holding the stream IDs a site produced.
 *
 * This is what makes deletion bounded: without it, removing a site's retained
 * payloads means scanning the whole stream (docs snapshot 05, D-210).
 */
export function siteQueueIndexKey(siteId: string, day: string): string {
  return `${SITE_QUEUE_INDEX_PREFIX}:${assertSafe('siteId', siteId)}:${assertSafe('utcDay', day)}`
}

/**
 * Separator inside a day-bucket entry. It appears in neither of the two ids it
 * joins — a stream id is `<ms>-<seq>` and an event id is a UUID — so the pair
 * never has to be escaped and never parses ambiguously.
 */
export const SITE_QUEUE_INDEX_SEPARATOR = '|'

/** `<stream id>|<event id>`, the form the enqueue script appends. */
export function encodeSiteQueueIndexEntry(streamId: string, eventId: string): string {
  return `${streamId}${SITE_QUEUE_INDEX_SEPARATOR}${eventId}`
}

export interface SiteQueueIndexEntry {
  readonly streamId: string
  readonly eventId: string
}

/**
 * Thrown by a bucket entry that carries no separator.
 *
 * Until 2026-08-06 this was not an error but a supported second form: ADR-0021
 * widened the entry from a bare stream id to the pair, and the decoder kept a
 * branch reading the old shape with a null `eventId`. ADR-0030 follow-up 2
 * granted permission to delete that branch once `SITE_QUEUE_INDEX_TTL_DAYS`
 * (8 days) had elapsed since the 0021 deploy of 2026-07-27 — not before
 * 2026-08-04 — and the permission was exercised after confirming the format had
 * actually drained rather than assuming the arithmetic: all 26 production
 * buckets were read end to end, 3 291 entries, **every one** carrying the
 * separator, the oldest bucket dated 2026-07-28.
 *
 * So an entry without one is no longer an old entry; it is a corrupt one, and
 * the deletion path is where that distinction earns its keep. The purge runs
 * inside `withTargetFailure`, which records the message on the
 * `deletion_targets` row, counts the attempt against `JOB_MAX_ATTEMPTS` and
 * leaves the target unpurged. Guessing instead — taking the whole entry as a
 * stream id and inventing no dedup key — would let a site deletion report
 * success over a bucket it could not read, which for an erasure is the one
 * outcome worth failing loudly to avoid.
 */
export class MalformedSiteQueueIndexEntryError extends Error {
  constructor(entry: string) {
    super(`site queue index entry has no "${SITE_QUEUE_INDEX_SEPARATOR}" separator: ${entry}`)
    this.name = 'MalformedSiteQueueIndexEntryError'
  }
}

export function decodeSiteQueueIndexEntry(entry: string): SiteQueueIndexEntry {
  const separator = entry.indexOf(SITE_QUEUE_INDEX_SEPARATOR)
  if (separator < 0) throw new MalformedSiteQueueIndexEntryError(entry)
  return {
    streamId: entry.slice(0, separator),
    eventId: entry.slice(separator + 1),
  }
}

export const DAY_IN_SECONDS = 86_400

export function daysToSeconds(days: number): number {
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(`TTL must be a positive whole number of days, received ${String(days)}`)
  }
  return days * DAY_IN_SECONDS
}

/**
 * Key naming for the realtime-cache instance.
 *
 * A different instance from the queue (D-205), so these names cannot collide
 * with the durable ones — but they are centralised for the same reason: the
 * collector writes them and the realtime gateway, the deletion job and the
 * worker's reconciliation all read them, from separate processes that share no
 * code path.
 */

export const RATE_LIMIT_IP_PREFIX = 'rl_ip'
export const RATE_LIMIT_IDENTITY_PREFIX = 'rl_id'
export const RATE_LIMIT_SITE_PREFIX = 'rl_site'
export const DAILY_CEILING_PREFIX = 'site_day_events'
export const DAILY_BILLABLE_PREFIX = 'site_day_billable'
export const USAGE_COUNTER_PREFIX = 'usage_window'
export const VISITOR_PRESENCE_PREFIX = 'rt_visitors'
export const BOT_COUNTER_PREFIX = 'sec_bot'

/**
 * Realtime presence-model v2 key families (docs snapshot 02 §17).
 *
 * `rt_meta` is the per-visitor metadata HASH the ZSET member points at; `rt_pages`
 * is the bounded per-visitor page history LIST. Both are keyed by `(site,
 * visitor)` and carry the presence-window TTL, so they cannot outlive the
 * liveness they describe. `rt_updates`/`rt_control` are the Pub/Sub channels the
 * shared gateway subscribes to — one carries "something changed, recompute", the
 * other carries a targeted disconnect. `rt_epoch` is the per-subject access epoch
 * a token snapshots and the gateway re-checks.
 */
/**
 * Where a site's tag has been seen loading in the last 24 hours (ADR-0081 D2).
 *
 * One HASH per site, fields keyed by the lowercased `Origin` of the config
 * fetch. Deliberately not a realtime-presence key: it counts *installations
 * asking for configuration*, including the ones the ingest gate then refuses,
 * which is exactly the population presence cannot contain.
 */
export const TAG_SIGHTING_PREFIX = 'tag_sighting'

export const VISITOR_META_PREFIX = 'rt_meta'
export const VISITOR_PAGES_PREFIX = 'rt_pages'
export const REALTIME_FEED_PREFIX = 'rt_feed'
export const REALTIME_UPDATES_CHANNEL_PREFIX = 'rt_updates'
export const REALTIME_CONTROL_CHANNEL_PREFIX = 'rt_control'
export const REALTIME_EPOCH_PREFIX = 'rt_epoch'

/**
 * Two minutes, for a one-minute window.
 *
 * The extra minute is not slack: a request arriving at the boundary reads the
 * bucket it is about to leave, and expiring on the minute would let a caller
 * reset their own counter by timing requests at :59.
 */
export const RATE_LIMIT_WINDOW_TTL_SECONDS = 120

/** The one-minute bucket an instant falls in, as `YYYY-MM-DDTHH:MM`. */
export function minuteBucketOf(at: Date): string {
  return at.toISOString().slice(0, 16)
}

export function rateLimitIpKey(siteId: string, ipHash: string, minute: string): string {
  return `${RATE_LIMIT_IP_PREFIX}:${assertSafe('siteId', siteId)}:${assertSafe('ipHash', ipHash)}:${minute}`
}

export function rateLimitIdentityKey(siteId: string, identityHash: string, minute: string): string {
  return `${RATE_LIMIT_IDENTITY_PREFIX}:${assertSafe('siteId', siteId)}:${assertSafe('identityHash', identityHash)}:${minute}`
}

export function rateLimitSiteKey(siteId: string, minute: string): string {
  return `${RATE_LIMIT_SITE_PREFIX}:${assertSafe('siteId', siteId)}:${minute}`
}

/** Every accepted event, for the G-005 per-site daily safety ceiling. */
export function dailyCeilingKey(siteId: string, day: string): string {
  return `${DAILY_CEILING_PREFIX}:${assertSafe('siteId', siteId)}:${assertSafe('utcDay', day)}`
}

/** Billable events only, for the G-005 rapid-burn notice. */
export function dailyBillableKey(siteId: string, day: string): string {
  return `${DAILY_BILLABLE_PREFIX}:${assertSafe('siteId', siteId)}:${assertSafe('utcDay', day)}`
}

/**
 * The D-103 near-realtime usage counter.
 *
 * Keyed by `(billing user, window start)` — the same natural key as the
 * `usage_windows` unique constraint (migration 0011) — because the collector
 * cannot mint the window's row id without writing to Postgres, and the worker
 * has to be able to reconcile onto the counter the collector was reading.
 */
export function usageCounterKey(billingUserId: string, windowStart: Date): string {
  return `${USAGE_COUNTER_PREFIX}:${assertSafe('billingUserId', billingUserId)}:${windowStart.toISOString()}`
}

export function visitorPresenceKey(siteId: string): string {
  return `${VISITOR_PRESENCE_PREFIX}:${assertSafe('siteId', siteId)}`
}

/**
 * Per-visitor metadata HASH. `visitorId` is the anonymous id (hex) — narrow
 * charset, so it cannot carry a separator that would address another visitor's
 * key. No raw IP and no user-agent string ever lands here (docs snapshot 02 §17
 * keeps the realtime store free of them); the coarse GeoLite2 city ADR-0024
 * admits is stored here and read by the private snapshot alone.
 */
export function visitorMetaKey(siteId: string, visitorId: string): string {
  return `${VISITOR_META_PREFIX}:${assertSafe('siteId', siteId)}:${assertSafe('visitorId', visitorId)}`
}

/** Per-visitor bounded page-history LIST (docs snapshot 02 §17). */
export function visitorPagesKey(siteId: string, visitorId: string): string {
  return `${VISITOR_PAGES_PREFIX}:${assertSafe('siteId', siteId)}:${assertSafe('visitorId', visitorId)}`
}

/**
 * Per-site bounded rolling page-view feed LIST (ADR-0024).
 *
 * Site-scoped rather than per-visitor: the board reads one feed for the whole
 * site, and a per-visitor list would make the read a scan. Written by the same
 * atomic touch that updates presence, trimmed on write, and carrying its own
 * expiry — the entries it holds are anonymous by construction (the D-102 visitor
 * hash, a sanitized path, coarse geo/UA labels), the same material the presence
 * HASH already holds.
 */
export function realtimeFeedKey(siteId: string): string {
  return `${REALTIME_FEED_PREFIX}:${assertSafe('siteId', siteId)}`
}

/** Pub/Sub channel: "a visitor in this site changed; recompute the snapshot". */
export function realtimeUpdatesChannel(siteId: string): string {
  return `${REALTIME_UPDATES_CHANNEL_PREFIX}:${assertSafe('siteId', siteId)}`
}

/** Pub/Sub channel: a targeted disconnect for one subject on this site. */
export function realtimeControlChannel(siteId: string): string {
  return `${REALTIME_CONTROL_CHANNEL_PREFIX}:${assertSafe('siteId', siteId)}`
}

/**
 * Access-epoch counter for a subject on a site.
 *
 * `subject` is a user id or the literal `public`. A removed member's epoch is
 * bumped, which invalidates every token that snapshotted the old value; the
 * gateway compares a token's `epoch` against this key at connect time and on
 * every keepalive (docs snapshot 02 §17, D-213).
 */
export function realtimeEpochKey(siteId: string, subject: string): string {
  return `${REALTIME_EPOCH_PREFIX}:${assertSafe('siteId', siteId)}:${assertSafe('subject', subject)}`
}

/**
 * The site's tag-sighting HASH (ADR-0081, D2).
 *
 * Site-scoped and nothing else: the origins live in its fields, so a pasted key
 * cannot address another site's record and an unusual origin cannot become part
 * of a key name.
 */
export function tagSightingKey(siteId: string): string {
  return `${TAG_SIGHTING_PREFIX}:${assertSafe('siteId', siteId)}`
}

/**
 * Aggregate bot counter (G-005).
 *
 * The signature is a rule name from the versioned ruleset, never a user agent:
 * a counter keyed by the matched text would be unbounded cardinality and
 * visitor data in a store nothing redacts.
 */
export function botCounterKey(siteId: string, day: string, signature: string): string {
  return `${BOT_COUNTER_PREFIX}:${assertSafe('siteId', siteId)}:${assertSafe('utcDay', day)}:${assertSafe('signature', signature)}`
}
