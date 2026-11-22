import { ApiError, heartbeatRequestSchema, type HeartbeatRequest } from '@openanalytics/contracts'
import { deriveVisitorContext } from '@openanalytics/domain'
import { Hono } from 'hono'
import { readIngestBody } from './body.ts'
import { readRawClientAddress } from './client-identity.ts'
import type { CollectorDeps } from './deps.ts'
import { BotRequest, GpcOptOut, passIngestGate } from './ingest-gate.ts'
import type { IngestLimiter } from './limiter.ts'
import { COLLECTOR_METRICS } from './metrics.ts'
import { presencePageFrom } from './presence.ts'

/**
 * `POST /v1/realtime/heartbeat` — presence, and nothing else.
 *
 * Docs snapshot 02 §7.2 and D-101: a heartbeat writes realtime state only. It
 * never reaches the durable queue, ClickHouse or usage, and its usage weight is
 * zero.
 *
 * The rule that makes it different from every other failure in this service:
 * **a failed heartbeat is never downgraded into a historical event.** The queue
 * is not a fallback here. A heartbeat carries no `event_id` — nothing
 * deduplicates a presence ping — so queueing one would create a row that could
 * never be recognised as a retry, and would claim a durability guarantee the
 * realtime path does not make. The honest answer is `503`, a degradation metric,
 * and the tracker sending the next interval's heartbeat (ADR-0008: a heartbeat
 * is not retried; the next interval *is* the retry).
 */

function parseHeartbeat(json: unknown): HeartbeatRequest {
  const parsed = heartbeatRequestSchema.safeParse(json)
  if (parsed.success) return parsed.data

  const first = parsed.error.issues[0]
  throw new ApiError('VALIDATION_FAILED', 'The heartbeat is not valid.', {
    details: {
      reason: 'schema',
      path: first?.path.join('.') ?? '',
      issue: first?.message ?? 'invalid',
    },
  })
}

export function createHeartbeatRoutes(deps: CollectorDeps, limiter: IngestLimiter) {
  const routes = new Hono()

  routes.post('/heartbeat', async (c) => {
    const receivedAt = deps.now?.() ?? new Date()
    const body = await readIngestBody(c)
    const heartbeat = parseHeartbeat(body.json)

    let gate
    try {
      gate = await passIngestGate(c, deps, (input) => limiter.check(input), {
        trackingKey: heartbeat.tracking_key,
        // One presence signal. A heartbeat is not a batch and never carries
        // more than the visitor it is about.
        cost: 1,
        receivedAt,
        endpoint: 'heartbeat',
        pages: [heartbeat.page?.url ?? null],
      })
    } catch (error) {
      // A bot's presence is not presence, and a GPC visitor asked not to be
      // present (ADR-0057 D5). Answered 204 like any other accepted heartbeat
      // so the caller learns nothing from the difference.
      if (error instanceof BotRequest || error instanceof GpcOptOut) return c.body(null, 204)
      throw error
    }

    // A visitor the site excluded is not counted in realtime any more than in
    // history, and gets the 204 a counted heartbeat gets. One difference is
    // left, and `exclusions.ts` names it: with the realtime store down, a
    // counted heartbeat is a 503 and an excluded one is still a 204.
    if (gate.excluded[0] === true) return c.body(null, 204)

    const visitor = deriveVisitorContext({
      ip: readRawClientAddress(c) ?? 'unknown',
      userAgent: gate.userAgent,
      siteId: gate.config.siteId,
      occurredAt: gate.acceptedAt,
      key: deps.identityKey,
    })

    // The heartbeat carries an optional page (docs snapshot 02 §17); it is
    // sanitized through the same helper the historical path uses, so the realtime
    // store never sees a raw URL or a sensitive query key.
    const page = presencePageFrom(heartbeat.page, gate.settings.redactQueryKeys)

    try {
      // Same geo and UA sources as the historical path (ADR-0024), so a visitor
      // kept alive by heartbeats alone still carries every snapshot breakdown.
      await deps.realtime.touchVisitor({
        siteId: gate.config.siteId,
        visitorId: visitor.anonymousId,
        at: gate.acceptedAt,
        country: gate.client.country ?? null,
        city: gate.client.city ?? null,
        deviceType: visitor.deviceType,
        browser: visitor.browser,
        os: visitor.os,
        ...(page ? { page } : {}),
      })
    } catch (error) {
      deps.metrics.increment(COLLECTOR_METRICS.heartbeatFailed, {
        site_id: gate.config.siteId,
        endpoint: 'heartbeat',
      })
      throw new ApiError('SERVICE_UNAVAILABLE', 'Realtime state is unavailable.', {
        details: { reason: 'realtime_unavailable' },
        cause: error,
      })
    }

    deps.metrics.increment(COLLECTOR_METRICS.heartbeatAccepted, {
      site_id: gate.config.siteId,
      endpoint: 'heartbeat',
    })

    // 204 only after the realtime write succeeded (§7.1 item 15) — the same rule
    // the 202 obeys, applied to the only store this path has.
    return c.body(null, 204)
  })

  return routes
}
