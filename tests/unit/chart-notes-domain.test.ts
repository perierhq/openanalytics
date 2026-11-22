import {
  CHART_NOTE_TEXT_MAX_LENGTH,
  normalizeChartNoteText,
  parseChartNoteCreate,
  parseChartNotePatch,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * Chart notes: the pure half (migration 0050). One definition of a legal note
 * for the API, the MCP tools that ride it, and the migration's CHECK.
 */

const AT = '2026-11-10T12:00:00.000Z'

describe('a note’s text', () => {
  it('is trimmed, and 1 to 280 characters after trimming', () => {
    expect(normalizeChartNoteText('  Launched v2  ')).toEqual({ ok: true, value: 'Launched v2' })
    expect(normalizeChartNoteText('x'.repeat(CHART_NOTE_TEXT_MAX_LENGTH))).toEqual({
      ok: true,
      value: 'x'.repeat(280),
    })
    expect(normalizeChartNoteText('x'.repeat(281))).toEqual({ ok: false, code: 'too_long' })
    expect(normalizeChartNoteText('')).toEqual({ ok: false, code: 'empty' })
    expect(normalizeChartNoteText(' \n\t ')).toEqual({ ok: false, code: 'empty' })
  })

  it('counts characters the way Postgres does, so an emoji is one', () => {
    // 280 emoji are 560 UTF-16 units; `char_length` counts 280.
    expect(normalizeChartNoteText('🚀'.repeat(280)).ok).toBe(true)
    expect(normalizeChartNoteText('🚀'.repeat(281))).toEqual({ ok: false, code: 'too_long' })
  })

  it('keeps newlines and refuses every other control character', () => {
    expect(normalizeChartNoteText('Pricing\nchanged')).toEqual({
      ok: true,
      value: 'Pricing\nchanged',
    })
    // A Windows line break is a newline, not a control character.
    expect(normalizeChartNoteText('a\r\nb')).toEqual({ ok: true, value: 'a\nb' })
    for (const bad of ['a\tb', 'a\u0000b', 'a\u0007b', 'a\u001bb', 'a\u007fb', 'a\u0085b']) {
      expect(normalizeChartNoteText(bad), JSON.stringify(bad)).toEqual({
        ok: false,
        code: 'control_characters',
      })
    }
  })

  it('must be a string', () => {
    expect(normalizeChartNoteText(42)).toEqual({ ok: false, code: 'not_a_string' })
    expect(normalizeChartNoteText(null)).toEqual({ ok: false, code: 'not_a_string' })
  })
})

describe('a create body', () => {
  it('needs a UTC instant and text', () => {
    const parsed = parseChartNoteCreate({ at: AT, text: ' Launch ' })
    expect(parsed).toEqual({ ok: true, value: { at: new Date(AT), text: 'Launch' } })
  })

  it('reports every problem at once', () => {
    expect(parseChartNoteCreate({ at: '2026-11-10T12:00:00+02:00', extra: 1 })).toEqual({
      ok: false,
      issues: [
        { field: 'extra', code: 'unknown' },
        { field: 'at', code: 'not_a_utc_instant' },
        { field: 'text', code: 'required' },
      ],
    })
    expect(parseChartNoteCreate([])).toEqual({
      ok: false,
      issues: [{ field: 'body', code: 'not_an_object' }],
    })
  })
})

describe('a patch body', () => {
  it('takes either field, and refuses an empty body', () => {
    expect(parseChartNotePatch({ text: 'Moved' })).toEqual({ ok: true, value: { text: 'Moved' } })
    expect(parseChartNotePatch({ at: AT })).toEqual({ ok: true, value: { at: new Date(AT) } })
    expect(parseChartNotePatch({})).toEqual({
      ok: false,
      issues: [{ field: 'body', code: 'required_one_of' }],
    })
  })

  it('applies the create’s text rules', () => {
    expect(parseChartNotePatch({ text: 'x'.repeat(281) })).toEqual({
      ok: false,
      issues: [{ field: 'text', code: 'too_long' }],
    })
    expect(parseChartNotePatch({ text: '   ' })).toEqual({
      ok: false,
      issues: [{ field: 'text', code: 'empty' }],
    })
  })
})
