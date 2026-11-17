import { describe, expect, it } from "vitest"

import { alignPrevious } from "./chart-fill"
import {
  bucketSessions,
  sessionGrainFits,
  type SessionPointLike,
} from "./session-buckets"

const HOUR = 3_600_000
const DAY = 24 * HOUR

const at = (iso: string) => Date.parse(iso)
const point = (
  bucket: string,
  sessions: number,
  bounced: number,
  avgMs: number
): SessionPointLike => ({
  bucket,
  sessions,
  bounced_sessions: bounced,
  avg_session_duration_ms: avgMs,
})

describe("putting the sessions series on the chart's buckets", () => {
  it("passes a series served at the chart's own grain straight through", () => {
    const starts = [at("2026-07-01T00:00:00.000Z"), at("2026-07-01T01:00:00.000Z")]
    const buckets = bucketSessions(starts, starts[1]! + HOUR, [
      point("2026-07-01T00:00:00.000Z", 10, 4, 60_000),
      point("2026-07-01T01:00:00.000Z", 20, 5, 90_000),
    ])
    expect(buckets).toEqual([
      { sessions: 10, bounceRate: 0.4, avgDurationMs: 60_000 },
      { sessions: 20, bounceRate: 0.25, avgDurationMs: 90_000 },
    ])
  })

  it("folds hourly sessions into a daily chart by re-deriving the rates from the sums", () => {
    // A 7-day view: the sessions read answers hourly, the chart draws days.
    const day1 = at("2026-07-01T00:00:00.000Z")
    const buckets = bucketSessions([day1, day1 + DAY], day1 + 2 * DAY, [
      point("2026-07-01T09:00:00.000Z", 10, 5, 60_000),
      point("2026-07-01T17:00:00.000Z", 30, 3, 100_000),
      point("2026-07-02T08:00:00.000Z", 4, 1, 30_000),
    ])
    // 8 of 40 bounced, not the mean of 50% and 10%; durations weighted by sessions.
    expect(buckets[0]).toEqual({ sessions: 40, bounceRate: 0.2, avgDurationMs: 90_000 })
    expect(buckets[1]).toEqual({ sessions: 4, bounceRate: 0.25, avgDurationMs: 30_000 })
  })

  it("folds daily sessions into the weekly chart's weeks", () => {
    const monday = at("2026-07-06T00:00:00.000Z")
    const buckets = bucketSessions([monday, monday + 7 * DAY], monday + 14 * DAY, [
      point("2026-07-06T00:00:00.000Z", 100, 30, 80_000),
      point("2026-07-12T00:00:00.000Z", 100, 50, 40_000),
      point("2026-07-13T00:00:00.000Z", 50, 10, 70_000),
    ])
    expect(buckets[0]).toEqual({ sessions: 200, bounceRate: 0.4, avgDurationMs: 60_000 })
    expect(buckets[1]).toEqual({ sessions: 50, bounceRate: 0.2, avgDurationMs: 70_000 })
  })

  it("leaves a bucket without sessions empty instead of calling it a 0% bounce rate", () => {
    const day1 = at("2026-07-01T00:00:00.000Z")
    const buckets = bucketSessions([day1, day1 + DAY], day1 + 2 * DAY, [
      point("2026-07-01T10:00:00.000Z", 5, 1, 50_000),
      point("2026-07-02T10:00:00.000Z", 0, 0, 0),
    ])
    expect(buckets[1]).toEqual({ sessions: 0, bounceRate: null, avgDurationMs: null })
  })

  it("drops sessions before the first bucket and at or after the end", () => {
    const day1 = at("2026-07-01T00:00:00.000Z")
    const buckets = bucketSessions([day1], day1 + DAY, [
      point("2026-06-30T23:00:00.000Z", 50, 50, 1_000),
      point("2026-07-01T12:00:00.000Z", 10, 2, 20_000),
      point("2026-07-02T00:00:00.000Z", 50, 50, 1_000),
    ])
    expect(buckets).toEqual([{ sessions: 10, bounceRate: 0.2, avgDurationMs: 20_000 }])
  })

  it("lines the previous period's sessions up under the current buckets, bucket i with bucket i", () => {
    // Current: Jul 1–3 by day; previous: Jun 28–30, served hourly.
    const cur = at("2026-07-01T00:00:00.000Z")
    const prev = cur - 3 * DAY
    const current = bucketSessions([cur, cur + DAY, cur + 2 * DAY], cur + 3 * DAY, [])
    const previous = bucketSessions([prev, prev + DAY, prev + 2 * DAY], cur, [
      point("2026-06-28T05:00:00.000Z", 10, 3, 40_000),
      point("2026-06-30T22:00:00.000Z", 20, 10, 80_000),
    ])
    const aligned = alignPrevious(current, previous)
    expect(aligned[0]?.bounceRate).toBe(0.3)
    expect(aligned[1]?.bounceRate).toBeNull()
    expect(aligned[2]).toEqual({ sessions: 20, bounceRate: 0.5, avgDurationMs: 80_000 })
  })
})

describe("whether a sessions series can be drawn on a chart", () => {
  it("fits when it is as fine as the chart's grain or finer", () => {
    expect(sessionGrainFits("hour", "hour")).toBe(true)
    expect(sessionGrainFits("hour", "day")).toBe(true)
    expect(sessionGrainFits("day", "week")).toBe(true)
  })

  it("does not fit when it is coarser: a day cannot be spread over hours", () => {
    expect(sessionGrainFits("day", "hour")).toBe(false)
    expect(sessionGrainFits("week", "day")).toBe(false)
  })
})
