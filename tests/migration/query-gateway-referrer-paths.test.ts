import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import { migrateClickHouse } from '@openanalytics/clickhouse'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpClickHouseReader } from '../../apps/query-gateway/src/clickhouse-http.ts'
import { findOperation } from '../../apps/query-gateway/src/operations.ts'
import type { QueryParameterValue } from '../../apps/query-gateway/src/clickhouse.ts'

/**
 * The referring-pages operations against a real, migrated ClickHouse.
 *
 * What the unit suite cannot prove: that the statement parses and runs (an
 * alias in WHERE, a bound `LIMIT … BY`, the regex), that the query string and
 * fragment are cut before grouping so two links to one page are one row, that
 * the bare origin is dropped, and that one site never reads another's paths.
 *
 * Skipped without TEST_CLICKHOUSE_URL; CI always provides one.
 */

const URL_ = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''

const describeIfClickHouse = URL_ ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

const RANGE = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' }

describeIfClickHouse('referring pages over events_raw', () => {
  const url = URL_ as string
  const database = `refpaths_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>

  const reader = createHttpClickHouseReader({
    url,
    database,
    username: USERNAME,
    password: PASSWORD,
  })

  const run = async (operationId: string, input: Record<string, unknown>) => {
    const operation = findOperation(operationId)
    if (!operation) throw new Error(`no such operation ${operationId}`)
    const parameters = operation.bindParams(input) as Record<string, QueryParameterValue>
    const result = await reader.query({
      sql: operation.sql,
      parameters,
      signal: new AbortController().signal,
      queryId: randomUUID(),
      settings: { max_execution_time: 20 },
    })
    return [...result.rows] as Record<string, unknown>[]
  }

  const siteA = randomUUID()
  const siteB = randomUUID()

  let seq = 0
  const view = (
    site: string,
    referrer_domain: string,
    referrer_path: string,
    anonymous_id: string,
    type = 'page_view',
  ) => ({
    schema_version: 1,
    site_id: site,
    event_id: randomUUID(),
    batch_id: 'b1',
    type,
    name: '',
    occurred_at: `2026-07-02 10:00:${String(seq++ % 60).padStart(2, '0')}.000`,
    billable: 1,
    anonymous_id,
    user_id: '',
    page_path: '/',
    referrer_domain,
    referrer_path,
    utm_source: '',
    utm_medium: '',
    utm_campaign: '',
    country: '',
    city: '',
    device_type: '',
    browser: '',
    os: '',
    properties: '{}',
  })

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
    await client.insert({
      table: 'events_raw',
      values: [
        // One page, reached through two different query strings and a fragment.
        view(siteA, 'lobste.rs', '/s/abc123/story?token=secret', 'v1'),
        view(siteA, 'lobste.rs', '/s/abc123/story?utm=x', 'v2'),
        view(siteA, 'lobste.rs', '/s/abc123/story#c_7', 'v3'),
        view(siteA, 'lobste.rs', '/t/privacy', 'v4'),
        // A query string after a newline: RE2's `.` stops at `\n` unless `(?s)`
        // is set, and without it the whole query string would be shown.
        view(siteA, 'lobste.rs', '/s/abc123/story?token=secret\nmore', 'v12'),
        // A matrix parameter: `;jsessionid=…` is cut like a query string.
        view(siteA, 'lobste.rs', '/t/privacy;jsessionid=0123456789ABCDEF', 'v13'),
        // The origin only, and no path at all: never a row.
        view(siteA, 'lobste.rs', '/', 'v5'),
        view(siteA, 'lobste.rs', '', 'v6'),
        // Not a page view: not counted.
        view(siteA, 'lobste.rs', '/s/zzz', 'v7', 'custom'),
        // A long path, truncated.
        view(siteA, 'github.com', `/${'a'.repeat(300)}`, 'v8'),
        view(siteA, 'github.com', '/org/repo', 'v9'),
        view(siteA, 'github.com', '/org/other', 'v10'),
        // An origin-only host.
        view(siteA, 'google.com', '/', 'v11'),
        // Another site's page under the same host.
        view(siteB, 'lobste.rs', '/s/other-site', 'w1'),
      ],
      format: 'JSONEachRow',
      clickhouse_settings: { insert_deduplication_token: 'refpaths-1' },
    })
    // Every ClickHouse migration runs first, which takes longer than the
    // default hook timeout on a cold server.
  }, 120_000)

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database}` })
    await client?.close()
  })

  it('groups on the path alone, without the query string or fragment', async () => {
    const rows = await run('analytics.referrer_paths', {
      site_id: siteA,
      ...RANGE,
      referrer_domains: ['lobste.rs'],
    })
    expect(
      rows.map((row) => [row['referrer_domain'], row['ref_path'], Number(row['visitors'])]),
    ).toEqual([
      ['lobste.rs', '/s/abc123/story', 4],
      ['lobste.rs', '/t/privacy', 2],
    ])
    for (const row of rows) {
      expect(String(row['ref_path'])).not.toMatch(/[?#;\n]|secret|jsessionid/)
    }
  })

  it('returns nothing for a host that sent only its origin', async () => {
    const rows = await run('analytics.referrer_paths', {
      site_id: siteA,
      ...RANGE,
      referrer_domains: ['google.com'],
    })
    expect(rows).toEqual([])
  })

  it('caps each host at the limit, truncates, and keeps the sites apart', async () => {
    const rows = await run('analytics.referrer_paths', {
      site_id: siteA,
      ...RANGE,
      referrer_domains: ['lobste.rs', 'github.com'],
      limit: 1,
    })
    const byHost = rows.map((row) => row['referrer_domain'])
    expect(byHost.sort()).toEqual(['github.com', 'lobste.rs'])
    for (const row of rows) {
      expect(String(row['ref_path']).length).toBeLessThanOrEqual(200)
      expect(String(row['ref_path'])).not.toContain('other-site')
    }

    const all = await run('analytics.referrer_paths', {
      site_id: siteA,
      ...RANGE,
      referrer_domains: ['github.com'],
    })
    expect(all).toHaveLength(3)
    expect(all.some((row) => String(row['ref_path']).length === 200)).toBe(true)
  })

  it('runs the filtered twin over the session facts', async () => {
    // No sessions were finalized for this site, so a filter selects none — the
    // point is that the statement runs and answers an honest empty list.
    const rows = await run('analytics.filtered_referrer_paths', {
      site_id: siteA,
      ...RANGE,
      referrer_domains: ['lobste.rs'],
      filters: [{ dimension: 'country', operator: 'eq', values: ['US'] }],
    })
    expect(rows).toEqual([])
  })
})
