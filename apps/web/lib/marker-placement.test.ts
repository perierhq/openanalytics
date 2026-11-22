import { describe, expect, it } from "vitest"

import {
  GLYPH_GAP,
  LEGEND_DEPTH,
  markerAnchorKey,
  markerAnchorY,
  markerHasStem,
  markerHitWidth,
  PLOT_BOTTOM_INSET,
  PLOT_TOP_SAFE,
  placeMarker,
  STEM_GAP,
} from "./marker-placement"
import { MARKER_FACE_HALO } from "./event-markers"
import { OVERVIEW_SERIES } from "./overview-series"

/** A 300px plot over 0…1000: y = 300 - value * 0.3, like the chart's own scale. */
const yScale = (value: number) => 300 - value * 0.3
const PLOT = 300
/** One face. */
const FACE = 20

describe("the anchor: the drawn series' value at the bucket", () => {
  it("puts the anchor where the line's own y scale puts the value", () => {
    expect(markerAnchorY({ visitors: 500 }, "visitors", yScale)).toBe(150)
    expect(markerAnchorY({ visitors: 0 }, "visitors", yScale)).toBe(300)
  })

  it("follows the selected metric's series, not visitors", () => {
    const point = { visitors: 500, session: 0.25 }
    const percent = (value: number) => 300 - value * 300
    expect(markerAnchorY(point, "session", percent)).toBe(225)
  })

  it("has no anchor where the series has no value (a gap in the line)", () => {
    expect(markerAnchorY({ visitors: 10 }, "session", yScale)).toBeNull()
    expect(markerAnchorY({ session: Number.NaN }, "session", yScale)).toBeNull()
    expect(markerAnchorY(undefined, "visitors", yScale)).toBeNull()
  })
})

describe("the series the markers sit on: the drawn primary series", () => {
  it("is visitors on the default chart and when visitors is pressed", () => {
    expect(markerAnchorKey(null)).toBe("visitors")
    expect(markerAnchorKey("visitors")).toBe("visitors")
  })

  it("is the pressed metric's own series in a metric mode", () => {
    expect(markerAnchorKey("pageviews")).toBe("pageviews")
    // Both session metrics draw the chart's `session` series.
    expect(markerAnchorKey("bounce_rate")).toBe("session")
    expect(markerAnchorKey("avg_visit")).toBe("session")
    // Revenue as the main series: the bars' tops.
    expect(markerAnchorKey("revenue")).toBe("revenueTop")
  })

  it("names the overview chart's own series keys, from the module the chart draws them with", () => {
    expect(markerAnchorKey(null)).toBe(OVERVIEW_SERIES.visitors)
    expect(markerAnchorKey("pageviews")).toBe(OVERVIEW_SERIES.pageviews)
    expect(markerAnchorKey("bounce_rate")).toBe(OVERVIEW_SERIES.session)
    expect(markerAnchorKey("revenue")).toBe(OVERVIEW_SERIES.revenueTop)
  })
})

describe("a marker's hit area", () => {
  it("is 24px wide on a faces chart, whose columns are at least that wide", () => {
    expect(markerHitWidth(true, 24)).toBe(24)
    expect(markerHitWidth(true, 60)).toBe(24)
  })

  it("never outgrows its bucket's column on a dense chart, so neighbours never overlap", () => {
    expect(markerHitWidth(false, 5)).toBe(5)
    expect(markerHitWidth(false, 11.5)).toBe(11.5)
    expect(markerHitWidth(false, 40)).toBe(24)
  })

  it("is 24px where the chart has no column width (a single bucket)", () => {
    expect(markerHitWidth(false, 0)).toBe(24)
  })
})

describe("which stacks stand on a stem", () => {
  const sale = { stemless: false }
  const mention = {}
  const note = { stemless: true }

  it("gives faces mode a stem, whether the bucket shows a face or a kind's glyph", () => {
    expect(markerHasStem(true, [sale])).toBe(true)
    expect(markerHasStem(true, [mention])).toBe(true)
    expect(markerHasStem(true, [sale, mention, note])).toBe(true)
  })

  it("gives a lone note flag no stem: the flag has a pole of its own", () => {
    expect(markerHasStem(true, [note])).toBe(false)
  })

  it("gives no marker on a dense chart a stem", () => {
    expect(markerHasStem(false, [sale])).toBe(false)
    expect(markerHasStem(false, [sale, mention, note])).toBe(false)
    expect(markerHasStem(false, [note])).toBe(false)
  })
})

describe("on the line, with a stem", () => {
  it("sits above the point with a stem from the point to the stack's bottom, and a dot", () => {
    const at = placeMarker({ anchorY: 150, stackHeight: FACE, stem: true, plotHeight: PLOT })
    expect(at.side).toBe("above")
    expect(at.stackTop).toBe(150 - STEM_GAP - FACE)
    expect(at.stem).toEqual({ top: 150 - STEM_GAP, bottom: 150 })
    expect(at.dot).toBe(true)
    expect(at.anchorY).toBe(150)
  })

  it("flips below the point when the stack would cross the top of the plot, the stem going down", () => {
    const anchor = PLOT_TOP_SAFE + STEM_GAP + FACE - 1
    const at = placeMarker({ anchorY: anchor, stackHeight: FACE, stem: true, plotHeight: PLOT })
    expect(at.side).toBe("below")
    expect(at.stackTop).toBe(anchor + STEM_GAP)
    expect(at.stem).toEqual({ top: anchor, bottom: anchor + STEM_GAP })
  })

  it("stays above when the stack exactly meets the top-safe line", () => {
    const anchor = PLOT_TOP_SAFE + STEM_GAP + FACE
    const at = placeMarker({ anchorY: anchor, stackHeight: FACE, stem: true, plotHeight: PLOT })
    expect(at.side).toBe("above")
    expect(at.stackTop).toBe(PLOT_TOP_SAFE)
  })

  it("keeps a stack at the top clear of the legend chips, a face's halo included", () => {
    const anchor = PLOT_TOP_SAFE + STEM_GAP + FACE
    const at = placeMarker({ anchorY: anchor, stackHeight: FACE, stem: true, plotHeight: PLOT })
    expect(at.side).toBe("above")
    // At least 4px of air between the chips' bottom edge and the halo.
    expect(at.stackTop - MARKER_FACE_HALO - LEGEND_DEPTH).toBeGreaterThanOrEqual(4)
  })

  it("clamps inside the plot when the stack fits neither above nor below, with no stem", () => {
    const at = placeMarker({ anchorY: 40, stackHeight: 60, stem: true, plotHeight: 100 })
    expect(at.side).toBe("clamped")
    expect(at.stackTop).toBeGreaterThanOrEqual(PLOT_TOP_SAFE)
    expect(at.stackTop + 60).toBeLessThanOrEqual(100 - PLOT_BOTTOM_INSET)
    expect(at.stem).toBeNull()
  })

  it("anchors to the bottom of the plot when the value is missing, with no stem or dot", () => {
    const at = placeMarker({ anchorY: null, stackHeight: FACE, stem: true, plotHeight: PLOT })
    expect(at.side).toBe("bottom")
    expect(at.stackTop).toBe(PLOT - PLOT_BOTTOM_INSET - FACE)
    expect(at.stem).toBeNull()
    expect(at.dot).toBe(false)
  })
})

describe("without a stem: dense glyphs and a lone note flag", () => {
  it("sits 4px above the point, with the dot on the line and no stem", () => {
    const at = placeMarker({ anchorY: 150, stackHeight: 8, stem: false, plotHeight: PLOT })
    expect(GLYPH_GAP).toBe(4)
    expect(at.side).toBe("above")
    expect(at.stackTop).toBe(150 - 4 - 8)
    expect(at.stem).toBeNull()
    expect(at.dot).toBe(true)
  })

  it("flips 4px below the point near the top, still without a stem", () => {
    const at = placeMarker({ anchorY: PLOT_TOP_SAFE + 4, stackHeight: 8, stem: false, plotHeight: PLOT })
    expect(at.side).toBe("below")
    expect(at.stackTop).toBe(PLOT_TOP_SAFE + 4 + GLYPH_GAP)
    expect(at.stem).toBeNull()
    expect(at.dot).toBe(true)
  })
})
