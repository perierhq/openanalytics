import {
  META_ADS_SYNC_INTERVAL_HOURS,
  META_ADS_USAGE_BACKOFF_PERCENT,
  metaAdsCredentialAad,
  metaBackfillChunk,
  metaSyncWindow,
  type MetaAdsError,
  type MetaUsage,
} from '@openanalytics/domain'
import type {
  CredentialVault,
  MetaAdsClient,
  MetaInsightsResult,
} from '@openanalytics/integrations'
import type { Logger, Metrics } from '@openanalytics/observability'
import {
  dbErrorFacts,
  listDueMetaAdsConnections,
  recordMetaAdsSync,
  upsertMetaAdsSpend,
  type Database,
  type MetaAdsConnectionRecord,
} from '@openanalytics/postgres'
import { WORKER_METRICS } from '../ingest/metrics.ts'

/**
 * The Meta Ads spend sync (migration 0052).
 *
 * Every tick picks up to ten connections that are active and due
 * (`next_sync_at` has passed), soonest first, and syncs them one after
 * another. A sync decrypts the site's token, reads the last three days of
 * daily spend per campaign (Meta restates recent spend) and upserts the
 * campaign-days. Then it records the outcome and when the site is due again.
 *
 * **A first sync** reads those three days first, then the ninety days before
 * them, oldest first, in thirty-day chunks (`metaBackfillChunk`). Each chunk's
 * spend and the backfill cursor are written in one transaction, so an attempt
 * cut short by a rate limit or an outage resumes after the last whole chunk
 * on the next one; `last_synced_at` is set only when the backfill is done.
 *
 * | outcome                    | next sync                            | tick   |
 * |----------------------------|--------------------------------------|--------|
 * | ok                         | in 6 hours                           | goes on|
 * | first sync paused, usage   | when Meta's budget is back (≥ 15 min)| stops  |
 * | `unauthorized`             | never: the connection stops polling  | goes on|
 * |                            | (`needs_reconnect`) until reconnected|        |
 * | `credential_undecryptable` | in 6 hours, and on the first tick    | goes on|
 * |                            | after the worker starts              |        |
 * | `rate_limited`             | Meta's estimate, at least an hour    | stops  |
 * | `unavailable`              | in an hour                           | stops  |
 * | `invalid_response`         | in 6 hours                           | goes on|
 *
 * **A token this install cannot decrypt** is not Meta's refusal and does not
 * stop polling: the fix is the operator's (restore the key the row names to
 * `OA_CREDENTIAL_KEYRING`), and the keyring is read when the worker starts, so
 * the first tick after a start retries every such connection at once, as the
 * revenue sweep retries a `credential_undecryptable` credential. Meta is never
 * called for it.
 *
 * **Only the connection it read.** Every write names the connection's
 * `connected_at` and ad account, and `upsertMetaAdsSpend` writes nothing once
 * either has changed: a sync still running when the owner disconnects, or
 * switches account, cannot put spend back.
 *
 * **Backing off.** The client stops paging once Meta's usage headers pass 75%
 * of any budget (app, business use case, or ad account). When that happens,
 * or a sync is throttled, or a read ends above 75%, the whole loop waits
 * (Meta's estimate, at least 15 minutes) before it calls Meta again for any
 * site: the app's budget is shared by every site this install syncs.
 *
 * **What it never logs.** The token, anything that could carry it (a
 * request URL, a thrown error's message, Meta's own error message) and the ad
 * account id. Lines carry the site id, a category, a categorized detail built
 * from status codes, and counts; a database error is reduced to its SQLSTATE.
 *
 * **It never throws.** It shares a process with batch ingest.
 */

const DEFAULT_TICK_MS = 5 * 60_000
const DEFAULT_BATCH_SIZE = 10
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
/** The least a throttled site waits, whatever Meta estimates. */
const RATE_LIMIT_MIN_WAIT_MS = HOUR_MS
/** The least the whole loop waits after it saw a budget above 75%. */
const LOOP_BACKOFF_MIN_MS = 15 * MINUTE_MS

export interface MetaAdsSyncDeps {
  readonly db: Database
  readonly logger: Logger
  readonly metrics: Metrics
  readonly client: MetaAdsClient
  /** The credential keyring: the token is decrypted per sync, never cached. */
  readonly vault: CredentialVault
  readonly batchSize?: number
  readonly tickMs?: number
  readonly now?: () => Date
  /**
   * Until when the loop makes no Meta call at all, in epoch ms. Shared across
   * ticks by `startMetaAdsSync`; memory only, so a restart forgets it, which
   * costs at most one throttled call per site.
   */
  readonly backoff?: { until: number }
  /**
   * List connections whose token could not be decrypted as due, whatever
   * their `next_sync_at`. `startMetaAdsSync` sets it on its first tick.
   */
  readonly retryUndecryptable?: boolean
  readonly stopped?: () => boolean
  readonly signal?: AbortSignal
}

export interface MetaAdsSyncResult {
  /** Connections whose sync was attempted. */
  readonly sites: number
  /** Syncs that ended in a failure category or a database error. */
  readonly failed: number
  /** Campaign-day rows written. */
  readonly rows: number
}

type SiteOutcome = {
  readonly error: MetaAdsError | null
  readonly rows: number
  /** Stop the tick after this site: Meta is throttling or down. */
  readonly stopTick: boolean
}

/** One tick. Extracted so tests drive it directly rather than through a timer. */
export async function syncMetaAdsOnce(deps: MetaAdsSyncDeps): Promise<MetaAdsSyncResult> {
  const now = deps.now ?? (() => new Date())
  const backoff = deps.backoff ?? { until: 0 }
  const isStopped = () => deps.stopped?.() === true || deps.signal?.aborted === true
  let sites = 0
  let failed = 0
  let rows = 0

  if (backoff.until > now().getTime()) return { sites, failed, rows }

  try {
    const due = await listDueMetaAdsConnections(deps.db, {
      now: now(),
      limit: deps.batchSize ?? DEFAULT_BATCH_SIZE,
      ...(deps.retryUndecryptable === true ? { includeUndecryptable: true } : {}),
    })
    for (const connection of due) {
      if (isStopped()) break
      sites += 1
      const outcome = await syncSite(deps, connection, now, backoff)
      rows += outcome.rows
      if (outcome.error !== null) failed += 1
      if (outcome.stopTick) {
        deps.logger.warn('meta_ads_sync_backing_off', {
          site_id: connection.siteId,
          remaining_sites: due.length - sites,
          backoff_until: new Date(backoff.until).toISOString(),
          retryable: true,
        })
        break
      }
    }
  } catch (err) {
    deps.logger.error('meta_ads_sync_tick_failed', { ...dbErrorFacts(err), retryable: true })
  }
  return { sites, failed, rows }
}

function nextSyncFor(error: MetaAdsError | null, at: number, regainMinutes: number): number {
  switch (error) {
    case 'rate_limited':
      return at + Math.max(regainMinutes * MINUTE_MS, RATE_LIMIT_MIN_WAIT_MS)
    case 'unavailable':
      return at + HOUR_MS
    default:
      return at + META_ADS_SYNC_INTERVAL_HOURS * HOUR_MS
  }
}

const isHot = (usage: MetaUsage) =>
  usage.percent !== null && usage.percent > META_ADS_USAGE_BACKOFF_PERCENT

async function syncSite(
  deps: MetaAdsSyncDeps,
  connection: MetaAdsConnectionRecord,
  now: () => Date,
  backoff: { until: number },
): Promise<SiteOutcome> {
  const at = now()
  const record = async (input: {
    error: MetaAdsError | null
    completed: boolean
    nextSyncAt: number
  }) => {
    await recordMetaAdsSync(deps.db, {
      siteId: connection.siteId,
      connectedAt: connection.connectedAt,
      at,
      error: input.error,
      completed: input.completed,
      nextSyncAt: new Date(input.nextSyncAt),
    })
  }
  const count = (status: string) => deps.metrics.increment(WORKER_METRICS.metaAdsSync, { status })
  const firstSync = connection.lastSyncedAt === null

  let written = 0
  try {
    const decrypted = deps.vault.decrypt(
      connection.encryptedToken,
      metaAdsCredentialAad({ siteId: connection.siteId, adAccountId: connection.adAccountId }),
    )
    if (!decrypted.ok) {
      // Ours, not Meta's: the ring lost the key the row names, or the row was
      // altered. Polling goes on (a decrypt costs no call to Meta), and the
      // first tick after a restart retries it at once.
      deps.logger.error('meta_ads_token_undecryptable', {
        site_id: connection.siteId,
        reason: decrypted.reason,
        retryable: true,
      })
      await record({
        error: 'credential_undecryptable',
        completed: false,
        nextSyncAt: nextSyncFor('credential_undecryptable', at.getTime(), 0),
      })
      count('credential_undecryptable')
      return { error: 'credential_undecryptable', rows: 0, stopTick: false }
    }

    const today = at.toISOString().slice(0, 10)
    const read = async (window: { since: string; until: string }): Promise<MetaInsightsResult> =>
      await deps.client.fetchInsights(
        {
          adAccountId: connection.adAccountId,
          token: decrypted.plaintext,
          since: window.since,
          until: window.until,
          fallbackCurrency: connection.currency,
        },
        deps.signal === undefined ? undefined : { signal: deps.signal },
      )
    // Whole campaign-days, so what was read before a failure is kept: the
    // next sync rereads the window and overwrites it anyway. The cursor moves
    // only with a chunk that was read to its end.
    // False when the connection is no longer the one this sync read.
    const write = async (result: MetaInsightsResult, backfillCursor?: string) => {
      if (result.rows.length === 0 && backfillCursor === undefined) return true
      const n = await upsertMetaAdsSpend(deps.db, {
        siteId: connection.siteId,
        connectedAt: connection.connectedAt,
        adAccountId: connection.adAccountId,
        rows: result.rows,
        fetchedAt: at,
        ...(backfillCursor === undefined ? {} : { backfillCursor }),
      })
      if (n === null) return false
      written += n
      if (n > 0) deps.metrics.increment(WORKER_METRICS.metaAdsSpendRows, {}, n)
      return true
    }
    // The owner disconnected or switched account while this ran: nothing was
    // stored, the token is not used again, and there is no outcome to record
    // (`recordMetaAdsSync` would match no row either).
    const superseded = (): SiteOutcome => {
      count('superseded')
      deps.logger.info('meta_ads_sync_superseded', {
        site_id: connection.siteId,
        first_sync: firstSync,
      })
      return { error: null, rows: written, stopTick: false }
    }

    // The recent window first, every time: it is what the dashboard shows
    // today, and a first sync that is cut short still has it.
    let result = await read(metaSyncWindow({ today, firstSync: false }))
    if (!(await write(result))) return superseded()
    let reads = 1
    let skipped = result.ok ? result.skipped : 0
    let pages = result.ok ? result.pages : 0
    let paused = false

    if (firstSync && result.ok) {
      let cursor = connection.backfillCursor
      for (;;) {
        const chunk = metaBackfillChunk({ today, cursor })
        if (chunk === null) break
        if (isHot(result.usage) || (deps.stopped?.() ?? false) || deps.signal?.aborted === true) {
          paused = true
          break
        }
        result = await read(chunk)
        reads += 1
        if (!result.ok) {
          if (!(await write(result))) return superseded()
          break
        }
        if (!(await write(result, chunk.until))) return superseded()
        cursor = chunk.until
        skipped += result.skipped
        pages += result.pages
      }
    }

    const usage = result.usage
    const hot = isHot(usage)
    const error = result.ok ? null : result.reason
    if (hot || error === 'rate_limited') {
      backoff.until = Math.max(
        backoff.until,
        at.getTime() + Math.max(usage.regainMinutes * MINUTE_MS, LOOP_BACKOFF_MIN_MS),
      )
    }

    const completed = result.ok && !paused
    await record({
      error,
      completed,
      // A first sync paused for the budget comes back as soon as the loop
      // may call Meta again, not a full interval later.
      nextSyncAt: paused
        ? Math.max(backoff.until, at.getTime() + LOOP_BACKOFF_MIN_MS)
        : nextSyncFor(error, at.getTime(), usage.regainMinutes),
    })
    count(error ?? (paused ? 'paused' : 'ok'))
    if (result.ok) {
      deps.logger.info(paused ? 'meta_ads_backfill_paused' : 'meta_ads_synced', {
        site_id: connection.siteId,
        first_sync: firstSync,
        rows: written,
        reads,
        skipped,
        pages,
        usage_percent: usage.percent,
      })
    } else {
      deps.logger.warn('meta_ads_sync_failed', {
        site_id: connection.siteId,
        reason: result.reason,
        first_sync: firstSync,
        // Built by the client from the HTTP status and Meta's numeric code.
        detail: result.detail,
        rows: written,
        reads,
        retryable: result.reason !== 'unauthorized',
      })
    }
    return {
      error,
      rows: written,
      stopTick: hot || paused || error === 'rate_limited' || error === 'unavailable',
    }
  } catch (err) {
    // A database error. Never the error itself: its message carries the
    // statement's parameters.
    count('error')
    deps.logger.error('meta_ads_sync_db_failed', {
      site_id: connection.siteId,
      ...dbErrorFacts(err),
      retryable: true,
    })
    try {
      await recordMetaAdsSync(deps.db, {
        siteId: connection.siteId,
        connectedAt: connection.connectedAt,
        at,
        error: 'invalid_response',
        completed: false,
        nextSyncAt: new Date(at.getTime() + HOUR_MS),
      })
    } catch (recordErr) {
      deps.logger.error('meta_ads_sync_record_failed', {
        site_id: connection.siteId,
        ...dbErrorFacts(recordErr),
        retryable: true,
      })
    }
    return { error: 'invalid_response', rows: written, stopTick: false }
  }
}

export interface MetaAdsSync {
  stop(): Promise<void>
}

/**
 * The loop, in the `currency-rates.ts` shape: a tick every five minutes, one
 * tick at a time, and a stop that waits for the tick in flight. The tick is
 * only how often the loop looks for due connections; how often a site is
 * synced is `next_sync_at`.
 */
export function startMetaAdsSync(deps: MetaAdsSyncDeps): MetaAdsSync {
  let running = false
  let stopped = false
  const controller = new AbortController()
  const backoff = deps.backoff ?? { until: 0 }

  // The keyring is read once, at start: the first tick is the one moment a
  // token that could not be decrypted before may decrypt now.
  let firstTick = true

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    const retryUndecryptable = firstTick
    firstTick = false
    try {
      await syncMetaAdsOnce({
        ...deps,
        backoff,
        retryUndecryptable,
        stopped: () => stopped,
        signal: controller.signal,
      })
    } catch (err) {
      deps.logger.error('meta_ads_sync_tick_failed', { ...dbErrorFacts(err), retryable: true })
    } finally {
      running = false
    }
  }

  setImmediate(() => void tick())
  const timer = setInterval(() => void tick(), deps.tickMs ?? DEFAULT_TICK_MS)
  timer.unref()

  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      controller.abort()
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
  }
}
