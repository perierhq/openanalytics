import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import { migrateClickHouse } from '@openanalytics/clickhouse'
import { computeFunnel, type FunnelEvent } from '@openanalytics/domain'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpClickHouseReader } from '../../apps/query-gateway/src/clickhouse-http.ts'
import { findOperation } from '../../apps/query-gateway/src/operations.ts'
import type { QueryParameterValue } from '../../apps/query-gateway/src/clickhouse.ts'

/**
 * The Milestone 8 session-read and funnel gateway operations, proven with data
 * (plan items 6-7, acceptance criterion 4; docs snapshot 05, D-211).
 *
 * Every assertion runs the real request path — `operation.bindParams(input)` →
 * placeholders + bound parameters → the HTTP read-only reader → an actual
 * migrated ClickHouse — so what it proves that the in-process suite cannot:
 *
 *   1. **The provisional layer reads current truth: argMax over version, THEN
 *      retracted = 0.** A late version flips a provisional bounce to engaged, and
 *      a retraction tombstone drops a superseded session id — never a pre-filter,
 *      never FINAL (migration 0013's read contract).
 *   2. **The finalized layer reads argMax over generation** from the swap rollup,
 *      and its additive measures sum across buckets (migration 0014).
 *   3. **Cross-site isolation** — a site's session read never returns another
 *      site's rows.
 *   4. **The funnel operation's `windowFunnel` matches the pure `computeFunnel`
 *      reference** on the same seeded events — the deterministic funnel spec.
 *   5. **A timezone-local session bucket is labelled by its instant, in UTC.**
 *      `session_start` is DateTime64(3, 'UTC') and `bucket_start` DateTime('UTC'),
 *      but `toStartOf*(col, tz)` renders in `tz`, and the API serializes a bucket
 *      by appending "Z" — so the label has to come back as the UTC rendering of
 *      the same instant.
 *
 * Skipped without TEST_CLICKHOUSE_URL; CI always provides one. Written to the
 * standing ClickHouse read rules (argMax-then-filter, alias-qualified aggregates)
 * because there is no local ClickHouse to run it against.
 */

const URL_ = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''

const describeIfClickHouse = URL_ ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

/** A session_facts_versions row with sensible defaults. */
function factRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    site_id: '',
    session_id: '',
    version: 1,
    visitor_id: '',
    user_id: '',
    anonymous_id: '',
    session_hint: '',
    midnight_bridged: 0,
    session_start: '2026-07-01 09:00:00.000',
    session_end: '2026-07-01 09:00:00.000',
    pageviews: 1,
    engaged: 0,
    active_duration_ms: 0,
    session_duration_ms: 0,
    entry_page_path: '',
    exit_page_path: '',
    referrer_domain: '',
    utm_source: '',
    utm_medium: '',
    utm_campaign: '',
    device_type: '',
    browser: '',
    os: '',
    country: '',
    city: '',
    session_hints: [],
    finalized: 0,
    retracted: 0,
    computed_at: '2026-07-01 10:00:00.000',
    ...over,
  }
}

describeIfClickHouse('session-read and funnel gateway operations', () => {
  const url = URL_ as string
  const database = `m8gw_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
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
    const controller = new AbortController()
    const result = await reader.query({
      sql: operation.sql,
      parameters,
      signal: controller.signal,
      queryId: randomUUID(),
      settings: { max_execution_time: 20, max_result_rows: 200_000, result_overflow_mode: 'throw' },
    })
    return [...result.rows]
  }

  const insertFacts = async (rows: readonly Record<string, unknown>[]): Promise<void> => {
    await client.insert({ table: 'session_facts_versions', values: rows, format: 'JSONEachRow' })
  }

  const insertRawEvents = async (rows: readonly Record<string, unknown>[]): Promise<void> => {
    await client.insert({
      table: 'events_raw',
      values: rows.map((row) => ({
        schema_version: 1,
        batch_id: 'b',
        name: '',
        billable: 1,
        anonymous_id: '',
        user_id: '',
        session_id: '',
        page_path: '',
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
        ...row,
      })),
      format: 'JSONEachRow',
    })
  }

  const siteA = randomUUID()
  const siteB = randomUUID()

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

  // -------------------------------------------------------------------------
  // Entry, exit and bounce (ADR-0075, D-E1)
  // -------------------------------------------------------------------------

  it('entry/exit: argMax first and retraction after, with a single-page session counted once', async () => {
    // The retraction trap, on the new operation. Filtering `retracted = 0`
    // BEFORE the version selection discards the tombstone and resurrects the
    // stale version underneath it — so this seeds exactly that shape and proves
    // the read returns nothing for it, while a session whose latest version is
    // live is counted.
    const from = '2026-07-05T09:00:00.000Z'
    const to = '2026-07-05T10:00:00.000Z'
    const site = randomUUID()

    await insertFacts([
      // A bounced single-page session: entry and exit are the same path, and it
      // must contribute one entrance, one exit and ONE session, not two.
      factRow({
        site_id: site,
        session_id: 'ee-single',
        version: 1,
        session_start: '2026-07-05 09:05:00.000',
        entry_page_path: '/lp',
        exit_page_path: '/lp',
        engaged: 0,
      }),
      // A two-page engaged session: entrance on /lp, exit on /pricing, no bounce.
      factRow({
        site_id: site,
        session_id: 'ee-two',
        version: 1,
        session_start: '2026-07-05 09:10:00.000',
        entry_page_path: '/lp',
        exit_page_path: '/pricing',
        engaged: 1,
      }),
      // A session that WAS stored and has since been retracted. Its live version
      // is seeded first so a pre-filtering read would find it and count it.
      factRow({
        site_id: site,
        session_id: 'ee-gone',
        version: 1,
        session_start: '2026-07-05 09:20:00.000',
        entry_page_path: '/lp',
        exit_page_path: '/lp',
        engaged: 0,
      }),
      // A session with no page view at all — only a custom event. Its empty
      // entry/exit path is not a page and must not become a row.
      factRow({
        site_id: site,
        session_id: 'ee-nopage',
        version: 1,
        session_start: '2026-07-05 09:30:00.000',
        entry_page_path: '',
        exit_page_path: '',
        engaged: 1,
      }),
    ])
    // The tombstone goes in its own INSERT, and that is load-bearing rather than
    // tidy: ReplacingMergeTree collapses equal sort keys WITHIN one written
    // block, so seeding both versions together would erase v1 before any read
    // could be wrong about it — and the pre-filter comparison below would pass
    // for the wrong reason.
    await insertFacts([
      factRow({
        site_id: site,
        session_id: 'ee-gone',
        version: 2,
        session_start: '2026-07-05 09:20:00.000',
        entry_page_path: '/lp',
        exit_page_path: '/lp',
        engaged: 0,
        retracted: 1,
      }),
    ])

    const rows = await run('analytics.page_sessions_hour', {
      site_id: site,
      from,
      to,
      limit: 50,
    })
    const byPath = new Map(rows.map((row) => [String(row['page_path']), row]))

    expect([...byPath.keys()].sort()).toEqual(['/lp', '/pricing'])

    // /lp: two entrances (single + two-page), one exit (the single-page one),
    // one bounce. The retracted session contributes nothing — a pre-filtering
    // read would have said three entrances and two bounces.
    expect(Number(byPath.get('/lp')?.['entrances'])).toBe(2)
    expect(Number(byPath.get('/lp')?.['exits'])).toBe(1)
    expect(Number(byPath.get('/lp')?.['bounces'])).toBe(1)
    // Two distinct sessions touched /lp as an entry or an exit, and the
    // single-page session's two arrayJoin rows must not double it.
    expect(Number(byPath.get('/lp')?.['sessions'])).toBe(2)

    // /pricing is an exit only: a bounce is a property of where a visit BEGAN,
    // so it is counted on the entry row alone.
    expect(Number(byPath.get('/pricing')?.['exits'])).toBe(1)
    expect(Number(byPath.get('/pricing')?.['entrances'])).toBe(0)
    expect(Number(byPath.get('/pricing')?.['bounces'])).toBe(0)

    // And the trap itself, run side by side, the way `clickhouse-sessions`
    // proves it for the raw fact read. Filtering `retracted = 0` BEFORE the
    // version selection discards the tombstone and resurrects the stale v1,
    // which counts a session that no longer exists. Asserting the wrong read is
    // wrong is what makes the right read's `2` mean something: on a
    // ReplacingMergeTree a background merge could have collapsed the two
    // versions and made a pre-filter accidentally correct, and then this
    // fixture would no longer be testing anything — so it fails loudly instead.
    const operation = findOperation('analytics.page_sessions_hour')!
    const naiveSql = operation.sql.replace(
      '    WHERE sfv.site_id = {site_id:UUID}',
      '    WHERE sfv.site_id = {site_id:UUID}\n      AND sfv.retracted = 0',
    )
    expect(naiveSql).not.toBe(operation.sql)
    const naive = await client
      .query({
        query: naiveSql,
        query_params: operation.bindParams({ site_id: site, from, to, limit: 50 }),
        format: 'JSONEachRow',
      })
      .then((set) => set.json<Record<string, unknown>>())
    const naiveLp = naive.find((row) => String(row['page_path']) === '/lp')
    expect(Number(naiveLp?.['entrances'])).toBe(3)
    expect(Number(naiveLp?.['bounces'])).toBe(2)
  })

  // -------------------------------------------------------------------------
  // Filtered reads (ADR-0075, D-F1/D-F3)
  // -------------------------------------------------------------------------

  it('a filtered read selects SESSIONS and then counts everything those sessions did', async () => {
    // D-F1, proven with data rather than asserted in prose. A visitor arrives
    // from youtube.com and reads three pages; only the landing page view carries
    // the referrer. A pageview-grain filter would report one page under
    // `Source: youtube.com`; the session-grain filter must report three.
    const site = randomUUID()
    const from = '2026-07-06T09:00:00.000Z'
    const to = '2026-07-06T10:00:00.000Z'

    await insertFacts([
      factRow({
        site_id: site,
        session_id: 'f-yt',
        version: 1,
        session_start: '2026-07-06 09:01:00.000',
        session_hint: 'hint-yt',
        session_hints: ['hint-yt'],
        anonymous_id: 'anon-yt',
        referrer_domain: 'youtube.com',
        country: 'US',
        city: 'Austin',
        device_type: 'desktop',
      }),
      factRow({
        site_id: site,
        session_id: 'f-direct',
        version: 1,
        session_start: '2026-07-06 09:02:00.000',
        session_hint: 'hint-direct',
        session_hints: ['hint-direct'],
        anonymous_id: 'anon-direct',
        referrer_domain: '',
        country: 'US',
        city: 'Austin',
        device_type: 'desktop',
      }),
      // A retracted session that WOULD match the filter. It must not admit its
      // events, and the tombstone only works if the version selection runs first.
      factRow({
        site_id: site,
        session_id: 'f-gone',
        version: 1,
        session_start: '2026-07-06 09:03:00.000',
        session_hint: 'hint-gone',
        session_hints: ['hint-gone'],
        referrer_domain: 'youtube.com',
      }),
      // One session, two tabs: the sessionizer partitions by identity rather
      // than by hint, so this session owns two hints and `session_hint` stores
      // only the first. Joining on the entry hint alone would lose every event
      // of the second tab — measured at roughly one page view in six on
      // production, which is what `session_hints` exists to fix.
      factRow({
        site_id: site,
        session_id: 'f-twotabs',
        version: 1,
        session_start: '2026-07-06 09:04:00.000',
        session_hint: 'hint-tab1',
        session_hints: ['hint-tab1', 'hint-tab2'],
        anonymous_id: 'anon-tabs',
        referrer_domain: 'youtube.com',
        country: 'DE',
        city: 'Berlin',
        device_type: 'mobile',
      }),
    ])
    // Its own INSERT, for the reason the entry/exit case states: a Replacing
    // engine collapses equal sort keys within one written block, so a tombstone
    // seeded beside its own predecessor proves nothing about the read order.
    await insertFacts([
      factRow({
        site_id: site,
        session_id: 'f-gone',
        version: 2,
        session_start: '2026-07-06 09:03:00.000',
        session_hint: 'hint-gone',
        session_hints: ['hint-gone'],
        referrer_domain: 'youtube.com',
        retracted: 1,
      }),
    ])

    await insertRawEvents([
      // The YouTube session's three page views. Only the first carries the
      // referrer, which is the whole reason a pageview-grain filter is wrong.
      {
        site_id: site,
        event_id: randomUUID(),
        type: 'page_view',
        origin: 'live',
        occurred_at: '2026-07-06 09:01:00.000',
        received_at: '2026-07-06 09:01:00.000',
        accepted_at: '2026-07-06 09:01:00.000',
        clock_skewed: 0,
        ingest_generation: 1,
        billing_user_id: randomUUID(),
        billing_assignment_version: 1,
        usage_window_start: '2026-07-06 00:00:00.000',
        billing_grace: 0,
        session_id: 'hint-yt',
        anonymous_id: 'anon-yt',
        page_path: '/lp',
        referrer_domain: 'youtube.com',
      },
      {
        site_id: site,
        event_id: randomUUID(),
        type: 'page_view',
        origin: 'live',
        occurred_at: '2026-07-06 09:01:30.000',
        received_at: '2026-07-06 09:01:30.000',
        accepted_at: '2026-07-06 09:01:30.000',
        clock_skewed: 0,
        ingest_generation: 1,
        billing_user_id: randomUUID(),
        billing_assignment_version: 1,
        usage_window_start: '2026-07-06 00:00:00.000',
        billing_grace: 0,
        session_id: 'hint-yt',
        anonymous_id: 'anon-yt',
        page_path: '/pricing',
      },
      {
        site_id: site,
        event_id: randomUUID(),
        type: 'page_view',
        origin: 'live',
        occurred_at: '2026-07-06 09:02:00.000',
        received_at: '2026-07-06 09:02:00.000',
        accepted_at: '2026-07-06 09:02:00.000',
        clock_skewed: 0,
        ingest_generation: 1,
        billing_user_id: randomUUID(),
        billing_assignment_version: 1,
        usage_window_start: '2026-07-06 00:00:00.000',
        billing_grace: 0,
        session_id: 'hint-yt',
        anonymous_id: 'anon-yt',
        page_path: '/docs',
      },
      // A Direct session's page view: must not appear under a youtube filter.
      {
        site_id: site,
        event_id: randomUUID(),
        type: 'page_view',
        origin: 'live',
        occurred_at: '2026-07-06 09:02:10.000',
        received_at: '2026-07-06 09:02:10.000',
        accepted_at: '2026-07-06 09:02:10.000',
        clock_skewed: 0,
        ingest_generation: 1,
        billing_user_id: randomUUID(),
        billing_assignment_version: 1,
        usage_window_start: '2026-07-06 00:00:00.000',
        billing_grace: 0,
        session_id: 'hint-direct',
        anonymous_id: 'anon-direct',
        page_path: '/lp',
      },
      // The retracted session's page view: must not appear either.
      {
        site_id: site,
        event_id: randomUUID(),
        type: 'page_view',
        origin: 'live',
        occurred_at: '2026-07-06 09:03:10.000',
        received_at: '2026-07-06 09:03:10.000',
        accepted_at: '2026-07-06 09:03:10.000',
        clock_skewed: 0,
        ingest_generation: 1,
        billing_user_id: randomUUID(),
        billing_assignment_version: 1,
        usage_window_start: '2026-07-06 00:00:00.000',
        billing_grace: 0,
        session_id: 'hint-gone',
        anonymous_id: 'anon-gone',
        page_path: '/ghost',
      },
      // The two-tab session: one page view under each hint. Both belong to one
      // session and both must be counted.
      {
        site_id: site,
        event_id: randomUUID(),
        type: 'page_view',
        origin: 'live',
        occurred_at: '2026-07-06 09:04:00.000',
        received_at: '2026-07-06 09:04:00.000',
        accepted_at: '2026-07-06 09:04:00.000',
        clock_skewed: 0,
        ingest_generation: 1,
        billing_user_id: randomUUID(),
        billing_assignment_version: 1,
        usage_window_start: '2026-07-06 00:00:00.000',
        billing_grace: 0,
        session_id: 'hint-tab1',
        anonymous_id: 'anon-tabs',
        page_path: '/tabs',
        country: 'DE',
        city: 'Berlin',
      },
      {
        site_id: site,
        event_id: randomUUID(),
        type: 'page_view',
        origin: 'live',
        occurred_at: '2026-07-06 09:04:30.000',
        received_at: '2026-07-06 09:04:30.000',
        accepted_at: '2026-07-06 09:04:30.000',
        clock_skewed: 0,
        ingest_generation: 1,
        billing_user_id: randomUUID(),
        billing_assignment_version: 1,
        usage_window_start: '2026-07-06 00:00:00.000',
        billing_grace: 0,
        session_id: 'hint-tab2',
        anonymous_id: 'anon-tabs',
        page_path: '/tabs',
        country: 'DE',
        city: 'Berlin',
      },
      // An event with no hint at all — a server-side or widget write. It belongs
      // to no session, so no session attribute can select it. That is the rule
      // rather than an omission, and it is measured at 0.001% of production.
      {
        site_id: site,
        event_id: randomUUID(),
        type: 'page_view',
        origin: 'server',
        occurred_at: '2026-07-06 09:05:00.000',
        received_at: '2026-07-06 09:05:00.000',
        accepted_at: '2026-07-06 09:05:00.000',
        clock_skewed: 0,
        ingest_generation: 1,
        billing_user_id: randomUUID(),
        billing_assignment_version: 1,
        usage_window_start: '2026-07-06 00:00:00.000',
        billing_grace: 0,
        session_id: '',
        anonymous_id: 'anon-server',
        page_path: '/api-hit',
      },
    ])

    const filtered = await run('analytics.filtered_pages_hour', {
      site_id: site,
      from,
      to,
      limit: 50,
      filters: [{ dimension: 'referrer_domain', operator: 'eq', values: ['youtube.com'] }],
    })
    const paths = new Map(filtered.map((row) => [String(row['page_path']), Number(row['views'])]))

    // Three pages for a visit that carried its referrer on one of them. This is
    // D-F1: five pages under `Source: youtube.com`, not one.
    expect(paths.get('/lp')).toBe(1)
    expect(paths.get('/pricing')).toBe(1)
    expect(paths.get('/docs')).toBe(1)
    // Both tabs of the one YouTube session, found through `session_hints`.
    expect(paths.get('/tabs')).toBe(2)
    // The Direct session, the retracted session and the hintless event are all
    // absent — three different reasons, one correct answer.
    expect(paths.has('/ghost')).toBe(false)
    expect(paths.has('/api-hit')).toBe(false)
    expect(paths.get('/lp')).not.toBe(2)

    // And a second dimension ANDs rather than ORs.
    const both = await run('analytics.filtered_pages_hour', {
      site_id: site,
      from,
      to,
      limit: 50,
      filters: [
        { dimension: 'referrer_domain', operator: 'eq', values: ['youtube.com'] },
        { dimension: 'device_type', operator: 'eq', values: ['mobile'] },
      ],
    })
    expect(both.map((row) => String(row['page_path']))).toEqual(['/tabs'])

    // A city filter reaches the column migration 0023 added, which is the whole
    // reason lane 0 had to land before this one.
    const city = await run('analytics.filtered_geography_hour', {
      site_id: site,
      from,
      to,
      limit: 50,
      filters: [{ dimension: 'city', operator: 'eq', values: ['Berlin'] }],
    })
    // The filter reads the SESSION's entry city (migration 0023's column, which
    // is why lane 0 had to land before this one); the row's own dimensions still
    // come from the events, as they do on the unfiltered report.
    expect(city).toHaveLength(1)
    expect(String(city[0]?.['city'])).toBe('Berlin')
    expect(Number(city[0]?.['views'])).toBe(2)
  })

  it('provisional layer: argMax over version flips a bounce, retraction drops a session, sums are additive', async () => {
    const hourFrom = '2026-07-01T09:00:00.000Z'
    const hourTo = '2026-07-01T10:00:00.000Z'

    // Session 1: v1 provisional bounce (engaged 0) then v2 engaged. The read must
    // reflect v2 — engaged, not bounced.
    await insertFacts([
      factRow({
        site_id: siteA,
        session_id: 's1',
        version: 1,
        engaged: 0,
        pageviews: 1,
        session_duration_ms: 0,
        active_duration_ms: 0,
      }),
      factRow({
        site_id: siteA,
        session_id: 's1',
        version: 2,
        engaged: 1,
        pageviews: 2,
        session_duration_ms: 30_000,
        active_duration_ms: 12_000,
      }),
    ])
    // Session 2: a real finalized session, then a higher-version retraction
    // tombstone (a re-key/merge). argMax-then-filter must drop it entirely.
    await insertFacts([
      factRow({
        site_id: siteA,
        session_id: 's2',
        version: 1,
        engaged: 0,
        pageviews: 1,
        retracted: 0,
      }),
      factRow({
        site_id: siteA,
        session_id: 's2',
        version: 2,
        engaged: 0,
        pageviews: 1,
        retracted: 1,
      }),
    ])
    // Session 3: a plain bounce, current.
    await insertFacts([
      factRow({
        site_id: siteA,
        session_id: 's3',
        version: 1,
        engaged: 0,
        pageviews: 1,
        session_duration_ms: 0,
        active_duration_ms: 0,
      }),
    ])
    // Site B session that must never leak into site A's answer.
    await insertFacts([factRow({ site_id: siteB, session_id: 'b1', version: 1, engaged: 1 })])

    const rows = await run('analytics.sessions_provisional_hour', {
      site_id: siteA,
      from: hourFrom,
      to: hourTo,
      timezone: 'UTC',
    })
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    // s1 (engaged) + s3 (bounce) = 2 sessions; s2 retracted, dropped. Site B gone.
    expect(Number(row['sessions'])).toBe(2)
    expect(Number(row['engaged_sessions'])).toBe(1)
    expect(Number(row['bounced_sessions'])).toBe(1)
    // Additive totals from the current versions only: s1 v2 pageviews 2 + s3 1.
    expect(Number(row['pageviews'])).toBe(3)
    expect(Number(row['total_session_duration_ms'])).toBe(30_000)
    expect(Number(row['total_active_duration_ms'])).toBe(12_000)
  })

  it('finalized layer: argMax over generation, additive across buckets, site-scoped', async () => {
    const insertRollup = async (table: string, row: Record<string, unknown>): Promise<void> => {
      await client.insert({
        table,
        values: [
          {
            site_id: siteA,
            generation: 1,
            sessions: 0,
            engaged_sessions: 0,
            bounced_sessions: 0,
            pageviews: 0,
            total_session_duration_ms: 0,
            total_active_duration_ms: 0,
            computed_at: '2026-07-01 10:00:00.000',
            ...row,
          },
        ],
        format: 'JSONEachRow',
      })
    }

    // Bucket 09:00 — generation 1 then a superseding generation 2 (a late pageview
    // flipped a bounce). Bucket 10:00 — one generation. Site B bucket must not leak.
    await insertRollup('session_rollups_15m', {
      bucket_start: '2026-07-01 09:00:00',
      generation: 1,
      sessions: 3,
      engaged_sessions: 1,
      bounced_sessions: 2,
      pageviews: 4,
      total_session_duration_ms: 90_000,
      total_active_duration_ms: 30_000,
    })
    await insertRollup('session_rollups_15m', {
      bucket_start: '2026-07-01 09:00:00',
      generation: 2,
      sessions: 3,
      engaged_sessions: 2,
      bounced_sessions: 1,
      pageviews: 6,
      total_session_duration_ms: 120_000,
      total_active_duration_ms: 48_000,
    })
    await insertRollup('session_rollups_15m', {
      bucket_start: '2026-07-01 10:00:00',
      generation: 1,
      sessions: 2,
      engaged_sessions: 2,
      bounced_sessions: 0,
      pageviews: 5,
      total_session_duration_ms: 60_000,
      total_active_duration_ms: 24_000,
    })
    await client.insert({
      table: 'session_rollups_15m',
      values: [
        {
          site_id: siteB,
          bucket_start: '2026-07-01 09:00:00',
          generation: 1,
          sessions: 99,
          engaged_sessions: 99,
          bounced_sessions: 0,
          pageviews: 99,
          total_session_duration_ms: 99,
          total_active_duration_ms: 99,
          computed_at: '2026-07-01 10:00:00.000',
        },
      ],
      format: 'JSONEachRow',
    })

    const rows = await run('analytics.sessions_finalized_hour', {
      site_id: siteA,
      from: '2026-07-01T09:00:00.000Z',
      to: '2026-07-01T11:00:00.000Z',
      timezone: 'UTC',
    })
    // The bucket label is the bucket instant rendered in UTC — a timezone-local
    // re-bucketing is returned as DateTime64(3, 'UTC'), hence the milliseconds.
    const byBucket = Object.fromEntries(rows.map((r) => [String(r['bucket']), r]))
    // 09:00 reads generation 2 (the swap), not the sum of both generations.
    expect(Number(byBucket['2026-07-01 09:00:00.000']?.['sessions'])).toBe(3)
    expect(Number(byBucket['2026-07-01 09:00:00.000']?.['engaged_sessions'])).toBe(2)
    expect(Number(byBucket['2026-07-01 09:00:00.000']?.['pageviews'])).toBe(6)
    expect(Number(byBucket['2026-07-01 10:00:00.000']?.['sessions'])).toBe(2)
  })

  // -------------------------------------------------------------------------
  // Timezone-local session bucket labels. Istanbul is +03:00 all year (no DST
  // since 2016), so every instant below is offset-stable: the local hour is a
  // whole UTC hour, and the local day 2026-07-12 starts at 2026-07-11T21:00:00Z.
  // A label rendered in Istanbul reads three hours ahead of the instant it names,
  // which the API then stamps "Z" onto.
  // -------------------------------------------------------------------------

  const ISTANBUL = 'Europe/Istanbul'

  it('provisional session buckets carry the bucket instant in UTC, at hour and local-day grain', async () => {
    const site = randomUUID()
    await insertFacts([
      factRow({
        site_id: site,
        session_id: 'tz1',
        version: 1,
        session_start: '2026-07-12 10:30:00.000',
        session_end: '2026-07-12 10:40:00.000',
        engaged: 1,
        pageviews: 2,
        session_duration_ms: 600_000,
        active_duration_ms: 60_000,
      }),
      factRow({
        site_id: site,
        session_id: 'tz2',
        version: 1,
        session_start: '2026-07-12 18:15:00.000',
        session_end: '2026-07-12 18:15:00.000',
        engaged: 0,
        pageviews: 1,
      }),
    ])

    const hourFrom = '2026-07-12T10:00:00.000Z'
    const hourTo = '2026-07-12T19:00:00.000Z'
    const hourRows = await run('analytics.sessions_provisional_hour', {
      site_id: site,
      from: hourFrom,
      to: hourTo,
      timezone: ISTANBUL,
    })
    // Rendered in Istanbul these would read 13:00:00 and 21:00:00 — the second of
    // which is not even inside the range that was asked for.
    expect(hourRows.map((row) => String(row['bucket']))).toEqual([
      '2026-07-12 10:00:00.000',
      '2026-07-12 18:00:00.000',
    ])
    expect(hourRows.map((row) => Number(row['sessions']))).toEqual([1, 1])
    for (const row of hourRows) {
      const ms = Date.parse(`${String(row['bucket']).replace(' ', 'T')}Z`)
      expect(ms).toBeGreaterThanOrEqual(Date.parse(hourFrom))
      expect(ms).toBeLessThan(Date.parse(hourTo))
    }

    // The Istanbul day 2026-07-12 is the instant range [2026-07-11T21:00:00Z,
    // 2026-07-12T21:00:00Z); its bucket is named by that start instant.
    const dayRows = await run('analytics.sessions_provisional_day_local', {
      site_id: site,
      from: '2026-07-11T21:00:00.000Z',
      to: '2026-07-12T21:00:00.000Z',
      timezone: ISTANBUL,
    })
    expect(dayRows.map((row) => String(row['bucket']))).toEqual(['2026-07-11 21:00:00.000'])
    expect(Number(dayRows[0]?.['sessions'])).toBe(2)
    expect(Number(dayRows[0]?.['engaged_sessions'])).toBe(1)
    expect(Number(dayRows[0]?.['pageviews'])).toBe(3)
  })

  it('finalized session buckets carry the bucket instant in UTC', async () => {
    const site = randomUUID()
    await client.insert({
      table: 'session_rollups_15m',
      values: [
        {
          site_id: site,
          bucket_start: '2026-07-12 10:00:00',
          generation: 1,
          sessions: 4,
          engaged_sessions: 3,
          bounced_sessions: 1,
          pageviews: 9,
          total_session_duration_ms: 120_000,
          total_active_duration_ms: 48_000,
          computed_at: '2026-07-12 11:00:00.000',
        },
      ],
      format: 'JSONEachRow',
    })

    const rows = await run('analytics.sessions_finalized_hour', {
      site_id: site,
      from: '2026-07-12T10:00:00.000Z',
      to: '2026-07-12T11:00:00.000Z',
      timezone: ISTANBUL,
    })
    expect(rows.map((row) => String(row['bucket']))).toEqual(['2026-07-12 10:00:00.000'])
    expect(Number(rows[0]?.['sessions'])).toBe(4)
  })

  // -------------------------------------------------------------------------
  // Quarter-hour offsets (ADR-0079, step 3).
  //
  // Kolkata's local midnight is 18:30Z and Kathmandu's is 18:15Z, so a local day
  // boundary falls inside a UTC hour. Composing these from `session_rollups_1h`
  // was impossible — the hour bucket straddling midnight would have to be split
  // — and it is what the refusal in `resolveSession` existed for. With the 15m
  // grain the boundary is a bucket boundary, and these assert that the buckets
  // land on the side of midnight they belong to rather than merely that the
  // query returns rows.
  // -------------------------------------------------------------------------

  it.each([
    { tz: 'Asia/Kolkata', before: '18:15:00', after: '18:30:00', midnight: '18:30:00.000' },
    { tz: 'Asia/Kathmandu', before: '18:00:00', after: '18:15:00', midnight: '18:15:00.000' },
  ])(
    'splits a $tz local day at its own midnight, from the 15m finalized layer',
    async ({ tz, before, after, midnight }) => {
      const site = randomUUID()
      const bucket = (bucketStart: string, sessions: number) => ({
        site_id: site,
        bucket_start: bucketStart,
        generation: 1,
        sessions,
        engaged_sessions: sessions,
        bounced_sessions: 0,
        pageviews: sessions,
        total_session_duration_ms: 1_000 * sessions,
        total_active_duration_ms: 500 * sessions,
        computed_at: '2026-08-11 00:00:00.000',
      })
      await client.insert({
        table: 'session_rollups_15m',
        values: [
          // The last quarter-hour of the local day, and the first of the next.
          bucket(`2026-08-10 ${before}`, 2),
          bucket(`2026-08-10 ${after}`, 5),
        ],
        format: 'JSONEachRow',
      })

      const rows = await run('analytics.sessions_finalized_day_local', {
        site_id: site,
        from: '2026-08-09T18:15:00.000Z',
        to: '2026-08-11T18:15:00.000Z',
        timezone: tz,
      })
      // Two local days, not one: the bucket before midnight belongs to the day
      // that is ending, the bucket at midnight to the day that is starting. An
      // hour-grain source would have put both in the same bucket.
      expect(rows.map((row) => Number(row['sessions']))).toEqual([2, 5])
      expect(String(rows[1]?.['bucket'])).toBe(`2026-08-10 ${midnight}`)
    },
  )

  it('funnel operation matches the pure computeFunnel reference on the same events', async () => {
    const funnelSite = randomUUID()
    const steps = ['/pricing', 'signup_started', 'signup']
    const windowMs = 1_800_000
    const from = '2026-07-10T00:00:00.000Z'
    const to = '2026-07-11T00:00:00.000Z'

    // Two visitors: v1 completes all three in order; v2 reaches step two only.
    // event_id is a UUID column; fixed literals keep the seed deterministic.
    const seed: { anon: string; ms: number; id: string; type: string; key: string }[] = [
      {
        anon: 'v1',
        ms: Date.parse('2026-07-10T09:00:00.000Z'),
        id: '00000000-0000-4000-8000-000000000001',
        type: 'page_view',
        key: '/pricing',
      },
      {
        anon: 'v1',
        ms: Date.parse('2026-07-10T09:05:00.000Z'),
        id: '00000000-0000-4000-8000-000000000002',
        type: 'custom_event',
        key: 'signup_started',
      },
      {
        anon: 'v1',
        ms: Date.parse('2026-07-10T09:10:00.000Z'),
        id: '00000000-0000-4000-8000-000000000003',
        type: 'conversion',
        key: 'signup',
      },
      {
        anon: 'v2',
        ms: Date.parse('2026-07-10T12:00:00.000Z'),
        id: '00000000-0000-4000-8000-000000000004',
        type: 'page_view',
        key: '/pricing',
      },
      {
        anon: 'v2',
        ms: Date.parse('2026-07-10T12:03:00.000Z'),
        id: '00000000-0000-4000-8000-000000000005',
        type: 'custom_event',
        key: 'signup_started',
      },
    ]

    await insertRawEvents(
      seed.map((s) => ({
        site_id: funnelSite,
        event_id: s.id,
        type: s.type,
        occurred_at: new Date(s.ms).toISOString().replace('T', ' ').replace('Z', ''),
        anonymous_id: s.anon,
        ...(s.type === 'page_view' ? { page_path: s.key } : { name: s.key }),
      })),
    )

    const rows = await run('analytics.funnel_visitor', {
      site_id: funnelSite,
      from,
      to,
      steps,
      window_ms: windowMs,
    })
    const row = rows[0]!
    const chCounts = [Number(row['step_1']), Number(row['step_2']), Number(row['step_3'])]

    // The pure reference over the same events.
    const events: FunnelEvent[] = seed.map((s) => ({
      unitKey: s.anon,
      occurredMs: s.ms,
      eventId: s.id,
      stepKey: s.key,
    }))
    const reference = computeFunnel(events, { steps, windowMs }).map((r) => r.count)

    expect(chCounts).toEqual(reference)
    expect(chCounts).toEqual([2, 2, 1])
  })

  it('funnel step kinds: a wildcard page step and an event step with property conditions', async () => {
    const site = randomUUID()
    const steps = [
      '{"page":"/de/discount/*"}',
      '{"event":"plan_selected","where":{"plan":"yearly","seats":"3"}}',
    ]
    const windowMs = 3_600_000
    const at = (minute: number): number => Date.parse('2026-07-14T09:00:00.000Z') + minute * 60_000
    let n = 0
    const id = (): string => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`
    // v1 matches both (a number property compared as its JSON text); v2 picks
    // the other plan; v3's path is not under the wildcard; v4 sends the right
    // event as a pageview path, which an event step must not match.
    const seed: {
      anon: string
      ms: number
      id: string
      type: string
      key: string
      properties?: Record<string, unknown>
    }[] = [
      { anon: 'v1', ms: at(0), id: id(), type: 'page_view', key: '/de/discount/abc/1' },
      {
        anon: 'v1',
        ms: at(5),
        id: id(),
        type: 'custom_event',
        key: 'plan_selected',
        properties: { plan: 'yearly', seats: 3 },
      },
      { anon: 'v2', ms: at(0), id: id(), type: 'page_view', key: '/de/discount/x' },
      {
        anon: 'v2',
        ms: at(5),
        id: id(),
        type: 'custom_event',
        key: 'plan_selected',
        properties: { plan: 'monthly', seats: 3 },
      },
      { anon: 'v3', ms: at(0), id: id(), type: 'page_view', key: '/de/discountx' },
      {
        anon: 'v3',
        ms: at(5),
        id: id(),
        type: 'custom_event',
        key: 'plan_selected',
        properties: { plan: 'yearly', seats: 3 },
      },
      { anon: 'v4', ms: at(0), id: id(), type: 'page_view', key: '/de/discount/' },
      { anon: 'v4', ms: at(5), id: id(), type: 'page_view', key: 'plan_selected' },
    ]
    await insertRawEvents(
      seed.map((s) => ({
        site_id: site,
        event_id: s.id,
        type: s.type,
        occurred_at: new Date(s.ms).toISOString().replace('T', ' ').replace('Z', ''),
        anonymous_id: s.anon,
        properties: JSON.stringify(s.properties ?? {}),
        ...(s.type === 'page_view' ? { page_path: s.key } : { name: s.key }),
      })),
    )

    const rows = await run('analytics.funnel_visitor', {
      site_id: site,
      from: '2026-07-14T00:00:00.000Z',
      to: '2026-07-15T00:00:00.000Z',
      steps,
      window_ms: windowMs,
    })
    const counts = [Number(rows[0]!['step_1']), Number(rows[0]!['step_2'])]
    const reference = computeFunnel(
      seed.map((s) => ({
        unitKey: s.anon,
        occurredMs: s.ms,
        eventId: s.id,
        stepKey: s.key,
        isPageView: s.type === 'page_view',
        properties: s.properties ?? {},
      })),
      { steps, windowMs },
    ).map((r) => r.count)
    expect(counts).toEqual(reference)
    expect(counts).toEqual([3, 1])
  })

  it('funnel visitor scope joins two signed-in days through identify, and reports buyers and revenue per step', async () => {
    const site = randomUUID()
    const at = (iso: string): string => iso.replace('T', ' ').replace('Z', '')
    let n = 0
    const id = (): string => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`
    // u1 is one person under two daily anonymous ids, identified on both days;
    // the first identify sits before the range's first instant but on its
    // first UTC day, which the identity map still has to see. a3 is anonymous
    // and only ever reaches step one.
    await insertRawEvents([
      {
        site_id: site,
        event_id: id(),
        type: 'identify',
        occurred_at: at('2026-07-20T08:00:00.000Z'),
        anonymous_id: 'a1',
        user_id: 'u1',
      },
      {
        site_id: site,
        event_id: id(),
        type: 'page_view',
        occurred_at: at('2026-07-20T10:00:00.000Z'),
        anonymous_id: 'a1',
        session_id: 's1',
        page_path: '/pricing',
      },
      {
        site_id: site,
        event_id: id(),
        type: 'identify',
        occurred_at: at('2026-07-21T09:00:00.000Z'),
        anonymous_id: 'a2',
        user_id: 'u1',
      },
      {
        site_id: site,
        event_id: id(),
        type: 'custom_event',
        occurred_at: at('2026-07-21T09:10:00.000Z'),
        anonymous_id: 'a2',
        session_id: 's2',
        name: 'checkout',
      },
      {
        site_id: site,
        event_id: id(),
        type: 'page_view',
        occurred_at: at('2026-07-20T11:00:00.000Z'),
        anonymous_id: 'a3',
        session_id: 's3',
        page_path: '/pricing',
      },
    ])

    const charge = (over: Record<string, unknown>): Record<string, unknown> => ({
      site_id: site,
      provider: 'stripe',
      object_kind: 'charge',
      version: 1,
      occurred_at: at('2026-07-21T09:20:00.000Z'),
      status: 'succeeded',
      livemode: 1,
      currency: 'eur',
      gross_minor: 3_999,
      fee_minor: 0,
      fee_currency: 'eur',
      net_minor: 3_999,
      reporting_currency: 'eur',
      reporting_gross_minor: 3_999,
      reporting_net_minor: 3_999,
      conversion_source: 'none',
      conversion_rate: 1,
      conversion_rate_date: '2026-07-21',
      ingested_via: 'webhook',
      ingested_at: at('2026-07-21T09:20:05.000Z'),
      ...over,
    })
    await client.insert({
      table: 'revenue_events',
      values: [
        charge({ object_id: 'ch_u1' }),
        // a3's charge failed: not a buyer.
        charge({ object_id: 'ch_a3', status: 'failed', gross_minor: 699 }),
      ],
      format: 'JSONEachRow',
    })
    await client.insert({
      table: 'revenue_attributions',
      values: [
        { object_id: 'ch_u1', visitor_id: 'u1', user_id: 'u1' },
        { object_id: 'ch_a3', visitor_id: 'a3' },
      ].map((row) => ({
        site_id: site,
        provider: 'stripe',
        version: 1,
        occurred_at: at('2026-07-21T09:20:00.000Z'),
        computed_at: at('2026-07-21T09:21:00.000Z'),
        ...row,
      })),
      format: 'JSONEachRow',
    })

    const base = {
      site_id: site,
      from: '2026-07-20T09:00:00.000Z',
      to: '2026-07-22T00:00:00.000Z',
      steps: ['/pricing', 'checkout'],
      window_ms: 2 * 86_400_000,
    }
    const read = async (
      operation: string,
      withRevenue: boolean,
    ): Promise<{ steps: number[]; buyers: number[]; revenue: number[]; currency: string }> => {
      const row = (await run(operation, { ...base, with_revenue: withRevenue }))[0]!
      return {
        steps: [Number(row['step_1']), Number(row['step_2'])],
        buyers: [Number(row['buyers_1']), Number(row['buyers_2'])],
        revenue: [Number(row['revenue_1']), Number(row['revenue_2'])],
        currency: String(row['currency']),
      }
    }

    // Visitor scope: u1's two days are one unit that completes the funnel.
    expect(await read('analytics.funnel_visitor', true)).toEqual({
      steps: [2, 1],
      buyers: [1, 1],
      revenue: [3_999, 3_999],
      currency: 'eur',
    })
    // Session scope keeps the day boundary: no session holds both steps.
    const session = await read('analytics.funnel_session', true)
    expect(session.steps).toEqual([2, 0])
    expect(session.buyers).toEqual([1, 0])
    // Without revenue the money is never read.
    expect(await read('analytics.funnel_visitor', false)).toEqual({
      steps: [2, 1],
      buyers: [0, 0],
      revenue: [0, 0],
      currency: '',
    })
  })

  it('reads recent visitors and one visitor’s trail out of the raw events (ADR-0024)', async () => {
    const site = randomUUID()
    const from = '2026-07-12T00:00:00.000Z'
    const to = '2026-07-12T06:00:00.000Z'
    const at = (iso: string): string => iso.replace('T', ' ').replace('Z', '')

    // v1: two client-hinted sessions, and a later event whose UA/geo differ from
    // the first — the read must report the *latest* label, not whichever came
    // back first — followed by an unlabelled custom event, which must not blank
    // that label. v2: one page view, seen earlier, so the ordering is observable.
    await insertRawEvents([
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000a1',
        type: 'page_view',
        occurred_at: at('2026-07-12T01:00:00.000'),
        anonymous_id: 'v1',
        session_id: 's1',
        page_path: '/',
        page_title: 'Home',
        referrer_domain: 'google.com',
        country: 'AZ',
        device_type: 'mobile',
        browser: 'safari',
        os: 'ios',
      },
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000a2',
        type: 'page_view',
        occurred_at: at('2026-07-12T01:10:00.000'),
        anonymous_id: 'v1',
        session_id: 's1',
        page_path: '/pricing',
        page_title: 'Pricing',
        referrer_domain: 'google.com',
        country: 'AZ',
        device_type: 'mobile',
        browser: 'safari',
        os: 'ios',
      },
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000a3',
        type: 'page_view',
        occurred_at: at('2026-07-12T03:00:00.000'),
        anonymous_id: 'v1',
        session_id: 's2',
        page_path: '/checkout',
        page_title: 'Checkout',
        country: 'DE',
        device_type: 'desktop',
        browser: 'chrome',
        os: 'windows',
      },
      // A non-pageview by the same visitor, carrying no page context, so every
      // UA/geo column defaults to empty: it counts toward presence in the window
      // but not toward the pageview total, never joins the trail, and never
      // blanks the labels the 03:00 page view established.
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000a4',
        type: 'custom_event',
        name: 'signup',
        occurred_at: at('2026-07-12T03:05:00.000'),
        anonymous_id: 'v1',
        session_id: 's2',
      },
      // v1 identifies mid-visit. user_id exists on this row ALONE (the
      // collector never stamps it onward), and the row carries v1's anonymous
      // id too — which is exactly what folds it onto v1's own group instead of
      // minting a phantom "u_hash_1" row with zero pageviews (ADR-0036 D3).
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000a5',
        type: 'identify',
        occurred_at: at('2026-07-12T03:02:00.000'),
        anonymous_id: 'v1',
        user_id: 'u_hash_1',
        session_id: 's2',
      },
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000b1',
        type: 'page_view',
        occurred_at: at('2026-07-12T00:30:00.000'),
        anonymous_id: 'v2',
        session_id: 's9',
        page_path: '/',
        country: 'US',
        device_type: 'desktop',
        browser: 'firefox',
        os: 'linux',
      },
    ])

    const visitors = await run('analytics.recent_visitors', { site_id: site, from, to, limit: 100 })
    // Two people, not three: the identify event joined v1's group rather than
    // appearing as a phantom visitor keyed on the user hash.
    expect(visitors.map((row) => row['visitor'])).toEqual(['v1', 'v2'])
    expect(visitors[0]!['user_id']).toBe('u_hash_1')
    expect(visitors[1]!['user_id']).toBe('')

    const v1 = visitors[0]!
    expect(Number(v1['pageviews'])).toBe(3)
    // The label of the most recent *labelled* event (03:00), not of the first
    // one read, and not the empty label of the newer unlabelled custom event.
    expect(v1['country']).toBe('DE')
    expect(v1['browser']).toBe('chrome')
    expect(v1['os']).toBe('windows')
    expect(v1['device_type']).toBe('desktop')
    expect(String(v1['first_seen'])).toContain('01:00:00')
    expect(String(v1['last_seen'])).toContain('03:05:00')

    const trail = await run('analytics.visitor_trail', {
      site_id: site,
      from,
      to,
      visitor: 'v1',
      limit: 500,
    })
    // Page views only, newest first, and never an unrelated visitor's rows —
    // v2 shares no session with v1, so the rotation branch cannot reach it.
    expect(trail.map((row) => row['page_path'])).toEqual(['/checkout', '/pricing', '/'])
    expect(trail.map((row) => row['session_id'])).toEqual(['s2', 's1', 's1'])

    // A visitor with nothing in the window is an empty trail, not an error.
    expect(
      await run('analytics.visitor_trail', { site_id: site, from, to, visitor: 'nobody' }),
    ).toEqual([])
  })

  it('reads the trail of a visitor whose id rotated mid-visit, but never across a UTC date', async () => {
    // D-102: the anonymous id is derived from the IP, so one visitor arrives
    // under two ids when their network moves. Measured in production: the second
    // id carried the web vitals and the *first* carried the only page view, so
    // the board showed a live visitor with an empty trail. The shared client
    // session hint is what proves the two are one person, and it is the same
    // evidence `packages/domain/src/session.ts`'s identity bridge acts on.
    const site = randomUUID()
    const from = '2026-07-12T00:00:00.000Z'
    const to = '2026-07-12T23:00:00.000Z'
    const at = (iso: string): string => iso.replace('T', ' ').replace('Z', '')

    await insertRawEvents([
      // One visit, one hint, two ids: the page view lands under `ip1`.
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000c1',
        type: 'page_view',
        occurred_at: at('2026-07-12T10:00:00.000'),
        anonymous_id: 'ip1',
        session_id: 'moved',
        page_path: '/pricing',
      },
      // Seconds later the IP moves: a new id, and only a web vital under it.
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000c2',
        type: 'web_vital',
        occurred_at: at('2026-07-12T10:00:03.000'),
        anonymous_id: 'ip2',
        session_id: 'moved',
      },
      // A different person on the same day carrying their own hint: the branch
      // keys on the hint, so this must stay out of both trails.
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000c3',
        type: 'page_view',
        occurred_at: at('2026-07-12T10:00:05.000'),
        anonymous_id: 'other',
        session_id: 'their-own',
        page_path: '/secret',
      },
      // A hintless row — a server-side event — must not pool into anybody.
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000c4',
        type: 'page_view',
        occurred_at: at('2026-07-12T10:00:07.000'),
        anonymous_id: 'hintless',
        session_id: '',
        page_path: '/hintless',
      },
    ])

    // Asked about the id that has no page view of its own, the trail answers
    // with the one its own visit produced. This is the assertion the old
    // anonymous-id-only match failed: it returned nothing at all.
    const rotated = await run('analytics.visitor_trail', {
      site_id: site,
      from,
      to,
      visitor: 'ip2',
      limit: 500,
    })
    expect(rotated.map((row) => row['page_path'])).toEqual(['/pricing'])

    // Neither the stranger's page nor the hintless row is reachable from it.
    expect(rotated.map((row) => row['page_path'])).not.toContain('/secret')
    expect(rotated.map((row) => row['page_path'])).not.toContain('/hintless')

    // A hintless visitor still reads their own rows: the rotation branch is
    // additive, never a replacement for the identity match.
    expect(
      (await run('analytics.visitor_trail', { site_id: site, from, to, visitor: 'hintless' })).map(
        (row) => row['page_path'],
      ),
    ).toEqual(['/hintless'])
  })

  it('does not carry a trail across the UTC-midnight identity rotation', async () => {
    // The daily rotation is the published privacy boundary, so the read stops at
    // it even though the hint would happily join the two days. This is the case
    // the realtime board films as "online, no pageviews", and it is answered by
    // showing where the visitor is now — not by linking yesterday to today.
    const site = randomUUID()
    const at = (iso: string): string => iso.replace('T', ' ').replace('Z', '')

    await insertRawEvents([
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000d1',
        type: 'page_view',
        occurred_at: at('2026-07-12T20:51:48.000'),
        anonymous_id: 'day1',
        session_id: 'overnight',
        page_path: '/',
      },
      {
        site_id: site,
        event_id: '00000000-0000-4000-8000-0000000000d2',
        type: 'web_vital',
        occurred_at: at('2026-07-13T04:04:10.000'),
        anonymous_id: 'day2',
        session_id: 'overnight',
      },
    ])

    expect(
      await run('analytics.visitor_trail', {
        site_id: site,
        from: '2026-07-12T12:00:00.000Z',
        to: '2026-07-13T12:00:00.000Z',
        visitor: 'day2',
        limit: 500,
      }),
    ).toEqual([])
  })
})
