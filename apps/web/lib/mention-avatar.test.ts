import { describe, expect, it } from "vitest"

import { mentionAvatarSrc } from "./mention-avatar"

const API = "https://api.analytics.example"
const PATH = "/v1/sites/site_1/mentions/avatars/x/ada"

describe("a mention author's picture address", () => {
  it("is nothing without a stored picture", () => {
    expect(mentionAvatarSrc(null, { apiBase: API })).toBeNull()
    expect(mentionAvatarSrc("", { apiBase: API })).toBeNull()
  })

  it("puts the API's own path on the API origin, the way requests are built", () => {
    expect(mentionAvatarSrc(PATH, { apiBase: API })).toBe(`${API}${PATH}`)
    expect(mentionAvatarSrc(PATH, { apiBase: `${API}/` })).toBe(`${API}${PATH}`)
    // No base configured: relative, like every other call.
    expect(mentionAvatarSrc(PATH, { apiBase: "" })).toBe(PATH)
  })

  it("accepts an absolute address only on the API origin", () => {
    expect(mentionAvatarSrc(`${API}${PATH}`, { apiBase: API })).toBe(`${API}${PATH}`)
    expect(mentionAvatarSrc(`https://elsewhere.example${PATH}`, { apiBase: API })).toBeNull()
  })

  it("never loads anything from X", () => {
    for (const url of [
      "https://pbs.twimg.com/profile_images/1/ada_normal.jpg",
      "http://pbs.twimg.com/profile_images/1/ada_normal.jpg",
      "//pbs.twimg.com/profile_images/1/ada_normal.jpg",
      "https://x.com/ada/photo",
      "https://abs.twimg.com/a.png",
    ]) {
      expect(mentionAvatarSrc(url, { apiBase: API })).toBeNull()
      expect(mentionAvatarSrc(url, { apiBase: "" })).toBeNull()
    }
  })

  it("refuses scripts, and image data unless mock mode allows it", () => {
    expect(mentionAvatarSrc("javascript:alert(1)", { apiBase: API })).toBeNull()
    const data = "data:image/svg+xml;utf8,<svg/>"
    expect(mentionAvatarSrc(data, { apiBase: API })).toBeNull()
    expect(mentionAvatarSrc(data, { apiBase: API, allowDataUrls: true })).toBe(data)
    expect(
      mentionAvatarSrc("data:text/html,<p>", { apiBase: API, allowDataUrls: true })
    ).toBeNull()
  })
})
