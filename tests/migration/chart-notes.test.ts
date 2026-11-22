import {
  createChartNote,
  createDatabase,
  createPool,
  createSiteWithOwner,
  deleteChartNote,
  listChartNotes,
  newId,
  purgeAccountPostgres,
  purgeSitePostgres,
  startSiteDeletion,
  updateChartNote,
  type Database,
} from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyPostgresStreams } from '../support/postgres-streams.ts'

/**
 * Migration 0050 (chart notes) against a real Postgres.
 *
 * 1. Create, update and delete, each with an audit row that never carries the
 *    note's text.
 * 2. The list is the half-open range on `at`, newest first, bounded.
 * 3. The author is a display name only, and null once the account is deleted.
 * 4. The CHECKs refuse what the domain would never write.
 * 5. The notes go with the site: the cascade, and the counted purge.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const day = (d: number, h = 12) => new Date(Date.UTC(2026, 10, d, h, 0, 0))

describeIfPostgres('chart notes (migration 0050)', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `chart_notes_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let ownerId: string

  const makeUser = async (name: string): Promise<string> => {
    const id = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
      [id, name, `${id}@example.com`],
    )
    return id
  }

  const makeSite = async (): Promise<string> => {
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: ownerId,
    })
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
    ownerId = await makeUser('Olga Owner')
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

  it('creates, updates and deletes a note, auditing each without its text', async () => {
    const siteId = await makeSite()
    const created = await createChartNote(db, {
      siteId,
      at: day(10),
      text: 'Launched v2',
      actorUserId: ownerId,
    })
    expect(created).toMatchObject({
      siteId,
      at: day(10),
      text: 'Launched v2',
      createdBy: { name: 'Olga Owner' },
    })
    expect(created.createdAt).toBeInstanceOf(Date)

    const moved = await updateChartNote(db, {
      id: created.id,
      siteId,
      at: day(11),
      actorUserId: ownerId,
    })
    expect(moved).toMatchObject({ at: day(11), text: 'Launched v2' })
    const renamed = await updateChartNote(db, {
      id: created.id,
      siteId,
      text: 'Launched v2.0',
      actorUserId: ownerId,
    })
    expect(renamed).toMatchObject({ at: day(11), text: 'Launched v2.0' })
    expect(renamed?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())

    // Another site's id reads as absent, for an update and a delete alike.
    const sibling = await makeSite()
    expect(
      await updateChartNote(db, {
        id: created.id,
        siteId: sibling,
        text: 'x',
        actorUserId: ownerId,
      }),
    ).toBeNull()
    expect(
      await deleteChartNote(db, { id: created.id, siteId: sibling, actorUserId: ownerId }),
    ).toEqual({ deleted: false })

    expect(await deleteChartNote(db, { id: created.id, siteId, actorUserId: ownerId })).toEqual({
      deleted: true,
    })
    expect(await deleteChartNote(db, { id: created.id, siteId, actorUserId: ownerId })).toEqual({
      deleted: false,
    })
    expect(await countIn('chart_notes', siteId)).toBe(0)

    const audit = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_logs WHERE site_id = $1 AND target_type = 'chart_note'
       ORDER BY action`,
      [siteId],
    )
    expect(audit.rows.map((row) => row.action).sort()).toEqual([
      'chart_note.created',
      'chart_note.deleted',
      'chart_note.updated',
      'chart_note.updated',
    ])
    const created_ = audit.rows.find((row) => row.action === 'chart_note.created')
    expect(created_?.metadata).toEqual({ text_length: 11 })
    const updated_ = audit.rows.filter((row) => row.action === 'chart_note.updated')
    expect(updated_.map((row) => row.metadata)).toEqual(
      expect.arrayContaining([{ fields: ['at'] }, { fields: ['text'], text_length: 13 }]),
    )
    const deleted_ = audit.rows.find((row) => row.action === 'chart_note.deleted')
    expect(deleted_?.metadata).toEqual({ text_length: 13 })
    // Lengths, never the words.
    expect(JSON.stringify(audit.rows)).not.toContain('Launched')
  })

  it('lists the half-open range on `at`, newest first, up to the limit', async () => {
    const siteId = await makeSite()
    const other = await makeSite()
    for (const [d, text] of [
      [9, 'before'],
      [10, 'from'],
      [12, 'middle'],
      [14, 'to'],
    ] as const) {
      await createChartNote(db, { siteId, at: day(d, 0), text, actorUserId: ownerId })
    }
    await createChartNote(db, {
      siteId: other,
      at: day(12),
      text: 'elsewhere',
      actorUserId: ownerId,
    })

    const rows = await listChartNotes(db, { siteId, from: day(10, 0), to: day(14, 0), limit: 10 })
    // `from` is in, `to` is out, the other site is invisible.
    expect(rows.map((row) => row.text)).toEqual(['middle', 'from'])

    const bounded = await listChartNotes(db, { siteId, from: day(1), to: day(30), limit: 2 })
    expect(bounded.map((row) => row.text)).toEqual(['to', 'middle'])
  })

  it('names the author by display name, and forgets them when their account goes', async () => {
    const siteId = await makeSite()
    const adminId = await makeUser('Adam Admin')
    const unnamedId = await makeUser('')
    await createChartNote(db, { siteId, at: day(5), text: 'by admin', actorUserId: adminId })
    await createChartNote(db, { siteId, at: day(6), text: 'by nobody', actorUserId: unnamedId })

    const before = await listChartNotes(db, { siteId, from: day(1), to: day(30), limit: 10 })
    expect(before.map((row) => [row.text, row.createdBy])).toEqual([
      // An account with no name is still an author; the name is just unknown.
      ['by nobody', { name: null }],
      ['by admin', { name: 'Adam Admin' }],
    ])

    // The real erasure. It never deletes the `users` row — it scrubs it into a
    // tombstone — so the foreign key's `ON DELETE SET NULL` can never fire, and
    // the teardown has to sever the link itself.
    const purged = await purgeAccountPostgres(db, { userId: adminId })
    expect(purged.affected['chart_notes_unlink']).toBe(1)
    expect((await pool.query(`SELECT 1 FROM users WHERE id = $1`, [adminId])).rowCount).toBe(1)

    const after = await listChartNotes(db, { siteId, from: day(1), to: day(30), limit: 10 })
    expect(after.find((row) => row.text === 'by admin')?.createdBy).toBeNull()
    // Somebody else's authorship is untouched.
    expect(after.find((row) => row.text === 'by nobody')?.createdBy).toEqual({ name: null })
    const link = await pool.query<{ created_by_user_id: string | null }>(
      `SELECT created_by_user_id FROM chart_notes WHERE site_id = $1 AND text = 'by admin'`,
      [siteId],
    )
    expect(link.rows).toEqual([{ created_by_user_id: null }])
    // The note itself stays.
    expect(after).toHaveLength(2)

    // A second pass finds nothing left to unlink.
    const again = await purgeAccountPostgres(db, { userId: adminId })
    expect(again.affected['chart_notes_unlink']).toBe(0)
  })

  it('refuses a note the domain would never write', async () => {
    const siteId = await makeSite()
    const insert = (text: string) =>
      pool.query(`INSERT INTO chart_notes (id, site_id, at, text) VALUES ($1, $2, now(), $3)`, [
        newId(),
        siteId,
        text,
      ])
    await expect(insert('')).rejects.toThrow(/chart_notes_text_length_check/)
    await expect(insert('x'.repeat(281))).rejects.toThrow(/chart_notes_text_length_check/)
    await expect(insert(' padded ')).rejects.toThrow(/chart_notes_text_trimmed_check/)
    await expect(insert('a\tb')).rejects.toThrow(/chart_notes_text_control_check/)
    // 280 emoji are 280 characters to Postgres.
    await expect(insert('🚀'.repeat(280))).resolves.toBeDefined()
    await expect(insert('two\nlines')).resolves.toBeDefined()
  })

  it('cascades with the site row', async () => {
    const siteId = await makeSite()
    await pool.query(
      `INSERT INTO chart_notes (id, site_id, at, text) VALUES ($1, $2, now(), 'x')`,
      [newId(), siteId],
    )
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
    expect(await countIn('chart_notes', siteId)).toBe(0)
  })

  it('is purged with the site, counted, and a sibling keeps its notes', async () => {
    const siteId = await makeSite()
    const sibling = await makeSite()
    for (const target of [siteId, sibling]) {
      await createChartNote(db, { siteId: target, at: day(3), text: 'a', actorUserId: ownerId })
      await createChartNote(db, { siteId: target, at: day(4), text: 'b', actorUserId: ownerId })
    }

    await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })
    const purged = await purgeSitePostgres(db, { siteId })
    expect(purged.deleted['chart_notes']).toBe(2)
    expect(await countIn('chart_notes', siteId)).toBe(0)
    expect(await countIn('chart_notes', sibling)).toBe(2)
  })
})
