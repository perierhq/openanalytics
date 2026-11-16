import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { RowBar } from "./row-bar"

const render = (segments: Parameters<typeof RowBar>[0]["segments"]) =>
  renderToStaticMarkup(createElement(RowBar, { segments }))

describe("the bar behind a breakdown row", () => {
  it("draws nothing for a row with no width", () => {
    expect(render([])).toBe("")
    expect(render([{ tone: "traffic", fraction: 0 }])).toBe("")
  })

  it("is as wide as its share, in the calm accent tint", () => {
    const html = render([{ tone: "traffic", fraction: 0.5 }])
    expect(html).toContain("width:50%")
    expect(html).toContain("bg-primary/10")
  })

  it("draws the revenue segment in the success green, in the order given", () => {
    const html = render([
      { tone: "revenue", fraction: 0.25 },
      { tone: "traffic", fraction: 0.5 },
    ])
    expect(html).toContain("width:75%")
    expect(html.indexOf("bg-success/10")).toBeLessThan(html.indexOf("bg-primary/10"))
  })
})
