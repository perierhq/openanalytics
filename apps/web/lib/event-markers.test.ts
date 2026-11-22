import { describe, expect, it } from "vitest"

import {
  bucketMarkers,
  MARKER_BADGE,
  MARKER_FACE,
  MARKER_FACE_HALO,
  MARKER_GLYPH,
  markerStack,
  type EventMarkerItem,
  type MarkerSlot,
} from "./event-markers"

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
  it("keeps a gap around a glyph and a wider one between two faces", () => {
    // Bottom first: a sale's buyer face, then a mention's author face.
    expect(markerStack(["face", "face"])).toEqual({ offsets: [0, 8], height: 20 + 8 + 20 })
    expect(markerStack(["face", "glyph"])).toEqual({ offsets: [0, 6], height: 34 })
    expect(markerStack(["glyph", "face"])).toEqual({ offsets: [0, 6], height: 34 })
    expect(markerStack(["glyph", "glyph"])).toEqual({ offsets: [0, 3], height: 19 })
    expect(markerStack(["face"])).toEqual({ offsets: [0], height: 20 })
  })
})

/**
 * Each mark's drawn extent, bottom-up from the stack's bottom (0), as the
 * layer draws it: a face with its white halo, its "+N" badge (box and 1px
 * ring) centred on the face's right edge, a glyph with its 1px ring.
 */
function drawnStack(slots: readonly MarkerSlot[]) {
  const { offsets } = markerStack(slots)
  let bottom = 0
  return slots.map((slot, index) => {
    bottom += offsets[index] ?? 0
    const size = slot === "face" ? MARKER_FACE : MARKER_GLYPH
    const centre = bottom + size / 2
    const mark =
      slot === "face"
        ? { slot, from: bottom - MARKER_FACE_HALO, to: bottom + size + MARKER_FACE_HALO }
        : { slot, from: bottom - 1, to: bottom + size + 1 }
    const badge = { from: centre - MARKER_BADGE / 2 - 1, to: centre + MARKER_BADGE / 2 + 1 }
    bottom += size
    return { ...mark, badge }
  })
}

describe("a tall stack: a note flag over two faces with '+N' badges", () => {
  // Jul 11 in the mock data: a buyer's face, an author's face, a note's flag.
  const [buyer, author, flag] = drawnStack(["face", "face", "glyph"])

  it("keeps the two faces' halos apart", () => {
    expect(author!.from - buyer!.to).toBeGreaterThanOrEqual(2)
  })

  it("keeps the two faces' badges well apart, not just untouched", () => {
    expect(author!.badge.from - buyer!.badge.to).toBeGreaterThanOrEqual(10)
  })

  it("puts the flag clear of the top face's halo", () => {
    expect(flag!.from - author!.to).toBeGreaterThanOrEqual(2)
  })

  it("keeps a glyph under a face clear of the face's halo too", () => {
    const [glyph, face] = drawnStack(["glyph", "face"])
    expect(face!.from - glyph!.to).toBeGreaterThanOrEqual(2)
  })

  it("counts every gap in the stack's height", () => {
    expect(markerStack(["face", "face", "glyph"]).height).toBe(20 + 8 + 20 + 6 + 8)
  })
})
