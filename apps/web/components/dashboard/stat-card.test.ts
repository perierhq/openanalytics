import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { StatCard } from "./stat-card"

const stat = { label: "Visitors", display: "12,874", info: "Unique people." }
const render = (pressed: boolean | null) =>
  renderToStaticMarkup(
    createElement(StatCard, {
      stat,
      ...(pressed === null
        ? {}
        : { chart: { metric: "visitors" as const, pressed, onPress: () => {} } }),
    })
  )

/** The classes of the element whose class list contains `marker`. */
function classesWith(html: string, marker: string): string[] {
  const match = [...html.matchAll(/class="([^"]*)"/g)].find((m) => m[1]?.includes(marker))
  return match?.[1]?.split(/\s+/) ?? []
}

describe("a stat tile as a chart control", () => {
  it("is a toggle button that says whether its metric is on the chart", () => {
    expect(render(true)).toContain('aria-pressed="true"')
    expect(render(false)).toContain('aria-pressed="false"')
    expect(render(null)).not.toContain("<button")
  })

  it("rings its inner panel, inset, when focused from the keyboard", () => {
    // The frame's squircle clip cuts any ring drawn outside it, so the ring
    // goes inside the value panel, where nothing clips it.
    for (const pressed of [false, true]) {
      const html = render(pressed)
      const button = html.match(/<button[^>]*class="([^"]*)"/)?.[1]?.split(/\s+/) ?? []
      expect(button).toContain("peer")
      const panel = classesWith(html, "peer-focus-visible:ring-2")
      expect(panel).toContain("peer-focus-visible:ring-inset")
      expect(panel).toContain("peer-focus-visible:ring-ring")
    }
  })

  it("keeps the focus ring on a pressed tile", () => {
    const panel = classesWith(render(true), "peer-focus-visible:ring-2")
    expect(panel.some((name) => /ring-0|ring-transparent/.test(name))).toBe(false)
  })
})
