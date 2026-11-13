import type {
  RevenueAdapter,
  RevenueLifecycleAdapter,
  RevenueLifecycleListOutcome,
  RevenueLifecycleSyncResource,
  RevenueListOptions,
} from '@openanalytics/domain'
import type * as PostgresModule from '@openanalytics/postgres'
import type { Database } from '@openanalytics/postgres'
import { NOOP_METRICS, type Metrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeRevenueAdapter } from '../support/revenue-fixtures.ts'

/**
 * The lifecycle half of the revenue sync walk (Perier gap 7): subscriptions and
 * invoices after the three money resources, inside the same page budget, with
 * failures that never take the money sync down.
 */

interface StateRow {
  cursor: string | null
  windowStart: Date | null
  windowEnd: Date | null
  completedAt: Date | null
}

const store = {
  state: new Map<string, StateRow>(),
  subscriptionApplies: [] as { subscriptionId: string; force: boolean }[],
  invoiceWrites: [] as string[][],
  ledger: [] as string[],
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    readRevenueSyncState: async (_db: unknown, input: { resource: string }) => {
      const row = store.state.get(input.resource)
      return row === undefined ? null : { ...row, resource: input.resource }
    },
    saveRevenueSyncState: async (_db: unknown, input: StateRow & { resource: string }) => {
      store.state.set(input.resource, {
        cursor: input.cursor,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        completedAt: input.completedAt,
      })
    },
    recordRevenueProviderEvent: async (_db: unknown, input: { providerEventId: string }) => {
      store.ledger.push(input.providerEventId)
      return { id: `l-${store.ledger.length}`, firstSeen: true, status: 'received' }
    },
    markRevenueProviderEvent: async () => {},
    applyRevenueObservation: async () => ({
      decision: { action: 'apply', version: 1, reason: 'first_observation' },
      objectRowId: 'o',
    }),
    applyRevenueSubscriptionObservation: async (
      _db: unknown,
      input: { observation: { subscriptionId: string }; force?: boolean },
    ) => {
      store.subscriptionApplies.push({
        subscriptionId: input.observation.subscriptionId,
        force: input.force === true,
      })
      return { decision: { action: 'apply', version: 1, reason: 'first_observation' } }
    },
    recordRevenueInvoiceHints: async (_db: unknown, input: { hints: { invoiceId: string }[] }) => {
      store.invoiceWrites.push(input.hints.map((h) => h.invoiceId))
      return { written: input.hints.length }
    },
  }
})

const { syncAllRevenueResources } = await import('../../apps/worker/src/revenue/sync.ts')

const WINDOW_START = new Date('2026-08-01T00:00:00.000Z')
const WINDOW_END = new Date('2026-11-01T00:00:00.000Z')

function subscription(id: string) {
  return {
    subscriptionId: id,
    snapshotAt: new Date('2026-03-01T00:00:00.000Z'),
    normalized: {
      status: 'active',
      livemode: false,
      customer_id: 'cus',
      currency: 'eur',
      items: [],
      created_at: '2026-03-01T00:00:00.000Z',
      started_at: '2026-03-01T00:00:00.000Z',
      trial_start: null,
      trial_end: null,
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      ended_at: null,
    },
  }
}

function lifecycleAdapter(
  list: (
    resource: RevenueLifecycleSyncResource,
    options: RevenueListOptions,
  ) => RevenueLifecycleListOutcome,
): RevenueAdapter & RevenueLifecycleAdapter & { calls: [string, RevenueListOptions][] } {
  const calls: [string, RevenueListOptions][] = []
  return {
    ...fakeRevenueAdapter(),
    calls,
    listLifecycle: async (_key, resource, options) => {
      calls.push([resource, options])
      await Promise.resolve()
      return list(resource, options)
    },
    fetchSubscription: async () => ({ ok: true, observation: null }),
  }
}

const page = (
  overrides: Partial<{
    subscriptions: ReturnType<typeof subscription>[]
    invoiceHints: { invoiceId: string }[]
    nextCursor: string | null
    hasMore: boolean
  }> = {},
): RevenueLifecycleListOutcome =>
  ({
    ok: true,
    page: { subscriptions: [], invoiceHints: [], nextCursor: null, hasMore: false, ...overrides },
  }) as unknown as RevenueLifecycleListOutcome

function run(
  adapter: RevenueAdapter,
  options: { mode?: 'backfill' | 'reconcile'; maxPages?: number; metrics?: Metrics } = {},
) {
  const captured = createCapturedLogger()
  const { logger } = captured
  return {
    captured,
    outcome: syncAllRevenueResources(
      { db: {} as Database, logger, metrics: options.metrics ?? NOOP_METRICS },
      {
        target: { credentialId: 'cred', siteId: 'site', provider: 'stripe', apiKey: 'rk' },
        adapter,
        mode: options.mode ?? 'backfill',
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        pageSize: 100,
        maxPages: options.maxPages ?? 20,
      },
    ),
  }
}

beforeEach(() => {
  store.state.clear()
  store.subscriptionApplies.length = 0
  store.invoiceWrites.length = 0
  store.ledger.length = 0
})

describe('syncAllRevenueResources — the lifecycle half', () => {
  it('walks subscriptions from the epoch on a backfill and invoices in the money window', async () => {
    const adapter = lifecycleAdapter((resource) =>
      resource === 'subscriptions'
        ? page({ subscriptions: [subscription('sub_old'), subscription('sub_new')] })
        : page({ invoiceHints: [{ invoiceId: 'in_1' }] }),
    )
    const { outcome } = run(adapter)
    const result = await outcome
    expect(result).toMatchObject({ ok: true, completed: true })
    expect(result.counts).toMatchObject({ subscriptions: 2, invoiceHints: 1 })

    const [subs, invoices] = adapter.calls
    expect(subs?.[0]).toBe('subscriptions')
    expect(subs?.[1].windowStart.getTime()).toBe(0)
    expect(invoices?.[0]).toBe('invoices')
    expect(invoices?.[1].windowStart).toEqual(WINDOW_START)

    expect(store.subscriptionApplies.map((a) => a.subscriptionId)).toEqual(['sub_old', 'sub_new'])
    expect(store.invoiceWrites).toEqual([['in_1']])
    expect(store.ledger).toContain('backfill:subscriptions:sub_old')
    expect(store.state.get('subscriptions')?.completedAt).not.toBeNull()
  })

  it('keeps the trailing window for a reconcile sweep’s subscriptions', async () => {
    const adapter = lifecycleAdapter(() => page())
    await run(adapter, { mode: 'reconcile' }).outcome
    expect(adapter.calls[0]?.[1].windowStart).toEqual(WINDOW_START)
  })

  it('stops at the shared budget, reports incomplete and resumes from the cursor', async () => {
    const adapter = lifecycleAdapter((resource, options) =>
      resource === 'subscriptions' && options.cursor === null
        ? page({ subscriptions: [subscription('sub_1')], nextCursor: 'sub_1', hasMore: true })
        : page({ subscriptions: resource === 'subscriptions' ? [subscription('sub_2')] : [] }),
    )
    // Three money pages (one per resource) + one lifecycle page.
    const first = await run(adapter, { maxPages: 4 }).outcome
    expect(first).toMatchObject({ ok: true, completed: false })
    expect(store.state.get('subscriptions')?.cursor).toBe('sub_1')

    const second = await run(adapter, { maxPages: 4 }).outcome
    expect(second).toMatchObject({ ok: true, completed: true })
    expect(adapter.calls.filter(([r]) => r === 'subscriptions').at(-1)?.[1].cursor).toBe('sub_1')
    expect(store.subscriptionApplies.map((a) => a.subscriptionId)).toEqual(['sub_1', 'sub_2'])
  })

  it('never fails the money sync when the key cannot read subscriptions', async () => {
    const failures: Record<string, unknown>[] = []
    const metrics: Metrics = {
      ...NOOP_METRICS,
      increment: (name, labels) => {
        if (name === 'worker_revenue_lifecycle_sync_failed') failures.push(labels ?? {})
      },
    }
    const adapter = lifecycleAdapter((resource) =>
      resource === 'subscriptions'
        ? { ok: false, reason: 'unauthorized', detail: 'stripe responded 403' }
        : page({ invoiceHints: [{ invoiceId: 'in_1' }] }),
    )
    const { outcome, captured } = run(adapter, { metrics })
    expect(await outcome).toMatchObject({ ok: true, completed: true })
    expect(failures).toEqual([
      { resource: 'subscriptions', reason: 'unauthorized', mode: 'backfill' },
    ])
    expect(captured.find('revenue_lifecycle_sync_failed')).toHaveLength(1)
    // The other lifecycle resource still ran.
    expect(store.invoiceWrites).toEqual([['in_1']])
  })

  it('leaves an adapter without a lifecycle half exactly as before', async () => {
    const result = await run(fakeRevenueAdapter()).outcome
    expect(result).toMatchObject({ ok: true, completed: true })
    expect(result.counts).toMatchObject({ subscriptions: 0, invoiceHints: 0 })
    expect(store.state.has('subscriptions')).toBe(false)
  })
})
