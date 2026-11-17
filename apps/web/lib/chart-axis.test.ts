import { describe, expect, it } from "vitest"

import { RIGHT_AXIS_GAP, rightAxisMargin } from "./chart-axis"

describe("room for the chart's right-hand axis", () => {
  it("is none when no right axis is drawn: the plot stays flush with the card", () => {
    expect(rightAxisMargin(false, 40)).toBe(0)
  })

  it("fits the widest label beside the plot, so '1m 40s' is never cut at the edge", () => {
    const margin = rightAxisMargin(true, 31.4)
    expect(margin).toBeGreaterThanOrEqual(RIGHT_AXIS_GAP + 32)
    // and not a wide gutter for a short label
    expect(rightAxisMargin(true, 14)).toBeLessThan(margin)
  })

  it("reserves room for a typical label before the labels have been measured", () => {
    expect(rightAxisMargin(true, null)).toBeGreaterThanOrEqual(RIGHT_AXIS_GAP + 36)
  })
})
