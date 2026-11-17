import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  publicRealtimeSnapshotSchema,
  realtimeControlSchema,
  realtimeSnapshotSchema,
} from '@openanalytics/contracts'
import {
  DEFAULT_TRACKER_SETTINGS,
  EMPTY_INGEST_EXCLUSIONS,
  compileIngestExclusions,
  loadPolicy,
  loadServiceEnv,
  type SiteIngestConfig,
} from '@openanalytics/domain'
import { loadRealtimeVerifyKey, signRealtimeToken } from '@openanalytics/auth'
import {
  createEventStreamQueue,
  createQueueClient,
  createRealtimeCache,
  realtimeEpochKey,
} from '@openanalytics/redis'
import {
  createLogger,
  createRecordingMetrics,
  createServiceMetadata,
} from '@openanalytics/observability'
import { testEnv } from '@openanalytics/testkit'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp as createRealtimeApp } from '../../apps/realtime/src/app.ts'
import { createIoRedisSubscriber } from '../../apps/realtime/src/subscriber.ts'
import {
  createApp as createCollectorApp,
  createFallbackLimiter,
  type CollectorDeps,
} from '../../apps/collector/src/index.ts'

/**
 * Milestone 9 (realtime) against a live Valkey — every plan-04 M9 acceptance
 * criterion proven end-to-end.
 *
 * The unit suite (`tests/unit/realtime-gateway.test.ts`) drives `createApp` with
 * a fake cache and fake Pub/Sub: it proves the gateway's *decisions*. This proves
 * the claims a double cannot make, because they are claims about Valkey and about
 * a real HTTP stream rather than about our TypeScript:
 *
 * - The real Ed25519 token minted by the api's codec verifies at connect.
 * - A real `touchVisitor` on the collector's cache publishes on the site channel,
 *   the gateway's real subscriber receives it, and the fetched SSE stream carries
 *   the recomputed snapshot — the whole pubsub → hub → SSE path, no polling.
 * - `bumpEpochAndPublishDisconnect` (exactly what the api and worker call on
 *   revocation) cuts an open stream through the real control channel, and the
 *   periodic epoch check is the backstop when that message is missed.
 * - A deleted epoch key fails the stream closed against a real Redis error.
 *
 * The gateway is served over real HTTP on an ephemeral localhost port (a small
 * `node:http` host for the app's `fetch`, since `@hono/node-server` is not a
 * dependency of the test project), and read with `fetch` + a `ReadableStream`
 * reader, so the streaming, the abort path and the token-in-header rule are
 * exercised for real.
 *
 * Skips without `TEST_VALKEY_URL`, like the M1/M5 live suites: CI supplies a
 * service container, and a contributor without one still runs everything else.
 * A per-run token embedded in every site and billing id isolates this run from
 * repeated runs and parallel CI jobs — the realtime hub subscribes to
 * *un-prefixed* channels (packages/redis prefixes keys for the collector's test
 * isolation, but the gateway cannot be prefixed without a channel mismatch), so
 * isolation is by identifier here rather than by key prefix, and `afterAll`
 * deletes everything carrying the token.
 */

const VALKEY_URL = process.env['TEST_VALKEY_URL']
const describeIfValkey = VALKEY_URL ? describe : describe.skip

const POLICY = loadPolicy({})
const RUN = randomUUID().replace(/-/g, '').slice(0, 12)
const TRACKING_KEY = 'oa_pk_live_testkey_00'
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

// A real signing/verify pair, generated in-test exactly as the api holds one.
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const VERIFY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const SIGNING_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const VERIFY_KEY = loadRealtimeVerifyKey(VERIFY_PEM)

const SERVICE = createServiceMetadata({
  name: 'realtime',
  version: '0.0.0',
  commit: 'test',
  environment: 'test',
})

type Client = ReturnType<typeof createQueueClient>

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// --- a minimal node:http host for a Hono `fetch` app ----------------------
// `@hono/node-server` is a dependency of apps/realtime but not of the test
// project, so it does not resolve from here. This is the slice of it the suite
// needs: real HTTP, streaming bodies, and — crucially — a request AbortSignal
// wired to the socket closing, so aborting a `fetch` tears the SSE stream down
// server-side (its `onAbort` fires) and `server.close()` never hangs.
interface FetchApp {
  fetch(request: Request): Response | Promise<Response>
}

async function handleRequest(
  app: FetchApp,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const controller = new AbortController()
  res.on('close', () => controller.abort())

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const entry of value) headers.append(key, entry)
    else if (value !== undefined) headers.set(key, value)
  }

  let response: Response
  try {
    response = await app.fetch(
      new Request(`http://127.0.0.1${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers,
        signal: controller.signal,
      }),
    )
  } catch {
    res.statusCode = 500
    res.end()
    return
  }

  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    // Let node own the wire framing; a copied length/encoding conflicts with it.
    if (lower === 'content-length' || lower === 'transfer-encoding') return
    res.setHeader(key, value)
  })
  // Flush the head immediately so `fetch` resolves before the first body chunk
  // (a stream that opens quiet — e.g. a caught-up Last-Event-ID — still returns).
  res.flushHeaders()

  if (response.body === null) {
    res.end()
    return
  }

  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || !res.writable) break
      res.write(Buffer.from(value))
    }
  } catch {
    // The client went away or the source stream was aborted.
  } finally {
    await reader.cancel().catch(() => undefined)
    if (res.writable) res.end()
  }
}

function startServer(
  app: FetchApp,
): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer((req, res) => void handleRequest(app, req, res))
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port })
    })
  })
}

// --- unique ids for a test ------------------------------------------------
let counter = 0
const siteId = (): string => `s-${RUN}-${(counter += 1)}-${randomBytes(3).toString('hex')}`
const userSubject = (): string => `u-${RUN}-${randomBytes(3).toString('hex')}`

// --- SSE parsing ----------------------------------------------------------
interface SseEvent {
  event?: string | undefined
  id?: string | undefined
  data?: string | undefined
  comment?: boolean | undefined
}

function parseFrame(raw: string): SseEvent | null {
  const lines = raw.split('\n')
  const data: string[] = []
  let event: string | undefined
  let id: string | undefined
  let isComment = false
  for (const line of lines) {
    if (line.startsWith(':')) {
      isComment = true
      continue
    }
    const idx = line.indexOf(':')
    const field = idx < 0 ? line : line.slice(0, idx)
    let value = idx < 0 ? '' : line.slice(idx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') data.push(value)
  }
  if (data.length === 0 && event === undefined && id === undefined) {
    return isComment ? { comment: true } : null
  }
  return { event, id, data: data.join('\n') }
}

/** Reads a fetched SSE body, buffering parsed frames for assertions. */
class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private buffer = ''
  private readonly frames: SseEvent[] = []
  private cursor = 0
  private done = false

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader()
    void this.pump()
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await this.reader.read()
        if (done) break
        this.buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
          const raw = this.buffer.slice(0, idx)
          this.buffer = this.buffer.slice(idx + 2)
          const frame = parseFrame(raw)
          if (frame) this.frames.push(frame)
        }
      }
    } catch {
      // Stream cancelled/aborted or the server closed it: pump ends.
    } finally {
      this.done = true
    }
  }

  /** Next frame matching `pred`, or throws loudly on timeout. */
  async nextMatching(pred: (e: SseEvent) => boolean, timeoutMs = 6000): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      while (this.cursor < this.frames.length) {
        const frame = this.frames[this.cursor++]!
        if (pred(frame)) return frame
      }
      if (this.done && this.cursor >= this.frames.length) break
      await sleep(15)
    }
    throw new Error('SSE frame did not arrive before the timeout')
  }

  /** Resolves true once the server has ended the stream, false on timeout. */
  async waitClosed(timeoutMs = 6000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.done) return true
      await sleep(20)
    }
    return false
  }

  cancel(): Promise<void> {
    return this.reader.cancel().catch(() => undefined)
  }
}

const isSnapshot = (e: SseEvent): boolean => e.event === 'snapshot'
const isControl = (e: SseEvent): boolean => e.event === 'control'
const hasPath = (e: SseEvent, path: string): boolean => {
  if (!isSnapshot(e) || e.data === undefined) return false
  const pages = (JSON.parse(e.data) as { pages?: { path: string }[] }).pages ?? []
  return pages.some((page) => page.path === path)
}

// --- token minting (the api side of the codec) ----------------------------
interface MintInput {
  siteId: string
  subject: string
  scope: 'private' | 'public'
  epoch: number
  issuedAt?: Date
  ttlSeconds?: number
}

function mintToken(input: MintInput): string {
  return signRealtimeToken({
    privateKeyPem: SIGNING_PEM,
    siteId: input.siteId,
    subject: input.subject,
    scope: input.scope,
    epoch: input.epoch,
    siteEpoch: 0,
    issuedAt: input.issuedAt ?? new Date(),
    ttlSeconds: input.ttlSeconds ?? 60,
    jti: randomUUID(),
  })
}

// --- collector wiring (the M5 pattern, driving real presence) -------------
function ingestConfig(site: string, billingUserId: string): SiteIngestConfig {
  return {
    siteId: site,
    status: 'active',
    ingestGeneration: 1,
    configVersion: 1,
    billingUserId,
    billingAssignmentVersion: 1,
    keyExpiresAt: null,
    allowedDomains: [],
  }
}

function buildCollector(opts: {
  queueClient: Client
  realtimeClient: Client
  streamKey: string
  siteId: string
  billingUserId: string
}): ReturnType<typeof createCollectorApp> {
  const resolved = {
    config: ingestConfig(opts.siteId, opts.billingUserId),
    settings: DEFAULT_TRACKER_SETTINGS,
    slug: 'shop',
    noCodeRules: [],
    exclusions: compileIngestExclusions(EMPTY_INGEST_EXCLUSIONS),
  }
  const deps: CollectorDeps = {
    configStore: {
      resolve: async (key: string) => (key === TRACKING_KEY ? resolved : null),
      invalidate: () => undefined,
    },
    queue: createEventStreamQueue({
      client: opts.queueClient,
      policy: POLICY,
      streamKey: opts.streamKey,
    }),
    realtime: createRealtimeCache({
      client: opts.realtimeClient,
      eventMaxLatenessHours: POLICY.EVENT_MAX_LATENESS_HOURS,
    }),
    policy: POLICY,
    identityKey: { keyVersion: 1, secret: 'live-identity-secret-000000' },
    metrics: createRecordingMetrics(),
    fallbackLimiter: createFallbackLimiter({ perMinute: 120, maxEntries: 100 }),
    now: () => new Date(),
  }
  const service = createServiceMetadata({
    name: 'collector',
    version: '0.0.0',
    commit: 'test',
    environment: 'test',
  })
  return createCollectorApp({
    service,
    logger: createLogger({ service, sink: () => undefined }),
    env: { ...POLICY, PORT: 0 } as never,
    ingest: deps,
  })
}

const iso = (): string => new Date().toISOString()
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
const pageView = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  event_id: uuidV7(),
  type: 'page_view',
  occurred_at: iso(),
  page: { url: 'https://shop.example.com/pricing' },
  ...overrides,
})
const batchOf = (events: unknown[]): Record<string, unknown> => ({
  schema_version: 1,
  tracking_key: TRACKING_KEY,
  sent_at: iso(),
  context: { sdk: 'web', sdk_version: '2.0.0' },
  events,
})
const heartbeatOf = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: 1,
  tracking_key: TRACKING_KEY,
  sent_at: iso(),
  context: { sdk: 'web', sdk_version: '2.0.0' },
  ...overrides,
})
const postCollector = async (
  app: ReturnType<typeof createCollectorApp>,
  path: string,
  body: unknown,
): Promise<Response> =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'user-agent': CHROME },
    body: JSON.stringify(body),
  })

describeIfValkey('M9 realtime gateway against a live Valkey', () => {
  let client: Client
  let gatewayCmd: Client
  let gatewaySub: Client
  let server: ReturnType<typeof createServer> | undefined
  let port = 0
  let testCache: ReturnType<typeof createRealtimeCache>

  const controllers: AbortController[] = []
  const readers: SseReader[] = []

  async function connect(opts: {
    token?: string
    query?: string
    lastEventId?: string
  }): Promise<{ res: Response; reader: SseReader | null; controller: AbortController }> {
    const controller = new AbortController()
    controllers.push(controller)
    const headers: Record<string, string> = {}
    if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`
    if (opts.lastEventId !== undefined) headers['Last-Event-ID'] = opts.lastEventId
    const res = await fetch(`http://127.0.0.1:${port}/v1/realtime/stream${opts.query ?? ''}`, {
      headers,
      signal: controller.signal,
    })
    let reader: SseReader | null = null
    if (res.status === 200 && res.body !== null) {
      reader = new SseReader(res.body)
      readers.push(reader)
    }
    return { res, reader, controller }
  }

  async function seedVisitor(
    site: string,
    path: string,
    options: { feedEventId?: string } = {},
  ): Promise<void> {
    await testCache.touchVisitor({
      siteId: site,
      visitorId: randomBytes(8).toString('hex'),
      at: new Date(),
      country: 'US',
      city: 'New York',
      deviceType: 'desktop',
      browser: 'chrome',
      os: 'windows',
      page: { path },
      ...(options.feedEventId === undefined
        ? {}
        : {
            feed: {
              eventId: options.feedEventId,
              occurredAt: new Date(),
              referrer: 'news.ycombinator.com',
            },
          }),
    })
  }

  beforeAll(async () => {
    // `worker` mode for a loopback service container (the M5 reasoning): the mode
    // selects transport rules, and TLS+AUTH is the public-hop requirement a
    // localhost container is not subject to.
    client = createQueueClient({
      mode: 'worker',
      url: VALKEY_URL as string,
      connectionName: `m9-main-${RUN}`,
    })
    gatewayCmd = createQueueClient({
      mode: 'worker',
      url: VALKEY_URL as string,
      connectionName: `m9-gwcmd-${RUN}`,
    })
    gatewaySub = createQueueClient({
      mode: 'worker',
      url: VALKEY_URL as string,
      connectionName: `m9-gwsub-${RUN}`,
    })
    testCache = createRealtimeCache({
      client,
      eventMaxLatenessHours: POLICY.EVENT_MAX_LATENESS_HOURS,
    })

    // Policy allows a 1s epoch cadence and a 1s snapshot cache; both keep the
    // liveness ceilings well inside a test's patience.
    const env = loadServiceEnv(
      'realtime',
      testEnv({ REALTIME_EPOCH_CHECK_SECONDS: '1', REALTIME_SNAPSHOT_CACHE_SECONDS: '1' }),
    )
    const { app } = createRealtimeApp({
      service: SERVICE,
      logger: createLogger({ service: SERVICE, sink: () => undefined }),
      env,
      cache: createRealtimeCache({
        client: gatewayCmd,
        eventMaxLatenessHours: POLICY.EVENT_MAX_LATENESS_HOURS,
      }),
      subscriber: createIoRedisSubscriber(gatewaySub),
      verifyKey: VERIFY_KEY,
    })

    const started = await startServer(app)
    server = started.server
    port = started.port
  })

  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort()
    await Promise.all(readers.splice(0).map((reader) => reader.cancel()))
  })

  afterAll(async () => {
    for (const controller of controllers.splice(0)) controller.abort()
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve()
        return
      }
      // Drop any lingering sockets so close cannot wait on a stream that outlived
      // its test, then close.
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
    const keys = await client.keys(`*${RUN}*`)
    if (keys.length > 0) await client.del(...keys)
    await Promise.allSettled([client.quit(), gatewayCmd.quit(), gatewaySub.quit()])
  })

  it('streams a valid private token an initial snapshot with an id', async () => {
    const site = siteId()
    const subject = userSubject()
    // The api seeds the epoch at issuance (ensureEpoch); a token never exists
    // without its epoch, so the gateway can anchor it.
    const epoch = await testCache.ensureEpoch({ siteId: site, subject })
    await seedVisitor(site, '/home')

    const { res, reader } = await connect({
      token: mintToken({ siteId: site, subject, scope: 'private', epoch }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const frame = await reader!.nextMatching(isSnapshot)
    expect(frame.id).toBeDefined()
    expect(Number(frame.id)).toBeGreaterThan(0)
    const snapshot = realtimeSnapshotSchema.parse(JSON.parse(frame.data!))
    expect(snapshot.active_visitors).toBeGreaterThanOrEqual(1)
  })

  it('drives the full pipeline: a collector touch reaches an open stream via pubsub', async () => {
    const site = siteId()
    const subject = userSubject()
    const billingUserId = `bu-${RUN}`.slice(0, 40)
    const epoch = await testCache.ensureEpoch({ siteId: site, subject })

    const { reader } = await connect({
      token: mintToken({ siteId: site, subject, scope: 'private', epoch }),
    })
    // The initial snapshot proves the hub subscribed before we publish anything.
    await reader!.nextMatching(isSnapshot)

    const collector = buildCollector({
      queueClient: client,
      realtimeClient: client,
      streamKey: `m9_pipe:${RUN}`,
      siteId: site,
      billingUserId,
    })

    // A real pageview batch: the collector enqueues durably AND touches presence,
    // which publishes on rt_updates:{site}. The gateway recomputes and fans out.
    const pv = await postCollector(
      collector,
      '/v1/events',
      batchOf([pageView({ page: { url: 'https://shop.example.com/pricing' } })]),
    )
    expect(pv.status).toBe(202)
    const withPricing = await reader!.nextMatching((e) => hasPath(e, '/pricing'), 8000)
    expect(
      realtimeSnapshotSchema.parse(JSON.parse(withPricing.data!)).pages.map((p) => p.path),
    ).toContain('/pricing')

    // A heartbeat carrying a page is the other presence source; it reaches the
    // same open stream the same way.
    const hb = await postCollector(
      collector,
      '/v1/realtime/heartbeat',
      heartbeatOf({
        page: { url: 'https://shop.example.com/checkout' },
      }),
    )
    // 204: an accepted heartbeat has no body (docs snapshot 02 §7.2).
    expect(hb.status).toBe(204)
    const withCheckout = await reader!.nextMatching((e) => hasPath(e, '/checkout'), 8000)
    expect(
      realtimeSnapshotSchema.parse(JSON.parse(withCheckout.data!)).pages.map((p) => p.path),
    ).toContain('/checkout')
  })

  it('never serves another site: a token for site A cannot reach site B', async () => {
    const siteA = siteId()
    const siteB = siteId()
    const subject = userSubject()
    await seedVisitor(siteA, '/only-on-a')
    await seedVisitor(siteB, '/only-on-b')
    const epoch = await testCache.ensureEpoch({ siteId: siteA, subject })

    const { reader } = await connect({
      token: mintToken({ siteId: siteA, subject, scope: 'private', epoch }),
    })
    const frame = await reader!.nextMatching(isSnapshot)
    const snapshot = realtimeSnapshotSchema.parse(JSON.parse(frame.data!))
    const paths = snapshot.pages.map((page) => page.path)
    expect(paths).toContain('/only-on-a')
    expect(paths).not.toContain('/only-on-b')
    // The site is bound in the token; there is no parameter to aim it at B.
  })

  it('rejects an expired token at connect (401 expired)', async () => {
    const site = siteId()
    const subject = userSubject()
    await testCache.ensureEpoch({ siteId: site, subject })
    const token = mintToken({
      siteId: site,
      subject,
      scope: 'private',
      epoch: 0,
      issuedAt: new Date(Date.now() - 120_000),
      ttlSeconds: 30,
    })
    const { res, reader } = await connect({ token })
    expect(res.status).toBe(401)
    expect(reader).toBeNull()
    const body = (await res.json()) as { error: { details: Record<string, unknown> } }
    expect(body.error.details['reason']).toBe('expired')
  })

  it('rejects a tampered token (401)', async () => {
    const site = siteId()
    const subject = userSubject()
    await testCache.ensureEpoch({ siteId: site, subject })
    const token = mintToken({ siteId: site, subject, scope: 'private', epoch: 0 })
    const [scheme, payload, sig] = token.split('.') as [string, string, string]
    // Flip one byte of the signed claims — the detached signature no longer
    // matches the bytes on the wire.
    const bytes = Buffer.from(payload, 'base64url')
    bytes[0] = bytes[0]! ^ 0x01
    const tampered = [scheme, bytes.toString('base64url'), sig].join('.')

    const { res, reader } = await connect({ token: tampered })
    expect(res.status).toBe(401)
    expect(reader).toBeNull()
    const body = (await res.json()) as { error: { details: Record<string, unknown> } }
    expect(body.error.details['reason']).toBe('bad_signature')
  })

  it('rejects a revoked-epoch token at connect (401 revoked)', async () => {
    const site = siteId()
    const subject = userSubject()
    const epoch = await testCache.ensureEpoch({ siteId: site, subject })
    const token = mintToken({ siteId: site, subject, scope: 'private', epoch })
    // The api/worker revoke path: bump the epoch. The pre-bump token no longer
    // matches the live epoch.
    await testCache.bumpEpochAndPublishDisconnect({ siteId: site, subject })

    const { res, reader } = await connect({ token })
    expect(res.status).toBe(401)
    expect(reader).toBeNull()
    const body = (await res.json()) as { error: { details: Record<string, unknown> } }
    expect(body.error.details['reason']).toBe('revoked')
  })

  it('cuts an OPEN stream immediately via the control channel on owner removal', async () => {
    const site = siteId()
    const subject = userSubject()
    const epoch = await testCache.ensureEpoch({ siteId: site, subject })
    await seedVisitor(site, '/x')

    const { reader } = await connect({
      token: mintToken({ siteId: site, subject, scope: 'private', epoch }),
    })
    await reader!.nextMatching(isSnapshot)

    const start = Date.now()
    // Exactly what the api+worker call on removal: bump the epoch and publish the
    // targeted disconnect on rt_control:{site}.
    await testCache.bumpEpochAndPublishDisconnect({ siteId: site, subject })

    const control = await reader!.nextMatching(isControl, 8000)
    const parsed = realtimeControlSchema.parse(JSON.parse(control.data!))
    expect(parsed.action).toBe('disconnect')
    expect(parsed.reason).toBe('access_revoked')
    expect(await reader!.waitClosed(8000)).toBe(true)
    expect(Date.now() - start).toBeLessThan(15_000)
  })

  it('cuts a stream within the epoch-check cadence when the control message is missed', async () => {
    const site = siteId()
    const subject = userSubject()
    const epoch = await testCache.ensureEpoch({ siteId: site, subject })
    await seedVisitor(site, '/x')

    const { reader } = await connect({
      token: mintToken({ siteId: site, subject, scope: 'private', epoch }),
    })
    await reader!.nextMatching(isSnapshot)

    // Silently advance the epoch WITHOUT publishing — the "if the message is
    // lost" case.
    // Only the periodic 1s epoch check can catch this.
    await client.incr(realtimeEpochKey(site, subject))

    const control = await reader!.nextMatching(isControl, 6000)
    expect(realtimeControlSchema.parse(JSON.parse(control.data!)).reason).toBe('access_revoked')
    expect(await reader!.waitClosed(6000)).toBe(true)
  })

  it('fails closed with auth_unreachable when the epoch state is lost', async () => {
    const site = siteId()
    const subject = userSubject()
    const epoch = await testCache.ensureEpoch({ siteId: site, subject })
    await seedVisitor(site, '/x')

    const { reader } = await connect({
      token: mintToken({ siteId: site, subject, scope: 'private', epoch }),
    })
    await reader!.nextMatching(isSnapshot)

    // The epoch key vanishes (eviction / never-seeded after a flush). Fail-closed,
    // never fail-open: the next check reads null and ends the stream.
    await client.del(realtimeEpochKey(site, subject))

    const control = await reader!.nextMatching(isControl, 6000)
    expect(realtimeControlSchema.parse(JSON.parse(control.data!)).reason).toBe('auth_unreachable')
    expect(await reader!.waitClosed(6000)).toBe(true)
  })

  it('does not exist as query-token auth: a valid token in the query string is 401', async () => {
    const site = siteId()
    const subject = userSubject()
    await testCache.ensureEpoch({ siteId: site, subject })
    const token = mintToken({ siteId: site, subject, scope: 'private', epoch: 0 })

    // A genuinely valid token, but in the URL and with no Authorization header.
    const { res, reader } = await connect({ query: `?token=${encodeURIComponent(token)}` })
    expect(res.status).toBe(401)
    expect(reader).toBeNull()
    const body = (await res.json()) as { error: { details: Record<string, unknown> } }
    expect(body.error.details['reason']).toBe('query_token_rejected')
  })

  it('serves the private snapshot the ADR-0024 breakdowns and the rolling feed', async () => {
    const site = siteId()
    const subject = userSubject()
    const epoch = await testCache.ensureEpoch({ siteId: site, subject })
    await seedVisitor(site, '/pricing', { feedEventId: `evt-${RUN}-1` })
    await seedVisitor(site, '/checkout', { feedEventId: `evt-${RUN}-2` })
    // A touch with no feed entry — the heartbeat shape. It counts toward presence
    // and adds nothing to the feed.
    await seedVisitor(site, '/quiet')

    const { reader } = await connect({
      token: mintToken({ siteId: site, subject, scope: 'private', epoch }),
    })
    const frame = await reader!.nextMatching(isSnapshot)
    const snapshot = realtimeSnapshotSchema.parse(JSON.parse(frame.data!))

    expect(snapshot.active_visitors).toBe(3)
    expect(snapshot.browsers).toEqual([{ browser: 'chrome', visitors: 3 }])
    expect(snapshot.operating_systems).toEqual([{ os: 'windows', visitors: 3 }])
    expect(snapshot.cities).toEqual([{ city: 'New York', visitors: 3 }])

    // Newest first, and only the two touches that carried an event.
    expect(snapshot.events.map((event) => event.event_id)).toEqual([`evt-${RUN}-2`, `evt-${RUN}-1`])
    expect(snapshot.events[0]?.path).toBe('/checkout')
    expect(snapshot.events[0]?.referrer).toBe('news.ycombinator.com')
  })

  it('serves a public-scope token only the narrow public snapshot', async () => {
    const site = siteId()
    const epoch = await testCache.ensureEpoch({ siteId: site, subject: 'public' })
    // Private breakdown data exists for the site — pages and countries.
    await seedVisitor(site, '/private-page')
    await seedVisitor(site, '/another-private-page')

    const token = mintToken({ siteId: site, subject: 'public', scope: 'public', epoch })
    const { reader } = await connect({ token })
    const frame = await reader!.nextMatching(isSnapshot)
    const raw = JSON.parse(frame.data!)
    const parsed = publicRealtimeSnapshotSchema.parse(raw)
    expect(parsed.active_visitors).toBe(2)
    // ONLY the allowlisted keys, even though private pages/countries exist.
    expect(Object.keys(raw).sort()).toEqual(['active_visitors', 'generated_at', 'type'])
  })

  it('never breaks historical ingest when realtime is unreachable', async () => {
    const site = siteId()
    const billingUserId = `bu2-${RUN}`.slice(0, 40)
    const streamKey = `m9_ingest:${RUN}`
    // A realtime cache pointed at a port nothing listens on, offline queue off, so
    // every realtime call fails fast — while the durable queue is the live client.
    const brokenRealtime = createQueueClient({
      mode: 'worker',
      url: (VALKEY_URL as string).replace(/:\d+/, ':6399'),
      connectTimeoutMs: 300,
      commandTimeoutMs: 300,
      lazyConnect: true,
      enableOfflineQueue: false,
    })
    const collector = buildCollector({
      queueClient: client,
      realtimeClient: brokenRealtime,
      streamKey,
      siteId: site,
      billingUserId,
    })

    const before = await client.xlen(streamKey)
    // The batch is still accepted and durably queued — realtime lives in its own
    // failure boundary (§7.2).
    const events = await postCollector(collector, '/v1/events', batchOf([pageView(), pageView()]))
    expect(events.status).toBe(202)
    expect(await client.xlen(streamKey)).toBe(before + 2)

    // The heartbeat has no fallback: realtime is its only destination, so a
    // realtime outage is an honest 503, never a downgrade into the queue.
    const heartbeat = await postCollector(
      collector,
      '/v1/realtime/heartbeat',
      heartbeatOf({
        page: { url: 'https://shop.example.com/live' },
      }),
    )
    expect(heartbeat.status).toBe(503)

    brokenRealtime.disconnect()
  })
})
