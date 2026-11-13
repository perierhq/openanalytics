import {
  DELETION_CLICKHOUSE_TARGETS,
  DELETION_POSTGRES_TARGETS,
  IMPORTED_REPORTS,
  IMPORTED_REPORT_TABLES,
  IMPORT_RUN_CLEANABLE_STATES,
  IMPORT_RUN_LIVE_STATES,
  IMPORT_RUN_STATES,
  IMPORT_RUN_TERMINAL_STATES,
  SITE_DELETION_TARGETS,
  defaultCutoverDate,
  importRunStatusFor,
  maxCutoverDate,
  IMPORT_DIMENSION_MAX_BYTES,
  IMPORT_TRUNCATION_SENTINEL,
  resolveCutoverDate,
  scrubImportDimension,
  scrubImportDimensionDetailed,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * The pure halves of the import pipeline: the cutover arithmetic (ADR-0032 D4),
 * the staging vocabulary and the deletion registry's agreement with it (D9).
 *
 * The cutover is worth its own suite because it is the one number in the whole
 * feature whose being wrong is *invisible*: a cutover a day late double-counts
 * the seam, a day early drops it, and either way the dashboard renders a
 * plausible chart nobody would question.
 */

describe('the cutover default (D4)', () => {
  it('is the day after the last imported day for a site with no live events', () => {
    // The primary migration case, and the one with no clamp: the whole import is
    // visible and live data starts winning the moment the tracker arrives.
    expect(defaultCutoverDate({ maxImportedDate: '2024-03-31', firstEventAt: null })).toBe(
      '2024-04-01',
    )
  })

  it('crosses month and year boundaries in UTC', () => {
    // Calendar arithmetic in UTC, never a local `Date`: the cutover is compared
    // against provider day keys, and "the next day" in the worker's zone would
    // land a day early for half the planet.
    expect(defaultCutoverDate({ maxImportedDate: '2024-02-28', firstEventAt: null })).toBe(
      '2024-02-29',
    )
    expect(defaultCutoverDate({ maxImportedDate: '2024-12-31', firstEventAt: null })).toBe(
      '2025-01-01',
    )
  })

  it('takes the earlier of the first live day and the day after the import', () => {
    expect(
      defaultCutoverDate({
        maxImportedDate: '2024-03-31',
        firstEventAt: new Date('2024-03-15T08:00:00.000Z'),
      }),
    ).toBe('2024-03-15')

    // Live data that starts after the import ends does not pull the cutover in.
    expect(
      defaultCutoverDate({
        maxImportedDate: '2024-03-31',
        firstEventAt: new Date('2024-06-01T08:00:00.000Z'),
      }),
    ).toBe('2024-04-01')
  })

  it('is null when nothing was staged', () => {
    expect(defaultCutoverDate({ maxImportedDate: null, firstEventAt: null })).toBeNull()
  })
})

describe('the cutover clamp (D4)', () => {
  it('is the day AFTER the first live day, one day looser than the default', () => {
    // Deliberate: a customer whose provider and tracker overlapped for the first
    // live day may want that day to come from the provider. That is a choice the
    // review step is for. Anything beyond it is not a choice — it hides live
    // data the site already has.
    expect(maxCutoverDate(new Date('2024-05-10T23:59:59.000Z'))).toBe('2024-05-11')
    expect(maxCutoverDate(null)).toBeNull()
  })

  it('accepts the proposal when the request omits a value', () => {
    expect(
      resolveCutoverDate({ requested: undefined, proposed: '2024-04-01', firstEventAt: null }),
    ).toEqual({ ok: true, cutoverDate: '2024-04-01' })
  })

  it('CLAMPS an omitted value rather than refusing it', () => {
    // `too_late` is a statement about a field the client sent, and a client that
    // sent nothing cannot act on it — it would be told its request is invalid
    // because of a value it never chose. The proposal can legitimately sit past
    // the limit: it is computed at *staging* time, and a first live event
    // arriving between staging and review moves the clamp underneath it.
    expect(
      resolveCutoverDate({
        requested: undefined,
        proposed: '2024-06-01',
        firstEventAt: new Date('2024-05-10T00:00:00.000Z'),
      }),
    ).toEqual({ ok: true, cutoverDate: '2024-05-11' })

    // An in-range proposal is used as it stands.
    expect(
      resolveCutoverDate({
        requested: undefined,
        proposed: '2024-05-01',
        firstEventAt: new Date('2024-05-10T00:00:00.000Z'),
      }),
    ).toEqual({ ok: true, cutoverDate: '2024-05-01' })
  })

  it('refuses an EXPLICIT value past the clamp', () => {
    // A choice is refused rather than quietly rewritten: silently publishing a
    // different boundary from the one the customer asked for is how a dashboard
    // ends up disagreeing with the request that produced it.
    expect(
      resolveCutoverDate({
        requested: '2024-05-12',
        proposed: '2024-04-01',
        firstEventAt: new Date('2024-05-10T00:00:00.000Z'),
      }),
    ).toEqual({ ok: false, code: 'too_late' })
  })

  it('accepts a value earlier than the proposal', () => {
    // Publishing less than was staged is legitimate — the read path filters
    // `date < cutover`, so the extra rows are simply never shown.
    expect(
      resolveCutoverDate({ requested: '2024-02-01', proposed: '2024-04-01', firstEventAt: null }),
    ).toEqual({ ok: true, cutoverDate: '2024-02-01' })
  })

  it('refuses a value that is not a calendar date', () => {
    for (const bad of ['2024-02-31', '2024-13-01', 'tomorrow', '', 20240401, null]) {
      expect(
        resolveCutoverDate({ requested: bad, proposed: '2024-04-01', firstEventAt: null }).ok,
        JSON.stringify(bad),
      ).toBe(bad === null)
    }
  })

  it('refuses to resolve anything when nothing was staged and nothing was asked for', () => {
    expect(
      resolveCutoverDate({ requested: undefined, proposed: null, firstEventAt: null }),
    ).toEqual({ ok: false, code: 'unavailable' })
  })
})

describe('the run state vocabulary', () => {
  it('partitions every state into live or terminal, with none in both', () => {
    const live = new Set<string>(IMPORT_RUN_LIVE_STATES)
    const terminal = new Set<string>(IMPORT_RUN_TERMINAL_STATES)
    for (const state of IMPORT_RUN_STATES) {
      expect(live.has(state) !== terminal.has(state), state).toBe(true)
    }
    expect(live.size + terminal.size).toBe(IMPORT_RUN_STATES.length)
  })

  it('makes every terminal state cleanable except `published`', () => {
    // The cleanable set is *derived* from the terminal one so the two cannot
    // drift: a state added as terminal is cleanable by default, which is the
    // safe direction — the alternative is a new terminal state whose staged rows
    // nothing ever purges. `published` is the single exclusion, because those
    // rows are the site's live imported history.
    expect([...IMPORT_RUN_CLEANABLE_STATES].sort()).toEqual(
      ['discarded', 'failed', 'rolled_back', 'superseded'].sort(),
    )
    expect(IMPORT_RUN_CLEANABLE_STATES).not.toContain('published')
  })

  it('lets a live job refine the status of the three phases it owns', () => {
    // The difference between "this is working" and "this keeps failing and will
    // be tried again" — exactly what a support conversation turns on.
    expect(importRunStatusFor('processing')).toBe('running')
    expect(importRunStatusFor('processing', 'failed_retryable')).toBe('failed_retryable')
    expect(importRunStatusFor('publishing', 'failed_retryable')).toBe('failed_retryable')
    // And leaves the states no job owns alone.
    expect(importRunStatusFor('ready_for_review', 'failed_retryable')).toBe('running')
    expect(importRunStatusFor('published', 'failed_retryable')).toBe('succeeded')
  })
})

describe('the staging vocabulary and the deletion registry (D9)', () => {
  it('names one ClickHouse table per report, and the registry covers all eight', () => {
    // The registry restates the names as literals on purpose — a snapshotted
    // deletion vocabulary is a fixed decision, not a derivation — so this is the
    // check that keeps the two honest. Derived, a renamed table would silently
    // stop being purged.
    const tables = IMPORTED_REPORTS.map((report) => IMPORTED_REPORT_TABLES[report])
    expect(new Set(tables).size).toBe(8)
    for (const table of tables) {
      expect(DELETION_CLICKHOUSE_TARGETS as readonly string[], table).toContain(table)
    }
  })

  it('has settled on the 64-target snapshot', () => {
    // 30 ClickHouse + 5 Redis + 19 Postgres + 1 object. The number changed on
    // purpose — 35 before M11, 38 after its CP1, 46 after CP2, 47 once CP4 added
    // `export_runs` (ADR-0032, D9), 48 once M12 CP1 added `revenue_credentials`,
    // 51 once CP2 added the three ingest tables, 53 once CP3 added
    // `revenue_events` on the ClickHouse side and `revenue_match_hints` on the
    // Postgres side (ADR-0033, D8 and its CP3 amendment), 55 once CP4 added
    // `revenue_attributions` (ClickHouse 0017) and `revenue_attribution_state`
    // (Postgres 0036), and 57 once CP5 added the `revenue_1h`/`revenue_1d`
    // rollups (ClickHouse 0018) — the milestone's end state, and the assertions
    // that name it are the contract.
    //
    // The object target deliberately did NOT multiply: an export's chunk keys
    // join the one snapshotted key list beside the import archives, and revenue
    // adds no object target at all because provider payload bodies are never
    // persisted.
    //
    // ADR-0068 removed `events_preview` (migration 0022) — the first time the
    // ClickHouse set has ever shrunk.
    // ADR-0079 D1 books the eight `*_15m` rollups (ClickHouse migration 0025),
    // taking ClickHouse 34 -> 42 and the total 62 -> 70. One 15m twin per
    // additive 1h family, nothing on the Postgres side: the read path does not
    // change in that step, so no row, key or object moved with it.
    // ADR-0079's second step books the other two 15m grains -- the session
    // finalizer's `session_rollups_15m` and the attribution job's `revenue_15m`
    // (ClickHouse migration 0026) -- taking ClickHouse 42 -> 44 and the total
    // 70 -> 72. Written by the worker rather than by a materialized view, which
    // changes how they are granted and filled and changes nothing about how
    // they are purged.
    // ClickHouse migration 0029 (v0.8.0) dropped the ten hour tables — the
    // eight `*_1h` view targets, `session_rollups_1h` and `revenue_1h` —
    // taking ClickHouse 44 -> 34 and the total 72 -> 62. Nothing had written
    // them since 0027, and the 15m backfill's gate reads `events_raw` now.
    // ClickHouse migration 0030 (DataFast gap 6) books the two custom-event
    // property breakdowns, taking ClickHouse 34 -> 36 and the total 62 -> 64.
    expect(DELETION_CLICKHOUSE_TARGETS).toHaveLength(36)
    expect(DELETION_CLICKHOUSE_TARGETS).toContain('custom_event_properties_15m')
    expect(DELETION_CLICKHOUSE_TARGETS).toContain('custom_event_properties_1d')
    for (const dropped of [
      'metrics_1h',
      'pages_1h',
      'sources_1h',
      'geography_1h',
      'devices_1h',
      'custom_events_1h',
      'performance_1h',
      'custom_event_samples_1h',
      'session_rollups_1h',
      'revenue_1h',
    ]) {
      expect(DELETION_CLICKHOUSE_TARGETS).not.toContain(dropped)
    }
    for (const family of [
      'metrics',
      'pages',
      'sources',
      'geography',
      'devices',
      'custom_events',
      'performance',
      'custom_event_samples',
    ]) {
      expect(DELETION_CLICKHOUSE_TARGETS).toContain(`${family}_15m`)
    }
    expect(DELETION_CLICKHOUSE_TARGETS).toContain('revenue_events')
    expect(DELETION_CLICKHOUSE_TARGETS).toContain('revenue_attributions')
    expect(DELETION_CLICKHOUSE_TARGETS).toContain('revenue_1d')
    expect(DELETION_POSTGRES_TARGETS).toContain('export_runs')
    expect(DELETION_POSTGRES_TARGETS).toContain('revenue_credentials')
    expect(DELETION_POSTGRES_TARGETS).toContain('revenue_provider_events')
    expect(DELETION_POSTGRES_TARGETS).toContain('revenue_objects')
    expect(DELETION_POSTGRES_TARGETS).toContain('revenue_sync_state')
    expect(DELETION_POSTGRES_TARGETS).toContain('revenue_match_hints')
    expect(DELETION_POSTGRES_TARGETS).toContain('revenue_attribution_state')
    // M13 CP1 books the event builder's two tables (ADR-0034, D9; Postgres
    // migration 0038), taking Postgres 19 -> 21 and the total 57 -> 59.
    // (`events_preview`, which M13 CP5 added on the ClickHouse side, was
    // removed again by ADR-0068 — migration 0022 drops the table.)
    expect(DELETION_POSTGRES_TARGETS).toContain('event_definitions')
    expect(DELETION_POSTGRES_TARGETS).toContain('event_definition_versions')
    expect(DELETION_CLICKHOUSE_TARGETS).not.toContain('events_preview')
    // ADR-0038 D8 books the custom-events decoration's two tables (ClickHouse
    // migration 0021), taking ClickHouse 33 -> 35 and the total 60 -> 62. An
    // aggregate outlives the rows it came from, so these are targets in their
    // own right rather than something purging `events_raw` handles.
    expect(DELETION_CLICKHOUSE_TARGETS).toContain('custom_event_samples_1d')
    // ADR-0045 D8 books the widget configuration table (Postgres migration
    // 0048), taking Postgres 21 -> 22 and the total 62 -> 63. One table and not
    // two: a widget's origin allowlist is a bounded `text[]` on the row rather
    // than a child table, so there is nothing beside it to enumerate. The rows
    // are live public credentials — every id sits in the HTML of a page that is
    // not ours — which is why the purge names them instead of leaving them to
    // the `sites` cascade.
    expect(DELETION_POSTGRES_TARGETS).toContain('widgets')
    expect(DELETION_POSTGRES_TARGETS).toHaveLength(22)
    expect(SITE_DELETION_TARGETS).toHaveLength(64)
  })
})

describe('dimension scrubbing (D6.3)', () => {
  it('removes control characters rather than escaping them', () => {
    // A CSV cell containing a newline, a NUL or an ANSI escape reaches a
    // dashboard cell, an export file and an operator's terminal, and every one
    // of those interprets at least one of them.
    expect(scrubImportDimension('Chrome [31m')).toBe('Chrome [31m')
    expect(scrubImportDimension('one\ntwo')).toBe('one two')
    expect(scrubImportDimension('nul\0here')).toBe('nul here')
  })

  it('collapses whitespace so two spellings are not two rows', () => {
    expect(scrubImportDimension('  Chrome   Mobile  ')).toBe('Chrome Mobile')
  })

  it('caps the value in BYTES, which is what the budget is about', () => {
    // Bytes rather than characters, because the reason for the cap is storage and
    // transport — every later ClickHouse row and every export file — and those are
    // measured in bytes. A 512-*character* cap would admit 2 KiB of four-byte code
    // points, which is four times the ceiling the number is supposed to express.
    const scrubbed = scrubImportDimension('x'.repeat(10_000))
    expect(Buffer.byteLength(scrubbed, 'utf8')).toBe(IMPORT_DIMENSION_MAX_BYTES)
    expect(scrubbed.endsWith(IMPORT_TRUNCATION_SENTINEL)).toBe(true)

    const astral = String.fromCodePoint(0x1f600).repeat(1_000)
    expect(Buffer.byteLength(scrubImportDimension(astral), 'utf8')).toBeLessThanOrEqual(
      IMPORT_DIMENSION_MAX_BYTES,
    )
  })

  it('marks a truncated value rather than shortening it silently', () => {
    // A silently shortened page path is a row the customer cannot find by
    // searching for its real URL, and — worse — a distinct merge key from the
    // live row of the same page. The sentinel makes the loss visible and the flag
    // makes the adapter able to count it for the reviewer.
    const short = scrubImportDimensionDetailed('/pricing')
    expect(short).toEqual({ value: '/pricing', truncated: false })

    const long = scrubImportDimensionDetailed('x'.repeat(10_000))
    expect(long.truncated).toBe(true)
    expect(long.value.endsWith(IMPORT_TRUNCATION_SENTINEL)).toBe(true)
  })

  it('cuts on a code point, never through a surrogate pair', () => {
    // The budget is spent in bytes but the cut lands between characters: a cut
    // through an astral character's surrogate pair is not a character at all —
    // `JSON.stringify` emits an unpaired escape, the ClickHouse client sends
    // invalid UTF-8, and the dashboard renders a replacement glyph.
    const astral = String.fromCodePoint(0x1f600)
    const scrubbed = scrubImportDimension(`${'a'.repeat(500)}${astral.repeat(20)}`)

    expect(Buffer.byteLength(scrubbed, 'utf8')).toBeLessThanOrEqual(IMPORT_DIMENSION_MAX_BYTES)
    // A round-trip through UTF-8 is lossless: no lone surrogate survived.
    expect(Buffer.from(scrubbed, 'utf8').toString('utf8')).toBe(scrubbed)
  })

  it('leaves a value inside the byte budget exactly as it was', () => {
    const value = String.fromCodePoint(0x1f600).repeat(100)
    expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(IMPORT_DIMENSION_MAX_BYTES)
    expect(scrubImportDimension(value)).toBe(value)
  })
})
