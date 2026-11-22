import { describe, expect, it } from "vitest"

import {
  EXCLUSION_LIMITS,
  canEditExclusions,
  checkNewExclusion,
  exclusionCountryOptions,
  normalizeCountry,
  normalizeHostname,
  normalizeIpRange,
  normalizePath,
} from "./exclusions"

/**
 * The Exclusions block's own validation. It mirrors the server's
 * (`packages/domain/src/ingest-exclusions.ts`): a value accepted here must be
 * one the server accepts and stores in the same spelling, or the list on
 * screen and the list the collector matches would disagree.
 */

describe("addresses", () => {
  it("stores what the server stores", () => {
    expect(normalizeIpRange("203.0.113.7")).toBe("203.0.113.7/32")
    expect(normalizeIpRange("192.168.1.77/24")).toBe("192.168.1.0/24")
    expect(normalizeIpRange("2001:DB8:0:0:0:0:0:1")).toBe("2001:db8::1/128")
    expect(normalizeIpRange("2001:db8:abcd:12::1/48")).toBe("2001:db8:abcd::/48")
    expect(normalizeIpRange("::ffff:198.51.100.4")).toBe("198.51.100.4/32")
  })

  it("refuses what is not an address", () => {
    for (const bad of ["office", "10.0.0", "10.0.0.256", "10.0.0.1/33", "2001:db8:::1", "01.2.3.4"]) {
      expect(normalizeIpRange(bad), bad).toBeNull()
    }
  })

  it("explains a bad address and a duplicate under the field", () => {
    expect(checkNewExclusion("ip_ranges", "my office", [])).toEqual({
      ok: false,
      problem: "Enter an IP address like 203.0.113.7 or a range like 203.0.113.0/24.",
    })
    // The same address in another spelling is the same entry.
    expect(checkNewExclusion("ip_ranges", "203.0.113.7", ["203.0.113.7/32"])).toEqual({
      ok: false,
      problem: "That's already in the list.",
    })
    expect(checkNewExclusion("ip_ranges", " 203.0.113.7 ", [])).toEqual({
      ok: true,
      value: "203.0.113.7/32",
    })
  })

  it("stops at the limit and says how to make room", () => {
    const full = Array.from({ length: EXCLUSION_LIMITS.ip_ranges }, (_, i) => `10.0.0.${i}/32`)
    expect(checkNewExclusion("ip_ranges", "10.0.1.1", full)).toEqual({
      ok: false,
      problem: "You can add up to 50 addresses. Remove one to add another.",
    })
  })
})

describe("paths", () => {
  it("needs a leading slash and no query or fragment", () => {
    expect(normalizePath("/admin/*")).toBe("/admin/*")
    expect(normalizePath("admin")).toBeNull()
    expect(normalizePath("/a?b")).toBeNull()
    expect(checkNewExclusion("paths", "admin/*", [])).toEqual({
      ok: false,
      problem: "Start with / and leave out ? and #, for example /admin/*.",
    })
    expect(checkNewExclusion("paths", `/${"a".repeat(200)}`, [])).toEqual({
      ok: false,
      problem: "A path can be at most 200 characters.",
    })
  })
})

describe("hostnames", () => {
  it("lowercases a host and allows *. only at the front", () => {
    expect(normalizeHostname("Staging.Example.com")).toBe("staging.example.com")
    expect(normalizeHostname("*.preview.example.com")).toBe("*.preview.example.com")
    expect(normalizeHostname("https://example.com")).toBeNull()
    expect(normalizeHostname("example.com:8080")).toBeNull()
    expect(normalizeHostname("staging.*.example.com")).toBeNull()
  })
})

describe("internationalised hostnames", () => {
  it("stores a Unicode host in the ASCII form browsers report, as the server does", () => {
    expect(normalizeHostname("bücher.de")).toBe("xn--bcher-kva.de")
    expect(normalizeHostname("*.bücher.de")).toBe("*.xn--bcher-kva.de")
    expect(normalizeHostname("bücher.de/pfad")).toBeNull()
  })

  it("says what a Unicode host was saved as", () => {
    expect(checkNewExclusion("hostnames", "*.bücher.de", [])).toEqual({
      ok: true,
      value: "*.xn--bcher-kva.de",
      note: "Saved as *.xn--bcher-kva.de, the form browsers report for *.bücher.de.",
    })
    // An ASCII host needs no explaining.
    expect(checkNewExclusion("hostnames", "example.com", [])).toEqual({
      ok: true,
      value: "example.com",
    })
  })
})

describe("the server's other limits", () => {
  it("refuses an IPv6 range that would cover IPv4-mapped addresses, and says why", () => {
    expect(normalizeIpRange("::/0")).toBeNull()
    expect(normalizeIpRange("::ffff:0:0/95")).toBeNull()
    expect(normalizeIpRange("2001:db8::/32")).toBe("2001:db8::/32")
    expect(checkNewExclusion("ip_ranges", "::/64", [])).toEqual({
      ok: false,
      problem:
        "This IPv6 range would also cover IPv4 addresses, which IPv6 rules never match. Use a /96 or narrower IPv6 range, and add IPv4 ranges separately.",
    })
  })

  it("allows at most ten * in a path", () => {
    expect(normalizePath(`/${"*/".repeat(10)}`)).not.toBeNull()
    expect(checkNewExclusion("paths", `/${"*/".repeat(11)}`, [])).toEqual({
      ok: false,
      problem: "Use at most 10 * in one path.",
    })
  })

  it("takes only codes that name a country", () => {
    for (const bad of ["XX", "T1", "ZZ", "EU"]) {
      expect(normalizeCountry(bad), bad).toBeNull()
    }
    expect(normalizeCountry("de")).toBe("DE")
    expect(normalizeCountry("XK")).toBe("XK")
    expect(exclusionCountryOptions().some((option) => option.code === "XK")).toBe(true)
  })
})

describe("countries", () => {
  it("offers every country by name, each once", () => {
    const options = exclusionCountryOptions()
    expect(options.length).toBeGreaterThan(200)
    expect(new Set(options.map((option) => option.code)).size).toBe(options.length)
    expect(options.find((option) => option.code === "DE")?.name).toBe("Germany")
  })

  it("refuses a country twice", () => {
    expect(checkNewExclusion("countries", "DE", ["DE"])).toEqual({
      ok: false,
      problem: "That's already in the list.",
    })
  })
})

describe("who can edit", () => {
  it("is an owner or an admin", () => {
    expect(canEditExclusions("owner")).toBe(true)
    expect(canEditExclusions("admin")).toBe(true)
    expect(canEditExclusions("viewer")).toBe(false)
  })
})
