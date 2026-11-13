import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import { migrateClickHouse } from '@openanalytics/clickhouse'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The Milestone 6 empty-database bootstrap for ClickHouse (docs snapshot 02 §15:
 * "Postgres and ClickHouse must build completely from an empty environment in
 * CI").
 *
 * Runs the real `packages/clickhouse/migrations` into a throwaway database and
 * proves:
 *
 *   1. the analytics schema builds from empty and the ledger records every file;
 *   2. re-running applies nothing;
 *   3. **every MergeTree-family table carries `non_replicated_deduplication_window`.**
 *
 * The third is the one that earns its keep. ADR-0005 measured what happens when
 * the window is set on the raw table but not on a dependent materialized-view
 * target: three retries of one batch produced 50 raw rows and a rollup of 150 —
 * a silent 3x on every dashboard number, invisible in the raw table anyone would
 * think to check. It is a per-table setting with no per-database default, so the
 * only durable defence is a test that fails the next migration that forgets it,
 * rather than a line in a review checklist.
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

/** Engines whose insert deduplication is off unless the window is configured. */
const DEDUP_BEARING_ENGINES = [
  'MergeTree',
  'ReplacingMergeTree',
  'SummingMergeTree',
  'AggregatingMergeTree',
  'CollapsingMergeTree',
  'VersionedCollapsingMergeTree',
]

describeIfClickHouse('analytics schema bootstrap', () => {
  const url = URL_ as string
  const database = `m6analytics_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>

  const run = () => {
    const { logger } = createCapturedLogger()
    return migrateClickHouse({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
      directory: MIGRATIONS_DIR,
      logger,
    })
  }

  const queryRows = async <T>(query: string): Promise<T[]> => {
    const resultSet = await client.query({ query, format: 'JSONEachRow' })
    return await resultSet.json<T>()
  }

  beforeAll(async () => {
    await run()
    client = createClient({ url, username: USERNAME, password: PASSWORD, database })
  })

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await client.close()
    }
  })

  it('builds the analytics schema from empty', async () => {
    const rows = await queryRows<{ name: string; engine: string }>(
      `SELECT name, engine FROM system.tables WHERE database = '${database}' ORDER BY name`,
    )
    const byName = new Map(rows.map((row) => [row.name, row.engine]))

    expect(byName.get('events_raw')).toBe('MergeTree')
    expect(byName.get('performance_events')).toBe('MergeTree')
    expect(byName.get('metrics_1m')).toBe('AggregatingMergeTree')
    expect(byName.get('performance_events_mv')).toBe('MaterializedView')
    expect(byName.get('metrics_1m_mv')).toBe('MaterializedView')

    // The Milestone 7 additive rollup family (plan items 1-2): every rollup the
    // schema still WRITES is an AggregatingMergeTree fed by its own
    // materialized view reading straight from events_raw. Asserted by presence
    // rather than by a frozen count so a later checkpoint that adds a rollup
    // does not fail this — the ledger test below is the one that pins the full
    // file set, derived from the directory. Session/bounce and revenue rollups
    // are intentionally absent (D-211, D-212) and there is nothing here to
    // assert their non-existence against beyond their names never appearing.
    const rollupFamily = [
      'metrics_1d',
      'pages_1d',
      'sources_1d',
      'geography_1d',
      'devices_1d',
      'custom_events_1d',
      // The custom-events decoration (ADR-0038, D5; migration 0021). Same
      // engine, same view pairing, additive — the property that let it ship
      // without dropping either `custom_events_*_mv`.
      'custom_event_samples_1d',
      'performance_1d',
      // The fifteen-minute family (ADR-0079, D1; migration 0025): one 15m twin
      // per additive family above, same engine, same view pairing, additive.
      'metrics_15m',
      'pages_15m',
      'sources_15m',
      'geography_15m',
      'devices_15m',
      'custom_events_15m',
      'performance_15m',
      'custom_event_samples_15m',
      // The custom-event property breakdowns (migration 0030): same engine,
      // same view pairing, additive.
      'custom_event_properties_15m',
      'custom_event_properties_1d',
    ]
    for (const table of rollupFamily) {
      expect(byName.get(table), `${table} should be an AggregatingMergeTree`).toBe(
        'AggregatingMergeTree',
      )
      expect(byName.get(`${table}_mv`), `${table}_mv should be a MaterializedView`).toBe(
        'MaterializedView',
      )
    }

    // The hour family is gone: 0027 (ADR-0079 step 4) dropped the eight views,
    // and 0029 (v0.8.0) the ten tables, once the 15m backfill's equality gate
    // compared with `events_raw` instead and the deletion registry stopped
    // naming them. Neither a table nor a view may come back by accident.
    const droppedHourFamily = [
      'metrics_1h',
      'pages_1h',
      'sources_1h',
      'geography_1h',
      'devices_1h',
      'custom_events_1h',
      'custom_event_samples_1h',
      'performance_1h',
    ]
    for (const table of [...droppedHourFamily, 'session_rollups_1h', 'revenue_1h']) {
      expect(byName.has(table), `${table} must be dropped by 0029`).toBe(false)
      expect(byName.has(`${table}_mv`), `${table}_mv must be dropped by 0027`).toBe(false)
    }

    // Milestone 8 Checkpoint A: the versioned session facts and the two
    // recompute/swap rollup targets. Asserted by presence and engine, not a
    // frozen count; the ledger test pins the full file set from the directory.
    // None of these is a materialized view — that is the whole point of D-211,
    // so their *_mv counterparts must NOT exist.
    expect(byName.get('session_facts_versions')).toBe('ReplacingMergeTree')
    expect(byName.get('session_rollups_1d')).toBe('ReplacingMergeTree')
    // ADR-0079 step 2 (migration 0026). The same engine and the same absence of
    // a view, and the second half matters more here than anywhere: 0025 gave
    // the eight ADDITIVE families a 15m twin WITH a materialized view, so a
    // copy-paste that brought one along would look consistent with its
    // neighbours and be structurally wrong -- a view cannot retract, and a
    // retracted session must leave the rollup.
    expect(byName.get('session_rollups_15m')).toBe('ReplacingMergeTree')
    for (const noView of [
      'session_facts_versions_mv',
      'session_rollups_15m_mv',
      'session_rollups_1h_mv',
      'session_rollups_1d_mv',
    ]) {
      expect(
        byName.has(noView),
        `${noView} must not exist — session facts are not an MV (D-211)`,
      ).toBe(false)
    }

    // The old M7-era "sessions_*" names were never adopted (the session
    // rollups are session_rollups_*), so their absence is still a useful guard.
    for (const forbidden of ['sessions_1h', 'sessions_1d']) {
      expect(byName.has(forbidden), `${forbidden} must not exist yet (D-211)`).toBe(false)
    }

    // M12 CP5: the revenue rollups exist now — created by 0018, strictly after
    // the 0016 canonical fact, which is D-212's ordering demand. Like the
    // session layer they are recompute/swap ReplacingMergeTrees, never MVs;
    // tests/unit/revenue-migration-order.test.ts pins the version ordering.
    expect(byName.get('revenue_1d')).toBe('ReplacingMergeTree')
    // ADR-0079 step 2 (migration 0026), on the same terms: a swap target, never
    // a view, because a refund has to be able to leave a bucket it once
    // entered.
    expect(byName.get('revenue_15m')).toBe('ReplacingMergeTree')
    for (const noView of ['revenue_15m_mv', 'revenue_1h_mv', 'revenue_1d_mv']) {
      expect(
        byName.has(noView),
        `${noView} must not exist — revenue rollups are not MVs (D-212)`,
      ).toBe(false)
    }
  })

  it('carries a mergeable unique-visitor state on every rollup that reports visitors', async () => {
    // Plan item 2: bucket uniques must be a merge state, never a summed count.
    // A column typed AggregateFunction(uniq, ...) can only be read with
    // uniqMerge, so its presence is the structural guarantee that a query cannot
    // accidentally sum per-bucket uniques. metrics_1m gained it by ALTER in 0005
    // and every 15m/1d metric/dimension rollup carries it from creation.
    const rows = await queryRows<{ table: string; type: string }>(
      `SELECT table, type FROM system.columns
        WHERE database = '${database}' AND name = 'visitors' ORDER BY table`,
    )
    const byTable = new Map(rows.map((row) => [row.table, row.type]))
    const visitorTables = [
      'metrics_1m',
      'metrics_1d',
      'pages_1d',
      'sources_1d',
      'geography_1d',
      'devices_1d',
      'custom_events_1d',
      'metrics_15m',
      'pages_15m',
      'sources_15m',
      'geography_15m',
      'devices_15m',
      'custom_events_15m',
      'custom_event_properties_15m',
      'custom_event_properties_1d',
    ]
    for (const table of visitorTables) {
      expect(byTable.get(table), `${table}.visitors must be an AggregateFunction(uniq)`).toMatch(
        /^AggregateFunction\(uniq,/,
      )
    }
  })

  it('records every migration file in the ledger', async () => {
    // Derived from the migrations directory rather than hardcoded: a list
    // frozen at one checkpoint fails the build the moment the next checkpoint
    // adds a file, without catching any real defect.
    const expected = (await readdir(MIGRATIONS_DIR))
      .filter((file) => /^\d{4}_.*\.sql$/.test(file))
      .map((file) => file.slice(0, 4))
      .sort()
    expect(expected.length).toBeGreaterThan(0)

    const rows = await queryRows<{ version: string }>(
      `SELECT version FROM ${database}.schema_migrations FINAL
       WHERE state = 'applied' ORDER BY version`,
    )
    expect(rows.map((row) => row.version)).toEqual(expected)
  })

  it('applies nothing on a second run', async () => {
    expect((await run()).applied).toEqual([])
  })

  it('sets the insert-dedup window on every table a materialized view can reach', async () => {
    const rows = await queryRows<{ name: string; engine: string; create_table_query: string }>(
      `SELECT name, engine, create_table_query FROM system.tables
       WHERE database = '${database}' AND name != 'schema_migrations'
       ORDER BY name`,
    )

    const dedupBearing = rows.filter((row) => DEDUP_BEARING_ENGINES.includes(row.engine))
    // Guards the guard: a rename or an engine change that emptied this list
    // would make the assertion below vacuously pass.
    expect(dedupBearing.length).toBeGreaterThanOrEqual(3)

    for (const row of dedupBearing) {
      expect(
        row.create_table_query,
        `${row.name} (${row.engine}) must set non_replicated_deduplication_window — ` +
          `without it the stable batch token is accepted and ignored (ADR-0005)`,
      ).toMatch(/non_replicated_deduplication_window\s*=\s*[1-9]/)
    }
  })

  it('keeps no raw IP column anywhere in the analytics schema', async () => {
    // Docs snapshot 02 §15 and D-102: the collector is the only component that
    // ever sees an address, and it discards it after deriving anonymous_id.
    const rows = await queryRows<{ table: string; name: string }>(
      `SELECT table, name FROM system.columns WHERE database = '${database}'`,
    )
    const suspicious = rows.filter((row) => /(^|_)(ip|ip_address|remote_addr)$/.test(row.name))
    expect(suspicious).toEqual([])
  })
})
