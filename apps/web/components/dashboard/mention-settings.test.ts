import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { SiteMentionSettings } from "@/lib/api"
import { MentionSettingsForm, mentionStatusLine } from "./mention-settings-form"

const settings = (overrides: Partial<SiteMentionSettings> = {}): SiteMentionSettings => ({
  domain: "getopen.so",
  x_enabled: true,
  terms: ["OpenAnalytics"],
  last_polled_at: null,
  last_error: null,
  ...overrides,
})

/** The switch's own opening tag. */
const switchTag = (html: string) => html.match(/<[^>]*role="switch"[^>]*>/)?.[0] ?? ""

const render = (canEdit: boolean, value = settings()) =>
  renderToStaticMarkup(
    createElement(MentionSettingsForm, {
      busy: false,
      canEdit,
      error: null,
      onTermsChange: () => {},
      onToggle: () => {},
      settings: value,
    })
  )

describe("the mention settings block", () => {
  it("lets an owner or admin toggle and add terms", () => {
    const html = render(true)
    expect(html).toContain("Watch X for mentions")
    expect(switchTag(html)).not.toContain('aria-disabled="true"')
    expect(html).toMatch(/<input[^>]*id="mention-term-input"/)
    expect(html).toContain('aria-label="Remove OpenAnalytics"')
    expect(html).toContain(
      "Searches X for posts that mention getopen.so and the terms below. When it&#x27;s on, getopen.so and your terms are sent to the X search service on each check. Nothing about your visitors is sent."
    )
  })

  it("shows a viewer the settings without any way to change them", () => {
    const html = render(false)
    expect(html).toContain("OpenAnalytics")
    expect(switchTag(html)).toContain('aria-disabled="true"')
    expect(html).not.toContain("mention-term-input")
    expect(html).not.toContain("Remove OpenAnalytics")
    expect(html).toContain("Only an owner or admin can change this.")
  })
})

describe("a site without a domain", () => {
  it("describes only the terms, and can't be turned on without one", () => {
    const html = render(true, settings({ domain: "", x_enabled: false, terms: [] }))
    expect(html).toContain(
      "Searches X for posts that mention the terms below. When it&#x27;s on, your terms are sent to the X search service on each check. Nothing about your visitors is sent."
    )
    expect(html).not.toContain("is always searched")
    expect(switchTag(html)).toContain('aria-disabled="true"')
    expect(html).toContain("Add a domain to the site or at least one term first.")
  })

  it("can be turned on once it has a term", () => {
    const html = render(true, settings({ domain: "", x_enabled: false, terms: ["Acme"] }))
    expect(switchTag(html)).not.toContain('aria-disabled="true"')
  })
})

describe("the status line", () => {
  it("says when the last check ran, or that none has", () => {
    expect(mentionStatusLine(settings())).toBe("Not checked yet")
    const recent = new Date(Date.now() - 5 * 60_000).toISOString()
    expect(mentionStatusLine(settings({ last_polled_at: recent }))).toBe("Last checked 5 min ago")
  })

  it("names each failure in plain words", () => {
    expect(mentionStatusLine(settings({ last_error: "unavailable" }))).toBe(
      "The last check failed: the X search service didn't answer."
    )
    expect(mentionStatusLine(settings({ last_error: "invalid_response" }))).toBe(
      "The last check failed: the X search service sent something we couldn't read."
    )
  })
})
