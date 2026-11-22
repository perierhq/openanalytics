import { describe, expect, it } from "vitest"

import { bucketMarkers, markerStack, type EventMarkerItem } from "./event-markers"

const DAY = 86_400_000
const START = Date.parse("2026-06-20T00:00:00.000Z")
/** Five daily buckets: Jun 20 … Jun 24, the range ending Jun 25 00:00. */
const STARTS = Array.from({ length: 5 }, (_, i) => START + i * DAY)
const END = START + 5 * DAY

const item = (id: string, kind: string, at: number): EventMarkerItem<string, null> => ({
  id,
  kind,
  at,
  payload: null,
})

describe("bucketing marker items into the chart's own buckets", () => {
  it("puts each item in the bucket whose start is the last one at or before it", () => {
    const buckets = bucketMarkers(STARTS, END, [
      item("a", "mention", START),
      item("b", "mention", START + DAY - 1),
      item("c", "mention", START + 3 * DAY + 5),
    ])
    expect(buckets.map((bucket) => [bucket.index, bucket.items.map((i) => i.id)])).toEqual([
      [0, ["b", "a"]],
      [3, ["c"]],
    ])
    expect(buckets[0]?.startMs).toBe(START)
  })

  it("drops items before the first bucket and at or after the end", () => {
    const buckets = bucketMarkers(STARTS, END, [
      item("early", "mention", START - 1),
      item("last", "mention", END - 1),
      item("end", "mention", END),
    ])
    expect(buckets.map((bucket) => bucket.items.map((i) => i.id))).toEqual([["last"]])
    expect(buckets[0]?.index).toBe(4)
  })

  it("keeps mixed kinds in one bucket and counts each kind", () => {
    const buckets = bucketMarkers(STARTS, END, [
      item("m1", "mention", START + 2 * DAY + 10),
      item("s1", "sale", START + 2 * DAY + 20),
      item("m2", "mention", START + 2 * DAY + 30),
      item("s2", "sale", START + 4 * DAY),
    ])
    expect(buckets).toHaveLength(2)
    expect(buckets[0]?.index).toBe(2)
    expect(buckets[0]?.counts).toEqual({ mention: 2, sale: 1 })
    expect(buckets[0]?.kinds).toEqual(["mention", "sale"])
    expect(buckets[0]?.byKind.sale?.map((i) => i.id)).toEqual(["s1"])
    expect(buckets[1]?.counts).toEqual({ sale: 1 })
  })

  it("orders kinds by the order given, not by arrival", () => {
    const [bucket] = bucketMarkers(
      STARTS,
      END,
      [item("s", "sale", START + 1), item("m", "mention", START + 2)],
      ["mention", "sale"]
    )
    expect(bucket?.kinds).toEqual(["mention", "sale"])
  })

  it("puts a note in its bucket beside sales and mentions, stacked in the overview's order", () => {
    // The overview chart's order, bottom first: sales, mentions, notes.
    const order = ["sale", "mention", "note"]
    const buckets = bucketMarkers(
      STARTS,
      END,
      [
        item("n1", "note", START + DAY + 5),
        item("m1", "mention", START + DAY + 10),
        item("s1", "sale", START + DAY + 20),
        item("n2", "note", START + DAY + 30),
        item("n3", "note", START + 3 * DAY),
      ],
      order
    )
    expect(buckets.map((bucket) => bucket.index)).toEqual([1, 3])
    expect(buckets[0]?.kinds).toEqual(["sale", "mention", "note"])
    expect(buckets[0]?.counts).toEqual({ note: 2, mention: 1, sale: 1 })
    expect(buckets[0]?.byKind.note?.map((i) => i.id)).toEqual(["n2", "n1"])
    // A bucket with only a note is a bucket like any other.
    expect(buckets[1]?.kinds).toEqual(["note"])
  })

  it("sorts items newest first inside a bucket and accepts unsorted bucket input", () => {
    const [bucket] = bucketMarkers(STARTS, END, [
      item("old", "mention", START + 1),
      item("new", "mention", START + 9),
    ])
    expect(bucket?.items.map((i) => i.id)).toEqual(["new", "old"])
  })

  it("returns nothing with no buckets", () => {
    expect(bucketMarkers([], END, [item("a", "mention", START)])).toEqual([])
  })
})

describe("stacking a bucket's marks", () => {
  it("stacks two faces 2px apart and keeps a gap around a glyph", () => {
    // Bottom first: a sale's buyer face, then a mention's author face, neither
    // hiding the other.
    expect(markerStack(["face", "face"])).toEqual({ offsets: [0, 2], height: 20 + 2 + 20 })
    expect(markerStack(["face", "glyph"])).toEqual({ offsets: [0, 3], height: 31 })
    expect(markerStack(["glyph", "face"])).toEqual({ offsets: [0, 3], height: 31 })
    expect(markerStack(["glyph", "glyph"])).toEqual({ offsets: [0, 3], height: 19 })
    expect(markerStack(["face"])).toEqual({ offsets: [0], height: 20 })
  })
})
