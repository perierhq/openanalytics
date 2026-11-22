import { ApiError, utcInstantSchema } from '@openanalytics/contracts'
import {
  CHART_NOTES_LIST_LIMIT,
  parseChartNoteCreate,
  parseChartNotePatch,
  type ChartNoteIssue,
} from '@openanalytics/domain'
import {
  createChartNote,
  deleteChartNote,
  listChartNotes,
  updateChartNote,
  type ChartNoteRecord,
  type Database,
} from '@openanalytics/postgres'
import { Hono } from 'hono'
import { requireCapability, siteMembership, type ApiVariables } from './middleware.ts'

/**
 * Chart notes (migration 0050): short notes pinned to a moment on the site's
 * overview chart.
 *
 * **Reading is membership-only**, viewer included: a note is written for the
 * people who read the chart. **Writing requires `site:settings`** (owner or
 * admin), the capability saved funnels and widgets use: a note is the site's
 * own annotation, not destructive and carrying no personal data.
 *
 * Every route has a `GRANT_WRITE_ALLOWLIST` row: the list with
 * `analytics:read` (the `list_notes` MCP tool), the writes with `notes:write`
 * (`create_note`, `update_note`, `delete_note`). The scope is a ceiling and the
 * role is the authority, so a viewer's grant writes nothing.
 *
 * The author is named by display name only. A note never carries its author's
 * user id or email address, and names nobody once the account is deleted.
 */

type Env = { Variables: ApiVariables }

/** The shape every id this API mints has; anything else cannot be a note. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function noteJson(note: ChartNoteRecord) {
  return {
    id: note.id,
    at: note.at.toISOString(),
    text: note.text,
    created_by: note.createdBy === null ? null : { name: note.createdBy.name },
    created_at: note.createdAt.toISOString(),
    updated_at: note.updatedAt.toISOString(),
  }
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'A JSON request body is required')
  }
}

function invalidNote(issues: readonly ChartNoteIssue[]): never {
  throw new ApiError('VALIDATION_FAILED', 'The note is not valid', {
    details: { issues: issues.map((issue) => ({ field: issue.field, code: issue.code })) },
  })
}

/** The note id from the path, or a 404 when it cannot be one. */
function noteId(raw: string | undefined): string {
  if (raw === undefined || !UUID.test(raw)) {
    throw new ApiError('NOT_FOUND', 'No note with this id on this site')
  }
  return raw
}

/** Validates the list query; every problem is reported at once as a 400. */
function parseRange(query: Record<string, string | undefined>): { from: Date; to: Date } {
  const issues: { path: string; message: string }[] = []
  const from = utcInstantSchema.safeParse(query['from'])
  if (!from.success) issues.push({ path: 'from', message: 'from must be an ISO-8601 UTC instant' })
  const to = utcInstantSchema.safeParse(query['to'])
  if (!to.success) issues.push({ path: 'to', message: 'to must be an ISO-8601 UTC instant' })
  if (from.success && to.success && new Date(from.data) > new Date(to.data)) {
    issues.push({ path: 'to', message: 'to must not be before from' })
  }
  if (issues.length > 0) {
    throw new ApiError('VALIDATION_FAILED', 'Invalid notes query parameters', {
      details: { issues },
    })
  }
  return { from: new Date(from.data as string), to: new Date(to.data as string) }
}

export function createNoteRoutes(deps: { db: Database }): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()

  const base = '/sites/:site_id/notes'
  app.use(base, siteMembership(db))
  app.use(`${base}/*`, siteMembership(db))

  app.get(base, async (c) => {
    const { siteId } = c.get('membership')
    const { from, to } = parseRange(c.req.query())
    const rows = await listChartNotes(db, { siteId, from, to, limit: CHART_NOTES_LIST_LIMIT })
    return c.json({ items: rows.map(noteJson) })
  })

  app.post(base, requireCapability('site:settings'), async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const parsed = parseChartNoteCreate(await readJson(c))
    if (!parsed.ok) invalidNote(parsed.issues)
    const created = await createChartNote(db, {
      siteId,
      at: parsed.value.at,
      text: parsed.value.text,
      actorUserId: actor.id,
    })
    return c.json(noteJson(created), 201)
  })

  app.patch(`${base}/:note_id`, requireCapability('site:settings'), async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const id = noteId(c.req.param('note_id'))
    const parsed = parseChartNotePatch(await readJson(c))
    if (!parsed.ok) invalidNote(parsed.issues)
    const updated = await updateChartNote(db, {
      id,
      siteId,
      ...(parsed.value.at === undefined ? {} : { at: parsed.value.at }),
      ...(parsed.value.text === undefined ? {} : { text: parsed.value.text }),
      actorUserId: actor.id,
    })
    if (!updated) throw new ApiError('NOT_FOUND', 'No note with this id on this site')
    return c.json(noteJson(updated))
  })

  app.delete(`${base}/:note_id`, requireCapability('site:settings'), async (c) => {
    const actor = c.get('user')
    const { siteId } = c.get('membership')
    const id = noteId(c.req.param('note_id'))
    const { deleted } = await deleteChartNote(db, { id, siteId, actorUserId: actor.id })
    if (!deleted) throw new ApiError('NOT_FOUND', 'No note with this id on this site')
    return c.body(null, 204)
  })

  return app
}
