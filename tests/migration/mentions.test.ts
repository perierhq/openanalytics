import {
  avatarStateForHandles,
  createDatabase,
  createPool,
  createSiteWithOwner,
  existingMentionPostIds,
  listMentions,
  listSitesDueForMentionPoll,
  newId,
  purgeSitePostgres,
  readMentionAvatar,
  readMentionSettings,
  recordMentionPoll,
  startSiteDeletion,
  upsertMentionAvatar,
  upsertMentionSettings,
  upsertMentions,
  type Database,
  type MentionUpsertRow,
} from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyPostgresStreams } from '../support/postgres-streams.ts'

/**
 * Migration 0048 (X mentions) against a real Postgres.
 *
 * 1. The migration applies and the settings read answers defaults for a site
 *    that never saved any.
 * 2. One row per post per site: the unique key is the upsert target, and a
 *    second sighting refreshes counts while keeping `first_seen_at` and the
 *    original `matched_term`.
 * 3. The CHECKs refuse what the domain would never write.
 * 4. The poller's pick-up query and the list's keyset behave.
 * 5. Both tables go with the site: the cascade, and the counted purge.
 * 6. Migration 0049's author pictures: the CHECKs, the primary key as the
 *    upsert target, the list's `authorHasAvatar`, and the same two deletions.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

function post(postId: string, overrides: Partial<MentionUpsertRow> = {}): MentionUpsertRow {
  return {
    postId,
    url: `https://x.com/hampfh/status/${postId}`,
    text: 'a post',
    authorHandle: 'hampfh',
    authorName: 'Hampus Hallkvist',
    authorUrl: 'https://x.com/hampfh',
    authorFollowers: 5,
    likes: 1,
    reposts: 0,
    replies: 1,
    quotes: 0,
    views: 23,
    postedAt: new Date('2026-11-10T12:00:00.000Z'),
    matchedTerm: 'conductor.build',
    linksToSite: true,
    ...overrides,
  }
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function avatar(
  siteId: string,
  overrides: Partial<Parameters<typeof upsertMentionAvatar>[1]> = {},
) {
  return {
    siteId,
    platform: 'x' as const,
    handle: 'hampfh',
    contentType: 'image/jpeg' as const,
    bytes: JPEG,
    sourceUrl: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg',
    ...overrides,
  }
}

describeIfPostgres('X mentions (migration 0048)', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `mentions_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let ownerId: string

  const makeSite = async (domains: string[] = []): Promise<string> => {
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: ownerId,
    })
    for (const domain of domains) {
      await pool.query(`INSERT INTO site_domains (id, site_id, domain) VALUES ($1, $2, $3)`, [
        newId(),
        siteId,
        domain,
      ])
    }
    return siteId
  }

  const countIn = async (table: string, siteId: string): Promise<number> => {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE site_id = $1`,
      [siteId],
    )
    return Number(r.rows[0]?.n ?? '0')
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }
    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    const scoped = url.toString()
    const { logger } = createCapturedLogger()
    await applyPostgresStreams({ connectionString: scoped, logger })
    pool = createPool(scoped)
    db = createDatabase(pool)
    ownerId = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [ownerId, `${ownerId}@example.com`],
    )
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  it('answers defaults, then stores settings with the first domain alphabetically', async () => {
    const siteId = await makeSite(['Zeta.example', 'alpha.example'])
    expect(await readMentionSettings(db, siteId)).toEqual({
      domain: 'alpha.example',
      domains: ['alpha.example', 'zeta.example'],
      xEnabled: false,
      terms: [],
      lastPolledAt: null,
      lastError: null,
    })

    await upsertMentionSettings(db, { siteId, actorUserId: ownerId, xEnabled: true })
    // The write answers the stored row, so the route need not read it back.
    expect(
      await upsertMentionSettings(db, { siteId, actorUserId: ownerId, terms: ['Alpha'] }),
    ).toEqual({ xEnabled: true, terms: ['Alpha'], lastPolledAt: null, lastError: null })
    const stored = await readMentionSettings(db, siteId)
    expect(stored).toMatchObject({ xEnabled: true, terms: ['Alpha'] })

    await recordMentionPoll(db, { siteId, error: 'unavailable' })
    expect((await readMentionSettings(db, siteId)).lastError).toBe('unavailable')

    const audit = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs WHERE site_id = $1 AND action = 'site.mentions.updated'`,
      [siteId],
    )
    expect(audit.rows[0]?.n).toBe('2')
  })

  it('refuses more than five terms and an unknown poll error', async () => {
    const siteId = await makeSite()
    await expect(
      pool.query(`INSERT INTO site_mention_settings (site_id, terms) VALUES ($1, $2)`, [
        siteId,
        ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'],
      ]),
    ).rejects.toThrow(/site_mention_settings_terms_count_check/)
    await expect(
      pool.query(`INSERT INTO site_mention_settings (site_id, last_error) VALUES ($1, 'boom')`, [
        siteId,
      ]),
    ).rejects.toThrow(/site_mention_settings_last_error_check/)
  })

  it('keeps one row per post and refreshes it without losing first_seen_at', async () => {
    const siteId = await makeSite(['conductor.build'])
    expect(await upsertMentions(db, { siteId, platform: 'x', posts: [post('1'), post('1')] })).toBe(
      1,
    )
    const before = await pool.query<{ first_seen_at: Date }>(
      `SELECT first_seen_at FROM mentions WHERE site_id = $1 AND post_id = '1'`,
      [siteId],
    )

    await new Promise((resolve) => setTimeout(resolve, 20))
    await upsertMentions(db, {
      siteId,
      platform: 'x',
      posts: [post('1', { likes: 99, matchedTerm: 'Conductor', text: 'edited' })],
    })

    const after = await pool.query<{
      first_seen_at: Date
      refreshed_at: Date
      likes: number
      matched_term: string
      text: string
    }>(
      `SELECT first_seen_at, refreshed_at, likes, matched_term, text FROM mentions WHERE site_id = $1`,
      [siteId],
    )
    expect(after.rows).toHaveLength(1)
    const row = after.rows[0]
    expect(row?.likes).toBe(99)
    expect(row?.text).toBe('edited')
    expect(row?.matched_term).toBe('conductor.build')
    expect(row?.first_seen_at.getTime()).toBe(before.rows[0]?.first_seen_at.getTime())
    expect(row?.refreshed_at.getTime()).toBeGreaterThan(row?.first_seen_at.getTime() ?? 0)

    expect(await existingMentionPostIds(db, siteId, 'x', ['1', '2'])).toEqual(new Set(['1']))

    // The unique key itself, below the repository.
    await expect(
      pool.query(
        `INSERT INTO mentions (id, site_id, platform, post_id, url, text, author_handle, author_name,
           author_url, posted_at, matched_term, links_to_site)
         VALUES ($1, $2, 'x', '1', 'https://x.com/h/status/1', 't', 'h', 'n', 'https://x.com/h',
           now(), 'm', false)`,
        [newId(), siteId],
      ),
    ).rejects.toThrow(/mentions_site_platform_post_key/)
  })

  it('refuses an unknown platform, over-long text and a link that is not https', async () => {
    const siteId = await makeSite()
    const insert = (
      platform: string,
      text: string,
      url = 'https://x.com/h/status/1',
      authorUrl = 'https://x.com/h',
    ) =>
      pool.query(
        `INSERT INTO mentions (id, site_id, platform, post_id, url, text, author_handle, author_name,
           author_url, posted_at, matched_term, links_to_site)
         VALUES ($1, $2, $3, $4, $5, $6, 'h', 'n', $7, now(), 'm', false)`,
        [newId(), siteId, platform, newId(), url, text, authorUrl],
      )
    await expect(insert('reddit', 't')).rejects.toThrow(/mentions_platform_check/)
    await expect(insert('x', 'a'.repeat(1001))).rejects.toThrow(/mentions_text_length_check/)
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'http://x.com/h']) {
      await expect(insert('x', 't', bad)).rejects.toThrow(/mentions_url_check/)
      await expect(insert('x', 't', undefined, bad)).rejects.toThrow(/mentions_author_url_check/)
    }
    await expect(insert('x', 't')).resolves.toBeDefined()
  })

  it('indexes the due query in its ORDER BY', async () => {
    const r = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND indexname = 'site_mention_settings_due_idx'`,
    )
    expect(r.rows[0]?.indexdef).toContain('(last_polled_at NULLS FIRST, site_id)')
    expect(r.rows[0]?.indexdef).toContain('WHERE x_enabled')
  })

  it('lists due sites oldest first and pages the list by (posted_at, id)', async () => {
    const due = await makeSite(['due.example'])
    const fresh = await makeSite(['fresh.example'])
    const off = await makeSite(['off.example'])
    await upsertMentionSettings(db, { siteId: due, actorUserId: ownerId, xEnabled: true })
    await upsertMentionSettings(db, { siteId: fresh, actorUserId: ownerId, xEnabled: true })
    await upsertMentionSettings(db, { siteId: off, actorUserId: ownerId, xEnabled: false })
    await recordMentionPoll(db, { siteId: fresh, error: null })

    const picked = await listSitesDueForMentionPoll(db, {
      staleBefore: new Date(Date.now() - 60 * 60_000),
      limit: 100,
    })
    const ids = picked.map((site) => site.siteId)
    expect(ids).toContain(due)
    expect(ids).not.toContain(fresh)
    expect(ids).not.toContain(off)
    expect(picked.find((site) => site.siteId === due)).toMatchObject({
      domain: 'due.example',
      lastPolledAt: null,
    })

    const sameSecond = new Date('2026-11-10T12:00:00.000Z')
    await upsertMentions(db, {
      siteId: due,
      platform: 'x',
      posts: [
        post('a', { postedAt: sameSecond }),
        post('b', { postedAt: sameSecond }),
        post('c', { postedAt: new Date('2026-11-09T12:00:00.000Z') }),
        post('outside', { postedAt: new Date('2026-12-01T00:00:00.000Z') }),
      ],
    })
    const range = {
      siteId: due,
      from: new Date('2026-11-01T00:00:00.000Z'),
      to: new Date('2026-12-01T00:00:00.000Z'),
    }
    const first = await listMentions(db, { ...range, limit: 2 })
    expect(first).toHaveLength(2)
    const last = first[1]
    if (!last) throw new Error('expected two rows')
    const second = await listMentions(db, {
      ...range,
      limit: 10,
      after: { postedAt: last.postedAt, id: last.id },
    })
    const all = [...first, ...second].map((row) => row.postId)
    expect(all).toHaveLength(3)
    expect(new Set(all)).toEqual(new Set(['a', 'b', 'c']))
    expect(all[2]).toBe('c')

    // One row a page, so the cursor lands inside the same-`posted_at` tie: the
    // `id` half of the keyset is what splits it, with nothing lost or repeated.
    const walked: { postId: string; postedAt: Date }[] = []
    let after: { postedAt: Date; id: string } | undefined
    for (let page = 0; page < 10; page += 1) {
      const rows = await listMentions(db, { ...range, limit: 1, ...(after ? { after } : {}) })
      const row = rows[0]
      if (!row) break
      walked.push({ postId: row.postId, postedAt: row.postedAt })
      after = { postedAt: row.postedAt, id: row.id }
    }
    expect(walked.map((row) => row.postId)).toHaveLength(3)
    expect(new Set(walked.map((row) => row.postId))).toEqual(new Set(['a', 'b', 'c']))
    expect(walked[0]?.postedAt.getTime()).toBe(sameSecond.getTime())
    expect(walked[1]?.postedAt.getTime()).toBe(sameSecond.getTime())
    expect(walked[2]?.postId).toBe('c')
  })

  it('stores one picture per author per site, replacing it on the primary key', async () => {
    const siteId = await makeSite()
    const sibling = await makeSite()
    const first = new Date('2026-11-01T00:00:00.000Z')
    await upsertMentionAvatar(db, avatar(siteId, { fetchedAt: first }))
    expect(await readMentionAvatar(db, siteId, 'x', 'hampfh')).toEqual({
      contentType: 'image/jpeg',
      bytes: JPEG,
    })
    expect(await avatarStateForHandles(db, siteId, 'x', ['hampfh', 'nobody'])).toEqual([
      {
        handle: 'hampfh',
        fetchedAt: first,
        sourceUrl: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg',
      },
    ])

    const second = new Date('2026-11-09T00:00:00.000Z')
    await upsertMentionAvatar(
      db,
      avatar(siteId, {
        contentType: 'image/png',
        bytes: PNG,
        sourceUrl: 'https://pbs.twimg.com/profile_images/2/b_normal.png',
        fetchedAt: second,
      }),
    )
    expect(await countIn('mention_avatars', siteId)).toBe(1)
    expect(await readMentionAvatar(db, siteId, 'x', 'hampfh')).toEqual({
      contentType: 'image/png',
      bytes: PNG,
    })
    expect(await avatarStateForHandles(db, siteId, 'x', ['hampfh'])).toEqual([
      {
        handle: 'hampfh',
        fetchedAt: second,
        sourceUrl: 'https://pbs.twimg.com/profile_images/2/b_normal.png',
      },
    ])

    // Per site: the sibling holds nothing, and reads nothing.
    expect(await readMentionAvatar(db, sibling, 'x', 'hampfh')).toBeNull()
    expect(await avatarStateForHandles(db, sibling, 'x', ['hampfh'])).toEqual([])
    expect(await avatarStateForHandles(db, siteId, 'x', [])).toEqual([])
  })

  it('refuses a picture the worker would never store', async () => {
    const siteId = await makeSite()
    const insert = (values: {
      platform?: string
      handle?: string
      contentType?: string
      bytes?: Buffer
      sourceUrl?: string
    }) =>
      pool.query(
        `INSERT INTO mention_avatars (site_id, platform, author_handle, content_type, bytes, source_url)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          siteId,
          values.platform ?? 'x',
          values.handle ?? newId().replace(/-/gu, '').slice(-15),
          values.contentType ?? 'image/jpeg',
          values.bytes ?? Buffer.from(JPEG),
          values.sourceUrl ?? 'https://pbs.twimg.com/profile_images/1/a_normal.jpg',
        ],
      )
    await expect(insert({ platform: 'reddit' })).rejects.toThrow(/mention_avatars_platform_check/)
    for (const handle of ['bad.handle', 'a'.repeat(16), '', '../x']) {
      await expect(insert({ handle })).rejects.toThrow(/mention_avatars_handle_check/)
    }
    for (const contentType of ['image/svg+xml', 'text/html', 'image/gif']) {
      await expect(insert({ contentType })).rejects.toThrow(/mention_avatars_content_type_check/)
    }
    await expect(insert({ bytes: Buffer.alloc(32_769) })).rejects.toThrow(
      /mention_avatars_bytes_size_check/,
    )
    await expect(insert({ bytes: Buffer.alloc(32_768) })).resolves.toBeDefined()
    for (const sourceUrl of [
      'http://pbs.twimg.com/a.jpg',
      'https://pbs.twimg.com.evil.com/a.jpg',
      'https://pbsxtwimg.com/a.jpg',
      'javascript:alert(1)',
    ]) {
      await expect(insert({ sourceUrl })).rejects.toThrow(/mention_avatars_source_url_check/)
    }
    await expect(insert({ handle: 'dup' })).resolves.toBeDefined()
    await expect(insert({ handle: 'dup' })).rejects.toThrow(/mention_avatars_pkey/)
  })

  it('tells the list which rows have a stored picture', async () => {
    const siteId = await makeSite()
    await upsertMentions(db, {
      siteId,
      platform: 'x',
      posts: [
        post('1', { authorHandle: 'hampfh' }),
        post('2', { authorHandle: 'faceless', authorUrl: 'https://x.com/faceless' }),
      ],
    })
    await upsertMentionAvatar(db, avatar(siteId))
    // Another site's picture of the same author does not count here.
    await upsertMentionAvatar(db, avatar(await makeSite(), { handle: 'faceless' }))

    const rows = await listMentions(db, {
      siteId,
      from: new Date('2026-11-01T00:00:00.000Z'),
      to: new Date('2026-12-01T00:00:00.000Z'),
      limit: 10,
    })
    expect(Object.fromEntries(rows.map((row) => [row.authorHandle, row.authorHasAvatar]))).toEqual({
      hampfh: true,
      faceless: false,
    })
  })

  it('cascades with the site row', async () => {
    const siteId = await makeSite()
    // Raw inserts, so no audit row (which outlives sites by design) is involved.
    await pool.query(`INSERT INTO site_mention_settings (site_id, x_enabled) VALUES ($1, true)`, [
      siteId,
    ])
    await upsertMentions(db, { siteId, platform: 'x', posts: [post('1')] })
    await upsertMentionAvatar(db, avatar(siteId))

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET CONSTRAINTS ALL DEFERRED')
      await client.query(`DELETE FROM sites WHERE id = $1`, [siteId])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
    expect(await countIn('mentions', siteId)).toBe(0)
    expect(await countIn('site_mention_settings', siteId)).toBe(0)
    expect(await countIn('mention_avatars', siteId)).toBe(0)
  })

  it('is purged with the site, counted per table, and a sibling keeps its rows', async () => {
    const siteId = await makeSite()
    const sibling = await makeSite()
    for (const target of [siteId, sibling]) {
      await upsertMentionSettings(db, { siteId: target, actorUserId: ownerId, xEnabled: true })
      await upsertMentions(db, { siteId: target, platform: 'x', posts: [post('1')] })
      await upsertMentionAvatar(db, avatar(target))
    }

    await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
    const purged = await purgeSitePostgres(db, { siteId })
    for (const table of ['site_mention_settings', 'mentions', 'mention_avatars']) {
      expect(purged.deleted[table]).toBe(1)
      expect(await countIn(table, siteId)).toBe(0)
      expect(await countIn(table, sibling)).toBe(1)
    }
  })
})
