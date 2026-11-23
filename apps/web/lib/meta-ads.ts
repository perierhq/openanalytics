/**
 * Meta Ads: the rules the settings card and the Ad campaigns card share.
 *
 * Kept free of React and of any runtime import from `./api`, so they are
 * tested here once and the screens only ask. The account id and token checks
 * mirror the server's (`normalizeMetaAdAccountId`, `normalizeMetaAccessToken`
 * in `packages/domain/src/meta-ads.ts`), so a typo is named under its field
 * before a slow round trip to Meta.
 */

import type { AdCampaignRow, SiteRole } from "./api";

/** The connection and the campaigns read are `revenue:read`: owner only. */
export function canManageMetaAds(role: SiteRole): boolean {
  return role === "owner";
}

const AD_ACCOUNT_DIGITS = /^[0-9]{1,20}$/;
const TOKEN_SHAPE = /^[A-Za-z0-9_.|-]+$/;
const TOKEN_MIN_LENGTH = 20;
const TOKEN_MAX_LENGTH = 1024;

/** `act_` plus digits, from what a person pasted; bare digits are accepted. */
export function normalizeAdAccountInput(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.startsWith("act_") ? trimmed.slice(4) : trimmed;
  return AD_ACCOUNT_DIGITS.test(digits) ? `act_${digits}` : null;
}

export type MetaConnectProblems = {
  adAccountId?: string;
  token?: string;
};

/** What is wrong with the connect form, per field; empty when it can be sent. */
export function validateMetaConnectInput(input: {
  adAccountId: string;
  token: string;
}): MetaConnectProblems {
  const problems: MetaConnectProblems = {};
  if (normalizeAdAccountInput(input.adAccountId) === null) {
    problems.adAccountId = "Enter the ad account id, like act_1234567890.";
  }
  const token = input.token.trim();
  if (token === "") {
    problems.token = "Paste the System User token.";
  } else if (!TOKEN_SHAPE.test(token)) {
    problems.token = "A token has no spaces. Copy it again from Meta Business Settings.";
  } else if (token.length < TOKEN_MIN_LENGTH || token.length > TOKEN_MAX_LENGTH) {
    problems.token = "That is too short or too long to be a token. Copy it again.";
  }
  return problems;
}

/** ROAS as a multiple: one decimal below 10, whole above; a dash when unknown. */
export function formatRoas(roas: number | null): string {
  if (roas === null || !Number.isFinite(roas)) return "—";
  return roas >= 10 ? `${Math.round(roas)}×` : `${roas.toFixed(1)}×`;
}

/** Why a ROAS is a dash, in words; null when it is not. */
export function roasReason(
  reason: AdCampaignRow["roas_unavailable"],
  spendCurrency: string
): string | null {
  if (reason === "no_rate") {
    return `${spendCurrency} spend could not be converted: a day in this range has no exchange rate.`;
  }
  if (reason === "no_spend") return "Nothing was spent in this range.";
  return null;
}

/**
 * The spend a row shows: converted to the reporting currency when it could
 * be, so the column reads in one currency beside revenue; the account's own
 * currency otherwise.
 */
export function campaignSpend(
  row: AdCampaignRow,
  reportingCurrency: string
): { minor: number; currency: string } {
  return row.spend_converted_minor === null
    ? { minor: row.spend.amount_minor, currency: row.spend.currency }
    : { minor: row.spend_converted_minor, currency: reportingCurrency };
}

/** A campaign Meta sent no name for is named by its id. */
export function campaignLabel(row: AdCampaignRow): string {
  return row.name === "" ? `Campaign ${row.id}` : row.name;
}

export type CampaignSort = "spend" | "roas";

const spendOf = (row: AdCampaignRow) =>
  row.spend_converted_minor ?? row.spend.amount_minor;

/** Largest spend first, or best ROAS first with the unknown ones last. */
export function rankCampaigns(
  rows: readonly AdCampaignRow[],
  sort: CampaignSort
): AdCampaignRow[] {
  return [...rows].sort((a, b) => {
    if (sort === "roas") {
      if (a.roas === null && b.roas !== null) return 1;
      if (b.roas === null && a.roas !== null) return -1;
      if (a.roas !== null && b.roas !== null && a.roas !== b.roas) return b.roas - a.roas;
    }
    return spendOf(b) - spendOf(a) || (a.id < b.id ? -1 : 1);
  });
}
