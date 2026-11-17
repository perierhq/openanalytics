import { describe, expect, it } from "vitest"

import {
  AVG_VISIT_INFO,
  BOUNCE_INFO,
  durationLabel,
  percentLabel,
  STAT_DEFINITIONS,
} from "./stat-format"

describe("the session axis labels", () => {
  it("prints a rate as a whole percent", () => {
    expect(percentLabel(0.358)).toBe("36%")
    expect(percentLabel(0)).toBe("0%")
    expect(percentLabel(1)).toBe("100%")
  })

  it("prints a duration compactly", () => {
    expect(durationLabel(84_210)).toBe("1m 24s")
    expect(durationLabel(40_000)).toBe("40s")
    expect(durationLabel(3_900_000)).toBe("1h 5m")
  })
})

describe("the stat definitions", () => {
  it("is one line each, with no second sentence", () => {
    for (const text of Object.values(STAT_DEFINITIONS)) {
      expect(text.split(/\.\s/)).toHaveLength(1)
    }
  })

  it("gives the share board the same bounce rate and visit wording as the dashboard", () => {
    expect(BOUNCE_INFO).toBe(STAT_DEFINITIONS.bounce_rate)
    expect(AVG_VISIT_INFO).toBe(STAT_DEFINITIONS.avg_visit)
  })
})
