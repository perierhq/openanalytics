import { describe, expect, it } from "vitest"

import {
  chartMetricForTile,
  computeDelta,
  computePointsDelta,
  effectiveChartMetric,
  isRevenueChartable,
  parseOverviewView,
  sessionsPreviousRange,
  sessionTileComparison,
  tileChartControl,
  toggleChartMetric,
  writeOverviewView,
} from "./overview-compare"

describe("the delta chip", () => {
  it("prints a rise with a plus sign, rounded to a whole percent", () => {
    expect(computeDelta(112, 100)).toEqual({ label: "+12%", direction: "up", tone: "neutral" })
    expect(computeDelta(1_234, 1_100).label).toBe("+12%")
  })

  it("prints a fall with a true minus sign, not a hyphen", () => {
    const delta = computeDelta(96, 100)
    expect(delta.label).toBe("−4%")
    expect(delta.label.charCodeAt(0)).toBe(0x2212)
    expect(delta.direction).toBe("down")
  })

  it("prints a dash, and no direction, when the previous period is zero", () => {
    expect(computeDelta(50, 0)).toEqual({ label: "—", direction: null, tone: "neutral" })
    expect(computeDelta(0, 0)).toEqual({ label: "—", direction: null, tone: "neutral" })
  })

  it("prints a dash for a previous value that is not a number", () => {
    expect(computeDelta(50, Number.NaN).label).toBe("—")
  })

  it("calls a change that rounds to nothing flat", () => {
    expect(computeDelta(1_001, 1_000)).toEqual({ label: "0%", direction: "flat", tone: "neutral" })
  })

  it("groups large changes the way the tiles group their numbers", () => {
    expect(computeDelta(2_600, 100).label).toBe("+2,500%")
  })

  it("measures against the size of a negative base, so a recovery reads as a rise", () => {
    // Revenue can be net negative (refunds over charges).
    expect(computeDelta(50, -100)).toMatchObject({ label: "+150%", direction: "up" })
  })

  it("keeps traffic changes neutral in either direction", () => {
    expect(computeDelta(120, 100).tone).toBe("neutral")
    expect(computeDelta(80, 100).tone).toBe("neutral")
  })

  it("calls a falling bounce rate good and a rising one bad", () => {
    expect(computeDelta(0.32, 0.4, "lower-is-better")).toEqual({
      label: "−20%",
      direction: "down",
      tone: "good",
    })
    expect(computeDelta(0.5, 0.4, "lower-is-better")).toEqual({
      label: "+25%",
      direction: "up",
      tone: "bad",
    })
  })

  it("gives a flat or incomparable bounce rate no verdict", () => {
    expect(computeDelta(0.4, 0.4, "lower-is-better").tone).toBe("neutral")
    expect(computeDelta(0.4, 0, "lower-is-better").tone).toBe("neutral")
  })
})

describe("a rate's change, in points", () => {
  it("prints the difference of two rates in percentage points, not a relative percent", () => {
    // 36% against 31% is five points up, which a relative +16% would hide.
    expect(computePointsDelta(0.36, 0.31, "lower-is-better")).toEqual({
      label: "+5 pts",
      direction: "up",
      tone: "bad",
    })
    const fall = computePointsDelta(0.36, 0.39, "lower-is-better")
    expect(fall).toEqual({ label: "−3 pts", direction: "down", tone: "good" })
    expect(fall.label.charCodeAt(0)).toBe(0x2212)
  })

  it("has a direction even from a previous rate of zero", () => {
    expect(computePointsDelta(0.2, 0).label).toBe("+20 pts")
  })

  it("calls a change under half a point flat", () => {
    expect(computePointsDelta(0.362, 0.36, "lower-is-better")).toEqual({
      label: "0 pts",
      direction: "flat",
      tone: "neutral",
    })
  })

  it("prints a dash for a rate that is not a number", () => {
    expect(computePointsDelta(0.3, Number.NaN).label).toBe("—")
  })
})

describe("a session tile's comparison", () => {
  const totals = (sessions: number, bounceRate: number, avgMs: number) => ({
    sessions,
    bounce_rate: bounceRate,
    avg_session_duration_ms: avgMs,
  })

  it("prints bounce rate's change in points and average visit's in percent", () => {
    expect(
      sessionTileComparison("bounce_rate", totals(100, 0.36, 87_000), totals(90, 0.39, 82_000))
    ).toEqual({ delta: { label: "−3 pts", direction: "down", tone: "good" }, previous: "39%" })
    expect(
      sessionTileComparison("avg_visit", totals(100, 0.36, 87_000), totals(90, 0.39, 82_000))
    ).toEqual({ delta: { label: "+6%", direction: "up", tone: "neutral" }, previous: "1m 22s" })
  })

  it("prints a dash for a previous period without a single session", () => {
    // Its zero bounce rate and zero duration were never measured.
    for (const tile of ["bounce_rate", "avg_visit"] as const) {
      expect(sessionTileComparison(tile, totals(100, 0.36, 87_000), totals(0, 0, 0))).toEqual({
        delta: { label: "—", direction: null, tone: "neutral" },
        previous: "—",
      })
    }
  })
})

describe("the previous window the sessions read asks for", () => {
  const range = {
    from: "2026-07-23T00:00:00.000Z",
    to: "2026-07-24T00:00:00.000Z",
    timezone: "Europe/Berlin",
  }
  const window = { from: "2026-07-22T00:00:00.000Z", to: "2026-07-22T09:15:00.000Z" }

  it("is exactly the window the overview read compared against, in the range's zone", () => {
    expect(sessionsPreviousRange(range, { forRange: range, window })).toEqual({
      ...window,
      timezone: "Europe/Berlin",
    })
  })

  it("is not known until the overview for this range has answered", () => {
    expect(sessionsPreviousRange(range, null)).toBeUndefined()
    const other = { ...range, from: "2026-07-22T00:00:00.000Z" }
    expect(sessionsPreviousRange(range, { forRange: other, window })).toBeUndefined()
  })

  it("is nothing when the overview had nothing to compare", () => {
    expect(sessionsPreviousRange(range, { forRange: range, window: null })).toBeNull()
  })
})

describe("the overview's view in the URL", () => {
  it("defaults to no comparison and the default chart", () => {
    expect(parseOverviewView("")).toEqual({ compare: false, metric: null })
  })

  it("reads compare=1 and a known metric", () => {
    expect(parseOverviewView("?compare=1&metric=pageviews")).toEqual({
      compare: true,
      metric: "pageviews",
    })
    expect(parseOverviewView("metric=revenue").metric).toBe("revenue")
    expect(parseOverviewView("?metric=bounce_rate").metric).toBe("bounce_rate")
    expect(parseOverviewView("?metric=avg_visit").metric).toBe("avg_visit")
  })

  it("ignores values it does not know", () => {
    expect(parseOverviewView("?compare=yes&metric=bounce")).toEqual({
      compare: false,
      metric: null,
    })
    expect(parseOverviewView("?compare=0").compare).toBe(false)
  })

  it("reads compare=true as on, the way the API spells it", () => {
    expect(parseOverviewView("?compare=true").compare).toBe(true)
    expect(parseOverviewView("?compare=false").compare).toBe(false)
  })

  it("writes only what differs from the default, and keeps every other parameter", () => {
    const filters = '[{"dimension":"country","values":["DE"]}]'
    const search = `?filters=${encodeURIComponent(filters)}&metric=visitors`
    const written = writeOverviewView(search, { compare: true, metric: null })
    const params = new URLSearchParams(written)
    expect(params.get("filters")).toBe(filters)
    expect(params.get("compare")).toBe("1")
    expect(params.has("metric")).toBe(false)
  })

  it("round-trips", () => {
    const view = { compare: true, metric: "revenue" as const }
    expect(parseOverviewView(writeOverviewView("", view))).toEqual(view)
    expect(writeOverviewView("?compare=1&metric=revenue", { compare: false, metric: null })).toBe("")
  })
})

describe("which tiles drive the chart", () => {
  const none = { revenueChartable: false, sessionsChartable: false }

  it("lets visitors and pageviews drive it", () => {
    expect(chartMetricForTile("visitors", none)).toBe("visitors")
    expect(chartMetricForTile("pageviews", none)).toBe("pageviews")
  })

  it("lets the session tiles drive it while their series can be read", () => {
    const sessions = { revenueChartable: false, sessionsChartable: true }
    expect(chartMetricForTile("bounce_rate", sessions)).toBe("bounce_rate")
    expect(chartMetricForTile("avg_visit", sessions)).toBe("avg_visit")
  })

  it("keeps the session tiles plain under a filter, which their read cannot take", () => {
    expect(chartMetricForTile("bounce_rate", none)).toBeNull()
    expect(chartMetricForTile("avg_visit", none)).toBeNull()
  })

  it("lets revenue drive it only when there are bars to promote", () => {
    expect(
      chartMetricForTile("revenue", { revenueChartable: true, sessionsChartable: false })
    ).toBe("revenue")
    expect(chartMetricForTile("revenue", none)).toBeNull()
  })

  it("charts revenue for an owner whose range has bars, and nobody else", () => {
    expect(isRevenueChartable({ role: "owner", hasBars: true })).toBe(true)
    expect(isRevenueChartable({ role: "owner", hasBars: false })).toBe(false)
    expect(isRevenueChartable({ role: "admin", hasBars: true })).toBe(false)
    expect(isRevenueChartable({ role: null, hasBars: true })).toBe(false)
  })

  it("turns a selected tile off when it is pressed again", () => {
    expect(toggleChartMetric(null, "visitors")).toBe("visitors")
    expect(toggleChartMetric("visitors", "pageviews")).toBe("pageviews")
    expect(toggleChartMetric("pageviews", "pageviews")).toBeNull()
  })

  it("falls back to the default chart when a linked view has nothing to show", () => {
    const none = { revenueChartable: false, sessionsChartable: false }
    expect(effectiveChartMetric("revenue", none)).toBeNull()
    expect(effectiveChartMetric("revenue", { ...none, revenueChartable: true })).toBe("revenue")
    expect(effectiveChartMetric("visitors", none)).toBe("visitors")
    expect(effectiveChartMetric("bounce_rate", none)).toBeNull()
    expect(effectiveChartMetric("avg_visit", { ...none, sessionsChartable: true })).toBe(
      "avg_visit"
    )
  })
})

describe("a tile's state follows what the chart draws", () => {
  const drawing = (drawn: Parameters<typeof tileChartControl>[1]["drawn"]) => ({
    drawn,
    revenueChartable: false,
    sessionsChartable: true,
  })

  it("is pressed only when the chart draws its metric", () => {
    expect(tileChartControl("visitors", drawing("visitors"))).toEqual({
      metric: "visitors",
      pressed: true,
    })
    expect(tileChartControl("pageviews", drawing("visitors"))).toEqual({
      metric: "pageviews",
      pressed: false,
    })
  })

  it("is not pressed while the chart draws the default for a metric it cannot draw", () => {
    // A link asked for bounce rate, but the sessions series cannot be drawn
    // at this grain: the chart draws the default, so no tile is pressed and
    // the bounce tile is not a button.
    const fallback = { drawn: null, revenueChartable: false, sessionsChartable: false }
    expect(tileChartControl("bounce_rate", fallback)).toBeNull()
    expect(tileChartControl("visitors", fallback)).toEqual({ metric: "visitors", pressed: false })
  })

  it("makes revenue a button only where the chart can draw it", () => {
    expect(tileChartControl("revenue", drawing(null))).toBeNull()
    expect(
      tileChartControl("revenue", { drawn: "revenue", revenueChartable: true, sessionsChartable: false })
    ).toEqual({ metric: "revenue", pressed: true })
  })
})
