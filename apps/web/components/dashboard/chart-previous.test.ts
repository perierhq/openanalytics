import { describe, expect, it } from "vitest"

import { PREVIOUS_LINE_PROPS, previousFields } from "./chart-previous"

describe("the previous period's dashed lines", () => {
  it("break where a bucket has no previous value, instead of drawing it", () => {
    // Without `gapsForMissing` the line reads the absent key as a point with
    // no position, and the dash jumps to the top of the plot there.
    expect(PREVIOUS_LINE_PROPS.gapsForMissing).toBe(true)
  })

  it("leave the keys off a bucket with no counterpart, so the gap is a gap", () => {
    expect(previousFields(null)).toEqual({})
  })

  it("carry the counterpart's numbers and its own date", () => {
    const date = new Date("2026-07-22T13:00:00.000Z")
    expect(previousFields({ date, visitors: 4, pageviews: 9 })).toEqual({
      prevVisitors: 4,
      prevPageviews: 9,
      prevAtMs: date.getTime(),
    })
  })
})
