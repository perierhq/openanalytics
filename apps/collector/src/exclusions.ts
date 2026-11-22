import { EXCLUSION_REASONS, type ExclusionReason } from '@openanalytics/domain'
import type { RealtimeCache } from '@openanalytics/redis'
import type { CollectorDeps } from './deps.ts'
import type { IngestEndpoint } from './ingest-gate.ts'
import { COLLECTOR_METRICS } from './metrics.ts'

/**
 * Server-side exclusions on the ingest path: the site's own list of traffic it
 * does not count (IP ranges, countries, hostnames, paths).
 *
 * The matchers are compiled once per config version by the ingest-config
 * store; this module only asks them. Three rules shape it:
 *
 * - **The raw address is read in memory and forgotten.** It is the same address
 *   geo and the rate limiter read (`readRawClientAddress`), it is tested against
 *   the ranges and dropped; neither it, the path nor the host appears in a log,
 *   a metric label or an error.
 * - **The answer does not change.** An excluded event is answered exactly as
 *   the same event counted would be, because it takes the same road through
 *   the events route and leaves out only what would store or show it. It is
 *   time-checked, classified, weighed by the quota check, and handed to the
 *   same enqueue script as the counted events of its batch — as a payload hash
 *   and a time under a hashed `(site_id, event_id)` key, kept for the counted
 *   path's dedup window (`INGEST_DEDUP_TTL_DAYS`). So a retry answers
 *   `duplicate`, a changed body under the same `event_id` answers `409`, an
 *   unavailable queue answers `503` (the dedup store *is* the queue, on both
 *   paths), and a quota refusal is the same refusal. The address and the
 *   payload are never written; only hashes are.
 * - **Counted, by reason only.** `collector_events_excluded{reason}` is the one
 *   trace an exclusion leaves, so an owner who excluded the wrong range can be
 *   helped by an operator who sees the drop rate move.
 *
 * What still differs, stated rather than hidden:
 *
 * - **Timing.** An excluded event skips building its envelope, the stream
 *   append, the usage increment and the realtime touch; a request made only of
 *   excluded events may answer measurably faster than the same request counted.
 *   Both make the one enqueue round trip.
 * - **The heartbeat.** An excluded heartbeat answers `204` without writing to
 *   the realtime store, so while that store is down it is still a `204` where
 *   a counted heartbeat is a `503`.
 * - **A site deleted inside the window** leaves its excluded-event records to
 *   expire on the dedup TTL: deletion cannot find them, and they hold nothing
 *   but hashes and a time.
 */

/** The host of an `Origin` header, or null. Judges a unit that has no page. */
export function originHostname(origin: string | null): string | null {
  if (origin === null) return null
  try {
    return new URL(origin).hostname
  } catch {
    return null
  }
}

/**
 * Count the dropped units by reason. One increment per reason present, valued
 * by how many units it dropped, so a batch of twenty excluded pageviews is one
 * write rather than twenty.
 */
export function countExclusions(
  deps: Pick<CollectorDeps, 'metrics'>,
  input: {
    readonly siteId: string
    readonly endpoint: IngestEndpoint
    readonly reasons: readonly (ExclusionReason | null)[]
  },
): void {
  for (const reason of EXCLUSION_REASONS) {
    const count = input.reasons.filter((entry) => entry === reason).length
    if (count === 0) continue
    deps.metrics.increment(
      COLLECTOR_METRICS.eventsExcluded,
      { site_id: input.siteId, endpoint: input.endpoint, reason },
      count,
    )
  }
}

/**
 * How often one collector process refreshes the "countries resolve" mark.
 * The key lives seven days; ten minutes keeps it fresh at the cost of one
 * Valkey write per process per ten minutes, whatever the traffic.
 */
const GEO_MARK_INTERVAL_MS = 10 * 60 * 1000

const lastGeoMark = new WeakMap<RealtimeCache, number>()

/**
 * Note that this collector resolved a country (server-side exclusions).
 *
 * The settings surface needs to say whether a country exclusion can match
 * anything, and geo is this process's fact, not the api's. Called only for a
 * country the collector's own GeoIP database resolved: a platform header
 * country is not evidence, because a visitor can send one wherever the
 * fronting proxy does not strip it. A deployment that gets countries only from
 * a platform header therefore never sets the mark, and the settings page says
 * country rules may have no effect there even though they match. Throttled in
 * memory per realtime store, fired without awaiting, and never allowed to fail
 * the request.
 */
export function noteGeoResolved(deps: Pick<CollectorDeps, 'realtime'>, at: Date): void {
  const previous = lastGeoMark.get(deps.realtime)
  if (previous !== undefined && at.getTime() - previous < GEO_MARK_INTERVAL_MS) return
  // Set before the write and never rolled back: one failed write hides the
  // mark until the interval passes, up to ten minutes.
  lastGeoMark.set(deps.realtime, at.getTime())
  void deps.realtime.markGeoResolved({ at }).catch(() => undefined)
}
