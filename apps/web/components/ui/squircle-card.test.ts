import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { SquircleCard } from "./squircle-card"

const ACTIONS = "flex shrink-0 items-center gap-1"

const render = (props: Partial<Parameters<typeof SquircleCard>[0]>) =>
  renderToStaticMarkup(
    createElement(SquircleCard, { title: "Sources", children: null, ...props })
  )

describe("the card header's right side", () => {
  it("has no wrapper when there is nothing to put in it", () => {
    expect(render({ hideSeeAll: true })).not.toContain(ACTIONS)
  })

  it("leaves See all where it was on a card without actions", () => {
    const html = render({ onSeeAll: () => {} })
    expect(html).toContain("See all")
    expect(html).not.toContain(ACTIONS)
  })

  it("groups a card's actions with See all", () => {
    const html = render({
      onSeeAll: () => {},
      actions: createElement("button", { type: "button" }, "Visitors"),
    })
    expect(html).toContain(ACTIONS)
    expect(html.indexOf("Visitors")).toBeLessThan(html.indexOf("See all"))
  })
})
