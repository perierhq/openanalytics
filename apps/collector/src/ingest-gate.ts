import { ApiError } from '@openanalytics/contracts'
import {
  anonymousIdentityFor,
  classifyUserAgent,
  decideIngestAdmission,
  isOriginAllowed,
  utcCalendarDate,
  type BotVerdict,
  type SiteIngestConfig,
  type SiteTrackerSettings,
} from '@openanalytics/domain'
import type { ResolvedNoCodeRule } from '@openanalytics/postgres'
import type { Context } from 'hono'
import { readClientIdentity, readRawClientAddress, type ClientIdentity } from './client-identity.ts'
import type { CollectorDeps } from './deps.ts'
import { COLLECTOR_METRICS } from './metrics.ts'
import type { CloudIngestFacts } from './cloud-extension.ts'
import { countExclusions, noteGeoResolved, originHostname } from './exclusions.ts'

/**
 * The checks every ingest request passes before anything is written, in the
 * order docs snapshot 02 §7.1 puts them.
 *
 * Both routes share this because both must answer the same way to the same
 * situation: a revoked key, a blocked site, a foreign origin and a bot are not
 * different questions for a pageview and a heartbeat. The parts that differ —
 * the queue for one, the realtime write for the other — start after this.
 *
 * Order is not incidental:
 *
 * - The key resolves first, because nothing else is knowable without a site.
 * - Admission next (D-012/D-013/D-210), so a blocked or deleting site is refused
 *   before its counters are touched.
 * - Then the origin allowlist, which is cheap and site-scoped.
 * - Then the rate limits — charged for *all* traffic including bots, because an
 *   abuse ceiling that exempted anything claiming to be a crawler would be an
 *   abuse ceiling anyone could opt out of by editing a header.
 * - Bot classification, so a filtered request has already paid its share of
 *   the site's budget and cannot be used to flood one for free.
 * - Then `Sec-GPC`, and last the site's own exclusions — after the bot check,
 *   so a crawler from an excluded range is still counted as a crawler, and
 *   before anything is queued or written to realtime.
 */

export interface IngestGateContext {
  readonly config: SiteIngestConfig
  readonly settings: SiteTrackerSettings
  /** The site's published no-code rules, for establishing event origin (D5). */
  readonly noCodeRules: readonly ResolvedNoCodeRule[]
  readonly client: ClientIdentity
  readonly bot: BotVerdict
  /** Present only for a non-bot request; bots never reach identity derivation. */
  readonly userAgent: string | null
  /** When the request arrived. */
  readonly receivedAt: Date
  /** When validation completed. Usage bills at this clock (D-015). */
  readonly acceptedAt: Date
  /** True when accepted under the D-012 grace of a suspended site. Always false
   * without a registered surface that has such a window. */
  readonly grace: boolean
  /**
   * What the registered surface resolved beside the config, carried out of the
   * gate so the quota check does not resolve it a second time. Absent in every
   * self-hosted build.
   */
  readonly cloud?: CloudIngestFacts
  /** True when the limiter store did not answer and G-005's ladder applied. */
  readonly limiterDegraded: boolean
  /**
   * Per unit, parallel to `GateInput.pages`: true when the site's exclusions
   * drop it. May be all true. Not an exception like `BotRequest`, because an
   * excluded unit must be answered exactly as a counted one — the events route
   * still runs it through the dedup record, the quota check and the queue's
   * availability, and only leaves out what would store or show it.
   */
  readonly excluded: readonly boolean[]
}

export class BotRequest extends Error {
  readonly verdict: BotVerdict

  constructor(verdict: BotVerdict) {
    super('bot traffic')
    this.name = 'BotRequest'
    this.verdict = verdict
  }
}

/**
 * The visitor's browser attached `Sec-GPC: 1` to the request itself.
 *
 * GPC ships in two forms: the DOM property the tracker reads client-side, and
 * this HTTP header. The client-side gate can be switched off by a site's
 * `data-respect-gpc="false"` attribute, served stale from a cached bundle, or
 * absent entirely in a non-official SDK — and in every one of those cases the
 * visitor's objection still arrives here, on the request. Honouring it
 * server-side is the backstop no site configuration can bypass (G-008,
 * ADR-0057 D5). Like a bot, this is not an error: each route answers its
 * ordinary success shape so nothing distinguishes a dropped batch.
 */
export class GpcOptOut extends Error {
  constructor() {
    super('visitor sent Sec-GPC')
    this.name = 'GpcOptOut'
  }
}

/**
 * Which ingest path a gate refusal happened on (ADR-0035, D9).
 *
 * Two values, forever: the gate has exactly two callers. It exists because a
 * refusal here is *silent* on both paths by design — a bot gets the same answer
 * as an accepted request so a crawler learns nothing from the difference, and a
 * disallowed origin gets a 403 the tracker treats as final — and because the
 * request metric's `route` label is the collector middleware's own mount (`/*`)
 * rather than the matched path. So a dropped heartbeat and a dropped batch were
 * one series, and "presence stopped updating" had no series that could say why.
 */
export type IngestEndpoint = 'events' | 'heartbeat'

export interface GateInput {
  readonly trackingKey: string
  /** Events in this request, for charging the rate limits by weight. */
  readonly cost: number
  readonly receivedAt: Date
  /** Which route is asking. Two values; see `IngestEndpoint`. */
  readonly endpoint: IngestEndpoint
  /**
   * The page URL of each unit the request carries — every event of a batch,
   * or the heartbeat's one page — `null` for a unit with no page. What the
   * site's path and hostname exclusions are matched against.
   */
  readonly pages: readonly (string | null)[]
}

/**
 * Resolve, admit, check origin, charge limits and classify.
 *
 * Throws `ApiError` for every refusal — the shared error handler turns it into
 * the canonical envelope — and `BotRequest` for filtered traffic, which is not
 * an error and gets a route-specific success answer.
 */
export async function passIngestGate(
  c: Context,
  deps: CollectorDeps,
  limiterCheck: (input: {
    siteId: string
    ipHash: string
    identityHash: string
    cost: number
    at: Date
  }) => Promise<
    | { limited: false; degraded: boolean }
    | { limited: true; scope: string; retryAfterSeconds: number; degraded: boolean }
  >,
  input: GateInput,
): Promise<IngestGateContext> {
  const resolved = await deps.configStore.resolve(input.trackingKey)
  if (resolved === null) {
    throw new ApiError('SITE_NOT_FOUND', 'No site matches this tracking key.')
  }

  const { config, settings, noCodeRules } = resolved
  const acceptedAt = deps.now?.() ?? new Date()

  /**
   * The product verdict, then the one refusal a registered surface may overrule.
   *
   * `decideIngestAdmission`'s own `onSuspended` hook is deliberately not used
   * here: the facts the hosted verdict needs were resolved with the config, so
   * the collector has them in hand, and reaching for the hook would put an
   * extension-shaped closure inside a pure function for no gain. Only the
   * `suspended` refusal is negotiable — an expired key and a deleting site are
   * `SITE_NOT_FOUND` in every build.
   */
  let admission = decideIngestAdmission({ config, now: acceptedAt })
  if (
    !admission.admitted &&
    admission.reason === 'site_suspended' &&
    deps.cloud &&
    resolved.cloud
  ) {
    admission = deps.cloud.admitSuspended({ config, facts: resolved.cloud, now: acceptedAt })
  }
  if (!admission.admitted) {
    deps.metrics.increment(COLLECTOR_METRICS.ingestRefused, {
      site_id: config.siteId,
      endpoint: input.endpoint,
      reason: admission.reason,
    })
    throw new ApiError(
      admission.code,
      // A refusal this module does not own the wording of carries its own; the
      // product's two both mean "there is no such site here".
      admission.message ?? 'No site matches this tracking key.',
      { details: { reason: admission.reason } },
    )
  }

  const origin = c.req.header('origin') ?? null
  if (!isOriginAllowed(origin, config.allowedDomains)) {
    deps.metrics.increment(COLLECTOR_METRICS.originRejected, {
      site_id: config.siteId,
      endpoint: input.endpoint,
    })
    // 403 rather than 429: a foreign origin will still be foreign on the next
    // attempt, and the tracker treats a non-429 4xx as final (ADR-0008).
    throw new ApiError('FORBIDDEN', 'This origin is not allowed to send events for this site.', {
      details: { reason: 'origin_not_allowed' },
    })
  }

  const utcDate = utcCalendarDate(acceptedAt)
  const identityOptions = {
    secret: deps.identityKey.secret,
    keyVersion: deps.identityKey.keyVersion,
    utcDate,
  }
  const client = readClientIdentity(c, identityOptions, deps.geo)
  // Only a country this collector's own database resolved: a header country
  // may have been written by the visitor (see `ClientIdentity.countrySource`).
  if (client.countrySource === 'database') noteGeoResolved(deps, acceptedAt)
  if (client.degraded) {
    deps.metrics.increment(COLLECTOR_METRICS.enrichmentDegraded, {
      site_id: config.siteId,
      endpoint: input.endpoint,
    })
  }

  const userAgent = c.req.header('user-agent') ?? null

  // The limiter's identity bucket, not the analytics identity: it is keyed on
  // the acceptance date rather than each event's validated `occurred_at`,
  // because a request is rate-limited as a whole and a batch may legitimately
  // span two UTC days.
  const rawAddress = readRawClientAddress(c)
  const identityHash = anonymousIdentityFor({
    ip: rawAddress ?? 'unknown',
    userAgent,
    siteId: config.siteId,
    occurredAt: acceptedAt,
    key: deps.identityKey,
  }).anonymousId.slice(0, 32)

  const limit = await limiterCheck({
    siteId: config.siteId,
    ipHash: client.ipHash,
    identityHash,
    cost: input.cost,
    at: acceptedAt,
  })

  if (limit.limited) {
    // G-005 says "429 + Retry-After", and means the header: throttling is a
    // delay rather than a loss only if the tracker is told how long to wait.
    // For the daily ceiling that is the time to UTC midnight, when the counter
    // resets — a tracker that retried sooner would spend a visitor's battery
    // failing.
    c.header('Retry-After', String(limit.retryAfterSeconds))
    throw new ApiError('RATE_LIMITED', 'Too many events. Retry after the indicated delay.', {
      details: { reason: limit.scope, retry_after_seconds: limit.retryAfterSeconds },
    })
  }

  const bot = classifyUserAgent(userAgent)
  if (bot.bot) {
    deps.metrics.increment(COLLECTOR_METRICS.botFiltered, {
      site_id: config.siteId,
      endpoint: input.endpoint,
      signature: bot.signature ?? 'unknown',
    })
    // Aggregate-only, and never allowed to fail the request: a security counter
    // that could 500 a request would be a denial-of-service surface of its own.
    void deps.realtime
      .countBot({
        siteId: config.siteId,
        signature: bot.signature ?? 'unknown',
        at: acceptedAt,
        cost: input.cost,
      })
      .catch(() => undefined)
    throw new BotRequest(bot)
  }

  // After the limits for the same reason bots are: a request dropped for GPC
  // has still paid its share of the site's abuse budget. The spec value is
  // exactly `1`; any other value is not a GPC assertion.
  if (c.req.header('sec-gpc') === '1') {
    deps.metrics.increment(COLLECTOR_METRICS.gpcFiltered, {
      site_id: config.siteId,
      endpoint: input.endpoint,
    })
    throw new GpcOptOut()
  }

  // The site's own exclusions (server-side; independent of the tracker's
  // `#oa-ignore`). The raw address is the one the limiter bucket above was
  // derived from, read in memory and dropped with this frame.
  const excluded = input.pages.map(() => false)
  const exclusions = resolved.exclusions
  if (!exclusions.empty) {
    const fallbackHostname = originHostname(origin)
    const reasons = input.pages.map((url) =>
      exclusions.reasonFor({ ip: rawAddress, country: client.country, url, fallbackHostname }),
    )
    reasons.forEach((reason, index) => {
      excluded[index] = reason !== null
    })
    countExclusions(deps, { siteId: config.siteId, endpoint: input.endpoint, reasons })
  }

  return {
    config,
    settings,
    // Carried out of the gate rather than re-resolved: establishing an event's
    // `no_code_rule` origin (ADR-0034, D5) needs the site's published rules, and
    // the gate has already paid for them in the same cached lookup that
    // authorised the batch.
    noCodeRules,
    client,
    bot,
    userAgent,
    receivedAt: input.receivedAt,
    acceptedAt,
    grace: admission.mode === 'grace',
    ...(resolved.cloud ? { cloud: resolved.cloud } : {}),
    limiterDegraded: limit.degraded,
    excluded,
  }
}
