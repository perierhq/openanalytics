import { describe, expect, it } from 'vitest'
import { ApiError } from '@openanalytics/contracts'
import { AnalyticsService } from '../../apps/api/src/analytics/service.ts'
import type { AnalyticsGateway, GatewayResult } from '../../apps/api/src/gateway-client.ts'

/**
 * The read service: row mapping, §18 metadata, comparison and freshness
 * interpretation (plan Milestone 7 items 6/9). Driven by a scripted fake gateway
 * so the mapping is asserted exactly, with no infrastructure.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const NOW = new Date('2026-07-23T14:40:00.000Z')

/**
 * One report read, reused by the freshness cases: they differ only in what the
 * freshness probe and the pipeline heartbeat answer, never in what was asked.
 */
const PAGES_REQ = {
  siteId: SITE,
  from: '2026-07-16T00:00:00.000Z',
  to: '2026-07-23T00:00:00.000Z',
  timezone: 'UTC',
  limit: 100,
}

type Responder = (operation: string, params: Record<string, unknown>) => unknown[]

class FakeGateway implements AnalyticsGateway {
  readonly calls: { operation: string; params: Record<string, unknown> }[] = []
  readonly #responder: Responder
  constructor(responder: Responder) {
    this.#responder = responder
  }
  query<TRow = Record<string, unknown>>(
    operation: string,
    params: Record<string, unknown>,
  ): Promise<GatewayResult<TRow>> {
    this.calls.push({ operation, params })
    const rows = this.#responder(operation, params) as readonly TRow[]
    return Promise.resolve({
      operation,
      rows,
      meta: { row_count: rows.length, truncated: false, elapsed_ms: 1, cached: false },
    })
  }
}

function serviceWith(responder: (op: string, p: Record<string, unknown>) => unknown[]) {
  const gateway = new FakeGateway(responder)
  return { gateway, service: new AnalyticsService(gateway, { now: () => NOW }) }
}

describe('overview mapping and metadata', () => {
  it('maps totals and reports requested vs effective range and freshness', async () => {
    const { service, gateway } = serviceWith((op) => {
      if (op === 'analytics.freshness')
        return [{ watermark: '2026-07-23 14:35:00.000', buckets: '42' }]
      return [{ events: '48210', pageviews: '41003', visitors: '12874', billable_events: '45120' }]
    })

    const res = await service.overview({
      siteId: SITE,
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: 'UTC',
      compare: false,
    })

    expect(res.totals).toEqual({
      events: 48210,
      pageviews: 41003,
      visitors: 12874,
      billable_events: 45120,
    })
    expect(res.meta.requested_range).toEqual({
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
    })
    expect(res.meta.resolution).toBe('hour')
    // Watermark is 5 minutes old → fresh.
    expect(res.meta.freshness.state).toBe('ok')
    expect(res.meta.freshness.watermark).toBe('2026-07-23T14:35:00.000Z')
    expect(res.meta.comparison_range).toBeNull()
    expect(res.comparison).toBeNull()
    // Overview reads the hour rollup: one overview call + one freshness call.
    expect(gateway.calls.filter((c) => c.operation === 'analytics.overview_hour')).toHaveLength(1)
  })

  it('computes a comparison over the equal-length preceding period', async () => {
    const { service, gateway } = serviceWith((op, params) => {
      if (op === 'analytics.freshness')
        return [{ watermark: '2026-07-23 14:35:00.000', buckets: '10' }]
      // Distinguish the two windows by their `from`.
      const from = params['from'] as string
      const events = from.startsWith('2026-07-16') ? '100' : '80'
      return [{ events, pageviews: events, visitors: events, billable_events: events }]
    })

    const res = await service.overview({
      siteId: SITE,
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: 'UTC',
      compare: true,
    })

    expect(res.totals.events).toBe(100)
    expect(res.comparison?.totals.events).toBe(80)
    expect(res.meta.comparison_range).toEqual({
      from: '2026-07-09T00:00:00.000Z',
      to: '2026-07-16T00:00:00.000Z',
    })
    // The comparison window is queried with its own range.
    const overviewCalls = gateway.calls.filter((c) => c.operation === 'analytics.overview_hour')
    expect(overviewCalls).toHaveLength(2)
  })
})

describe('freshness interpretation', () => {
  it('distinguishes no_data from stale from ok', async () => {
    const empty = serviceWith((op) =>
      op === 'analytics.freshness' ? [{ watermark: null, buckets: '0' }] : [{}],
    )
    const emptyRes = await empty.service.pages({
      siteId: SITE,
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: 'UTC',
      limit: 100,
    })
    expect(emptyRes.meta.freshness.state).toBe('no_data')
    expect(emptyRes.meta.freshness.watermark).toBeNull()

    const stale = serviceWith((op) =>
      op === 'analytics.freshness'
        ? [{ watermark: '2026-07-23 10:00:00.000', buckets: '5' }] // 4h40m old
        : [],
    )
    const staleRes = await stale.service.pages({
      siteId: SITE,
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: 'UTC',
      limit: 100,
    })
    expect(staleRes.meta.freshness.state).toBe('stale')
  })

  it('calls a quiet site fresh when the pipeline is ticking (ADR-0025)', async () => {
    // Nobody visited for four hours, and the ingest loop ticked two seconds ago
    // with an empty queue. That is a quiet site, not a broken pipeline.
    const gateway = new FakeGateway((op) =>
      op === 'analytics.freshness' ? [{ watermark: '2026-07-23 10:40:00.000', buckets: '5' }] : [],
    )
    const service = new AnalyticsService(gateway, {
      now: () => NOW,
      pipelineHeartbeat: () =>
        Promise.resolve({
          lastTickAt: new Date(NOW.getTime() - 2_000),
          queueOldestAgeMs: 0,
        }),
    })

    const res = await service.pages(PAGES_REQ)
    expect(res.meta.freshness.state).toBe('ok')
    // The watermark still reports the site's own latest data instant.
    expect(res.meta.freshness.watermark).toBe('2026-07-23T10:40:00.000Z')
  })

  it('keeps a site with no buckets at no_data even while the pipeline is healthy', async () => {
    // A ticking heartbeat says the pipeline is fine; it must not promote a site
    // that has never rolled up a bucket to `ok`.
    const gateway = new FakeGateway((op) =>
      op === 'analytics.freshness' ? [{ watermark: null, buckets: '0' }] : [],
    )
    const service = new AnalyticsService(gateway, {
      now: () => NOW,
      pipelineHeartbeat: () =>
        Promise.resolve({
          lastTickAt: new Date(NOW.getTime() - 2_000),
          queueOldestAgeMs: 0,
        }),
    })

    const res = await service.pages(PAGES_REQ)
    expect(res.meta.freshness.state).toBe('no_data')
    expect(res.meta.freshness.watermark).toBeNull()
  })

  it('is stale when the ingest loop stopped ticking, however fresh the site data', async () => {
    // A bucket from one minute ago — the old rule would have said `ok` — but the
    // loop's last tick was fifteen minutes ago.
    const gateway = new FakeGateway((op) =>
      op === 'analytics.freshness' ? [{ watermark: '2026-07-23 14:39:00.000', buckets: '5' }] : [],
    )
    const service = new AnalyticsService(gateway, {
      now: () => NOW,
      pipelineHeartbeat: () =>
        Promise.resolve({
          lastTickAt: new Date(NOW.getTime() - 15 * 60_000),
          queueOldestAgeMs: 0,
        }),
    })

    const res = await service.pages(PAGES_REQ)
    expect(res.meta.freshness.state).toBe('stale')
  })

  it('is stale when the loop ticks in front of a backed-up queue', async () => {
    const gateway = new FakeGateway((op) =>
      op === 'analytics.freshness' ? [{ watermark: '2026-07-23 14:39:00.000', buckets: '5' }] : [],
    )
    const service = new AnalyticsService(gateway, {
      now: () => NOW,
      pipelineHeartbeat: () =>
        Promise.resolve({
          lastTickAt: new Date(NOW.getTime() - 2_000),
          queueOldestAgeMs: 20 * 60_000,
        }),
    })

    const res = await service.pages(PAGES_REQ)
    expect(res.meta.freshness.state).toBe('stale')
  })

  it('falls back to the watermark rule when no heartbeat has been written', async () => {
    // Pre-migration, or a worker that has not ticked since deploy. The old rule
    // applies: conservative, so a four-hour-old watermark still reads stale.
    const gateway = new FakeGateway((op) =>
      op === 'analytics.freshness' ? [{ watermark: '2026-07-23 10:40:00.000', buckets: '5' }] : [],
    )
    const service = new AnalyticsService(gateway, {
      now: () => NOW,
      pipelineHeartbeat: () => Promise.resolve(null),
    })

    const res = await service.pages(PAGES_REQ)
    expect(res.meta.freshness.state).toBe('stale')
    expect(res.meta.partial).toBe(false)
  })

  it('treats a failing heartbeat read as no heartbeat, not as degraded', async () => {
    // A Postgres blip on an advisory liveness row is not evidence about the
    // customer's data, so it must not turn a working read into `degraded`.
    const gateway = new FakeGateway((op) =>
      op === 'analytics.freshness' ? [{ watermark: '2026-07-23 10:40:00.000', buckets: '5' }] : [],
    )
    const service = new AnalyticsService(gateway, {
      now: () => NOW,
      pipelineHeartbeat: () => Promise.reject(new Error('connection terminated')),
    })

    const res = await service.pages(PAGES_REQ)
    expect(res.meta.freshness.state).toBe('stale')
    expect(res.meta.freshness.state).not.toBe('degraded')
    expect(res.meta.partial).toBe(false)
  })

  it('degrades freshness without failing the read when the probe throws', async () => {
    const gateway: AnalyticsGateway = {
      query: <TRow = Record<string, unknown>>(operation: string) => {
        if (operation === 'analytics.freshness') {
          return Promise.reject(new Error('down')) as Promise<GatewayResult<TRow>>
        }
        return Promise.resolve({
          operation,
          rows: [{ page_path: '/', views: '10', visitors: '8' }] as unknown as readonly TRow[],
          meta: { row_count: 1, truncated: false, elapsed_ms: 1, cached: false },
        })
      },
    }
    const service = new AnalyticsService(gateway, { now: () => NOW })
    const res = await service.pages({
      siteId: SITE,
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: 'UTC',
      limit: 100,
    })
    expect(res.meta.freshness.state).toBe('degraded')
    expect(res.meta.partial).toBe(true)
    // The data itself still came back.
    expect(res.items).toEqual([
      {
        page_path: '/',
        views: 10,
        visitors: 8,
        entrances: null,
        exits: null,
        bounces: null,
        bounce_rate: null,
      },
    ])
  })
})

describe('forced grain over a sub-grain range', () => {
  it('returns an empty series when day-floor snapping collapses the range', async () => {
    // Forcing day over a three-hour morning window floors both endpoints to the
    // same UTC midnight. The service must answer with an empty series and a
    // visibly zero-width effective range — never reach the gateway with a
    // from >= to range it would reject.
    const { service, gateway } = serviceWith((op) =>
      op === 'analytics.freshness' ? [{ watermark: '2026-07-23 14:35:00.000', buckets: '9' }] : [],
    )
    const res = await service.timeseries({
      siteId: SITE,
      from: '2026-07-23T06:00:00.000Z',
      to: '2026-07-23T09:00:00.000Z',
      timezone: 'UTC',
      compare: false,
      resolution: 'day',
    })
    expect(res.series).toEqual([])
    expect(res.meta.resolution).toBe('day')
    expect(res.meta.effective_range).toEqual({
      from: '2026-07-23T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
    })
    expect(gateway.calls.map((c) => c.operation)).toEqual(['analytics.freshness'])
  })
})

describe('performance percentile mapping', () => {
  it('names the merged t-digest array and derives the mean', async () => {
    const { service } = serviceWith((op) => {
      if (op === 'analytics.freshness')
        return [{ watermark: '2026-07-23 14:35:00.000', buckets: '9' }]
      return [
        {
          metric: 'LCP',
          device_type: 'desktop',
          samples: '100',
          value_sum: '180000',
          percentiles: [1700, 2100, 2600, 3100, 4200],
          good_samples: '70',
          needs_improvement_samples: '20',
          poor_samples: '10',
        },
      ]
    })
    const res = await service.performance({
      siteId: SITE,
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: 'UTC',
      limit: 100,
    })
    const row = res.items[0]!
    expect(row.mean).toBe(1800)
    expect([row.p50, row.p75, row.p90, row.p95, row.p99]).toEqual([1700, 2100, 2600, 3100, 4200])
  })
})

describe('a quarter-hour timezone is served, and an unservable one is a typed refusal', () => {
  it('reaches the gateway for Asia/Kolkata, on the same operation UTC uses', async () => {
    // The refusal this replaces was ADR-0011's, and it rested on the atom being
    // an hour. ADR-0079 step 3 moved the atom, so +05:30 is an ordinary zone:
    // same operation id, range snapped to the quarter it now buckets on.
    const { service, gateway } = serviceWith((op) => {
      if (op === 'analytics.freshness')
        return [{ watermark: '2026-07-23 14:35:00.000', buckets: '42' }]
      return [{ events: '10', pageviews: '8', visitors: '5', billable_events: '10' }]
    })
    const res = await service.overview({
      siteId: SITE,
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: 'Asia/Kolkata',
      compare: false,
    })
    expect(res.totals.events).toBe(10)
    const overview = gateway.calls.find((c) => c.operation === 'analytics.overview_hour')
    expect(overview).toBeDefined()
    expect(overview?.params['timezone']).toBe('Asia/Kolkata')
  })

  it('throws RESOLUTION_NOT_AVAILABLE and never calls the gateway for an offset the atom cannot express', async () => {
    // Pacific/Kiritimati ran -10:40 until 1979-10-01: forty minutes is not a
    // whole number of atoms, so the refusal principle (refuse rather than
    // approximate) still has exactly one class of range it applies to.
    const { service, gateway } = serviceWith(() => [])
    await expect(
      service.overview({
        siteId: SITE,
        from: '1975-01-01T00:00:00.000Z',
        to: '1975-01-08T00:00:00.000Z',
        timezone: 'Pacific/Kiritimati',
        compare: false,
      }),
    ).rejects.toMatchObject({ code: 'RESOLUTION_NOT_AVAILABLE' })
    expect(gateway.calls).toHaveLength(0)
  })
})

describe('session metrics — finalized/provisional layering', () => {
  // A long UTC range → day grain, so the 1d layers are exercised.
  const range = { from: '2026-01-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' }

  function sessionRow(bucket: string, over: Record<string, string>) {
    return {
      bucket,
      sessions: '0',
      engaged_sessions: '0',
      bounced_sessions: '0',
      pageviews: '0',
      total_session_duration_ms: '0',
      total_active_duration_ms: '0',
      ...over,
    }
  }

  it('reads both layers, merges them and derives bounce rate and averages at read', async () => {
    const { service, gateway } = serviceWith((op) => {
      if (op === 'analytics.freshness')
        return [{ watermark: '2026-07-07 23:00:00.000', buckets: '10' }]
      if (op === 'analytics.sessions_finalized_day')
        return [
          sessionRow('2026-01-15 00:00:00', {
            sessions: '2',
            bounced_sessions: '1',
            total_session_duration_ms: '100000',
          }),
        ]
      if (op === 'analytics.sessions_provisional_day')
        return [
          sessionRow('2026-03-15 00:00:00', {
            sessions: '2',
            bounced_sessions: '0',
            total_session_duration_ms: '300000',
          }),
        ]
      return []
    })

    const res = await service.sessions({
      siteId: SITE,
      ...range,
      timezone: 'UTC',
      finalizedThrough: new Date('2026-03-01T00:00:00.000Z'),
    })

    // Long UTC range → day layers. Split on the day boundary from finalized_through.
    const ops = gateway.calls.map((c) => c.operation)
    expect(ops).toContain('analytics.sessions_finalized_day')
    expect(ops).toContain('analytics.sessions_provisional_day')

    expect(res.totals.sessions).toBe(4)
    expect(res.totals.bounce_rate).toBe(0.25) // 1 of 4
    expect(res.totals.avg_session_duration_ms).toBe(100_000) // 400_000 / 4
    expect(res.layering.finalized_through).toBe('2026-03-01T00:00:00.000Z')
    expect(res.layering.provisional_through).toBe('2026-07-07T23:00:00.000Z')
    expect(res.series.map((s) => s.bucket)).toEqual([
      '2026-01-15T00:00:00.000Z',
      '2026-03-15T00:00:00.000Z',
    ])
  })

  it('reads only the provisional layer when the finalizer has never run', async () => {
    const { service, gateway } = serviceWith((op) => {
      if (op === 'analytics.freshness')
        return [{ watermark: '2026-07-07 23:00:00.000', buckets: '3' }]
      if (op === 'analytics.sessions_provisional_day')
        return [sessionRow('2026-02-02 00:00:00', { sessions: '5', bounced_sessions: '2' })]
      return []
    })
    const res = await service.sessions({
      siteId: SITE,
      ...range,
      timezone: 'UTC',
      finalizedThrough: null,
    })
    const ops = gateway.calls.map((c) => c.operation)
    expect(ops).toContain('analytics.sessions_provisional_day')
    expect(ops).not.toContain('analytics.sessions_finalized_day')
    expect(res.totals.sessions).toBe(5)
    expect(res.layering.finalized_through).toBeNull()
  })

  it('refuses only an offset the atom cannot express, and reaches the gateway otherwise', async () => {
    const { service, gateway } = serviceWith(() => [])
    await expect(
      service.sessions({
        siteId: SITE,
        from: '1975-01-01T00:00:00.000Z',
        to: '1975-01-08T00:00:00.000Z',
        timezone: 'Pacific/Kiritimati',
        finalizedThrough: null,
      }),
    ).rejects.toMatchObject({ code: 'RESOLUTION_NOT_AVAILABLE' })
    expect(gateway.calls).toHaveLength(0)

    await service.sessions({
      siteId: SITE,
      ...range,
      timezone: 'Asia/Kolkata',
      finalizedThrough: null,
    })
    expect(gateway.calls.length).toBeGreaterThan(0)
  })
})

describe('funnels', () => {
  it('maps per-step counts and conversion rates and picks the scope operation', async () => {
    const { service, gateway } = serviceWith((op) => {
      if (op === 'analytics.freshness')
        return [{ watermark: '2026-07-07 23:00:00.000', buckets: '9' }]
      if (op === 'analytics.funnel_visitor')
        return [{ step_1: '4200', step_2: '1890', step_3: '940' }]
      return []
    })
    const res = await service.funnel({
      siteId: SITE,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-08T00:00:00.000Z',
      timezone: 'UTC',
      scope: 'visitor',
      steps: ['/pricing', 'signup_started', 'signup'],
      windowMs: 1_800_000,
      withRevenue: false,
    })
    expect(gateway.calls.some((c) => c.operation === 'analytics.funnel_visitor')).toBe(true)
    expect(res.steps.map((s) => s.count)).toEqual([4200, 1890, 940])
    expect(res.steps[0]!.conversion_rate).toBe(1)
    expect(res.steps[2]!.conversion_rate).toBeCloseTo(940 / 4200)
    expect(res.meta.scope).toBe('visitor')
    expect(res.meta.window_ms).toBe(1_800_000)
    // Without revenue the money fields are absent, never zero.
    expect(res.steps[0]).not.toHaveProperty('buyers')
    expect(res.steps[0]).not.toHaveProperty('revenue_minor')
    expect(res).not.toHaveProperty('currency')
    const call = gateway.calls.find((c) => c.operation === 'analytics.funnel_visitor')
    expect(call?.params).toMatchObject({ with_revenue: false })
  })

  it('serves buyers and revenue per step, and the currency, when asked', async () => {
    const { service, gateway } = serviceWith((op) => {
      if (op === 'analytics.freshness')
        return [{ watermark: '2026-07-07 23:00:00.000', buckets: '9' }]
      if (op === 'analytics.funnel_session')
        return [
          {
            step_1: '40',
            step_2: '10',
            buyers_1: '3',
            buyers_2: '2',
            revenue_1: '11997',
            revenue_2: '7998',
            currency: 'EUR',
          },
        ]
      return []
    })
    const res = await service.funnel({
      siteId: SITE,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-08T00:00:00.000Z',
      timezone: 'UTC',
      scope: 'session',
      steps: ['/pricing', '{"event":"plan_selected","where":{"plan":"yearly"}}'],
      windowMs: 1_800_000,
      withRevenue: true,
    })
    const call = gateway.calls.find((c) => c.operation === 'analytics.funnel_session')
    expect(call?.params).toMatchObject({ with_revenue: true })
    expect(res.steps.map((s) => [s.buyers, s.revenue_minor])).toEqual([
      [3, 11997],
      [2, 7998],
    ])
    expect(res.currency).toBe('EUR')
  })

  it('reports a null currency when no step had a buyer', async () => {
    const { service } = serviceWith((op) => {
      if (op === 'analytics.funnel_visitor')
        return [{ step_1: '5', step_2: '1', buyers_1: '0', revenue_1: '0', currency: '' }]
      return []
    })
    const res = await service.funnel({
      siteId: SITE,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-08T00:00:00.000Z',
      timezone: 'UTC',
      scope: 'visitor',
      steps: ['/a', '/b'],
      windowMs: 1_000,
      withRevenue: true,
    })
    expect(res.currency).toBeNull()
    expect(res.steps[0]).toMatchObject({ buyers: 0, revenue_minor: 0 })
  })

  it('refuses a range beyond the synchronous cap (async is a follow-up)', async () => {
    const { service, gateway } = serviceWith(() => [])
    await expect(
      service.funnel({
        siteId: SITE,
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-07-01T00:00:00.000Z',
        timezone: 'UTC',
        scope: 'visitor',
        steps: ['/a', '/b'],
        windowMs: 1_000,
        withRevenue: false,
      }),
    ).rejects.toMatchObject({ code: 'RESOLUTION_NOT_AVAILABLE' })
    expect(gateway.calls).toHaveLength(0)
  })
})

describe('public geography coarsening', () => {
  it('suppresses cities when no threshold is set (G-008 fail-closed)', async () => {
    const { service } = serviceWith((op) => {
      if (op === 'analytics.freshness')
        return [{ watermark: '2026-07-23 14:35:00.000', buckets: '3' }]
      return [
        { country: 'US', city: 'New York', views: '500', visitors: '300' },
        { country: 'US', city: 'Smalltown', views: '5', visitors: '2' },
      ]
    })
    const res = await service.publicGeography(
      {
        siteId: SITE,
        from: '2026-07-16T00:00:00.000Z',
        to: '2026-07-23T00:00:00.000Z',
        timezone: 'UTC',
        limit: 100,
      },
      undefined,
    )
    expect(res.items.every((r) => r.city === null && r.city_suppressed)).toBe(true)
  })

  it('names cities at or above the threshold once set', async () => {
    const { service } = serviceWith((op) => {
      if (op === 'analytics.freshness')
        return [{ watermark: '2026-07-23 14:35:00.000', buckets: '3' }]
      return [
        { country: 'US', city: 'New York', views: '500', visitors: '300' },
        { country: 'US', city: 'Smalltown', views: '5', visitors: '2' },
      ]
    })
    const res = await service.publicGeography(
      {
        siteId: SITE,
        from: '2026-07-16T00:00:00.000Z',
        to: '2026-07-23T00:00:00.000Z',
        timezone: 'UTC',
        limit: 100,
      },
      100,
    )
    const named = res.items.filter((r) => !r.city_suppressed).map((r) => r.city)
    expect(named).toEqual(['New York'])
    expect(res.items.some((r) => r.city === 'Smalltown')).toBe(false)
  })

  it('never throws ApiError for a servable range', async () => {
    const { service } = serviceWith((op) =>
      op === 'analytics.freshness' ? [{ watermark: '2026-07-23 14:35:00.000', buckets: '1' }] : [],
    )
    await expect(
      service.publicGeography(
        {
          siteId: SITE,
          from: '2026-07-16T00:00:00.000Z',
          to: '2026-07-23T00:00:00.000Z',
          timezone: 'UTC',
          limit: 100,
        },
        50,
      ),
    ).resolves.toBeDefined()
    expect(ApiError).toBeDefined()
  })
})
