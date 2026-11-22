import { utcInstantSchema } from '@openanalytics/contracts'

/**
 * Chart notes: the pure half (migration 0050).
 *
 * A note is a short line of text pinned to a moment on a site's overview chart
 * (a launch, a pricing change). Owners, admins and their agents write them, and
 * every member reads them. Everything here is free of I/O, so the API, the MCP
 * tools that ride it and the tests share one definition of a legal note, and the
 * migration's CHECKs are a floor under it rather than a second opinion.
 */

/** A note is at most this many characters after trimming; mirrors
 * `chart_notes_text_check`. Counted in code points, as `char_length` counts. */
export const CHART_NOTE_TEXT_MAX_LENGTH = 280

/** The most notes one list answers with. There is no pagination: notes are
 * written by hand, and a range holding more is better narrowed than paged. */
export const CHART_NOTES_LIST_LIMIT = 500

/** Every control character except the newline (U+000A): C0, DEL and C1. A tab
 * is refused too; the note is one short paragraph or a few lines. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u

export type ChartNoteTextIssue = 'not_a_string' | 'empty' | 'too_long' | 'control_characters'

export type ChartNoteTextResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: ChartNoteTextIssue }

/**
 * Normalizes a note's text: Windows and old-Mac line breaks become `\n`, the
 * ends are trimmed, and what remains must be 1–280 characters with no control
 * character other than the newline.
 */
export function normalizeChartNoteText(raw: unknown): ChartNoteTextResult {
  if (typeof raw !== 'string') return { ok: false, code: 'not_a_string' }
  const text = raw.replace(/\r\n?/gu, '\n').trim()
  if (text.length === 0) return { ok: false, code: 'empty' }
  if (CONTROL_CHARS.test(text)) return { ok: false, code: 'control_characters' }
  if ([...text].length > CHART_NOTE_TEXT_MAX_LENGTH) return { ok: false, code: 'too_long' }
  return { ok: true, value: text }
}

export interface ChartNoteIssue {
  readonly field: string
  readonly code: string
}

export interface ChartNoteFields {
  readonly at: Date
  readonly text: string
}

export type ChartNoteCreateResult =
  | { readonly ok: true; readonly value: ChartNoteFields }
  | { readonly ok: false; readonly issues: readonly ChartNoteIssue[] }

export type ChartNotePatchResult =
  | { readonly ok: true; readonly value: Partial<ChartNoteFields> }
  | { readonly ok: false; readonly issues: readonly ChartNoteIssue[] }

const KEYS = ['at', 'text'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads the two fields; `required` decides whether an absent one is an issue. */
function readFields(
  input: Record<string, unknown>,
  required: boolean,
): { value: { at?: Date; text?: string }; issues: ChartNoteIssue[] } {
  const issues: ChartNoteIssue[] = []
  const value: { at?: Date; text?: string } = {}

  for (const key of Object.keys(input)) {
    if (!(KEYS as readonly string[]).includes(key)) issues.push({ field: key, code: 'unknown' })
  }

  if (Object.hasOwn(input, 'at')) {
    const at = utcInstantSchema.safeParse(input['at'])
    if (at.success) value.at = new Date(at.data)
    else issues.push({ field: 'at', code: 'not_a_utc_instant' })
  } else if (required) {
    issues.push({ field: 'at', code: 'required' })
  }

  if (Object.hasOwn(input, 'text')) {
    const text = normalizeChartNoteText(input['text'])
    if (text.ok) value.text = text.value
    else issues.push({ field: 'text', code: text.code })
  } else if (required) {
    issues.push({ field: 'text', code: 'required' })
  }

  return { value, issues }
}

/** Validates an untrusted `POST /notes` body; every problem is reported at once. */
export function parseChartNoteCreate(input: unknown): ChartNoteCreateResult {
  if (!isRecord(input)) return { ok: false, issues: [{ field: 'body', code: 'not_an_object' }] }
  const { value, issues } = readFields(input, true)
  if (issues.length > 0 || value.at === undefined || value.text === undefined) {
    return { ok: false, issues }
  }
  return { ok: true, value: { at: value.at, text: value.text } }
}

/**
 * Validates an untrusted `PATCH /notes/{id}` body. Absent means "leave it
 * alone"; an empty body is refused, matching the other settings `PATCH`es.
 */
export function parseChartNotePatch(input: unknown): ChartNotePatchResult {
  if (!isRecord(input)) return { ok: false, issues: [{ field: 'body', code: 'not_an_object' }] }
  const { value, issues } = readFields(input, false)
  if (issues.length > 0) return { ok: false, issues }
  if (Object.keys(value).length === 0) {
    return { ok: false, issues: [{ field: 'body', code: 'required_one_of' }] }
  }
  return { ok: true, value }
}
