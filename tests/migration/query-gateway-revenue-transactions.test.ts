import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import { migrateClickHouse } from '@openanalytics/clickhouse'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpClickHouseReader } from '../../apps/query-gateway/src/clickhouse-http.ts'
import type { QueryParameterValue } from '../../apps/query-gateway/src/clickhouse.ts'
import { findOperation } from '../../apps/query-gateway/src/operations.ts'

/**
 * The transactions list's `visitor` column, against a live, migrated
 * ClickHouse.
 *
 * `visitor` is the anonymous id the buyer had in the purchase's last-touch
 * session: the same id the realtime surfaces key a visitor on, so a sale can be
 * drawn with the same generated face. What only a real server can answer:
 *
 *   1. **An anonymous buyer** reads back their own anonymous id, from the
 *      conversion event (the attribution key), not from the session. An
 *      `anonymous_day` row that nonetheless carries a user id resolves through
 *      its session like an identified one, never to the user id.
 *   2. **An identified buyer** reads back the anonymous id of their last-touch
 *      session — the CURRENT version of that session — and never the
 *      identify() hash, which is stable across days and would let a reader
 *      link one buyer's purchases.
 *   3. **A last-touch session older than the range** still resolves: the
 *      session is found by its key, not by a time window the range implies.
 *   4. **Unmatched, unattributed, retracted or sessionless** charges read back
 *      the empty string, which the api renders as null.
 *   5. Cross-site isolation: another site's session with the same id is never
 *      read.
 *
 * Skipped without TEST_CLICKHOUSE_URL; CI always provides one.
 */

const URL_ = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''

const describeIfClickHouse = URL_ ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

const FROM = '2026-07-01T00:00:00.000Z'
const TO = '2026-07-08T00:00:00.000Z'

function charge(over: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: 'stripe',
    object_kind: 'charge',
    version: 1,
    status: 'succeeded',
    livemode: 1,
    currency: 'eur',
    gross_minor: 1000,
    reporting_currency: 'EUR',
    reporting_gross_minor: 1000,
    conversion_source: 'identity',
    conversion_rate: 1,
    ingested_via: 'webhook',
    ingested_at: '2026-07-10 00:00:00.000',
    ...over,
  }
}

function attribution(over: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: 'stripe',
    version: 1,
    model_version: 1,
    window_days: 30,
    matched_via: 'conversion_event',
    confidence: 'exact',
    identity_scope: 'identified',
    journey: '[]',
    computed_at: '2026-07-10 00:00:00.000',
    ...over,
  }
}

function fact(over: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    user_id: '',
    anonymous_id: '',
    session_hint: '',
    session_hints: [],
    midnight_bridged: 0,
    session_start: '2026-07-02 09:00:00.000',
    session_end: '2026-07-02 09:05:00.000',
    pageviews: 1,
    engaged: 1,
    active_duration_ms: 0,
    session_duration_ms: 0,
    entry_page_path: '/',
    exit_page_path: '/',
    finalized: 1,
    retracted: 0,
    computed_at: '2026-07-03 00:00:00.000',
    ...over,
  }
}

describeIfClickHouse('revenue transactions: the buyer’s anonymous id', () => {
  const url = URL_ as string
  const database = `rt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>
  const reader = createHttpClickHouseReader({
    url,
    database,
    username: USERNAME,
    password: PASSWORD,
  })

  const run = async (input: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
    const operation = findOperation('analytics.revenue_transactions')
    if (!operation) throw new Error('no revenue_transactions operation')
    const parameters = operation.bindParams(input) as Record<string, QueryParameterValue>
    const result = await reader.query({
      sql: operation.sql,
      parameters,
      signal: new AbortController().signal,
      queryId: randomUUID(),
      settings: { max_execution_time: 20, max_result_rows: 200_000, result_overflow_mode: 'throw' },
    })
    return [...result.rows]
  }

  const firstPage = { from: FROM, to: TO, cursor_occurred_at: TO, cursor_object_id: '' }

  const site = randomUUID()
  const otherSite = randomUUID()

  beforeAll(async () => {
    const { logger } = createCapturedLogger()
    await migrateClickHouse({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
      directory: MIGRATIONS_DIR,
      logger,
    })
    client = createClient({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
      clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 },
    })

    const charges = [
      ['ch_anon', '2026-07-02 12:00:00.000'],
      ['ch_anon_user', '2026-07-02 13:00:00.000'],
      ['ch_ident', '2026-07-03 12:00:00.000'],
      ['ch_ident_old', '2026-07-03 13:00:00.000'],
      ['ch_ident_nosession', '2026-07-04 12:00:00.000'],
      ['ch_ident_retracted', '2026-07-04 13:00:00.000'],
      ['ch_none', '2026-07-05 12:00:00.000'],
      ['ch_noatt', '2026-07-05 13:00:00.000'],
    ] as const
    await client.insert({
      table: 'revenue_events',
      format: 'JSONEachRow',
      values: [
        ...charges.map(([object_id, occurred_at]) =>
          charge({ site_id: site, object_id, occurred_at }),
        ),
        charge({ site_id: otherSite, object_id: 'ch_x', occurred_at: '2026-07-03 12:00:00.000' }),
      ],
    })

    await client.insert({
      table: 'revenue_attributions',
      format: 'JSONEachRow',
      values: [
        attribution({
          site_id: site,
          object_id: 'ch_anon',
          occurred_at: '2026-07-02 12:00:00.000',
          identity_scope: 'anonymous_day',
          visitor_id: 'ANON_A',
          user_id: '',
          lt_session_id: 's_anon',
        }),
        // Anonymous scope, but a user id is set: the key is the identify()
        // hash, so the answer must come from the session.
        attribution({
          site_id: site,
          object_id: 'ch_anon_user',
          occurred_at: '2026-07-02 13:00:00.000',
          identity_scope: 'anonymous_day',
          visitor_id: 'HMAC_U5',
          user_id: 'HMAC_U5',
          lt_session_id: 's_anon_user',
        }),
        // Version 1 named an older session; version 2 names s_ident and wins.
        attribution({
          site_id: site,
          object_id: 'ch_ident',
          occurred_at: '2026-07-03 12:00:00.000',
          visitor_id: 'HMAC_U1',
          user_id: 'HMAC_U1',
          lt_session_id: 's_anon',
        }),
        attribution({
          site_id: site,
          object_id: 'ch_ident',
          version: 2,
          occurred_at: '2026-07-03 12:00:00.000',
          visitor_id: 'HMAC_U1',
          user_id: 'HMAC_U1',
          lt_session_id: 's_ident',
        }),
        attribution({
          site_id: site,
          object_id: 'ch_ident_old',
          occurred_at: '2026-07-03 13:00:00.000',
          matched_via: 'client_reference',
          confidence: 'linked',
          visitor_id: 'HMAC_U2',
          user_id: 'HMAC_U2',
          lt_session_id: 's_old',
        }),
        // Matched by its conversion event before the finalizer wrote the
        // session: an exact match with no last touch yet.
        attribution({
          site_id: site,
          object_id: 'ch_ident_nosession',
          occurred_at: '2026-07-04 12:00:00.000',
          visitor_id: 'HMAC_U3',
          user_id: 'HMAC_U3',
          lt_session_id: '',
        }),
        attribution({
          site_id: site,
          object_id: 'ch_ident_retracted',
          occurred_at: '2026-07-04 13:00:00.000',
          visitor_id: 'HMAC_U4',
          user_id: 'HMAC_U4',
          lt_session_id: 's_retracted',
        }),
        attribution({
          site_id: site,
          object_id: 'ch_none',
          occurred_at: '2026-07-05 12:00:00.000',
          matched_via: 'none',
          confidence: 'none',
          identity_scope: '',
        }),
        attribution({
          site_id: otherSite,
          object_id: 'ch_x',
          occurred_at: '2026-07-03 12:00:00.000',
          visitor_id: 'HMAC_X',
          user_id: 'HMAC_X',
          lt_session_id: 's_ident',
        }),
      ],
    })

    await client.insert({
      table: 'session_facts_versions',
      format: 'JSONEachRow',
      values: [
        // The session's entry anonymous id differs from the conversion event's,
        // so the answer shows which branch produced it.
        fact({
          site_id: site,
          session_id: 's_anon',
          visitor_id: 'ANON_A_ENTRY',
          anonymous_id: 'ANON_A_ENTRY',
        }),
        fact({
          site_id: site,
          session_id: 's_anon_user',
          visitor_id: 'HMAC_U5',
          user_id: 'HMAC_U5',
          anonymous_id: 'ANON_U5',
          session_start: '2026-07-02 12:30:00.000',
        }),
        // Two versions: the current one's anonymous id is the answer.
        fact({
          site_id: site,
          session_id: 's_ident',
          visitor_id: 'HMAC_U1',
          user_id: 'HMAC_U1',
          anonymous_id: 'ANON_STALE',
          session_start: '2026-07-03 11:00:00.000',
        }),
        fact({
          site_id: site,
          session_id: 's_ident',
          version: 2,
          visitor_id: 'HMAC_U1',
          user_id: 'HMAC_U1',
          anonymous_id: 'ANON_U1',
          session_start: '2026-07-03 11:00:00.000',
        }),
        // Twenty days before the range: a 30-day attribution window allows it.
        fact({
          site_id: site,
          session_id: 's_old',
          visitor_id: 'HMAC_U2',
          user_id: 'HMAC_U2',
          anonymous_id: 'ANON_U2',
          session_start: '2026-06-11 09:00:00.000',
        }),
        fact({
          site_id: site,
          session_id: 's_retracted',
          visitor_id: 'HMAC_U4',
          user_id: 'HMAC_U4',
          anonymous_id: 'ANON_U4',
        }),
        fact({
          site_id: site,
          session_id: 's_retracted',
          version: 2,
          retracted: 1,
          visitor_id: 'HMAC_U4',
          user_id: 'HMAC_U4',
          anonymous_id: 'ANON_U4',
        }),
        // Another site's session under the same id must never be read.
        fact({
          site_id: otherSite,
          session_id: 's_ident',
          visitor_id: 'HMAC_X',
          anonymous_id: 'ANON_X',
          session_start: '2026-07-03 11:00:00.000',
        }),
      ],
    })
  }, 120_000)

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await client.close()
    }
  })

  it('reads each charge’s last-touch anonymous id, and nothing for the rest', async () => {
    const rows = await run({ site_id: site, ...firstPage, limit: 20 })
    expect(rows).toHaveLength(8)
    expect(Object.fromEntries(rows.map((r) => [r['object_id'], r['visitor']]))).toEqual({
      ch_anon: 'ANON_A',
      ch_anon_user: 'ANON_U5',
      ch_ident: 'ANON_U1',
      ch_ident_old: 'ANON_U2',
      ch_ident_nosession: '',
      ch_ident_retracted: '',
      ch_none: '',
      ch_noatt: '',
    })
  })

  it('never returns an identify() hash', async () => {
    const rows = await run({ site_id: site, ...firstPage, limit: 20 })
    for (const row of rows) {
      expect(String(row['visitor'])).not.toMatch(/^HMAC_/)
      expect(row).not.toHaveProperty('user_id')
      expect(row).not.toHaveProperty('visitor_id')
    }
  })

  it('keeps another site’s session out', async () => {
    const rows = await run({ site_id: otherSite, ...firstPage, limit: 20 })
    expect(rows.map((r) => [r['object_id'], r['visitor']])).toEqual([['ch_x', 'ANON_X']])
  })

  it('pages the same rows with the same keyset', async () => {
    const page1 = await run({ site_id: site, ...firstPage, limit: 3 })
    expect(page1.map((r) => r['object_id'])).toEqual(['ch_noatt', 'ch_none', 'ch_ident_retracted'])
    const last = page1[2]!
    const page2 = await run({
      site_id: site,
      from: FROM,
      to: TO,
      cursor_occurred_at: new Date(
        `${String(last['occurred_at']).replace(' ', 'T')}Z`,
      ).toISOString(),
      cursor_object_id: String(last['object_id']),
      limit: 3,
    })
    expect(page2.map((r) => [r['object_id'], r['visitor']])).toEqual([
      ['ch_ident_nosession', ''],
      ['ch_ident_old', 'ANON_U2'],
      ['ch_ident', 'ANON_U1'],
    ])
  })
})
