import { randomUUID } from 'node:crypto'
import { healthResponseSchema } from '@openanalytics/contracts'
import {
  DEFAULT_TRACKER_SETTINGS,
  EMPTY_INGEST_EXCLUSIONS,
  compileIngestExclusions,
  loadPolicy,
  type SiteIngestConfig,
} from '@openanalytics/domain'
import { createLogger, createServiceMetadata, type Metrics } from '@openanalytics/observability'
import type { EnqueueInput, EventStreamQueue, RealtimeCache } from '@openanalytics/redis'
import { describe, expect, it } from 'vitest'
import {
  createApp,
  createFallbackLimiter,
  type CollectorDeps,
  type TrackerConfigRecord,
} from '../../apps/collector/src/index.ts'

/**
 * Public CORS on the ingest surface (ADR-0019 open item 2).
 *
 * The failure this pins was structural rather than intermittent: the collector
 * had no CORS middleware and no `OPTIONS` route at all. Because the tracker
 * deliberately sends a CORS *simple* request, the batch was received, validated
 * and enqueued — and then the browser discarded the response for want of an
 * `Access-Control-Allow-Origin` header, `fetch` rejected, and the tracker
 * requeued a batch that had in fact been delivered. Forever. Nothing on the
 * server could see it; only the browser knew.
 *
 * The policy is deliberately the opposite of the api's (`tests/unit/api-cors.test.ts`):
 * wildcard origin, and no `Access-Control-Allow-Credentials` ever. That pairing
 * is the whole safety argument — a browser rejects `*` together with
 * credentials, so the absence of the credentials header is what keeps the
 * wildcard legal, and the write-only tracking key (docs snapshot 01 §3.2) is
 * what makes a wide-open origin grant nothing.
 *
 * The doubles here are deliberately minimal: what is under test is response
 * headers and an `OPTIONS` answer, not ingest behaviour, which
 * `tests/unit/collector-ingest.test.ts` owns.
 */

const POLICY = loadPolicy({})
const NOW = new Date('2026-07-23T12:00:00.000Z')
const TRACKING_KEY = 'oa_pk_testkey_000000'
const PAGE_ORIGIN = 'https://shop.example.com'
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

function uuidV7(): string {
  const base = randomUUID()
  return `${base.slice(0, 14)}7${base.slice(15, 19)}${base.slice(19)}`.replace(
    /^(.{19})(.)/,
    (_all, head: string, variant: string) => `${head}${'89ab'.includes(variant) ? variant : '8'}`,
  )
}

const siteConfig: SiteIngestConfig = {
  siteId: 'site-1',
  status: 'active',
  ingestGeneration: 3,
  configVersion: 7,
  billingUserId: 'user-1',
  billingAssignmentVersion: 2,
  keyExpiresAt: null,
  allowedDomains: [],
}

const TRACKER_CONFIG: TrackerConfigRecord = {
  siteId: 'site-1',
  config: {
    config_version: 7,
    site_timezone: 'Asia/Baku',
    allowed_domains: ['shop.example.com'],
    redact_query_keys: [],
    interaction_sampling: 1,
    heartbeat_interval_seconds: 15,
    features: { web_vitals: true, engagement: true, interactions: true, heartbeat: true },
    attributed_revenue: false,
    no_code_rules: [],
  },
}

/** Enough of the ports to let one valid batch reach 202. */
const queue = {
  enqueueBatch: (inputs: readonly EnqueueInput[]) =>
    Promise.resolve({
      outcome: 'accepted' as const,
      results: inputs.map((input) => ({
        outcome: 'enqueued' as const,
        enqueued: true as const,
        streamId: '1-0',
        firstAcceptedAt: input.acceptedAt,
      })),
    }),
} as unknown as EventStreamQueue

const realtime = {
  chargeRateLimits: () => Promise.resolve({ ipSite: 1, identity: 1, site: 1, siteDaily: 1 }),
  readUsage: () => Promise.resolve({ billableUsed: 0, siteDailyBillable: 0 }),
  recordBillable: () => Promise.resolve(undefined),
  touchVisitor: () => Promise.resolve(undefined),
  countBot: () => Promise.resolve(undefined),
  // The config route records a tag sighting on every fetch (ADR-0081, D2), so a
  // CORS harness that omitted it would be exercising the recorder's failure
  // path rather than the header assertions it is here for.
  recordTagSighting: () => Promise.resolve(undefined),
} as unknown as RealtimeCache

function harness() {
  /** Counts store hits, so "the preflight reached no route" is an observation. */
  let configLookups = 0

  const ingest: CollectorDeps = {
    configStore: {
      resolve: (key: string) =>
        Promise.resolve(
          key === TRACKING_KEY
            ? {
                config: siteConfig,
                settings: DEFAULT_TRACKER_SETTINGS,
                slug: 'shop',
                noCodeRules: [],
                exclusions: compileIngestExclusions(EMPTY_INGEST_EXCLUSIONS),
              }
            : null,
        ),
      invalidate: () => undefined,
    },
    queue,
    realtime,
    policy: POLICY,
    identityKey: { keyVersion: 1, secret: 'identity-secret-for-tests-0000' },
    metrics: { increment: () => undefined } as unknown as Metrics,
    fallbackLimiter: createFallbackLimiter({ perMinute: 120, maxEntries: 100 }),
    now: () => NOW,
  }

  const service = createServiceMetadata({
    name: 'collector',
    version: '0.0.0',
    commit: 'test',
    environment: 'test',
  })

  const app = createApp({
    service,
    logger: createLogger({ service, sink: () => undefined }),
    env: { ...POLICY, PORT: 0 } as never,
    trackerConfigStore: {
      find: (key: string) => {
        configLookups += 1
        return Promise.resolve(key === TRACKING_KEY ? TRACKER_CONFIG : null)
      },
    },
    ingest,
  })

  return {
    app,
    configLookups: () => configLookups,
    postBatch: () =>
      app.request('/v1/events', {
        method: 'POST',
        headers: {
          // Exactly what the tracker sends: a CORS simple request with no
          // credentials of any kind.
          'content-type': 'text/plain;charset=UTF-8',
          'user-agent': CHROME,
          origin: PAGE_ORIGIN,
        },
        body: JSON.stringify({
          schema_version: 1,
          tracking_key: TRACKING_KEY,
          sent_at: NOW.toISOString(),
          context: { sdk: 'web', sdk_version: '2.0.0' },
          events: [
            {
              event_id: uuidV7(),
              type: 'page_view',
              occurred_at: NOW.toISOString(),
              page: { url: `${PAGE_ORIGIN}/pricing` },
            },
          ],
        }),
      }),
    getConfig: () =>
      app.request(`/v1/tracker/config?key=${TRACKING_KEY}`, { headers: { origin: PAGE_ORIGIN } }),
    preflight: (path: string, method: string, headers?: string) =>
      app.request(path, {
        method: 'OPTIONS',
        headers: {
          origin: PAGE_ORIGIN,
          'access-control-request-method': method,
          ...(headers === undefined ? {} : { 'access-control-request-headers': headers }),
        },
      }),
  }
}

describe('collector CORS', () => {
  it('answers an ingest POST with a wildcard origin and never Allow-Credentials', async () => {
    const h = harness()
    const response = await h.postBatch()

    // The batch was always accepted; what was missing was the browser's
    // permission to read the answer.
    expect(response.status).toBe(202)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    // Never sent, not even as `false`. Its absence is what makes `*` legal.
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('exposes ETag on the config response, so the tracker can cache conditionally', async () => {
    // `apps/tracker/src/config.ts` stores `response.headers.get('etag')` to drive
    // its `If-None-Match` request. `ETag` is not a CORS-safelisted response
    // header, so cross-origin it reads `null` unless it is named here — and the
    // 304 path can then never fire.
    const h = harness()
    const response = await h.getConfig()

    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe('"oa-site-1-7"')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect((response.headers.get('access-control-expose-headers') ?? '').toLowerCase()).toContain(
      'etag',
    )
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('answers a preflight without reaching a route handler and advertises if-none-match', async () => {
    const h = harness()
    // The config fetch preflights as soon as the tracker has a cached config,
    // because `If-None-Match` is not CORS-safelisted.
    const response = await h.preflight('/v1/tracker/config', 'GET', 'if-none-match')

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    // No route ran: `GET /v1/tracker/config` without a `key` is a 400, and its
    // store would have been consulted for a valid one. Neither happened.
    expect(h.configLookups()).toBe(0)

    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()

    const headers = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase()
    expect(headers).toContain('if-none-match')
    expect(headers).toContain('content-type')

    const methods = response.headers.get('access-control-allow-methods') ?? ''
    for (const method of ['GET', 'POST', 'OPTIONS']) expect(methods).toContain(method)

    expect(Number(response.headers.get('access-control-max-age'))).toBeGreaterThan(0)
  })

  it('answers a preflight for the ingest POST too, though the tracker never needs one', async () => {
    // The batch is a simple request by construction and does not preflight. A
    // caller that makes it non-simple (a proxy-injected header, a different
    // content type) must still get a usable answer rather than a 404 from the
    // POST-only route.
    const h = harness()
    const response = await h.preflight('/v1/events', 'POST', 'content-type')

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('leaves a bare OPTIONS to the router: it is not a preflight', async () => {
    // A preflight is an OPTIONS that names the method it is asking about.
    // Answering every OPTIONS would hide a genuinely unrouted request.
    const h = harness()
    const response = await h.app.request('/v1/events', {
      method: 'OPTIONS',
      headers: { origin: PAGE_ORIGIN },
    })

    expect(response.status).toBe(404)
  })

  it('leaves /health exactly as it was', async () => {
    // `/health` is an operator endpoint that no browser calls, so the middleware
    // is mounted after it on purpose. Its behaviour is unchanged, headers
    // included — which is also the check that the mounting order is what this
    // file claims.
    const h = harness()
    const response = await h.app.request('/health')

    expect(response.status).toBe(200)
    const body = healthResponseSchema.parse(await response.json())
    expect(body.service).toBe('collector')

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('access-control-expose-headers')).toBeNull()
  })
})
