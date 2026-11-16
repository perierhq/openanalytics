import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { BreakdownRow, ROW_TOOLTIP_PLACEMENT } from "./breakdown-row"
import { HoverList } from "./hover-list"

type Props = Parameters<typeof BreakdownRow>[0]

const render = (props: Partial<Props> = {}) =>
  renderToStaticMarkup(
    createElement(
      HoverList,
      null,
      createElement(BreakdownRow, { name: "Google", value: "1,204", ...props })
    )
  )

const tag = (html: string, marker: string) => {
  const at = html.indexOf(marker)
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1)
}

describe("a breakdown row with a tooltip", () => {
  it("can be reached by keyboard and touch when the row is not a button", () => {
    const html = render({ tooltip: "Revenue $1" })
    const row = tag(html, 'tabindex="0"')
    expect(row.startsWith("<div")).toBe(true)
    expect(row).toContain("focus-visible:ring-2")
  })

  it("adds no tab stop to a plain row", () => {
    expect(render()).not.toContain("tabindex")
  })

  it("keeps a filter row a button, which is focusable already", () => {
    const html = render({ tooltip: "Revenue $1", onSelect: () => {} })
    expect(html).not.toContain('tabindex="0"')
    expect(html).toContain("<button")
  })

  it("opens below the row, never over the card header above it", () => {
    expect(ROW_TOOLTIP_PLACEMENT.side).toBe("bottom")
    expect(ROW_TOOLTIP_PLACEMENT.collisionPadding).toBeGreaterThan(0)
    // Not flipped above a row near the viewport's bottom either: for the
    // first row, above is the header.
    expect(ROW_TOOLTIP_PLACEMENT.collisionAvoidance.side).toBe("none")
  })
})

describe("the revenue column", () => {
  it("names the green amount for a screen reader", () => {
    const html = render({ revenue: "$12.3K" })
    expect(html).toMatch(/<span class="sr-only">revenue <\/span>\$12\.3K/)
  })

  it("grows for a long amount instead of wrapping or spilling", () => {
    const html = render({ revenue: "CHF 12.3K" })
    const column = tag(html, "text-success-foreground")
    expect(column).toContain("min-w-14")
    expect(column).toContain("whitespace-nowrap")
    expect(column).not.toMatch(/[\s"]w-14\b/)
  })

  it("keeps an empty cell for a row without revenue, with nothing to read", () => {
    const html = render({ revenue: null })
    expect(html).toContain("text-success-foreground")
    expect(html).not.toContain("sr-only")
  })
})
