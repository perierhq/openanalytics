import { loadServiceEnv, metaAdsCredentialAad, type MetaSpendRow } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import {
  createCredentialVault,
  type MetaAccountResult,
  type MetaAdsClient,
} from '@openanalytics/integrations'
import type {
  CurrencyRateRow,
  Database,
  MetaAdsConnectionRecord,
  SaveMetaAdsConnectionInput,
} from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyticsGateway } from '../../apps/api/src/gateway-client.ts'

/**
 * The Meta Ads surface (migration 0052).
 *
 * - **Owner-only, everywhere.** The connection and the campaigns read both
 *   need `revenue:read`; an admin and a viewer get 403 and Meta is never
 *   called for them.
 * - **The connection is session-only**: it has no grant allowlist row, so an
 *   OAuth token cannot read or change it. The campaigns read has one
 *   (`revenue:read`) for the `ads_campaigns` MCP tool.
 * - **The token goes in and never comes out**: not in a response, not in an
 *   error, not in a log line. It is stored as the vault's ciphertext bound to
 *   the site and the ad account.
 * - **The campaigns join**: name and id matching, case-insensitive; spend
 *   converted at each day's rate; ROAS null with a reason when it cannot be
 *   had.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const OWNER = 'u-owner'
const ADMIN = 'u-admin'
const VIEWER = 'u-viewer'
const STRANGER = 'u-stranger'
const OAUTH_TOKEN = 'oauth-token-1'
const META_TOKEN = 'EAAG' + 'MetaSecretToken'.repeat(5)

const vault = createCredentialVault(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
)

const memberships = new Map<string, { role: string; isBillingOwner: boolean }>([
  [OWNER, { role: 'owner', isBillingOwner: true }],
  [ADMIN, { role: 'admin', isBillingOwner: false }],
  [VIEWER, { role: 'viewer', isBillingOwner: false }],
])

const world = {
  connection: null as MetaAdsConnectionRecord | null,
  saves: [] as SaveMetaAdsConnectionInput[],
  deletes: [] as string[],
  audits: [] as { action: string; metadata?: Record<string, unknown> }[],
  spend: [] as MetaSpendRow[],
  spendArgs: [] as { siteId: string; fromDay: string; toDay: string }[],
  rates: [] as CurrencyRateRow[],
  siteStatus: 'active',
  /** The deletion that starts between the route's site check and the save. */
  saveConflict: false,
  reportingCurrency: 'EUR',
  gatewayCalls: [] as { operation: string; params: Record<string, unknown> }[],
  utmRows: [] as Record<string, unknown>[],
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async (_db: unknown, params: { siteId: string; userId: string }) =>
      params.siteId === SITE ? (memberships.get(params.userId) ?? null) : null,
    resolveOAuthAccessToken: async (_db: unknown, token: string) =>
      token === OAUTH_TOKEN
        ? {
            id: 'grant-1',
            userId: OWNER,
            clientId: 'client-1',
            scopes: 'site:read analytics:read revenue:read sites:write team:read',
          }
        : null,
    getAuthedUserById: async (_db: unknown, id: string) => ({
      id,
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
    getSiteBasics: async () => ({
      siteId: SITE,
      slug: 's',
      name: 'S',
      status: world.siteStatus,
      configVersion: 3,
      publishedImportRunId: null,
      importCutoverDate: null,
      reportingCurrency: world.reportingCurrency,
    }),
    writeAudit: async (
      _db: unknown,
      entry: { action: string; metadata?: Record<string, unknown> },
    ) => {
      world.audits.push(entry)
    },
    readMetaAdsConnection: async (_db: unknown, siteId: string) =>
      siteId === SITE ? world.connection : null,
    saveMetaAdsConnection: async (_db: unknown, input: SaveMetaAdsConnectionInput) => {
      world.saves.push(input)
      if (world.saveConflict) return { ok: false, conflict: 'site_unavailable' }
      const accountChanged =
        world.connection !== null && world.connection.adAccountId !== input.adAccountId
      world.connection = {
        siteId: input.siteId,
        adAccountId: input.adAccountId,
        adAccountName: input.adAccountName,
        currency: input.currency,
        accountStatus: input.accountStatus,
        encryptedToken: input.encryptedToken,
        keyVersion: input.keyVersion,
        tokenLast4: input.tokenLast4,
        status: 'active',
        connectedAt: new Date('2026-11-22T10:00:00.000Z'),
        nextSyncAt: new Date('2026-11-22T10:00:00.000Z'),
        lastAttemptedAt: null,
        lastSyncedAt: null,
        backfillCursor: null,
        lastError: null,
      }
      return { ok: true, connection: world.connection, accountChanged }
    },
    deleteMetaAdsConnection: async (_db: unknown, input: { siteId: string }) => {
      world.deletes.push(input.siteId)
      const had = world.connection !== null
      world.connection = null
      return { deleted: had, spendRows: had ? 3 : 0 }
    },
    listMetaAdsSpend: async (
      _db: unknown,
      input: { siteId: string; fromDay: string; toDay: string },
    ) => {
      world.spendArgs.push(input)
      return world.spend
    },
    listCurrencyRatesBetween: async () => world.rates,
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')
const { AnalyticsService } = await import('../../apps/api/src/analytics/service.ts')

const auth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get('x-test-user')
      if (id === null) return null
      return {
        user: {
          id,
          email: `${id}@example.test`,
          emailVerified: true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        session: { createdAt: new Date('2026-01-01T00:00:00.000Z') },
      }
    },
  },
  handler: async () => new Response(null),
} as unknown as Auth

const verifyCalls: { adAccountId: string; token: string }[] = []
let verifyAnswer: MetaAccountResult = {
  ok: true,
  name: 'Acme Ads',
  currency: 'USD',
  accountStatus: 1,
}
const metaClient: MetaAdsClient = {
  verifyAccount: async (adAccountId, token) => {
    verifyCalls.push({ adAccountId, token })
    return verifyAnswer
  },
  fetchInsights: async () => {
    throw new Error('the API never reads insights')
  },
}

const gateway: AnalyticsGateway = {
  query: <TRow = Record<string, unknown>>(operation: string, params?: unknown) => {
    world.gatewayCalls.push({ operation, params: (params ?? {}) as Record<string, unknown> })
    const rows =
      operation === 'analytics.revenue_attribution_last_utm_campaign' ? world.utmRows : []
    return Promise.resolve({
      operation,
      rows: rows as TRow[],
      meta: { row_count: rows.length, truncated: false, elapsed_ms: 1, cached: false },
    })
  },
}

const captured = createCapturedLogger()

function buildApp(options: { vault?: boolean } = {}) {
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger: captured.logger,
    env: loadServiceEnv('api', testEnv()),
    auth,
    db: {} as Database,
    analytics: new AnalyticsService(gateway, { now: () => new Date('2026-11-22T15:00:00.000Z') }),
    ...(options.vault === false ? {} : { vault }),
    metaAds: metaClient,
  })
}

const app = buildApp()

const CONNECTION = `/v1/sites/${SITE}/marketing/meta/connection`
const RANGE = 'from=2026-11-01T00:00:00.000Z&to=2026-11-08T00:00:00.000Z&timezone=UTC'
const CAMPAIGNS = `/v1/sites/${SITE}/marketing/campaigns?${RANGE}`
/** The first paths, kept for server-side clients: content blockers drop `/ads/`. */
const OLD_CONNECTION = `/v1/sites/${SITE}/ads/meta/connection`
const OLD_CAMPAIGNS = `/v1/sites/${SITE}/ads/campaigns?${RANGE}`

const send = (
  method: string,
  path: string,
  user?: string,
  body?: unknown,
  target = app,
  headers: Record<string, string> = {},
) =>
  target.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        ...(user === undefined ? {} : { 'x-test-user': user }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string; details: unknown } }).error

const connectBody = { ad_account_id: 'act_1234567890', access_token: META_TOKEN }

function storedConnection(
  overrides: Partial<MetaAdsConnectionRecord> = {},
): MetaAdsConnectionRecord {
  return {
    siteId: SITE,
    adAccountId: 'act_1234567890',
    adAccountName: 'Acme Ads',
    currency: 'USD',
    accountStatus: 1,
    encryptedToken: vault.encrypt(
      META_TOKEN,
      metaAdsCredentialAad({ siteId: SITE, adAccountId: 'act_1234567890' }),
    ).stored,
    keyVersion: 'k1',
    tokenLast4: META_TOKEN.slice(-4),
    status: 'active',
    connectedAt: new Date('2026-11-20T10:00:00.000Z'),
    nextSyncAt: new Date('2026-11-22T16:00:00.000Z'),
    lastAttemptedAt: new Date('2026-11-22T10:00:00.000Z'),
    lastSyncedAt: new Date('2026-11-22T10:00:00.000Z'),
    backfillCursor: null,
    lastError: null,
    ...overrides,
  }
}

function noSecret(text: string) {
  expect(text).not.toContain(META_TOKEN)
  expect(text).not.toContain('MetaSecretToken')
  expect(text).not.toContain('encrypted')
}

beforeEach(() => {
  world.connection = null
  world.saves = []
  world.deletes = []
  world.audits = []
  world.spend = []
  world.spendArgs = []
  world.rates = []
  world.siteStatus = 'active'
  world.saveConflict = false
  world.reportingCurrency = 'EUR'
  world.gatewayCalls = []
  world.utmRows = []
  verifyCalls.length = 0
  verifyAnswer = { ok: true, name: 'Acme Ads', currency: 'USD', accountStatus: 1 }
  captured.clear()
})

describe('who may touch the connection', () => {
  it('answers the owner, and refuses an admin and a viewer with 403', async () => {
    expect((await send('GET', CONNECTION, OWNER)).status).toBe(200)
    for (const user of [ADMIN, VIEWER]) {
      expect((await send('GET', CONNECTION, user)).status, user).toBe(403)
      expect((await send('PUT', CONNECTION, user, connectBody)).status, user).toBe(403)
      expect((await send('DELETE', CONNECTION, user)).status, user).toBe(403)
    }
    expect(verifyCalls).toHaveLength(0)
    expect(world.saves).toHaveLength(0)
    expect(world.deletes).toHaveLength(0)
  })

  it('hides the site from a stranger and asks an anonymous caller to sign in', async () => {
    expect((await send('GET', CONNECTION, STRANGER)).status).toBe(404)
    expect((await send('GET', CONNECTION)).status).toBe(401)
  })

  it('is session-only: an OAuth grant cannot read or change it', async () => {
    const bearer = { authorization: `Bearer ${OAUTH_TOKEN}` }
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await send(
        method,
        CONNECTION,
        undefined,
        method === 'PUT' ? connectBody : undefined,
        app,
        bearer,
      )
      expect(res.status, method).toBe(403)
    }
    expect(verifyCalls).toHaveLength(0)
  })
})

describe('GET /marketing/meta/connection', () => {
  it('says not_connected when there is none', async () => {
    const res = await send('GET', CONNECTION, OWNER)
    expect(await res.json()).toEqual({ status: 'not_connected' })
  })

  it('renders the connection without the token or its ciphertext', async () => {
    world.connection = storedConnection({ lastError: 'rate_limited' })
    const res = await send('GET', CONNECTION, OWNER)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({
      status: 'active',
      ad_account_id: 'act_1234567890',
      ad_account_name: 'Acme Ads',
      ad_account_active: true,
      currency: 'USD',
      token_last4: META_TOKEN.slice(-4),
      connected_at: '2026-11-20T10:00:00.000Z',
      last_attempted_at: '2026-11-22T10:00:00.000Z',
      last_synced_at: '2026-11-22T10:00:00.000Z',
      next_sync_at: '2026-11-22T16:00:00.000Z',
      last_error: 'rate_limited',
    })
    noSecret(text)
    expect(text).not.toContain(world.connection.encryptedToken)
  })

  it('says whether Meta reported the account active, and null when it did not say', async () => {
    world.connection = storedConnection({ accountStatus: 101 })
    expect(await (await send('GET', CONNECTION, OWNER)).json()).toMatchObject({
      ad_account_active: false,
    })
    world.connection = storedConnection({ accountStatus: null })
    expect(await (await send('GET', CONNECTION, OWNER)).json()).toMatchObject({
      ad_account_active: null,
    })
  })

  it('carries a token this install cannot decrypt as its own error', async () => {
    world.connection = storedConnection({ lastError: 'credential_undecryptable' })
    expect(await (await send('GET', CONNECTION, OWNER)).json()).toMatchObject({
      status: 'active',
      last_error: 'credential_undecryptable',
    })
  })
})

describe('PUT /marketing/meta/connection', () => {
  it('checks the token with Meta, stores it encrypted to the site and account, and never returns it', async () => {
    const res = await send('PUT', CONNECTION, OWNER, {
      ad_account_id: ' 1234567890 ',
      access_token: ` ${META_TOKEN} `,
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    noSecret(text)
    expect(JSON.parse(text)).toMatchObject({
      status: 'active',
      ad_account_id: 'act_1234567890',
      ad_account_name: 'Acme Ads',
      currency: 'USD',
      token_last4: META_TOKEN.slice(-4),
    })
    expect(verifyCalls).toEqual([{ adAccountId: 'act_1234567890', token: META_TOKEN }])

    const saved = world.saves[0]!
    expect(saved).toMatchObject({
      siteId: SITE,
      adAccountId: 'act_1234567890',
      adAccountName: 'Acme Ads',
      currency: 'USD',
      keyVersion: 'k1',
      tokenLast4: META_TOKEN.slice(-4),
      actorUserId: OWNER,
    })
    expect(saved.encryptedToken).not.toContain(META_TOKEN)
    expect(
      vault.decrypt(
        saved.encryptedToken,
        metaAdsCredentialAad({ siteId: SITE, adAccountId: 'act_1234567890' }),
      ),
    ).toEqual({ ok: true, plaintext: META_TOKEN })
    noSecret(JSON.stringify(captured.lines))
  })

  it('refuses a malformed account id or token without echoing either, and without calling Meta', async () => {
    const res = await send('PUT', CONNECTION, OWNER, {
      ad_account_id: 'acct-12',
      access_token: 'short',
    })
    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(JSON.stringify(error)).not.toContain('short')
    expect(JSON.stringify(error.details)).toContain('ad_account_id')
    expect(JSON.stringify(error.details)).toContain('access_token')

    const spaced = await send('PUT', CONNECTION, OWNER, {
      ad_account_id: 'act_1',
      access_token: `${META_TOKEN} extra`,
    })
    expect(spaced.status).toBe(400)
    noSecret(await spaced.text())
    expect(verifyCalls).toHaveLength(0)
  })

  it('answers 422 when Meta refuses the token, keeping it out of the body, the audit and the logs', async () => {
    verifyAnswer = { ok: false, reason: 'unauthorized', detail: 'account responded 400 (code 190)' }
    const res = await send('PUT', CONNECTION, OWNER, connectBody)
    expect(res.status).toBe(422)
    const text = await res.text()
    expect(JSON.parse(text).error.code).toBe('ADS_CREDENTIAL_REJECTED')
    noSecret(text)
    expect(world.saves).toHaveLength(0)
    expect(world.audits).toEqual([
      expect.objectContaining({
        action: 'site.meta_ads.verify_failed',
        metadata: { outcome: 'unauthorized', detail: 'account responded 400 (code 190)' },
      }),
    ])
    expect(captured.find('meta_ads_verify_failed')).toHaveLength(1)
    noSecret(JSON.stringify(captured.lines))
    noSecret(JSON.stringify(world.audits))
  })

  it('answers 503 when Meta is down or throttling, and stores nothing', async () => {
    for (const reason of ['unavailable', 'rate_limited', 'invalid_response'] as const) {
      verifyAnswer = { ok: false, reason, detail: 'x' }
      const res = await send('PUT', CONNECTION, OWNER, connectBody)
      expect(res.status, reason).toBe(503)
      expect((await errorOf(res)).code).toBe('PROVIDER_UNAVAILABLE')
    }
    expect(world.saves).toHaveLength(0)
  })

  it('connects an account Meta reports disabled, stores the status, and warns', async () => {
    verifyAnswer = { ok: true, name: 'Paused Co', currency: 'USD', accountStatus: 2 }
    const res = await send('PUT', CONNECTION, OWNER, connectBody)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ad_account_active: false })
    expect(world.saves[0]).toMatchObject({ accountStatus: 2 })
    expect(captured.find('meta_ads_account_inactive')).toEqual([
      expect.objectContaining({ site_id: SITE, account_status: 2 }),
    ])
    noSecret(JSON.stringify(captured.lines))
    expect(JSON.stringify(captured.lines)).not.toContain('act_1234567890')
  })

  it('answers 404 when the site’s deletion starts between the check and the save', async () => {
    world.saveConflict = true
    const res = await send('PUT', CONNECTION, OWNER, connectBody)
    expect(res.status).toBe(404)
    expect((await errorOf(res)).code).toBe('SITE_NOT_FOUND')
  })

  it('refuses a site on its way out before calling Meta', async () => {
    world.siteStatus = 'deleting'
    expect((await send('PUT', CONNECTION, OWNER, connectBody)).status).toBe(404)
    expect(verifyCalls).toHaveLength(0)
  })

  it('is not there without a credential keyring, while GET and DELETE still are', async () => {
    const bare = buildApp({ vault: false })
    expect((await send('PUT', CONNECTION, OWNER, connectBody, bare)).status).toBe(404)
    expect((await send('GET', CONNECTION, OWNER, undefined, bare)).status).toBe(200)
    world.connection = storedConnection()
    expect((await send('DELETE', CONNECTION, OWNER, undefined, bare)).status).toBe(204)
    expect(verifyCalls).toHaveLength(0)
  })
})

describe('DELETE /marketing/meta/connection', () => {
  it('deletes the token and the spend', async () => {
    world.connection = storedConnection()
    const res = await send('DELETE', CONNECTION, OWNER)
    expect(res.status).toBe(204)
    expect(world.deletes).toEqual([SITE])
  })

  it('answers 404 when there is nothing to disconnect', async () => {
    expect((await send('DELETE', CONNECTION, OWNER)).status).toBe(404)
  })
})

interface CampaignsBody {
  connection: { status: string; ad_account_name: string; currency: string } | null
  currency: string
  from_day: string
  to_day: string
  campaigns: {
    id: string
    name: string
    spend: { amount_minor: number; currency: string }
    spend_converted_minor: number | null
    revenue_minor: number
    orders: number
    roas: number | null
    roas_unavailable: string | null
    matched_by: string | null
  }[]
  totals: {
    spend: { amount_minor: number; currency: string }
    spend_converted_minor: number | null
    revenue_minor: number
    orders: number
    roas: number | null
    roas_unavailable: string | null
  }
  unmatched: {
    campaigns: number
    spend: { amount_minor: number; currency: string }
    spend_converted_minor: number | null
  }
}

const spendRow = (
  campaignId: string,
  campaignName: string,
  day: string,
  spendMinor: number,
): MetaSpendRow => ({
  campaignId,
  campaignName,
  day,
  spendMinor,
  currency: 'USD',
})

const rate = (rateDate: string, currency: string, ratePerEur: string): CurrencyRateRow => ({
  rateDate,
  currency,
  ratePerEur,
  fetchedAt: new Date('2026-11-01T16:00:00.000Z'),
})

describe('GET /marketing/campaigns', () => {
  it('is owner-only: an admin and a viewer get 403 and nothing is read', async () => {
    world.connection = storedConnection()
    for (const user of [ADMIN, VIEWER]) {
      expect((await send('GET', CAMPAIGNS, user)).status, user).toBe(403)
    }
    expect(world.spendArgs).toHaveLength(0)
    expect(world.gatewayCalls).toHaveLength(0)
  })

  it('answers an empty report with no connection, and asks the gateway nothing', async () => {
    const res = await send('GET', CAMPAIGNS, OWNER)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      connection: null,
      currency: 'EUR',
      from_day: '2026-11-01',
      to_day: '2026-11-07',
      campaigns: [],
      totals: {
        spend: { amount_minor: 0, currency: 'EUR' },
        spend_converted_minor: 0,
        revenue_minor: 0,
        orders: 0,
        roas: null,
        roas_unavailable: 'no_spend',
      },
      unmatched: {
        campaigns: 0,
        spend: { amount_minor: 0, currency: 'EUR' },
        spend_converted_minor: 0,
      },
    })
    expect(world.gatewayCalls).toHaveLength(0)
  })

  it('joins spend to last-touch utm_campaign revenue by name and id, converting each day', async () => {
    world.connection = storedConnection()
    world.spend = [
      spendRow('111', 'Black Friday', '2026-11-02', 12_500),
      spendRow('111', 'Black Friday', '2026-11-03', 12_500),
      spendRow('222', 'Retargeting', '2026-11-03', 6_250),
      spendRow('333', 'Brand', '2026-11-03', 1_250),
    ]
    // EUR is the reporting currency: 1.25 USD per EUR on both days.
    world.rates = [rate('2026-10-31', 'USD', '1.25'), rate('2026-10-31', 'EUR', '1')]
    world.utmRows = [
      { value: null, revenue_minor: '99999', orders: '9' },
      { value: ' black friday', revenue_minor: '40000', orders: '4' },
      { value: '222', revenue_minor: '2500', orders: '1' },
      { value: 'newsletter', revenue_minor: '7000', orders: '2' },
    ]
    const res = await send('GET', CAMPAIGNS, OWNER)
    expect(res.status).toBe(200)
    const body = (await res.json()) as CampaignsBody

    expect(world.spendArgs).toEqual([{ siteId: SITE, fromDay: '2026-11-01', toDay: '2026-11-07' }])
    expect(world.gatewayCalls.map((c) => c.operation)).toEqual([
      'analytics.revenue_attribution_last_utm_campaign',
    ])
    expect(world.gatewayCalls[0]!.params).toMatchObject({ site_id: SITE, limit: 500 })

    expect(body.connection).toMatchObject({
      status: 'active',
      ad_account_name: 'Acme Ads',
      currency: 'USD',
    })
    expect(body.currency).toBe('EUR')
    expect(body.campaigns).toEqual([
      {
        id: '111',
        name: 'Black Friday',
        spend: { amount_minor: 25_000, currency: 'USD' },
        spend_converted_minor: 20_000,
        revenue_minor: 40_000,
        orders: 4,
        roas: 2,
        roas_unavailable: null,
        matched_by: 'name',
      },
      {
        id: '222',
        name: 'Retargeting',
        spend: { amount_minor: 6_250, currency: 'USD' },
        spend_converted_minor: 5_000,
        revenue_minor: 2_500,
        orders: 1,
        roas: 0.5,
        roas_unavailable: null,
        matched_by: 'id',
      },
      {
        id: '333',
        name: 'Brand',
        spend: { amount_minor: 1_250, currency: 'USD' },
        spend_converted_minor: 1_000,
        revenue_minor: 0,
        orders: 0,
        roas: 0,
        roas_unavailable: null,
        matched_by: null,
      },
    ])
    expect(body.totals).toEqual({
      spend: { amount_minor: 32_500, currency: 'USD' },
      spend_converted_minor: 26_000,
      revenue_minor: 42_500,
      orders: 5,
      roas: 42_500 / 26_000,
      roas_unavailable: null,
    })
    expect(body.unmatched).toEqual({
      campaigns: 1,
      spend: { amount_minor: 1_250, currency: 'USD' },
      spend_converted_minor: 1_000,
    })
  })

  it('leaves ROAS empty with a reason when spend has no exchange rate', async () => {
    world.connection = storedConnection()
    world.spend = [spendRow('111', 'Black Friday', '2026-11-02', 10_000)]
    world.rates = [rate('2026-10-31', 'EUR', '1')]
    world.utmRows = [{ value: 'Black Friday', revenue_minor: '5000', orders: '1' }]
    const body = (await (await send('GET', CAMPAIGNS, OWNER)).json()) as CampaignsBody
    expect(body.campaigns[0]).toMatchObject({
      spend: { amount_minor: 10_000, currency: 'USD' },
      spend_converted_minor: null,
      revenue_minor: 5_000,
      roas: null,
      roas_unavailable: 'no_rate',
    })
    expect(body.totals).toMatchObject({
      spend_converted_minor: null,
      roas: null,
      roas_unavailable: 'no_rate',
    })
  })

  it('does not convert at a rate older than the seven-day lookback', async () => {
    world.connection = storedConnection()
    world.spend = [spendRow('111', 'A', '2026-11-07', 1_250)]
    world.rates = [rate('2026-10-30', 'USD', '1.25'), rate('2026-10-30', 'EUR', '1')]
    const body = (await (await send('GET', CAMPAIGNS, OWNER)).json()) as CampaignsBody
    expect(body.campaigns[0]?.spend_converted_minor).toBeNull()
  })

  it('reaches an OAuth grant carrying revenue:read (the ads_campaigns tool)', async () => {
    world.connection = storedConnection()
    const res = await send('GET', CAMPAIGNS, undefined, undefined, app, {
      authorization: `Bearer ${OAUTH_TOKEN}`,
    })
    expect(res.status).toBe(200)
  })

  it('refuses a malformed range', async () => {
    const res = await send(
      'GET',
      `/v1/sites/${SITE}/marketing/campaigns?from=x&to=y&timezone=UTC`,
      OWNER,
    )
    expect(res.status).toBe(400)
  })
})

describe('the deprecated /ads/ paths still answer, identically', () => {
  it('GET connection: the same body under both paths, connected or not', async () => {
    const before = await send('GET', OLD_CONNECTION, OWNER)
    expect(before.status).toBe(200)
    expect(await before.json()).toEqual(await (await send('GET', CONNECTION, OWNER)).json())

    world.connection = storedConnection()
    const old = await send('GET', OLD_CONNECTION, OWNER)
    expect(old.status).toBe(200)
    const body = await old.json()
    expect(body).toMatchObject({ status: 'active', ad_account_id: 'act_1234567890' })
    expect(body).toEqual(await (await send('GET', CONNECTION, OWNER)).json())
  })

  it('GET connection: the same refusals (admin 403, stranger 404, OAuth grant 403)', async () => {
    expect((await send('GET', OLD_CONNECTION, ADMIN)).status).toBe(403)
    expect((await send('GET', OLD_CONNECTION, STRANGER)).status).toBe(404)
    const bearer = { authorization: `Bearer ${OAUTH_TOKEN}` }
    expect((await send('GET', OLD_CONNECTION, undefined, undefined, app, bearer)).status).toBe(403)
  })

  it('PUT and DELETE connection still work there', async () => {
    expect((await send('PUT', OLD_CONNECTION, OWNER, connectBody)).status).toBe(200)
    expect(world.saves).toHaveLength(1)
    expect((await send('DELETE', OLD_CONNECTION, OWNER)).status).toBe(204)
    expect(world.deletes).toEqual([SITE])
  })

  it('GET campaigns: the same body under both paths, for a session and for an OAuth grant', async () => {
    world.connection = storedConnection()
    world.spend = [spendRow('111', 'Black Friday', '2026-11-02', 12_500)]
    world.rates = [rate('2026-10-31', 'USD', '1.25'), rate('2026-10-31', 'EUR', '1')]
    world.utmRows = [{ value: 'Black Friday', revenue_minor: '40000', orders: '4' }]

    const old = await send('GET', OLD_CAMPAIGNS, OWNER)
    expect(old.status).toBe(200)
    const body = (await old.json()) as CampaignsBody
    expect(body.campaigns).toHaveLength(1)
    expect(body).toEqual(await (await send('GET', CAMPAIGNS, OWNER)).json())

    const bearer = { authorization: `Bearer ${OAUTH_TOKEN}` }
    expect((await send('GET', OLD_CAMPAIGNS, undefined, undefined, app, bearer)).status).toBe(200)
    expect((await send('GET', OLD_CAMPAIGNS, ADMIN)).status).toBe(403)
  })
})
