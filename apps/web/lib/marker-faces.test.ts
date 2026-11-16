import { describe, expect, it } from "vitest"

import type { Mention } from "./api"
import {
  FACE_BUCKET_LIMIT,
  markerFaceMode,
  mentionFace,
  rankMentionAuthors,
  topMentionAuthor,
} from "./marker-faces"

const mention = (
  id: number,
  handle: string,
  followers: number | null,
  postedAt: string,
  avatar_url: string | null = `/v1/sites/s/mentions/avatars/x/${handle}`
): Mention => ({
  id: `m${id}`,
  platform: "x",
  post_id: String(id),
  url: `https://x.com/${handle}/status/${id}`,
  text: "getopen.so",
  author: { handle, name: handle, followers, url: `https://x.com/${handle}`, avatar_url },
  posted_at: postedAt,
  matched_term: "getopen.so",
  links_to_site: true,
  likes: null,
  reposts: null,
  replies: null,
  quotes: null,
  views: null,
  first_seen_at: postedAt,
  refreshed_at: postedAt,
})

describe("when the markers show faces", () => {
  it("shows faces up to 45 buckets and glyphs above", () => {
    expect(FACE_BUCKET_LIMIT).toBe(45)
    expect(markerFaceMode(30, 40)).toBe(true)
    expect(markerFaceMode(45, 30)).toBe(true)
    expect(markerFaceMode(46, 30)).toBe(false)
    expect(markerFaceMode(90, 15)).toBe(false)
  })

  it("keeps glyphs when a column is too narrow for a face (a phone on 30 days)", () => {
    expect(markerFaceMode(30, 11.7)).toBe(false)
    expect(markerFaceMode(30, 24)).toBe(true)
  })
})

describe("whose face a bucket shows", () => {
  it("picks the author with the most followers", () => {
    const top = topMentionAuthor([
      mention(1, "small", 10, "2026-07-11T12:00:00Z"),
      mention(2, "big", 41_200, "2026-07-11T09:00:00Z"),
      mention(3, "unknown", null, "2026-07-11T15:00:00Z"),
    ])
    expect(top?.handle).toBe("big")
  })

  it("breaks a tie with the newest post", () => {
    const top = topMentionAuthor([
      mention(1, "older", 500, "2026-07-11T08:00:00Z"),
      mention(2, "newer", 500, "2026-07-11T18:00:00Z"),
    ])
    expect(top?.handle).toBe("newer")
  })

  it("counts every other mention in +N, and none for one", () => {
    const three = [
      mention(1, "a", 1, "2026-07-11T08:00:00Z"),
      mention(2, "b", 900, "2026-07-11T09:00:00Z"),
      mention(3, "a", 1, "2026-07-11T10:00:00Z"),
    ]
    expect(mentionFace(three)).toMatchObject({ author: { handle: "b" }, more: 2 })
    expect(mentionFace(three.slice(0, 1))).toMatchObject({ author: { handle: "a" }, more: 0 })
    expect(mentionFace([])).toBeNull()
  })

  it("ranks distinct authors for the tooltip, pictures only, at most three", () => {
    const ranked = rankMentionAuthors(
      [
        mention(1, "a", 10, "2026-07-11T08:00:00Z"),
        mention(2, "b", 300, "2026-07-11T09:00:00Z"),
        mention(3, "b", 300, "2026-07-11T10:00:00Z"),
        mention(4, "nopic", 9_999, "2026-07-11T11:00:00Z", null),
        mention(5, "c", 20, "2026-07-11T12:00:00Z"),
        mention(6, "d", 5, "2026-07-11T13:00:00Z"),
      ],
      { limit: 3, withPicture: true }
    )
    expect(ranked.map((author) => author.handle)).toEqual(["b", "c", "a"])
  })
})
