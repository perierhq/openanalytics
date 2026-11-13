import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveEnvFileReferences } from '@openanalytics/domain'
import { createLogger, createServiceMetadata } from '@openanalytics/observability'
import { BackfillRefusedError, backfillFifteenMinuteRollups } from './backfill-15m.ts'
import {
  BACKFILL_LEDGER_NAMES,
  readBackfillLedger,
  recordBackfill,
  type BackfillLedgerName,
} from './backfill-ledger.ts'
import { backfillEventProperties } from './backfill-event-properties.ts'
import { backfillSessionRollups15m } from './backfill-sessions-15m.ts'
import { createClient } from '@clickhouse/client'
import { migrateClickHouse } from './migrate.ts'

/**
 * `pnpm run migrate:clickhouse [--dry-run]`
 * `pnpm run migrate:clickhouse backfill-15m [--dry-run] [--if-needed] [--sessions] [--settle-seconds N] [--accept-site <uuid>]...`
 * `pnpm run migrate:clickhouse ledger [record <name> <detail-json>]`
 * `pnpm run migrate:clickhouse backfill-event-properties [--dry-run] [--days N]`
 *
 * Uses the dedicated migration credential. Docs snapshot 02 §5: the ingest user
 * may only insert and the query-gateway user may only read; neither can alter
 * schema.
 *
 * The `backfill-15m` subcommand is the history half of migration 0025
 * (ADR-0079, D3): it fills the fifteen-minute rollups from `events_raw`. It
 * fills GAPS — a (site, quarter hour) with raw events and no rollup row — and
 * never touches a pair that holds a row, so it cannot double a count and a
 * second run writes nothing. Exit codes: 0 done (including "nothing to fill"),
 * 2 refused by a guard (nothing was written), 3 the fill ran but what it left
 * disagrees with `events_raw` (or, with `--sessions`, with the session facts),
 * 1 any other failure.
 *
 * `--if-needed` is the automated mode the self-hosted migrate container runs
 * on every start: no refusal at all, whatever the state — empty targets, targets
 * the views already started filling while the worker kept running, targets that
 * stay empty because the install has no such events. Without it the command
 * keeps its hand-run refusals: every target must be empty, and `events_raw`
 * must not move between two readings.
 *
 * `--sessions` switches that same subcommand to migration 0026's session half
 * (ADR-0079, step 2). `session_rollups_15m` has no materialized view to replay,
 * so its gaps are recomputed from `session_facts_versions` through the
 * finalizer's own aggregate and written at generation 0, below anything the
 * finalizer mints — which is what makes it safe beside a running worker. The
 * revenue half of 0026 has no backfill at all — its history is reclaimed by
 * pulling each site's re-roll cursor back
 * (`apps/worker/dist/revenue/seed-15m-reroll.js --if-needed`).
 *
 * `ledger` prints `backfill_ledger` (migration 0028); `ledger record` writes one
 * row by hand, for a database whose fills ran before the ledger existed.
 *
 * `backfill-event-properties` is the history half of migration 0030: it fills
 * the custom-event property rollups for the last 92 days (`--days` lowers it),
 * (site, bucket) pairs with no row only, one UTC day per statement, never the
 * live bucket. Safe beside a running worker and idempotent. Exit 0 done
 * (including nothing to fill), 1 any failure.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = join(packageRoot, 'migrations')

const logger = createLogger({
  service: createServiceMetadata({
    name: 'migrator',
    version: process.env['SERVICE_VERSION'] ?? '0.0.0',
    commit: process.env['GIT_COMMIT'] ?? 'unknown',
    environment: process.env['ENVIRONMENT'] ?? 'local',
  }),
})

// Resolved, not raw: this CLI never calls `loadServiceEnv`, so it is its own
// first read of the environment and has to honour `*_FILE` itself (ADR-0065).
// Without this, `CLICKHOUSE_MIGRATION_PASSWORD_FILE` reads as an absent
// password and the migration fails authentication against a credential that is
// sitting right there on disk.
const env = resolveEnvFileReferences(process.env)

const url = env['CLICKHOUSE_URL']
const username = env['CLICKHOUSE_MIGRATION_USER']
const password = env['CLICKHOUSE_MIGRATION_PASSWORD']
const database = env['CLICKHOUSE_DATABASE'] ?? 'analytics'

if (!url || !username || password === undefined) {
  process.stderr.write(
    'CLICKHOUSE_URL, CLICKHOUSE_MIGRATION_USER and CLICKHOUSE_MIGRATION_PASSWORD are required\n',
  )
  process.exit(78) // EX_CONFIG
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

function optionValues(flag: string): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) {
        process.stderr.write(`${flag} needs a value\n`)
        process.exit(64) // EX_USAGE
      }
      values.push(value)
    }
  }
  return values
}

if (args[0] === 'ledger') {
  const client = createClient({ url, username, password, database })
  try {
    if (args[1] === 'record') {
      const name = args[2]
      const detail = args[3]
      if (!BACKFILL_LEDGER_NAMES.includes(name as BackfillLedgerName) || detail === undefined) {
        process.stderr.write(
          `usage: ledger record <${BACKFILL_LEDGER_NAMES.join('|')}> <detail-json>\n`,
        )
        process.exit(64)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(detail)
      } catch {
        process.stderr.write('detail must be JSON\n')
        process.exit(64)
      }
      await recordBackfill(client, { name: name as BackfillLedgerName, detail: parsed })
      logger.info('backfill_ledger_recorded', { store: 'clickhouse', name })
    }
    process.stdout.write(`${JSON.stringify(await readBackfillLedger(client), null, 2)}\n`)
  } catch (err) {
    logger.error('backfill_ledger_failed', { store: 'clickhouse', retryable: false, err })
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  } finally {
    await client.close()
  }
} else if (args[0] === 'backfill-event-properties') {
  const daysRaw = optionValues('--days')[0]
  const days = daysRaw === undefined ? undefined : Number(daysRaw)
  if (days !== undefined && !(Number.isInteger(days) && days >= 1 && days <= 92)) {
    process.stderr.write('--days must be an integer from 1 to 92\n')
    process.exit(64)
  }
  try {
    const result = await backfillEventProperties({
      url,
      username,
      password,
      database,
      logger,
      dryRun,
      ...(days === undefined ? {} : { days }),
    })
    logger.info('backfill_event_properties_finished', { store: 'clickhouse', ...result })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (err) {
    logger.error('backfill_event_properties_failed', { store: 'clickhouse', retryable: false, err })
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
} else if (args[0] === 'backfill-15m') {
  const settle = optionValues('--settle-seconds')[0]
  const settleSeconds = settle === undefined ? undefined : Number(settle)
  if (settleSeconds !== undefined && !(Number.isFinite(settleSeconds) && settleSeconds >= 0)) {
    process.stderr.write('--settle-seconds must be a non-negative number\n')
    process.exit(64)
  }
  const acceptSites = optionValues('--accept-site')
  const sessions = args.includes('--sessions')
  const ifNeeded = args.includes('--if-needed')

  const common = {
    url,
    username,
    password,
    database,
    logger,
    dryRun,
    ifNeeded,
    acceptSites,
    ...(settleSeconds === undefined ? {} : { settleSeconds }),
  }

  try {
    const result = sessions
      ? await backfillSessionRollups15m(common)
      : await backfillFifteenMinuteRollups(common)
    logger.info(sessions ? 'backfill_sessions_15m_finished' : 'backfill_15m_finished', {
      store: 'clickhouse',
      ...result,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (err) {
    if (err instanceof BackfillRefusedError) {
      logger.error('backfill_15m_refused', {
        store: 'clickhouse',
        retryable: false,
        reason: err.reason,
        err,
      })
      process.stderr.write(`${err.message}\n`)
      process.exit(err.reason === 'additive_mismatch' ? 3 : 2)
    }
    logger.error('backfill_15m_failed', { store: 'clickhouse', retryable: false, err })
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
} else {
  try {
    const result = await migrateClickHouse({
      url,
      username,
      password,
      database,
      directory: process.env['CLICKHOUSE_MIGRATIONS_DIR'] ?? MIGRATIONS_DIR,
      logger,
      dryRun,
    })

    logger.info('migrate_finished', {
      store: 'clickhouse',
      dry_run: dryRun,
      applied: result.applied.length,
      pending: result.pending.length,
      already_applied: result.alreadyApplied,
    })

    if (dryRun && result.pending.length > 0) {
      process.stderr.write(`Pending migrations: ${result.pending.join(', ')}\n`)
      process.exit(1)
    }
  } catch (err) {
    logger.error('migrate_failed', { store: 'clickhouse', retryable: false, err })
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
