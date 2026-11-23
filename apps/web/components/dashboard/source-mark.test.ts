import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { SourceRow } from "@/lib/api"
import { CHANNEL_LABELS, foldChannels } from "@/lib/source-rows"
import { BreakdownRow } from "./breakdown-row"
import { HoverList } from "./hover-list"
import { sourceMark } from "./source-mark"

const CHANNELS = Object.keys(CHANNEL_LABELS) as SourceRow["channel"][]

const rowsOf = (channels: SourceRow["channel"][]): SourceRow[] =>
  channels.map((channel, index) => ({
    referrer_domain: channel === "direct" ? "" : `host-${index}.example`,
    utm_source: "",
    utm_medium: "",
    utm_campaign: "",
    channel,
    views: 100 - index,
    visitors: 50 - index,
  }))

describe("the Channels cut", () => {
  it("renders one row per channel, each with its label and its own mark", () => {
    const folded = foldChannels(rowsOf(CHANNELS))
    const html = renderToStaticMarkup(
      createElement(
        HoverList,
        null,
        ...folded.map((row) =>
          createElement(BreakdownRow, {
            icon: sourceMark(row),
            key: row.label,
            name: row.label,
            value: row.visitors.toLocaleString("en-US"),
          })
        )
      )
    )
    for (const label of Object.values(CHANNEL_LABELS)) {
      expect(html).toContain(`>${label}<`)
    }
    // A mark per row, and no favicon: a channel is not a site.
    expect(html.match(/<svg/g)).toHaveLength(CHANNELS.length)
    expect(html).not.toContain("<img")

    const marks = new Set(
      folded.map((row) => renderToStaticMarkup(sourceMark(row) as never))
    )
    expect(marks.size).toBe(CHANNELS.length)
  })
})
