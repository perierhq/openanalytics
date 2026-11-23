import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { AdCampaignsResponse } from "@/lib/api"
import { AdCampaignList, adCampaignsTitleFigure, adCampaignsVisibility } from "./ad-campaign-rows"

const response = (overrides: Partial<AdCampaignsResponse> = {}): AdCampaignsResponse => ({
  connection: {
    status: "active",
    ad_account_name: "Acme Ads",
    currency: "USD",
    last_synced_at: null,
    last_error: null,
  },
  currency: "EUR",
  from_day: "2026-11-01",
  to_day: "2026-11-07",
  campaigns: [
    {
      id: "111",
      name: "Black Friday",
      spend: { amount_minor: 25_000, currency: "USD" },
      spend_converted_minor: 20_000,
      revenue_minor: 56_000,
      orders: 4,
      roas: 2.8,
      roas_unavailable: null,
      matched_by: "name",
    },
    {
      id: "222",
      name: "",
      spend: { amount_minor: 6_250, currency: "USD" },
      spend_converted_minor: 5_000,
      revenue_minor: 25_000,
      orders: 1,
      roas: 5,
      roas_unavailable: null,
      matched_by: "id",
    },
  ],
  totals: {
    spend: { amount_minor: 31_250, currency: "USD" },
    spend_converted_minor: 25_000,
    revenue_minor: 81_000,
    orders: 5,
    roas: 3.24,
    roas_unavailable: null,
  },
  unmatched: { campaigns: 0, spend: { amount_minor: 0, currency: "USD" }, spend_converted_minor: 0 },
  ...overrides,
})

const render = (data: AdCampaignsResponse, sort: "spend" | "roas" = "spend") =>
  renderToStaticMarkup(createElement(AdCampaignList, { data, sort }))

describe("when the card exists at all", () => {
  it("is only for the owner of a site with a Meta connection", () => {
    expect(adCampaignsVisibility("admin", { status: "ready", data: response() })).toBe("hidden")
    expect(adCampaignsVisibility("owner", { status: "loading" })).toBe("hidden")
    expect(adCampaignsVisibility("owner", { status: "ready", data: response({ connection: null }) })).toBe(
      "hidden"
    )
    expect(adCampaignsVisibility("owner", { status: "ready", data: response() })).toBe("shown")
  })

  it("folds away on a 403 and shows any other failure in place", () => {
    const forbidden = { kind: "forbidden" as const, title: "x", body: "y", retryable: false }
    const down = { kind: "unavailable" as const, title: "x", body: "y", retryable: true }
    expect(adCampaignsVisibility("owner", { status: "error", error: forbidden, retry: () => {} })).toBe("hidden")
    expect(adCampaignsVisibility("owner", { status: "error", error: down, retry: () => {} })).toBe("shown")
  })
})

describe("the rows", () => {
  it("show spend and revenue in the reporting currency, and ROAS as a multiple", () => {
    const html = render(response())
    expect(html).toContain("Black Friday")
    expect(html).toContain("Campaign 222")
    expect(html).toContain("€200")
    expect(html).toContain("€560")
    expect(html).toContain("2.8×")
    expect(html).toContain("5.0×")
    expect(html.indexOf("Black Friday")).toBeLessThan(html.indexOf("Campaign 222"))
  })

  it("sort by ROAS on request", () => {
    const html = render(response(), "roas")
    expect(html.indexOf("Campaign 222")).toBeLessThan(html.indexOf("Black Friday"))
  })

  it("show a dash and say why when spend could not be converted", () => {
    const html = render(
      response({
        campaigns: [
          {
            id: "111",
            name: "Abroad",
            spend: { amount_minor: 10_000, currency: "PLN" },
            spend_converted_minor: null,
            revenue_minor: 5_000,
            orders: 1,
            roas: null,
            roas_unavailable: "no_rate",
            matched_by: "name",
          },
        ],
      })
    )
    expect(html).toContain("PLN")
    expect(html).toContain("—")
    expect(html).toContain("PLN spend could not be converted: a day in this range has no exchange rate.")
  })

  it("say when nothing was spent in the range", () => {
    expect(render(response({ campaigns: [] }))).toContain("No ad spend in this range.")
  })
})

describe("the figure beside the title", () => {
  it("is the total ROAS, or nothing when it is unknown", () => {
    expect(adCampaignsTitleFigure(response())).toBe("3.2× ROAS")
    expect(
      adCampaignsTitleFigure(
        response({ totals: { ...response().totals, roas: null, roas_unavailable: "no_rate" } })
      )
    ).toBeNull()
  })
})
