import { describe, expect, it } from "vitest"

import { relativeBucketLabel } from "./relative-bucket-label"

const ms = (iso: string) => Date.parse(iso)

describe("the relative time under the cursor", () => {
  // 15 Nov 2026, 10:30 in Berlin (UTC+1 in winter).
  const now = ms("2026-11-15T09:30:00.000Z")
  const zone = "Europe/Berlin"

  it("names today and yesterday at day grain", () => {
    expect(relativeBucketLabel(ms("2026-11-14T23:00:00.000Z"), now, "day", zone)).toBe("Today")
    expect(relativeBucketLabel(ms("2026-11-13T23:00:00.000Z"), now, "day", zone)).toBe("Yesterday")
  })

  it("counts days back", () => {
    expect(relativeBucketLabel(ms("2026-11-01T23:00:00.000Z"), now, "day", zone)).toBe("13 days ago")
  })

  it("counts calendar days in the site's zone, not UTC's", () => {
    // 00:30 on 15 Nov in Berlin is still 14 Nov in UTC.
    const justAfterMidnight = ms("2026-11-14T23:30:00.000Z")
    expect(relativeBucketLabel(ms("2026-11-14T23:00:00.000Z"), justAfterMidnight, "day", zone)).toBe("Today")
    // The same instant is yesterday in Berlin and still today in UTC.
    expect(relativeBucketLabel(ms("2026-11-14T00:00:00.000Z"), justAfterMidnight, "day", zone)).toBe("Yesterday")
    expect(relativeBucketLabel(ms("2026-11-14T00:00:00.000Z"), justAfterMidnight, "day", "UTC")).toBe("Today")
  })

  it("counts across a daylight-saving change without drifting", () => {
    // Berlin left summer time on 25 Oct 2026; 20 Oct is 26 calendar days back.
    expect(relativeBucketLabel(ms("2026-10-19T22:00:00.000Z"), now, "day", zone)).toBe("26 days ago")
  })

  it("counts hours at hour grain", () => {
    expect(relativeBucketLabel(ms("2026-11-15T09:00:00.000Z"), now, "hour", zone)).toBe("This hour")
    expect(relativeBucketLabel(ms("2026-11-15T08:00:00.000Z"), now, "hour", zone)).toBe("1 hour ago")
    expect(relativeBucketLabel(ms("2026-11-15T06:00:00.000Z"), now, "hour", zone)).toBe("3 hours ago")
  })

  it("names weeks at week grain", () => {
    // Monday 9 Nov and Monday 2 Nov in Berlin.
    expect(relativeBucketLabel(ms("2026-11-08T23:00:00.000Z"), now, "week", zone)).toBe("This week")
    expect(relativeBucketLabel(ms("2026-11-01T23:00:00.000Z"), now, "week", zone)).toBe("Last week")
    expect(relativeBucketLabel(ms("2026-10-11T22:00:00.000Z"), now, "week", zone)).toBe("4 weeks ago")
  })
})
