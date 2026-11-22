import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type {
  ChartNoteRecord,
  CreateChartNoteInput,
  Database,
  ListChartNotesInput,
  UpdateChartNoteInput,
} from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The chart notes surface (migration 0050).
 *
 * - **Reading is membership-only, writing is `site:settings`.** A viewer sees
 *   every note and changes none.
 * - **An OAuth grant reaches the list with `analytics:read` and the writes with
 *   `notes:write`**, and the role still decides: a viewer's grant writes
 *   nothing.
 * - **The author is a display name only.** No user id, no email, on any route.
 * - **The text is validated once, in the domain**: empty, 281 characters and
 *   control characters are 400s that never reach the database.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const NOTE = '0190a3b4-0000-7000-8000-000000000001'
const OWNER = 'u-owner'
const ADMIN = 'u-admin'
const VIEWER = 'u-viewer'
const STRANGER = 'u-stranger'

const memberships = new Map<string, { role: string; isBillingOwner: boolean }>([
  [OWNER, { role: 'owner', isBillingOwner: true }],
  [ADMIN, { role: 'admin', isBillingOwner: false }],
  [VIEWER, { role: 'viewer', isBillingOwner: false }],
])

/** token → the grant it resolves to. */
const grants = new Map<string, { userId: string; scopes: string }>([
  ['tok-read', { userId: OWNER, scopes: 'site:read analytics:read' }],
  ['tok-write', { userId: OWNER, scopes: 'site:read analytics:read notes:write' }],
  ['tok-write-only', { userId: OWNER, scopes: 'notes:write' }],
  ['tok-viewer-write', { userId: VIEWER, scopes: 'analytics:read notes:write' }],
  // Every other write scope, and still not `notes:write`.
  [
    'tok-other-writes',
    { userId: OWNER, scopes: 'analytics:read sites:write funnels:write widgets:write' },
  ],
])

function note(overrides: Partial<ChartNoteRecord> = {}): ChartNoteRecord {
  return {
    id: NOTE,
    siteId: SITE,
    at: new Date('2026-11-10T12:00:00.000Z'),
    text: 'Launched v2',
    createdBy: { name: 'Olga Owner' },
    createdAt: new Date('2026-11-10T12:05:00.000Z'),
    updatedAt: new Date('2026-11-10T12:06:00.000Z'),
    ...overrides,
  }
}

const calls = {
  list: [] as ListChartNotesInput[],
  create: [] as CreateChartNoteInput[],
  update: [] as UpdateChartNoteInput[],
  remove: [] as { id: string; siteId: string; actorUserId: string }[],
}
const stored: { rows: ChartNoteRecord[]; exists: boolean } = { rows: [], exists: true }

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async (_db: unknown, params: { siteId: string; userId: string }) =>
      memberships.get(params.userId) ?? null,
    resolveOAuthAccessToken: async (_db: unknown, token: string) => {
      const grant = grants.get(token)
      return grant ? { id: `grant-${token}`, clientId: 'client-1', ...grant } : null
    },
    getAuthedUserById: async (_db: unknown, id: string) => ({
      id,
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
    listChartNotes: async (_db: unknown, input: ListChartNotesInput) => {
      calls.list.push(input)
      return stored.rows.slice(0, input.limit)
    },
    createChartNote: async (_db: unknown, input: CreateChartNoteInput) => {
      calls.create.push(input)
      return note({ at: input.at, text: input.text })
    },
    updateChartNote: async (_db: unknown, input: UpdateChartNoteInput) => {
      calls.update.push(input)
      if (!stored.exists) return null
      return note({
        ...(input.at === undefined ? {} : { at: input.at }),
        ...(input.text === undefined ? {} : { text: input.text }),
      })
    },
    deleteChartNote: async (
      _db: unknown,
      input: { id: string; siteId: string; actorUserId: string },
    ) => {
      calls.remove.push(input)
      return { deleted: stored.exists }
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
const app = createApp({
  service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
  logger,
  env: loadServiceEnv('api', testEnv()),
  auth,
  db: {} as Database,
})

const LIST = `/v1/sites/${SITE}/notes`
const ONE = `${LIST}/${NOTE}`
const RANGE = 'from=2026-11-01T00:00:00Z&to=2026-11-15T00:00:00Z'
const BODY = { at: '2026-11-10T12:00:00.000Z', text: '  Launched v2  ' }

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

const viaGrant = (token: string, method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

async function errorOf(res: Response): Promise<Record<string, unknown>> {
  const body = (await res.json()) as { error: Record<string, unknown> }
  return body.error
}

const noWrites = () => {
  expect(calls.create).toEqual([])
  expect(calls.update).toEqual([])
  expect(calls.remove).toEqual([])
}

beforeEach(() => {
  calls.list = []
  calls.create = []
  calls.update = []
  calls.remove = []
  stored.rows = []
  stored.exists = true
})

describe('GET /notes', () => {
  it('answers a viewer with the notes in the contract shape, author by name only', async () => {
    stored.rows = [
      note(),
      note({ id: 'n2', createdBy: null }),
      note({ id: 'n3', createdBy: { name: null } }),
    ]
    const res = await send('GET', `${LIST}?${RANGE}`, VIEWER)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Record<string, unknown>[] }
    expect(body.items[0]).toEqual({
      id: NOTE,
      at: '2026-11-10T12:00:00.000Z',
      text: 'Launched v2',
      created_by: { name: 'Olga Owner' },
      created_at: '2026-11-10T12:05:00.000Z',
      updated_at: '2026-11-10T12:06:00.000Z',
    })
    expect(body.items[1]?.['created_by']).toBeNull()
    expect(body.items[2]?.['created_by']).toEqual({ name: null })
    // Neither an id nor an email address of anyone, anywhere in the body.
    const raw = JSON.stringify(body)
    expect(raw).not.toContain('user_id')
    expect(raw).not.toContain('@')
  })

  it('asks for the half-open range and at most 500 notes', async () => {
    await send('GET', `${LIST}?${RANGE}`, VIEWER)
    expect(calls.list).toEqual([
      {
        siteId: SITE,
        from: new Date('2026-11-01T00:00:00Z'),
        to: new Date('2026-11-15T00:00:00Z'),
        limit: 500,
      },
    ])
  })

  it('refuses a missing, local or reversed range with 400', async () => {
    for (const query of [
      '',
      'from=2026-11-01T00:00:00Z',
      'from=2026-11-01T00:00:00%2B02:00&to=2026-11-15T00:00:00Z',
      'from=2026-11-15T00:00:00Z&to=2026-11-01T00:00:00Z',
    ]) {
      const res = await send('GET', `${LIST}?${query}`, VIEWER)
      expect(res.status, query).toBe(400)
      expect((await errorOf(res))['code']).toBe('VALIDATION_FAILED')
    }
    expect(calls.list).toEqual([])
  })

  it('refuses a stranger and an anonymous caller', async () => {
    const stranger = await send('GET', `${LIST}?${RANGE}`, STRANGER)
    expect(stranger.status).toBe(404)
    expect((await send('GET', `${LIST}?${RANGE}`)).status).toBe(401)
    expect(calls.list).toEqual([])
  })
})

describe('the writes', () => {
  it('refuse a viewer with 403, before any write', async () => {
    expect((await send('POST', LIST, VIEWER, BODY)).status).toBe(403)
    expect((await send('PATCH', ONE, VIEWER, { text: 'x' })).status).toBe(403)
    expect((await send('DELETE', ONE, VIEWER)).status).toBe(403)
    noWrites()
  })

  it('let an admin create a note, trimmed, as themselves', async () => {
    const res = await send('POST', LIST, ADMIN, BODY)
    expect(res.status).toBe(201)
    expect(calls.create).toEqual([
      {
        siteId: SITE,
        at: new Date('2026-11-10T12:00:00.000Z'),
        text: 'Launched v2',
        actorUserId: ADMIN,
      },
    ])
    expect(await res.json()).toMatchObject({
      text: 'Launched v2',
      created_by: { name: 'Olga Owner' },
    })
  })

  it('let an owner move a note or change its text, and delete it', async () => {
    const moved = await send('PATCH', ONE, OWNER, { at: '2026-11-11T08:00:00.000Z' })
    expect(moved.status).toBe(200)
    expect(calls.update).toEqual([
      { id: NOTE, siteId: SITE, at: new Date('2026-11-11T08:00:00.000Z'), actorUserId: OWNER },
    ])
    expect(await moved.json()).toMatchObject({ at: '2026-11-11T08:00:00.000Z' })

    const removed = await send('DELETE', ONE, OWNER)
    expect(removed.status).toBe(204)
    expect(calls.remove).toEqual([{ id: NOTE, siteId: SITE, actorUserId: OWNER }])
  })

  it('answer 404 for a note that is not on this site, or an id that is not one', async () => {
    stored.exists = false
    const patch = await send('PATCH', ONE, OWNER, { text: 'x' })
    expect(patch.status).toBe(404)
    expect((await errorOf(patch))['code']).toBe('NOT_FOUND')
    expect((await send('DELETE', ONE, OWNER)).status).toBe(404)

    calls.update = []
    calls.remove = []
    // Not a uuid: refused before the database could choke on the cast.
    expect((await send('PATCH', `${LIST}/not-a-uuid`, OWNER, { text: 'x' })).status).toBe(404)
    expect((await send('DELETE', `${LIST}/not-a-uuid`, OWNER)).status).toBe(404)
    noWrites()
  })

  it('refuse an empty, too long or control-character text with 400 and the issue', async () => {
    const cases: [unknown, string, string][] = [
      [{ at: BODY.at, text: '   ' }, 'text', 'empty'],
      [{ at: BODY.at, text: 'x'.repeat(281) }, 'text', 'too_long'],
      [{ at: BODY.at, text: 'tab\there' }, 'text', 'control_characters'],
      [{ at: BODY.at, text: 'bell\u0007' }, 'text', 'control_characters'],
      [{ text: 'no time' }, 'at', 'required'],
      [{ at: 'yesterday', text: 'x' }, 'at', 'not_a_utc_instant'],
    ]
    for (const [body, field, code] of cases) {
      const res = await send('POST', LIST, OWNER, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      const error = await errorOf(res)
      expect(error['code']).toBe('VALIDATION_FAILED')
      expect((error['details'] as { issues: unknown[] }).issues).toContainEqual({ field, code })
    }
    // 280 characters is allowed.
    expect((await send('POST', LIST, OWNER, { at: BODY.at, text: 'x'.repeat(280) })).status).toBe(
      201,
    )
    expect(calls.create).toHaveLength(1)
  })

  it('refuse an empty PATCH body, and a body that is not JSON', async () => {
    const empty = await send('PATCH', ONE, OWNER, {})
    expect(empty.status).toBe(400)
    expect((await errorOf(empty))['details']).toEqual({
      issues: [{ field: 'body', code: 'required_one_of' }],
    })
    const garbled = await app.fetch(
      new Request(`http://api.test${LIST}`, {
        method: 'POST',
        headers: { 'x-test-user': OWNER, 'content-type': 'application/json' },
        body: '{',
      }),
    )
    expect(garbled.status).toBe(400)
    noWrites()
  })
})

describe('an OAuth grant', () => {
  it('reads with analytics:read, and not without it', async () => {
    expect((await viaGrant('tok-read', 'GET', `${LIST}?${RANGE}`)).status).toBe(200)
    const refused = await viaGrant('tok-write-only', 'GET', `${LIST}?${RANGE}`)
    expect(refused.status).toBe(403)
    expect(calls.list).toHaveLength(1)
  })

  it('writes with notes:write, every write', async () => {
    expect((await viaGrant('tok-write', 'POST', LIST, BODY)).status).toBe(201)
    expect((await viaGrant('tok-write', 'PATCH', ONE, { text: 'x' })).status).toBe(200)
    expect((await viaGrant('tok-write', 'DELETE', ONE)).status).toBe(204)
    expect(calls.create).toHaveLength(1)
    expect(calls.update).toHaveLength(1)
    expect(calls.remove).toHaveLength(1)
  })

  it('writes nothing without notes:write, whatever other write scopes it holds', async () => {
    for (const token of ['tok-read', 'tok-other-writes']) {
      for (const [method, path, body] of [
        ['POST', LIST, BODY],
        ['PATCH', ONE, { text: 'x' }],
        ['DELETE', ONE, undefined],
      ] as const) {
        const res = await viaGrant(token, method, path, body)
        expect(res.status, `${token} ${method}`).toBe(403)
        expect(String((await errorOf(res))['message'])).toContain('notes:write')
      }
    }
    noWrites()
  })

  it('writes nothing for a viewer, even holding notes:write', async () => {
    const res = await viaGrant('tok-viewer-write', 'POST', LIST, BODY)
    expect(res.status).toBe(403)
    expect((await viaGrant('tok-viewer-write', 'DELETE', ONE)).status).toBe(403)
    // The read still works for the viewer.
    expect((await viaGrant('tok-viewer-write', 'GET', `${LIST}?${RANGE}`)).status).toBe(200)
    noWrites()
  })
})
