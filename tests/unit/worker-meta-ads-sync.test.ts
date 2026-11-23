import type * as PostgresModule from '@openanalytics/postgres'
import type {
  Database,
  MetaAdsConnectionRecord,
  RecordMetaAdsSyncInput,
  UpsertMetaAdsSpendInput,
} from '@openanalytics/postgres'
import {
  createCredentialVault,
  type MetaAdsClient,
  type MetaInsightsInput,
  type MetaInsightsResult,
} from '@openanalytics/integrations'
import { metaAdsCredentialAad, type MetaSpendRow } from '@openanalytics/domain'
import type { Metrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Meta Ads sync loop (migration 0052): which connections it picks, the
 * window it reads, what it records for each failure category, how it backs
 * off, and that neither the token nor anything carrying it reaches a log line
 * or an error.
 */

const TOKEN = 'EAAG' + 'TopSecretToken'.repeat(5)
const vault = createCredentialVault(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
)
const NOW = new Date('2026-11-22T12:00:00.000Z')
const HOUR = 3_600_000

const state = {
  due: [] as MetaAdsConnectionRecord[],
  dueArgs: [] as { now: Date; limit: number; includeUndecryptable?: boolean }[],
  upserts: [] as { siteId: string; rows: MetaSpendRow[] }[],
  upsertGuards: [] as { connectedAt: Date; adAccountId: string; backfillCursor?: string }[],
  records: [] as RecordMetaAdsSyncInput[],
  failList: false,
  failUpsert: null as Error | null,
  /** The connection was disconnected or switched while the sync ran. */
  superseded: false,
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    listDueMetaAdsConnections: async (
      _db: unknown,
      input: { now: Date; limit: number; includeUndecryptable?: boolean },
    ) => {
      if (state.failList) throw new Error(`connection reset ${TOKEN}`)
      state.dueArgs.push(input)
      return state.due
    },
    upsertMetaAdsSpend: async (_db: unknown, input: UpsertMetaAdsSpendInput) => {
      if (state.failUpsert !== null) throw state.failUpsert
      if (state.superseded) return null
      if (input.rows.length > 0) state.upserts.push({ siteId: input.siteId, rows: [...input.rows] })
      state.upsertGuards.push({
        connectedAt: input.connectedAt,
        adAccountId: input.adAccountId,
        ...(input.backfillCursor === undefined ? {} : { backfillCursor: input.backfillCursor }),
      })
      return input.rows.length
    },
    recordMetaAdsSync: async (_db: unknown, input: RecordMetaAdsSyncInput) => {
      state.records.push(input)
      return true
    },
  }
})

const { syncMetaAdsOnce, startMetaAdsSync } = await import('../../apps/worker/src/ads/meta-sync.ts')

function connection(siteId: string, overrides: Partial<MetaAdsConnectionRecord> = {}) {
  const adAccountId = overrides.adAccountId ?? 'act_100'
  const encrypted = vault.encrypt(TOKEN, metaAdsCredentialAad({ siteId, adAccountId }))
  return {
    siteId,
    adAccountId,
    adAccountName: 'Acme',
    currency: 'USD',
    accountStatus: 1,
    encryptedToken: encrypted.stored,
    keyVersion: encrypted.keyVersion,
    tokenLast4: TOKEN.slice(-4),
    status: 'active',
    connectedAt: new Date('2026-11-01T00:00:00.000Z'),
    nextSyncAt: new Date('2026-11-22T00:00:00.000Z'),
    lastAttemptedAt: null,
    lastSyncedAt: null,
    backfillCursor: null,
    lastError: null,
    ...overrides,
  } satisfies MetaAdsConnectionRecord
}

const spendRow = (campaignId: string, day: string): MetaSpendRow => ({
  campaignId,
  campaignName: `C${campaignId}`,
  day,
  spendMinor: 100,
  currency: 'USD',
})

const NO_USAGE: { percent: number | null; regainMinutes: number } = {
  percent: null,
  regainMinutes: 0,
}

function client(answer: (input: MetaInsightsInput) => MetaInsightsResult) {
  const calls: MetaInsightsInput[] = []
  const impl: MetaAdsClient = {
    verifyAccount: async () => {
      throw new Error('the worker never verifies')
    },
    fetchInsights: async (input) => {
      calls.push(input)
      return answer(input)
    },
  }
  return { impl, calls }
}

function recordingMetrics() {
  const increments: { name: string; labels: Record<string, string> | undefined; value: number }[] =
    []
  const metrics = {
    increment: (name: string, labels?: Record<string, string>, value?: number) => {
      increments.push({ name, labels, value: value ?? 1 })
    },
    gauge: () => {},
    observe: () => {},
  } as unknown as Metrics
  return { metrics, increments }
}

function deps(metaClient: MetaAdsClient, backoff = { until: 0 }) {
  const captured = createCapturedLogger()
  const { metrics, increments } = recordingMetrics()
  return {
    deps: {
      db: {} as Database,
      logger: captured.logger,
      metrics,
      client: metaClient,
      vault,
      now: () => NOW,
      backoff,
    },
    captured,
    increments,
  }
}

const ok = (rows: MetaSpendRow[], usage = NO_USAGE): MetaInsightsResult => ({
  ok: true,
  rows,
  skipped: 0,
  pages: 1,
  usage,
})

beforeEach(() => {
  state.due = []
  state.dueArgs = []
  state.upserts = []
  state.upsertGuards = []
  state.records = []
  state.failList = false
  state.failUpsert = null
  state.superseded = false
})

describe('a successful sync', () => {
  it('reads the recent three days first, then ninety days back in chunks, and is due again in six hours', async () => {
    state.due = [connection('s1')]
    const { impl, calls } = client((input) =>
      input.since === '2026-11-20' ? ok([spendRow('1', '2026-11-20')]) : ok([]),
    )
    const { deps: d, increments } = deps(impl)

    const result = await syncMetaAdsOnce(d)

    expect(result).toEqual({ sites: 1, failed: 0, rows: 1 })
    const base = { adAccountId: 'act_100', token: TOKEN, fallbackCurrency: 'USD' }
    expect(calls).toEqual([
      { ...base, since: '2026-11-20', until: '2026-11-22' },
      { ...base, since: '2026-08-25', until: '2026-09-23' },
      { ...base, since: '2026-09-24', until: '2026-10-23' },
      { ...base, since: '2026-10-24', until: '2026-11-19' },
    ])
    expect(state.upserts).toEqual([{ siteId: 's1', rows: [spendRow('1', '2026-11-20')] }])
    // Every write names the connection the sync read, and each backfill chunk
    // moves the cursor with its spend.
    const connectedAt = new Date('2026-11-01T00:00:00.000Z')
    expect(state.upsertGuards).toEqual([
      { connectedAt, adAccountId: 'act_100' },
      { connectedAt, adAccountId: 'act_100', backfillCursor: '2026-09-23' },
      { connectedAt, adAccountId: 'act_100', backfillCursor: '2026-10-23' },
      { connectedAt, adAccountId: 'act_100', backfillCursor: '2026-11-19' },
    ])
    expect(state.records).toEqual([
      {
        siteId: 's1',
        connectedAt,
        at: NOW,
        error: null,
        completed: true,
        nextSyncAt: new Date(NOW.getTime() + 6 * HOUR),
      },
    ])
    expect(increments).toContainEqual({
      name: 'worker_meta_ads_sync',
      labels: { status: 'ok' },
      value: 1,
    })
  })

  it('keeps the backfill progress when a first sync is cut short, and resumes after it', async () => {
    state.due = [connection('s1')]
    const backoff = { until: 0 }
    const first = client((input) =>
      input.since === '2026-09-24'
        ? {
            ok: false,
            reason: 'rate_limited',
            detail: 'insights responded 400 (code 80000)',
            rows: [],
            usage: { percent: 100, regainMinutes: 30 },
          }
        : ok([]),
    )
    await syncMetaAdsOnce(deps(first.impl, backoff).deps)
    expect(first.calls.map((c) => c.since)).toEqual(['2026-11-20', '2026-08-25', '2026-09-24'])
    expect(state.upsertGuards.map((g) => g.backfillCursor)).toEqual(['2026-09-23'])
    expect(state.records).toEqual([
      expect.objectContaining({ error: 'rate_limited', completed: false }),
    ])

    // The next attempt: the cursor the first one stored is where it resumes.
    state.due = [connection('s1', { backfillCursor: '2026-09-23' })]
    state.records = []
    state.upsertGuards = []
    const second = client(() => ok([]))
    await syncMetaAdsOnce(deps(second.impl).deps)
    expect(second.calls.map((c) => [c.since, c.until])).toEqual([
      ['2026-11-20', '2026-11-22'],
      ['2026-09-24', '2026-10-23'],
      ['2026-10-24', '2026-11-19'],
    ])
    expect(state.records[0]).toMatchObject({ error: null, completed: true })
  })

  it('stops calling Meta with a token once its connection was disconnected or switched', async () => {
    state.due = [connection('s1'), connection('s2')]
    state.superseded = true
    const { impl, calls } = client(() => ok([spendRow('1', '2026-11-20')]))
    const { deps: d, captured } = deps(impl)
    const result = await syncMetaAdsOnce(d)
    // One read per site: the write that found the connection gone ends it.
    expect(calls.map((c) => c.since)).toEqual(['2026-11-20', '2026-11-20'])
    expect(result).toEqual({ sites: 2, failed: 0, rows: 0 })
    expect(captured.find('meta_ads_sync_superseded')).toHaveLength(2)
  })

  it('stops a first sync between chunks when usage runs hot, and comes back after the backoff', async () => {
    state.due = [connection('s1'), connection('s2')]
    const backoff = { until: 0 }
    const { impl, calls } = client(() => ok([], { percent: 90, regainMinutes: 20 }))
    await syncMetaAdsOnce(deps(impl, backoff).deps)
    expect(calls.map((c) => c.since)).toEqual(['2026-11-20'])
    expect(state.records).toEqual([
      expect.objectContaining({
        siteId: 's1',
        error: null,
        completed: false,
        nextSyncAt: new Date(NOW.getTime() + 20 * 60_000),
      }),
    ])
    expect(backoff.until).toBe(NOW.getTime() + 20 * 60_000)
  })

  it('reads the last three days once a sync has completed', async () => {
    state.due = [connection('s1', { lastSyncedAt: new Date('2026-11-22T05:00:00.000Z') })]
    const { impl, calls } = client(() => ok([]))
    await syncMetaAdsOnce(deps(impl).deps)
    expect(calls[0]).toMatchObject({ since: '2026-11-20', until: '2026-11-22' })
    expect(state.records[0]).toMatchObject({ error: null, completed: true })
  })
})

describe('the failure categories', () => {
  it('records unauthorized, which stops polling, and carries on with the next site', async () => {
    state.due = [connection('s1'), connection('s2')]
    const { impl, calls } = client((input) =>
      input.adAccountId === 'act_100' && calls.length === 1
        ? {
            ok: false,
            reason: 'unauthorized',
            detail: 'insights responded 400 (code 190)',
            rows: [],
            usage: NO_USAGE,
          }
        : ok([]),
    )
    const result = await syncMetaAdsOnce(deps(impl).deps)
    expect(result).toEqual({ sites: 2, failed: 1, rows: 0 })
    expect(state.records.map((r) => [r.siteId, r.error, r.completed])).toEqual([
      ['s1', 'unauthorized', false],
      ['s2', null, true],
    ])
  })

  it('keeps rows read before a rate limit, waits Meta’s estimate (at least an hour), and backs the whole loop off', async () => {
    state.due = [connection('s1'), connection('s2')]
    const backoff = { until: 0 }
    const { impl, calls } = client(() => ({
      ok: false,
      reason: 'rate_limited',
      detail: 'usage at 80% after 1 pages',
      rows: [spendRow('1', '2026-11-20')],
      usage: { percent: 80, regainMinutes: 90 },
    }))
    const { deps: d, captured } = deps(impl, backoff)
    const result = await syncMetaAdsOnce(d)

    expect(calls).toHaveLength(1)
    expect(result).toEqual({ sites: 1, failed: 1, rows: 1 })
    expect(state.upserts).toEqual([{ siteId: 's1', rows: [spendRow('1', '2026-11-20')] }])
    expect(state.records).toEqual([
      expect.objectContaining({
        siteId: 's1',
        error: 'rate_limited',
        completed: false,
        nextSyncAt: new Date(NOW.getTime() + 90 * 60_000),
      }),
    ])
    expect(backoff.until).toBe(NOW.getTime() + 90 * 60_000)
    expect(captured.find('meta_ads_sync_backing_off')).toHaveLength(1)

    // The next tick inside the backoff calls nobody.
    state.records = []
    const again = await syncMetaAdsOnce(d)
    expect(again).toEqual({ sites: 0, failed: 0, rows: 0 })
    expect(calls).toHaveLength(1)
    expect(state.dueArgs).toHaveLength(1)
  })

  it('finishes the site whose last page crossed 75%, then stops the tick', async () => {
    const synced = { lastSyncedAt: new Date('2026-11-22T05:00:00.000Z') }
    state.due = [connection('s1', synced), connection('s2', synced)]
    const backoff = { until: 0 }
    const { impl, calls } = client(() => ok([], { percent: 82, regainMinutes: 0 }))
    await syncMetaAdsOnce(deps(impl, backoff).deps)
    expect(calls).toHaveLength(1)
    expect(state.records).toEqual([
      expect.objectContaining({ siteId: 's1', error: null, completed: true }),
    ])
    expect(backoff.until).toBe(NOW.getTime() + 15 * 60_000)
  })

  it('records unavailable, retries the site in an hour, and stops the tick', async () => {
    state.due = [connection('s1'), connection('s2')]
    const { impl, calls } = client(() => ({
      ok: false,
      reason: 'unavailable',
      detail: 'insights responded 503',
      rows: [],
      usage: NO_USAGE,
    }))
    await syncMetaAdsOnce(deps(impl).deps)
    expect(calls).toHaveLength(1)
    expect(state.records).toEqual([
      expect.objectContaining({
        siteId: 's1',
        error: 'unavailable',
        nextSyncAt: new Date(NOW.getTime() + HOUR),
      }),
    ])
  })

  it('records invalid_response and waits a full interval', async () => {
    state.due = [connection('s1')]
    const { impl } = client(() => ({
      ok: false,
      reason: 'invalid_response',
      detail: 'insights body has no data array',
      rows: [],
      usage: NO_USAGE,
    }))
    await syncMetaAdsOnce(deps(impl).deps)
    expect(state.records[0]).toMatchObject({
      error: 'invalid_response',
      nextSyncAt: new Date(NOW.getTime() + 6 * HOUR),
    })
  })

  it('records a token this keyring cannot decrypt as credential_undecryptable, without calling Meta or stopping polling', async () => {
    const moved = connection('s1')
    // Bound to another ad account: the AAD no longer matches.
    state.due = [{ ...moved, adAccountId: 'act_999' }, connection('s2')]
    const { impl, calls } = client(() => ok([]))
    const { deps: d, captured, increments } = deps(impl)
    const result = await syncMetaAdsOnce(d)
    expect(result).toEqual({ sites: 2, failed: 1, rows: 0 })
    expect(calls.every((c) => c.adAccountId === 'act_100')).toBe(true)
    expect(state.records[0]).toMatchObject({
      siteId: 's1',
      error: 'credential_undecryptable',
      completed: false,
      nextSyncAt: new Date(NOW.getTime() + 6 * HOUR),
    })
    expect(captured.find('meta_ads_token_undecryptable')[0]).toMatchObject({
      reason: 'authentication_failed',
      retryable: true,
    })
    expect(increments).toContainEqual({
      name: 'worker_meta_ads_sync',
      labels: { status: 'credential_undecryptable' },
      value: 1,
    })
  })
})

describe('the token never reaches a log line or an error', () => {
  it('logs categories and counts only, even when a database error carries the token', async () => {
    state.due = [connection('s1'), connection('s2')]
    state.failUpsert = new Error(`insert failed: params (${TOKEN})`)
    const { impl } = client(() => ok([spendRow('1', '2026-11-20')]))
    const { deps: d, captured } = deps(impl)

    await expect(syncMetaAdsOnce(d)).resolves.toBeDefined()
    expect(state.records.map((r) => r.error)).toEqual(['invalid_response', 'invalid_response'])
    expect(captured.lines.length).toBeGreaterThan(0)
    const text = JSON.stringify(captured.lines)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('TopSecretToken')
    expect(text).not.toContain('act_100')
  })

  it('survives a failing due list without throwing or logging its message', async () => {
    state.failList = true
    const { impl } = client(() => ok([]))
    const { deps: d, captured } = deps(impl)
    await expect(syncMetaAdsOnce(d)).resolves.toEqual({ sites: 0, failed: 0, rows: 0 })
    expect(captured.find('meta_ads_sync_tick_failed')).toHaveLength(1)
    expect(JSON.stringify(captured.lines)).not.toContain('TopSecretToken')
  })

  it('never logs the detail of a failure that might quote a URL', async () => {
    state.due = [connection('s1')]
    const { impl } = client(() => ({
      ok: false,
      reason: 'unauthorized',
      detail: 'insights responded 400 (code 190)',
      rows: [],
      usage: NO_USAGE,
    }))
    const { deps: d, captured } = deps(impl)
    await syncMetaAdsOnce(d)
    expect(captured.find('meta_ads_sync_failed')[0]).toMatchObject({
      site_id: 's1',
      reason: 'unauthorized',
      detail: 'insights responded 400 (code 190)',
    })
    expect(JSON.stringify(captured.lines)).not.toContain('TopSecretToken')
  })
})

describe('startMetaAdsSync', () => {
  it('runs a tick on start and stops cleanly', async () => {
    state.due = [connection('s1', { lastSyncedAt: NOW })]
    const { impl, calls } = client(() => ok([]))
    const { deps: d } = deps(impl)
    const loop = startMetaAdsSync({ ...d, tickMs: 60_000 })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    await loop.stop()
  })

  it('retries undecryptable tokens on its first tick only: a restart is when the keyring can change', async () => {
    state.due = []
    const { impl } = client(() => ok([]))
    const { deps: d } = deps(impl)
    const loop = startMetaAdsSync({ ...d, tickMs: 30 })
    await vi.waitFor(() => expect(state.dueArgs.length).toBeGreaterThanOrEqual(2))
    await loop.stop()
    expect(state.dueArgs[0]?.includeUndecryptable).toBe(true)
    expect(state.dueArgs[1]?.includeUndecryptable).not.toBe(true)
  })
})
