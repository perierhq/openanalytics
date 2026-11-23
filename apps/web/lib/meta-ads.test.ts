import { describe, expect, it } from "vitest";

import type { AdCampaignRow } from "./api";
import {
  campaignLabel,
  campaignSpend,
  canManageMetaAds,
  formatRoas,
  normalizeAdAccountInput,
  rankCampaigns,
  roasReason,
  validateMetaConnectInput,
} from "./meta-ads";

const row = (overrides: Partial<AdCampaignRow> = {}): AdCampaignRow => ({
  id: "111",
  name: "Black Friday",
  spend: { amount_minor: 25_000, currency: "USD" },
  spend_converted_minor: 20_000,
  revenue_minor: 40_000,
  orders: 4,
  roas: 2,
  roas_unavailable: null,
  matched_by: "name",
  ...overrides,
});

describe("who may manage the Meta Ads connection", () => {
  it("is the owner only, like every revenue read", () => {
    expect(canManageMetaAds("owner")).toBe(true);
    expect(canManageMetaAds("admin")).toBe(false);
    expect(canManageMetaAds("viewer")).toBe(false);
  });
});

describe("the connect form's checks", () => {
  it("accepts act_ plus digits, or bare digits, as act_ plus digits", () => {
    expect(normalizeAdAccountInput(" act_123 ")).toBe("act_123");
    expect(normalizeAdAccountInput("123")).toBe("act_123");
    expect(normalizeAdAccountInput("act_")).toBeNull();
    expect(normalizeAdAccountInput("act-123")).toBeNull();
  });

  it("names the field that is wrong and what to do", () => {
    expect(validateMetaConnectInput({ adAccountId: "", token: "" })).toEqual({
      adAccountId: "Enter the ad account id, like act_1234567890.",
      token: "Paste the System User token.",
    });
    expect(
      validateMetaConnectInput({ adAccountId: "act_1", token: "EAA has spaces in it" })
    ).toEqual({ token: "A token has no spaces. Copy it again from Meta Business Settings." });
    expect(
      validateMetaConnectInput({ adAccountId: "act_1", token: "EAAG" + "x".repeat(40) })
    ).toEqual({});
  });
});

describe("ROAS", () => {
  it("reads as a multiple", () => {
    expect(formatRoas(2)).toBe("2.0×");
    expect(formatRoas(0.456)).toBe("0.5×");
    expect(formatRoas(12.34)).toBe("12×");
    expect(formatRoas(0)).toBe("0.0×");
  });

  it("is a dash when it cannot be had, with the reason in words", () => {
    expect(formatRoas(null)).toBe("—");
    expect(roasReason("no_rate", "USD")).toBe(
      "USD spend could not be converted: a day in this range has no exchange rate."
    );
    expect(roasReason("no_spend", "USD")).toBe("Nothing was spent in this range.");
    expect(roasReason(null, "USD")).toBeNull();
  });
});

describe("campaign rows", () => {
  it("shows the converted spend, or the account currency when it could not be converted", () => {
    expect(campaignSpend(row(), "EUR")).toEqual({ minor: 20_000, currency: "EUR" });
    expect(campaignSpend(row({ spend_converted_minor: null }), "EUR")).toEqual({
      minor: 25_000,
      currency: "USD",
    });
  });

  it("names a campaign Meta sent no name for by its id", () => {
    expect(campaignLabel(row())).toBe("Black Friday");
    expect(campaignLabel(row({ name: "" }))).toBe("Campaign 111");
  });

  it("ranks by spend, or by ROAS with the unknown ones last", () => {
    const rows = [
      row({ id: "a", spend_converted_minor: 100, roas: 5 }),
      row({ id: "b", spend_converted_minor: 900, roas: 0.5 }),
      row({ id: "c", spend_converted_minor: null, spend: { amount_minor: 500, currency: "USD" }, roas: null }),
      row({ id: "d", spend_converted_minor: 300, roas: 5 }),
    ];
    expect(rankCampaigns(rows, "spend").map((r) => r.id)).toEqual(["b", "c", "d", "a"]);
    expect(rankCampaigns(rows, "roas").map((r) => r.id)).toEqual(["d", "a", "b", "c"]);
  });
});
