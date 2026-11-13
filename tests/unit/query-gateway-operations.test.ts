import { generateKeyPairSync } from 'node:crypto'
import { ApiError } from '@openanalytics/contracts'
import { EPOCH_IMPORT_CUTOVER, NIL_IMPORT_RUN_ID } from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'
import {
  IMPORT_AWARE_OPERATIONS,
  IMPORT_RUN_OPERATIONS,
  TIMEZONE_OPERATIONS,
} from '../../apps/api/src/analytics/resolve.ts'
import {
  QUERY_OPERATIONS,
  clickhouseRoundtripOperation,
  findOperation,
} from '../../apps/query-gateway/src/operations.ts'
import { InMemoryNonceStore } from '../../apps/query-gateway/src/nonce-store.ts'
import {
  SIGNATURE_SCHEME,
  canonicalSigningString,
  loadVerifyKey,
  sha256Hex,
  signRequest,
  signedPathOf,
  verifySignature,
} from '@openanalytics/auth'

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const SITE_B = '7c4e9a12-0b55-4d31-8f6a-1e2d3c4b5a60'

/** The ADR-0080 pair: the only operations that bind a list of sites. */
const MULTI_SITE_OPERATIONS = ['analytics.sites_all_time', 'analytics.sites_all_time_revenue']

/** A range whose endpoints are UTC-day (and therefore hour and minute) aligned. */
const DAY_RANGE = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' }

/**
 * What a site with no published import binds (ADR-0032, D2b/D4).
 *
 * Spread into every binding case below rather than made optional in the schema:
 * the whole safety of the partition is that the two parameters are **required**,
 * so no request shape exists in which the cutover filter is quietly not applied.
 */
const NO_IMPORT = {
  import_run_id: NIL_IMPORT_RUN_ID,
  import_cutover: EPOCH_IMPORT_CUTOVER,
  // Every import-aware operation binds the zone, because the cutover boundary is
  // rendered in it — a total and the chart of the same window must agree about
  // which provider days that window contains.
  timezone: 'UTC',
}

/** A live breakdown takes the cutover alone: its statement reads no staged row,
 * so a run id would be a bound value the SQL never uses. */
const NO_IMPORT_CUTOVER = { import_cutover: EPOCH_IMPORT_CUTOVER, timezone: 'UTC' }

/** A published run and a real cutover, for the operations that read one. */
const PUBLISHED_IMPORT = {
  import_run_id: '9f0f6f2e-6b32-4f0b-9e0a-6d1f0f6c2b41',
  import_cutover: '2026-06-01',
  timezone: 'UTC',
}

describe('operation registry', () => {
  it('exposes exactly the Milestone 7/8 rollup allowlist plus health', () => {
    // The allowlist is the security boundary; an operation appearing here
    // without review is the thing D-208 forbids.
    expect([...QUERY_OPERATIONS.keys()].sort()).toEqual([
      // The custom-events decoration (ADR-0038, D5): a separate operation, so
      // the counts a public surface may read and the sample a member's
      // dashboard may read are not the same allowlist entry.
      'analytics.custom_event_samples_day',
      'analytics.custom_event_samples_hour',
      'analytics.custom_events_day',
      'analytics.custom_events_hour',
      'analytics.devices_day',
      'analytics.devices_hour',
      // The filtered family (ADR-0075, D-F2/D-F3). Additional operations, never
      // a widening of the unfiltered ones: an unfiltered read must keep routing
      // to its rollup, and these refuse an empty filter set outright.
      'analytics.filtered_devices_day',
      'analytics.filtered_devices_hour',
      'analytics.filtered_geography_day',
      'analytics.filtered_geography_hour',
      'analytics.filtered_overview_day',
      'analytics.filtered_overview_hour',
      'analytics.filtered_page_sessions_day',
      'analytics.filtered_page_sessions_hour',
      'analytics.filtered_pages_day',
      'analytics.filtered_pages_hour',
      'analytics.filtered_sources_day',
      'analytics.filtered_sources_hour',
      'analytics.filtered_timeseries_day',
      'analytics.filtered_timeseries_day_utc',
      'analytics.filtered_timeseries_hour',
      'analytics.filtered_timeseries_minute',
      'analytics.filtered_timeseries_week',
      'analytics.filtered_timeseries_week_utc',
      'analytics.freshness',
      'analytics.funnel_session',
      'analytics.funnel_visitor',
      'analytics.geography_day',
      'analytics.geography_hour',
      // The seven imported-only breakdowns (ADR-0032, D2b). They exist because a
      // blank-padded SQL union would fabricate dimension tuples; the api merges
      // their rows onto the live report's instead.
      'analytics.imported_browsers',
      'analytics.imported_custom_events',
      'analytics.imported_devices',
      'analytics.imported_geography',
      'analytics.imported_os',
      'analytics.imported_pages',
      'analytics.imported_sources',
      'analytics.overview_day',
      'analytics.overview_hour',
      // Entry/exit/bounce per path (ADR-0075, D-E1): a decoration of the pages
      // report, not a report of its own, and a separate allowlist entry so the
      // public share cannot reach it by reaching the counts.
      'analytics.page_sessions_day',
      'analytics.page_sessions_hour',
      'analytics.pages_day',
      'analytics.pages_hour',
      'analytics.performance_day',
      'analytics.performance_hour',
      'analytics.recent_visitors',
      // The revenue read surface (ADR-0033, D7; CP5). Two bucket families over
      // the 0018 rollups, two object families over the 0016/0017 facts, and the
      // unconverted remainder — which reads facts for a range total because the
      // bucket cannot carry a currency dimension without breaking its own unit
      // of replacement.
      'analytics.revenue_order_objects',
      'analytics.revenue_summary_day',
      'analytics.revenue_summary_hour',
      'analytics.revenue_timeseries_day',
      'analytics.revenue_timeseries_day_local',
      'analytics.revenue_timeseries_hour',
      'analytics.revenue_transaction_journey',
      'analytics.revenue_transactions',
      'analytics.revenue_unconverted',
      'analytics.sessions_finalized_day',
      'analytics.sessions_finalized_day_local',
      'analytics.sessions_finalized_hour',
      'analytics.sessions_provisional_day',
      'analytics.sessions_provisional_day_local',
      'analytics.sessions_provisional_hour',
      // The two multi-site reads (ADR-0080). They bind `site_ids`, not
      // `site_id`, and they are the only entries here that do — the site-scope
      // assertion below is what keeps that a widening of arity rather than a
      // hole in the boundary.
      'analytics.sites_all_time',
      'analytics.sites_all_time_revenue',
      'analytics.sources_day',
      'analytics.sources_hour',
      'analytics.timeseries_day',
      'analytics.timeseries_day_utc',
      'analytics.timeseries_hour',
      'analytics.timeseries_minute',
      'analytics.timeseries_week',
      'analytics.timeseries_week_utc',
      'analytics.visitor_revenue',
      'analytics.visitor_revenue_entries',
      'analytics.visitor_trail',
      'health.clickhouse_roundtrip',
    ])
  })

  it('retired the M1 echo probe', () => {
    expect(findOperation('analytics.site_range_probe')).toBeUndefined()
    expect(findOperation('analytics.anything_else')).toBeUndefined()
    expect(findOperation('__proto__')).toBeUndefined()
  })

  it('never reads the raw event table, except the bounded families (§15, ADR-0024, ADR-0075)', () => {
    // §15 forbids events_raw for the additive family (overview/pages/sources/geo/
    // devices/charts) and the session layers. Only the funnel operations, the
    // recent-visitor pair and the filtered family read it, each under a bounded,
    // site-scoped, capped query they opt into explicitly.
    const rawReaders = new Set([
      'analytics.funnel_session',
      'analytics.funnel_visitor',
      'analytics.recent_visitors',
      'analytics.visitor_trail',
      // Reads revenue facts, not events — except the identity-linkage
      // subquery (ADR-0036 CP7): the identify() hashes an anonymous id paired
      // inside the window, which only events_raw can answer.
      'analytics.visitor_revenue_entries',
      // ADR-0075 D-F3: a filter selects sessions on the fact table, but the
      // report it produces is over the events those sessions did — and no
      // rollup carries both halves. Each is capped at 92 days with a row cap and
      // a hard site filter, the way the funnel earns its own exception.
      'analytics.filtered_overview_hour',
      'analytics.filtered_overview_day',
      'analytics.filtered_timeseries_minute',
      'analytics.filtered_timeseries_hour',
      'analytics.filtered_timeseries_day',
      'analytics.filtered_timeseries_day_utc',
      'analytics.filtered_timeseries_week',
      'analytics.filtered_timeseries_week_utc',
      'analytics.filtered_pages_hour',
      'analytics.filtered_pages_day',
      'analytics.filtered_sources_hour',
      'analytics.filtered_sources_day',
      'analytics.filtered_geography_hour',
      'analytics.filtered_geography_day',
      'analytics.filtered_devices_hour',
      'analytics.filtered_devices_day',
    ])
    for (const operation of QUERY_OPERATIONS.values()) {
      if (rawReaders.has(operation.id)) {
        expect(operation.sql).toMatch(/events_raw/i)
        continue
      }
      expect(operation.sql).not.toMatch(/events_raw/i)
    }
  })

  it('keeps the entry/exit reads off the raw table entirely (ADR-0075, D-E1)', () => {
    // Both variants — filtered and not — are pure session-fact reads. The
    // filtered one is the single filtered operation that needs no raw access at
    // all, because the population it counts IS the fact rows, and that is worth
    // pinning: a future edit reaching for events_raw here would pay a raw scan
    // for a number the facts already hold.
    for (const id of [
      'analytics.page_sessions_hour',
      'analytics.page_sessions_day',
      'analytics.filtered_page_sessions_hour',
      'analytics.filtered_page_sessions_day',
    ]) {
      const operation = findOperation(id)!
      expect(operation.sql).not.toMatch(/events_raw/i)
      expect(operation.sql).toContain('session_facts_versions')
      // Migration 0013's read contract, in the only order that is correct:
      // latest version per session FIRST, retraction filtered AFTER.
      expect(operation.sql).toContain('argMax(sfv.engaged, sfv.version)')
      expect(operation.sql.indexOf('GROUP BY sfv.site_id, sfv.session_id')).toBeLessThan(
        operation.sql.indexOf('WHERE cur.retracted = 0'),
      )
    }
  })

  it('refuses a filtered operation that carries no filter at all (ADR-0075, D-F4)', () => {
    // The routing promise, made structural. An unfiltered read belongs on a
    // rollup and the only thing that could send it here is a bug — so the
    // operation refuses rather than trusting the caller, and a future edit that
    // routed an empty chip row down the raw path fails loudly instead of
    // quietly costing a scan.
    const filtered = findOperation('analytics.filtered_pages_hour')!
    expect(() =>
      filtered.bindParams({ site_id: SITE, ...DAY_RANGE, limit: 10, filters: [] }),
    ).toThrow(ApiError)
    expect(() =>
      filtered.bindParams({
        site_id: SITE,
        ...DAY_RANGE,
        limit: 10,
        filters: [{ dimension: 'country', operator: 'in', values: ['US'] }],
      }),
    ).not.toThrow()
  })

  it('binds a filter value, never splices it (ADR-0075, D-F3)', () => {
    // The value never appears in the statement, and every dimension is bound on
    // every call — an inactive one as an off-flag beside an empty list — which
    // is what keeps the SQL a module-load constant a fifth dimension need not
    // edit.
    const filtered = findOperation('analytics.filtered_geography_hour')!
    const bound = filtered.bindParams({
      site_id: SITE,
      ...DAY_RANGE,
      limit: 10,
      // An apostrophe, because a real city has one and a hand-rolled ClickHouse
      // array literal is exactly where that would have broken.
      filters: [{ dimension: 'city', operator: 'eq', values: ["N'Djamena"] }],
    })
    expect(filtered.sql).not.toContain('Djamena')
    expect(bound['f_city']).toBe(JSON.stringify(["N'Djamena"]))
    expect(bound['f_city_on']).toBe(1)
    expect(bound['f_country_on']).toBe(0)
    expect(bound['f_country']).toBe('[]')
  })

  it('opens the session window a full session cap before the range (ADR-0075)', () => {
    // A session that began before `from` owns events inside it, and the cap is
    // what makes the widening exact rather than generous: 24 hours (ADR-0018),
    // because a session containing an event at t cannot have started earlier.
    const filtered = findOperation('analytics.filtered_pages_hour')!
    const bound = filtered.bindParams({
      site_id: SITE,
      ...DAY_RANGE,
      limit: 10,
      filters: [{ dimension: 'country', operator: 'eq', values: ['US'] }],
    })
    expect(bound['from']).toBe('2026-07-01 00:00:00.000')
    expect(bound['session_from']).toBe('2026-06-30 00:00:00.000')
  })

  it('joins events to sessions through every hint, not just the entry one', () => {
    // The measured bug this shape exists to prevent: the sessionizer partitions
    // by resolved identity rather than by hint, so one session owns every tab's
    // hint and `session_hint` stores only the first. On a production fortnight
    // the entry hint alone matched 82% of page views while 99% of them had a
    // session under the same anonymous id — a silent one-in-six undercount on
    // every filtered report.
    const filtered = findOperation('analytics.filtered_sources_hour')!
    expect(filtered.sql).toContain('arrayJoin(arrayFilter(')
    expect(filtered.sql).toContain('argMax(sfv.session_hints, sfv.version)')
    // And the events-side join column is the raw table's `session_id`, which IS
    // the hint: `session_facts_versions.session_id` is a different value (0013)
    // and joining on it returns nothing at all, silently.
    expect(filtered.sql).toContain('(er.site_id, er.session_id) IN (')
  })

  it('bounds the recent-visitor reads to a day, a row cap and one identity rule', () => {
    const recent = findOperation('analytics.recent_visitors')!
    const trail = findOperation('analytics.visitor_trail')!
    const funnel = findOperation('analytics.funnel_visitor')!

    // The same identity the funnel aggregates by — the D-102 anonymous id
    // (ADR-0036 D3) — so "one visitor" means one thing across the API. The
    // identify() hash is folded onto the anonymous group as an attribute,
    // never used as a competing row identity: keyed on the resolved-identity
    // expression, one identified person was their anonymous row plus a
    // phantom user_id row with zero pageviews.
    expect(recent.sql).toContain('er.anonymous_id AS visitor')
    expect(recent.sql).toContain(
      "argMaxIf(er.user_id, er.occurred_at, er.user_id != '') AS user_id",
    )
    expect(recent.sql).not.toContain("if(er.user_id != '', er.user_id, er.anonymous_id)")
    expect(trail.sql).toContain('er.anonymous_id = {visitor:String}')
    // The funnel's visitor unit is the anonymous id, or the identify hash it
    // was paired with: a signed-in person's days are one unit, never a
    // competing row identity next to their anonymous one.
    expect(funnel.sql).toContain(
      "if(idm.identified_as != '', idm.identified_as, er.anonymous_id) AS unit",
    )
    expect(funnel.sql).toContain('GROUP BY unit')

    const day = 24 * 3_600_000
    const from = '2026-07-23T00:00:00.000Z'
    for (const operation of [recent, trail]) {
      const extra = operation.id === 'analytics.visitor_trail' ? { visitor: 'v1' } : {}
      expect(() =>
        operation.bindParams({
          site_id: SITE,
          from,
          to: new Date(Date.parse(from) + day).toISOString(),
          ...extra,
        }),
      ).not.toThrow()
      expect(() =>
        operation.bindParams({
          site_id: SITE,
          from,
          to: new Date(Date.parse(from) + day + 1).toISOString(),
          ...extra,
        }),
      ).toThrow()
    }

    expect(recent.maxRows).toBe(200)
    expect(trail.maxRows).toBe(500)
    // Newest first on both, so a row cap cuts the oldest activity, not the newest.
    expect(recent.sql).toContain('ORDER BY last_seen DESC')
    expect(trail.sql).toContain('ORDER BY occurred_at DESC')

    // Neither may be cached (ADR-0035, D7). Their window ends at `now` rather
    // than on a whole minute, so an entry could never be read twice — it would
    // serve no hit and evict a key from the shared bounded LRU that could have.
    expect(recent.cacheable).toBe(false)
    expect(trail.cacheable).toBe(false)
  })

  it('routes the session finalized layer to the long cache TTL band and provisional to the short', () => {
    for (const id of [
      'analytics.sessions_finalized_hour',
      'analytics.sessions_finalized_day',
      'analytics.sessions_finalized_day_local',
    ]) {
      expect(findOperation(id)?.cacheProfile).toBe('finalized')
    }
    for (const id of [
      'analytics.sessions_provisional_hour',
      'analytics.sessions_provisional_day',
      'analytics.sessions_provisional_day_local',
    ]) {
      expect(findOperation(id)?.cacheProfile).toBe('default')
    }
  })

  it('reads session current-truth with argMax then filters retracted, never FINAL', () => {
    const provisional = findOperation('analytics.sessions_provisional_hour')
    expect(provisional?.sql).toMatch(/argMax\(sfv\.\w+, sfv\.version\)/)
    expect(provisional?.sql).toMatch(/cur\.retracted = 0/)
    expect(provisional?.sql).not.toMatch(/FINAL/i)
    const finalized = findOperation('analytics.sessions_finalized_hour')
    expect(finalized?.sql).toMatch(/argMax\(sr\.\w+, sr\.generation\)/)
    expect(finalized?.sql).not.toMatch(/FINAL/i)
  })

  it('binds a bounded, deterministic funnel and pads unused step slots', () => {
    const funnel = findOperation('analytics.funnel_visitor')
    const bound = funnel?.bindParams({
      site_id: SITE,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-08T00:00:00.000Z',
      steps: ['/pricing', 'signup'],
      window_ms: 1_800_000,
    })
    expect(bound?.['step_count']).toBe(2)
    expect(bound?.['step_1']).toBe('/pricing')
    expect(bound?.['step_1_kind']).toBe('key')
    expect(bound?.['step_2']).toBe('signup')
    // Unused slots are bound to an empty string, gated off by the step_count guard.
    expect(bound?.['step_8']).toBe('')
    // Revenue is opt-in: a caller that predates it reads none.
    expect(bound?.['with_revenue']).toBe(0)
    expect(funnel?.sql).toContain('windowFunnel({window_ms:UInt64})')
    // A range past the synchronous funnel cap is refused (async is a follow-up).
    expect(() =>
      funnel?.bindParams({
        site_id: SITE,
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-07-01T00:00:00.000Z',
        steps: ['/a', '/b'],
        window_ms: 1_800_000,
      }),
    ).toThrow(ApiError)
    // Fewer than two steps is not a funnel.
    expect(() =>
      funnel?.bindParams({
        site_id: SITE,
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-02T00:00:00.000Z',
        steps: ['/a'],
        window_ms: 1_000,
      }),
    ).toThrow(ApiError)
  })

  it('binds step kinds as values, never SQL, and refuses a malformed step object', () => {
    const funnel = findOperation('analytics.funnel_session')!
    const bound = funnel.bindParams({
      site_id: SITE,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-08T00:00:00.000Z',
      steps: [
        '{"page":"/de/discount/*"}',
        '{"event":"plan_selected","where":{"plan":"yearly","trial":"true"}}',
        '/100%_done',
      ],
      window_ms: 1_800_000,
      with_revenue: true,
    })
    expect(bound['step_1_kind']).toBe('page')
    expect(bound['step_1']).toBe('/de/discount/%')
    expect(bound['step_2_kind']).toBe('event')
    expect(bound['step_2']).toBe('plan_selected')
    expect(bound['step_2_where_1_key']).toBe('plan')
    expect(bound['step_2_where_1_value']).toBe('yearly')
    expect(bound['step_2_where_2_key']).toBe('trial')
    expect(bound['step_2_where_3_key']).toBe('')
    // A legacy key is compared exactly, so its LIKE metacharacters stay literal.
    expect(bound['step_3_kind']).toBe('key')
    expect(bound['step_3']).toBe('/100%_done')
    expect(bound['with_revenue']).toBe(1)
    expect(funnel.sql).toContain('like(er.page_path, {step_1:String})')

    for (const bad of ['{"page":"no-slash"}', '{nope', '{"event":"x","extra":1}']) {
      expect(() =>
        funnel.bindParams({
          site_id: SITE,
          from: '2026-07-01T00:00:00.000Z',
          to: '2026-07-02T00:00:00.000Z',
          steps: ['/a', bad],
          window_ms: 1_000,
        }),
      ).toThrow(ApiError)
    }
  })

  it('is a single statement with no comment escape', () => {
    for (const operation of QUERY_OPERATIONS.values()) {
      expect(operation.sql).not.toMatch(/;|--|\/\*/)
    }
  })

  it('names its sites on every analytics operation, so no operation is cross-site', () => {
    // ADR-0080 widened this from "binds `site_id`" to "binds `site_id` **or**
    // `site_ids`". What it did not widen is the boundary: the statement can only
    // read sites the caller named, and the api only ever names sites the
    // requesting user is a member of. An operation that bound neither could read
    // every site in the cluster, which is what this assertion exists to make
    // impossible.
    for (const operation of QUERY_OPERATIONS.values()) {
      if (operation.id === 'health.clickhouse_roundtrip') continue
      expect(operation.requiresSiteScope).toBe(true)
      if (MULTI_SITE_OPERATIONS.includes(operation.id)) {
        expect(operation.sql, operation.id).toContain('{site_ids:Array(UUID)}')
        // Exactly one of the two forms — never a statement that filters by a
        // single id while claiming to answer for a list.
        expect(operation.sql, operation.id).not.toContain('{site_id:UUID}')
      } else {
        expect(operation.sql, operation.id).toContain('{site_id:UUID}')
      }
    }
  })

  it('keeps the multi-site binding off every single-site family', () => {
    // The inverse, and the one a careless refactor breaks: no ordinary report
    // may quietly grow a `site_ids` binding, because every authorization check
    // above the gateway is written for one site at a time.
    for (const operation of QUERY_OPERATIONS.values()) {
      if (MULTI_SITE_OPERATIONS.includes(operation.id)) continue
      expect(operation.sql, operation.id).not.toContain('{site_ids:')
    }
  })

  it('reads unique visitors with uniqMerge, never a bucket sum', () => {
    for (const id of [
      'analytics.overview_hour',
      'analytics.pages_hour',
      'analytics.timeseries_hour',
    ]) {
      const operation = findOperation(id)
      // The column reference may be alias-qualified (`t.visitors`) — what the
      // assertion pins is the merge function, never a plain sum of the state.
      // The metrics-family reads carry the ADR-0036 page-view filter on the
      // merge; the pages report needs none because its rollup filters at write.
      expect(operation?.sql).toMatch(
        /uniqMergeIf\(t\.visitors, t\.event_type = 'page_view'\)|uniqMerge\(visitors\)/,
      )
      expect(operation?.sql).not.toMatch(/sum\((?:t\.)?visitors\)/)
    }
  })

  it('reads performance percentiles with the exact stored t-digest parameter list', () => {
    const operation = findOperation('analytics.performance_hour')
    expect(operation?.sql).toContain(
      'quantilesTDigestMerge(0.5, 0.75, 0.9, 0.95, 0.99)(value_quantiles)',
    )
  })

  it('never pairs a visitors merge with a page-view-filtered count unless the merge is filtered too (ADR-0036)', () => {
    // The drift this pins: for six milestones the timeseries and overview reads
    // paired `sumIf(events, event_type = 'page_view') AS pageviews` with a BARE
    // `uniqMerge(visitors)` over states the metrics rollups store per
    // event_type — so a departure beacon in the next bucket minted a visitor
    // with zero pageviews, and `identify()`'s user_id state double-counted a
    // person. Any operation that projects a page-view-filtered count must
    // filter its visitors merge to the same population. (`uniqMergeIf(` does
    // not contain the substring `uniqMerge(`, which is what makes the negative
    // assertion exact.)
    for (const operation of QUERY_OPERATIONS.values()) {
      if (!operation.sql.includes('AS pageviews')) continue
      expect(operation.sql, operation.id).not.toMatch(/uniqMerge\(/)
      if (operation.sql.includes('uniqMergeIf(')) {
        expect(operation.sql, operation.id).toMatch(
          /uniqMergeIf\([^,]+,\s*[^)]*event_type = 'page_view'\)/,
        )
      }
    }
    // And the guard itself must be exercised: the two families it was written
    // for are present and carry the filtered merge.
    for (const id of ['analytics.timeseries_hour', 'analytics.overview_day']) {
      expect(findOperation(id)?.sql).toContain('uniqMergeIf(')
    }
  })
})

/**
 * The multi-site site-card reads (ADR-0080).
 *
 * These are the first operations in the registry whose parameter is a *list* of
 * sites, so the parameter schema is carrying weight the single-site ones never
 * had to: it is what bounds the fan-out, and it is what keeps `maxRows` an
 * honest ceiling rather than a truncation waiting to happen.
 */
describe('site card operations bind a list of sites (ADR-0080)', () => {
  /** A Monday-aligned 40-week window, the shape the api computes. */
  const WEEK_MS = 7 * 86_400_000
  const TO = '2026-09-14T00:00:00.000Z' // a Monday
  const FROM = new Date(Date.parse(TO) - 40 * WEEK_MS).toISOString()
  const base = { site_ids: [SITE, SITE_B], from: FROM, to: TO }

  it('binds the id list as a ClickHouse Array(UUID) literal, never into the statement', () => {
    const operation = findOperation('analytics.sites_all_time')
    const parameters = operation?.bindParams(base)

    // The value travels as `param_site_ids`; ClickHouse parses it against the
    // declared `Array(UUID)` type server-side. The quoting is safe only because
    // every element passed `z.uuid()` first, which is asserted below.
    expect(parameters).toEqual({
      site_ids: `['${SITE}','${SITE_B}']`,
      from: '2025-12-08 00:00:00.000',
      to: '2026-09-14 00:00:00.000',
    })
    expect(operation?.sql).toContain('{site_ids:Array(UUID)}')
    expect(operation?.sql).not.toContain(SITE)
  })

  it('refuses an empty list, a non-uuid element and a repeated id', () => {
    const operation = findOperation('analytics.sites_all_time')
    // Empty is not "all sites" and must never be readable as such.
    expect(() => operation?.bindParams({ ...base, site_ids: [] })).toThrow(ApiError)
    expect(() => operation?.bindParams({ ...base, site_ids: ["' OR 1=1 --"] })).toThrow(ApiError)
    expect(() => operation?.bindParams({ ...base, site_ids: [SITE, SITE] })).toThrow(ApiError)
  })

  it('caps the fan-out below its own row ceiling', () => {
    const operation = findOperation('analytics.sites_all_time')
    const ids = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      )

    expect(() => operation?.bindParams({ ...base, site_ids: ids(100) })).not.toThrow()
    expect(() => operation?.bindParams({ ...base, site_ids: ids(101) })).toThrow(ApiError)

    // The cap and the row ceiling are the same statement said twice: 100 sites ×
    // (40 weeks + 1 total). A request that could exceed `maxRows` would come
    // back truncated — a silently short answer — instead of refused.
    expect(operation?.maxRows).toBe(100 * 41)
  })

  it('requires UTC Monday endpoints, because every plotted week must be whole', () => {
    const operation = findOperation('analytics.sites_all_time')
    // Day-aligned but a Tuesday: `toStartOfWeek(…, 1)` would fold six days into
    // the first bucket and one into the last, producing two short points the
    // card draws at full width.
    expect(() => operation?.bindParams({ ...base, from: '2025-12-09T00:00:00.000Z' })).toThrow(
      ApiError,
    )
    // Monday, but not midnight.
    expect(() => operation?.bindParams({ ...base, from: '2025-12-08T01:00:00.000Z' })).toThrow(
      ApiError,
    )
    expect(() => operation?.bindParams({ ...base, from: TO, to: FROM })).toThrow(ApiError)
  })

  it('bounds the window at forty weeks', () => {
    const operation = findOperation('analytics.sites_all_time')
    const tooEarly = new Date(Date.parse(TO) - 41 * WEEK_MS).toISOString()
    expect(() => operation?.bindParams({ ...base, from: tooEarly })).toThrow(ApiError)
  })

  it('reads visitors as a page-view-filtered merge, and totals without a lower bound', () => {
    const sql = findOperation('analytics.sites_all_time')?.sql ?? ''
    // ADR-0036: the same population `pageviews` counts, so `visitors <=
    // pageviews` holds on the total row and on every week.
    expect(sql).toContain("uniqMergeIf(t.visitors, t.event_type = 'page_view')")
    expect(sql).not.toMatch(/uniqMerge\(/)
    expect(sql).not.toMatch(/sum\((?:t\.)?visitors\)/)

    // "All time" is literal: the total branch takes the upper bound only. Two
    // `>=` filters would mean the week window silently clipped the totals too.
    expect(sql.match(/AND t\.bucket_start >= /gu)).toHaveLength(1)
    expect(sql.match(/AND t\.bucket_start < /gu)).toHaveLength(2)
    expect(sql).toContain("toDateTime64(toStartOfWeek(t.bucket_start, 1), 3, 'UTC') AS week")
  })

  it('takes the current generation of each revenue bucket, never FINAL or a raw sum', () => {
    const operation = findOperation('analytics.sites_all_time_revenue')
    // `revenue_1d` is a ReplacingMergeTree: summing it directly would add every
    // superseded generation of every recomputed bucket (the D-212 read rule).
    expect(operation?.sql).toContain('argMax(rr.net_minor, rr.generation)')
    expect(operation?.sql).not.toContain('FINAL')
    expect(operation?.sql).toContain('GROUP BY rr.site_id, rr.bucket_start')

    // All-time only: it validates the same window as its sibling — one window
    // definition for both halves of the card — but binds no lower bound.
    const parameters = operation?.bindParams(base)
    expect(parameters).toEqual({
      site_ids: `['${SITE}','${SITE_B}']`,
      to: '2026-09-14 00:00:00.000',
    })
    expect(operation?.maxRows).toBe(100)
  })

  it('is not cached in the gateway, because the api holds the long TTL', () => {
    // ADR-0080 D5 puts the cache in the api, keyed by the caller's membership
    // set and held for minutes. A second TTL here would decide nothing and would
    // make "why is this number stale" a two-place question.
    for (const id of MULTI_SITE_OPERATIONS) {
      expect(findOperation(id)?.cacheable, id).toBe(false)
    }
  })
})

describe('binding keeps values out of the statement and enforces the range', () => {
  it('binds parameters as placeholders and converts instants to the DateTime64 form', () => {
    const operation = findOperation('analytics.overview_hour')
    const parameters = operation?.bindParams({ site_id: SITE, ...DAY_RANGE, ...NO_IMPORT })

    expect(parameters).toEqual({
      site_id: SITE,
      from: '2026-07-01 00:00:00.000',
      to: '2026-07-08 00:00:00.000',
      tz: 'UTC',
      import_run_id: NIL_IMPORT_RUN_ID,
      import_cutover: EPOCH_IMPORT_CUTOVER,
    })
    expect(operation?.sql).toContain('{site_id:UUID}')
    expect(operation?.sql).not.toContain(SITE)
  })

  it('defaults and bounds the top-N limit', () => {
    const pages = findOperation('analytics.pages_hour')
    const base = { site_id: SITE, ...DAY_RANGE, ...NO_IMPORT_CUTOVER }
    expect(pages?.bindParams(base)['limit']).toBe(100)
    expect(pages?.bindParams({ ...base, limit: 25 })['limit']).toBe(25)
    expect(() => pages?.bindParams({ ...base, limit: 10_000 })).toThrow(ApiError)
  })

  it('rejects an inverted range', () => {
    const operation = findOperation('analytics.overview_hour')
    expect(() =>
      operation?.bindParams({
        site_id: SITE,
        from: DAY_RANGE.to,
        to: DAY_RANGE.from,
        ...NO_IMPORT,
      }),
    ).toThrow(ApiError)
  })

  it('rejects a range longer than the operation cap', () => {
    const operation = findOperation('analytics.overview_hour')
    expect(() =>
      operation?.bindParams({
        site_id: SITE,
        from: '2020-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
        ...NO_IMPORT,
      }),
    ).toThrow(ApiError)
  })

  it('rejects a range whose endpoints do not align to the rollup bucket boundary', () => {
    const quarter = findOperation('analytics.overview_hour')
    // 00:07 is not a UTC quarter-hour boundary — the atom rollup buckets at
    // :00/:15/:30/:45 and nothing finer, so this range has no honest answer.
    expect(() =>
      quarter?.bindParams({
        site_id: SITE,
        from: '2026-07-01T00:07:00.000Z',
        to: DAY_RANGE.to,
        ...NO_IMPORT,
      }),
    ).toThrow(ApiError)

    // 00:15 IS a quarter-hour boundary, and since ADR-0079 step 3 it is the
    // shape a +05:30 zone's local midnight actually snaps to. The old hour
    // check rejected it; accepting it is the whole point of the step.
    expect(() =>
      quarter?.bindParams({
        site_id: SITE,
        from: '2026-07-01T00:15:00.000Z',
        to: DAY_RANGE.to,
        ...NO_IMPORT,
      }),
    ).not.toThrow()

    const day = findOperation('analytics.overview_day')
    // 06:00 is a valid quarter-hour boundary but not a UTC-day boundary.
    expect(() =>
      day?.bindParams({
        site_id: SITE,
        from: '2026-07-01T06:00:00.000Z',
        to: DAY_RANGE.to,
        ...NO_IMPORT,
      }),
    ).toThrow(ApiError)
  })

  it('rejects unknown parameters rather than ignoring them', () => {
    // A silently dropped filter is how a scoped query becomes an unscoped one.
    const operation = findOperation('analytics.overview_hour')
    expect(() =>
      operation?.bindParams({ site_id: SITE, ...DAY_RANGE, ...NO_IMPORT, table: 'system.tables' }),
    ).toThrow(ApiError)
  })

  it('rejects a malformed site id', () => {
    const operation = findOperation('analytics.overview_hour')
    expect(() =>
      operation?.bindParams({ site_id: 'not-a-uuid', ...DAY_RANGE, ...NO_IMPORT }),
    ).toThrow(ApiError)
  })
})

describe('the import partition (ADR-0032, D2b/D4)', () => {
  /**
   * Exactly the operations whose statement names the cutover.
   *
   * The cutover rather than the run id, because the two are not the same set: a
   * live breakdown takes only the cutover (its imported rows arrive through a
   * separate operation and are merged in the api), while a unioned or
   * imported-only operation takes both.
   */
  const importAware = [...QUERY_OPERATIONS.values()]
    .filter((operation) => operation.sql.includes('{import_cutover:Date}'))
    .map((operation) => operation.id)
    .sort()

  it('is exactly the set the api binds for, so neither end can drift', () => {
    // The gateway refuses both directions — an unbound placeholder and a bound
    // value the statement never uses — so a disagreement here is a 500 on a real
    // request. These two assertions are what tie the api's lists to the SQL.
    expect(importAware).toEqual([...IMPORT_AWARE_OPERATIONS].sort())
    expect(
      [...QUERY_OPERATIONS.values()]
        .filter((operation) => operation.sql.includes('{import_run_id:UUID}'))
        .map((operation) => operation.id)
        .sort(),
    ).toEqual([...IMPORT_RUN_OPERATIONS].sort())
  })

  it('partitions every timeseries but unions only the day and week grains', () => {
    // An aggregate-only export has one row per calendar day, so a sub-day
    // imported branch could only be a daily total smeared across buckets nobody
    // measured. The cutover still applies: two charts of the same range that
    // disagreed about whether the pre-cutover days exist would be worse than one
    // of them being empty, and the empty one is explained by `estimated`.
    for (const id of [
      'analytics.timeseries_minute',
      'analytics.timeseries_hour',
      'analytics.timeseries_day',
      'analytics.timeseries_day_utc',
      'analytics.timeseries_week',
      'analytics.timeseries_week_utc',
      'analytics.overview_hour',
      'analytics.overview_day',
    ]) {
      expect(importAware, id).toContain(id)
    }
    expect(IMPORT_RUN_OPERATIONS.has('analytics.timeseries_minute')).toBe(false)
    expect(IMPORT_RUN_OPERATIONS.has('analytics.timeseries_hour')).toBe(false)
    expect(findOperation('analytics.timeseries_minute')?.sql).not.toContain('imported_metrics_1d')
    expect(findOperation('analytics.timeseries_hour')?.sql).not.toContain('imported_metrics_1d')
    // No provider exports web vitals, so there is nothing to partition against
    // and applying one could only hide live samples.
    expect(importAware).not.toContain('analytics.performance_hour')
    expect(importAware).not.toContain('analytics.performance_day')
  })

  it('leaves every untouched operation byte-identical to CP2', () => {
    // A site with no import reads these through statements that never learned
    // about imports at all.
    for (const id of [
      'analytics.performance_hour',
      'analytics.performance_day',
      'analytics.sessions_finalized_hour',
      'analytics.recent_visitors',
      'analytics.freshness',
    ]) {
      const sql = findOperation(id)?.sql ?? ''
      expect(sql, id).not.toContain('import_run_id')
      expect(sql, id).not.toContain('import_cutover')
      expect(sql, id).not.toContain('imported_')
    }
  })

  it('renders the cutover boundary identically on every surface', () => {
    // The defect this pins: the chart placed a provider day at local midnight
    // while the totals and the breakdowns placed it at UTC midnight, so a KPI
    // card and the chart beneath it covered different days for any viewer far
    // enough from UTC — and a range the api called fully imported could still
    // contain live rows.
    const boundary = "toDateTime64(toDateTime({import_cutover:Date}, {tz:String}), 3, 'UTC')"
    const placement = "toDateTime64(toDateTime(i.date, {tz:String}), 3, 'UTC')"
    for (const id of importAware) {
      const sql = findOperation(id)?.sql ?? ''
      if (id.startsWith('analytics.imported_')) {
        expect(sql, id).toContain(placement)
        continue
      }
      // The two UTC-bucketed charts are only ever routed a UTC request, so their
      // zone literally is UTC and they say so rather than binding a parameter.
      const utcOnly = id.endsWith('_utc')
      expect(sql, id).toContain(utcOnly ? boundary.replace(/\{tz:String\}/, "'UTC'") : boundary)
      if (sql.includes('imported_metrics_1d')) {
        expect(sql, id).toContain(utcOnly ? placement.replace(/\{tz:String\}/, "'UTC'") : placement)
      }
    }
  })

  it('unions the day chart on the same bucket label both sides compute', () => {
    const sql = findOperation('analytics.timeseries_day')?.sql ?? ''
    // Live: the local day of an hour bucket. Imported: the provider's calendar
    // day placed at that day's local midnight. Same label, so a bucket does not
    // split in two across the seam.
    expect(sql).toContain("toDateTime64(toStartOfDay(t.bucket_start, {tz:String}), 3, 'UTC')")
    expect(sql).toContain("toDateTime64(toDateTime(i.date, {tz:String}), 3, 'UTC') AS bucket")
    expect(sql).toContain('UNION ALL')
    expect(sql).toContain('FROM imported_metrics_1d AS i')
    // D4's strict partition, both halves.
    expect(sql).toContain(
      "AND t.bucket_start >= toDateTime64(toDateTime({import_cutover:Date}, {tz:String}), 3, 'UTC')",
    )
    expect(sql).toContain('AND i.date < {import_cutover:Date}')
    // Visitors cross the union as a plain sum. There is no state to merge on the
    // imported side, and conjuring one would fabricate an identity set — D5 calls
    // the honest arithmetic `estimated` instead.
    expect(sql).toContain('sum(u.visitors) AS visitors')
    expect(sql).toContain("uniqMergeIf(t.visitors, t.event_type = 'page_view') AS visitors")
  })

  it('keeps the UTC day chart on DateTime, not DateTime64, so live-only bytes do not move', () => {
    // A DateTime64 imported branch would widen the union's supertype and start
    // rendering every live-only bucket with a milliseconds suffix.
    const sql = findOperation('analytics.timeseries_day_utc')?.sql ?? ''
    expect(sql).toContain('t.bucket_start AS bucket')
    expect(sql).toContain("toDateTime(i.date, 'UTC') AS bucket")
    expect(sql).not.toContain("toDateTime64(toDateTime(i.date, 'UTC'), 3, 'UTC') AS bucket")
  })

  it('groups imported days into ISO Monday weeks on both week charts', () => {
    expect(findOperation('analytics.timeseries_week_utc')?.sql).toContain(
      "toDateTime64(toStartOfWeek(i.date, 1), 3, 'UTC') AS bucket",
    )
    // Two arguments, not three: the zone goes on the `toDateTime` that turns the
    // Monday back into an instant, never on the `toStartOfWeek` that reads a
    // calendar date. See the structural guard below for why.
    expect(findOperation('analytics.timeseries_week')?.sql).toContain(
      "toDateTime64(toDateTime(toStartOfWeek(i.date, 1), {tz:String}), 3, 'UTC') AS bucket",
    )
  })

  it('never passes a timezone to a Date-typed toStartOf* call', () => {
    // ClickHouse **rejects** a timezone argument on a Date-typed call of the
    // `toStartOf*` family — ILLEGAL_TYPE_OF_ARGUMENT (43) — rather than ignoring
    // it, and it would be meaningless anyway: no zone moves a calendar date into
    // a different week. `i.date`, the imported day, is the only Date-typed column
    // any operation groups on, and this is the shape that cost a CI round-trip.
    for (const operation of QUERY_OPERATIONS.values()) {
      expect(operation.sql, operation.id).not.toMatch(/toStartOf\w+\(i\.date[^)]*\{tz:String\}/)
    }
  })

  it('never adds imported rows to billable_events', () => {
    // Import data is not billable (D10, D-101). A range total that counted it
    // would make a dashboard disagree with an invoice.
    for (const id of ['analytics.overview_hour', 'analytics.overview_day']) {
      expect(findOperation(id)?.sql).toContain('toUInt64(0) AS billable_events')
    }
  })

  it('projects the live report’s own column names on every imported breakdown', () => {
    // The merge is keyed on them, and the response schema must not change: a
    // caller cannot tell a merged row from a live one.
    expect(findOperation('analytics.imported_pages')?.sql).toContain('i.page AS page_path')
    expect(findOperation('analytics.imported_sources')?.sql).toContain(
      'i.referrer AS referrer_domain',
    )
    expect(findOperation('analytics.imported_devices')?.sql).toContain('i.device AS device_type')
    expect(findOperation('analytics.imported_custom_events')?.sql).toContain('i.name AS event_name')
    // Geography is country-only: the import has no city, and one is never
    // invented beside real live city names.
    const geography = findOperation('analytics.imported_geography')?.sql ?? ''
    expect(geography).toContain('i.country AS country')
    expect(geography).not.toContain('city')
  })

  it('serializes every imported count as the same JSON type its live twin does', () => {
    // The live measures are `sum(...)` over an unsigned column and
    // `uniqMerge(...)`, and ClickHouse types **both** as UInt64 whatever the
    // stored width. So every imported measure is explicitly `toUInt64(...)`: a
    // bare `sum()` over a narrower column would still widen, but a future measure
    // that did not — a count, a difference — would come back as a different JSON
    // type on one side of a merged list only, and the merge would be adding a
    // string to a number.
    for (const id of importAware.filter((name) => name.startsWith('analytics.imported_'))) {
      const measures = (findOperation(id)?.sql ?? '')
        .split('\n')
        // The aggregate *call*, not the word: `i.country AS country` is a
        // dimension whose name happens to start with "count".
        .filter((line) => /^ {2}\S.*\bAS\b/.test(line) && /\b(sum|count|uniq\w*)\(/.test(line))
      expect(measures.length, id).toBeGreaterThan(0)
      for (const measure of measures) {
        expect(measure.trim(), `${id}: ${measure.trim()}`).toMatch(/^toUInt64\(/)
      }
    }
  })

  it('binds every imported breakdown to the run, the cutover and the range', () => {
    for (const id of importAware.filter((name) => name.startsWith('analytics.imported_'))) {
      const operation = findOperation(id)
      const bound = operation?.bindParams({ site_id: SITE, ...DAY_RANGE, ...PUBLISHED_IMPORT })
      expect(bound?.['import_run_id'], id).toBe(PUBLISHED_IMPORT.import_run_id)
      expect(bound?.['import_cutover'], id).toBe(PUBLISHED_IMPORT.import_cutover)
      expect(bound?.['limit'], id).toBe(100)
      expect(operation?.sql, id).toContain('AND i.import_run_id = {import_run_id:UUID}')
      expect(operation?.sql, id).toContain('AND i.date < {import_cutover:Date}')
      expect(operation?.maxRows, id).toBe(500)
    }
  })

  it('refuses a cutover that is not a calendar date', () => {
    const operation = findOperation('analytics.imported_pages')
    expect(() =>
      operation?.bindParams({ site_id: SITE, ...DAY_RANGE, ...NO_IMPORT, import_cutover: 'today' }),
    ).toThrow(ApiError)
    expect(() =>
      operation?.bindParams({ site_id: SITE, ...DAY_RANGE, ...NO_IMPORT, import_run_id: 'nope' }),
    ).toThrow(ApiError)
  })

  it('requires both import parameters rather than defaulting them', () => {
    // "No import published" is a pair of values, not an omission — otherwise a
    // caller that forgot them would get a read with no cutover partition at all.
    const operation = findOperation('analytics.overview_day')
    expect(() => operation?.bindParams({ site_id: SITE, ...DAY_RANGE })).toThrow(ApiError)
  })
})

describe('timezone binding', () => {
  it('binds the timezone as a parameter on the timeseries operations', () => {
    const minute = findOperation('analytics.timeseries_minute')
    const parameters = minute?.bindParams({
      site_id: SITE,
      from: '2026-07-23T00:00:00.000Z',
      to: '2026-07-23T06:00:00.000Z',
      timezone: 'America/New_York',
      import_cutover: EPOCH_IMPORT_CUTOVER,
    })
    expect(parameters?.['tz']).toBe('America/New_York')
    expect(minute?.sql).toContain('{tz:String}')
    // The zone is never spliced into the statement text.
    expect(minute?.sql).not.toContain('America/New_York')
  })

  it('renders every timezone-local bucket as a UTC instant', () => {
    // ClickHouse renders a DateTime in the timezone carried by its type, so
    // `toStartOf*(col, {tz:String})` returns the right instant labelled in the
    // request's zone — and the API reads a bucket label as a UTC instant (it
    // appends "Z"), which shifts every bucket by that zone's offset. The wrapper
    // changes the rendering timezone only, never the instant and never the
    // grouping. Asserted structurally so a timezone operation added later cannot
    // reintroduce local wall-clock labels without failing here.
    // Four accepted shapes, spelled out rather than loosened into one permissive
    // pattern, so the set of legal timezone-bearing expressions stays enumerable:
    //   * `toStartOf<Grain>(col, tz)` — minute/hour/day, already an instant.
    //   * the week form, whose `toStartOfWeek` returns a *Date* (the local
    //     Monday) and needs `toDateTime(date, tz)` to become the instant that
    //     local Monday midnight is, before the same UTC relabelling.
    //   * the imported forms M11 CP3 added (ADR-0032, D4): a provider day placed
    //     at its local midnight, and the cutover date rendered the same way. Both
    //     are instants derived from a Date, which is why they take the zone.
    // Two shapes of the week form, and the difference is a type rule rather than
    // a style: a `DateTime` argument needs the zone to be reduced to a local
    // calendar date, a `Date` argument already is one and ClickHouse refuses the
    // zone outright.
    const WEEK = String.raw`toDateTime\(toStartOfWeek\([\w.]+, 1(?:, \{tz:String\})?\), \{tz:String\}\)`
    const SIMPLE = String.raw`toStartOf\w+\([\w.]+, \{tz:String\}\)`
    const IMPORTED_DAY = String.raw`toDateTime\(i\.date, \{tz:String\}\)`
    const CUTOVER = String.raw`toDateTime\(\{import_cutover:Date\}, \{tz:String\}\)`
    const wrapped = new RegExp(
      String.raw`^toDateTime64\((?:${WEEK}|${SIMPLE}|${IMPORTED_DAY}), 3, 'UTC'\)$`,
    )

    const timezoneOperations = [...QUERY_OPERATIONS.values()].filter((operation) =>
      operation.sql.includes('{tz:String}'),
    )
    // Every parameter schema is a `strictObject`, so binding a zone to an
    // operation that has none is rejected exactly as loudly as omitting one it
    // needs — which makes the api's list of zone-taking operations a thing that
    // has to be pinned rather than assumed. It is deliberately NOT the
    // import-aware set: the UTC-bucketed charts read the import and take no
    // zone, and `performance` takes neither.
    expect(timezoneOperations.map((operation) => operation.id).sort()).toEqual(
      [...TIMEZONE_OPERATIONS].sort(),
    )
    expect(timezoneOperations.map((operation) => operation.id).sort()).toEqual([
      'analytics.custom_events_day',
      'analytics.custom_events_hour',
      'analytics.devices_day',
      'analytics.devices_hour',
      // Only the four filtered charts that bucket in LOCAL time (ADR-0075). The
      // filtered breakdowns and totals have no bucket to label and no cutover to
      // render, so a zone bound to one of them is a "bound unused parameter"
      // rejection — the same rule this list already encodes for `performance`.
      'analytics.filtered_timeseries_day',
      'analytics.filtered_timeseries_hour',
      'analytics.filtered_timeseries_minute',
      'analytics.filtered_timeseries_week',
      'analytics.geography_day',
      'analytics.geography_hour',
      'analytics.imported_browsers',
      'analytics.imported_custom_events',
      'analytics.imported_devices',
      'analytics.imported_geography',
      'analytics.imported_os',
      'analytics.imported_pages',
      'analytics.imported_sources',
      'analytics.overview_day',
      'analytics.overview_hour',
      'analytics.pages_day',
      'analytics.pages_hour',
      'analytics.revenue_timeseries_day_local',
      'analytics.revenue_timeseries_hour',
      'analytics.sessions_finalized_day_local',
      'analytics.sessions_finalized_hour',
      'analytics.sessions_provisional_day_local',
      'analytics.sessions_provisional_hour',
      'analytics.sources_day',
      'analytics.sources_hour',
      'analytics.timeseries_day',
      'analytics.timeseries_hour',
      'analytics.timeseries_minute',
      'analytics.timeseries_week',
    ])

    for (const operation of timezoneOperations) {
      // Every `… AS bucket` in the statement, at any indentation. A unioned
      // operation has three: the outer projection's plain `u.bucket`, the live
      // branch's and the imported branch's. The last two are labels computed from
      // a zone-typed value and must come back rendered as UTC — the API reads a
      // bucket string as a UTC instant, so a local wall clock would silently shift
      // every point by the viewer's offset.
      const selects = [...operation.sql.matchAll(/^ *(.+?) AS bucket,?$/gm)].map(
        (match) => match[1] as string,
      )
      // A breakdown has no bucket at all — it takes the zone only for the cutover
      // boundary, which the residue check below covers.
      for (const selected of selects) {
        if (selected === 'u.bucket') continue
        expect(selected, `${operation.id} bucket label is not UTC`).toMatch(wrapped)
      }

      // The zone may only reach the statement through one of the four enumerated
      // forms: an operation that bound it into some other filter or projection
      // would be shaping the answer with a value this assertion does not inspect.
      // Stripping every legal form and demanding nothing is left is fail-closed —
      // a new use of the zone has to be added here before it can ship.
      const residue = operation.sql
        .replace(new RegExp(WEEK, 'g'), '')
        .replace(new RegExp(SIMPLE, 'g'), '')
        .replace(new RegExp(IMPORTED_DAY, 'g'), '')
        .replace(new RegExp(CUTOVER, 'g'), '')
      expect(residue, `${operation.id} binds the zone outside an enumerated form`).not.toContain(
        '{tz:String}',
      )
    }
  })

  it('leaves the non-timezone bucket expressions unwrapped', () => {
    // These read a UTC column straight through. Wrapping them would change their
    // wire format for no reason, so the fix is scoped to the zone-typed ones.
    for (const id of [
      'analytics.timeseries_day_utc',
      'analytics.sessions_finalized_day',
      'analytics.sessions_provisional_day',
    ]) {
      const operation = findOperation(id)
      expect(operation?.sql).not.toContain('{tz:String}')
      expect(operation?.sql).not.toContain('toDateTime64(toStartOf')
    }
  })

  it('buckets ISO weeks on Monday and merges their visitors, never sums them', () => {
    // Mode 1 is what makes the week ISO (Monday start); mode 0 would silently
    // give Sunday-start weeks that disagree with every calendar the dashboard
    // shows. It is the whole semantic of these two operations, so it is pinned.
    const utc = findOperation('analytics.timeseries_week_utc')
    expect(utc?.sql).toContain("toDateTime64(toStartOfWeek(t.bucket_start, 1), 3, 'UTC')")
    // No zone: a UTC week's Monday is a UTC midnight, which is a metrics_1d
    // bucket boundary, so the day rollup answers it directly.
    expect(utc?.sql).not.toContain('{tz:String}')
    expect(utc?.sql).toContain('FROM metrics_1d')

    const local = findOperation('analytics.timeseries_week')
    expect(local?.sql).toContain(
      "toDateTime64(toDateTime(toStartOfWeek(t.bucket_start, 1, {tz:String}), {tz:String}), 3, 'UTC')",
    )
    // A local Monday midnight is a quarter-hour boundary, never a UTC-day one,
    // so the local week composes from metrics_15m — the same source the local
    // day uses.
    expect(local?.sql).toContain('FROM metrics_15m')

    for (const operation of [utc, local]) {
      // The point of grouping a week at read time rather than adding seven day
      // buckets: a visitor active on Monday and Thursday is one weekly visitor.
      // Filtered to the page-view population per ADR-0036.
      expect(operation?.sql).toMatch(/uniqMergeIf\(t\.visitors, t\.event_type = 'page_view'\)/)
      expect(operation?.sql).not.toMatch(/sum\(t\.visitors\)/)
      expect(operation?.maxRows).toBe(600)
    }
  })

  it('rejects an invalid timezone', () => {
    const hour = findOperation('analytics.timeseries_hour')
    expect(() =>
      hour?.bindParams({ site_id: SITE, ...DAY_RANGE, timezone: 'Mars/Phobos' }),
    ).toThrow(ApiError)
  })

  it('does not bind a timezone on the UTC day timeseries operation', () => {
    const dayUtc = findOperation('analytics.timeseries_day_utc')
    expect(dayUtc?.sql).not.toContain('{tz:String}')
    expect(() => dayUtc?.bindParams({ site_id: SITE, ...DAY_RANGE, timezone: 'UTC' })).toThrow(
      ApiError,
    )
  })
})

describe('health operation', () => {
  it('takes no parameters, reads no table and is not cached', () => {
    expect(clickhouseRoundtripOperation.requiresSiteScope).toBe(false)
    expect(clickhouseRoundtripOperation.cacheable).toBe(false)
    expect(clickhouseRoundtripOperation.bindParams({})).toEqual({})
  })
})

describe('canonical signing string (D-208)', () => {
  const fields = {
    keyId: 'oa-query-2026-07',
    audience: 'query-gateway:test',
    method: 'post',
    path: '/v1/query?x=1',
    issuedAt: '2026-07-21T12:00:00.000Z',
    expiresAt: '2026-07-21T12:00:30.000Z',
    nonce: 'nonce-1',
    bodySha256: sha256Hex('{}'),
  }

  it('binds scheme, key, audience, method, path, window, nonce and body hash', () => {
    expect(canonicalSigningString(fields).split('\n')).toEqual([
      SIGNATURE_SCHEME,
      'oa-query-2026-07',
      'query-gateway:test',
      'POST',
      '/v1/query?x=1',
      '2026-07-21T12:00:00.000Z',
      '2026-07-21T12:00:30.000Z',
      'nonce-1',
      fields.bodySha256,
    ])
  })

  it('changes when any single bound field changes', () => {
    const baseline = canonicalSigningString(fields)
    const mutations = [
      { ...fields, audience: 'query-gateway:prod' },
      { ...fields, method: 'GET' },
      { ...fields, path: '/v1/query' },
      { ...fields, nonce: 'nonce-2' },
      { ...fields, bodySha256: sha256Hex('{"a":1}') },
    ]

    for (const mutation of mutations) {
      expect(canonicalSigningString(mutation)).not.toBe(baseline)
    }
  })

  it('signs the query string, not only the pathname', () => {
    expect(signedPathOf('https://gateway.test/v1/query?site=a')).toBe('/v1/query?site=a')
    expect(signedPathOf('https://gateway.test:443/v1/query')).toBe('/v1/query')
  })

  it('round-trips a real Ed25519 signature and rejects a one-byte edit', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const verifyKey = loadVerifyKey(publicKey.export({ type: 'spki', format: 'pem' }).toString())

    const headers = signRequest({
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: fields.keyId,
      audience: fields.audience,
      method: 'POST',
      url: `https://gateway.test${fields.path}`,
      body: '{}',
      nonce: fields.nonce,
      issuedAt: new Date(fields.issuedAt),
      lifetimeMs: 30_000,
    })

    const signatureBase64 = headers['x-oa-signature'] as string
    const canonical = canonicalSigningString(fields)

    expect(verifySignature({ verifyKey, canonical, signatureBase64 })).toBe(true)
    expect(verifySignature({ verifyKey, canonical: `${canonical} `, signatureBase64 })).toBe(false)
    expect(verifySignature({ verifyKey, canonical, signatureBase64: 'not-base64!!' })).toBe(false)
  })

  it('refuses a verification key that is not Ed25519', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expect(() =>
      loadVerifyKey(rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    ).toThrow(/ed25519/)
  })
})

describe('in-memory nonce store', () => {
  it('accepts a nonce once and refuses it afterwards', async () => {
    const store = new InMemoryNonceStore({ now: () => 1_000 })
    const expiresAt = new Date(31_000)

    expect(await store.consume('n1', expiresAt)).toBe(true)
    expect(await store.consume('n1', expiresAt)).toBe(false)
    expect(await store.consume('n2', expiresAt)).toBe(true)
  })

  it('forgets a nonce once its signature can no longer verify', async () => {
    // Retaining a nonce past its signature's expiry buys nothing: the signature
    // is already unusable, and unbounded retention is the memory leak a Redis
    // implementation would replace with a TTL.
    let now = 1_000
    const store = new InMemoryNonceStore({ now: () => now, pruneThreshold: 1 })

    expect(await store.consume('n1', new Date(2_000))).toBe(true)
    now = 5_000
    expect(await store.consume('n2', new Date(9_000))).toBe(true)
    expect(store.size).toBe(1)
  })
})
