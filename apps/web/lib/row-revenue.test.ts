import { describe, expect, it, vi } from "vitest"

import type {
  RevenueAttributionResponse,
  RevenueAttributionRow,
  RevenueConnectionState,
} from "./api"
import {
  hasUnconvertedOrders,
  joinAttribution,
  loadRowRevenue,
  revenueOf,
  revenuePerVisitor,
  revenueRowKey,
  ROW_REVENUE_LIMIT,
  rowRevenueAmount,
  rowRevenueCaveat,
  rowRevenueHold,
  rowRevenueTip,
  seeAllColumns,
  sharedAttribution,
  sortRows,
  type RowRevenue,
  type RowRevenueDeps,
  type RowRevenueEntry,
} from "./row-revenue"
import { referrerLabel } from "./source-rows"

const RANGE = {
  from: "2026-06-20T00:00:00.000Z",
  to: "2026-07-20T00:00:00.000Z",
  timezone: "UTC",
}

const row = (
  value: string | null,
  revenue_minor: number,
  overrides: Partial<RevenueAttributionRow> = {}
): RevenueAttributionRow => ({
  value,
  revenue_minor,
  recurring_revenue_minor: 0,
  orders: 1,
  unconverted_orders: 0,
  buyers: 1,
  visitors: null,
  conversion_rate: null,
  revenue_per_visitor_minor: null,
  ...overrides,
})

const response = (
  dimension: RevenueAttributionResponse["dimension"],
  rows: RevenueAttributionRow[],
  visitors_available = false
): Pick<
  RevenueAttributionResponse,
  "currency" | "dimension" | "rows" | "visitors_available"
> => ({
  currency: "USD",
  dimension,
  rows,
  visitors_available,
})

const entry = (overrides: Partial<RowRevenueEntry> = {}): RowRevenueEntry => ({
  revenueMinor: 10_000,
  buyers: 2,
  visitors: 400,
  unconvertedOrders: 0,
  ...overrides,
})

describe("which card row a revenue row belongs to", () => {
  it("files the empty referrer under Direct / none, like the Sources card", () => {
    expect(referrerLabel("")).toBe("Direct / none")
    expect(revenueRowKey("referrer_domain", "")).toBe("Direct / none")
  })

  it("folds referrer hosts the way the card does, whatever their case", () => {
    expect(revenueRowKey("referrer_domain", "Google.com")).toBe("Google")
    expect(revenueRowKey("referrer_domain", "www.google.com")).toBe("Google")
    expect(revenueRowKey("referrer_domain", "t.co")).toBe("X")
  })

  it("matches utm values exactly after trimming, as the card and the api group them", () => {
    expect(revenueRowKey("utm_source", " newsletter ")).toBe("newsletter")
    expect(revenueRowKey("utm_source", "Newsletter")).toBe("Newsletter")
    // Untagged traffic is not a row of a utm cut.
    expect(revenueRowKey("utm_campaign", "")).toBeNull()
  })

  it("matches entry pages by their path", () => {
    expect(revenueRowKey("entry_page", "/pricing")).toBe("/pricing")
  })

  it("has no row for unattributed revenue", () => {
    expect(revenueRowKey("referrer_domain", null)).toBeNull()
  })
})

describe("joining attribution rows onto the card", () => {
  it("sums hosts that fold into one source, and drops unattributed revenue", () => {
    const joined = joinAttribution(
      response("referrer_domain", [
        row(null, 9_900),
        row("google.com", 4_000, { buyers: 2 }),
        row("Google.com", 1_000, { buyers: 1 }),
        row("", 2_500),
      ])
    )
    expect(joined.currency).toBe("USD")
    expect(revenueOf(joined, "Google")).toMatchObject({ revenueMinor: 5_000, buyers: 3 })
    expect(revenueOf(joined, "Direct / none")).toMatchObject({ revenueMinor: 2_500 })
    expect([...joined.byKey.keys()]).not.toContain("Unattributed")
  })

  it("keeps utm values of a different case apart", () => {
    const joined = joinAttribution(
      response("utm_source", [row("newsletter", 1_000), row("Newsletter", 400)])
    )
    expect(revenueOf(joined, "newsletter")?.revenueMinor).toBe(1_000)
    expect(revenueOf(joined, "Newsletter")?.revenueMinor).toBe(400)
  })

  it("shows nothing for a row without revenue", () => {
    const joined = joinAttribution(
      response("entry_page", [row("/pricing", 0, { orders: 1, unconverted_orders: 1 })])
    )
    expect(revenueOf(joined, "/pricing")).toBeNull()
    expect(revenueOf(joined, "/docs")).toBeNull()
    expect(revenueOf(null, "/pricing")).toBeNull()
  })
})

describe("revenue per visitor", () => {
  it("divides the row's revenue by the attribution's own visitors", () => {
    expect(revenuePerVisitor(entry({ revenueMinor: 10_000, visitors: 400 }))).toBe(25)
  })

  it("has no answer when the attribution did not count visitors, or counted none", () => {
    expect(revenuePerVisitor(entry({ visitors: null }))).toBeNull()
    expect(revenuePerVisitor(entry({ visitors: 0 }))).toBeNull()
  })
})

describe("the visitors a row's revenue is divided by", () => {
  it("are the session entries the attribution counted, summed over folded hosts", () => {
    const joined = joinAttribution(
      response(
        "referrer_domain",
        [
          row("google.com", 4_000, { visitors: 300 }),
          row("www.google.com", 1_000, { visitors: 20 }),
          // Direct: the attribution's own entries, not the card's Direct row,
          // which also holds internal navigation.
          row("", 2_500, { visitors: 90 }),
        ],
        true
      )
    )
    expect(revenueOf(joined, "Google")?.visitors).toBe(320)
    expect(revenueOf(joined, "Direct / none")?.visitors).toBe(90)
  })

  it("are unknown when the response says visitors are not available", () => {
    const joined = joinAttribution(
      response("entry_page", [row("/pricing", 4_000, { visitors: 300 })], false)
    )
    expect(revenueOf(joined, "/pricing")?.visitors).toBeNull()
  })

  it("are unknown when a folded value has no count", () => {
    const joined = joinAttribution(
      response(
        "referrer_domain",
        [row("google.com", 4_000, { visitors: 300 }), row("www.google.com", 1, { visitors: null })],
        true
      )
    )
    expect(revenueOf(joined, "Google")?.visitors).toBeNull()
  })
})

describe("the row tooltip", () => {
  it("shows the attribution's visitors and revenue per visitor when it counted them", () => {
    const tip = rowRevenueTip(entry({ revenueMinor: 10_000, visitors: 400, buyers: 3 }), "USD")
    expect(tip.lines).toEqual([
      ["Visitors", "400"],
      ["Revenue", "$100.00"],
      ["Revenue per visitor", "$0.25"],
      ["Buyers", "3"],
    ])
    expect(tip.note).toBeNull()
  })

  it("has no Visitors line and no revenue per visitor without the attribution's count", () => {
    const tip = rowRevenueTip(entry({ visitors: null }), "USD")
    expect(tip.lines.map(([label]) => label)).toEqual(["Revenue", "Buyers"])
  })

  it("says how many orders in other currencies the amount leaves out", () => {
    expect(rowRevenueTip(entry({ unconvertedOrders: 3 }), "USD").note).toBe(
      "3 orders in other currencies not included"
    )
    expect(rowRevenueTip(entry({ unconvertedOrders: 1 }), "USD").note).toBe(
      "1 order in another currency not included"
    )
  })
})

describe("orders in other currencies", () => {
  it("are carried onto the row they belong to", () => {
    const joined = joinAttribution(
      response("referrer_domain", [
        row("google.com", 4_000, { unconverted_orders: 2 }),
        row("www.google.com", 1_000, { unconverted_orders: 1 }),
      ])
    )
    expect(revenueOf(joined, "Google")?.unconvertedOrders).toBe(3)
  })

  it("are noticed only on the card's own rows", () => {
    const joined = joinAttribution(
      response("utm_source", [
        row("newsletter", 4_000),
        row("partner", 1_000, { unconverted_orders: 1 }),
      ])
    )
    expect(hasUnconvertedOrders(joined, ["newsletter"])).toBe(false)
    expect(hasUnconvertedOrders(joined, ["newsletter", "partner"])).toBe(true)
  })
})

describe("the card's caveat", () => {
  it("says renewals are in the revenue, and which touch gets it", () => {
    expect(rowRevenueCaveat({ entryPages: false, unconverted: false })).toBe(
      "Revenue, including renewals, is credited to the visit's last source before the purchase."
    )
    expect(rowRevenueCaveat({ entryPages: true, unconverted: false })).toBe(
      "Revenue, including renewals, is credited to the entry page of the visit's last session before the purchase."
    )
  })

  it("adds one sentence when a row leaves orders out", () => {
    const text = rowRevenueCaveat({ entryPages: false, unconverted: true })
    expect(text.startsWith("Revenue, including renewals,")).toBe(true)
    expect(text.split(". ")).toHaveLength(2)
    expect(text).toContain("no exchange rate")
  })
})

describe("the amount a row prints", () => {
  it("is compact money in en-US, like the visitor numbers beside it", () => {
    const Original = Intl.NumberFormat
    const spy = vi
      .spyOn(Intl, "NumberFormat")
      .mockImplementation(function (
        locales?: Intl.LocalesArgument,
        options?: Intl.NumberFormatOptions
      ) {
        return new Original(locales, options)
      } as typeof Intl.NumberFormat)
    try {
      expect(rowRevenueAmount(entry({ revenueMinor: 1_234_500 }), "USD")).toBe("$12.3K")
      expect(spy.mock.calls.length).toBeGreaterThan(0)
      for (const [locale] of spy.mock.calls) expect(locale).toBe("en-US")
    } finally {
      spy.mockRestore()
    }
  })

  it("is nothing for a row without revenue", () => {
    expect(rowRevenueAmount(null, "USD")).toBeNull()
  })
})

describe("when the card holds its revenue read", () => {
  const base = {
    dimension: "referrer_domain" as const,
    rangePending: false,
    filtered: false,
    range: RANGE,
  }

  it("reads for a settled, unfiltered range", () => {
    expect(rowRevenueHold(base)).toBe(false)
  })

  it("sends nothing for a cut revenue is not about", () => {
    expect(rowRevenueHold({ ...base, dimension: null })).toBe(true)
  })

  it("sends nothing while the range is still pending", () => {
    expect(rowRevenueHold({ ...base, rangePending: true })).toBe(true)
  })

  it("is hidden under a filter, which the attribution cannot apply", () => {
    expect(rowRevenueHold({ ...base, filtered: true })).toBe(true)
  })

  it("skips a range over 400 days, which the api refuses", () => {
    const days = (n: number) => ({
      from: "2025-01-01T00:00:00.000Z",
      to: new Date(Date.parse("2025-01-01T00:00:00.000Z") + n * 86_400_000).toISOString(),
      timezone: "UTC",
    })
    expect(rowRevenueHold({ ...base, range: days(400) })).toBe(false)
    expect(rowRevenueHold({ ...base, range: days(401) })).toBe(true)
  })
})

describe("one attribution read per cut and range", () => {
  const RESPONSE = {
    ...response("referrer_domain", [row("google.com", 4_000)]),
    touch: "last",
    meta: {} as RevenueAttributionResponse["meta"],
  } as RevenueAttributionResponse
  const options = (dimension: RevenueAttributionResponse["dimension"]) => ({
    dimension,
    touch: "last" as const,
    limit: ROW_REVENUE_LIMIT,
  })

  it("answers a cut the page has read from the first read", async () => {
    const read = vi.fn(async () => RESPONSE)
    const cached = sharedAttribution(read)
    await cached("s", RANGE, options("referrer_domain"))
    await cached("s", RANGE, options("utm_source"))
    await cached("s", RANGE, options("referrer_domain"))
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("reads again for another range or site", async () => {
    const read = vi.fn(async () => RESPONSE)
    const cached = sharedAttribution(read)
    await cached("s", RANGE, options("referrer_domain"))
    await cached("s", { ...RANGE, from: "2026-06-21T00:00:00.000Z" }, options("referrer_domain"))
    await cached("t", RANGE, options("referrer_domain"))
    expect(read).toHaveBeenCalledTimes(3)
  })

  it("forgets a failed read, so the next look tries again", async () => {
    const read = vi
      .fn<RowRevenueDeps["attribution"]>()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValue(RESPONSE)
    const cached = sharedAttribution(read)
    await expect(cached("s", RANGE, options("referrer_domain"))).rejects.toThrow("503")
    await expect(cached("s", RANGE, options("referrer_domain"))).resolves.toBe(RESPONSE)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("reads again once the answer is old", async () => {
    let now = 0
    const read = vi.fn(async () => RESPONSE)
    const cached = sharedAttribution(read, { ttlMs: 1_000, now: () => now })
    await cached("s", RANGE, options("referrer_domain"))
    now = 1_001
    await cached("s", RANGE, options("referrer_domain"))
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe("sorting rows by revenue", () => {
  const rows = [
    { label: "a", visitors: 300, revenue: 0 },
    { label: "b", visitors: 200, revenue: 5_000 },
    { label: "c", visitors: 100, revenue: 9_000 },
    { label: "d", visitors: 250, revenue: 0 },
  ]
  const by = {
    traffic: (r: (typeof rows)[number]) => r.visitors,
    revenue: (r: (typeof rows)[number]) => r.revenue,
  }

  it("ranks by revenue, rows without revenue after, by visitors", () => {
    expect(sortRows(rows, "revenue", by).map((r) => r.label)).toEqual(["c", "b", "a", "d"])
  })

  it("leaves the visitors order alone", () => {
    expect(sortRows(rows, "visitors", by)).toBe(rows)
  })
})

describe("the See all columns", () => {
  it("adds a Revenue column to sources and entry pages when revenue is shown", () => {
    expect(seeAllColumns("sources", true)).toEqual(["Visitors", "Revenue"])
    expect(seeAllColumns("entries", true)).toEqual(["Entries", "Bounce", "Revenue"])
  })

  it("has no Revenue column without revenue, or on cuts revenue is not about", () => {
    expect(seeAllColumns("sources", false)).toEqual(["Visitors"])
    expect(seeAllColumns("entries", false)).toEqual(["Entries", "Bounce"])
    expect(seeAllColumns("pages", true)).toEqual(["Views", "Visitors"])
    expect(seeAllColumns("exits", true)).toEqual(["Exits", "Views"])
  })
})

describe("who gets revenue on the rows", () => {
  const ACTIVE = { status: "active" } as RevenueConnectionState

  function deps(
    state: RevenueConnectionState | Error = ACTIVE,
    attribution: RevenueAttributionResponse | Error = {
      ...response("referrer_domain", [row("google.com", 4_000)]),
      touch: "last",
      visitors_available: false,
      meta: {} as RevenueAttributionResponse["meta"],
    }
  ) {
    return {
      revenueState: vi.fn(async () => {
        if (state instanceof Error) throw state
        return state
      }),
      attribution: vi.fn(async () => {
        if (attribution instanceof Error) throw attribution
        return attribution
      }),
    } satisfies RowRevenueDeps
  }

  it("never asks the revenue api for an admin or a viewer", async () => {
    for (const role of ["admin", "viewer"] as const) {
      const d = deps()
      const result = await loadRowRevenue(
        { siteId: "s", role, range: RANGE, dimension: "referrer_domain" },
        d
      )
      expect(result).toBeNull()
      expect(d.revenueState).not.toHaveBeenCalled()
      expect(d.attribution).not.toHaveBeenCalled()
    }
  })

  it("stops after the connection read when no provider is connected", async () => {
    const d = deps({ status: "not_connected" } as RevenueConnectionState)
    const result = await loadRowRevenue(
      { siteId: "s", role: "owner", range: RANGE, dimension: "referrer_domain" },
      d
    )
    expect(result).toBeNull()
    expect(d.attribution).not.toHaveBeenCalled()
  })

  it("asks an owner's last-touch attribution for the card's dimension", async () => {
    const d = deps()
    const result = (await loadRowRevenue(
      { siteId: "s", role: "owner", range: RANGE, dimension: "entry_page" },
      d
    )) as RowRevenue
    expect(d.attribution).toHaveBeenCalledWith(
      "s",
      RANGE,
      expect.objectContaining({ dimension: "entry_page", touch: "last" })
    )
    expect(result.currency).toBe("USD")
  })

  it("asks for the contract's 500 rows, so the visitor scan covers every earner", async () => {
    const d = deps()
    await loadRowRevenue(
      { siteId: "s", role: "owner", range: RANGE, dimension: "referrer_domain" },
      d
    )
    expect(ROW_REVENUE_LIMIT).toBe(500)
    expect(d.attribution).toHaveBeenCalledWith(
      "s",
      RANGE,
      expect.objectContaining({ limit: 500 })
    )
  })

  it("turns a failed read into no revenue", async () => {
    expect(
      await loadRowRevenue(
        { siteId: "s", role: "owner", range: RANGE, dimension: "utm_source" },
        deps(ACTIVE, new Error("503"))
      )
    ).toBeNull()
    expect(
      await loadRowRevenue(
        { siteId: "s", role: "owner", range: RANGE, dimension: "utm_source" },
        deps(new Error("offline"))
      )
    ).toBeNull()
  })
})
