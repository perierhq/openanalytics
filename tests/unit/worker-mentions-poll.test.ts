import type * as PostgresModule from '@openanalytics/postgres'
import type { Database, MentionPollTarget, MentionUpsertRow } from '@openanalytics/postgres'
import type {
  FxTwitterClient,
  FxTwitterSearchResult,
  MentionAvatarClient,
  MentionAvatarFetchResult,
} from '@openanalytics/integrations'
import { parseFxTwitterSearch } from '@openanalytics/domain'
import type { Metrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fxSearchBody, fxStatus, fxStatusWithId } from '../support/fxtwitter-fixtures.ts'

/**
 * The mentions poller: which sites it picks, how deep it pages, what it
 * records, and that it never throws.
 *
 * Paging rule: keep following `cursor.bottom` while every post on the page is
 * new to us, up to 3 pages on a site's first-ever poll and 1 page afterwards.
 * A page that holds a post we already have means we have caught up.
 */

const state = {
  due: [] as MentionPollTarget[],
  existing: new Set<string>(),
  upserts: [] as { siteId: string; posts: MentionUpsertRow[] }[],
  polls: [] as { siteId: string; error: string | null }[],
  dueArgs: [] as { staleBefore: Date; limit: number }[],
  failUpsert: false,
  /** What a failing upsert throws; defaults to a plain connection error. */
  upsertError: null as Error | null,
  failRecord: false,
  /** Stored avatars by handle, as `avatarStateForHandles` reads them. */
  avatars: new Map<string, { fetchedAt: Date; sourceUrl: string }>(),
  avatarStateArgs: [] as { siteId: string; platform: string; handles: string[] }[],
  avatarUpserts: [] as {
    siteId: string
    platform: string
    handle: string
    contentType: string
    bytes: Uint8Array
    sourceUrl: string
  }[],
  failAvatarState: false,
  failAvatarUpsert: false,
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    listSitesDueForMentionPoll: async (
      _db: unknown,
      input: { staleBefore: Date; limit: number },
    ) => {
      state.dueArgs.push(input)
      return state.due
    },
    existingMentionPostIds: async (
      _db: unknown,
      _siteId: string,
      _platform: string,
      postIds: string[],
    ) => new Set(postIds.filter((id) => state.existing.has(id))),
    upsertMentions: async (_db: unknown, input: { siteId: string; posts: MentionUpsertRow[] }) => {
      if (state.failUpsert) throw state.upsertError ?? new Error('connection reset')
      state.upserts.push({ siteId: input.siteId, posts: [...input.posts] })
      for (const post of input.posts) state.existing.add(post.postId)
      return input.posts.length
    },
    recordMentionPoll: async (_db: unknown, input: { siteId: string; error: string | null }) => {
      if (state.failRecord) throw new Error('connection reset')
      state.polls.push({ siteId: input.siteId, error: input.error })
    },
    avatarStateForHandles: async (
      _db: unknown,
      siteId: string,
      platform: string,
      handles: string[],
    ) => {
      if (state.failAvatarState) throw new Error('connection reset')
      state.avatarStateArgs.push({ siteId, platform, handles: [...handles] })
      return handles.flatMap((handle) => {
        const stored = state.avatars.get(handle)
        return stored === undefined ? [] : [{ handle, ...stored }]
      })
    },
    upsertMentionAvatar: async (
      _db: unknown,
      input: (typeof state.avatarUpserts)[number] & { fetchedAt?: Date },
    ) => {
      if (state.failAvatarUpsert) throw new Error('connection reset')
      const { fetchedAt: _fetchedAt, ...rest } = input
      state.avatarUpserts.push(rest)
    },
  }
})

const { pollMentionsOnce, startMentionsPoller } =
  await import('../../apps/worker/src/mentions/poll.ts')

const SITE = 'site-1'
const NOW = new Date('2026-11-15T12:00:00.000Z')

function target(overrides: Partial<MentionPollTarget> = {}): MentionPollTarget {
  return {
    siteId: SITE,
    domain: 'conductor.build',
    domains: ['conductor.build'],
    terms: [],
    lastPolledAt: null,
    ...overrides,
  }
}

/** A page of statuses with these ids, with or without a next cursor. */
function page(ids: string[], next: string | null = 'next'): FxTwitterSearchResult {
  const parsed = parseFxTwitterSearch(
    fxSearchBody(
      ids.map((id) => fxStatusWithId(id)),
      next,
    ),
  )
  if (!parsed.ok) throw new Error('fixture did not parse')
  return { ok: true, data: { posts: parsed.posts, nextCursor: parsed.nextCursor } }
}

function scriptedClient(
  script: (query: string, cursor: string | undefined) => FxTwitterSearchResult,
) {
  const calls: { query: string; cursor: string | undefined }[] = []
  const client: FxTwitterClient = {
    search: async (query, cursor) => {
      calls.push({ query, cursor })
      return script(query, cursor)
    },
  }
  return { client, calls }
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

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

/** An avatar client that answers every URL with `respond` and records the calls. */
function avatarClient(
  respond: (url: string) => MentionAvatarFetchResult = () => ({
    ok: true,
    contentType: 'image/jpeg',
    bytes: JPEG,
  }),
) {
  const calls: { url: string; signal: AbortSignal | undefined }[] = []
  const client: MentionAvatarClient = {
    fetchAvatar: async (url, options) => {
      calls.push({ url, signal: options?.signal })
      return respond(url)
    },
  }
  return { client, calls }
}

function deps(client: FxTwitterClient, metrics?: Metrics, avatars?: MentionAvatarClient) {
  const captured = createCapturedLogger()
  const sleeps: number[] = []
  return {
    deps: {
      db: {} as Database,
      logger: captured.logger,
      metrics: metrics ?? recordingMetrics().metrics,
      client,
      avatars: avatars ?? avatarClient().client,
      pollMinutes: 60,
      now: () => NOW,
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
    },
    captured,
    sleeps,
  }
}

beforeEach(() => {
  state.due = []
  state.existing = new Set()
  state.upserts = []
  state.polls = []
  state.dueArgs = []
  state.failUpsert = false
  state.upsertError = null
  state.failRecord = false
  state.avatars = new Map()
  state.avatarStateArgs = []
  state.avatarUpserts = []
  state.failAvatarState = false
  state.failAvatarUpsert = false
})

/** A one-page search result with one post per author, each with its own avatar. */
function authorsPage(authors: readonly { handle: string; avatar?: string | null }[]) {
  const parsed = parseFxTwitterSearch(
    fxSearchBody(
      authors.map(({ handle, avatar }, i) =>
        fxStatusWithId(String(500 + i), {
          author: {
            ...fxStatus.author,
            screen_name: handle,
            avatar_url:
              avatar === undefined
                ? `https://pbs.twimg.com/profile_images/${handle}/p_400x400.jpg`
                : avatar,
          },
        }),
      ),
      null,
    ),
  )
  if (!parsed.ok) throw new Error('fixture did not parse')
  const result: FxTwitterSearchResult = {
    ok: true,
    data: { posts: parsed.posts, nextCursor: null },
  }
  return result
}

const avatarOf = (handle: string) => `https://pbs.twimg.com/profile_images/${handle}/p_normal.jpg`
const DAY = 24 * 60 * 60_000

describe('author pictures', () => {
  const polledBefore = { lastPolledAt: new Date('2026-11-15T10:00:00.000Z') }

  it('fetches only missing, week-old or moved pictures, pausing between them', async () => {
    state.due = [target(polledBefore)]
    state.avatars.set('fresh', {
      fetchedAt: new Date(NOW.getTime() - DAY),
      sourceUrl: avatarOf('fresh'),
    })
    state.avatars.set('stale', {
      fetchedAt: new Date(NOW.getTime() - 8 * DAY),
      sourceUrl: avatarOf('stale'),
    })
    state.avatars.set('moved', {
      fetchedAt: new Date(NOW.getTime() - DAY),
      sourceUrl: 'https://pbs.twimg.com/profile_images/old/p_normal.jpg',
    })
    const { client } = scriptedClient(() =>
      authorsPage([
        { handle: 'fresh' },
        { handle: 'stale' },
        { handle: 'moved' },
        { handle: 'newbie' },
        { handle: 'newbie' },
        { handle: 'faceless', avatar: null },
        { handle: 'offsite', avatar: 'https://evil.example/p.jpg' },
      ]),
    )
    const avatars = avatarClient()
    const { metrics, increments } = recordingMetrics()
    const { deps: d, sleeps, captured } = deps(client, metrics, avatars.client)

    await pollMentionsOnce(d)

    expect(state.avatarStateArgs).toEqual([
      { siteId: SITE, platform: 'x', handles: ['fresh', 'stale', 'moved', 'newbie'] },
    ])
    expect(avatars.calls.map((call) => call.url)).toEqual([
      avatarOf('stale'),
      avatarOf('moved'),
      avatarOf('newbie'),
    ])
    expect(state.avatarUpserts).toEqual(
      ['stale', 'moved', 'newbie'].map((handle) => ({
        siteId: SITE,
        platform: 'x',
        handle,
        contentType: 'image/jpeg',
        bytes: JPEG,
        sourceUrl: avatarOf(handle),
      })),
    )
    // One search, then three pictures with a pause between each two.
    expect(sleeps).toEqual([1000, 1000])
    expect(increments.filter((i) => i.name === 'worker_mention_avatars')).toEqual([
      { name: 'worker_mention_avatars', labels: { status: 'ok' }, value: 3 },
    ])
    // Categories only: no handle reaches a log line.
    const logged = JSON.stringify(captured.lines)
    for (const handle of ['stale', 'moved', 'newbie']) expect(logged).not.toContain(handle)
  })

  it('fetches at most ten pictures per site per poll', async () => {
    state.due = [target(polledBefore)]
    const handles = Array.from({ length: 12 }, (_, i) => `author${String(i)}`)
    const { client } = scriptedClient(() => authorsPage(handles.map((handle) => ({ handle }))))
    const avatars = avatarClient()

    await pollMentionsOnce(deps(client, undefined, avatars.client).deps)

    expect(avatars.calls).toHaveLength(10)
    expect(state.avatarUpserts.map((u) => u.handle)).toEqual(handles.slice(0, 10))
  })

  it('skips a picture that failed for a day, so it cannot hold a slot every poll', async () => {
    state.due = [target(polledBefore)]
    const handles = Array.from({ length: 11 }, (_, i) => `author${String(i)}`)
    const { client } = scriptedClient(() => authorsPage(handles.map((handle) => ({ handle }))))
    // author0 always fails; the rest succeed.
    const avatars = avatarClient((url) =>
      url === avatarOf('author0')
        ? { ok: false, reason: 'too_large' }
        : { ok: true, contentType: 'image/jpeg', bytes: JPEG },
    )
    const avatarFailures = new Map<string, number>()
    const first = deps(client, undefined, avatars.client).deps
    await pollMentionsOnce({ ...first, avatarFailures })
    expect(avatars.calls.map((c) => c.url)).toContain(avatarOf('author0'))
    expect(avatars.calls).toHaveLength(10)

    // Next poll, an hour later: author0 is skipped, so author10 gets its slot.
    avatars.calls.length = 0
    const hourLater = new Date(NOW.getTime() + 60 * 60_000)
    await pollMentionsOnce({ ...first, now: () => hourLater, avatarFailures })
    expect(avatars.calls.map((c) => c.url)).not.toContain(avatarOf('author0'))
    expect(avatars.calls.map((c) => c.url)).toContain(avatarOf('author10'))

    // A day after the failure it is tried again.
    avatars.calls.length = 0
    const dayLater = new Date(NOW.getTime() + DAY + 60_000)
    await pollMentionsOnce({ ...first, now: () => dayLater, avatarFailures })
    expect(avatars.calls.map((c) => c.url)).toContain(avatarOf('author0'))
  })

  it('never fails the poll or touches last_error when a picture fails', async () => {
    state.due = [target(polledBefore)]
    const { client } = scriptedClient(() =>
      authorsPage([{ handle: 'one' }, { handle: 'two' }, { handle: 'three' }]),
    )
    const avatars = avatarClient((url) =>
      url === avatarOf('one')
        ? { ok: false, reason: 'unavailable' }
        : url === avatarOf('two')
          ? { ok: false, reason: 'unsupported_type' }
          : { ok: true, contentType: 'image/png', bytes: JPEG },
    )
    const { metrics, increments } = recordingMetrics()

    const result = await pollMentionsOnce(deps(client, metrics, avatars.client).deps)

    expect(result.failed).toBe(0)
    expect(state.polls).toEqual([{ siteId: SITE, error: null }])
    expect(state.avatarUpserts.map((u) => u.handle)).toEqual(['three'])
    expect(increments).toContainEqual({
      name: 'worker_mention_avatars',
      labels: { status: 'unavailable' },
      value: 1,
    })
    expect(increments).toContainEqual({
      name: 'worker_mention_avatars',
      labels: { status: 'unsupported_type' },
      value: 1,
    })
    expect(increments).toContainEqual({
      name: 'worker_mentions_poll',
      labels: { status: 'ok' },
      value: 1,
    })
  })

  it('survives a database failure while reading or storing pictures', async () => {
    state.due = [target(polledBefore), target({ ...polledBefore, siteId: 'b' })]
    state.failAvatarUpsert = true
    const { client } = scriptedClient(() => authorsPage([{ handle: 'one' }, { handle: 'two' }]))
    const avatars = avatarClient()
    const { metrics, increments } = recordingMetrics()
    const { deps: d, captured } = deps(client, metrics, avatars.client)

    const result = await pollMentionsOnce(d)

    expect(result).toMatchObject({ sites: 2, failed: 0 })
    expect(state.polls).toEqual([
      { siteId: SITE, error: null },
      { siteId: 'b', error: null },
    ])
    // A failing store stops that site's pictures; the next site still tries.
    expect(avatars.calls).toHaveLength(2)
    expect(increments).toContainEqual({
      name: 'worker_mention_avatars',
      labels: { status: 'error' },
      value: 1,
    })
    expect(captured.find('mention_avatars_failed')[0]).toMatchObject({ category: 'database' })
    expect(JSON.stringify(captured.lines)).not.toContain('connection reset')

    state.failAvatarUpsert = false
    state.failAvatarState = true
    state.polls = []
    await expect(pollMentionsOnce(d)).resolves.toMatchObject({ failed: 0 })
    expect(state.polls).toHaveLength(2)
  })

  it('stops between pictures, storing nothing the stop cut short', async () => {
    state.due = [target(polledBefore), target({ ...polledBefore, siteId: 'b' })]
    let stopped = false
    const { client, calls } = scriptedClient(() =>
      authorsPage([{ handle: 'one' }, { handle: 'two' }, { handle: 'three' }]),
    )
    const avatars = avatarClient(() => {
      stopped = true
      return { ok: true, contentType: 'image/jpeg', bytes: JPEG }
    })
    const { deps: d, sleeps } = deps(client, undefined, avatars.client)

    await pollMentionsOnce({ ...d, stopped: () => stopped })

    expect(avatars.calls).toHaveLength(1)
    expect(state.avatarUpserts).toEqual([])
    expect(sleeps).toEqual([])
    // The site's posts were stored and its poll stamped before the pictures.
    expect(state.polls).toEqual([{ siteId: SITE, error: null }])
    expect(calls).toHaveLength(1)
  })

  it('passes the stop signal to the download', async () => {
    state.due = [target(polledBefore)]
    const { client } = scriptedClient(() => authorsPage([{ handle: 'one' }]))
    const avatars = avatarClient()
    const controller = new AbortController()

    await pollMentionsOnce({
      ...deps(client, undefined, avatars.client).deps,
      signal: controller.signal,
    })

    expect(avatars.calls[0]?.signal).toBe(controller.signal)
  })
})

describe('pollMentionsOnce', () => {
  it('asks for at most 20 sites not polled within MENTIONS_POLL_MINUTES', async () => {
    const { client } = scriptedClient(() => page([]))
    await pollMentionsOnce(deps(client).deps)
    expect(state.dueArgs).toEqual([
      { staleBefore: new Date(NOW.getTime() - 60 * 60_000), limit: 20 },
    ])
  })

  it('pages up to 3 times on a first poll while every post is new', async () => {
    state.due = [target()]
    let n = 0
    const { client, calls } = scriptedClient(() => {
      n += 1
      return page([`${String(n)}01`, `${String(n)}02`], `c${String(n)}`)
    })

    const { deps: d, sleeps } = deps(client)
    const result = await pollMentionsOnce(d)

    expect(calls).toEqual([
      { query: 'conductor.build', cursor: undefined },
      { query: 'conductor.build', cursor: 'c1' },
      { query: 'conductor.build', cursor: 'c2' },
    ])
    expect(state.upserts.flatMap((u) => u.posts.map((p) => p.postId))).toEqual([
      '101',
      '102',
      '201',
      '202',
      '301',
      '302',
    ])
    expect(result.upserted).toBe(6)
    expect(state.polls).toEqual([{ siteId: SITE, error: null }])
    // A pause between consecutive HTTP calls, never before the first.
    expect(sleeps).toEqual([1000, 1000])
  })

  it('stops paging as soon as a page holds a post it already has', async () => {
    state.due = [target()]
    state.existing.add('100')
    const { client, calls } = scriptedClient(() => page(['101', '100'], 'c1'))

    await pollMentionsOnce(deps(client).deps)

    expect(calls).toHaveLength(1)
    // The known post is still upserted, which refreshes its counts.
    expect(state.upserts[0]?.posts.map((p) => p.postId)).toEqual(['101', '100'])
  })

  it('stops paging when there is no next cursor or the page is empty', async () => {
    state.due = [target()]
    const { client, calls } = scriptedClient(() => page(['1'], null))
    await pollMentionsOnce(deps(client).deps)
    expect(calls).toHaveLength(1)

    state.polls = []
    const empty = scriptedClient(() => page([], 'c1'))
    await pollMentionsOnce(deps(empty.client).deps)
    expect(empty.calls).toHaveLength(1)
  })

  it('reads one page per query after the first poll', async () => {
    state.due = [target({ lastPolledAt: new Date('2026-11-15T10:00:00.000Z'), terms: ['My App'] })]
    let n = 0
    const { client, calls } = scriptedClient(() => {
      n += 1
      return page([`${String(n)}`], `c${String(n)}`)
    })

    await pollMentionsOnce(deps(client).deps)

    expect(calls.map((c) => c.query)).toEqual(['conductor.build', '"My App"'])
    expect(calls.every((c) => c.cursor === undefined)).toBe(true)
  })

  it('records the matched term and whether the post links to the site', async () => {
    state.due = [
      target({ terms: ['Conductor'], lastPolledAt: new Date('2026-11-15T10:00:00.000Z') }),
    ]
    const named = page(['202'], null)
    if (!named.ok) throw new Error('fixture')
    const unlinked: FxTwitterSearchResult = {
      ok: true,
      data: { posts: named.data.posts.map((p) => ({ ...p, linkHosts: [] })), nextCursor: null },
    }
    const { client } = scriptedClient((query) =>
      query === 'conductor.build' ? page(['201'], null) : unlinked,
    )

    await pollMentionsOnce(deps(client).deps)

    const rows = state.upserts.flatMap((u) => u.posts)
    expect(rows.find((r) => r.postId === '201')).toMatchObject({
      matchedTerm: 'conductor.build',
      linksToSite: true,
    })
    expect(rows.find((r) => r.postId === '202')).toMatchObject({
      matchedTerm: 'Conductor',
      linksToSite: false,
    })
  })

  it('records a failing query, still storing what the other queries found', async () => {
    state.due = [target({ terms: ['Conductor'] })]
    const { client } = scriptedClient((query) =>
      query === 'conductor.build'
        ? page(['301'], null)
        : { ok: false, reason: 'invalid_response', detail: 'body has no results array' },
    )
    const { metrics, increments } = recordingMetrics()

    await pollMentionsOnce(deps(client, metrics).deps)

    expect(state.upserts.flatMap((u) => u.posts.map((p) => p.postId))).toEqual(['301'])
    expect(state.polls).toEqual([{ siteId: SITE, error: 'invalid_response' }])
    expect(increments).toContainEqual({
      name: 'worker_mentions_poll',
      labels: { status: 'invalid_response' },
      value: 1,
    })
    expect(increments).toContainEqual({
      name: 'worker_mentions_upserted',
      labels: {},
      value: 1,
    })
  })

  it('backs off for the rest of the tick when the service is unavailable', async () => {
    state.due = [target({ siteId: 'a' }), target({ siteId: 'b' })]
    const { client, calls } = scriptedClient(() => ({
      ok: false,
      reason: 'unavailable',
      detail: 'search responded 503',
    }))

    await pollMentionsOnce(deps(client).deps)

    expect(calls).toHaveLength(1)
    expect(state.polls).toEqual([{ siteId: 'a', error: 'unavailable' }])
  })

  it('never throws, and never logs post text', async () => {
    state.due = [target()]
    state.failUpsert = true
    const { client } = scriptedClient(() => page(['401'], null))
    const { deps: d, captured } = deps(client)

    await expect(pollMentionsOnce(d)).resolves.toBeDefined()
    expect(JSON.stringify(captured.lines)).not.toContain('go away')
    expect(captured.find('mentions_poll_failed')).toHaveLength(1)
  })

  it('never throws when listing due sites fails', async () => {
    const { client } = scriptedClient(() => page([]))
    // Not an array: iterating it throws inside the tick, as a database error would.
    state.due = undefined as unknown as MentionPollTarget[]
    const { deps: d, captured } = deps(client)
    await expect(pollMentionsOnce(d)).resolves.toEqual({ sites: 0, upserted: 0, failed: 0 })
    expect(captured.find('mentions_poll_tick_failed')).toHaveLength(1)
  })

  it('logs a database failure by category and driver code, never its message', async () => {
    state.due = [target()]
    state.failUpsert = true
    // drizzle's query error puts the statement's parameters, post text
    // included, into its message.
    state.upsertError = Object.assign(
      new Error("Failed query: insert into mentions ... params: I'm so sad to se go away..."),
      {
        cause: Object.assign(new Error('new row violates check constraint'), {
          code: '23514',
          constraint: 'mentions_text_length_check',
        }),
      },
    )
    const { client } = scriptedClient(() => page(['401'], null))
    const { deps: d, captured } = deps(client)

    await pollMentionsOnce(d)

    const logged = JSON.stringify(captured.lines)
    expect(logged).not.toContain('so sad')
    expect(logged).not.toContain('Failed query')
    expect(captured.find('mentions_poll_failed')[0]).toMatchObject({
      site_id: SITE,
      category: 'database',
      db_code: '23514',
      db_constraint: 'mentions_text_length_check',
    })
  })

  it('still stamps the poll after a database failure, so the site waits an interval', async () => {
    state.due = [target()]
    state.failUpsert = true
    const { client } = scriptedClient(() => page(['401'], null))

    const result = await pollMentionsOnce(deps(client).deps)

    expect(result.failed).toBe(1)
    expect(state.polls).toEqual([{ siteId: SITE, error: 'invalid_response' }])
  })

  it('only logs the category when stamping the failed poll fails too', async () => {
    state.due = [target()]
    state.failUpsert = true
    state.failRecord = true
    const { client } = scriptedClient(() => page(['401'], null))
    const { deps: d, captured } = deps(client)

    await expect(pollMentionsOnce(d)).resolves.toMatchObject({ failed: 1 })
    expect(captured.find('mentions_poll_record_failed')[0]).toMatchObject({
      site_id: SITE,
      category: 'database',
    })
    expect(JSON.stringify(captured.lines)).not.toContain('connection reset')
  })
})

describe('stopping', () => {
  it('ends the tick before the next search and records nothing for the site', async () => {
    state.due = [target({ terms: ['Conductor'] }), target({ siteId: 'b' })]
    let stopped = false
    const { client, calls } = scriptedClient(() => {
      stopped = true
      return page(['101'], 'c1')
    })
    const { deps: d, sleeps } = deps(client)

    const result = await pollMentionsOnce({ ...d, stopped: () => stopped })

    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect(state.polls).toEqual([])
    expect(result.failed).toBe(0)
  })

  it('cuts a pause short when the signal aborts', async () => {
    state.due = [target()]
    const controller = new AbortController()
    const { client, calls } = scriptedClient(() => {
      setTimeout(() => controller.abort(), 20)
      return page(['101', '102'], 'c1')
    })
    const { deps: base } = deps(client)
    // The real sleep, with a pause long enough to time the test out.
    const { sleep: _unused, ...d } = base

    const started = Date.now()
    await pollMentionsOnce({
      ...d,
      pauseMs: 60_000,
      signal: controller.signal,
      stopped: () => controller.signal.aborted,
    })

    expect(Date.now() - started).toBeLessThan(2000)
    expect(calls).toHaveLength(1)
    expect(state.polls).toEqual([])
  })

  it('aborts the search in flight on stop(), and records nothing for the site', async () => {
    state.due = [target()]
    let seen: AbortSignal | undefined
    let called: () => void = () => {}
    const inFlight = new Promise<void>((resolve) => {
      called = resolve
    })
    const client: FxTwitterClient = {
      search: (_query, _cursor, options) => {
        seen = options?.signal
        called()
        return new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () => {
            resolve({ ok: false, reason: 'unavailable', detail: 'search request did not complete' })
          })
        })
      },
    }
    const { deps: d } = deps(client)

    const poller = startMentionsPoller({ ...d, tickMs: 3_600_000 })
    await inFlight
    const started = Date.now()
    await poller.stop()

    expect(Date.now() - started).toBeLessThan(1000)
    expect(seen?.aborted).toBe(true)
    expect(state.polls).toEqual([])
  })
})
