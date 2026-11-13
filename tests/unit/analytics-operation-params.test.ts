import { describe, expect, it } from 'vitest'
import { operationParamsFor } from '../../apps/api/src/analytics/resolve.ts'
import { QUERY_OPERATIONS, findOperation } from '../../apps/query-gateway/src/operations.ts'

/**
 * Every operation binds cleanly from the api's own parameter helper.
 *
 * This exists because of a specific failure mode, and it is one only a
 * ClickHouse-gated CI job used to catch. Every operation's parameter schema is a
 * `strictObject` and `defineOperation` cross-checks the bound keys against the
 * statement's placeholders **in both directions** — so a parameter an operation
 * needs and did not get, and a parameter it got and does not declare, are equally
 * fatal, and both surface as a `VALIDATION_FAILED` at request time rather than at
 * build time. M11 CP3 added three such parameters (`import_cutover`,
 * `import_run_id`, `timezone`) to overlapping but *different* subsets of the
 * registry: the UTC-bucketed charts read the import and take no zone, the live
 * breakdowns take the zone and the cutover but no run id, and `performance` takes
 * none of the three.
 *
 * So the api resolves them from the operation id through one helper, and this
 * walks the whole registry asserting that helper is sufficient and not excessive
 * — for a site with and without a published import, and for two zones. A new
 * operation, or a new bound parameter on an existing one, fails here in
 * milliseconds instead of in a CI round-trip.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const POINTER = { runId: '9f0f6f2e-6b32-4f0b-9e0a-6d1f0f6c2b41', cutoverDate: '2024-02-01' }

/** The parameters that are the operation's own subject rather than its scope. */
const EXTRAS: Readonly<Record<string, Record<string, unknown>>> = {
  'analytics.visitor_trail': { visitor: 'v1' },
  'analytics.visitor_revenue_entries': { visitor: 'v1' },
  'analytics.funnel_visitor': { steps: ['/a', '/b'], window_ms: 1_000 },
  'analytics.funnel_session': { steps: ['/a', '/b'], window_ms: 1_000 },
  // The revenue transactions keyset (CP5). The first page binds the range's
  // upper bound and an empty id, which is what makes one statement serve both
  // the first page and every later one.
  'analytics.revenue_transactions': {
    cursor_occurred_at: '2024-02-02T00:00:00.000Z',
    cursor_object_id: '',
    limit: 51,
  },
  // The order's money objects are keyed by the charge AND bounded by a range:
  // without the bound one journey load scans every partition the site has ever
  // had, because the sort key leads on site and object id rather than on time.
  'analytics.revenue_order_objects': { object_id: 'ch_1' },
  // Perier fork, DataFast gaps 3 and 4. The visitors denominator is bound to
  // the dimension values the revenue read returned; the events-before-purchase
  // read takes its look-back window.
  ...Object.fromEntries(
    ['referrer_domain', 'utm_source', 'utm_medium', 'utm_campaign', 'entry_page'].map((slug) => [
      `analytics.revenue_attribution_visitors_${slug}`,
      { values: ['google.com', "it's"] },
    ]),
  ),
  'analytics.revenue_events_before_purchase': { window_ms: 86_400_000 },
}

/**
 * Operations keyed by a subject rather than by a range (CP5).
 *
 * `analytics.freshness` was the first; the journey's attribution read is the
 * other. Its sibling `revenue_order_objects` is NOT here — it is keyed by the
 * charge and bounded by a range, because without the bound one journey load
 * scans every partition the site has ever had. A range bound to one of them is rejected as loudly as a missing
 * parameter — every schema here is a `strictObject` — so they are asserted with
 * the shape they are actually called with instead of being folded into the
 * range walk.
 */
const SUBJECT_ONLY: Readonly<Record<string, Record<string, unknown>>> = {
  'analytics.freshness': {},
  'analytics.revenue_transaction_journey': { object_id: 'ch_1' },
}

/**
 * The multi-site pair (ADR-0080), whose subject is a *list* of sites.
 *
 * Walked separately rather than folded into the range loop below, because the
 * two things that loop supplies are exactly the two they do not take: a single
 * `site_id`, and a range aligned to a UTC day. These need a list and a window of
 * whole ISO weeks — Monday to Monday — and every schema here is a `strictObject`,
 * so a `site_id` bound to one of them is refused as loudly as a missing
 * parameter. What is asserted is the same property: every placeholder bound,
 * nothing bound that the statement ignores.
 */
const MULTI_SITE: Readonly<Record<string, Record<string, unknown>>> = {
  // 2024-01-01 and 2024-02-05 are Mondays, five weeks apart.
  'analytics.sites_all_time': {
    site_ids: [SITE],
    from: '2024-01-01T00:00:00.000Z',
    to: '2024-02-05T00:00:00.000Z',
  },
  'analytics.sites_all_time_revenue': {
    site_ids: [SITE],
    from: '2024-01-01T00:00:00.000Z',
    to: '2024-02-05T00:00:00.000Z',
  },
}

describe('operation parameters resolve from the operation id alone', () => {
  it('leaves no operation with an unbound or an unused parameter', () => {
    // One UTC day: aligned to every boundary in the registry and inside every
    // span cap, including the recent-visitor pair's 24 hours.
    const range = { from: '2024-02-01T00:00:00.000Z', to: '2024-02-02T00:00:00.000Z' }

    for (const operation of QUERY_OPERATIONS.values()) {
      if (operation.id === 'health.clickhouse_roundtrip') continue
      const listed = MULTI_SITE[operation.id]
      if (listed !== undefined) {
        expect(() => operation.bindParams(listed), operation.id).not.toThrow()
        // And the single-site shape the loop below would have sent is refused,
        // which is what keeps "site scope" a real constraint on this pair rather
        // than a naming convention.
        expect(
          () =>
            operation.bindParams({
              site_id: SITE,
              from: '2024-01-01T00:00:00.000Z',
              to: '2024-02-05T00:00:00.000Z',
            }),
          operation.id,
        ).toThrow()
        continue
      }

      const subject = SUBJECT_ONLY[operation.id]
      if (subject !== undefined) {
        // No range, no zone, no import — the site plus the operation's subject.
        expect(
          () => operation.bindParams({ site_id: SITE, ...subject }),
          operation.id,
        ).not.toThrow()
        continue
      }

      for (const pointer of [null, POINTER]) {
        for (const timezone of ['UTC', 'America/New_York']) {
          const scoped = {
            site_id: SITE,
            ...range,
            ...(EXTRAS[operation.id] ?? {}),
            ...operationParamsFor(operation.id, pointer, timezone),
          }
          // `limit` is the one parameter the helper cannot know about, so it is
          // added exactly where the statement declares it.
          const withLimit = operation.sql.includes('{limit:UInt32}')
            ? { ...scoped, limit: 10 }
            : scoped
          // The filtered family's subject IS its filter set (ADR-0075), and the
          // set must be non-empty: these operations refuse an empty one on
          // purpose, so that an unfiltered read cannot be routed down the raw
          // path (D-F4). Every filtered statement binds every dimension, so one
          // clause is enough to exercise the whole block.
          const params = operation.id.startsWith('analytics.filtered_')
            ? {
                ...withLimit,
                filters: [{ dimension: 'country', operator: 'eq', values: ['US'] }],
              }
            : withLimit
          const label = `${operation.id} tz=${timezone} import=${pointer === null ? 'none' : 'published'}`
          expect(() => operation.bindParams(params), label).not.toThrow()
        }
      }
    }
  })

  it('binds the call shapes the ClickHouse-gated suites use', () => {
    // The exact (operation, range-alignment, zone) combinations
    // `query-gateway-rollups.test.ts` and `clickhouse-imported-read.test.ts`
    // exercise. Those suites cannot run without a server; this cannot prove what
    // they *answer*, but it does prove they will get past binding.
    const RANGES = {
      minute: { from: '2024-02-01T00:05:00.000Z', to: '2024-02-01T06:05:00.000Z' },
      hour: { from: '2024-02-01T05:00:00.000Z', to: '2024-02-03T05:00:00.000Z' },
      day: { from: '2024-02-01T00:00:00.000Z', to: '2024-02-03T00:00:00.000Z' },
    } as const

    const shapes: readonly [string, keyof typeof RANGES, string, Record<string, unknown>][] = [
      ['analytics.overview_hour', 'hour', 'UTC', {}],
      ['analytics.overview_day', 'day', 'America/New_York', {}],
      ['analytics.pages_hour', 'hour', 'UTC', { limit: 10 }],
      ['analytics.performance_hour', 'hour', 'UTC', { limit: 10 }],
      ['analytics.timeseries_minute', 'minute', 'Europe/Istanbul', {}],
      ['analytics.timeseries_hour', 'hour', 'Europe/Istanbul', {}],
      ['analytics.timeseries_day', 'hour', 'Europe/Istanbul', {}],
      ['analytics.timeseries_day', 'hour', 'America/New_York', {}],
      ['analytics.timeseries_day_utc', 'day', 'UTC', {}],
      ['analytics.timeseries_week', 'hour', 'America/Sao_Paulo', {}],
      ['analytics.timeseries_week_utc', 'day', 'UTC', {}],
      ['analytics.imported_pages', 'hour', 'America/New_York', { limit: 50 }],
      ['analytics.imported_geography', 'day', 'UTC', { limit: 10 }],
      ['analytics.imported_custom_events', 'day', 'UTC', { limit: 10 }],
    ]

    for (const [id, alignment, timezone, extra] of shapes) {
      for (const pointer of [null, POINTER]) {
        const params = {
          site_id: SITE,
          ...RANGES[alignment],
          ...extra,
          ...operationParamsFor(id, pointer, timezone),
        }
        expect(() => findOperation(id)?.bindParams(params), `${id} ${timezone}`).not.toThrow()
      }
    }
  })
})
