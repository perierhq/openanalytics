import { describe, expect, it } from "vitest"

import type { ReferrerPathRow, SourceRow } from "./api"
import {
  CHANNEL_LABELS,
  foldAiReferrals,
  foldChannels,
  foldReferrers,
  pathHostsOf,
  REFERRER_PATHS_MAX_DAYS,
  referrerPathsByRow,
  referrerPathsServable,
  sourcesGroupByFor,
  sourcesReadParams,
} from "./source-rows"

const row = (
  referrer_domain: string,
  channel: SourceRow["channel"],
  visitors: number,
  extra: Partial<SourceRow> = {}
): SourceRow => ({
  referrer_domain,
  utm_source: "",
  utm_medium: "",
  utm_campaign: "",
  channel,
  views: visitors * 2,
  visitors,
  ...extra,
})

describe("the Channels cut", () => {
  it("folds rows by the channel the server gave them, ranked by visitors", () => {
    const rows = foldChannels([
      row("google.com", "organic_search", 50),
      row("", "direct", 40),
      row("x.com", "social", 10),
      row("t.co", "social", 15),
      row("", "email", 5, { utm_medium: "email" }),
    ])
    expect(rows.map((r) => [r.label, r.channel, r.visitors])).toEqual([
      ["Organic search", "organic_search", 50],
      ["Direct", "direct", 40],
      ["Social", "social", 25],
      ["Email", "email", 5],
    ])
  })

  it("never re-derives a channel from the referrer", () => {
    // A row the server called referral stays referral, whatever its host
    // looks like: the classifier is the server's, not the card's.
    const rows = foldChannels([row("google.com", "referral", 3)])
    expect(rows.map((r) => r.channel)).toEqual(["referral"])
  })

  it("labels every channel", () => {
    expect(Object.keys(CHANNEL_LABELS).sort()).toEqual(
      [
        "affiliate",
        "ai",
        "direct",
        "email",
        "organic_search",
        "paid",
        "referral",
        "social",
      ].sort()
    )
  })
})

describe("the sources read each cut makes", () => {
  it("asks the api for one row per channel on the Channels cut", () => {
    // The api's `group_by=channel` reads the deepest tuple list the gateway
    // serves; summing the card's own top-100 tuple read undercounts every
    // channel past the 100th tuple. One source of truth: the server's.
    expect(sourcesGroupByFor("channels")).toBe("channel")
    expect(sourcesReadParams({ groupBy: sourcesGroupByFor("channels") })).toEqual({
      group_by: "channel",
    })
  })

  it("keeps the tuple read for every other cut", () => {
    for (const view of [
      "referrers",
      "utm_campaign",
      "utm_source",
      "utm_medium",
    ] as const) {
      expect(sourcesGroupByFor(view)).toBeUndefined()
      expect(sourcesReadParams({ groupBy: sourcesGroupByFor(view) })).toEqual({})
    }
  })

  it("carries the filters either way", () => {
    expect(sourcesReadParams({ groupBy: "channel", filters: "[]" })).toEqual({
      group_by: "channel",
      filters: "[]",
    })
    expect(sourcesReadParams({ filters: "[]" })).toEqual({ filters: "[]" })
  })
})

describe("whether referring pages can be read for a range", () => {
  // The api checks the *effective* (aligned) range, so the card does too.
  const day = 86_400_000
  const range = (days: number) => ({
    from: "2026-04-01T00:00:00.000Z",
    to: new Date(Date.parse("2026-04-01T00:00:00.000Z") + days * day).toISOString(),
  })

  it("serves up to 92 days of the effective range", () => {
    expect(REFERRER_PATHS_MAX_DAYS).toBe(92)
    expect(referrerPathsServable(range(92))).toBe(true)
    expect(referrerPathsServable(range(7))).toBe(true)
  })

  it("does not serve past it", () => {
    expect(referrerPathsServable(range(92.5))).toBe(false)
    expect(referrerPathsServable(range(365))).toBe(false)
  })
})

describe("referring pages under a Referrers row", () => {
  const referrers = foldReferrers([
    row("lobste.rs", "referral", 30),
    row("x.com", "social", 20),
    row("t.co", "social", 10),
    row("google.com", "organic_search", 50),
    row("", "direct", 60),
  ])

  it("asks for the hosts of the top rows, never Direct", () => {
    expect(pathHostsOf(referrers, 20)).toEqual([
      "google.com",
      "lobste.rs",
      "x.com",
      "t.co",
    ])
    expect(pathHostsOf(referrers, 2)).toEqual(["google.com", "lobste.rs"])
  })

  it("gives a row its paths only when it has at least one", () => {
    const paths: ReferrerPathRow[] = [
      { referrer_domain: "lobste.rs", path: "/s/abc123/story", views: 9, visitors: 7 },
      { referrer_domain: "t.co", path: "/abc", views: 2, visitors: 2 },
      { referrer_domain: "x.com", path: "/someone/status/1", views: 4, visitors: 3 },
    ]
    const byRow = referrerPathsByRow(referrers, paths)
    expect(byRow.get("lobste.rs")?.map((p) => p.label)).toEqual([
      "lobste.rs/s/abc123/story",
    ])
    // X folds x.com and t.co: both hosts' paths, ranked together.
    expect(byRow.get("X")?.map((p) => [p.label, p.visitors])).toEqual([
      ["x.com/someone/status/1", 3],
      ["t.co/abc", 2],
    ])
    // No paths, no entry: the row renders without an expander.
    expect(byRow.has("Google")).toBe(false)
    expect(byRow.has("Direct / none")).toBe(false)
  })

  it("ignores a bare origin even if one arrives", () => {
    const byRow = referrerPathsByRow(referrers, [
      { referrer_domain: "lobste.rs", path: "/", views: 1, visitors: 1 },
      { referrer_domain: "lobste.rs", path: "", views: 1, visitors: 1 },
    ])
    expect(byRow.has("lobste.rs")).toBe(false)
  })
})

describe("the AI referrals rows", () => {
  it("are the rows the server put in the ai channel, and no others", () => {
    const rows = foldAiReferrals([
      row("chatgpt.com", "ai", 30),
      row("", "ai", 10, { utm_source: "chatgpt.com" }),
      row("", "ai", 4, { utm_source: "Claude AI", utm_medium: "claude.ai" }),
      // An assistant host the server put elsewhere (a paid tag won) is not an
      // AI referral, whatever the host looks like.
      row("perplexity.ai", "paid", 8, { utm_medium: "cpc" }),
      row("google.com", "organic_search", 50),
    ])
    expect(rows.map((r) => [r.label, r.visitors])).toEqual([
      ["ChatGPT", 40],
      ["Claude", 4],
    ])
    // Only a referrer host is a filter value.
    expect(rows[0]?.raw).toEqual(["chatgpt.com"])
  })

  it("names a tag-only AI row by the assistant, never by a non-AI host", () => {
    // The server put this tuple in `ai` because its medium names Claude; the
    // source names a social network and must not become the row's label.
    const rows = foldAiReferrals([
      row("", "ai", 6, { utm_source: "facebook.com", utm_medium: "claude.ai" }),
      row("", "ai", 3, { utm_source: "news.google.com", utm_medium: "chatgpt" }),
    ])
    expect(rows.map((r) => [r.label, r.visitors])).toEqual([
      ["Claude", 6],
      ["ChatGPT", 3],
    ])
  })
})
