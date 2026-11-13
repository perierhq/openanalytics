import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import {
  EVENT_PROPERTY_ROLLUPS,
  backfillEventProperties,
  migrateClickHouse,
  readBackfillLedger,
} from '@openanalytics/clickhouse'
import { DELETION_CLICKHOUSE_TARGETS } from '@openanalytics/domain'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpClickHouseReader } from '../../apps/query-gateway/src/clickhouse-http.ts'
import { findOperation } from '../../apps/query-gateway/src/operations.ts'
import type { QueryParameterValue } from '../../apps/query-gateway/src/clickhouse.ts'

/**
 * The custom-event property breakdowns (ClickHouse migration 0030), proven with
 * data:
 *
 *   1. **The views write what a breakdown should read**: one row per (event,
 *      key, value), a number or boolean as its JSON text, values cut to 100
 *      characters, and the reserved `oa_*` keys and `order_id` never stored.
 *   2. **The bounded backfill fills gaps only**: a (site, bucket) pair the
 *      view already wrote is left alone, a missing one is filled with exactly
 *      what the view writes, a second run writes nothing, and nothing older
 *      than 92 days is touched.
 *   3. **The read caps cardinality**: top N values per key plus one `other`
 *      row per key, and the allowlist the api passes restricts the keys.
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

describeIfClickHouse('custom-event property breakdowns (migration 0030)', () => {
  const url = URL_ as string
  const database = `ceprops_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>

  const reader = createHttpClickHouseReader({
    url,
    database,
    username: USERNAME,
    password: PASSWORD,
  })

  const run = async (
    operationId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> => {
    const operation = findOperation(operationId)
    if (!operation) throw new Error(`no such operation ${operationId}`)
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

  const queryRows = async <T>(query: string): Promise<T[]> => {
    const resultSet = await client.query({ query, format: 'JSONEachRow' })
    return await resultSet.json<T>()
  }

  const event = (over: Record<string, unknown>): Record<string, unknown> => ({
    schema_version: 1,
    batch_id: 'b',
    event_id: randomUUID(),
    type: 'custom_event',
    name: 'plan_selected',
    billable: 1,
    anonymous_id: 'v1',
    user_id: '',
    session_id: '',
    page_path: '/pricing',
    referrer_domain: '',
    utm_source: '',
    utm_medium: '',
    utm_campaign: '',
    country: '',
    city: '',
    device_type: '',
    browser: '',
    os: '',
    properties: '{}',
    ...over,
  })

  const insertRaw = async (rows: readonly Record<string, unknown>[]): Promise<void> => {
    await client.insert({ table: 'events_raw', values: rows, format: 'JSONEachRow' })
  }

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
  }, 120_000)

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await client.close()
    }
  })

  it('is booked in the deletion registry, both grains', () => {
    for (const spec of EVENT_PROPERTY_ROLLUPS) {
      expect(DELETION_CLICKHOUSE_TARGETS as readonly string[]).toContain(spec.table)
    }
  })

  it('stores value text per key and never the reserved keys or order_id', async () => {
    const site = randomUUID()
    const long = 'x'.repeat(140)
    await insertRaw([
      event({
        site_id: site,
        occurred_at: '2026-07-01 10:00:00.000',
        properties: JSON.stringify({
          plan: 'yearly',
          seats: 3,
          trial: true,
          note: long,
          nothing: null,
          oa_text: 'Buy',
          Order_Id: 'ord_123',
        }),
      }),
      event({
        site_id: site,
        occurred_at: '2026-07-01 10:05:00.000',
        anonymous_id: 'v2',
        properties: JSON.stringify({ plan: 'yearly' }),
      }),
      // A page view carries no name and is not a breakdown row.
      event({
        site_id: site,
        type: 'page_view',
        name: '',
        occurred_at: '2026-07-01 10:06:00.000',
        properties: JSON.stringify({ plan: 'monthly' }),
      }),
    ])

    for (const spec of EVENT_PROPERTY_ROLLUPS) {
      const rows = await queryRows<{ k: string; v: string; e: string; u: string }>(
        `SELECT property_key AS k, property_value AS v, sum(events) AS e, uniqMerge(visitors) AS u
           FROM ${spec.table} WHERE site_id = '${site}'
          GROUP BY k, v ORDER BY k, v`,
      )
      expect(
        rows.map((row) => [row.k, row.v, Number(row.e), Number(row.u)]),
        spec.table,
      ).toEqual([
        ['note', 'x'.repeat(100), 1, 1],
        ['plan', 'yearly', 2, 2],
        ['seats', '3', 1, 1],
        ['trial', 'true', 1, 1],
      ])
    }
  })

  it('backfills only missing (site, bucket) pairs, the view’s own rows, within 92 days', async () => {
    const site = randomUUID()
    const nowMs = Date.parse('2026-07-10T12:07:00.000Z')
    // Events from before the views existed: drop the views' rows afterwards
    // to model history the views never saw.
    await insertRaw([
      event({
        site_id: site,
        occurred_at: '2026-07-05 09:00:00.000',
        properties: JSON.stringify({ plan: 'monthly' }),
      }),
      event({
        site_id: site,
        occurred_at: '2026-07-05 09:01:00.000',
        anonymous_id: 'v2',
        properties: JSON.stringify({ plan: 'yearly' }),
      }),
      // Older than 92 days before 2026-07-10: never filled.
      event({
        site_id: site,
        occurred_at: '2026-03-01 09:00:00.000',
        properties: JSON.stringify({ plan: 'old' }),
      }),
      // The live quarter hour and the live day: never filled.
      event({
        site_id: site,
        occurred_at: '2026-07-10 12:05:00.000',
        properties: JSON.stringify({ plan: 'live' }),
      }),
    ])
    const viewRows = async (table: string) =>
      await queryRows<{ b: string; v: string; e: string; u: string }>(
        `SELECT toString(bucket_start) AS b, property_value AS v, sum(events) AS e, uniqMerge(visitors) AS u
           FROM ${table} WHERE site_id = '${site}' AND property_value NOT IN ('live', 'old')
          GROUP BY b, v ORDER BY b, v`,
      )
    const expected = new Map<string, unknown>()
    for (const spec of EVENT_PROPERTY_ROLLUPS) expected.set(spec.table, await viewRows(spec.table))

    for (const spec of EVENT_PROPERTY_ROLLUPS) {
      await client.command({
        query: `ALTER TABLE ${spec.table} DELETE WHERE site_id = '${site}'`,
        clickhouse_settings: { mutations_sync: '2' },
      })
    }
    // One pair the view "already wrote": the fill must leave it as it is.
    await insertRaw([
      event({
        site_id: site,
        occurred_at: '2026-07-06 09:00:00.000',
        properties: JSON.stringify({ plan: 'yearly' }),
      }),
    ])

    const { logger } = createCapturedLogger()
    const options = { url, username: USERNAME, password: PASSWORD, database, logger, nowMs }
    const dry = await backfillEventProperties({ ...options, dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(dry.rows).toBeGreaterThan(0)

    const first = await backfillEventProperties(options)
    expect(first.from).toBe('2026-04-09T00:00:00.000Z')
    expect(first.before['custom_event_properties_15m']).toBe('2026-07-10T12:00:00.000Z')
    expect(first.before['custom_event_properties_1d']).toBe('2026-07-10T00:00:00.000Z')
    expect(first.ledgerRecorded).toBe(true)

    for (const spec of EVENT_PROPERTY_ROLLUPS) {
      const rows = (await viewRows(spec.table)).filter((row) => !row.b.startsWith('2026-07-06'))
      expect(rows, spec.table).toEqual(expected.get(spec.table))
      // The view-written pair is untouched: one event, not two.
      const kept = await queryRows<{ e: string }>(
        `SELECT sum(events) AS e FROM ${spec.table}
          WHERE site_id = '${site}' AND toDate(bucket_start) = '2026-07-06'`,
      )
      expect(Number(kept[0]?.e), spec.table).toBe(1)
      const old = await queryRows<{ c: string }>(
        `SELECT count() AS c FROM ${spec.table} WHERE site_id = '${site}' AND property_value = 'old'`,
      )
      expect(Number(old[0]?.c), spec.table).toBe(0)
      const live = await queryRows<{ c: string }>(
        `SELECT count() AS c FROM ${spec.table} WHERE site_id = '${site}' AND property_value = 'live'`,
      )
      expect(Number(live[0]?.c), spec.table).toBe(0)
    }

    const second = await backfillEventProperties(options)
    expect(second.rows).toBe(0)
    const ledger = await readBackfillLedger(client)
    expect(ledger.map((entry) => entry.name)).toContain('custom_event_properties')
  })

  it('reads the top values per key with an other row, under the allowlist', async () => {
    const site = randomUUID()
    const rows: Record<string, unknown>[] = []
    const counts: Record<string, number> = { a: 5, b: 4, c: 3, d: 2, e: 1 }
    for (const [value, count] of Object.entries(counts)) {
      for (let i = 0; i < count; i += 1) {
        rows.push(
          event({
            site_id: site,
            occurred_at: '2026-07-02 08:00:00.000',
            anonymous_id: `v-${value}-${String(i)}`,
            properties: JSON.stringify({ trigger: value, plan: 'yearly' }),
          }),
        )
      }
    }
    rows.push(
      event({
        site_id: site,
        name: 'other_event',
        occurred_at: '2026-07-02 08:00:00.000',
        properties: JSON.stringify({ trigger: 'z' }),
      }),
    )
    await insertRaw(rows)

    const range = {
      site_id: site,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-03T00:00:00.000Z',
    }
    const all = await run('analytics.custom_event_properties_day', {
      ...range,
      event_name: 'plan_selected',
      all_keys: true,
      keys: [],
      limit: 2,
    })
    expect(
      all.map((row) => [
        row['property_key'],
        row['property_value'],
        Number(row['is_other']),
        Number(row['events']),
        Number(row['visitors']),
      ]),
    ).toEqual([
      ['plan', 'yearly', 0, 15, 15],
      ['trigger', 'a', 0, 5, 5],
      ['trigger', 'b', 0, 4, 4],
      ['trigger', '', 1, 6, 6],
    ])

    const allowed = await run('analytics.custom_event_properties_hour', {
      ...range,
      event_name: 'plan_selected',
      all_keys: false,
      keys: ['plan'],
      limit: 10,
    })
    expect(allowed.map((row) => row['property_key'])).toEqual(['plan'])

    const none = await run('analytics.custom_event_properties_day', {
      ...range,
      event_name: 'plan_selected',
      all_keys: false,
      keys: [],
    })
    expect(none).toEqual([])
  })
})
