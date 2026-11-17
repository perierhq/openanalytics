import { randomUUID } from 'node:crypto'
import {
  createApp,
  createFallbackLimiter,
  type CollectorDeps,
} from '../../apps/collector/src/index.ts'
import { persistedEventSchema } from '@openanalytics/contracts'
import {
  DEFAULT_TRACKER_SETTINGS,
  EMPTY_INGEST_EXCLUSIONS,
  compileIngestExclusions,
  loadPolicy,
  usageWindowFor,
  type CompiledIngestExclusions,
  type SiteIngestConfig,
} from '@openanalytics/domain'
import {
  createLogger,
  createRecordingMetrics,
  createServiceMetadata,
} from '@openanalytics/observability'
import {
  createEventStreamQueue,
  createQueueClient,
  createRealtimeCache,
  decodeSiteQueueIndexEntry,
  dedupKey,
  encodeSiteQueueIndexEntry,
  excludedRecordKey,
  realtimeUpdatesChannel,
  siteQueueIndexKey,
  visitorMetaKey,
  visitorPagesKey,
  type EnqueueBatchResult,
  type EnqueueAccepted,
} from '@openanalytics/redis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Milestone 5 against a real Valkey.
 *
 * The unit suite proves the collector's decisions with doubles. This proves the
 * three claims a double cannot make, because they are claims about Valkey rather
 * than about our TypeScript:
 *
 * 1. **Concurrent identical events produce exactly one stream row.** A double
 *    that "deduplicates" only proves the double deduplicates. What is in
 *    question is whether the EVAL is genuinely uninterruptible.
 * 2. **A conflict leaves nothing enqueued.** The all-or-nothing rule is a
 *    property of the script's two passes, and only the server can demonstrate
 *    that the first pass really precedes every write.
 * 3. **The dedup record, the stream entry and the site queue index move
 *    together.** ADR-0004's atomicity claim in the shape M5 actually uses it.
 *
 * Skips without `TEST_VALKEY_URL`, like the M1 live suites: CI supplies a
 * service container, and a contributor without one still runs everything else.
 * Each run works inside its own stream and key prefix, so repeated runs and
 * parallel CI jobs cannot interfere.
 */

const VALKEY_URL = process.env['TEST_VALKEY_URL']
const daysInSeconds = (days: number): number => days * 24 * 60 * 60
const describeIfValkey = VALKEY_URL ? describe : describe.skip

const POLICY = loadPolicy({})
const TRACKING_KEY = 'oa_pk_live_testkey_00'
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

function uuidV7(): string {
  const hex = randomUUID().replace(/-/g, '')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `7${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

describeIfValkey('M5 collector against a live Valkey', () => {
  const streamKey = `m5_test_stream:${randomUUID()}`
  const keyPrefix = `m5_test:${randomUUID()}:`

  let client: ReturnType<typeof createQueueClient>
  let siteId: string
  let deps: CollectorDeps
  let app: ReturnType<typeof createApp>
  let metrics: ReturnType<typeof createRecordingMetrics>
  let now: Date
  /** What the real script answered, batch by batch: the stream ids the HTTP
   * response does not carry. */
  let scriptAnswers: EnqueueBatchResult[]
  let resolved: {
    config: SiteIngestConfig
    settings: typeof DEFAULT_TRACKER_SETTINGS
    slug: string
    noCodeRules: readonly never[]
    exclusions: CompiledIngestExclusions
  }

  const config = (): SiteIngestConfig => ({
    siteId,
    status: 'active',
    ingestGeneration: 1,
    configVersion: 1,
    billingUserId: `user-${randomUUID().replace(/-/g, '')}`.slice(0, 40),
    billingAssignmentVersion: 1,
    keyExpiresAt: null,
    allowedDomains: [],
  })

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'user-agent': CHROME, ...headers },
      body: JSON.stringify(body),
    })

  const pageView = (overrides: Record<string, unknown> = {}) => ({
    event_id: uuidV7(),
    type: 'page_view' as const,
    occurred_at: now.toISOString(),
    page: { url: 'https://shop.example.com/pricing' },
    ...overrides,
  })

  const batchOf = (events: unknown[]) => ({
    schema_version: 1,
    tracking_key: TRACKING_KEY,
    sent_at: now.toISOString(),
    context: { sdk: 'web', sdk_version: '2.0.0' },
    events,
  })

  const streamLength = async (): Promise<number> => client.xlen(streamKey)

  beforeAll(() => {
    // `worker` mode, deliberately, for a loopback service container: the modes
    // select *transport* rules, and `collector` requires TLS and AUTH because
    // that hop crosses the public internet (D-206) — which a container on
    // localhost is not. The requirement itself is asserted in
    // `tests/unit/event-stream-queue.test.ts` and exercised for real against the
    // deployed instance by the M1 live suite. What is under test here is the
    // script's behaviour, which is identical on either transport.
    client = createQueueClient({
      mode: 'worker',
      url: VALKEY_URL as string,
      connectionName: 'm5-collector-test',
    })
  })

  beforeEach(() => {
    now = new Date()
    // A fresh site per test, so dedup records from one case cannot answer
    // another and each assertion counts only its own rows.
    siteId = `site-${randomUUID().replace(/-/g, '')}`.slice(0, 40)
    metrics = createRecordingMetrics()
    resolved = {
      config: config(),
      settings: DEFAULT_TRACKER_SETTINGS,
      slug: 'shop',
      noCodeRules: [],
      exclusions: compileIngestExclusions(EMPTY_INGEST_EXCLUSIONS),
    }

    const queue = createEventStreamQueue({ client, policy: POLICY, streamKey })
    scriptAnswers = []

    deps = {
      configStore: {
        resolve: async (key: string) => (key === TRACKING_KEY ? resolved : null),
        invalidate: () => undefined,
      },
      queue: {
        enqueue: (input) => queue.enqueue(input),
        enqueueBatch: async (inputs) => {
          const answer = await queue.enqueueBatch(inputs)
          scriptAnswers.push(answer)
          return answer
        },
      },
      realtime: createRealtimeCache({
        client,
        eventMaxLatenessHours: POLICY.EVENT_MAX_LATENESS_HOURS,
        keyPrefix,
      }),
      policy: POLICY,
      identityKey: { keyVersion: 1, secret: 'live-identity-secret-000000' },
      metrics,
      fallbackLimiter: createFallbackLimiter({ perMinute: 120, maxEntries: 100 }),
      now: () => now,
    }

    const service = createServiceMetadata({
      name: 'collector',
      version: '0.0.0',
      commit: 'test',
      environment: 'test',
    })
    app = createApp({
      service,
      logger: createLogger({ service, sink: () => undefined }),
      env: { ...POLICY, PORT: 0 } as never,
      ingest: deps,
    })
  })

  afterAll(async () => {
    await client?.del(streamKey)
    const keys = await client?.keys(`${keyPrefix}*`)
    if (keys && keys.length > 0) await client.del(...keys)
    await client?.quit()
  })

  it('durably enqueues an accepted batch', async () => {
    const before = await streamLength()

    const response = await post('/v1/events', batchOf([pageView(), pageView()]))

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ accepted: 2, duplicate: 0 })
    expect(await streamLength()).toBe(before + 2)
  })

  it('writes a payload the persisted envelope accepts', async () => {
    await post('/v1/events', batchOf([pageView()]))

    const entries = await client.xrevrange(streamKey, '+', '-', 'COUNT', 1)
    const fields = entries[0]?.[1] ?? []
    const payloadIndex = fields.indexOf('payload')
    const payload: unknown = JSON.parse(fields[payloadIndex + 1] ?? '{}')

    expect(() => persistedEventSchema.parse(payload)).not.toThrow()
  })

  it('writes a canonical, external-only referrer into the durable payload (ADR-0028)', async () => {
    // The value that reaches the queue is the value ClickHouse and every rollup
    // built on it will hold, so the two rules are proven where they are durable
    // rather than only where they are computed.
    await post(
      '/v1/events',
      batchOf([
        pageView({ referrer: 'https://WWW.Google.com:443/search/abc?q=x#top' }),
        pageView({
          page: { url: 'https://shop.example.com/checkout' },
          referrer: 'https://shop.example.com/pricing',
        }),
      ]),
    )

    const entries = await client.xrevrange(streamKey, '+', '-', 'COUNT', 2)
    const sources = entries.map((entry) => {
      const fields = entry[1] ?? []
      const payload = persistedEventSchema.parse(
        JSON.parse(fields[fields.indexOf('payload') + 1] ?? '{}'),
      )
      return payload.source.referrer_domain
    })

    // Newest first: the self-referral is null, the search engine is one domain
    // whatever spelling arrived.
    expect(sources).toEqual([null, 'google.com'])
  })

  it('answers a retried excluded event as a duplicate and a changed one with 409', async () => {
    // The real script, not the double: an excluded event is remembered for the
    // dedup window as a payload hash and a time, so the answers match the
    // counted path's — and nothing of it reaches the stream.
    resolved = {
      ...resolved,
      exclusions: compileIngestExclusions({ ...EMPTY_INGEST_EXCLUSIONS, paths: ['/admin/*'] }),
    }
    const hidden = pageView({ page: { url: 'https://shop.example.com/admin/very-private' } })
    const kept = pageView()
    const before = await streamLength()

    const first = await post('/v1/events', batchOf([hidden, kept]))
    expect(await first.json()).toEqual({ accepted: 2, duplicate: 0 })
    const again = await post('/v1/events', batchOf([hidden, kept]))
    expect(await again.json()).toEqual({ accepted: 0, duplicate: 2 })
    expect(await streamLength()).toBe(before + 1)

    const changed = { ...hidden, page: { url: 'https://shop.example.com/admin/other' } }
    const conflict = await post('/v1/events', batchOf([changed]))
    expect(conflict.status).toBe(409)
    expect(await streamLength()).toBe(before + 1)

    const key = excludedRecordKey(siteId, hidden.event_id)
    const record = await client.hgetall(key)
    expect(Object.keys(record).sort()).toEqual(['accepted_at', 'payload_hash'])
    expect(JSON.stringify(record)).not.toContain('very-private')
    const ttl = await client.ttl(key)
    expect(ttl).toBeGreaterThan(daysInSeconds(POLICY.INGEST_DEDUP_TTL_DAYS) - 60)
    expect(ttl).toBeLessThanOrEqual(daysInSeconds(POLICY.INGEST_DEDUP_TTL_DAYS))
    await client.del(key)
  })

  it('answers a fully excluded batch sent twice like a counted one', async () => {
    resolved = {
      ...resolved,
      exclusions: compileIngestExclusions({
        ...EMPTY_INGEST_EXCLUSIONS,
        ipRanges: ['203.0.113.0/24'],
      }),
    }
    const event = pageView()
    const before = await streamLength()
    const office = { 'x-real-ip': '203.0.113.7' }

    const first = await post('/v1/events', batchOf([event]), office)
    expect(await first.json()).toEqual({ accepted: 1, duplicate: 0 })
    const again = await post('/v1/events', batchOf([event]), office)
    expect(await again.json()).toEqual({ accepted: 0, duplicate: 1 })
    expect(await streamLength()).toBe(before)

    const key = excludedRecordKey(siteId, event.event_id)
    expect(JSON.stringify(await client.hgetall(key))).not.toContain('203.0.113')
    await client.del(key)
  })

  describe('an exclusion changed between a delivery and its retry', () => {
    const ADMIN_RULES = { ...EMPTY_INGEST_EXCLUSIONS, paths: ['/admin/*'] }
    const adminPage = () => pageView({ page: { url: 'https://shop.example.com/admin/users/7' } })

    /** The script's answer for the only event of the latest batch. */
    const lastAnswer = (): EnqueueAccepted => {
      const batch = scriptAnswers.at(-1)
      if (batch?.outcome !== 'accepted') throw new Error('expected an accepted batch')
      const [only] = batch.results
      if (!only || only.outcome === 'idempotency_conflict') throw new Error('expected one result')
      return only
    }

    it('answers a counted event retried after an exclusion was added as its duplicate', async () => {
      const event = adminPage()
      const before = await streamLength()

      await post('/v1/events', batchOf([event]))
      const first = lastAnswer()
      expect(first.outcome).toBe('enqueued')
      expect(await streamLength()).toBe(before + 1)

      // The exclusion lands between the delivery and the retry: the retry is
      // handed to the script as excluded, and must still find the counted
      // record — same payload hash, so a duplicate rather than a 409.
      resolved = { ...resolved, exclusions: compileIngestExclusions(ADMIN_RULES) }
      const retry = await post('/v1/events', batchOf([event]))

      expect(await retry.json()).toEqual({ accepted: 0, duplicate: 1 })
      const again = lastAnswer()
      expect(again.outcome).toBe('duplicate')
      expect(first.streamId).toMatch(/^\d+-\d+$/)
      expect(again.streamId).toBe(first.streamId)
      expect(await streamLength()).toBe(before + 1)
      // Nothing was remembered as excluded for an event already counted.
      expect(await client.exists(excludedRecordKey(siteId, event.event_id))).toBe(0)
    })

    it('answers an excluded event retried after the exclusion was removed as its duplicate', async () => {
      resolved = { ...resolved, exclusions: compileIngestExclusions(ADMIN_RULES) }
      const event = adminPage()
      const before = await streamLength()

      await post('/v1/events', batchOf([event]))
      expect(lastAnswer().outcome).toBe('excluded')

      // The exclusion is removed before the retry: the retry is handed to the
      // script as counted, and must find the excluded record and stop there.
      resolved = { ...resolved, exclusions: compileIngestExclusions(EMPTY_INGEST_EXCLUSIONS) }
      const retry = await post('/v1/events', batchOf([event]))

      expect(await retry.json()).toEqual({ accepted: 0, duplicate: 1 })
      const again = lastAnswer()
      expect(again.outcome).toBe('duplicate')
      expect(again.streamId).toBe('')
      // No XADD: the stream did not grow and no counted record was written.
      expect(await streamLength()).toBe(before)
      expect(await client.exists(dedupKey(siteId, event.event_id))).toBe(0)
      await client.del(excludedRecordKey(siteId, event.event_id))
    })
  })

  it('creates exactly one stream row for 25 concurrent identical events', async () => {
    // The M1 gate bullet, at the HTTP layer. 25 requests, one event id: the
    // window a client-side check-then-append leaves open is exactly the one a
    // tracker retry storm finds.
    const event = pageView()
    const before = await streamLength()

    const responses = await Promise.all(
      Array.from({ length: 25 }, () => post('/v1/events', batchOf([event]))),
    )

    expect(responses.every((response) => response.status === 202)).toBe(true)
    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<{ accepted: number }>),
    )
    // Exactly one request created the row; the other 24 recognised it.
    expect(bodies.filter((body) => body.accepted === 1)).toHaveLength(1)
    expect(await streamLength()).toBe(before + 1)

    // The stream is what gets billed and inserted, so it is asserted separately
    // from the return values: they could all agree while the stream held 25.
    const record = await client.hgetall(dedupKey(siteId, event.event_id))
    expect(record['stream_id']).toBeTruthy()
  })

  it('answers 202 for a retry across separate requests without a second row', async () => {
    const event = pageView()
    const before = await streamLength()

    const first = await post('/v1/events', batchOf([event]))
    const second = await post('/v1/events', batchOf([event]))

    expect(await first.json()).toEqual({ accepted: 1, duplicate: 0 })
    expect(await second.json()).toEqual({ accepted: 0, duplicate: 1 })
    expect(await streamLength()).toBe(before + 1)
  })

  it('enqueues nothing from a batch containing an idempotency conflict', async () => {
    // §7.3, and the reason the enqueue script reads every dedup record before it
    // writes any of them: the valid events *before* the conflicting one must not
    // reach the stream.
    const original = pageView()
    await post('/v1/events', batchOf([original]))

    const before = await streamLength()
    const conflicting = { ...original, page: { url: 'https://shop.example.com/changed' } }
    const response = await post('/v1/events', batchOf([pageView(), pageView(), conflicting]))

    expect(response.status).toBe(409)
    expect(await streamLength()).toBe(before)
  })

  it('moves the dedup record, the stream entry and the site index together', async () => {
    // ADR-0004's atomicity claim in the shape M5 uses it. A stream entry without
    // a dedup record is re-enqueued forever; a dedup record without a stream
    // entry answers 202 for an event nobody stored.
    const event = pageView()
    await post('/v1/events', batchOf([event]))

    const record = await client.hgetall(dedupKey(siteId, event.event_id))
    const streamId = record['stream_id']
    expect(streamId).toBeTruthy()

    const indexKey = siteQueueIndexKey(siteId, now.toISOString().slice(0, 10))
    // Both ids: deletion has to reach the dedup record too, and
    // `ingest_dedup:{site}:{event}` cannot be derived from a stream id.
    const bucket = await client.lrange(indexKey, 0, -1)
    expect(bucket).toContain(encodeSiteQueueIndexEntry(streamId as string, event.event_id))
    const decoded = bucket.map(decodeSiteQueueIndexEntry)
    expect(decoded).toContainEqual({ streamId, eventId: event.event_id })
    // Every dedup key the bucket names is reachable from it alone. No entry can
    // decline to name one since 2026-08-06: the ADR-0021 legacy id-only form is
    // gone (ADR-0030 follow-up 2), so `decoded` either carries both ids or the
    // map above has already thrown.
    for (const entry of decoded) {
      expect(await client.exists(dedupKey(siteId, entry.eventId))).toBe(1)
    }

    const entry = await client.xrange(streamKey, streamId as string, streamId as string)
    expect(entry).toHaveLength(1)

    // Both TTLs come from policy, and the index must outlive the payloads it
    // indexes or deletion cannot prove it removed everything (D-209/D-210).
    const dedupTtl = await client.ttl(dedupKey(siteId, event.event_id))
    const indexTtl = await client.ttl(indexKey)
    expect(dedupTtl).toBeGreaterThan(0)
    expect(dedupTtl).toBeLessThanOrEqual(POLICY.INGEST_DEDUP_TTL_DAYS * 86_400)
    expect(indexTtl).toBeGreaterThan(dedupTtl)
  })

  it('refreshes the day bucket TTL on every append, not only when it opens', async () => {
    // The bucket has to outlive every payload and dedup record it names. Pinned
    // to its creation time, a bucket opened at 00:01 expires while the records
    // appended at 23:59 — each carrying a fresh full-length TTL — are still
    // there, and deletion would walk a bucket that no longer names them.
    const first = pageView()
    await post('/v1/events', batchOf([first]))
    const indexKey = siteQueueIndexKey(siteId, now.toISOString().slice(0, 10))

    // Stand in for a bucket that has been alive most of its life already.
    await client.expire(indexKey, 60)
    expect(await client.ttl(indexKey)).toBeLessThanOrEqual(60)

    await post('/v1/events', batchOf([pageView()]))

    const refreshed = await client.ttl(indexKey)
    expect(refreshed).toBeGreaterThan(60)
    expect(refreshed).toBeLessThanOrEqual(POLICY.SITE_QUEUE_INDEX_TTL_DAYS * 86_400)
    // …and the entry that prompted the refresh is in it.
    expect((await client.lrange(indexKey, 0, -1)).length).toBeGreaterThanOrEqual(2)
  })

  it('keeps accepting while nothing consumes the stream, and the backlog grows', async () => {
    // The plan's first acceptance criterion: "with ClickHouse down the collector
    // keeps accepting and the backlog grows." Nothing here reads the stream —
    // that is the worker, which does not exist yet — so an unconsumed stream is
    // exactly the state a ClickHouse outage produces.
    const before = await streamLength()

    for (let round = 0; round < 5; round += 1) {
      const response = await post('/v1/events', batchOf([pageView(), pageView()]))
      expect(response.status).toBe(202)
    }

    expect(await streamLength()).toBe(before + 10)
  })

  it('does not corrupt an accepted event when the realtime write fails', async () => {
    // The realtime half runs against a deliberately broken cache; the queue half
    // is the same live Valkey. §7.2: a realtime outage must not lose an accepted
    // historical event.
    const service = createServiceMetadata({
      name: 'collector',
      version: '0.0.0',
      commit: 'test',
      environment: 'test',
    })
    const brokenApp = createApp({
      service,
      logger: createLogger({ service, sink: () => undefined }),
      env: { ...POLICY, PORT: 0 } as never,
      ingest: {
        ...deps,
        realtime: {
          ...deps.realtime,
          touchVisitor: () => Promise.reject(new Error('realtime down')),
          recordBillable: () => Promise.reject(new Error('realtime down')),
        },
      },
    })

    const before = await streamLength()
    const response = await brokenApp.request('/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'user-agent': CHROME },
      body: JSON.stringify(batchOf([pageView()])),
    })

    expect(response.status).toBe(202)
    expect(await streamLength()).toBe(before + 1)
    expect(metrics.countOf('collector_realtime_degraded')).toBe(1)
  })

  it('never answers 202 when the queue is unreachable', async () => {
    // The one failure this whole milestone exists to make impossible.
    const unreachable = createQueueClient({
      mode: 'worker',
      // A port nothing listens on, with a short timeout so the test is quick.
      url: (VALKEY_URL as string).replace(/:\d+/, ':6399'),
      connectTimeoutMs: 300,
      commandTimeoutMs: 300,
      lazyConnect: true,
      // Fail the command rather than parking it in the offline queue — which is
      // what the collector configures in production, and the difference between
      // a 503 the tracker retries and a request that hangs until the platform
      // kills it.
      enableOfflineQueue: false,
    })
    const service = createServiceMetadata({
      name: 'collector',
      version: '0.0.0',
      commit: 'test',
      environment: 'test',
    })
    const brokenApp = createApp({
      service,
      logger: createLogger({ service, sink: () => undefined }),
      env: { ...POLICY, PORT: 0 } as never,
      ingest: {
        ...deps,
        queue: createEventStreamQueue({ client: unreachable, policy: POLICY, streamKey }),
      },
    })

    const before = await streamLength()
    const response = await brokenApp.request('/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'user-agent': CHROME },
      body: JSON.stringify(batchOf([pageView()])),
    })

    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe(
      String(POLICY.QUEUE_FAILURE_RETRY_AFTER_SECONDS),
    )
    expect(await streamLength()).toBe(before)
    expect(metrics.countOf('collector_queue_write_failed')).toBe(1)

    unreachable.disconnect()
  })

  it('enforces the G-005 rate limit from real counters', async () => {
    // The limit is charged per event, so one batch of 100 plus one more event
    // crosses a burst of 120 only after the second batch — which is what makes
    // this a test of the counters rather than of a constant.
    const many = () => batchOf(Array.from({ length: 100 }, () => pageView()))

    expect((await post('/v1/events', many())).status).toBe(202)
    const second = await post('/v1/events', many())

    expect(second.status).toBe(429)
    const body = (await second.json()) as { error: { details: Record<string, unknown> } }
    expect(body.error.details['reason']).toBe('ip_site')
  })

  // Skipped since the open-core split: recording usage against a window counter
  // is the hosted service's (`apps/collector/src/cloud`, `recordUsage`), and this
  // harness builds the product collector, which meters nothing. The claim — that
  // the writer and the D-103 reader agree on the key — is worth exactly as much
  // as before and needs a `tests/integration/cloud/` harness that mounts that
  // extension. Until then it is skipped rather than asserted against code that
  // deliberately no longer does it.
  it.skip('records billable usage on the very counter the D-103 check reads', async () => {
    // Read back through the same adapter the collector writes with, so a key
    // mismatch between the writer and the reader fails here rather than in
    // production as a limit that never triggers.
    await post('/v1/events', batchOf([pageView(), pageView()]))

    // The window start must be derived the same way the collector derives it
    // from the anchor, not pinned to a literal: a literal is only the current
    // window while the wall clock stays inside the month it was written in
    // (this line was `2026-07-01` and detonated on August 1st).
    const usage = await deps.realtime.readUsage({
      siteId,
      billingUserId: resolved.config.billingUserId,
      usageWindowStart: usageWindowFor(new Date('2026-07-01T00:00:00.000Z'), now).startsAt,
      at: now,
    })

    expect(usage.billableUsed).toBe(2)
    expect(usage.siteDailyBillable).toBe(2)
  })

  const heartbeatOf = (overrides: Record<string, unknown> = {}) => ({
    schema_version: 1,
    tracking_key: TRACKING_KEY,
    sent_at: now.toISOString(),
    context: { sdk: 'web', sdk_version: '2.0.0' },
    ...overrides,
  })

  it('writes presence metadata for a pageview, in its own key space', async () => {
    // Presence-model v2 (docs snapshot 02 §17): the ZSET member points at a
    // metadata HASH holding the sanitized path, the derived device and the
    // country, and the page-history list carries the path. City is never stored.
    await post(
      '/v1/events',
      batchOf([pageView({ page: { url: 'https://shop.example.com/pricing' } })]),
      {
        'x-vercel-ip-country': 'AZ',
      },
    )

    const members = await client.zrange(`${keyPrefix}rt_visitors:${siteId}`, 0, -1)
    expect(members).toHaveLength(1)
    const visitorId = members[0] as string

    const meta = await client.hgetall(`${keyPrefix}${visitorMetaKey(siteId, visitorId)}`)
    expect(meta['path']).toBe('/pricing')
    expect(meta['device_type']).toBe('desktop')
    expect(meta['country']).toBe('AZ')
    expect(meta).not.toHaveProperty('city')

    const pages = await client.lrange(`${keyPrefix}${visitorPagesKey(siteId, visitorId)}`, 0, -1)
    expect(pages).toContain('/pricing')
  })

  it('writes the same presence metadata for a heartbeat carrying a page', async () => {
    await post(
      '/v1/realtime/heartbeat',
      heartbeatOf({ page: { url: 'https://shop.example.com/checkout' } }),
      {
        'x-vercel-ip-country': 'AZ',
      },
    )

    const members = await client.zrange(`${keyPrefix}rt_visitors:${siteId}`, 0, -1)
    expect(members).toHaveLength(1)
    const visitorId = members[0] as string

    const meta = await client.hgetall(`${keyPrefix}${visitorMetaKey(siteId, visitorId)}`)
    expect(meta['path']).toBe('/checkout')
    expect(meta['device_type']).toBe('desktop')
    expect(meta['country']).toBe('AZ')

    const pages = await client.lrange(`${keyPrefix}${visitorPagesKey(siteId, visitorId)}`, 0, -1)
    expect(pages).toContain('/checkout')
  })

  it('publishes a change notice on the site updates channel', async () => {
    // The gateway subscribes to this channel to know when to recompute a
    // snapshot; a touch that did not publish would leave every client stale.
    const subscriber = createQueueClient({
      mode: 'worker',
      url: VALKEY_URL as string,
      connectionName: 'm5-presence-subscriber',
    })
    const channel = `${keyPrefix}${realtimeUpdatesChannel(siteId)}`

    const received = new Promise<string>((resolve) => {
      subscriber.on('message', (_channel, message) => resolve(message))
    })
    await subscriber.subscribe(channel)

    await post('/v1/events', batchOf([pageView()]))

    const message = await Promise.race([
      received,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('no message')), 2000)),
    ])
    expect(JSON.parse(message)).toHaveProperty('t')

    await subscriber.quit()
  })
})
