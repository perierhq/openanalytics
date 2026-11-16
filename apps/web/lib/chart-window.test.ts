import { describe, expect, it } from "vitest"

import { bucketRevenue } from "./chart-revenue"
import { chartWindow } from "./chart-window"
import { bucketMarkers } from "./event-markers"
import { relativeBucketLabel } from "./relative-bucket-label"

const ms = (iso: string) => Date.parse(iso)

describe("the moment relative labels count from", () => {
  // The share board's "Last 7 days" in UTC, read at 10:00 on 15 Nov: the
  // range ends at tomorrow's midnight, and the public meta has no `as_of`.
  const toMs = ms("2026-11-16T00:00:00.000Z")
  const nowMs = ms("2026-11-15T10:00:00.000Z")

  it("calls today's bucket Today when the meta has no as_of", () => {
    const { readAtMs } = chartWindow({
      asOf: undefined,
      effectiveTo: "2026-11-16T00:00:00.000Z",
      toMs,
      nowMs,
    })
    expect(relativeBucketLabel(ms("2026-11-15T00:00:00.000Z"), readAtMs, "day", "UTC")).toBe("Today")
    expect(relativeBucketLabel(ms("2026-11-14T00:00:00.000Z"), readAtMs, "day", "UTC")).toBe("Yesterday")
  })

  it("never counts from later than the range's end", () => {
    // A past range (last month) read today: its end is the reference.
    const { readAtMs } = chartWindow({
      asOf: undefined,
      effectiveTo: "2026-11-01T00:00:00.000Z",
      toMs: ms("2026-11-01T00:00:00.000Z"),
      nowMs,
    })
    expect(readAtMs).toBe(ms("2026-11-01T00:00:00.000Z"))
  })

  it("uses the server's as_of when there is one", () => {
    const { readAtMs } = chartWindow({
      asOf: "2026-11-15T09:58:00.000Z",
      effectiveTo: "2026-11-16T00:00:00.000Z",
      toMs,
      nowMs,
    })
    expect(readAtMs).toBe(ms("2026-11-15T09:58:00.000Z"))
  })
})

describe("where the revenue and marker layers stop", () => {
  // Hourly "today": traffic is read up to 10:20, so the last plotted bucket
  // is 10:00. A sale at 11:05 (a clock ahead of the traffic read) must not
  // fold into the 10:00 bucket.
  const starts = Array.from({ length: 11 }, (_, h) => ms(`2026-11-15T${String(h).padStart(2, "0")}:00:00.000Z`))
  const window = chartWindow({
    asOf: "2026-11-15T10:20:00.000Z",
    effectiveTo: "2026-11-16T00:00:00.000Z",
    toMs: ms("2026-11-16T00:00:00.000Z"),
    nowMs: ms("2026-11-15T10:20:00.000Z"),
  })

  it("drops a revenue point after the last traffic bucket", () => {
    const point = {
      bucket: "2026-11-15T11:00:00.000Z",
      currency: "EUR",
      charge_gross_minor: 5000,
      refund_minor: 0,
      dispute_withdrawn_minor: 0,
      dispute_reinstated_minor: 0,
      fee_minor: 0,
      net_minor: 4800,
      charge_count: 1,
      refund_count: 0,
      dispute_count: 0,
      unconverted_count: 0,
    }
    expect(bucketRevenue(starts, window.layerEndMs, [point]).buckets.size).toBe(0)
  })

  it("drops a marker after the last traffic bucket", () => {
    const sale = { id: "s", kind: "sale", at: ms("2026-11-15T11:05:00.000Z"), payload: null }
    expect(bucketMarkers(starts, window.layerEndMs, [sale])).toEqual([])
  })

  it("keeps a marker inside the last bucket", () => {
    const sale = { id: "s", kind: "sale", at: ms("2026-11-15T10:10:00.000Z"), payload: null }
    expect(bucketMarkers(starts, window.layerEndMs, [sale]).map((b) => b.startMs)).toEqual([
      ms("2026-11-15T10:00:00.000Z"),
    ])
  })
})
