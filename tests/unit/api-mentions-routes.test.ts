import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type {
  Database,
  ListMentionsInput,
  MentionRecord,
  MentionSettingsRecord,
  UpsertMentionSettingsInput,
} from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeMentionsCursor } from '../../apps/api/src/analytics/mentions-cursor.ts'

/**
 * The mentions surface (migration 0048): settings read and write, and the
 * paginated list.
 *
 * - **Reads are membership-only; the settings write is `site:settings`.** A
 *   viewer can see what was found and what is searched; only an owner or admin
 *   decides to send the site's domain and terms to a third-party service.
 * - **The list is keyset-paginated with an exact `has_more`**: the route
 *   over-fetches by one, and a malformed cursor is a 400, never page one again.
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const OWNER = 'u-owner'
const ADMIN = 'u-admin'
const VIEWER = 'u-viewer'
const STRANGER = 'u-stranger'
const OAUTH_TOKEN = 'oauth-token-1'

const memberships = new Map<string, { role: string; isBillingOwner: boolean }>([
  [OWNER, { role: 'owner', isBillingOwner: true }],
  [ADMIN, { role: 'admin', isBillingOwner: false }],
  [VIEWER, { role: 'viewer', isBillingOwner: false }],
])

const settings: { current: MentionSettingsRecord } = {
  current: {
    domain: 'conductor.build',
    domains: ['conductor.build'],
    xEnabled: false,
    terms: [],
    lastPolledAt: null,
    lastError: null,
  },
}

function mention(i: number): MentionRecord {
  return {
    id: `0190a3b4-0000-7000-8000-${String(i).padStart(12, '0')}`,
    platform: 'x',
    postId: String(1000 + i),
    url: `https://x.com/hampfh/status/${String(1000 + i)}`,
    text: `post ${String(i)}`,
    authorHandle: 'hampfh',
    authorName: 'Hampus Hallkvist',
    authorUrl: 'https://x.com/hampfh',
    authorFollowers: 5,
    likes: 1,
    reposts: 0,
    replies: null,
    quotes: 0,
    views: 23,
    postedAt: new Date(Date.UTC(2026, 10, 10, 12, 0, 0) - i * 60_000),
    matchedTerm: 'conductor.build',
    linksToSite: true,
    firstSeenAt: new Date('2026-11-10T13:00:00.000Z'),
    refreshedAt: new Date('2026-11-10T14:00:00.000Z'),
    authorHasAvatar: false,
  }
}

const calls = {
  upsert: [] as UpsertMentionSettingsInput[],
  list: [] as ListMentionsInput[],
  reads: 0,
}
const stored: { rows: MentionRecord[] } = { rows: [] }
const failWrite: { error: Error | null } = { error: null }
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const avatars: {
  rows: Map<string, { contentType: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: Uint8Array }>
  reads: { siteId: string; platform: string; handle: string }[]
} = { rows: new Map(), reads: [] }

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    getMembership: async (_db: unknown, params: { siteId: string; userId: string }) =>
      memberships.get(params.userId) ?? null,
    resolveOAuthAccessToken: async (_db: unknown, token: string) =>
      token === OAUTH_TOKEN
        ? {
            id: 'grant-1',
            userId: OWNER,
            clientId: 'client-1',
            // Every grant scope, so a refusal can only come from the allowlist.
            scopes:
              'site:read analytics:read sites:write funnels:write events:write widgets:write share:write team:read',
          }
        : null,
    getAuthedUserById: async (_db: unknown, id: string) => ({
      id,
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
    readMentionSettings: async () => {
      calls.reads += 1
      return settings.current
    },
    upsertMentionSettings: async (_db: unknown, input: UpsertMentionSettingsInput) => {
      if (failWrite.error !== null) throw failWrite.error
      calls.upsert.push(input)
      settings.current = {
        ...settings.current,
        ...(input.xEnabled === undefined ? {} : { xEnabled: input.xEnabled }),
        ...(input.terms === undefined ? {} : { terms: input.terms }),
      }
      const { xEnabled, terms, lastPolledAt, lastError } = settings.current
      return { xEnabled, terms, lastPolledAt, lastError }
    },
    listMentions: async (_db: unknown, input: ListMentionsInput) => {
      calls.list.push(input)
      return stored.rows.slice(0, input.limit)
    },
    readMentionAvatar: async (_db: unknown, siteId: string, platform: string, handle: string) => {
      avatars.reads.push({ siteId, platform, handle })
      return siteId === SITE ? (avatars.rows.get(`${platform}/${handle}`) ?? null) : null
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

const SETTINGS = `/v1/sites/${SITE}/mentions/settings`
const LIST = `/v1/sites/${SITE}/mentions`
const RANGE = 'from=2026-11-01T00:00:00Z&to=2026-11-15T00:00:00Z'

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

async function errorOf(res: Response): Promise<Record<string, unknown>> {
  const body = (await res.json()) as { error: Record<string, unknown> }
  return body.error
}

beforeEach(() => {
  failWrite.error = null
  calls.upsert = []
  calls.list = []
  calls.reads = 0
  stored.rows = []
  avatars.rows = new Map()
  avatars.reads = []
  settings.current = {
    domain: 'conductor.build',
    domains: ['conductor.build'],
    xEnabled: false,
    terms: [],
    lastPolledAt: null,
    lastError: null,
  }
})

describe('GET /mentions/settings', () => {
  it('answers a viewer with the settings, in the contract shape', async () => {
    settings.current = {
      ...settings.current,
      xEnabled: true,
      terms: ['Conductor'],
      lastPolledAt: new Date('2026-11-15T10:00:00.000Z'),
      lastError: 'unavailable',
    }
    const res = await send('GET', SETTINGS, VIEWER)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      domain: 'conductor.build',
      x_enabled: true,
      terms: ['Conductor'],
      last_polled_at: '2026-11-15T10:00:00.000Z',
      last_error: 'unavailable',
    })
  })

  it('refuses a stranger and an anonymous caller', async () => {
    expect((await send('GET', SETTINGS, STRANGER)).status).not.toBe(200)
    expect((await send('GET', SETTINGS)).status).toBe(401)
  })
})

describe('PATCH /mentions/settings', () => {
  it('refuses a viewer before any write', async () => {
    const res = await send('PATCH', SETTINGS, VIEWER, { x_enabled: true })
    expect(res.status).toBe(403)
    expect(calls.upsert).toEqual([])
  })

  it('lets an admin turn watching on and set terms, normalized', async () => {
    const res = await send('PATCH', SETTINGS, ADMIN, {
      x_enabled: true,
      terms: [' Conductor ', 'conductor', 'conductor.build'],
    })
    expect(res.status).toBe(200)
    expect(calls.upsert).toEqual([
      { siteId: SITE, actorUserId: ADMIN, xEnabled: true, terms: ['Conductor'] },
    ])
    expect(await res.json()).toMatchObject({ x_enabled: true, terms: ['Conductor'] })
    // The domain is read once, before the write; the response is what the
    // write returned, not a second read.
    expect(calls.reads).toBe(1)
  })

  it('refuses to turn watching on for a site with no domain and no terms', async () => {
    settings.current = { ...settings.current, domain: null, domains: [], terms: [] }
    const res = await send('PATCH', SETTINGS, OWNER, { x_enabled: true })
    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error['code']).toBe('VALIDATION_FAILED')
    expect(error['details']).toEqual({
      issues: [
        {
          field: 'x_enabled',
          code: 'nothing_to_search',
          message: 'Add a domain to the site or at least one term first.',
        },
      ],
    })
    expect(calls.upsert).toEqual([])

    // Clearing the last term while watching is on is the same request.
    settings.current = { ...settings.current, xEnabled: true, terms: ['Conductor'] }
    const cleared = await send('PATCH', SETTINGS, OWNER, { terms: [] })
    expect(cleared.status).toBe(400)

    // With a term it is allowed.
    settings.current = { ...settings.current, xEnabled: false, terms: [] }
    const withTerm = await send('PATCH', SETTINGS, OWNER, { x_enabled: true, terms: ['Conductor'] })
    expect(withTerm.status).toBe(200)
  })

  it('never logs the raw error when the write fails', async () => {
    const captured = createCapturedLogger()
    const failing = createApp({
      service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
      logger: captured.logger,
      env: loadServiceEnv('api', testEnv()),
      auth,
      db: {} as Database,
    })
    failWrite.error = Object.assign(new Error('Failed query: insert ... params: SecretTerm'), {
      cause: Object.assign(new Error('value too long'), { code: '22001' }),
    })
    const res = await failing.fetch(
      new Request(`http://api.test${SETTINGS}`, {
        method: 'PATCH',
        headers: { 'x-test-user': OWNER, 'content-type': 'application/json' },
        body: JSON.stringify({ terms: ['SecretTerm'] }),
      }),
    )
    expect(res.status).toBe(500)
    const logged = JSON.stringify(captured.lines)
    expect(logged).not.toContain('SecretTerm')
    expect(logged).not.toContain('Failed query')
    expect(captured.find('mentions_settings_write_failed')[0]).toMatchObject({
      category: 'database',
      db_code: '22001',
    })
  })

  it('refuses an empty body with 400', async () => {
    const res = await send('PATCH', SETTINGS, OWNER, {})
    expect(res.status).toBe(400)
    expect((await errorOf(res))['code']).toBe('VALIDATION_FAILED')
    expect(calls.upsert).toEqual([])
  })

  it('refuses invalid terms with 400 and the issues', async () => {
    const res = await send('PATCH', SETTINGS, OWNER, {
      terms: ['a', 'bb', 'cc', 'dd', 'ee', 'ff'],
    })
    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error['code']).toBe('VALIDATION_FAILED')
    expect(JSON.stringify(error)).toContain('too_many')

    const short = await send('PATCH', SETTINGS, OWNER, { terms: ['a'] })
    expect(short.status).toBe(400)
    expect(calls.upsert).toEqual([])
  })
})

describe('GET /mentions', () => {
  it('answers a viewer with a page in the contract shape', async () => {
    stored.rows = [mention(1)]
    const res = await send('GET', `${LIST}?${RANGE}`, VIEWER)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      items: [
        {
          id: mention(1).id,
          platform: 'x',
          post_id: '1001',
          url: 'https://x.com/hampfh/status/1001',
          text: 'post 1',
          author: {
            handle: 'hampfh',
            name: 'Hampus Hallkvist',
            followers: 5,
            url: 'https://x.com/hampfh',
            avatar_url: null,
          },
          posted_at: mention(1).postedAt.toISOString(),
          matched_term: 'conductor.build',
          links_to_site: true,
          likes: 1,
          reposts: 0,
          replies: null,
          quotes: 0,
          views: 23,
          first_seen_at: '2026-11-10T13:00:00.000Z',
          refreshed_at: '2026-11-10T14:00:00.000Z',
        },
      ],
      next_cursor: null,
      has_more: false,
    })
    expect(calls.list[0]).toMatchObject({
      siteId: SITE,
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-15T00:00:00Z'),
      limit: 51,
    })
  })

  it('over-fetches by one and hands back a cursor that resumes after the last item', async () => {
    stored.rows = [mention(1), mention(2), mention(3)]
    const res = await send('GET', `${LIST}?${RANGE}&limit=2&platform=x`, VIEWER)
    const body = (await res.json()) as {
      items: { id: string }[]
      next_cursor: string | null
      has_more: boolean
    }
    expect(calls.list[0]).toMatchObject({ limit: 3, platform: 'x' })
    expect(body.items.map((item) => item.id)).toEqual([mention(1).id, mention(2).id])
    expect(body.has_more).toBe(true)
    expect(body.next_cursor).toBe(
      encodeMentionsCursor({ postedAtMs: mention(2).postedAt.getTime(), id: mention(2).id }),
    )

    await send('GET', `${LIST}?${RANGE}&cursor=${body.next_cursor as string}`, VIEWER)
    expect(calls.list[1]?.after).toEqual({ postedAt: mention(2).postedAt, id: mention(2).id })
  })

  it('points author.avatar_url at this API when a picture is stored, else null', async () => {
    stored.rows = [{ ...mention(1), authorHasAvatar: true }, mention(2)]
    const res = await send('GET', `${LIST}?${RANGE}`, VIEWER)
    const body = (await res.json()) as { items: { author: { avatar_url: string | null } }[] }
    expect(body.items.map((item) => item.author.avatar_url)).toEqual([
      `/v1/sites/${SITE}/mentions/avatars/x/hampfh`,
      null,
    ])
  })

  it.each([
    ['a malformed cursor', `${RANGE}&cursor=not-a-cursor`],
    [
      'a cursor with a non-uuid id',
      `${RANGE}&cursor=${Buffer.from('men1|1|abc').toString('base64url')}`,
    ],
    ['a missing range', 'from=2026-11-01T00:00:00Z'],
    ['a non-UTC instant', 'from=2026-11-01T00:00:00+01:00&to=2026-11-15T00:00:00Z'],
    ['an inverted range', 'from=2026-11-15T00:00:00Z&to=2026-11-01T00:00:00Z'],
    ['a limit over 200', `${RANGE}&limit=201`],
    ['an unknown platform', `${RANGE}&platform=reddit`],
  ])('refuses %s with 400', async (_label, query) => {
    const res = await send('GET', `${LIST}?${query}`, VIEWER)
    expect(res.status).toBe(400)
    expect((await errorOf(res))['code']).toBe('VALIDATION_FAILED')
    expect(calls.list).toEqual([])
  })
})

describe('GET /mentions/avatars/{platform}/{handle}', () => {
  const AVATAR = `/v1/sites/${SITE}/mentions/avatars/x/hampfh`

  it('answers a viewer with the stored bytes, type and locked-down headers', async () => {
    avatars.rows.set('x/hampfh', { contentType: 'image/jpeg', bytes: JPEG })
    const res = await send('GET', AVATAR, VIEWER)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-site')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG)
    expect(avatars.reads).toEqual([{ siteId: SITE, platform: 'x', handle: 'hampfh' }])
  })

  it('answers 404 when the site has no picture for that author', async () => {
    const res = await send('GET', `/v1/sites/${SITE}/mentions/avatars/x/nobody`, VIEWER)
    expect(res.status).toBe(404)
  })

  it.each([
    ['a handle with a dot', 'x/bad.handle'],
    ['a handle over 15 characters', `x/${'a'.repeat(16)}`],
    ['an encoded slash', 'x/a%2Fb'],
    ['an unknown platform', 'reddit/hampfh'],
  ])('refuses %s with 400 before any read', async (_label, tail) => {
    const res = await send('GET', `/v1/sites/${SITE}/mentions/avatars/${tail}`, VIEWER)
    expect(res.status).toBe(400)
    expect((await errorOf(res))['code']).toBe('VALIDATION_FAILED')
    expect(avatars.reads).toEqual([])
  })

  it('refuses a stranger and an anonymous caller before any read', async () => {
    avatars.rows.set('x/hampfh', { contentType: 'image/jpeg', bytes: JPEG })
    const stranger = await send('GET', AVATAR, STRANGER)
    expect(stranger.status).toBe(404)
    expect((await errorOf(stranger))['code']).toBe('SITE_NOT_FOUND')
    expect((await send('GET', AVATAR)).status).toBe(401)
    expect(avatars.reads).toEqual([])
  })
})

describe('an OAuth grant', () => {
  // The grant's user is the owner and the grant carries every scope, so the
  // only thing that can refuse it is the allowlist in `grant-arm.ts`.
  const viaGrant = (method: string, path: string, body?: unknown) =>
    app.fetch(
      new Request(`http://api.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${OAUTH_TOKEN}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )

  it('is refused on both settings routes, before any read or write', async () => {
    const read = await viaGrant('GET', SETTINGS)
    expect(read.status).toBe(403)
    expect((await errorOf(read))['code']).toBe('FORBIDDEN')

    const write = await viaGrant('PATCH', SETTINGS, { x_enabled: true })
    expect(write.status).toBe(403)
    expect((await errorOf(write))['code']).toBe('FORBIDDEN')

    expect(calls.reads).toBe(0)
    expect(calls.upsert).toEqual([])
  })

  it('is refused on the avatar route, which is session only', async () => {
    avatars.rows.set('x/hampfh', { contentType: 'image/jpeg', bytes: JPEG })
    const res = await viaGrant('GET', `/v1/sites/${SITE}/mentions/avatars/x/hampfh`)
    expect(res.status).toBe(403)
    expect((await errorOf(res))['code']).toBe('FORBIDDEN')
    expect(avatars.reads).toEqual([])
  })

  it('may read the list', async () => {
    stored.rows = [mention(1)]
    const res = await viaGrant('GET', `${LIST}?${RANGE}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1)
  })
})
