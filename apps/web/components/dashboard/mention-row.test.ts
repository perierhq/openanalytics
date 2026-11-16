import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { Mention } from "@/lib/api"
import { MentionRow } from "./mention-row"

const mention = (overrides: Partial<Mention> = {}): Mention => ({
  id: "0190c0de-0000-7000-8000-000000000001",
  platform: "x",
  post_id: "1800000000000000001",
  url: "https://x.com/ada/status/1800000000000000001",
  text: "Trying getopen.so for analytics",
  author: { handle: "ada", name: "Ada Lovelace", followers: 1200, url: "https://x.com/ada", avatar_url: null },
  posted_at: "2026-07-01T10:00:00.000Z",
  matched_term: "getopen.so",
  links_to_site: true,
  likes: 4,
  reposts: null,
  replies: 0,
  quotes: null,
  views: 1500,
  first_seen_at: "2026-07-01T10:20:00.000Z",
  refreshed_at: "2026-07-01T11:20:00.000Z",
  ...overrides,
})

const render = (m: Mention) =>
  renderToStaticMarkup(createElement(MentionRow, { mention: m, domain: "getopen.so" }))

describe("a mention row", () => {
  it("renders the author, the post, the counts it has and the badge", () => {
    const html = render(mention())
    expect(html).toContain("Ada Lovelace")
    expect(html).toContain("@ada")
    expect(html).toContain("Trying getopen.so for analytics")
    expect(html).toContain("Links to your site")
    expect(html).toMatch(/4<\/span> likes/)
    expect(html).toMatch(/0<\/span> replies/)
    expect(html).toMatch(/1\.5K<\/span> views/)
    expect(html).toContain("1.2K followers")
    expect(html).not.toContain("reposts")
    // The domain matched, so naming it would say nothing.
    expect(html).not.toContain("Matched")
  })

  it("omits null counts, the badge when the post doesn't link, and followers when unknown", () => {
    const html = render(
      mention({
        likes: null,
        replies: null,
        views: null,
        links_to_site: false,
        matched_term: "OpenAnalytics",
        author: { handle: "ada", name: "Ada", followers: null, url: "https://x.com/ada", avatar_url: null },
      })
    )
    expect(html).not.toContain("Links to your site")
    expect(html).not.toMatch(/likes|replies|views|followers/)
    expect(html).toContain("OpenAnalytics")
  })

  it("links out safely and loads nothing from X", () => {
    const html = render(mention())
    expect(html).toContain('href="https://x.com/ada"')
    expect(html).toContain("Open on X")
    expect(html).toContain('href="https://x.com/ada/status/1800000000000000001"')
    for (const anchor of html.match(/<a [^>]*>/g) ?? []) {
      expect(anchor).toContain('rel="noopener noreferrer"')
      expect(anchor).toContain('target="_blank"')
    }
    expect(html).not.toContain("<img")
    expect(html).not.toContain("twimg")
    expect(html).toContain(">AL<")
  })

  it("shows the author's stored picture from our API when there is one", () => {
    const path = "/v1/sites/site_1/mentions/avatars/x/ada"
    const html = render(
      mention({
        author: { handle: "ada", name: "Ada Lovelace", followers: 1200, url: "https://x.com/ada", avatar_url: path },
      })
    )
    expect(html).toContain(`src="${path}"`)
    expect(html).not.toContain("twimg")
  })
})
