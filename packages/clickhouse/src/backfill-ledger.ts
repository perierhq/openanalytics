import { createClient, type ClickHouseClient } from '@clickhouse/client'

/**
 * The history-fill ledger of ClickHouse migration 0028.
 *
 * Evidence, never a decision input: every fill that writes here is
 * state-seeking on its own (it computes what is missing from the tables
 * themselves), so nothing reads this to decide whether to run. See the
 * migration's header for why the migration writes no row itself.
 */

export const BACKFILL_LEDGER_TABLE = 'backfill_ledger'

export const BACKFILL_LEDGER_NAMES = [
  'rollups_15m',
  'session_rollups_15m',
  'revenue_15m_reroll',
  // The custom-event property rollups of 0030 (`backfill-event-properties`).
  'custom_event_properties',
] as const
export type BackfillLedgerName = (typeof BACKFILL_LEDGER_NAMES)[number]

export interface BackfillLedgerEntry {
  readonly name: BackfillLedgerName
  readonly completedAt: string
  readonly detail: unknown
}

/** `YYYY-MM-DD hh:mm:ss.sss`, the DateTime64(3) input format. */
function chDateTime64(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
}

export async function readBackfillLedger(
  client: ClickHouseClient,
): Promise<readonly BackfillLedgerEntry[]> {
  const resultSet = await client.query({
    query: `SELECT l.name AS name,
                   toString(max(l.completed_at)) AS completed_at,
                   argMax(l.detail, l.completed_at) AS detail
              FROM ${BACKFILL_LEDGER_TABLE} AS l
             GROUP BY l.name
             ORDER BY name`,
    format: 'JSONEachRow',
  })
  const rows = await resultSet.json<{
    name: BackfillLedgerName
    completed_at: string
    detail: string
  }>()
  return rows.map((row) => ({
    name: row.name,
    completedAt: row.completed_at,
    detail: parseDetail(row.detail),
  }))
}

function parseDetail(detail: string): unknown {
  try {
    return JSON.parse(detail) as unknown
  } catch {
    return detail
  }
}

/**
 * Record a fill. Called only by a run that wrote something, or by the first run
 * that found nothing to write (so a fresh install still gets one row saying so).
 */
export async function recordBackfill(
  client: ClickHouseClient,
  input: { readonly name: BackfillLedgerName; readonly detail: unknown; readonly nowMs?: number },
): Promise<void> {
  await client.insert({
    table: BACKFILL_LEDGER_TABLE,
    values: [
      {
        name: input.name,
        completed_at: chDateTime64(input.nowMs ?? Date.now()),
        detail: JSON.stringify(input.detail),
      },
    ],
    format: 'JSONEachRow',
    // A fill's report is unique per run, so the content token never collides;
    // the synchronous insert is what lets the caller report "recorded".
    clickhouse_settings: { async_insert: 0 },
  })
}

/** Whether the ledger already holds a row for `name`. */
export async function hasBackfillRecord(
  client: ClickHouseClient,
  name: BackfillLedgerName,
): Promise<boolean> {
  const resultSet = await client.query({
    query: `SELECT count() AS c FROM ${BACKFILL_LEDGER_TABLE} WHERE name = {name:String}`,
    query_params: { name },
    format: 'JSONEachRow',
  })
  const [row] = await resultSet.json<{ c: string }>()
  return Number(row?.c ?? 0) > 0
}

export interface BackfillLedger {
  hasRecord(name: BackfillLedgerName): Promise<boolean>
  record(input: { readonly name: BackfillLedgerName; readonly detail: unknown }): Promise<void>
  read(): Promise<readonly BackfillLedgerEntry[]>
  close(): Promise<void>
}

/**
 * A ledger handle on its own connection, for a caller outside this package that
 * holds a credential allowed to write it (the migration identity).
 */
export function openBackfillLedger(options: {
  readonly url: string
  readonly username: string
  readonly password: string
  readonly database: string
}): BackfillLedger {
  const client = createClient(options)
  return {
    hasRecord: async (name) => await hasBackfillRecord(client, name),
    record: async (input) => {
      await recordBackfill(client, input)
    },
    read: async () => await readBackfillLedger(client),
    close: async () => {
      await client.close()
    },
  }
}
