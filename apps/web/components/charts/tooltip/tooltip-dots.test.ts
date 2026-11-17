import { describe, expect, it } from "vitest"

import { linesWithDots } from "./tooltip-dots"

describe("which series get a dot under the cursor", () => {
  const lines = [{ dataKey: "visitors" }, { dataKey: "prevVisitors" }, { dataKey: "session" }]

  it("dots every series that has a value at the hovered bucket", () => {
    expect(linesWithDots(lines, { visitors: 40, prevVisitors: 80, session: 12 })).toEqual(lines)
  })

  it("skips a series with no value there, instead of pinning its dot to the top", () => {
    // A previous period shorter than the current one has no bucket under the
    // last current ones; a session line has none where nobody visited.
    expect(linesWithDots(lines, { visitors: 40 })).toEqual([{ dataKey: "visitors" }])
  })

  it("keeps a value of zero, which is a real position at the baseline", () => {
    expect(linesWithDots(lines, { visitors: 0, prevVisitors: 0, session: 0 })).toEqual(lines)
  })

  it("dots nothing while nothing is hovered", () => {
    expect(linesWithDots(lines, undefined)).toEqual([])
  })
})
