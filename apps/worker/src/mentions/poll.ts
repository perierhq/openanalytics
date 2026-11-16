import {
  MENTION_AVATAR_MAX_AGE_MS,
  linksToSite,
  mentionQueries,
  type MentionPollError,
} from '@openanalytics/domain'
import type {
  FxTwitterClient,
  FxTwitterSearchResult,
  MentionAvatarClient,
} from '@openanalytics/integrations'
import type { Logger, Metrics } from '@openanalytics/observability'
import {
  avatarStateForHandles,
  dbErrorFacts,
  existingMentionPostIds,
  listSitesDueForMentionPoll,
  recordMentionPoll,
  upsertMentionAvatar,
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
 * Then, once the site's poll is stamped, the authors' pictures (migration
 * 0049): for each distinct author in this poll's posts whose picture the site
 * does not hold, holds from a different URL, or fetched over a week ago, the
 * small picture is downloaded from `pbs.twimg.com` and stored. At most ten per
 * site per poll, one second apart. A picture that fails is counted
 * (`worker_mention_avatars`) and tried again on a later poll; it never fails
 * the poll and never touches `last_error`, which is about the search.
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
 *   and SQLSTATEs, never post text, author names or handles, picture bytes or
 *   a database error message (which would carry the statement's parameters).
 */

const DEFAULT_TICK_MS = 5 * 60_000
const DEFAULT_BATCH_SIZE = 20
const DEFAULT_PAUSE_MS = 1000
const FIRST_POLL_MAX_PAGES = 3
const LATER_POLL_MAX_PAGES = 1
/** Author pictures downloaded per site per poll; the rest wait for the next. */
const AVATARS_PER_SITE = 10

export interface MentionsPollDeps {
  readonly db: Database
  readonly logger: Logger
  readonly metrics: Metrics
  readonly client: FxTwitterClient
  /** Downloads author pictures from `pbs.twimg.com` (migration 0049). */
  readonly avatars: MentionAvatarClient
  /** `MENTIONS_POLL_MINUTES`: how long a site waits between polls. */
  readonly pollMinutes: number
  readonly batchSize?: number
  /** Pause between two consecutive HTTP calls, searches and pictures alike. */
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

/** Downloads and stores a site's due author pictures; never throws. */
type AvatarRefresh = (siteId: string, authors: ReadonlyMap<string, string>) => Promise<void>

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

    const refreshAvatars: AvatarRefresh = (siteId, authors) =>
      refreshSiteAvatars(deps, siteId, authors, { isStopped, sleep, pauseMs, now })

    for (const site of due) {
      if (isStopped()) break
      sites += 1
      const outcome = await pollSite(deps, site, search, refreshAvatars)
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
  refreshAvatars: AvatarRefresh,
): Promise<{ status: SiteStatus; upserted: number }> {
  const maxPages = site.lastPolledAt === null ? FIRST_POLL_MAX_PAGES : LATER_POLL_MAX_PAGES
  let error: MentionPollError | null = null
  let upserted = 0
  // Each distinct author in this poll with a picture to fetch, in the order
  // first seen (newest posts first), mapped to the picture's source URL.
  const authors = new Map<string, string>()

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
        for (const post of posts) {
          if (post.authorAvatarSourceUrl !== null && !authors.has(post.authorHandle)) {
            authors.set(post.authorHandle, post.authorAvatarSourceUrl)
          }
        }
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
  // After the stamp, so neither a failing picture nor a stop between pictures
  // can change what the poll recorded.
  await refreshAvatars(site.siteId, authors)
  return { status, upserted }
}

/**
 * Downloads the due pictures of these authors and stores them for the site.
 * Never throws: a failed download is counted and retried on a later poll, and
 * a database error ends this site's pictures for this poll.
 */
async function refreshSiteAvatars(
  deps: MentionsPollDeps,
  siteId: string,
  authors: ReadonlyMap<string, string>,
  pacing: {
    readonly isStopped: () => boolean
    readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
    readonly pauseMs: number
    readonly now: () => Date
  },
): Promise<void> {
  if (authors.size === 0 || pacing.isStopped()) return
  const counts = new Map<string, number>()
  const count = (status: string) => counts.set(status, (counts.get(status) ?? 0) + 1)

  try {
    const stored = new Map(
      (await avatarStateForHandles(deps.db, siteId, 'x', [...authors.keys()])).map((row) => [
        row.handle,
        row,
      ]),
    )
    const staleBefore = pacing.now().getTime() - MENTION_AVATAR_MAX_AGE_MS
    const due = [...authors]
      .filter(([handle, sourceUrl]) => {
        const held = stored.get(handle)
        return (
          held === undefined ||
          held.fetchedAt.getTime() < staleBefore ||
          held.sourceUrl !== sourceUrl
        )
      })
      .slice(0, AVATARS_PER_SITE)

    for (const [index, [handle, sourceUrl]] of due.entries()) {
      if (pacing.isStopped()) break
      if (index > 0) {
        await pacing.sleep(pacing.pauseMs, deps.signal)
        if (pacing.isStopped()) break
      }
      const result = await deps.avatars.fetchAvatar(
        sourceUrl,
        deps.signal === undefined ? undefined : { signal: deps.signal },
      )
      // A download cut short by `stop()` is neither stored nor counted.
      if (pacing.isStopped()) break
      if (!result.ok) {
        count(result.reason)
        continue
      }
      await upsertMentionAvatar(deps.db, {
        siteId,
        platform: 'x',
        handle,
        contentType: result.contentType,
        bytes: result.bytes,
        sourceUrl,
        fetchedAt: pacing.now(),
      })
      count('ok')
    }
  } catch (err) {
    // Reading or storing failed: logged by category and driver code only, as
    // the poll's own database errors are. The poll is already stamped.
    count('error')
    deps.logger.warn('mention_avatars_failed', {
      site_id: siteId,
      ...dbErrorFacts(err),
      retryable: true,
    })
  }

  let total = 0
  for (const [status, n] of counts) {
    total += n
    deps.metrics.increment(WORKER_METRICS.mentionAvatars, { status }, n)
  }
  if (total > 0) {
    const stored = counts.get('ok') ?? 0
    deps.logger.info('mention_avatars_refreshed', {
      site_id: siteId,
      stored,
      failed: total - stored,
    })
  }
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
