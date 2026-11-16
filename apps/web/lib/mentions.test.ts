import { describe, expect, it } from "vitest"

import type { Mention } from "./api"
import {
  canEditMentions,
  matchedTermLabel,
  mentionCounts,
  mentionExcerpt,
  MAX_TERMS,
  validateNewTerm,
  validateTerms,
} from "./mentions"

const mention = (overrides: Partial<Mention> = {}): Mention => ({
  id: "0190c0de-0000-7000-8000-000000000001",
  platform: "x",
  post_id: "1800000000000000001",
  url: "https://x.com/ada/status/1800000000000000001",
  text: "Trying getopen.so for analytics",
  author: { handle: "ada", name: "Ada", followers: 1200, url: "https://x.com/ada" },
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

/** The contract: at most 5 extra terms, each 2–64 characters. */
describe("mention terms", () => {
  it("rejects a sixth term", () => {
    const five = ["alpha", "beta", "gamma", "delta", "epsilon"]
    expect(MAX_TERMS).toBe(5)
    expect(validateTerms(five)).toBeNull()
    expect(validateTerms([...five, "zeta"])).toMatch(/up to 5/i)
    expect(validateNewTerm("zeta", five, "getopen.so")).toMatch(/up to 5/i)
  })

  it("rejects a one-character term and one longer than 64", () => {
    expect(validateNewTerm("a", [], "getopen.so")).toMatch(/at least 2/i)
    expect(validateNewTerm("  a  ", [], "getopen.so")).toMatch(/at least 2/i)
    expect(validateNewTerm("x".repeat(65), [], "getopen.so")).toMatch(/64/)
    expect(validateNewTerm("ab", [], "getopen.so")).toBeNull()
    expect(validateNewTerm("x".repeat(64), [], "getopen.so")).toBeNull()
    expect(validateTerms(["a"])).toMatch(/at least 2/i)
  })

  it("rejects a duplicate and the domain itself", () => {
    expect(validateNewTerm("Open Analytics", ["open analytics"], "getopen.so")).toMatch(
      /already/i
    )
    expect(validateNewTerm("GetOpen.so", [], "getopen.so")).toMatch(/always searched/i)
  })
})

describe("who may edit", () => {
  it("lets owners and admins edit, and not viewers", () => {
    expect(canEditMentions("owner")).toBe(true)
    expect(canEditMentions("admin")).toBe(true)
    expect(canEditMentions("viewer")).toBe(false)
  })
})

describe("a mention row's parts", () => {
  it("lists the counts it has and omits the null ones", () => {
    expect(mentionCounts(mention()).map((count) => count.key)).toEqual([
      "likes",
      "replies",
      "views",
    ])
    expect(
      mentionCounts(mention({ likes: null, replies: null, views: null }))
    ).toEqual([])
  })

  it("shows the matched term only when it isn't the domain", () => {
    expect(matchedTermLabel(mention(), "getopen.so")).toBeNull()
    expect(matchedTermLabel(mention({ matched_term: "GetOpen.so" }), "getopen.so")).toBeNull()
    expect(matchedTermLabel(mention({ matched_term: "OpenAnalytics" }), "getopen.so")).toBe(
      "OpenAnalytics"
    )
  })

  it("cuts an excerpt at about 80 characters on a word", () => {
    const long = "word ".repeat(40).trim()
    const excerpt = mentionExcerpt(long)
    expect(excerpt.length).toBeLessThanOrEqual(81)
    expect(excerpt.endsWith("…")).toBe(true)
    expect(mentionExcerpt("short post")).toBe("short post")
  })
})
