import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { RevenueBucket } from "@/lib/chart-revenue"
import { MentionGlyph, SaleGlyph } from "./chart-marker-glyphs"
import { OverviewTooltipContent } from "./overview-chart-tooltip"

const bucket = (overrides: Partial<RevenueBucket> = {}): RevenueBucket => ({
  startMs: Date.parse("2026-07-11T00:00:00.000Z"),
  currency: "EUR",
  netMinor: 0,
  grossMinor: 0,
  refundMinor: 0,
  sales: 0,
  unconverted: 0,
  otherCurrencies: false,
  ...overrides,
})

const render = (props: Partial<Parameters<typeof OverviewTooltipContent>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(OverviewTooltipContent, {
      title: "Sat, Jul 11",
      visitors: 3165,
      pageviews: 6406,
      revenue: null,
      sales: 0,
      mentions: 0,
      ...props,
    })
  )

/** The markup's text, without tags. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim()

describe("the overview chart's day tooltip", () => {
  it("reads date, then traffic", () => {
    const out = text(render())
    expect(out).toBe("Sat, Jul 11 Visitors 3,165 Pageviews 6,406")
  })

  it("has no revenue section without revenue for the bucket", () => {
    expect(text(render())).not.toContain("Revenue")
  })

  it("shows net first, refunds negative, and leaves out zero lines", () => {
    const out = text(
      render({ revenue: bucket({ netMinor: 3800, refundMinor: 1200, sales: 2 }) })
    )
    expect(out).toContain("Revenue €38.00")
    expect(out).toContain("Refunds −€12.00")
    expect(out).not.toContain("Gross")
  })

  it("counts sales once, in the markers line, not again under revenue", () => {
    const out = text(
      render({ sales: 3, revenue: bucket({ netMinor: 3800, grossMinor: 3800, sales: 2 }) })
    )
    expect(out).toContain("3 sales")
    expect(out).not.toMatch(/Sales \d/)
  })

  it("drops revenue per visitor under a filter and says why", () => {
    const out = text(
      render({ filtered: true, revenue: bucket({ netMinor: 3800, grossMinor: 3800, sales: 2 }) })
    )
    expect(out).toContain("Revenue €38.00")
    expect(out).not.toContain("Revenue per visitor")
    expect(out).toContain("Revenue isn't filtered.")
  })

  it("has no revenue per visitor without visitors", () => {
    const out = text(
      render({ visitors: 0, revenue: bucket({ netMinor: 4900, grossMinor: 4900, sales: 1 }) })
    )
    expect(out).toContain("Revenue per visitor —")
  })

  it("keeps unconverted sales visible", () => {
    const out = text(render({ revenue: bucket({ unconverted: 2 }) }))
    expect(out).toContain("2 sales could not be converted")
  })

  it("summarises markers in one line each", () => {
    const out = text(render({ sales: 3, mentions: 1 }))
    expect(out).toContain("3 sales")
    expect(out).toContain("1 mention")
  })

  it("draws the same glyphs as the chart's markers", () => {
    const html = render({ sales: 3, mentions: 1 })
    expect(html).toContain(renderToStaticMarkup(createElement(SaleGlyph)))
    expect(html).toContain(renderToStaticMarkup(createElement(MentionGlyph)))
  })
})
