import { describe, expect, it } from "vitest"

import { thinAxisLabels } from "./x-axis-thinning"

const ticks = (xs: number[], labels: string[]) =>
  xs.map((x, i) => ({ x, label: labels[i] ?? "" }))

describe("thinning x-axis labels that would collide", () => {
  const labels = ["Jun 20", "Jun 27", "Jul 5", "Jul 12", "Jul 19"]

  it("keeps every label when there is room", () => {
    const wide = ticks([0, 330, 660, 990, 1320], labels)
    expect(thinAxisLabels(wide, { clampWidth: 1320, edgePad: 50 }).map((t) => t.label)).toEqual(labels)
  })

  it("skips a label that would touch its neighbour on a phone", () => {
    // 340px plot: the first label is clamped 50px in and lands on the second.
    const narrow = ticks([0, 82, 170, 255, 340], labels)
    expect(thinAxisLabels(narrow, { clampWidth: 340, edgePad: 50 }).map((t) => t.label)).toEqual([
      "Jun 20",
      "Jul 5",
      "Jul 19",
    ])
  })

  it("keeps the range's last label over the one before it", () => {
    const tight = ticks([0, 120, 300, 320], ["Jun 20", "Jul 1", "Jul 18", "Jul 19"])
    expect(thinAxisLabels(tight, { clampWidth: 400, edgePad: 40 }).map((t) => t.label)).toEqual([
      "Jun 20",
      "Jul 1",
      "Jul 19",
    ])
  })

  it("leaves one label or none alone", () => {
    expect(thinAxisLabels([], { clampWidth: 300, edgePad: 50 })).toEqual([])
    expect(thinAxisLabels(ticks([10], ["Jun 20"]), { clampWidth: 300, edgePad: 50 })).toHaveLength(1)
  })

  it("measures longer labels as wider", () => {
    const clock = ticks([0, 45, 90], ["00:00", "03:00", "06:00"])
    expect(thinAxisLabels(clock, { clampWidth: 1000, edgePad: 0 }).map((t) => t.label)).toEqual([
      "00:00",
      "03:00",
      "06:00",
    ])
    const dates = ticks([0, 45, 90], ["Sep 30", "Oct 1", "Oct 2"])
    expect(thinAxisLabels(dates, { clampWidth: 1000, edgePad: 0 }).map((t) => t.label)).toEqual([
      "Sep 30",
      "Oct 2",
    ])
  })
})
