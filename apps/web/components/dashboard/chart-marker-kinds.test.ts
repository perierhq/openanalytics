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

const saleItem = (id: number, visitor: string | null): OverviewMarkerItem => {
  const sale = {
    object_id: `ch_${id}`,
    occurred_at: `2026-07-11T1${id}:00:00.000Z`,
    visitor,
  } as RevenueTransaction
  return {
    id: sale.object_id,
    kind: "sale",
    at: Date.parse(sale.occurred_at),
    payload: { kind: "sale", sale },
  }
}

describe("the overview chart's marker kinds", () => {
  it("stacks sales first, nearest the axis, so a buyer's face sits under a mention's", () => {
    expect(Object.keys(OVERVIEW_MARKER_KINDS)).toEqual(["sale", "mention"])
  })

  it("gives a sale its buyer's face, in the green ring with a diamond", () => {
    const face = OVERVIEW_MARKER_KINDS.sale.face
    expect(face).toBeDefined()
    const out = markup(face?.([saleItem(2, "anon_b"), saleItem(1, null)]))
    // The face (before hydration, its placeholder disc), the ring, the badge.
    expect(out).toContain("width:20px;height:20px")
    expect(out).toContain("ring-success")
    expect(out).toContain(renderToStaticMarkup(createElement(SaleGlyph)))
    // "+N" counts the bucket's other sales, faceless ones included.
    expect(out).toContain("+1")
  })

  it("draws no face for a sale that matched no visitor, so the diamond stays", () => {
    expect(OVERVIEW_MARKER_KINDS.sale.face?.([saleItem(1, null), saleItem(2, null)])).toBeNull()
    expect(markup(OVERVIEW_MARKER_KINDS.sale.glyph)).toContain(
      renderToStaticMarkup(createElement(SaleGlyph))
    )
  })

  it("has no count for a single sale", () => {
    expect(markup(OVERVIEW_MARKER_KINDS.sale.face?.([saleItem(1, "anon_a")]))).not.toContain("+")
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
