import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  loadServiceEnv,
  DEFAULT_TRACKER_SETTINGS,
  EMPTY_INGEST_EXCLUSIONS,
  type IngestExclusions,
} from '@openanalytics/domain'
import type { RealtimeCache } from '@openanalytics/redis'
import { InProcessRateLimiter } from '../../apps/api/src/http/rate-limit.ts'
import type { Auth } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `GET`/`PATCH /v1/sites/{site_id}/ingest-settings` — the writer ADR-0064 F4
 * asked for.
 *
 * Two invariants, and the second is the reason this route exists at all:
 *
 * 1. **Server-side authorization**, the same shape as every sibling: a
 *    non-member is told the site does not exist, a viewer is refused, and the
 *    refusal lands *before* any repository call — which the call log proves and
 *    a status code alone cannot.
 * 2. **Every accepted write bumps `config_version`.** Without it the settings
 *    row would change and every browser would keep running the old
 *    configuration until something unrelated moved the version (ADR-0008), so
 *    the write would appear to work and change nothing anybody could see.
 */

const SPEC_PATH = fileURLToPath(
  new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url),
)

async function spec(): Promise<string> {
  return readFile(SPEC_PATH, 'utf8')
}

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const OWNER = 'u-owner'
const ADMIN = 'u-admin'
const VIEWER = 'u-viewer'
const STRANGER = 'u-stranger'

const memberships = new Map<string, { role: string; isBillingOwner: boolean }>([
  [OWNER, { role: 'owner', isBillingOwner: true }],
  [ADMIN, { role: 'admin', isBillingOwner: false }],
  [VIEWER, { role: 'viewer', isBillingOwner: false }],
])

/** The stored row, as the repository would answer it. */
const stored = {
  configVersion: 3,
  settings: { ...DEFAULT_TRACKER_SETTINGS, attributedRevenue: false },
  exclusions: EMPTY_INGEST_EXCLUSIONS as IngestExclusions,
}

/** Every repository call the routes can make, so "refused before any write" is
 * provable rather than assumed. */
const calls = { reads: [] as string[], writes: [] as Record<string, unknown>[] }

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async (_db: unknown, params: { siteId: string; userId: string }) =>
      memberships.get(params.userId) ?? null,
    readSiteIngestSettings: async (_db: unknown, siteId: string) => {
      calls.reads.push(siteId)
      return {
        configVersion: stored.configVersion,
        settings: { ...stored.settings },
        exclusions: stored.exclusions,
      }
    },
    upsertSiteIngestSettings: async (_db: unknown, input: Record<string, unknown>) => {
      calls.writes.push(input)
      // The real repository bumps the version in the same transaction as the
      // write; the stub does the same so the response can be asserted on.
      stored.configVersion += 1
      if (input['attributedRevenue'] !== undefined) {
        stored.settings = {
          ...stored.settings,
          attributedRevenue: input['attributedRevenue'] as boolean,
        }
      }
      if (input['exclusions'] !== undefined) {
        stored.exclusions = input['exclusions'] as IngestExclusions
      }
      if (input['timezone'] !== undefined) {
        stored.settings = { ...stored.settings, timezone: input['timezone'] as string }
      }
      return { configVersion: stored.configVersion }
    },
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')

const auth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get('x-test-user')
      if (id === null) return null
      return {
        user: {
          id,
          email: `${id}@example.test`,
          emailVerified: true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        session: { createdAt: new Date('2026-01-01T00:00:00.000Z') },
      }
    },
  },
  handler: async () => new Response(null),
} as unknown as Auth

const { logger } = createCapturedLogger()
const appWith = (cache?: Pick<RealtimeCache, 'readGeoResolvedAt'>) =>
  createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv('api', testEnv()),
    auth,
    db: {} as Database,
    ...(cache === undefined
      ? {}
      : {
          realtime: {
            cache: cache as RealtimeCache,
            rateLimiter: new InProcessRateLimiter({ requestsPerMinute: 60, burst: 120 }),
          },
        }),
  })
const app = appWith()

const send = (method: string, user?: string, body?: unknown, target = app) =>
  target.fetch(
    new Request(`http://api.test/v1/sites/${SITE}/ingest-settings`, {
      method,
      headers: {
        ...(user === undefined ? {} : { 'x-test-user': user }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

beforeEach(() => {
  calls.reads = []
  calls.writes = []
  stored.configVersion = 3
  stored.settings = { ...DEFAULT_TRACKER_SETTINGS, attributedRevenue: false }
  stored.exclusions = EMPTY_INGEST_EXCLUSIONS
})

describe('OpenAPI documents the ingest-settings surface', () => {
  it('declares both operations, once each, at their own path item', async () => {
    const text = await spec()
    expect(text).toContain('/v1/sites/{site_id}/ingest-settings:')
    for (const operationId of ['getSiteIngestSettings', 'updateSiteIngestSettings']) {
      expect(text.split(`operationId: ${operationId}\n`).length - 1, operationId).toBe(1)
    }
  })

  it('keeps the routes out of the OAuth surface', async () => {
    // Session only, deliberately (ADR-0048): a settings toggle that changes what
    // every visitor's browser does is not something to hand to an agent on the
    // strength of a scope name. If a later change adds `oauthAccessToken` here it
    // also has to add a `GRANT_WRITE_ALLOWLIST` row, and this is the reminder.
    const text = await spec()
    const start = text.indexOf('/v1/sites/{site_id}/ingest-settings:')
    const block = text.slice(start, text.indexOf('/v1/sites/{site_id}/widgets:', start))
    expect(block).toContain('sessionCookie: []')
    expect(block).not.toContain('oauthAccessToken')
  })
})

describe('GET /v1/sites/{site_id}/ingest-settings', () => {
  it('answers an owner with the settings and the current config version', async () => {
    const response = await send('GET', OWNER)
    expect(response.status).toBe(200)

    const body = (await response.json()) as Record<string, unknown>
    expect(body['config_version']).toBe(3)
    expect(body['attributed_revenue']).toBe(false)
    expect(body['timezone']).toBe('UTC')
    expect(body['features']).toEqual({
      web_vitals: true,
      engagement: true,
      interactions: true,
      heartbeat: true,
    })
    expect(body['redact_query_keys']).toEqual([])
  })

  it('answers an admin too, and refuses a viewer', async () => {
    expect((await send('GET', ADMIN)).status).toBe(200)

    // `site:settings` is owner+admin. A viewer is refused, and the read that
    // would have answered them never happens.
    calls.reads = []
    const refused = await send('GET', VIEWER)
    expect(refused.status).toBe(403)
    expect(calls.reads).toEqual([])
  })

  it('tells a non-member the site does not exist', async () => {
    const response = await send('GET', STRANGER)
    expect(response.status).toBe(404)
    expect(calls.reads).toEqual([])
  })

  it('refuses an unauthenticated caller', async () => {
    const response = await send('GET')
    expect(response.status).toBe(401)
    expect(calls.reads).toEqual([])
  })
})

describe('PATCH /v1/sites/{site_id}/ingest-settings', () => {
  it('writes only what was sent, and bumps the config version', async () => {
    const response = await send('PATCH', OWNER, { attributed_revenue: true })
    expect(response.status).toBe(200)

    // One repository call, carrying one field: a patch that mentioned one flag
    // must not restate the rest of the row.
    expect(calls.writes).toHaveLength(1)
    expect(calls.writes[0]).toEqual({ siteId: SITE, attributedRevenue: true })

    const body = (await response.json()) as Record<string, unknown>
    expect(body['attributed_revenue']).toBe(true)
    // The bump is the half that makes the write visible to browsers at all.
    expect(body['config_version']).toBe(4)
  })

  it('refuses a viewer before writing anything', async () => {
    const response = await send('PATCH', VIEWER, { attributed_revenue: true })
    expect(response.status).toBe(403)
    expect(calls.writes).toEqual([])
  })

  it('tells a non-member the site does not exist, and writes nothing', async () => {
    const response = await send('PATCH', STRANGER, { attributed_revenue: true })
    expect(response.status).toBe(404)
    expect(calls.writes).toEqual([])
  })

  it('refuses an empty body rather than bumping for nothing', async () => {
    const response = await send('PATCH', OWNER, {})
    expect(response.status).toBe(400)
    expect(calls.writes).toEqual([])

    const body = (await response.json()) as { error?: { details?: Record<string, unknown> } }
    expect(JSON.stringify(body.error?.details)).toContain('required_one_of')
  })

  it('refuses an out-of-range heartbeat interval with a named field', async () => {
    // The gap `packages/domain/src/tracker-settings.ts` has recorded since M5:
    // "an HTTP writer must map this to 400 VALIDATION_FAILED. There is none
    // today." This is that writer, and this is the mapping.
    const response = await send('PATCH', OWNER, { heartbeat_interval_seconds: 300 })
    expect(response.status).toBe(400)
    expect(calls.writes).toEqual([])

    const body = (await response.json()) as { error?: { details?: Record<string, unknown> } }
    expect(JSON.stringify(body.error?.details)).toContain('heartbeat_interval_seconds')
  })

  it('accepts the whole family in one write', async () => {
    const response = await send('PATCH', ADMIN, {
      timezone: 'Asia/Baku',
      redact_query_keys: ['Token', 'token'],
      interaction_sampling: 0.25,
      heartbeat_interval_seconds: 30,
      features: { interactions: false },
      attributed_revenue: true,
    })
    expect(response.status).toBe(200)
    expect(calls.writes[0]).toEqual({
      siteId: SITE,
      timezone: 'Asia/Baku',
      redactQueryKeys: ['token'],
      interactionSampling: 0.25,
      heartbeatIntervalSeconds: 30,
      features: { interactions: false },
      attributedRevenue: true,
    })
  })
})

describe('exclusions on the ingest-settings surface', () => {
  const OFFICE_LISTS = {
    ip_ranges: ['203.0.113.7', '10.0.0.0/8'],
    paths: ['/admin/*'],
    countries: ['de'],
    hostnames: ['Staging.Example.com'],
  }

  it('reads an empty set for a site that excluded nothing', async () => {
    const body = (await (await send('GET', OWNER)).json()) as Record<string, unknown>
    expect(body['exclusions']).toEqual({ ip_ranges: [], paths: [], countries: [], hostnames: [] })
  })

  it('stores the lists normalised, replaces them whole, and bumps the version', async () => {
    const response = await send('PATCH', ADMIN, { exclusions: OFFICE_LISTS })
    expect(response.status).toBe(200)
    expect(calls.writes[0]).toEqual({
      siteId: SITE,
      exclusions: {
        ipRanges: ['203.0.113.7/32', '10.0.0.0/8'],
        paths: ['/admin/*'],
        countries: ['DE'],
        hostnames: ['staging.example.com'],
      },
    })
    const body = (await response.json()) as Record<string, unknown>
    expect(body['config_version']).toBe(4)
    expect(body['exclusions']).toEqual({
      ip_ranges: ['203.0.113.7/32', '10.0.0.0/8'],
      paths: ['/admin/*'],
      countries: ['DE'],
      hostnames: ['staging.example.com'],
    })

    // A second write replaces the set: what it does not list is gone.
    const replaced = await send('PATCH', OWNER, {
      exclusions: { ip_ranges: [], paths: ['/preview'], countries: [], hostnames: [] },
    })
    expect(((await replaced.json()) as Record<string, unknown>)['exclusions']).toEqual({
      ip_ranges: [],
      paths: ['/preview'],
      countries: [],
      hostnames: [],
    })
  })

  it('leaves all four lists alone on a PATCH that does not name exclusions', async () => {
    const stored = await send('PATCH', OWNER, { exclusions: OFFICE_LISTS })
    expect(stored.status).toBe(200)
    const lists = ((await stored.json()) as Record<string, unknown>)['exclusions']
    expect(lists).toEqual({
      ip_ranges: ['203.0.113.7/32', '10.0.0.0/8'],
      paths: ['/admin/*'],
      countries: ['DE'],
      hostnames: ['staging.example.com'],
    })

    const timezone = await send('PATCH', ADMIN, { timezone: 'Europe/Berlin' })
    expect(timezone.status).toBe(200)
    expect(((await timezone.json()) as Record<string, unknown>)['exclusions']).toEqual(lists)

    const revenue = await send('PATCH', OWNER, { attributed_revenue: true })
    expect(revenue.status).toBe(200)
    expect(((await revenue.json()) as Record<string, unknown>)['exclusions']).toEqual(lists)

    // Neither partial write handed the repository an `exclusions` member — not
    // even an empty one, which would clear the lists.
    expect(calls.writes.slice(1).map((write) => Object.hasOwn(write, 'exclusions'))).toEqual([
      false,
      false,
    ])
    const read = await send('GET', OWNER)
    expect(((await read.json()) as Record<string, unknown>)['exclusions']).toEqual(lists)
  })

  it('refuses a viewer before writing anything', async () => {
    const response = await send('PATCH', VIEWER, { exclusions: OFFICE_LISTS })
    expect(response.status).toBe(403)
    expect(calls.writes).toEqual([])
  })

  it('names the list and the entry that failed, per field', async () => {
    const response = await send('PATCH', OWNER, {
      exclusions: {
        ip_ranges: ['203.0.113.7', 'my office'],
        paths: ['admin'],
        countries: ['Germany'],
        hostnames: ['https://staging.example.com'],
      },
    })
    expect(response.status).toBe(400)
    expect(calls.writes).toEqual([])
    const body = (await response.json()) as { error?: { details?: { issues?: unknown } } }
    const text = JSON.stringify(body.error?.details)
    for (const field of [
      'exclusions.ip_ranges.1',
      'exclusions.paths.0',
      'exclusions.countries.0',
      'exclusions.hostnames.0',
    ]) {
      expect(text).toContain(field)
    }
    // The value is never echoed back.
    expect(text).not.toContain('my office')
  })

  it('refuses a partial set, because a write replaces all four lists', async () => {
    const response = await send('PATCH', OWNER, { exclusions: { ip_ranges: ['10.0.0.1'] } })
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain('exclusions.paths')
    expect(calls.writes).toEqual([])
  })

  it('refuses a list over its limit', async () => {
    const response = await send('PATCH', OWNER, {
      exclusions: {
        ip_ranges: [],
        paths: [],
        countries: [],
        hostnames: Array.from({ length: 21 }, (_, index) => `h${index}.example.com`),
      },
    })
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain('too_many')
  })

  it('says whether a country exclusion can match, without failing the read', async () => {
    // No realtime store: unknown, not false.
    expect(
      ((await (await send('GET', OWNER)).json()) as Record<string, unknown>)[
        'exclusions_country_active'
      ],
    ).toBeNull()

    const resolving = appWith({ readGeoResolvedAt: async () => '2026-11-16T10:00:00.000Z' })
    expect(
      ((await (await send('GET', OWNER, undefined, resolving)).json()) as Record<string, unknown>)[
        'exclusions_country_active'
      ],
    ).toBe(true)

    const silent = appWith({ readGeoResolvedAt: async () => null })
    expect(
      ((await (await send('GET', OWNER, undefined, silent)).json()) as Record<string, unknown>)[
        'exclusions_country_active'
      ],
    ).toBe(false)

    const down = appWith({ readGeoResolvedAt: () => Promise.reject(new Error('valkey down')) })
    const answered = await send('GET', OWNER, undefined, down)
    expect(answered.status).toBe(200)
    expect(
      ((await answered.json()) as Record<string, unknown>)['exclusions_country_active'],
    ).toBeNull()
  })

  it('documents exclusions in the contract and keeps them out of the tracker config', async () => {
    const text = await spec()
    expect(text).toContain('IngestExclusions:')
    expect(text).toContain('exclusions_country_active:')
    const start = text.indexOf('\n    TrackerConfig:\n')
    expect(start).toBeGreaterThan(0)
    const rest = text.slice(start + 1)
    const block = rest.slice(0, rest.slice(1).search(/\n {4}[A-Za-z]+:\n/) + 1)
    expect(block).toContain('config_version')
    expect(block).not.toContain('exclusions')
  })
})
