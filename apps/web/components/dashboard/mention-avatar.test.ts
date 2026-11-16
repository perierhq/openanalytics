// @vitest-environment happy-dom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"

import type { Mention } from "@/lib/api"
import { MentionAvatar } from "./mention-avatar"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const author = (avatar_url: string | null): Mention["author"] => ({
  handle: "ada",
  name: "Ada Lovelace",
  followers: 1200,
  url: "https://x.com/ada",
  avatar_url,
})

const PATH = "/v1/sites/site_1/mentions/avatars/x/ada"

const html = (avatar_url: string | null) =>
  renderToStaticMarkup(createElement(MentionAvatar, { author: author(avatar_url), size: 24 }))

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe("a mention author's avatar", () => {
  it("shows the initials when there is no stored picture", () => {
    const out = html(null)
    expect(out).not.toContain("<img")
    expect(out).toContain(">AL<")
  })

  it("shows the stored picture from the API, quietly", () => {
    const out = html(PATH)
    const img = out.match(/<img [^>]*>/)?.[0] ?? ""
    expect(img).toContain(`src="${PATH}"`)
    expect(img).toContain('alt=""')
    expect(img).toContain('loading="lazy"')
    expect(img).toContain('decoding="async"')
    expect(img).toMatch(/referrerpolicy="no-referrer"/i)
    expect(img).toContain('width="24"')
  })

  it("refuses an X address and keeps the initials", () => {
    const out = html("https://pbs.twimg.com/profile_images/1/ada_normal.jpg")
    expect(out).not.toContain("<img")
    expect(out).not.toContain("twimg")
    expect(out).toContain(">AL<")
  })

  it("falls back to the initials when the picture fails to load", () => {
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    act(() => root?.render(createElement(MentionAvatar, { author: author(PATH), size: 32 })))
    const img = host.querySelector("img")
    expect(img).not.toBeNull()
    act(() => {
      img?.dispatchEvent(new Event("error"))
    })
    expect(host.querySelector("img")).toBeNull()
    expect(host.textContent).toBe("AL")
  })
})
