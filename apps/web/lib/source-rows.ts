/**
 * The Sources card's rows, folded from the sources rollup's tuples
 * (referrer domain × utm source/medium/campaign): one dimension at a time,
 * ranked by visitors. Pure, and apart from the card, because the public share
 * board folds referrers the same way and must not pull the card's owner-only
 * revenue code into its bundle with it.
 *
 * Folding sums visitor counts across tuples, so a visitor who arrived under
 * two campaigns of one source counts twice in that row: a small, deliberate
 * over-count (see `top-sources-card.tsx`).
 */

import type { SourceRow } from "./api";
import { resolveReferrer } from "./referrers";

/** The label the Sources card gives a referrer domain; `""` is Direct. */
export function referrerLabel(domain: string): string {
  return domain === "" ? "Direct / none" : resolveReferrer(domain).name;
}

export type FoldedRow = {
  label: string;
  /** Canonical domain for the favicon — referrers view only. */
  domain: string | null;
  direct: boolean;
  views: number;
  visitors: number;
  /**
   * The raw `referrer_domain` values this row folded together, and what a
   * click filters by. The filter matches the canonical host exactly
   * (ADR-0075), and folding is by display name, which can merge more than
   * one host under one label; filtering by every host the row actually
   * holds is the only way the filtered numbers describe the row that was
   * clicked. Direct's raw value is the contract's own `""`.
   */
  raw: string[];
};

/** The referrer dimension: every row's domain, "" folding into Direct. */
export function foldReferrers(items: SourceRow[]): FoldedRow[] {
  const byLabel = new Map<string, FoldedRow>();
  for (const row of items) {
    const source = row.referrer_domain
      ? resolveReferrer(row.referrer_domain)
      : null;
    // The revenue join keys on the same label (`lib/row-revenue.ts`).
    const label = referrerLabel(row.referrer_domain);
    const bucket = byLabel.get(label) ?? {
      label,
      domain: source?.domain ?? null,
      direct: source === null,
      views: 0,
      visitors: 0,
      raw: [],
    };
    bucket.views += row.views;
    bucket.visitors += row.visitors;
    if (!bucket.raw.includes(row.referrer_domain)) {
      bucket.raw.push(row.referrer_domain);
    }
    byLabel.set(label, bucket);
  }
  return [...byLabel.values()].sort(byVisitors);
}

/** Ranked by the shown number, views breaking ties (see the file comment). */
function byVisitors(a: FoldedRow, b: FoldedRow): number {
  return b.visitors - a.visitors || b.views - a.views;
}

/** One utm dimension: tagged rows only — untagged traffic is not "(none)",
 *  it simply is not part of this cut. */
export function foldUtm(
  items: SourceRow[],
  key: "utm_source" | "utm_medium" | "utm_campaign"
): FoldedRow[] {
  const byLabel = new Map<string, FoldedRow>();
  for (const row of items) {
    const value = row[key].trim();
    if (value === "") continue;
    const bucket = byLabel.get(value) ?? {
      label: value,
      domain: null,
      direct: false,
      views: 0,
      visitors: 0,
      raw: [],
    };
    bucket.views += row.views;
    bucket.visitors += row.visitors;
    byLabel.set(value, bucket);
  }
  return [...byLabel.values()].sort(byVisitors);
}
