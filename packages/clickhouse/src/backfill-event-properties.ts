import type { Logger } from '@openanalytics/observability'
import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { hasBackfillRecord, recordBackfill } from './backfill-ledger.ts'

/**
 * Bounded history fill of the custom-event property rollups (ClickHouse
 * migration 0030).
 *
 * A materialized view aggregates only what is inserted after it exists, so the
 * two `custom_event_properties_*` targets start empty. This fills the **last
 * 92 days** — the funnel and report range cap, and as far back as a breakdown
 * is worth reading — from `events_raw`, with the views' own SELECT.
 *
 * It follows the 15m backfill's gap rule (`backfill-15m.ts`), and only that
 * rule: a `(site_id, bucket)` pair is filled when the target holds no row for
 * it at all, and a pair that holds a row is never written to, whoever wrote
 * it. So it cannot double a count, a second run writes nothing, and it is safe
 * beside a running worker. Two bounds keep it apart from the views:
 *
 *   - **The live bucket is never filled.** The 15m table stops at the current
 *     quarter hour and the 1d table at the current UTC day, which the views
 *     are writing.
 *   - **One UTC day per statement**, so no statement scans more than one day
 *     of `events_raw` (on its `(site_id, occurred_at)` order) and memory stays
 *     bounded on a small host. 92 days is 92 statements per table.
 *
 * The seam it cannot recover: the pair the view started writing part way
 * through, when 0030 ran with the worker up. That is one quarter hour per
 * site in the 15m table and the migration day per site in the 1d table. A
 * breakdown is a ranking, not a ledger, so that loss is documented, not
 * repaired — repairing it would mean rewriting a live bucket.
 *
 * Runs under the migration credential, which has `SELECT` and `INSERT` on the
 * analytics database. A run that wrote something, and the first run that found
 * nothing, record themselves in `backfill_ledger` as `custom_event_properties`.
 */

/** The days a fill reaches back, counted from the start of the current UTC day. */
export const EVENT_PROPERTY_BACKFILL_DAYS = 92

const IDENTITY = "if(user_id != '', user_id, anonymous_id)"

/**
 * The SELECT list, ARRAY JOIN and WHERE of both views in migration 0030,
 * verbatim apart from `{bucket}`. Kept beside the specs so the fill inserts
 * exactly what the view would have, and the migration test compares the two.
 */
export const EVENT_PROPERTY_SELECT = [
  `site_id, {bucket} AS bucket_start, name AS event_name, kv.1 AS property_key,`,
  `substringUTF8(if(JSONType(properties, kv.1) = 'String', JSONExtractString(properties, kv.1), kv.2), 1, 100) AS property_value,`,
  `count() AS events, uniqState(${IDENTITY}) AS visitors`,
].join(' ')

export const EVENT_PROPERTY_ARRAY_JOIN = 'ARRAY JOIN JSONExtractKeysAndValuesRaw(properties) AS kv'

export const EVENT_PROPERTY_WHERE = [
  "name != ''",
  "NOT startsWith(lower(kv.1), 'oa_')",
  "lower(kv.1) != 'order_id'",
  "JSONType(properties, kv.1) IN ('String', 'Int64', 'UInt64', 'Double', 'Bool')",
].join(' AND ')

export const EVENT_PROPERTY_GROUP_BY =
  'site_id, bucket_start, event_name, property_key, property_value'

export interface EventPropertyRollupSpec {
  readonly table: string
  /** The view's bucket expression over `occurred_at`. */
  readonly bucket: string
  /** The bucket width; the live bucket is the one `now` falls in. */
  readonly grainSeconds: number
}

export const EVENT_PROPERTY_ROLLUPS: readonly EventPropertyRollupSpec[] = [
  {
    table: 'custom_event_properties_15m',
    bucket: "toStartOfFifteenMinutes(toDateTime(occurred_at, 'UTC'))",
    grainSeconds: 15 * 60,
  },
  {
    table: 'custom_event_properties_1d',
    bucket: "toStartOfDay(toDateTime(occurred_at, 'UTC'))",
    grainSeconds: 24 * 60 * 60,
  },
]

const DAY_SECONDS = 24 * 60 * 60

/**
 * The INSERT ... SELECT that fills one table's gaps in `[fromSeconds,
 * beforeSeconds)`. The absence test and the raw read are one statement, so a
 * view writing a pair while it runs makes the pair present rather than
 * doubled. Exported so the migration test runs the statement production runs.
 */
export function eventPropertyBackfillStatement(
  spec: EventPropertyRollupSpec,
  fromSeconds: number,
  beforeSeconds: number,
): string {
  return `INSERT INTO ${spec.table} ${eventPropertySelect(spec, fromSeconds, beforeSeconds)}`
}

function eventPropertySelect(
  spec: EventPropertyRollupSpec,
  fromSeconds: number,
  beforeSeconds: number,
): string {
  const from = `toDateTime(${String(fromSeconds)}, 'UTC')`
  const before = `toDateTime(${String(beforeSeconds)}, 'UTC')`
  return [
    `SELECT ${EVENT_PROPERTY_SELECT.replace('{bucket}', spec.bucket)}`,
    'FROM events_raw',
    EVENT_PROPERTY_ARRAY_JOIN,
    `WHERE occurred_at >= ${from} AND occurred_at < ${before}`,
    `  AND ${EVENT_PROPERTY_WHERE}`,
    `  AND (site_id, ${spec.bucket}) NOT IN (`,
    `    SELECT site_id, bucket_start FROM ${spec.table}`,
    `     WHERE bucket_start >= toStartOfDay(${from}) AND bucket_start < ${before})`,
    `GROUP BY ${EVENT_PROPERTY_GROUP_BY}`,
  ].join('\n')
}

export interface BackfillEventPropertiesOptions {
  readonly url: string
  readonly username: string
  readonly password: string
  readonly database: string
  readonly logger: Logger
  /** Count the gap instead of writing it. */
  readonly dryRun?: boolean
  /** Days back from the start of the current UTC day. Default and maximum 92. */
  readonly days?: number
  /** The run's clock, for tests. Default `Date.now()`. */
  readonly nowMs?: number
  /** Per-statement memory ceiling. Default 1 GB. */
  readonly maxMemoryBytes?: number
}

export interface BackfillEventPropertiesTableReport {
  readonly table: string
  /** Rows written — or, on a dry run, the rows the fill would write. */
  readonly rows: number
  readonly statements: number
}

export interface BackfillEventPropertiesResult {
  readonly dryRun: boolean
  /** The first instant filled (start of a UTC day). */
  readonly from: string
  /** Per table, the instant the fill stopped before: its live bucket. */
  readonly before: Readonly<Record<string, string>>
  readonly tables: readonly BackfillEventPropertiesTableReport[]
  readonly rows: number
  readonly durationMs: number
  readonly ledgerRecorded: boolean
}

async function countRows(client: ClickHouseClient, select: string): Promise<number> {
  const resultSet = await client.query({
    query: `SELECT count() AS c FROM (${select})`,
    format: 'JSONEachRow',
  })
  const [row] = await resultSet.json<{ c: string }>()
  return Number(row?.c ?? 0)
}

export async function backfillEventProperties(
  options: BackfillEventPropertiesOptions,
): Promise<BackfillEventPropertiesResult> {
  const days = Math.min(options.days ?? EVENT_PROPERTY_BACKFILL_DAYS, EVENT_PROPERTY_BACKFILL_DAYS)
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(
      `days must be an integer from 1 to ${String(EVENT_PROPERTY_BACKFILL_DAYS)}`,
    )
  }
  const client = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
    clickhouse_settings: {
      async_insert: 0,
      wait_for_async_insert: 1,
      max_memory_usage: String(options.maxMemoryBytes ?? 1_000_000_000),
      // This runs beside live reads on a small host.
      max_threads: 2,
      max_insert_threads: '1',
      max_execution_time: 0,
    },
    request_timeout: 30 * 60 * 1000,
  })
  try {
    return await run(client, options, days)
  } finally {
    await client.close()
  }
}

async function run(
  client: ClickHouseClient,
  options: BackfillEventPropertiesOptions,
  days: number,
): Promise<BackfillEventPropertiesResult> {
  const dryRun = options.dryRun === true
  const startedAt = Date.now()
  const nowSeconds = Math.floor((options.nowMs ?? startedAt) / 1000)
  const todaySeconds = Math.floor(nowSeconds / DAY_SECONDS) * DAY_SECONDS
  const fromSeconds = todaySeconds - days * DAY_SECONDS

  const tables: BackfillEventPropertiesTableReport[] = []
  const before: Record<string, string> = {}
  for (const spec of EVENT_PROPERTY_ROLLUPS) {
    const liveSeconds = Math.floor(nowSeconds / spec.grainSeconds) * spec.grainSeconds
    before[spec.table] = new Date(liveSeconds * 1000).toISOString()
    let rows = 0
    let statements = 0
    for (let day = fromSeconds; day < liveSeconds; day += DAY_SECONDS) {
      const end = Math.min(day + DAY_SECONDS, liveSeconds)
      if (dryRun) {
        rows += await countRows(client, eventPropertySelect(spec, day, end))
      } else {
        const result = await client.command({
          query: eventPropertyBackfillStatement(spec, day, end),
        })
        rows += Number(result.summary?.written_rows ?? 0)
      }
      statements += 1
    }
    tables.push({ table: spec.table, rows, statements })
    options.logger.info('backfill_event_properties_table', {
      store: 'clickhouse',
      table: spec.table,
      rows,
      dry_run: dryRun,
    })
  }

  const total = tables.reduce((sum, table) => sum + table.rows, 0)
  const report = {
    dryRun,
    from: new Date(fromSeconds * 1000).toISOString(),
    before,
    tables,
    rows: total,
    durationMs: Date.now() - startedAt,
  }

  let ledgerRecorded = false
  if (!dryRun && (total > 0 || !(await hasBackfillRecord(client, 'custom_event_properties')))) {
    await recordBackfill(client, { name: 'custom_event_properties', detail: report })
    ledgerRecorded = true
  }
  return { ...report, ledgerRecorded }
}
