import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { Mention, RevenueTransaction } from "@/lib/api"
import { SaleGlyph } from "./chart-marker-glyphs"
import { OVERVIEW_MARKER_KINDS, type OverviewMarkerItem } from "./chart-marker-kinds"

const markup = (node: ReactNode) => renderToStaticMarkup(createElement("div", null, node))

const mentionItem = (id: number, handle: string, followers: number): OverviewMarkerItem => {
  const mention = {
    id: `m${id}`,
    posted_at: `2026-07-11T0${id}:00:00.000Z`,
    author: {
      handle,
      name: handle,
      followers,
      url: `https://x.com/${handle}`,
      avatar_url: `/v1/sites/s/mentions/avatars/x/${handle}`,
    },
  } as Mention
  return {
    id: mention.id,
    kind: "mention",
    at: Date.parse(mention.posted_at),
    payload: { kind: "mention", mention },
  }
}

const saleItem: OverviewMarkerItem = {
  id: "ch_1",
  kind: "sale",
  at: Date.parse("2026-07-11T10:00:00.000Z"),
  payload: { kind: "sale", sale: { object_id: "ch_1" } as RevenueTransaction },
}

describe("the overview chart's marker kinds", () => {
  it("keeps the diamond for sales: a transaction carries no visitor seed for a face", () => {
    expect(OVERVIEW_MARKER_KINDS.sale.face).toBeUndefined()
    expect(markup(OVERVIEW_MARKER_KINDS.sale.glyph)).toContain(
      renderToStaticMarkup(createElement(SaleGlyph))
    )
    // Not even a face made up from the transaction id.
    expect(saleItem.payload.kind).toBe("sale")
  })

  it("shows the top author's picture and counts the rest for mentions", () => {
    const face = OVERVIEW_MARKER_KINDS.mention.face
    expect(face).toBeDefined()
    const out = markup(
      face?.([mentionItem(1, "small", 10), mentionItem(2, "big", 9_000), mentionItem(3, "mid", 50)])
    )
    expect(out).toContain('src="/v1/sites/s/mentions/avatars/x/big"')
    expect(out).not.toContain("avatars/x/small")
    expect(out).toContain("+2")
  })

  it("has no count for a single mention", () => {
    const out = markup(OVERVIEW_MARKER_KINDS.mention.face?.([mentionItem(1, "solo", 10)]))
    expect(out).toContain("avatars/x/solo")
    expect(out).not.toContain("+")
  })
})
