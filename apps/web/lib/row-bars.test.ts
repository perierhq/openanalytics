import { describe, expect, it } from "vitest"

import { barScale, stackedBars, trafficBars } from "./row-bars"

describe("how wide a row's bar is", () => {
  it("scales every row against the largest one", () => {
    const scale = barScale([200, 100, 50])
    expect(scale(200)).toBe(1)
    expect(scale(100)).toBe(0.5)
    expect(scale(50)).toBe(0.25)
  })

  it("draws no bars when the largest value is zero", () => {
    const scale = barScale([0, 0])
    expect(scale(0)).toBe(0)
  })

  it("draws no bars for an empty list", () => {
    expect(barScale([])(10)).toBe(0)
  })

  it("fills the row when there is only one", () => {
    expect(barScale([7])(7)).toBe(1)
  })

  it("never draws a negative or a broken width", () => {
    const scale = barScale([10, -5])
    expect(scale(-5)).toBe(0)
    expect(scale(Number.NaN)).toBe(0)
    expect(scale(20)).toBe(1)
  })
})

describe("traffic-only bars", () => {
  it("is one segment per row, none for a row with nothing", () => {
    const bar = trafficBars([40, 10, 0])
    expect(bar(40)).toEqual([{ tone: "traffic", fraction: 1 }])
    expect(bar(10)).toEqual([{ tone: "traffic", fraction: 0.25 }])
    expect(bar(0)).toEqual([])
  })
})

describe("bars with a revenue segment", () => {
  it("is one traffic segment per row when no row has revenue", () => {
    const bars = stackedBars(
      [
        { traffic: 100, revenue: null },
        { traffic: 50, revenue: 0 },
      ],
      "traffic"
    )
    expect(bars).toEqual([
      [{ tone: "traffic", fraction: 1 }],
      [{ tone: "traffic", fraction: 0.5 }],
    ])
  })

  it("appends revenue after traffic, the fullest row filling the width", () => {
    const bars = stackedBars(
      [
        { traffic: 100, revenue: 0 },
        { traffic: 50, revenue: 1000 },
      ],
      "traffic"
    )
    // Shares: row 1 is 1 + 0, row 2 is 0.5 + 1 = 1.5, the fullest.
    expect(bars[0]).toEqual([{ tone: "traffic", fraction: 1 / 1.5 }])
    expect(bars[1]).toEqual([
      { tone: "traffic", fraction: 0.5 / 1.5 },
      { tone: "revenue", fraction: 1 / 1.5 },
    ])
    const widest = Math.max(
      ...bars.map((segments) => segments.reduce((sum, s) => sum + s.fraction, 0))
    )
    expect(widest).toBeCloseTo(1)
  })

  it("puts the revenue segment first when the rows are sorted by revenue", () => {
    const [bar] = stackedBars([{ traffic: 10, revenue: 500 }], "revenue")
    expect(bar!.map((segment) => segment.tone)).toEqual(["revenue", "traffic"])
  })

  it("leaves out a segment that would have no width", () => {
    const bars = stackedBars(
      [
        { traffic: 0, revenue: 300 },
        { traffic: 0, revenue: 0 },
      ],
      "traffic"
    )
    expect(bars).toEqual([[{ tone: "revenue", fraction: 1 }], []])
  })
})
