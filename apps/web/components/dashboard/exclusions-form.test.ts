import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { ExclusionLists } from "@/lib/exclusions"
import { ExclusionsForm, ExclusionsViewerNotice } from "./exclusions-form"

const lists = (overrides: Partial<ExclusionLists> = {}): ExclusionLists => ({
  ip_ranges: ["203.0.113.0/24"],
  paths: ["/admin/*"],
  countries: ["DE"],
  hostnames: ["staging.example.com"],
  ...overrides,
})

const render = (canEdit: boolean, value = lists(), countryActive: boolean | null = true) =>
  renderToStaticMarkup(
    createElement(ExclusionsForm, {
      busy: false,
      canEdit,
      countryActive,
      error: null,
      exclusions: value,
      onChange: () => {},
    })
  )

describe("the exclusions block", () => {
  it("gives an owner or admin an editor for each list", () => {
    const html = render(true)
    for (const kind of ["ip_ranges", "paths", "hostnames", "countries"]) {
      expect(html).toContain(`id="exclusions-${kind}-input"`)
    }
    expect(html).toContain('aria-label="Remove 203.0.113.0/24"')
    expect(html).toContain('aria-label="Remove /admin/*"')
    expect(html).toContain('aria-label="Remove staging.example.com"')
    // A country reads as its name, and the picker will not offer it twice.
    expect(html).toContain('aria-label="Remove Germany"')
    expect(html).toMatch(/<option disabled="" value="DE">Germany<\/option>/)
    expect(html).toContain(
      "Visits from these addresses aren&#x27;t counted. Use it for your office or your own devices."
    )
  })

  it("shows the lists to a reader without any way to change them", () => {
    const html = render(false)
    expect(html).toContain("203.0.113.0/24")
    expect(html).not.toContain("exclusions-ip_ranges-input")
    expect(html).not.toContain("<select")
    expect(html).not.toContain("Remove ")
    expect(html).toContain("Only an owner or admin can change this.")
  })

  it("says when country rules cannot match, and only then", () => {
    expect(render(true, lists(), false)).toContain("These may have no effect")
    expect(render(true, lists(), true)).not.toContain("These may have no effect")
    // Unknown is not "off".
    expect(render(true, lists(), null)).not.toContain("These may have no effect")
    // Nothing to warn about with no country listed.
    expect(render(true, lists({ countries: [] }), false)).not.toContain("These may have no effect")
  })

  it("stops offering a field once a list is full", () => {
    const full = Array.from({ length: 20 }, (_, i) => `h${i}.example.com`)
    const html = render(true, lists({ hostnames: full }))
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*id="exclusions-hostnames-input"[^>]*placeholder="20 of 20"/)
  })

  it("tells a viewer the lists exist and who can see them", () => {
    const html = renderToStaticMarkup(createElement(ExclusionsViewerNotice))
    expect(html).toContain("Only an owner or admin can see and change the lists.")
    expect(html).not.toContain("<input")
  })
})
