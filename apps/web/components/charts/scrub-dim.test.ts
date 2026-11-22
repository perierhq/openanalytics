import { describe, expect, it } from "vitest"

import { scrubDimCut } from "./scrub-dim"

const hovering = {
  dimOpacity: 0.35,
  canInteract: true,
  tooltipX: 100,
  selecting: false,
  innerWidth: 400,
  columnWidth: 20,
}

describe("the scrub dim's cut", () => {
  it("sits at the hovered bucket's right edge, halfway to the next point", () => {
    expect(scrubDimCut(hovering)).toBe(110)
  })

  it("never runs past the plot's right edge", () => {
    expect(scrubDimCut({ ...hovering, tooltipX: 395 })).toBe(400)
  })

  it("is off without a dim, without a hover, while selecting, and while the chart cannot be used", () => {
    expect(scrubDimCut({ ...hovering, dimOpacity: undefined })).toBeNull()
    expect(scrubDimCut({ ...hovering, tooltipX: null })).toBeNull()
    expect(scrubDimCut({ ...hovering, selecting: true })).toBeNull()
    expect(scrubDimCut({ ...hovering, canInteract: false })).toBeNull()
  })
})
