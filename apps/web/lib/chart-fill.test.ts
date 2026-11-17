import { afterEach, describe, expect, it } from "vitest"

import {
  alignPrevious,
  fillDailyZeros,
  fillFixedZeros,
  fillPreviousGrid,
  fillWeeklyZeros,
  nearestZonedMidnight,
  type PlotPoint,
} from "./chart-fill"

const HOUR = 3_600_000

/** A local calendar day, the way the daily grid steps them. */
const local = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h)
const point = (date: Date, visitors: number): PlotPoint => ({
  date,
  visitors,
  pageviews: visitors * 2,
})

describe("pairing the previous period with the current one", () => {
  it("pairs bucket i with bucket i across months of different lengths", () => {
    // March (31 days) against the 31 days before it, which run through a
    // 28-day February: by date the two would never line up.
    const from = local(2026, 3, 1).getTime()
    const until = local(2026, 4, 1).getTime()
    const prevFrom = local(2026, 1, 29).getTime()
    const current = fillDailyZeros([point(local(2026, 3, 31), 9)], from, until)
    const previous = fillDailyZeros(
      [point(local(2026, 1, 29), 4), point(local(2026, 2, 28), 7)],
      prevFrom,
      from
    )
    expect(current).toHaveLength(31)
    expect(previous).toHaveLength(31)

    const aligned = alignPrevious(current, previous)
    expect(aligned).toHaveLength(31)
    expect(aligned[0]?.date).toEqual(local(2026, 1, 29))
    expect(aligned[0]?.visitors).toBe(4)
    expect(aligned[30]?.date).toEqual(local(2026, 2, 28))
    expect(aligned[30]?.visitors).toBe(7)
    // A day with no row in the previous period is a zero, not a gap.
    expect(aligned[1]).toEqual({ date: local(2026, 1, 30), visitors: 0, pageviews: 0 })
  })

  it("pairs hour i of today with hour i of yesterday, up to the hour today has reached", () => {
    const today = Date.parse("2026-07-26T00:00:00.000Z")
    const yesterday = today - 24 * HOUR
    // As of 13:20, today has 14 buckets (00:00 … 13:00); yesterday has 24.
    const current = fillFixedZeros(
      [point(new Date(today + 13 * HOUR), 30)],
      today,
      today + 13 * HOUR + 20 * 60_000,
      HOUR
    )
    const previous = fillFixedZeros(
      [point(new Date(yesterday + 13 * HOUR), 21), point(new Date(yesterday + 20 * HOUR), 50)],
      yesterday,
      today,
      HOUR
    )
    const aligned = alignPrevious(current, previous)
    expect(aligned).toHaveLength(14)
    expect(aligned[13]?.date.toISOString()).toBe("2026-07-25T13:00:00.000Z")
    expect(aligned[13]?.visitors).toBe(21)
    expect(aligned.every((entry, i) => entry?.date.getTime() === yesterday + i * HOUR)).toBe(true)
  })

  it("leaves a current bucket without a counterpart empty rather than inventing one", () => {
    const current = [point(new Date(0), 1), point(new Date(HOUR), 2)]
    const previous = [point(new Date(-HOUR), 5)]
    expect(alignPrevious(current, previous)).toEqual([previous[0], null])
  })
})

/**
 * The browser and the site keep different clocks. These cases set the
 * process zone (`TZ`, which Node re-reads on assignment) to stand in for the
 * browser, and cut every expected instant with explicit zone maths, so the
 * grid must come out the same whatever zone the machine running them is in.
 */
const BROWSER_ZONES = ["Europe/Berlin", "America/New_York", "Asia/Tokyo", "UTC"] as const
const originalTz = process.env.TZ
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

const iso = (value: string) => Date.parse(value)
const served = (instant: string, visitors: number): PlotPoint => ({
  date: new Date(instant),
  visitors,
  pageviews: visitors,
})

describe("the previous period's grid, cut in the site's zone", () => {
  for (const browser of BROWSER_ZONES) {
    it(`keeps a Tokyo site's first previous day when the browser is in ${browser}`, () => {
      process.env.TZ = browser
      // Tokyo midnights are 15:00Z the day before. The 7 days before a range
      // starting Tokyo Jul 17 run from Tokyo Jul 10.
      const grid = fillPreviousGrid(
        [served("2026-07-09T15:00:00.000Z", 7), served("2026-07-15T15:00:00.000Z", 3)],
        {
          grain: "day",
          fromMs: iso("2026-07-09T15:00:00.000Z"),
          untilMs: iso("2026-07-16T15:00:00.000Z"),
          timeZone: "Asia/Tokyo",
        }
      )
      expect(grid).toHaveLength(7)
      expect(grid[0]).toEqual(served("2026-07-09T15:00:00.000Z", 7))
      expect(grid[6]).toEqual(served("2026-07-15T15:00:00.000Z", 3))
      // Zero days sit on the site's midnights, not the browser's.
      expect(grid[1]?.date.toISOString()).toBe("2026-07-10T15:00:00.000Z")
      expect(grid[1]?.visitors).toBe(0)
    })

    it(`snaps a New York site's start to its own midnight across DST, browser in ${browser}`, () => {
      process.env.TZ = browser
      // A 7-day span cut back across the spring-forward (Mar 8, 2026) lands an
      // hour off New York midnight: 03:00Z instead of 04:00Z or 05:00Z.
      const grid = fillPreviousGrid(
        [served("2026-03-05T05:00:00.000Z", 4), served("2026-03-08T05:00:00.000Z", 9)],
        {
          grain: "day",
          fromMs: iso("2026-03-05T04:00:00.000Z"),
          untilMs: iso("2026-03-12T04:00:00.000Z"),
          timeZone: "America/New_York",
        }
      )
      expect(grid[0]).toEqual(served("2026-03-05T05:00:00.000Z", 4))
      expect(grid[3]).toEqual(served("2026-03-08T05:00:00.000Z", 9))
      // After the change New York midnight is 04:00Z.
      expect(grid[4]?.date.toISOString()).toBe("2026-03-09T04:00:00.000Z")
    })

    it(`steps the site's Mondays for a weekly grid, browser in ${browser}`, () => {
      process.env.TZ = browser
      // Tokyo Monday Jun 1, 2026 starts at 15:00Z on Sunday May 31.
      const grid = fillPreviousGrid([served("2026-05-31T15:00:00.000Z", 12)], {
        grain: "week",
        fromMs: iso("2026-06-02T15:00:00.000Z"),
        untilMs: iso("2026-06-30T15:00:00.000Z"),
        timeZone: "Asia/Tokyo",
      })
      expect(grid[0]).toEqual(served("2026-05-31T15:00:00.000Z", 12))
      expect(grid[1]?.date.toISOString()).toBe("2026-06-07T15:00:00.000Z")
      expect(grid.every((point, i) => i === 0 || point.visitors === 0)).toBe(true)
    })
  }

  it("floors a sub-day previous grid to its bucket", () => {
    const grid = fillPreviousGrid([served("2026-07-22T13:00:00.000Z", 5)], {
      grain: "fixed",
      fromMs: iso("2026-07-22T13:20:00.000Z"),
      untilMs: iso("2026-07-22T15:00:00.000Z"),
      bucketMs: HOUR,
      timeZone: "UTC",
    })
    expect(grid.map((point) => point.visitors)).toEqual([5, 0])
  })
})

describe("the current grid, in the site's zone", () => {
  for (const browser of BROWSER_ZONES) {
    it(`labels a Tokyo site's empty days with Tokyo midnights, browser in ${browser}`, () => {
      process.env.TZ = browser
      const daily = fillDailyZeros(
        [served("2026-07-16T15:00:00.000Z", 2)],
        iso("2026-07-16T15:00:00.000Z"),
        iso("2026-07-19T15:00:00.000Z"),
        "Asia/Tokyo"
      )
      expect(daily.map((point) => point.date.toISOString())).toEqual([
        "2026-07-16T15:00:00.000Z",
        "2026-07-17T15:00:00.000Z",
        "2026-07-18T15:00:00.000Z",
      ])
      const weekly = fillWeeklyZeros(
        [],
        iso("2026-06-02T15:00:00.000Z"),
        iso("2026-06-16T15:00:00.000Z"),
        "Asia/Tokyo"
      )
      expect(weekly.map((point) => point.date.toISOString())).toEqual([
        "2026-05-31T15:00:00.000Z",
        "2026-06-07T15:00:00.000Z",
        "2026-06-14T15:00:00.000Z",
      ])
    })
  }
})

describe("the site midnight nearest an instant", () => {
  it("is the instant itself on a midnight, and the nearest one an hour either side", () => {
    expect(nearestZonedMidnight(iso("2026-07-09T15:00:00.000Z"), "Asia/Tokyo")).toBe(
      iso("2026-07-09T15:00:00.000Z")
    )
    expect(nearestZonedMidnight(iso("2026-07-09T14:00:00.000Z"), "Asia/Tokyo")).toBe(
      iso("2026-07-09T15:00:00.000Z")
    )
    expect(nearestZonedMidnight(iso("2026-03-05T03:00:00.000Z"), "America/New_York")).toBe(
      iso("2026-03-05T05:00:00.000Z")
    )
  })
})
