import {
  loadServiceEnv,
  DELETION_POSTGRES_TARGETS,
  SITE_DELETION_TARGETS,
} from '@openanalytics/domain'
import { widgetFixture } from '@openanalytics/contracts'
import type { Auth } from '@openanalytics/auth'
import type { Database, WidgetRecord } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The widget CRUD surface (ADR-0045, D13; migration 0048) — its authorization
 * matrix, its validation and the two derived fields it returns.
 *
 * Everything here is a rule that lives at the route and nowhere else, which is
 * why none of it needs a database:
 *
 * - **Reads are membership-only, mutations are `site:settings`.** Knowing what a
 *   site publishes is not a privilege (a viewer who cannot see the widget list
 *   cannot tell that a number is on a public page), but changing what it
 *   publishes is. A refusal must land *before* any repository call, which is why
 *   every repository function is recorded rather than merely stubbed.
 * - **The origin allowlist is validated as whole strings.** `cors.ts`'s argument,
 *   restated at a second allowlist: `https://app.getopen.so` and
 *   `https://evil-app.getopen.so` are different origins, and the test below pins
 *   that they are stored as two distinct entries rather than collapsed by any
 *   suffix rule.
 * - **`surface` is immutable and `DELETE` is not idempotent** (ADR-0045, D2 and
 *   D13) — the two places this surface deliberately differs from the funnels
 *   CRUD it otherwise mirrors.
 * - **`embed_url` is built from configured typed config, never from `c.req.url`**
 *   (ADR-0045, D13; the `b54c03d` lesson: behind Caddy the request URL carries
 *   the internal `http://` scheme).
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const WIDGET = 'w3f9xk21qm70c4bd'
const OWNER = 'u-owner'
const ADMIN = 'u-admin'
const VIEWER = 'u-viewer'
const STRANGER = 'u-stranger'

/** The api's own public origin for this suite, so `embed_url` has something to
 * be built from that is provably not the request URL (`http://api.test`). */
const API_BASE = 'https://api.example.test'

const memberships = new Map<string, { role: string; isBillingOwner: boolean }>([
  [OWNER, { role: 'owner', isBillingOwner: true }],
  [ADMIN, { role: 'admin', isBillingOwner: false }],
  [VIEWER, { role: 'viewer', isBillingOwner: false }],
])

/**
 * The stored row behind every request here, written as the repository would
 * return it for `widgetFixture` — same id, same surface, same parameters. That
 * is what lets the round-trip test at the bottom compare the whole response
 * against the published fixture rather than against a copy of itself.
 */
const row: WidgetRecord = {
  id: WIDGET,
  siteId: SITE,
  surface: 'pages',
  title: 'Most read this week',
  range: '7d',
  limit: 5,
  allowedOrigins: ['https://shop.example.com'],
  enabled: true,
  createdByUserId: widgetFixture.created_by_user_id,
  createdAt: new Date('2026-08-07T09:12:00.000Z'),
  updatedAt: new Date('2026-08-07T09:12:00.000Z'),
}

/** Every repository call the routes can make, recorded so "refused before any
 * write" is provable rather than assumed. */
const calls = {
  list: [] as string[],
  get: [] as { id: string; siteId: string }[],
  count: [] as string[],
  create: [] as Record<string, unknown>[],
  update: [] as Record<string, unknown>[],
  remove: [] as { id: string; siteId: string }[],
}
const results = {
  count: 0,
  get: true,
  update: true,
  remove: true,
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async (_db: unknown, params: { siteId: string; userId: string }) =>
      memberships.get(params.userId) ?? null,
    listWidgets: async (_db: unknown, siteId: string) => {
      calls.list.push(siteId)
      return [row]
    },
    getWidget: async (_db: unknown, input: { id: string; siteId: string }) => {
      calls.get.push({ id: input.id, siteId: input.siteId })
      return results.get ? { ...row, id: input.id } : null
    },
    countWidgets: async (_db: unknown, siteId: string) => {
      calls.count.push(siteId)
      return results.count
    },
    createWidget: async (_db: unknown, input: Record<string, unknown>) => {
      calls.create.push(input)
      return {
        ...row,
        surface: input['surface'],
        title: input['title'] ?? null,
        range: input['range'] ?? null,
        limit: input['limit'] ?? null,
        allowedOrigins: input['allowedOrigins'] ?? [],
        enabled: input['enabled'] ?? true,
      } as WidgetRecord
    },
    updateWidget: async (_db: unknown, input: Record<string, unknown>) => {
      calls.update.push(input)
      return results.update ? row : null
    },
    deleteWidget: async (_db: unknown, input: { id: string; siteId: string }) => {
      calls.remove.push({ id: input.id, siteId: input.siteId })
      return { deleted: results.remove }
    },
  }
})

// After `vi.mock`, so the app is built against the mocked repository.
const { createApp } = await import('../../apps/api/src/app.ts')

/** The caller is chosen per request with a test header, so one app instance can
 * exercise every role. */
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
const app = createApp({
  service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
  logger,
  env: loadServiceEnv('api', testEnv({ AUTH_BASE_URL: API_BASE })),
  auth,
  db: {} as Database,
})

const COLLECTION = `/v1/sites/${SITE}/widgets`
const ITEM = `${COLLECTION}/${WIDGET}`

const send = (method: string, path: string, user?: string, body?: unknown) =>
  app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        ...(user === undefined ? {} : { 'x-test-user': user }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

const CREATE_BODY = {
  surface: 'pages',
  title: 'Most read this week',
  range: '7d',
  limit: 5,
  allowed_origins: ['https://shop.example.com'],
}

async function errorOf(res: Response): Promise<Record<string, unknown>> {
  const body = (await res.json()) as { error: Record<string, unknown> }
  return body.error
}

beforeEach(() => {
  calls.list = []
  calls.get = []
  calls.count = []
  calls.create = []
  calls.update = []
  calls.remove = []
  results.count = 0
  results.get = true
  results.update = true
  results.remove = true
})

describe('widget CRUD authorization', () => {
  it('lets every member read the list and one widget', async () => {
    for (const user of [OWNER, ADMIN, VIEWER]) {
      const list = await send('GET', COLLECTION, user)
      expect(list.status, `${user} list`).toBe(200)
      expect((await list.json()) as { items: unknown[] }).toHaveProperty('items')

      const one = await send('GET', ITEM, user)
      expect(one.status, `${user} item`).toBe(200)
    }
  })

  it('refuses an unauthenticated caller before it looks at the site', async () => {
    const res = await send('GET', COLLECTION)
    expect(res.status).toBe(401)
    expect(calls.list).toEqual([])
  })

  it('tells a non-member the site does not exist, on every verb', async () => {
    const cases: [string, string, unknown?][] = [
      ['GET', COLLECTION],
      ['GET', ITEM],
      ['POST', COLLECTION, CREATE_BODY],
      ['PATCH', ITEM, { title: 'x' }],
      ['DELETE', ITEM],
    ]
    for (const [method, path, body] of cases) {
      const res = await send(method, path, STRANGER, body)
      expect(res.status, `${method} ${path}`).toBe(404)
      expect((await errorOf(res))['code']).toBe('SITE_NOT_FOUND')
    }
    expect(calls.create).toEqual([])
    expect(calls.update).toEqual([])
    expect(calls.remove).toEqual([])
  })

  it('refuses a viewer every mutation, before any repository call', async () => {
    const cases: [string, string, unknown?][] = [
      ['POST', COLLECTION, CREATE_BODY],
      ['PATCH', ITEM, { title: 'x' }],
      ['DELETE', ITEM],
    ]
    for (const [method, path, body] of cases) {
      const res = await send(method, path, VIEWER, body)
      expect(res.status, `${method} ${path}`).toBe(403)
    }
    expect(calls.create).toEqual([])
    expect(calls.update).toEqual([])
    expect(calls.remove).toEqual([])
  })

  it('lets an owner and an admin mutate', async () => {
    for (const user of [OWNER, ADMIN]) {
      expect((await send('POST', COLLECTION, user, CREATE_BODY)).status, `${user} create`).toBe(201)
      expect((await send('PATCH', ITEM, user, { title: 'x' })).status, `${user} update`).toBe(200)
      expect((await send('DELETE', ITEM, user)).status, `${user} delete`).toBe(204)
    }
  })

  it('answers 404 for a widget id that is not on this site', async () => {
    results.get = false
    results.update = false
    results.remove = false
    for (const [method, body] of [
      ['GET', undefined],
      ['PATCH', { title: 'x' }],
      ['DELETE', undefined],
    ] as [string, unknown][]) {
      const res = await send(method, ITEM, OWNER, body)
      expect(res.status, method).toBe(404)
      expect((await errorOf(res))['code']).toBe('NOT_FOUND')
    }
  })
})

describe('the widget budget', () => {
  it('refuses the fifty-first widget with the rule budget’s own shape', async () => {
    results.count = 50
    const res = await send('POST', COLLECTION, OWNER, CREATE_BODY)
    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error['code']).toBe('VALIDATION_FAILED')
    expect((error['details'] as Record<string, unknown>)['reason']).toBe('widget_budget_exceeded')
    // Counted before the write, and the write never happened.
    expect(calls.count).toEqual([SITE])
    expect(calls.create).toEqual([])
  })

  it('admits the fiftieth', async () => {
    results.count = 49
    expect((await send('POST', COLLECTION, OWNER, CREATE_BODY)).status).toBe(201)
  })
})

describe('allowed_origins', () => {
  const create = (origins: unknown) =>
    send('POST', COLLECTION, OWNER, { ...CREATE_BODY, allowed_origins: origins })

  it('accepts an empty list — "nowhere yet" is a choice, not an omission', async () => {
    const res = await create([])
    expect(res.status).toBe(201)
    expect(calls.create[0]?.['allowedOrigins']).toEqual([])
  })

  it('accepts the wildcard alone', async () => {
    const res = await create(['*'])
    expect(res.status).toBe(201)
    expect(calls.create[0]?.['allowedOrigins']).toEqual(['*'])
  })

  it('refuses the wildcard beside anything else', async () => {
    const res = await create(['*', 'https://shop.example.com'])
    expect(res.status).toBe(400)
    expect((await errorOf(res))['code']).toBe('VALIDATION_FAILED')
    expect(calls.create).toEqual([])
  })

  it('stores a suffix lookalike as its own entry rather than collapsing it', async () => {
    // The reason this allowlist compares whole strings: a suffix test would
    // accept `evil-app.getopen.so` for a list naming `app.getopen.so`.
    const origins = ['https://app.getopen.so', 'https://evil-app.getopen.so']
    const res = await create(origins)
    expect(res.status).toBe(201)
    expect(calls.create[0]?.['allowedOrigins']).toEqual(origins)
  })

  it('refuses anything that is not an exactly serialized origin', async () => {
    const bad = [
      'https://shop.example.com/', // a trailing slash is a URL, not an origin
      'https://shop.example.com/embed', // a path
      'HTTPS://shop.example.com', // not lowercased
      'shop.example.com', // no scheme
      'ftp://shop.example.com', // not an http(s) origin
      'https://shop.example.com:443', // the default port is never sent by a browser
      'https://shop.example.com?a=1', // a query
      '*.example.com', // the wildcard is not a pattern
      '',
    ]
    for (const origin of bad) {
      const res = await create([origin])
      expect(res.status, JSON.stringify(origin)).toBe(400)
      expect((await errorOf(res))['code']).toBe('VALIDATION_FAILED')
    }
    expect(calls.create).toEqual([])
  })

  it('accepts an explicit non-default port', async () => {
    const res = await create(['http://localhost:3000'])
    expect(res.status).toBe(201)
  })

  it('refuses duplicates and a list longer than twenty', async () => {
    const dup = await create(['https://a.example.com', 'https://a.example.com'])
    expect(dup.status).toBe(400)

    const many = Array.from({ length: 21 }, (_, i) => `https://a${i}.example.com`)
    expect((await create(many)).status).toBe(400)
    expect((await create(many.slice(0, 20))).status).toBe(201)
  })
})

describe('surface, range and limit', () => {
  it('refuses a PATCH that carries surface, before any write', async () => {
    const res = await send('PATCH', ITEM, OWNER, { surface: 'pages' })
    expect(res.status).toBe(400)
    expect((await errorOf(res))['code']).toBe('VALIDATION_FAILED')
    expect(calls.update).toEqual([])
  })

  it('refuses an empty PATCH body', async () => {
    const res = await send('PATCH', ITEM, OWNER, {})
    expect(res.status).toBe(400)
    expect(calls.update).toEqual([])
  })

  it('creates a realtime widget with no range and no limit', async () => {
    const res = await send('POST', COLLECTION, OWNER, {
      surface: 'realtime',
      title: 'Reading right now',
      allowed_origins: [],
    })
    expect(res.status).toBe(201)
    expect(calls.create[0]).toMatchObject({ surface: 'realtime', range: null, limit: null })
    const body = (await res.json()) as Record<string, unknown>
    expect(body['range']).toBeNull()
    expect(body['limit']).toBeNull()
  })

  it('refuses a range or a limit on a realtime widget', async () => {
    const withRange = await send('POST', COLLECTION, OWNER, {
      surface: 'realtime',
      range: '7d',
      allowed_origins: [],
    })
    expect(withRange.status).toBe(400)

    const withLimit = await send('POST', COLLECTION, OWNER, {
      surface: 'realtime',
      limit: 5,
      allowed_origins: [],
    })
    expect(withLimit.status).toBe(400)
    expect(calls.create).toEqual([])
  })

  it('requires a range on every historical surface, from the nine keys only', async () => {
    const missing = await send('POST', COLLECTION, OWNER, {
      surface: 'overview',
      allowed_origins: [],
    })
    expect(missing.status).toBe(400)

    const invented = await send('POST', COLLECTION, OWNER, {
      surface: 'overview',
      range: '14d',
      allowed_origins: [],
    })
    expect(invented.status).toBe(400)

    for (const range of ['today', 'yesterday', '24h', '7d', '30d', '90d', '6mo', '12mo', 'all']) {
      const res = await send('POST', COLLECTION, OWNER, {
        surface: 'overview',
        range,
        allowed_origins: [],
      })
      expect(res.status, range).toBe(201)
    }
  })

  it('accepts limit only on the four breakdown surfaces', async () => {
    for (const surface of ['pages', 'sources', 'devices', 'geography']) {
      const res = await send('POST', COLLECTION, OWNER, {
        surface,
        range: '7d',
        limit: 5,
        allowed_origins: [],
      })
      expect(res.status, surface).toBe(201)
    }
    for (const surface of ['overview', 'timeseries', 'sessions']) {
      const res = await send('POST', COLLECTION, OWNER, {
        surface,
        range: '7d',
        limit: 5,
        allowed_origins: [],
      })
      expect(res.status, surface).toBe(400)
    }
  })

  it('defaults a breakdown widget to ten rows and bounds the value at 1..50', async () => {
    const defaulted = await send('POST', COLLECTION, OWNER, {
      surface: 'pages',
      range: '7d',
      allowed_origins: [],
    })
    expect(defaulted.status).toBe(201)
    expect(calls.create[0]?.['limit']).toBe(10)

    for (const limit of [0, 51, -1, 1.5]) {
      const res = await send('POST', COLLECTION, OWNER, {
        surface: 'pages',
        range: '7d',
        limit,
        allowed_origins: [],
      })
      expect(res.status, String(limit)).toBe(400)
    }
  })

  it('leaves limit null on a non-breakdown surface', async () => {
    const res = await send('POST', COLLECTION, OWNER, {
      surface: 'timeseries',
      range: '30d',
      allowed_origins: [],
    })
    expect(res.status).toBe(201)
    expect(calls.create[0]?.['limit']).toBeNull()
  })

  it('refuses a title longer than the contract allows', async () => {
    const res = await send('POST', COLLECTION, OWNER, {
      ...CREATE_BODY,
      title: 'x'.repeat(81),
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE is a revocation, not a state', () => {
  it('answers 404 on a repeat rather than 204', async () => {
    expect((await send('DELETE', ITEM, OWNER)).status).toBe(204)
    results.remove = false
    const second = await send('DELETE', ITEM, OWNER)
    expect(second.status).toBe(404)
    expect((await errorOf(second))['code']).toBe('NOT_FOUND')
  })
})

describe('the embed fields', () => {
  it('builds embed_url from configured typed config, never from the request URL', async () => {
    const res = await send('GET', ITEM, OWNER)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['embed_url']).toBe(`${API_BASE}/embed/${WIDGET}`)
    // The request was made to `http://api.test`; behind Caddy that is the
    // internal scheme, and it must not appear in a snippet a customer pastes.
    expect(String(body['embed_url'])).not.toContain('api.test')
    expect(String(body['embed_snippet'])).toContain(`src="${API_BASE}/embed/${WIDGET}"`)
    expect(String(body['embed_snippet'])).toMatch(/^<iframe /u)
  })

  it('escapes an owner-authored title inside the snippet attribute', async () => {
    results.get = true
    const res = await send('POST', COLLECTION, OWNER, {
      ...CREATE_BODY,
      title: 'Ann "Bo" & <b>co</b>',
    })
    const body = (await res.json()) as Record<string, unknown>
    const snippet = String(body['embed_snippet'])
    expect(snippet).not.toContain('<b>')
    expect(snippet).toContain('&quot;')
    expect(snippet).toContain('&amp;')
  })

  it('returns exactly the fields the Widget schema requires', async () => {
    const res = await send('GET', ITEM, OWNER)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(
      [
        'id',
        'surface',
        'title',
        'range',
        'limit',
        'allowed_origins',
        'enabled',
        'embed_url',
        'embed_snippet',
        'created_by_user_id',
        'created_at',
        'updated_at',
      ].sort(),
    )
  })
})

describe('the published fixture is what the route actually returns', () => {
  /**
   * `widgetFixture` is what a frontend builds against before this route exists,
   * so a snippet the mock shows and the server never produces is a copy button
   * that ships wrong. The fixture's `embed_url` is on `api.getopen.so`, so the
   * app is rebuilt with that as its configured origin and the whole body is
   * compared — the `<iframe>` attributes included, byte for byte, because
   * ADR-0045 D13's reason for returning the snippet at all is that the dashboard
   * must not be a second place where they are decided.
   */
  it('reproduces widgetFixture byte for byte from the stored row', async () => {
    const fixtureApp = createApp({
      service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
      logger,
      env: loadServiceEnv('api', testEnv({ AUTH_BASE_URL: 'https://api.getopen.so' })),
      auth,
      db: {} as Database,
    })
    const res = await fixtureApp.fetch(
      new Request(`http://api.test${COLLECTION}/${widgetFixture.id}`, {
        headers: { 'x-test-user': OWNER },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(widgetFixture)
  })
})

describe('the deletion registry, at 64 after migration 0030 added the property breakdowns', () => {
  /**
   * Pinned here as well as in the migration suite because that suite needs a
   * database and therefore only runs in CI: a widget table that is not a
   * deletion target is a site's public embed configuration surviving the site
   * (ADR-0039 recorded the same trap).
   */
  it('names the widget table as a Postgres target', () => {
    expect(DELETION_POSTGRES_TARGETS).toContain('widgets')
    // 64, not 65: `billing_transfer_offers` is registered by the hosted surface
    // (`CLOUD_DELETION_EXTENSION`), so what this pins is the set a build with no
    // such surface erases. 62 became 72 when ADR-0079 booked the ten `*_15m`
    // rollups (ClickHouse migrations 0025/0026), 72 became 62 again when
    // migration 0029 dropped the ten hour tables, and 62 became 64 when 0030
    // added the two custom-event property breakdowns.
    expect(SITE_DELETION_TARGETS).toHaveLength(64)
    expect(SITE_DELETION_TARGETS.filter((t) => t.store === 'postgres')).toHaveLength(22)
    expect(SITE_DELETION_TARGETS).toContainEqual({ store: 'postgres', target: 'widgets' })
  })
})
