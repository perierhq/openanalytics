/**
 * The mentions list cursor (migration 0048).
 *
 * The same design as `revenue-cursor.ts`, over a different keyset:
 * `(posted_at, id)` descending, where `id` is the row's UUID and breaks ties
 * between posts made in the same second.
 *
 * It carries no authority and is not signed: the site comes from the path and
 * is checked on every request, so an edited cursor can only move the caller
 * within their own site's list. What it must do is fail loudly on anything
 * malformed — `decodeMentionsCursor` returns null and the route answers 400,
 * never a silent restart from page one.
 *
 * Format: `base64url("men1|<posted_at ms>|<uuid>")`. The `men1` prefix is a
 * version tag, so a future keyset change rejects old cursors rather than
 * misreading them.
 */

const VERSION = 'men1'
const SEPARATOR = '|'

/** The contract's own bound (`cursorSchema`), enforced before any decoding. */
const MAX_CURSOR_LENGTH = 512

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export interface MentionsCursor {
  readonly postedAtMs: number
  readonly id: string
}

export function encodeMentionsCursor(cursor: MentionsCursor): string {
  const payload = [VERSION, String(cursor.postedAtMs), cursor.id].join(SEPARATOR)
  return Buffer.from(payload, 'utf8').toString('base64url')
}

/** Decodes a cursor, or null if it is anything other than one this server wrote. */
export function decodeMentionsCursor(raw: string): MentionsCursor | null {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return null
  if (!/^[A-Za-z0-9_-]+$/u.test(raw)) return null

  const decoded = Buffer.from(raw, 'base64url').toString('utf8')
  const parts = decoded.split(SEPARATOR)
  if (parts.length !== 3) return null
  const [version, ms, id] = parts as [string, string, string]
  if (version !== VERSION) return null

  if (!/^\d+$/u.test(ms)) return null
  const postedAtMs = Number(ms)
  if (!Number.isSafeInteger(postedAtMs)) return null

  if (!UUID_PATTERN.test(id)) return null
  return { postedAtMs, id: id.toLowerCase() }
}
