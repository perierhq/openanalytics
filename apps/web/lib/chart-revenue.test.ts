import { describe, expect, it, vi } from "vitest"

import type { RevenueConnectionState, RevenueTimeseriesPoint } from "./api"
import {
  bucketRevenue,
  hasRevenueBars,
  loadChartRevenue,
  pickRevenueCurrency,
  revenueLayers,
  revenueResolutionFor,
  revenueTooltipModel,
  type ChartRevenueDeps,
  type RevenueBucket,
} from "./chart-revenue"

const RANGE = {
  from: "2026-06-21T22:00:00.000Z",
  to: "2026-07-05T22:00:00.000Z",
  timezone: "Europe/Berlin",
}

const point = (
  bucket: string,
  overrides: Partial<RevenueTimeseriesPoint> = {}
): RevenueTimeseriesPoint => ({
  bucket,
  currency: "EUR",
  charge_gross_minor: 0,
  refund_minor: 0,
  dispute_withdrawn_minor: 0,
  dispute_reinstated_minor: 0,
  fee_minor: 0,
  net_minor: 0,
  charge_count: 0,
  refund_count: 0,
  dispute_count: 0,
  unconverted_count: 0,
  ...overrides,
})

const ms = (iso: string) => Date.parse(iso)

describe("which revenue grain the chart asks for", () => {
  it("asks for the chart's own grain at hour and day, days for weeks, nothing for minutes", () => {
    expect(revenueResolutionFor("hour")).toBe("hour")
    expect(revenueResolutionFor("day")).toBe("day")
    expect(revenueResolutionFor("week")).toBe("day")
    expect(revenueResolutionFor("minute")).toBeNull()
  })
})

describe("summing daily revenue into the chart's week buckets", () => {
  // Berlin in summer is UTC+2: its Mondays start at 22:00Z on the Sunday.
  const weekStarts = [ms("2026-06-21T22:00:00.000Z"), ms("2026-06-28T22:00:00.000Z")]
  const endMs = ms("2026-07-05T22:00:00.000Z")

  it("adds every day of a week into that week", () => {
    const days = [
      point("2026-06-21T22:00:00.000Z", { net_minor: 1000, charge_gross_minor: 1100, charge_count: 1 }),
      point("2026-06-24T22:00:00.000Z", { net_minor: 2000, charge_gross_minor: 2200, charge_count: 2 }),
      point("2026-06-30T22:00:00.000Z", { net_minor: 500, charge_gross_minor: 600, refund_minor: 100, charge_count: 1 }),
    ]
    const { buckets } = bucketRevenue(weekStarts, endMs, days)
    expect(buckets.get(weekStarts[0]!)).toMatchObject({
      netMinor: 3000,
      grossMinor: 3300,
      sales: 3,
      refundMinor: 0,
    })
    expect(buckets.get(weekStarts[1]!)).toMatchObject({
      netMinor: 500,
      grossMinor: 600,
      refundMinor: 100,
      sales: 1,
    })
  })

  it("cuts weeks at the site's midnight, not at UTC's", () => {
    // Sunday 28 June in Berlin is labelled 27 June 22:00Z and belongs to the
    // first week; 28 June 22:00Z is already Monday 29 June in Berlin.
    const days = [
      point("2026-06-27T22:00:00.000Z", { net_minor: 700 }),
      point("2026-06-28T22:00:00.000Z", { net_minor: 300 }),
    ]
    const { buckets } = bucketRevenue(weekStarts, endMs, days)
    expect(buckets.get(weekStarts[0]!)?.netMinor).toBe(700)
    expect(buckets.get(weekStarts[1]!)?.netMinor).toBe(300)
  })

  it("drops days outside the plotted weeks", () => {
    const days = [
      point("2026-06-20T22:00:00.000Z", { net_minor: 999 }),
      point("2026-07-05T22:00:00.000Z", { net_minor: 999 }),
    ]
    expect(bucketRevenue(weekStarts, endMs, days).buckets.size).toBe(0)
  })
})

describe("one currency on the bars", () => {
  it("picks the currency with the largest total when two appear", () => {
    const points = [
      point("2026-06-22T22:00:00.000Z", { currency: "EUR", charge_gross_minor: 4000, net_minor: 3800 }),
      point("2026-06-23T22:00:00.000Z", { currency: "USD", charge_gross_minor: 3000, net_minor: 2900 }),
      point("2026-06-24T22:00:00.000Z", { currency: "USD", charge_gross_minor: 3000, net_minor: 2900 }),
    ]
    expect(pickRevenueCurrency(points)).toBe("USD")
  })

  it("measures the total as net plus refunds, not gross", () => {
    // EUR grossed more, but fees and disputes ate most of it; USD kept more.
    const points = [
      point("2026-06-22T22:00:00.000Z", { currency: "EUR", charge_gross_minor: 9000, net_minor: 1000, refund_minor: 500 }),
      point("2026-06-23T22:00:00.000Z", { currency: "USD", charge_gross_minor: 3000, net_minor: 2900 }),
    ]
    expect(pickRevenueCurrency(points)).toBe("USD")
  })

  it("keeps the first currency seen on a tie", () => {
    const points = [
      point("2026-06-22T22:00:00.000Z", { currency: "USD", net_minor: 1000 }),
      point("2026-06-23T22:00:00.000Z", { currency: "EUR", net_minor: 800, refund_minor: 200 }),
    ]
    expect(pickRevenueCurrency(points)).toBe("USD")
  })

  it("has no currency without points", () => {
    expect(pickRevenueCurrency([])).toBeNull()
  })

  it("draws only the picked currency and flags buckets that had another", () => {
    const starts = [ms("2026-06-22T22:00:00.000Z"), ms("2026-06-23T22:00:00.000Z")]
    const points = [
      point("2026-06-22T22:00:00.000Z", { currency: "EUR", charge_gross_minor: 1000, net_minor: 900 }),
      point("2026-06-22T22:00:00.000Z", { currency: "USD", charge_gross_minor: 5000, net_minor: 4800 }),
      point("2026-06-23T22:00:00.000Z", { currency: "USD", charge_gross_minor: 2000, net_minor: 1900 }),
    ]
    const model = bucketRevenue(starts, ms("2026-06-24T22:00:00.000Z"), points)
    expect(model.currency).toBe("USD")
    expect(model.buckets.get(starts[0]!)).toMatchObject({ netMinor: 4800, otherCurrencies: true })
    expect(model.buckets.get(starts[1]!)).toMatchObject({ netMinor: 1900, otherCurrencies: false })
  })
})

describe("whether there is anything to draw", () => {
  it("draws nothing from a missing read", () => {
    const model = bucketRevenue([ms("2026-06-22T22:00:00.000Z")], ms("2026-06-23T22:00:00.000Z"), null)
    expect(model.buckets.size).toBe(0)
    expect(hasRevenueBars(model)).toBe(false)
  })

  it("draws nothing when every bucket is zero", () => {
    const starts = [ms("2026-06-22T22:00:00.000Z")]
    const model = bucketRevenue(starts, ms("2026-06-23T22:00:00.000Z"), [
      point("2026-06-22T22:00:00.000Z"),
    ])
    expect(hasRevenueBars(model)).toBe(false)
  })

  it("draws a refund-only bucket", () => {
    const starts = [ms("2026-06-22T22:00:00.000Z")]
    const model = bucketRevenue(starts, ms("2026-06-23T22:00:00.000Z"), [
      point("2026-06-22T22:00:00.000Z", { refund_minor: 500, net_minor: -500 }),
    ])
    expect(hasRevenueBars(model)).toBe(true)
  })
})

describe("which revenue layers the chart shows", () => {
  const starts = [ms("2026-06-22T22:00:00.000Z"), ms("2026-06-23T22:00:00.000Z")]
  const endMs = ms("2026-06-24T22:00:00.000Z")

  it("keeps the tooltip section for a range whose only revenue could not be converted", () => {
    const model = bucketRevenue(starts, endMs, [
      point("2026-06-22T22:00:00.000Z", { unconverted_count: 2 }),
    ])
    expect(revenueLayers(model, { enabled: true, hidden: false })).toEqual({
      bars: false,
      barsVisible: false,
      tooltip: true,
    })
  })

  it("shows bars, their visibility and the tooltip together when there is money", () => {
    const model = bucketRevenue(starts, endMs, [
      point("2026-06-22T22:00:00.000Z", { net_minor: 900 }),
    ])
    expect(revenueLayers(model, { enabled: true, hidden: false })).toEqual({
      bars: true,
      barsVisible: true,
      tooltip: true,
    })
    expect(revenueLayers(model, { enabled: true, hidden: true })).toEqual({
      bars: true,
      barsVisible: false,
      tooltip: false,
    })
  })

  it("ignores a hidden choice when there are no bars to toggle it back with", () => {
    const model = bucketRevenue(starts, endMs, [
      point("2026-06-22T22:00:00.000Z", { unconverted_count: 1 }),
    ])
    expect(revenueLayers(model, { enabled: true, hidden: true }).tooltip).toBe(true)
  })

  it("shows nothing when the layer is off or there are no points", () => {
    const model = bucketRevenue(starts, endMs, [
      point("2026-06-22T22:00:00.000Z", { net_minor: 900 }),
    ])
    expect(revenueLayers(model, { enabled: false, hidden: false })).toEqual({
      bars: false,
      barsVisible: false,
      tooltip: false,
    })
    expect(revenueLayers(bucketRevenue(starts, endMs, null), { enabled: true, hidden: false }).tooltip).toBe(false)
  })
})

function deps(
  state: RevenueConnectionState | Error = { status: "active" } as RevenueConnectionState,
  series: RevenueTimeseriesPoint[] | Error = []
) {
  const revenueState = vi.fn(async () => {
    if (state instanceof Error) throw state
    return state
  })
  const revenueTimeseries = vi.fn(async () => {
    if (series instanceof Error) throw series
    return { series }
  })
  return { revenueState, revenueTimeseries } satisfies ChartRevenueDeps
}

describe("who gets revenue bars", () => {
  it("never asks for the revenue timeseries for an admin or a viewer", async () => {
    for (const role of ["admin", "viewer"] as const) {
      const d = deps(undefined, [point("2026-06-22T22:00:00.000Z", { net_minor: 100 })])
      const result = await loadChartRevenue({ siteId: "s", role, range: RANGE, grain: "day" }, d)
      expect(result).toBeNull()
      expect(d.revenueState).not.toHaveBeenCalled()
      expect(d.revenueTimeseries).not.toHaveBeenCalled()
    }
  })

  it("stops after the connection read when no provider is connected", async () => {
    const d = deps({ status: "not_connected" } as RevenueConnectionState)
    expect(await loadChartRevenue({ siteId: "s", role: "owner", range: RANGE, grain: "day" }, d)).toBeNull()
    expect(d.revenueTimeseries).not.toHaveBeenCalled()
  })

  it("asks an owner's timeseries at the mapped grain over the chart's range", async () => {
    const series = [point("2026-06-22T22:00:00.000Z", { net_minor: 100 })]
    const d = deps(undefined, series)
    const result = await loadChartRevenue({ siteId: "s", role: "owner", range: RANGE, grain: "week" }, d)
    expect(result).toEqual(series)
    expect(d.revenueTimeseries).toHaveBeenCalledWith("s", RANGE, expect.objectContaining({ resolution: "day" }))
  })

  it("asks nothing at minute grain", async () => {
    const d = deps()
    expect(await loadChartRevenue({ siteId: "s", role: "owner", range: RANGE, grain: "minute" }, d)).toBeNull()
    expect(d.revenueState).not.toHaveBeenCalled()
  })

  it("turns a failed read into no bars", async () => {
    for (const d of [deps(new Error("403")), deps(undefined, new Error("404"))]) {
      const result = await loadChartRevenue({ siteId: "s", role: "owner", range: RANGE, grain: "day" }, d)
      expect(result).toBeNull()
      expect(hasRevenueBars(bucketRevenue([ms("2026-06-22T22:00:00.000Z")], ms(RANGE.to), result))).toBe(false)
    }
  })
})

const bucket = (overrides: Partial<RevenueBucket> = {}): RevenueBucket => ({
  startMs: ms("2026-06-22T22:00:00.000Z"),
  currency: "EUR",
  netMinor: 0,
  grossMinor: 0,
  refundMinor: 0,
  sales: 0,
  unconverted: 0,
  otherCurrencies: false,
  ...overrides,
})

describe("the tooltip's revenue section", () => {
  it("keeps net and leaves out lines that are zero", () => {
    const model = revenueTooltipModel(bucket(), 120)
    expect(model.net).toBe("€0.00")
    expect(model.lines).toEqual([])
    expect(model.notes).toEqual([])
  })

  it("shows refunds as a negative", () => {
    const model = revenueTooltipModel(
      bucket({ netMinor: 3800, grossMinor: 5000, refundMinor: 1200, sales: 2 }),
      100
    )
    expect(model.lines).toEqual([
      { label: "Gross", value: "€50.00" },
      { label: "Refunds", value: "−€12.00" },
      { label: "Revenue per visitor", value: "€0.38" },
    ])
  })

  it("leaves the sale count to the markers line", () => {
    const model = revenueTooltipModel(bucket({ netMinor: 3800, grossMinor: 3800, sales: 2 }), 100)
    expect(model.lines.map((line) => line.label)).not.toContain("Sales")
  })

  it("prints less than a minor unit per visitor with its sign", () => {
    expect(revenueTooltipModel(bucket({ netMinor: 3 }), 1000).lines.at(-1)).toEqual({
      label: "Revenue per visitor",
      value: "<€0.01",
    })
    expect(revenueTooltipModel(bucket({ netMinor: -3, refundMinor: 3 }), 1000).lines.at(-1)).toEqual({
      label: "Revenue per visitor",
      value: "−<€0.01",
    })
  })

  it("has no revenue per visitor under a filter, and says revenue isn't filtered", () => {
    const model = revenueTooltipModel(
      bucket({ netMinor: 3800, grossMinor: 5000, refundMinor: 1200, sales: 2 }),
      100,
      { filtered: true }
    )
    expect(model.lines.map((line) => line.label)).toEqual(["Gross", "Refunds"])
    expect(model.notes).toEqual(["Revenue isn't filtered."])
  })

  it("has no revenue per visitor without visitors", () => {
    const model = revenueTooltipModel(bucket({ netMinor: 4900, grossMinor: 4900, sales: 1 }), 0)
    expect(model.lines.at(-1)).toEqual({ label: "Revenue per visitor", value: "—" })
  })

  it("prints a negative net with a minus sign", () => {
    const model = revenueTooltipModel(bucket({ netMinor: -500, refundMinor: 500 }), 10)
    expect(model.net).toBe("−€5.00")
  })

  it("says how many sales could not be converted, and when other currencies were left out", () => {
    expect(revenueTooltipModel(bucket({ unconverted: 2 }), 1).notes).toEqual([
      "2 sales could not be converted",
    ])
    expect(revenueTooltipModel(bucket({ unconverted: 1, otherCurrencies: true }), 1).notes).toEqual([
      "1 sale could not be converted",
      "Other currencies not shown",
    ])
  })
})
