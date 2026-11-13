import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database, RevenueCredentialRow } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import type { AnalyticsGateway } from '../../apps/api/src/gateway-client.ts'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The revenue read surface (ADR-0033, D7). Milestone 12 Checkpoint 5.
 *
 * Driven through the real app with the real middleware chain, because what is
 * being asserted lives in the chain rather than in the service:
 *
 * - **`revenue:read` is owner-only, and this is its first consumer.** The
 *   capability has sat in the owner-only set of `packages/domain/src/authz.ts`
 *   since M2 with no route requiring it. An admin and a viewer keep full
 *   analytics access and get `403` here — which is the distinction 02 §19 draws
 *   and the one a shared mount with the analytics subtree would have erased.
 * - **A blocked site closes with `402`**, never an empty 200 (02 §23). Note the
 *   contrast with the *connection* routes, which stay reachable while blocked:
 *   reading the money is what billing gates, severing a provider link is not.
 * - **A provider outage is never revenue of zero** (acceptance criterion 3). A
 *   `degraded` credential serves the facts it has with the status visible, and
 *   the three empty states are decidable from one response.
 * - **Pagination is exact**: `has_more` comes from an over-fetch, not a count,
 *   and `next_cursor` round-trips into the next request.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'

const world = {
  membership: null as { role: string; isBillingOwner: boolean } | null,
  siteStatus: 'active',
  credential: null as RevenueCredentialRow | null,
  /** `revenue_attribution_state` — OUR pipeline's watermark, not the provider's. */
  attributionState: {
    siteId: SITE,
    computedThrough: new Date('2026-07-20T11:50:00.000Z'),
    runSeq: 4,
    lastRunAt: new Date('2026-07-20T11:50:00.000Z'),
    claimedBy: null,
    rollupRecomputeFrom: null,
    rollupGenerationSeq: 4,
  } as Record<string, unknown> | null,
  unconvertedFails: false,
  transactionRows: [] as Record<string, unknown>[],
  unconvertedRows: [] as Record<string, unknown>[],
  summaryRow: null as Record<string, unknown> | null,
  attributionRows: [] as Record<string, unknown>[],
  orderObjectRows: [] as Record<string, unknown>[],
  subscriptionTotalsRow: null as Record<string, unknown> | null,
  subscriptionDayRows: [] as Record<string, unknown>[],
  purchaseKindRows: [] as Record<string, unknown>[],
  purchaseKindsFail: false,
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async () => world.membership,
    getSiteBasics: async () => ({
      siteId: SITE,
      slug: 'demo',
      name: 'Demo',
      status: world.siteStatus,
      configVersion: 3,
      publishedImportRunId: null,
      importCutoverDate: null,
      reportingCurrency: 'USD',
    }),
    readRevenueCredential: async () => world.credential,
    getRevenueAttributionState: async () => world.attributionState,
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')
const { AnalyticsService } = await import('../../apps/api/src/analytics/service.ts')

function credential(overrides: Partial<RevenueCredentialRow> = {}): RevenueCredentialRow {
  return {
    id: 'cred-1',
    siteId: SITE,
    provider: 'stripe',
    encryptedApiKey: 'x',
    encryptedWebhookSecret: 'y',
    keyVersion: 'k1',
    apiKeyLast4: '4242',
    webhookToken: 'tok',
    status: 'active',
    createdByUserId: 'u-owner',
    connectedAt: new Date('2026-07-01T00:00:00.000Z'),
    lastVerifiedAt: new Date('2026-07-20T00:00:00.000Z'),
    lastSyncedAt: new Date('2026-07-20T09:00:00.000Z'),
    lastWebhookAt: new Date('2026-07-20T09:30:00.000Z'),
    lastError: null,
    disabledAt: null,
    backfillGeneration: 1,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-20T09:30:00.000Z'),
    ...overrides,
  } as RevenueCredentialRow
}

function auth(userId: string | null): Auth {
  return {
    api: {
      getSession: async () =>
        userId === null
          ? null
          : {
              user: {
                id: userId,
                email: `${userId}@example.test`,
                emailVerified: true,
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
              },
              session: { createdAt: new Date('2026-07-20T00:00:00.000Z') },
            },
    },
    handler: async () => new Response(null),
  } as unknown as Auth
}

let gatewayCalls: string[] = []
let gatewayParams: Record<string, Record<string, unknown>> = {}
/** The event pipeline's own freshness probe, which a revenue read must not
 * simply inherit (S6). */
const freshnessRows = {
  value: [{ watermark: '2026-07-20 09:00:00.000', buckets: '5' }] as unknown[],
}

function buildApp(userId: string | null) {
  gatewayCalls = []
  gatewayParams = {}
  const gateway: AnalyticsGateway = {
    query: <TRow = Record<string, unknown>>(operation: string, params?: unknown) => {
      gatewayCalls.push(operation)
      gatewayParams[operation] = (params ?? {}) as Record<string, unknown>
      let rows: unknown[]
      if (operation === 'analytics.freshness') {
        rows = freshnessRows.value
      } else if (operation.startsWith('analytics.revenue_summary')) {
        rows = world.summaryRow === null ? [] : [world.summaryRow]
      } else if (operation.startsWith('analytics.revenue_timeseries')) {
        rows = [{ bucket: '2026-07-20 10:00:00', ...(world.summaryRow ?? {}) }]
      } else if (operation === 'analytics.revenue_unconverted') {
        if (world.unconvertedFails) return Promise.reject(new Error('gateway said no'))
        rows = world.unconvertedRows
      } else if (operation === 'analytics.revenue_transactions') {
        rows = world.transactionRows
      } else if (operation === 'analytics.revenue_transaction_journey') {
        rows = world.attributionRows
      } else if (operation === 'analytics.revenue_order_objects') {
        rows = world.orderObjectRows
      } else if (operation === 'analytics.subscription_lifecycle_totals') {
        rows = world.subscriptionTotalsRow === null ? [] : [world.subscriptionTotalsRow]
      } else if (operation === 'analytics.subscription_timeseries_day') {
        rows = world.subscriptionDayRows
      } else if (operation === 'analytics.revenue_purchase_kinds') {
        if (world.purchaseKindsFail) return Promise.reject(new Error('gateway said no'))
        rows = world.purchaseKindRows
      } else {
        rows = []
      }
      return Promise.resolve({
        operation,
        rows: rows as TRow[],
        meta: { row_count: rows.length, truncated: false, cached: false, elapsed_ms: 1 },
      })
    },
  }

  const { logger } = createCapturedLogger()
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv('api', testEnv()),
    auth: auth(userId),
    db: {} as unknown as Database,
    analytics: new AnalyticsService(gateway, { now: () => new Date('2026-07-20T12:00:00.000Z') }),
  })
}

const RANGE = 'from=2026-07-20T00:00:00.000Z&to=2026-07-21T00:00:00.000Z&timezone=UTC'

const SUMMARY_ROW = {
  charge_gross_minor: '120000',
  refund_minor: '20000',
  dispute_withdrawn_minor: '5000',
  dispute_reinstated_minor: '0',
  fee_minor: '4000',
  net_minor: '91000',
  charge_count: '12',
  refund_count: '2',
  dispute_count: '1',
  unconverted_count: '3',
}

function transactionRow(objectId: string, occurredAt: string): Record<string, unknown> {
  return {
    object_id: objectId,
    provider: 'stripe',
    object_kind: 'charge',
    occurred_at: occurredAt,
    status: 'succeeded',
    livemode: '1',
    currency: 'eur',
    gross_minor: '10000',
    fee_minor: '500',
    net_minor: '9500',
    reporting_currency: 'usd',
    reporting_gross_minor: '10800',
    reporting_net_minor: '10260',
    conversion_source: 'ecb',
    conversion_rate: 1.08,
    conversion_rate_date: '2026-07-20',
    parent_object_id: '',
    order_id: 'pi_1',
    product_name: 'Pro plan',
    matched_via: 'conversion_event',
    confidence: 'exact',
    identity_scope: 'identified',
    purchase_kind: 'renewal',
  }
}

beforeEach(() => {
  world.membership = { role: 'owner', isBillingOwner: true }
  world.siteStatus = 'active'
  world.credential = credential()
  world.summaryRow = SUMMARY_ROW
  world.unconvertedRows = []
  world.transactionRows = []
  world.attributionRows = []
  world.orderObjectRows = []
  world.unconvertedFails = false
  world.subscriptionTotalsRow = null
  world.subscriptionDayRows = []
  world.purchaseKindRows = []
  world.purchaseKindsFail = false
  freshnessRows.value = [{ watermark: '2026-07-20 09:00:00.000', buckets: '5' }]
  world.attributionState = {
    siteId: SITE,
    computedThrough: new Date('2026-07-20T11:50:00.000Z'),
    runSeq: 4,
    lastRunAt: new Date('2026-07-20T11:50:00.000Z'),
    claimedBy: null,
    rollupRecomputeFrom: null,
    rollupGenerationSeq: 4,
  }
})

async function get(path: string, userId: string | null = 'u-owner'): Promise<Response> {
  return await buildApp(userId).request(path, { headers: { accept: 'application/json' } })
}

describe('authorization (revenue:read is owner-only)', () => {
  const paths = [
    `/v1/sites/${SITE}/revenue/summary?${RANGE}`,
    `/v1/sites/${SITE}/revenue/timeseries?${RANGE}`,
    `/v1/sites/${SITE}/revenue/transactions?${RANGE}`,
    `/v1/sites/${SITE}/revenue/transactions/ch_1/journey?${RANGE}`,
    `/v1/sites/${SITE}/revenue/subscriptions/summary?${RANGE}`,
    `/v1/sites/${SITE}/revenue/subscriptions/timeseries?${RANGE}`,
  ]

  it('lets an owner through', async () => {
    for (const path of paths) {
      world.orderObjectRows = [
        {
          object_id: 'ch_1',
          object_kind: 'charge',
          occurred_at: '2026-07-20 10:00:00.000',
          status: 'succeeded',
          currency: 'eur',
          gross_minor: '10000',
          reporting_currency: 'usd',
          reporting_gross_minor: '10800',
          conversion_source: 'ecb',
        },
      ]
      const response = await get(path)
      expect(response.status, path).toBe(200)
    }
  })

  it('refuses an admin with 403 while analytics stays open to them', async () => {
    world.membership = { role: 'admin', isBillingOwner: false }
    for (const path of paths) {
      const response = await get(path)
      expect(response.status, path).toBe(403)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('FORBIDDEN')
    }
    // The same member reads analytics without a capability, which is the whole
    // point of the two surfaces being separate mounts.
    const analytics = await get(`/v1/sites/${SITE}/analytics/overview?${RANGE}`)
    expect(analytics.status).toBe(200)
  })

  it('refuses a viewer with 403', async () => {
    world.membership = { role: 'viewer', isBillingOwner: false }
    const response = await get(paths[0] as string)
    expect(response.status).toBe(403)
  })

  it('answers 404 for a non-member, never 403', async () => {
    // "That is not yours" and "that does not exist" are the same answer to a
    // caller holding a site id.
    world.membership = null
    const response = await get(paths[0] as string)
    expect(response.status).toBe(404)
  })

  it('answers 401 with no session and never reaches the gateway', async () => {
    const response = await get(paths[0] as string, null)
    expect(response.status).toBe(401)
    expect(gatewayCalls).toHaveLength(0)
  })

  it('closes a billing-blocked site with 403, not an empty 200', async () => {
    world.siteStatus = 'suspended'
    for (const path of paths) {
      const response = await get(path)
      expect(response.status, path).toBe(403)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('SITE_SUSPENDED')
    }
    expect(gatewayCalls).toHaveLength(0)
  })
})

describe('metadata: the empty-state trichotomy (acceptance criterion 3)', () => {
  async function summaryMeta() {
    const response = await get(`/v1/sites/${SITE}/revenue/summary?${RANGE}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      meta: { revenue: Record<string, unknown> }
      totals: Record<string, number>
    }
    return body
  }

  it('reports not_connected for a site that never connected a provider', async () => {
    world.credential = null
    world.summaryRow = null
    const body = await summaryMeta()
    expect(body.meta.revenue).toEqual({
      provider: null,
      connection_status: 'not_connected',
      last_synced_at: null,
      last_webhook_at: null,
      rollup_through: '2026-07-20T11:50:00.000Z',
    })
    // Zero, and the status says it is not a number about this site's sales.
    expect(body.totals['net_minor']).toBe(0)
  })

  it('reports connected with genuine zeros for a site with no sales', async () => {
    world.summaryRow = null
    const body = await summaryMeta()
    expect(body.meta.revenue['connection_status']).toBe('connected')
    expect(body.meta.revenue['last_synced_at']).toBe('2026-07-20T09:00:00.000Z')
    expect(body.totals['net_minor']).toBe(0)
  })

  it('serves the facts it has under a degraded provider, never zeros', async () => {
    world.credential = credential({ status: 'degraded', lastError: 'unauthorized' })
    const body = await summaryMeta()
    expect(body.meta.revenue['connection_status']).toBe('degraded')
    // The totals are intact. This is the failure mode the milestone is named
    // after: legacy showed a provider outage as a confident "0 revenue".
    expect(body.totals['net_minor']).toBe(91_000)
    expect(body.totals['charge_gross_minor']).toBe(120_000)
    // And the last instant the data was actually correct is on the response.
    expect(body.meta.revenue['last_synced_at']).toBe('2026-07-20T09:00:00.000Z')
  })

  it('reports disconnected for a credential the customer disabled', async () => {
    world.credential = credential({ status: 'disabled', disabledAt: new Date() })
    const body = await summaryMeta()
    // `disabled` on the row, `disconnected` on the wire — and distinct from
    // `not_connected`, which is a different sentence on the empty-state screen.
    expect(body.meta.revenue['connection_status']).toBe('disconnected')
    expect(body.totals['net_minor']).toBe(91_000)
  })

  it('reports stale when OUR loop is behind, however healthy the provider is', async () => {
    // Acceptance criterion 3's internal half. The credential is `connected`, the
    // provider is answering, the event pipeline is fine — and the projection or
    // attribution loop stopped an hour ago, so the totals are frozen. Nothing in
    // the credential row can see that.
    world.attributionState = {
      siteId: SITE,
      computedThrough: new Date('2026-07-20T10:00:00.000Z'),
      runSeq: 4,
      lastRunAt: new Date('2026-07-20T10:00:00.000Z'),
      claimedBy: null,
      rollupRecomputeFrom: null,
      rollupGenerationSeq: 4,
    }
    const body = await summaryMeta()
    expect(body.meta.revenue['connection_status']).toBe('connected')
    expect(body.meta.revenue['rollup_through']).toBe('2026-07-20T10:00:00.000Z')
    const meta = body.meta as unknown as { freshness: { state: string; watermark: string } }
    expect(meta.freshness.state).toBe('stale')
    // The totals are still served in full. A stalled loop is not zero revenue.
    expect(body.totals['net_minor']).toBe(91_000)
  })

  it('reports no_data when our pipeline has never computed this site', async () => {
    world.attributionState = null
    const body = await summaryMeta()
    const meta = body.meta as unknown as { freshness: { state: string; watermark: null } }
    expect(meta.freshness.state).toBe('no_data')
    expect(meta.freshness.watermark).toBeNull()
    expect(body.meta.revenue['rollup_through']).toBeNull()
  })

  it('treats the epoch watermark as "never", not as 1970', async () => {
    world.attributionState = {
      siteId: SITE,
      computedThrough: new Date(0),
      runSeq: 0,
      lastRunAt: null,
      claimedBy: null,
      rollupRecomputeFrom: null,
      rollupGenerationSeq: 0,
    }
    const body = await summaryMeta()
    expect(body.meta.revenue['rollup_through']).toBeNull()
    const meta = body.meta as unknown as { freshness: { state: string } }
    expect(meta.freshness.state).toBe('no_data')
  })

  it('does not report no_data on a revenue-only site with no tracker', async () => {
    // The customer connected Stripe and never installed the tracker, so the
    // event pipeline has no bucket at all and the shared probe says `no_data` —
    // beside real revenue. Same shape ADR-0032 D5 fixed for imported-only sites.
    freshnessRows.value = [{ watermark: null, buckets: '0' }]
    const body = await summaryMeta()
    const meta = body.meta as unknown as { freshness: { state: string; watermark: string } }
    expect(meta.freshness.state).toBe('ok')
    expect(meta.freshness.watermark).toBe('2026-07-20T11:50:00.000Z')
    expect(body.totals['net_minor']).toBe(91_000)
  })

  it('marks the response partial when the unconverted read degrades', async () => {
    // S5. An empty `unconverted` must not be readable as "everything converted"
    // when it means "we could not find out".
    world.unconvertedFails = true
    const response = await get(`/v1/sites/${SITE}/revenue/summary?${RANGE}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      meta: { partial: boolean }
      totals: Record<string, number>
      unconverted: unknown[]
    }
    expect(body.meta.partial).toBe(true)
    expect(body.unconverted).toEqual([])
    // The totals are the answer that was asked for, and they are still served.
    expect(body.totals['net_minor']).toBe(91_000)
  })

  it('is not partial when the unconverted read simply found nothing', async () => {
    world.unconvertedRows = []
    const response = await get(`/v1/sites/${SITE}/revenue/summary?${RANGE}`)
    const body = (await response.json()) as { meta: { partial: boolean } }
    expect(body.meta.partial).toBe(false)
  })

  it('carries the §18 analytics meta beside the revenue block', async () => {
    const response = await get(`/v1/sites/${SITE}/revenue/summary?${RANGE}`)
    const body = (await response.json()) as { meta: Record<string, unknown> }
    expect(body.meta['data_sources']).toEqual(['live'])
    expect(body.meta['accuracy']).toBe('exact')
    expect(body.meta['resolution']).toBe('hour')
    // Freshness on a revenue read is about the REVENUE pipeline (S6). The
    // pageview probe's watermark is three hours old and would read `stale`; what
    // is reported instead is `revenue_attribution_state.computed_through`, ten
    // minutes old, which is what the totals were actually computed from.
    expect(body.meta['freshness']).toMatchObject({
      state: 'ok',
      watermark: '2026-07-20T11:50:00.000Z',
      as_of: '2026-07-20T12:00:00.000Z',
    })
    expect(body.meta['requested_range']).toEqual({
      from: '2026-07-20T00:00:00.000Z',
      to: '2026-07-21T00:00:00.000Z',
    })
  })
})

describe('summary', () => {
  it('returns the unconverted remainder per original currency', async () => {
    world.unconvertedRows = [
      {
        currency: 'isk',
        charge_gross_minor: '900000',
        refund_minor: '0',
        dispute_minor: '0',
        transactions: '3',
      },
    ]
    const response = await get(`/v1/sites/${SITE}/revenue/summary?${RANGE}`)
    const body = (await response.json()) as {
      totals: Record<string, number>
      unconverted: Record<string, unknown>[]
    }
    expect(body.unconverted).toEqual([
      {
        currency: 'ISK',
        charge_gross_minor: 900_000,
        refund_minor: 0,
        dispute_minor: 0,
        transactions: 3,
      },
    ])
    // The remainder is NOT in the totals, and the count says how much is missing.
    expect(body.totals['unconverted_count']).toBe(3)
  })

  it('adds a comparison period without a second remainder read', async () => {
    const response = await get(`/v1/sites/${SITE}/revenue/summary?${RANGE}&compare=true`)
    const body = (await response.json()) as {
      meta: { comparison_range: unknown }
      comparison: { totals: Record<string, number> } | null
    }
    expect(body.comparison?.totals['net_minor']).toBe(91_000)
    expect(body.meta.comparison_range).toEqual({
      from: '2026-07-19T00:00:00.000Z',
      to: '2026-07-20T00:00:00.000Z',
    })
    expect(gatewayCalls.filter((op) => op === 'analytics.revenue_unconverted')).toHaveLength(1)
  })

  it('names the site’s reporting currency on the totals', async () => {
    const response = await get(`/v1/sites/${SITE}/revenue/summary?${RANGE}`)
    const body = (await response.json()) as { totals: { currency: string } }
    expect(body.totals.currency).toBe('USD')
  })
})

describe('transactions pagination', () => {
  it('reports has_more exactly and hands back a usable cursor', async () => {
    // Three rows for a limit of two: the service over-fetches by one, so the
    // extra row is what makes `has_more` exact without a count query.
    world.transactionRows = [
      transactionRow('ch_3', '2026-07-20 12:00:00.000'),
      transactionRow('ch_2', '2026-07-20 11:00:00.000'),
      transactionRow('ch_1', '2026-07-20 10:00:00.000'),
    ]
    const response = await get(`/v1/sites/${SITE}/revenue/transactions?${RANGE}&limit=2`)
    const body = (await response.json()) as {
      items: { object_id: string }[]
      next_cursor: string | null
      has_more: boolean
    }
    expect(body.items.map((item) => item.object_id)).toEqual(['ch_3', 'ch_2'])
    expect(body.has_more).toBe(true)
    expect(body.next_cursor).not.toBeNull()

    // The gateway was asked for limit + 1.
    expect(gatewayParams['analytics.revenue_transactions']?.['limit']).toBe(3)

    // And the cursor is accepted on the next request, positioned at the last
    // item returned rather than at the over-fetched one.
    const next = await get(
      `/v1/sites/${SITE}/revenue/transactions?${RANGE}&limit=2&cursor=${encodeURIComponent(body.next_cursor as string)}`,
    )
    expect(next.status).toBe(200)
    expect(gatewayParams['analytics.revenue_transactions']?.['cursor_object_id']).toBe('ch_2')
    expect(gatewayParams['analytics.revenue_transactions']?.['cursor_occurred_at']).toBe(
      '2026-07-20T11:00:00.000Z',
    )
  })

  it('closes the page when the over-fetch returns nothing extra', async () => {
    world.transactionRows = [transactionRow('ch_1', '2026-07-20 10:00:00.000')]
    const response = await get(`/v1/sites/${SITE}/revenue/transactions?${RANGE}&limit=2`)
    const body = (await response.json()) as { has_more: boolean; next_cursor: string | null }
    expect(body.has_more).toBe(false)
    expect(body.next_cursor).toBeNull()
  })

  it('starts the first page at the range’s upper bound', async () => {
    await get(`/v1/sites/${SITE}/revenue/transactions?${RANGE}`)
    expect(gatewayParams['analytics.revenue_transactions']?.['cursor_occurred_at']).toBe(
      '2026-07-21T00:00:00.000Z',
    )
    expect(gatewayParams['analytics.revenue_transactions']?.['cursor_object_id']).toBe('')
  })

  it('refuses a malformed cursor rather than silently restarting', async () => {
    const response = await get(
      `/v1/sites/${SITE}/revenue/transactions?${RANGE}&cursor=not-a-cursor`,
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(gatewayCalls).not.toContain('analytics.revenue_transactions')
  })

  it('refuses a limit outside the contract’s bounds', async () => {
    for (const limit of ['0', '201', 'many']) {
      const response = await get(`/v1/sites/${SITE}/revenue/transactions?${RANGE}&limit=${limit}`)
      expect(response.status, limit).toBe(400)
    }
  })

  it('shapes money as minor units and nulls an unconverted reporting amount', async () => {
    world.transactionRows = [
      transactionRow('ch_1', '2026-07-20 10:00:00.000'),
      {
        ...transactionRow('ch_0', '2026-07-20 09:00:00.000'),
        conversion_source: 'unavailable',
        reporting_gross_minor: '0',
        reporting_net_minor: '0',
        matched_via: '',
        confidence: '',
      },
    ]
    const response = await get(`/v1/sites/${SITE}/revenue/transactions?${RANGE}`)
    const body = (await response.json()) as { items: Record<string, unknown>[] }
    const [converted, unconverted] = body.items as [
      Record<string, unknown>,
      Record<string, unknown>,
    ]

    expect(converted['gross']).toEqual({ amount_minor: 10_000, currency: 'EUR' })
    expect(converted['refund']).toEqual({ amount_minor: 0, currency: 'EUR' })
    expect(converted['net']).toEqual({ amount_minor: 9_500, currency: 'EUR' })
    expect(converted['reporting']).toEqual({ amount_minor: 10_260, currency: 'USD' })
    expect(converted['conversion']).toEqual({
      source: 'ecb',
      rate: 1.08,
      rate_at: '2026-07-20T00:00:00.000Z',
    })
    expect(converted['matched_via']).toBe('conversion_event')

    // Null together, and never zero: a zero is a number a client would add up.
    expect(unconverted['reporting']).toBeNull()
    expect(unconverted['conversion']).toBeNull()
    expect(unconverted['gross']).toEqual({ amount_minor: 10_000, currency: 'EUR' })
    // An unmatched transaction is a first-class outcome, not a gap.
    expect(unconverted['matched_via']).toBe('none')
    expect(unconverted['confidence']).toBe('none')
  })
})

describe('journey', () => {
  const objects = [
    {
      object_id: 'ch_1',
      object_kind: 'charge',
      occurred_at: '2026-07-20 10:00:00.000',
      status: 'refunded',
      currency: 'eur',
      gross_minor: '10000',
      reporting_currency: 'usd',
      reporting_gross_minor: '10800',
      conversion_source: 'ecb',
    },
    {
      object_id: 're_1',
      object_kind: 'refund',
      occurred_at: '2026-07-20 14:00:00.000',
      status: 'succeeded',
      currency: 'eur',
      gross_minor: '10000',
      reporting_currency: 'usd',
      reporting_gross_minor: '10800',
      conversion_source: 'ecb',
    },
  ]

  const attribution = {
    object_id: 'ch_1',
    provider: 'stripe',
    version: '3',
    occurred_at: '2026-07-20 10:00:00.000',
    model_version: '1',
    window_days: '30',
    matched_via: 'conversion_event',
    confidence: 'exact',
    identity_scope: 'identified',
    ft_session_id: 's-first',
    ft_session_start: '2026-07-01 08:00:00.000',
    ft_referrer_domain: 'google.com',
    ft_utm_source: '',
    ft_utm_medium: '',
    ft_utm_campaign: '',
    ft_utm_content: '',
    ft_utm_term: '',
    ft_entry_page: '/blog',
    lt_session_id: 's-last',
    lt_session_start: '2026-07-20 09:30:00.000',
    lt_referrer_domain: '',
    lt_utm_source: 'newsletter',
    lt_utm_medium: 'email',
    lt_utm_campaign: 'july',
    lt_utm_content: '',
    lt_utm_term: '',
    lt_entry_page: '/pricing',
    touchpoint_count: '2',
    journey_truncated: '0',
    journey: JSON.stringify([
      {
        session_id: 's-first',
        session_start: '2026-07-01T08:00:00.000Z',
        entry_page: '/blog',
        referrer_domain: 'google.com',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        utm_content: '',
        utm_term: '',
      },
      {
        session_id: 's-last',
        session_start: '2026-07-20T09:30:00.000Z',
        entry_page: '/pricing',
        referrer_domain: '',
        utm_source: 'newsletter',
        utm_medium: 'email',
        utm_campaign: 'july',
        utm_content: '',
        utm_term: '',
      },
    ]),
  }

  it('renders touchpoints and money events in one chronological timeline', async () => {
    world.attributionRows = [attribution]
    world.orderObjectRows = objects
    const response = await get(`/v1/sites/${SITE}/revenue/transactions/ch_1/journey?${RANGE}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      entries: { event_id: string; occurred_at: string; display: { kind: string; text: string } }[]
      first_touch: Record<string, unknown> | null
      last_touch: Record<string, unknown> | null
      matched_via: string
      confidence: string
      identity_scope: string
      model_version: number
      window_days: number
      touchpoint_count: number
      journey_truncated: boolean
    }

    expect(body.entries.map((entry) => entry.display.kind)).toEqual([
      'session_entry',
      'session_entry',
      'revenue_charge',
      'revenue_refund',
    ])
    // Oldest first, so the story reads forwards.
    expect(body.entries.map((entry) => entry.occurred_at)).toEqual([
      '2026-07-01T08:00:00.000Z',
      '2026-07-20T09:30:00.000Z',
      '2026-07-20T10:00:00.000Z',
      '2026-07-20T14:00:00.000Z',
    ])
    expect(body.entries[0]?.display.text).toBe('Session from google.com, landing on /blog')
    expect(body.entries[2]?.display.text).toBe('Payment was fully refunded')
    expect(body.entries[3]?.display.text).toBe('Refund was issued')

    expect(body.first_touch).toMatchObject({ session_id: 's-first', entry_page: '/blog' })
    expect(body.last_touch).toMatchObject({ session_id: 's-last', utm_source: 'newsletter' })
    expect(body.matched_via).toBe('conversion_event')
    expect(body.confidence).toBe('exact')
    expect(body.identity_scope).toBe('identified')
    expect(body.model_version).toBe(1)
    expect(body.window_days).toBe(30)
    expect(body.touchpoint_count).toBe(2)
    expect(body.journey_truncated).toBe(false)
  })

  it('bounds the order-objects read instead of scanning the site’s history', async () => {
    // S1. Without a time bound this reads every partition the site has ever had,
    // on every journey a customer opens: the sort key leads on site and object
    // id, so `WHERE object_id = ...` is a full-site scan.
    world.attributionRows = [attribution]
    world.orderObjectRows = objects
    await get(`/v1/sites/${SITE}/revenue/transactions/ch_1/journey?${RANGE}`)
    const params = gatewayParams['analytics.revenue_order_objects'] as Record<string, string>
    // A day below the viewed range absorbs the resolver's boundary snapping...
    expect(params['from']).toBe('2026-07-19T00:00:00.000Z')
    // ...and the ceiling runs past now, because a refund can be issued after the
    // range being looked at. Refunds only ever FOLLOW their charge, so nothing
    // relevant can sit below the floor.
    expect(Date.parse(params['to'] as string)).toBeGreaterThan(
      Date.parse('2026-07-21T00:00:00.000Z'),
    )
  })

  it('nulls every model field when the STORED row says the charge is unmatched', async () => {
    // The CP7 deviation, and the shape that produced it: the matcher writes a
    // row for an unmatched charge too (D6 — unmatched is a first-class outcome),
    // carrying `none`/`none`, empty touch blocks and `ft_session_start` of zero.
    // Reading row-PRESENCE as "matched" served that as a first-touch block of
    // empty strings dated 1970-01-01, beside model_version 1 and window_days 30.
    world.attributionRows = [
      {
        ...attribution,
        matched_via: 'none',
        confidence: 'none',
        identity_scope: '',
        visitor_id: '',
        user_id: '',
        ft_session_id: '',
        ft_session_start: '1970-01-01 00:00:00.000',
        ft_referrer_domain: '',
        ft_utm_source: '',
        ft_entry_page: '',
        lt_session_id: '',
        lt_session_start: '1970-01-01 00:00:00.000',
        lt_referrer_domain: '',
        lt_utm_source: '',
        lt_entry_page: '',
        touchpoint_count: '0',
        journey_truncated: '0',
        journey: '[]',
      },
    ]
    world.orderObjectRows = objects

    const response = await get(`/v1/sites/${SITE}/revenue/transactions/ch_1/journey?${RANGE}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>

    expect(body['matched_via']).toBe('none')
    expect(body['confidence']).toBe('none')
    // All five null, per the contract. Not an epoch-dated block of empty strings.
    expect(body['identity_scope']).toBeNull()
    expect(body['model_version']).toBeNull()
    expect(body['window_days']).toBeNull()
    expect(body['first_touch']).toBeNull()
    expect(body['last_touch']).toBeNull()
    // And nothing anywhere in the payload claims 1970.
    expect(JSON.stringify(body)).not.toContain('1970-01-01')
    expect(body['touchpoint_count']).toBe(0)
    expect(body['journey_truncated']).toBe(false)
    // The money events are still served — the transaction exists.
    expect((body['entries'] as unknown[]).length).toBe(2)
  })

  it('keeps the model fields on a matched charge', async () => {
    // The regression guard for the fix above: nulling on `none` must not have
    // nulled the matched case too.
    world.attributionRows = [attribution]
    world.orderObjectRows = objects
    const response = await get(`/v1/sites/${SITE}/revenue/transactions/ch_1/journey?${RANGE}`)
    const body = (await response.json()) as Record<string, unknown>
    expect(body['model_version']).toBe(1)
    expect(body['window_days']).toBe(30)
    expect(body['identity_scope']).toBe('identified')
    expect(body['first_touch']).not.toBeNull()
  })

  it('answers an unmatched transaction with its money events and none/none', async () => {
    world.attributionRows = []
    world.orderObjectRows = objects
    const response = await get(`/v1/sites/${SITE}/revenue/transactions/ch_1/journey?${RANGE}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      entries: unknown[]
      matched_via: string
      confidence: string
      identity_scope: null
      first_touch: null
      touchpoint_count: number
    }
    // Not a 404: the transaction plainly exists, it just has no journey.
    expect(body.entries).toHaveLength(2)
    expect(body.matched_via).toBe('none')
    expect(body.confidence).toBe('none')
    expect(body.identity_scope).toBeNull()
    expect(body.first_touch).toBeNull()
    expect(body.touchpoint_count).toBe(0)
  })

  it('answers 404 when the site has no such transaction', async () => {
    world.attributionRows = []
    world.orderObjectRows = []
    const response = await get(`/v1/sites/${SITE}/revenue/transactions/ch_missing/journey?${RANGE}`)
    expect(response.status).toBe(404)
  })
})

describe('timeseries', () => {
  it('routes to the hour rollup and bucket-labels in UTC', async () => {
    const response = await get(`/v1/sites/${SITE}/revenue/timeseries?${RANGE}`)
    expect(response.status).toBe(200)
    expect(gatewayCalls).toContain('analytics.revenue_timeseries_hour')
    const body = (await response.json()) as {
      series: { bucket: string; net_minor: number; currency: string }[]
    }
    expect(body.series[0]?.bucket).toBe('2026-07-20T10:00:00.000Z')
    expect(body.series[0]?.net_minor).toBe(91_000)
    expect(body.series[0]?.currency).toBe('USD')
  })

  it('refuses a minute resolution at the edge', async () => {
    const response = await get(`/v1/sites/${SITE}/revenue/timeseries?${RANGE}&resolution=minute`)
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('subscriptions (Perier gap 7)', () => {
  const WEEK = 'from=2026-07-13T00:00:00.000Z&to=2026-07-20T00:00:00.000Z&timezone=UTC'

  it('answers the totals and the purchase-kind split in the reporting currency', async () => {
    world.subscriptionTotalsRow = {
      mrr_start_minor: '1000',
      mrr_end_minor: '1366',
      active_start: '2',
      active_end: '2',
      new_mrr_minor: '699',
      churned_mrr_minor: '333',
      new_subscriptions: '1',
      churned_subscriptions: '1',
    }
    world.purchaseKindRows = [
      {
        purchase_kind: 'renewal',
        charges: '3',
        reporting_gross_minor: '2097',
        unconverted_count: '0',
      },
      { purchase_kind: 'new', charges: '1', reporting_gross_minor: '699', unconverted_count: '0' },
    ]
    const response = await get(`/v1/sites/${SITE}/revenue/subscriptions/summary?${WEEK}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      meta: { partial: boolean; revenue: { connection_status: string } }
      totals: Record<string, unknown>
      purchase_kinds: { purchase_kind: string; charge_gross_minor: number }[]
    }
    expect(body.totals).toMatchObject({
      currency: 'USD',
      mrr_start_minor: 1000,
      mrr_end_minor: 1366,
      churned_subscriptions: 1,
    })
    expect(body.purchase_kinds.map((row) => row.purchase_kind)).toEqual(['new', 'renewal'])
    expect(body.meta.partial).toBe(false)
    expect(body.meta.revenue.connection_status).toBe('connected')
    // Both reads get the summary's own range, not a wider one.
    expect(gatewayParams['analytics.subscription_lifecycle_totals']).toMatchObject({
      from: '2026-07-13T00:00:00.000Z',
      to: '2026-07-20T00:00:00.000Z',
    })
  })

  it('marks the summary partial, not empty, when the purchase-kind read fails', async () => {
    world.purchaseKindsFail = true
    const response = await get(`/v1/sites/${SITE}/revenue/subscriptions/summary?${WEEK}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { meta: { partial: boolean }; purchase_kinds: [] }
    expect(body.meta.partial).toBe(true)
    expect(body.purchase_kinds).toEqual([])
  })

  it('runs MRR forward per local day from the start level and fills every day', async () => {
    world.subscriptionTotalsRow = {
      mrr_start_minor: '1000',
      active_start: '2',
      trialing_start: '1',
    }
    world.subscriptionDayRows = [
      {
        bucket: '2026-07-15 00:00:00.000',
        net_mrr_minor: '699',
        active_delta: '1',
        trial_delta: '-1',
      },
    ]
    const response = await get(`/v1/sites/${SITE}/revenue/subscriptions/timeseries?${WEEK}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      meta: { resolution: string }
      series: { bucket: string; mrr_minor: number; active: number; trialing: number }[]
    }
    expect(body.meta.resolution).toBe('day')
    expect(body.series).toHaveLength(7)
    expect(body.series[0]).toMatchObject({ bucket: '2026-07-13T00:00:00.000Z', mrr_minor: 1000 })
    expect(body.series.map((p) => p.mrr_minor)).toEqual([1000, 1000, 1699, 1699, 1699, 1699, 1699])
    expect(body.series[6]).toMatchObject({ active: 3, trialing: 0 })
    expect(gatewayParams['analytics.subscription_timeseries_day']).toMatchObject({
      timezone: 'UTC',
    })
  })

  it('labels a transaction with its purchase kind, and a refund with null', async () => {
    world.transactionRows = [
      transactionRow('ch_2', '2026-07-20 10:00:00.000'),
      {
        ...transactionRow('re_1', '2026-07-20 09:00:00.000'),
        object_kind: 'refund',
        purchase_kind: '',
      },
    ]
    const response = await get(`/v1/sites/${SITE}/revenue/transactions?${RANGE}`)
    const body = (await response.json()) as { items: { purchase_kind: string | null }[] }
    expect(body.items.map((item) => item.purchase_kind)).toEqual(['renewal', null])
  })
})
