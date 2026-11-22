import { and, desc, eq, gte, lt } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { writeAudit } from './audit.ts'
import { users } from '../schema/auth.ts'
import { chartNotes } from '../schema/chart-notes.ts'

/**
 * Chart notes (migration 0050).
 *
 * Every read and write takes `siteId` and puts it in the `WHERE`, so a caller
 * authorized on one site cannot reach another site's note by holding its id.
 *
 * The author comes back as a display name only, joined from `users` on every
 * read, so a renamed account shows its new name and a deleted one shows none.
 * No user id or email address leaves this module.
 *
 * The audit rows carry the text's length, never the text: the ledger answers
 * "who changed which note, and when", and the words are the note's own.
 */

export interface ChartNoteAuthorRecord {
  /** The account's display name, or null when it never set one. */
  readonly name: string | null
}

export interface ChartNoteRecord {
  readonly id: string
  readonly siteId: string
  readonly at: Date
  readonly text: string
  /** Null once the author's account is deleted. */
  readonly createdBy: ChartNoteAuthorRecord | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

const noteColumns = {
  id: chartNotes.id,
  siteId: chartNotes.siteId,
  at: chartNotes.at,
  text: chartNotes.text,
  createdByUserId: chartNotes.createdByUserId,
  authorName: users.name,
  createdAt: chartNotes.createdAt,
  updatedAt: chartNotes.updatedAt,
}

interface NoteRow {
  readonly id: string
  readonly siteId: string
  readonly at: Date
  readonly text: string
  readonly createdByUserId: string | null
  readonly authorName: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

function toRecord(row: NoteRow): ChartNoteRecord {
  return {
    id: row.id,
    siteId: row.siteId,
    at: row.at,
    text: row.text,
    // `users.name` is NOT NULL, so an account with no name carries the empty
    // string; the contract says "unknown" with null, as the member list does.
    createdBy:
      row.createdByUserId === null
        ? null
        : { name: row.authorName === null || row.authorName.length === 0 ? null : row.authorName },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

type Executor = Pick<Database, 'select'>

async function readNote(db: Executor, siteId: string, id: string): Promise<ChartNoteRecord | null> {
  const [row] = await db
    .select(noteColumns)
    .from(chartNotes)
    .leftJoin(users, eq(users.id, chartNotes.createdByUserId))
    .where(and(eq(chartNotes.id, id), eq(chartNotes.siteId, siteId)))
    .limit(1)
  return row ? toRecord(row) : null
}

/** The text's length in characters, as `char_length` counts it. */
const textLength = (text: string): number => [...text].length

export interface ListChartNotesInput {
  readonly siteId: string
  /** Inclusive. */
  readonly from: Date
  /** Exclusive. */
  readonly to: Date
  readonly limit: number
}

/** A site's notes with `at` in `[from, to)`, newest first, `id` breaking ties. */
export async function listChartNotes(
  db: Database,
  input: ListChartNotesInput,
): Promise<ChartNoteRecord[]> {
  const rows = await db
    .select(noteColumns)
    .from(chartNotes)
    .leftJoin(users, eq(users.id, chartNotes.createdByUserId))
    .where(
      and(
        eq(chartNotes.siteId, input.siteId),
        gte(chartNotes.at, input.from),
        lt(chartNotes.at, input.to),
      ),
    )
    .orderBy(desc(chartNotes.at), desc(chartNotes.id))
    .limit(input.limit)
  return rows.map(toRecord)
}

export interface CreateChartNoteInput {
  readonly siteId: string
  readonly at: Date
  /** Already normalized by `normalizeChartNoteText`. */
  readonly text: string
  readonly actorUserId: string
}

export async function createChartNote(
  db: Database,
  input: CreateChartNoteInput,
): Promise<ChartNoteRecord> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(chartNotes)
      .values({
        siteId: input.siteId,
        at: input.at,
        text: input.text,
        createdByUserId: input.actorUserId,
      })
      .returning({ id: chartNotes.id })
    if (!inserted) throw new Error('chart note insert returned no row')

    await writeAudit(tx, {
      action: 'chart_note.created',
      actorUserId: input.actorUserId,
      actorType: 'user',
      siteId: input.siteId,
      targetType: 'chart_note',
      targetId: inserted.id,
      metadata: { text_length: textLength(input.text) },
    })

    const note = await readNote(tx, input.siteId, inserted.id)
    if (!note) throw new Error('chart note vanished inside its own transaction')
    return note
  })
}

export interface UpdateChartNoteInput {
  readonly id: string
  readonly siteId: string
  readonly at?: Date
  /** Already normalized by `normalizeChartNoteText`. */
  readonly text?: string
  readonly actorUserId: string
}

/** The updated note, or null when no note with this id exists on this site. */
export async function updateChartNote(
  db: Database,
  input: UpdateChartNoteInput,
): Promise<ChartNoteRecord | null> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(chartNotes)
      .set({
        ...(input.at === undefined ? {} : { at: input.at }),
        ...(input.text === undefined ? {} : { text: input.text }),
        updatedAt: new Date(),
      })
      .where(and(eq(chartNotes.id, input.id), eq(chartNotes.siteId, input.siteId)))
      .returning({ id: chartNotes.id })
    if (updated.length === 0) return null

    await writeAudit(tx, {
      action: 'chart_note.updated',
      actorUserId: input.actorUserId,
      actorType: 'user',
      siteId: input.siteId,
      targetType: 'chart_note',
      targetId: input.id,
      metadata: {
        fields: (['at', 'text'] as const).filter((field) => input[field] !== undefined),
        ...(input.text === undefined ? {} : { text_length: textLength(input.text) }),
      },
    })
    return readNote(tx, input.siteId, input.id)
  })
}

/**
 * Deletes a note. Returns whether a note with this id existed on this site, so
 * a replay answers "not found" rather than pretending to delete twice.
 */
export async function deleteChartNote(
  db: Database,
  input: { readonly id: string; readonly siteId: string; readonly actorUserId: string },
): Promise<{ deleted: boolean }> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(chartNotes)
      .where(and(eq(chartNotes.id, input.id), eq(chartNotes.siteId, input.siteId)))
      .returning({ text: chartNotes.text })
    const [row] = removed
    if (!row) return { deleted: false }

    await writeAudit(tx, {
      action: 'chart_note.deleted',
      actorUserId: input.actorUserId,
      actorType: 'user',
      siteId: input.siteId,
      targetType: 'chart_note',
      targetId: input.id,
      metadata: { text_length: textLength(row.text) },
    })
    return { deleted: true }
  })
}
