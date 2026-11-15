import { linksToSite, mentionQueries, type MentionPollError } from '@openanalytics/domain'
import type { FxTwitterClient, FxTwitterSearchResult } from '@openanalytics/integrations'
import type { Logger, Metrics } from '@openanalytics/observability'
import {
  dbErrorFacts,
  existingMentionPostIds,
  listSitesDueForMentionPoll,
  recordMentionPoll,
  upsertMentions,
  type Database,
  type MentionPollTarget,
} from '@openanalytics/postgres'
import { WORKER_METRICS } from '../ingest/metrics.ts'

/**
 * The X mentions poller (migration 0048).
 *
 * Every tick picks up to 20 sites that have watching on and were not polled
 * within `MENTIONS_POLL_MINUTES`, least recently polled first, and polls them
 * one after another with a pause between HTTP calls. The search service is a
 * shared public one with no published rate limit, so the loop is slow on
 * purpose.
 *
 * Per site, per query (the domain, then each term as a phrase): read page 1,
 * and keep following the bottom cursor while every post on the page is new to
 * us — up to 3 pages on a site's first-ever poll, 1 afterwards. A page that
 * holds a post we already have means we have caught up. Every post the search
 * returns is stored; a known one has its counts refreshed.
 *
 * What it refuses to do:
 *
 * - **Throw.** It shares a process with batch ingest and email delivery. A
 *   failed search is recorded on the site (`last_error`) and counted; a
 *   database failure is logged and counted, and the site is still stamped
 *   (`invalid_response`) so it waits a full interval; the tick carries on.
 * - **Hammer a service that is down.** After a site's poll ends `unavailable`
 *   the rest of the tick is skipped; those sites are next in line next tick.
 *   The failing site's `last_polled_at` moves too, so it waits a full interval.
 * - **Hold up shutdown.** `stop()` is checked before every search and every
 *   pause, and aborts the pause or search in flight. A site cut short is not
 *   stamped, so it is first in line after the restart.
 * - **Log what people wrote.** Logs carry site ids, counts, failure categories
 *   and SQLSTATEs, never post text, author names or a database error message
 *   (which would carry the statement's parameters).
 */

const DEFAULT_TICK_MS = 5 * 60_000
const DEFAULT_BATCH_SIZE = 20
const DEFAULT_PAUSE_MS = 1000
const FIRST_POLL_MAX_PAGES = 3
const LATER_POLL_MAX_PAGES = 1

export interface MentionsPollDeps {
  readonly db: Database
  readonly logger: Logger
  readonly metrics: Metrics
  readonly client: FxTwitterClient
  /** `MENTIONS_POLL_MINUTES`: how long a site waits between polls. */
  readonly pollMinutes: number
  readonly batchSize?: number
  /** Pause between two consecutive HTTP calls. */
  readonly pauseMs?: number
  readonly tickMs?: number
  readonly now?: () => Date
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** True once `stop()` was called: checked before every search and pause. */
  readonly stopped?: () => boolean
  /** Aborted by `stop()`: cuts a pause short and cancels the search in flight. */
  readonly signal?: AbortSignal
}

export interface MentionsPollResult {
  /** Sites whose poll was attempted. */
  readonly sites: number
  readonly upserted: number
  /** Sites whose poll ended with a search failure or a database error. */
  readonly failed: number
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

/** The queries for a site, each with the term recorded as `matched_term`. */
function queriesFor(site: MentionPollTarget): { query: string; term: string }[] {
  const pairs: { query: string; term: string }[] = []
  if (site.domain !== null && site.domain.length > 0) {
    for (const query of mentionQueries(site.domain, [])) pairs.push({ query, term: site.domain })
  }
  for (const term of site.terms) {
    for (const query of mentionQueries(null, [term])) pairs.push({ query, term })
  }
  return pairs
}

/** One search, or null when the poller was stopped before or during it. */
type PacedSearch = (query: string, cursor?: string) => Promise<FxTwitterSearchResult | null>

/** One tick. Extracted so tests drive it directly rather than through a timer. */
export async function pollMentionsOnce(deps: MentionsPollDeps): Promise<MentionsPollResult> {
  const now = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? defaultSleep
  const pauseMs = deps.pauseMs ?? DEFAULT_PAUSE_MS
  const isStopped = () => deps.stopped?.() === true || deps.signal?.aborted === true
  let sites = 0
  let upserted = 0
  let failed = 0

  try {
    const due = await listSitesDueForMentionPoll(deps.db, {
      staleBefore: new Date(now().getTime() - deps.pollMinutes * 60_000),
      limit: deps.batchSize ?? DEFAULT_BATCH_SIZE,
    })

    let httpCalls = 0
    const search: PacedSearch = async (query, cursor) => {
      if (isStopped()) return null
      if (httpCalls > 0) {
        await sleep(pauseMs, deps.signal)
        if (isStopped()) return null
      }
      httpCalls += 1
      const result = await deps.client.search(
        query,
        cursor,
        deps.signal === undefined ? undefined : { signal: deps.signal },
      )
      // A call cut short by `stop()` says nothing about the service.
      return isStopped() ? null : result
    }

    for (const site of due) {
      if (isStopped()) break
      sites += 1
      const outcome = await pollSite(deps, site, search)
      upserted += outcome.upserted
      if (outcome.status === 'stopped') break
      if (outcome.status !== 'ok') failed += 1
      if (outcome.status === 'unavailable') {
        deps.logger.warn('mentions_poll_backing_off', {
          site_id: site.siteId,
          remaining_sites: due.length - sites,
          retryable: true,
        })
        break
      }
    }
  } catch (err) {
    // Listing the due sites failed: a database outage or a bug. Swallowed so
    // the worker keeps running; the next tick tries again.
    deps.logger.error('mentions_poll_tick_failed', { ...dbErrorFacts(err), retryable: true })
  }

  return { sites, upserted, failed }
}

type SiteStatus = MentionPollError | 'ok' | 'error' | 'stopped'

async function pollSite(
  deps: MentionsPollDeps,
  site: MentionPollTarget,
  search: PacedSearch,
): Promise<{ status: SiteStatus; upserted: number }> {
  const maxPages = site.lastPolledAt === null ? FIRST_POLL_MAX_PAGES : LATER_POLL_MAX_PAGES
  let error: MentionPollError | null = null
  let upserted = 0

  try {
    for (const { query, term } of queriesFor(site)) {
      let cursor: string | undefined
      for (let pages = 1; ; pages += 1) {
        const result = await search(query, cursor)
        if (result === null) {
          // Stopped mid-site. Nothing is recorded, so `last_polled_at` stays
          // where it was and the site is first in line after the restart.
          if (upserted > 0) deps.metrics.increment(WORKER_METRICS.mentionsUpserted, {}, upserted)
          deps.logger.info('mentions_poll_stopped', { site_id: site.siteId, upserted })
          return { status: 'stopped', upserted }
        }
        if (!result.ok) {
          error ??= result.reason
          deps.logger.warn('mentions_search_failed', {
            site_id: site.siteId,
            reason: result.reason,
            detail: result.detail,
            retryable: true,
          })
          break
        }

        // "Known" is read per page, after the earlier queries of this same poll
        // have written their pages. So a post the domain query just found
        // counts as known when a term query finds it too, and stops that
        // query's paging. Acceptable: the post is stored either way, and the
        // only cost is that a term query may page less deep on a first poll.
        const posts = result.data.posts
        const known = await existingMentionPostIds(
          deps.db,
          site.siteId,
          'x',
          posts.map((post) => post.postId),
        )
        upserted += await upsertMentions(deps.db, {
          siteId: site.siteId,
          platform: 'x',
          posts: posts.map((post) => ({
            postId: post.postId,
            url: post.url,
            text: post.text,
            authorHandle: post.authorHandle,
            authorName: post.authorName,
            authorUrl: post.authorUrl,
            authorFollowers: post.authorFollowers,
            likes: post.likes,
            reposts: post.reposts,
            replies: post.replies,
            quotes: post.quotes,
            views: post.views,
            postedAt: post.postedAt,
            matchedTerm: term,
            linksToSite: linksToSite(post.linkHosts, site.domains),
          })),
        })

        const allNew = posts.length > 0 && posts.every((post) => !known.has(post.postId))
        if (!allNew || pages >= maxPages || result.data.nextCursor === null) break
        cursor = result.data.nextCursor
      }
      // The service is down: the remaining queries would fail the same way.
      if (error === 'unavailable') break
    }

    await recordMentionPoll(deps.db, { siteId: site.siteId, error })
  } catch (err) {
    // A database error. Logged by category and driver code only: the error's
    // message carries the statement's parameters, which are post text.
    deps.metrics.increment(WORKER_METRICS.mentionsPoll, { status: 'error' })
    if (upserted > 0) deps.metrics.increment(WORKER_METRICS.mentionsUpserted, {}, upserted)
    deps.logger.error('mentions_poll_failed', {
      site_id: site.siteId,
      ...dbErrorFacts(err),
      retryable: true,
    })
    // Still stamp the poll, so the site waits a full interval rather than
    // failing again every tick. `invalid_response` is the closest of the two
    // recorded reasons: something about what came back could not be stored.
    try {
      await recordMentionPoll(deps.db, { siteId: site.siteId, error: 'invalid_response' })
    } catch (recordErr) {
      deps.logger.error('mentions_poll_record_failed', {
        site_id: site.siteId,
        ...dbErrorFacts(recordErr),
        retryable: true,
      })
    }
    return { status: 'error', upserted }
  }

  const status = error ?? 'ok'
  deps.metrics.increment(WORKER_METRICS.mentionsPoll, { status })
  if (upserted > 0) deps.metrics.increment(WORKER_METRICS.mentionsUpserted, {}, upserted)
  deps.logger.info('mentions_polled', { site_id: site.siteId, status, upserted })
  return { status, upserted }
}

export interface MentionsPoller {
  stop(): Promise<void>
}

/**
 * The loop, in the `currency-rates.ts` shape: a tick every five minutes, one
 * tick at a time, and a stop that waits for the tick in flight. The five-minute
 * tick is only how often the loop looks for due sites; how often a site is
 * searched is `MENTIONS_POLL_MINUTES`.
 */
export function startMentionsPoller(deps: MentionsPollDeps): MentionsPoller {
  let running = false
  let stopped = false
  const controller = new AbortController()

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      await pollMentionsOnce({ ...deps, stopped: () => stopped, signal: controller.signal })
    } catch (err) {
      deps.logger.error('mentions_poll_tick_failed', { ...dbErrorFacts(err), retryable: true })
    } finally {
      running = false
    }
  }

  // Deferred off the boot path so a slow search service cannot delay the
  // health endpoint binding.
  setImmediate(() => void tick())
  const timer = setInterval(() => void tick(), deps.tickMs ?? DEFAULT_TICK_MS)
  timer.unref()

  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      // Ends the pause or the search in flight now, rather than after up to
      // 15 s of socket timeout.
      controller.abort()
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
  }
}
