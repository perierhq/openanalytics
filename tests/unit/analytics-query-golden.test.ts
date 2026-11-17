import { describe, expect, it } from 'vitest'
import {
  assembleSparkline,
  chooseResolution,
  classifyTimezoneAlignment,
  derivePreviousPeriod,
  siteCardWindow,
  timezoneOffsetMinutes,
} from '@openanalytics/domain'
import { isHalfOpenContained } from '@openanalytics/contracts'
import { findOperation } from '../../apps/query-gateway/src/operations.ts'

/**
 * Milestone 7 acceptance criterion 4 (docs snapshot 04): "the timezone, DST,
 * half-open range and comparison golden tests pass."
 *
 * These are the frozen numeric cases behind the resolution selector and the
 * comparison-range derivation. They are deliberately concrete — real IANA zones,
 * real DST dates, exact instants — so a change to the timezone maths that moves a
 * bucket by an hour, or a comparison window off by a period, fails here with a
 * legible diff rather than in a dashboard.
 */

const NY = 'America/New_York'
const LORD_HOWE = 'Australia/Lord_Howe'
const LONDON = 'Europe/London'

describe('interior sampling (the flagged classify defect)', () => {
  // The defect this pins is *sampling only the endpoints*. Europe/London is the
  // case that still has teeth after ADR-0079 step 3: it is offset zero at both
  // ends of a calendar year and +01:00 through the summer between. An end-only
  // classifier calls the year `utc`, reads `metrics_1d` straight, and gives
  // every British summer day the wrong twenty-four hours. The interior walk is
  // what demotes it to `local` and routes it through the composed-day path.
  const winter2026 = new Date('2026-01-15T00:00:00.000Z')
  const summer2026 = new Date('2026-07-15T00:00:00.000Z')
  const winter2027 = new Date('2027-01-15T00:00:00.000Z')

  it('both endpoints are UTC but the interior is not', () => {
    expect(timezoneOffsetMinutes(winter2026, LONDON)).toBe(0)
    expect(timezoneOffsetMinutes(winter2027, LONDON)).toBe(0)
    expect(timezoneOffsetMinutes(summer2026, LONDON)).toBe(60) // BST
  })

  it('classifies the winter-to-winter range as local, not by its ends', () => {
    expect(classifyTimezoneAlignment(winter2026, winter2027, LONDON)).toBe('local')
  })

  it('chooseResolution composes that range rather than reading the UTC day table', () => {
    const decision = chooseResolution({
      from: '2026-01-15T00:00:00.000Z',
      to: '2027-01-15T00:00:00.000Z',
      timezone: LONDON,
    })
    expect(decision.servable).toBe(true)
    expect(decision.timezoneAlignment).toBe('local')
    expect(decision.sourceRollup).toBe('15m')
    expect(decision.composeDayFromHour).toBe(true)
  })

  // Lord Howe is +11:00 in the austral summer (Oct–Apr) and +10:30 through the
  // standard-time months between. Before ADR-0079 that half hour was the reason
  // a summer-to-summer range was refused; fifteen-minute buckets fall wholly
  // inside a +10:30 local day, so the same range is now served — by the same
  // interior walk, which still sees both offsets and now approves both.
  it('serves the summer-to-summer Lord Howe range the hour atom refused', () => {
    const summer2027 = new Date('2027-01-15T00:00:00.000Z')
    expect(timezoneOffsetMinutes(summer2026, LORD_HOWE) % 60).not.toBe(0) // +10:30
    expect(classifyTimezoneAlignment(winter2026, summer2027, LORD_HOWE)).toBe('local')

    const decision = chooseResolution({
      from: '2026-01-15T00:00:00.000Z',
      to: '2027-01-15T00:00:00.000Z',
      timezone: LORD_HOWE,
    })
    expect(decision.servable).toBe(true)
    expect(decision.sourceRollup).toBe('15m')
  })
})

describe('DST days route through the composed-day path', () => {
  // The composed day path (composeDayFromHour) is what makes a 23h spring-forward
  // day and a 25h fall-back day come out right: ClickHouse's toStartOfDay(tz)
  // groups the atom rollup by local day, so a short/long day gets exactly its own
  // hours. The domain selector's job is to *route* a non-UTC day there and to keep
  // the range bucket-aligned; the 23/25h arithmetic itself is proven in the
  // ClickHouse rollup suite.
  it('a US spring-forward local day composes from the atom rollup', () => {
    // 2026-03-08 is the US spring-forward day (02:00 → 03:00 local). The local day
    // starts at 05:00Z (EST, -05:00) and the next local day starts at 04:00Z
    // (EDT, -04:00) — a 23-hour UTC span, both endpoints UTC-hour aligned.
    const decision = chooseResolution({
      from: '2026-03-08T05:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
      timezone: NY,
    })
    expect(decision.grain).toBe('minute') // 23h ≤ the 24h minute band
    // Non-UTC zone: even at minute grain the range is bucket-aligned and servable.
    expect(decision.servable).toBe(true)
    expect(decision.timezoneAlignment).toBe('local')
  })

  it('a multi-month non-UTC day range composes from the atom rollup across DST', () => {
    const decision = chooseResolution({
      from: '2026-01-01T05:00:00.000Z',
      to: '2026-06-01T04:00:00.000Z',
      timezone: NY,
    })
    expect(decision.grain).toBe('day')
    expect(decision.sourceRollup).toBe('15m')
    expect(decision.composeDayFromHour).toBe(true)
    expect(decision.servable).toBe(true)
  })
})

describe('half-open boundary exactness', () => {
  const range = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' }

  it('includes from, excludes to', () => {
    expect(isHalfOpenContained(range, '2026-07-01T00:00:00.000Z')).toBe(true)
    expect(isHalfOpenContained(range, '2026-07-07T23:59:59.999Z')).toBe(true)
    // An event exactly at `to` belongs to the next range, never this one.
    expect(isHalfOpenContained(range, '2026-07-08T00:00:00.000Z')).toBe(false)
  })
})

describe('comparison-range derivation', () => {
  it('previous period is the equal-length window ending where the current begins', () => {
    const previous = derivePreviousPeriod({
      from: '2026-07-08T00:00:00.000Z',
      to: '2026-07-15T00:00:00.000Z',
    })
    expect(previous).toEqual({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-08T00:00:00.000Z',
    })
  })

  it('is contiguous and non-overlapping with the current range', () => {
    const current = { from: '2026-07-08T00:00:00.000Z', to: '2026-07-15T00:00:00.000Z' }
    const previous = derivePreviousPeriod(current)
    expect(previous?.to).toBe(current.from) // touches at the boundary
    // Half-open, so the shared instant is in the current range only.
    expect(isHalfOpenContained(current, previous!.to)).toBe(true)
    expect(isHalfOpenContained(previous!, previous!.to)).toBe(false)
  })

  it('keeps an equal UTC span across a DST boundary (span-based, not calendar)', () => {
    // A 7-day current range whose previous period crosses the US spring-forward.
    const previous = derivePreviousPeriod({
      from: '2026-03-11T00:00:00.000Z',
      to: '2026-03-18T00:00:00.000Z',
    })
    const spanMs = Date.parse(previous!.to) - Date.parse(previous!.from)
    expect(spanMs).toBe(7 * 86_400_000)
  })

  // A period still in progress compares like for like: the previous period
  // starts where it always did (one span before `from`) and covers only as
  // much as the current period has had so far, so 09:00 today is set against
  // 00:00-09:00 yesterday rather than all of yesterday.
  it('cuts an unfinished day at the elapsed point: 00:00-09:00 today vs 00:00-09:00 yesterday', () => {
    const previous = derivePreviousPeriod(
      { from: '2026-07-23T00:00:00.000Z', to: '2026-07-24T00:00:00.000Z' },
      { asOf: '2026-07-23T09:00:00.000Z', stepMs: 15 * 60_000 },
    )
    expect(previous).toEqual({
      from: '2026-07-22T00:00:00.000Z',
      to: '2026-07-22T09:00:00.000Z',
    })
  })

  it('cuts an unfinished day in a non-UTC zone at the same elapsed point', () => {
    // Tokyo's today is 15:00Z the day before to 15:00Z; as of 09:07 Tokyo
    // (00:07Z) the read has reached into its 09:00 quarter, so the previous
    // day is cut at the end of that quarter: 00:00-09:15 Tokyo yesterday.
    const previous = derivePreviousPeriod(
      { from: '2026-07-22T15:00:00.000Z', to: '2026-07-23T15:00:00.000Z' },
      { asOf: '2026-07-23T00:07:00.000Z', stepMs: 15 * 60_000 },
    )
    expect(previous).toEqual({
      from: '2026-07-21T15:00:00.000Z',
      to: '2026-07-22T00:15:00.000Z',
    })
  })

  it('cuts an unfinished 7 days at the same offset into the previous 7', () => {
    const previous = derivePreviousPeriod(
      { from: '2026-07-17T00:00:00.000Z', to: '2026-07-24T00:00:00.000Z' },
      { asOf: '2026-07-23T14:40:00.000Z', stepMs: 15 * 60_000 },
    )
    expect(previous).toEqual({
      from: '2026-07-10T00:00:00.000Z',
      to: '2026-07-16T14:45:00.000Z',
    })
  })

  it('leaves a finished period whole', () => {
    const previous = derivePreviousPeriod(
      { from: '2026-07-22T00:00:00.000Z', to: '2026-07-23T00:00:00.000Z' },
      { asOf: '2026-07-23T09:00:00.000Z', stepMs: 15 * 60_000 },
    )
    expect(previous).toEqual({
      from: '2026-07-21T00:00:00.000Z',
      to: '2026-07-22T00:00:00.000Z',
    })
  })

  it('compares whole days where the read can only resolve whole days', () => {
    // A UTC-day rollup has no bucket smaller than a day: the cut rounds up to
    // the end of the day `as_of` is in, which is the full period here.
    const previous = derivePreviousPeriod(
      { from: '2026-05-25T00:00:00.000Z', to: '2026-07-24T00:00:00.000Z' },
      { asOf: '2026-07-23T09:00:00.000Z', stepMs: 86_400_000 },
    )
    expect(previous).toEqual({
      from: '2026-03-26T00:00:00.000Z',
      to: '2026-05-25T00:00:00.000Z',
    })
  })

  it('keeps the whole previous period when as_of is unknown', () => {
    const range = { from: '2026-07-23T00:00:00.000Z', to: '2026-07-24T00:00:00.000Z' }
    const whole = { from: '2026-07-22T00:00:00.000Z', to: '2026-07-23T00:00:00.000Z' }
    expect(derivePreviousPeriod(range, { asOf: null, stepMs: 900_000 })).toEqual(whole)
    expect(derivePreviousPeriod(range, { stepMs: 900_000 })).toEqual(whole)
    expect(derivePreviousPeriod(range, { asOf: 'garbage', stepMs: 900_000 })).toEqual(whole)
  })

  it('has nothing to compare when the period has not started', () => {
    expect(
      derivePreviousPeriod(
        { from: '2026-07-24T00:00:00.000Z', to: '2026-07-25T00:00:00.000Z' },
        { asOf: '2026-07-23T09:00:00.000Z', stepMs: 900_000 },
      ),
    ).toBeNull()
  })

  it('returns null for a malformed or inverted range', () => {
    expect(derivePreviousPeriod({ from: 'not-a-date', to: '2026-07-01T00:00:00.000Z' })).toBeNull()
    expect(
      derivePreviousPeriod({ from: '2026-07-15T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' }),
    ).toBeNull()
  })
})

describe('UTC and non-UTC agree where they must', () => {
  it('a whole number of UTC days is day-aligned and served directly for UTC', () => {
    const decision = chooseResolution({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
      timezone: 'UTC',
    })
    expect(decision.sourceRollup).toBe('1d')
    expect(decision.composeDayFromHour).toBe(false)
  })

  it('the same span for a UTC-offset-zero IANA zone classifies as utc too', () => {
    // Etc/UTC and UTC are distinct identifiers that must resolve identically.
    const a = classifyTimezoneAlignment(
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-04-01T00:00:00.000Z'),
      'UTC',
    )
    const b = classifyTimezoneAlignment(
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-04-01T00:00:00.000Z'),
      'Etc/UTC',
    )
    expect(a).toBe('utc')
    expect(b).toBe('utc')
  })
})

/**
 * The site-card reads, frozen (ADR-0080).
 *
 * Two golden cases, and they pin the two things that are silently wrong rather
 * than loudly broken when they drift:
 *
 *   * the **statement**, because the total branch and the week branch differ
 *     only by one filter line, and a copy-paste that gave the totals the week
 *     window's lower bound would return plausible numbers that are simply not
 *     all-time;
 *   * the **window**, because "the last 40 ISO weeks including this one" is
 *     arithmetic with an off-by-one in every direction and nothing downstream
 *     can tell a 39-week window from a 40-week one.
 */
describe('site card reads (ADR-0080)', () => {
  it('freezes the per-site all-time + weekly statement', () => {
    expect(findOperation('analytics.sites_all_time')?.sql).toMatchInlineSnapshot(`
      "SELECT
        t.site_id AS site_id,
        toUInt8(0) AS is_total,
        toDateTime64(toStartOfWeek(t.bucket_start, 1), 3, 'UTC') AS week,
        sumIf(t.events, t.event_type = 'page_view') AS pageviews,
        uniqMergeIf(t.visitors, t.event_type = 'page_view') AS visitors
      FROM metrics_1d AS t
      WHERE t.site_id IN {site_ids:Array(UUID)}
        AND t.bucket_start >= toDateTime64({from:String}, 3, 'UTC')
        AND t.bucket_start < toDateTime64({to:String}, 3, 'UTC')
      GROUP BY t.site_id, week
      UNION ALL
      SELECT
        t.site_id AS site_id,
        toUInt8(1) AS is_total,
        toDateTime64(0, 3, 'UTC') AS week,
        sumIf(t.events, t.event_type = 'page_view') AS pageviews,
        uniqMergeIf(t.visitors, t.event_type = 'page_view') AS visitors
      FROM metrics_1d AS t
      WHERE t.site_id IN {site_ids:Array(UUID)}
        AND t.bucket_start < toDateTime64({to:String}, 3, 'UTC')
      GROUP BY t.site_id"
    `)
  })

  it('freezes the per-site all-time revenue statement', () => {
    expect(findOperation('analytics.sites_all_time_revenue')?.sql).toMatchInlineSnapshot(`
      "SELECT
        cur.site_id AS site_id,
        sum(cur.net_minor) AS net_minor
      FROM (
        SELECT
          rr.site_id AS site_id,
          argMax(rr.net_minor, rr.generation) AS net_minor
        FROM revenue_1d AS rr
        WHERE rr.site_id IN {site_ids:Array(UUID)}
          AND rr.bucket_start < toDateTime64({to:String}, 3, 'UTC')
        GROUP BY rr.site_id, rr.bucket_start
      ) AS cur
      GROUP BY cur.site_id"
    `)
  })

  it('spans exactly forty Mondays and ends on the week in progress', () => {
    // A Saturday, so `now` is mid-week: the window must still close on the
    // *next* Monday, and the current, half-filled week must be the last point.
    const window = siteCardWindow(new Date('2026-09-12T18:30:00.000Z'))

    expect(window.from).toBe('2025-12-08T00:00:00.000Z')
    expect(window.to).toBe('2026-09-14T00:00:00.000Z')
    expect(window.weekStarts).toHaveLength(40)
    expect(window.weekStarts.at(0)).toBe('2025-12-08T00:00:00.000Z')
    // The Monday of the week containing `now` — present, not excluded for being
    // incomplete.
    expect(window.weekStarts.at(-1)).toBe('2026-09-07T00:00:00.000Z')
    // Every endpoint is a UTC Monday midnight, which is what the gateway's
    // parameter schema refuses anything else for.
    for (const start of [...window.weekStarts, window.to]) {
      expect(new Date(start).getUTCDay(), start).toBe(1)
      expect(start.endsWith('T00:00:00.000Z'), start).toBe(true)
    }
  })

  it('anchors on Monday itself without sliding a week', () => {
    // The boundary case: `now` IS a Monday midnight. The current week is the one
    // starting at that instant, so `to` is seven days later — not that instant.
    const window = siteCardWindow(new Date('2026-09-07T00:00:00.000Z'))
    expect(window.to).toBe('2026-09-14T00:00:00.000Z')
    expect(window.weekStarts.at(-1)).toBe('2026-09-07T00:00:00.000Z')
  })

  it('starts a young site at its first event and zero-fills only inside its life', () => {
    const window = siteCardWindow(new Date('2026-09-12T18:30:00.000Z'))
    const weekly = new Map([
      ['2026-08-24T00:00:00.000Z', 140],
      // 2026-08-31 deliberately absent — a real week with no visitors.
      ['2026-09-07T00:00:00.000Z', 12],
    ])

    const series = assembleSparkline({
      window,
      // Mid-week, three weeks back: the series starts at that week's Monday.
      firstEventAt: new Date('2026-08-26T11:04:00.000Z'),
      weekly,
    })

    // Three points, not forty. The 37 weeks before this site existed are not
    // zeros — nothing was measured in them — and drawing them as zeros would
    // show a launch spike that is really just the site's birth.
    expect(series).toEqual([140, 0, 12])
  })

  it('starts at data older than first_event_at rather than trimming it away', () => {
    const window = siteCardWindow(new Date('2026-09-12T18:30:00.000Z'))
    const series = assembleSparkline({
      window,
      // Later than the data below — the ADR-0027 non-backfill case, measured
      // live on one production site in six.
      firstEventAt: new Date('2026-08-26T11:04:00.000Z'),
      weekly: new Map([
        ['2026-08-17T00:00:00.000Z', 7],
        ['2026-09-07T00:00:00.000Z', 12],
      ]),
    })
    // Starts at the data (08-17), not at the field's week (08-24), and the two
    // weeks between are real zeros.
    expect(series).toEqual([7, 0, 0, 12])
  })

  it('gives a site that never received an event an empty series', () => {
    const window = siteCardWindow(new Date('2026-09-12T18:30:00.000Z'))
    expect(assembleSparkline({ window, firstEventAt: null, weekly: new Map() })).toEqual([])
  })

  it('clips a site older than the window to the window', () => {
    const window = siteCardWindow(new Date('2026-09-12T18:30:00.000Z'))
    const series = assembleSparkline({
      window,
      firstEventAt: new Date('2019-03-01T00:00:00.000Z'),
      weekly: new Map([['2026-09-07T00:00:00.000Z', 5]]),
    })
    expect(series).toHaveLength(40)
    expect(series.at(-1)).toBe(5)
    expect(series.slice(0, 39).every((value) => value === 0)).toBe(true)
  })
})
