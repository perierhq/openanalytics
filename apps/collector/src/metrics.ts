/**
 * Collector metric names.
 *
 * G-005 requires every limit trigger to emit a metric, and G-006 will bind them
 * to an alert pipeline. Names live in one table so an alert rule and the code
 * that fires it cannot drift, and so the set of things this service reports is
 * readable in one place rather than scattered across throw sites.
 *
 * Every name is a legal Prometheus metric name — `[a-zA-Z_:][a-zA-Z0-9_:]*`, so
 * `collector_x` and never `collector.x`. This table used dots until the M18
 * audit, and not one of these series had ever reached Grafana: the remote-write
 * exporter dropped the invalid name and the unit tests asserted against an
 * in-memory sink that accepts any string. The exporter now repairs a bad name
 * loudly instead of dropping it, but a repaired name publishes as something no
 * alert rule mentions — so the name written here is the name PromQL must use.
 *
 * Labels are low-cardinality by contract (`@openanalytics/observability`): a
 * site id is one series per customer, an IP or a user agent is unbounded and
 * would put visitor data in a store with no redaction. Nothing here is labelled
 * with either.
 *
 * Everything the ingest gate emits also carries `endpoint`, with exactly two
 * values — `events` and `heartbeat` (ADR-0035, D9). The gate refuses silently on
 * both paths by design (a bot gets the same answer as an accepted request; a
 * disallowed origin gets a 403 the tracker treats as final), and the shared
 * request metric's `route` label is the collector middleware's own mount `/*`
 * rather than the matched path. So a dropped heartbeat and a dropped batch used
 * to be one series, and "presence stopped updating" had no series that could say
 * why. Two series per site per counter instead of one, and no new cardinality
 * class.
 */
export const COLLECTOR_METRICS = {
  /** G-005 rate limit tripped. Labelled by scope: ip_site | identity | site. */
  rateLimited: 'collector_rate_limited',
  /** G-005 per-site daily safety ceiling reached. The three-consecutive-days
   * operator alert is the worker's (ADR-0010, ADR-0013), not a collector metric. */
  dailyCeilingReached: 'collector_daily_ceiling_reached',
  /** G-005 rapid-burn: half a monthly limit spent in one UTC day. */
  rapidBurn: 'collector_rapid_burn',
  /** D-103: window limit and its buffer both spent. */
  quotaExceeded: 'collector_quota_exceeded',
  /** D-103: accepted, but into the unpaid buffer. Precedes the cut-off. */
  quotaBuffer: 'collector_quota_buffer_used',

  /** G-005 bot ruleset matched. Labelled by signature name and `endpoint`,
   * never by user agent — a bot-filtered heartbeat and a bot-filtered batch are
   * different failures and both are silent to the caller (ADR-0035, D9). */
  botFiltered: 'collector_bot_filtered',

  /** Request carried `Sec-GPC: 1`; dropped silently server-side (G-008,
   * ADR-0057 D5). Labelled by `endpoint` like the bot counter — the client-side
   * gate normally stops these before they are sent, so a sustained rate here
   * means a site disabled `data-respect-gpc` or a stale bundle is in the wild. */
  gpcFiltered: 'collector_gpc_filtered',

  /** Units dropped by the site's own server-side exclusions before anything
   * was queued or written to realtime. Labelled by `site_id`, `endpoint` and
   * `reason` — `ip`, `country`, `hostname` or `path` — and never by the
   * address, the country, the host or the path that matched: the label says
   * which list did it, the settings page says what is on the list. */
  eventsExcluded: 'collector_events_excluded',

  /** An event arrived carrying a linking hint (`order_id`) for a site whose
   * `attributed_revenue` is off; the property was removed and the event kept
   * (ADR-0064 D4a, server half). Labelled by `site_id`: the tracker strips the
   * hint before sending, so a sustained rate on one site means a stale bundle or
   * an integration posting to `/v1/events` directly — this counter is the only
   * thing that makes that gap visible. */
  linkingHintFiltered: 'collector_linking_hint_filtered',

  /** Limiter store unreachable; bounded fail-open in effect (G-005). */
  limiterFailOpen: 'collector_limiter_fail_open',
  /** Fail-open expired; the in-process fallback limiter is now deciding. */
  limiterFallback: 'collector_limiter_fallback',
  /** The fallback limiter rejected a request. */
  limiterFallbackLimited: 'collector_limiter_fallback_limited',

  /** Durable queue write failed. The request was answered 503, never 202. */
  queueWriteFailed: 'collector_queue_write_failed',
  /** Events durably enqueued. */
  eventsEnqueued: 'collector_events_enqueued',
  /** Events recognised as already accepted inside the dedup window (D-209). */
  eventsDuplicate: 'collector_events_duplicate',
  /** An event id was reused with different bytes; the whole batch was rejected. */
  idempotencyConflict: 'collector_idempotency_conflict',

  /** Site refused ingest. Labelled by reason (D-012/D-013/D-210) and `endpoint`. */
  ingestRefused: 'collector_ingest_refused',
  /** Origin outside the site's configured allowlist. Labelled by `endpoint`:
   * a misconfigured allowlist takes presence down as well as history, and only
   * this label distinguishes the two. */
  originRejected: 'collector_origin_rejected',

  /** Realtime write failed on the historical path. The event stays accepted. */
  realtimeDegraded: 'collector_realtime_degraded',
  /** Realtime write failed on the heartbeat path, which has no fallback. */
  heartbeatFailed: 'collector_heartbeat_failed',
  /** Presence recorded. */
  heartbeatAccepted: 'collector_heartbeat_accepted',

  /** Geo/UA enrichment produced nothing; the event is accepted regardless. */
  enrichmentDegraded: 'collector_enrichment_degraded',
  /** The near-realtime usage counter could not be updated after an enqueue. */
  usageCounterDegraded: 'collector_usage_counter_degraded',

  /** A tag sighting could not be recorded (ADR-0081, D2). The config response
   * was unaffected; what is lost is the dashboard's ability to say where the tag
   * loaded, on exactly the screen someone is watching because nothing else has
   * told them. Labelled by `site_id`. */
  tagSightingFailed: 'collector_tag_sighting_failed',
} as const

export type CollectorMetric = (typeof COLLECTOR_METRICS)[keyof typeof COLLECTOR_METRICS]
