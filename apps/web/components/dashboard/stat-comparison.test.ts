import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { computeDelta, computePointsDelta } from "@/lib/overview-compare"
import { StatComparison } from "./stat-comparison"

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const render = (current: number, previous: number, polarity?: "lower-is-better") =>
  renderToStaticMarkup(
    createElement(StatComparison, {
      delta: computeDelta(current, previous, polarity),
      previous: previous.toLocaleString("en-US"),
    })
  )

describe("a tile's comparison line", () => {
  it("prints the change, then the previous value", () => {
    expect(text(render(112, 100))).toMatch(/^\+12% vs 100 /)
  })

  it("draws an arrow beside a rise or a fall, so colour is never the only signal", () => {
    expect(render(112, 100)).toContain('data-direction="up"')
    expect(render(112, 100)).toContain("<svg")
    expect(render(96, 100)).toContain('data-direction="down"')
    expect(render(96, 100)).toContain("<svg")
  })

  it("draws no arrow when there is nothing to compare against", () => {
    const html = render(50, 0)
    expect(text(html)).toMatch(/^— vs 0 /)
    expect(html).not.toContain("<svg")
  })

  it("says the direction in words for a screen reader", () => {
    expect(render(96, 100)).toMatch(/sr-only[^>]*>Down 4% from 100 in the previous period</)
    expect(render(112, 100)).toMatch(/sr-only[^>]*>Up 12% from 100 in the previous period</)
    expect(render(50, 0)).toMatch(/sr-only[^>]*>No percentage change: the previous period was 0</)
  })

  it("leaves traffic uncoloured and colours bounce rate by what is good", () => {
    expect(render(120, 100)).toContain('data-tone="neutral"')
    expect(render(30, 40, "lower-is-better")).toContain('data-tone="good"')
    expect(render(50, 40, "lower-is-better")).toContain('data-tone="bad"')
  })
})

describe("a rate's comparison line", () => {
  it("prints the change in points and says it in words", () => {
    const html = renderToStaticMarkup(
      createElement(StatComparison, {
        delta: computePointsDelta(0.36, 0.31, "lower-is-better"),
        previous: "31%",
      })
    )
    expect(text(html)).toMatch(/^\+5 pts vs 31% /)
    expect(html).toContain("Up 5 points from 31% in the previous period")
  })

  it("says plainly when the previous period had nothing to measure", () => {
    const html = renderToStaticMarkup(
      createElement(StatComparison, {
        delta: { label: "—", direction: null, tone: "neutral" },
        previous: "—",
      })
    )
    expect(html).toContain("No visits in the previous period to compare with")
  })
})
