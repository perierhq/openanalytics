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

import type { ReferrerPathRow, SourceChannel, SourceRow } from "./api";
import { resolveAiUtm, resolveReferrer } from "./referrers";

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
  /** The channel a Channels-cut row stands for; absent on every other cut. */
  channel?: SourceChannel;
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

/** The cuts the Sources card offers, one dimension of the tuple each. */
export type SourceView =
  | "referrers"
  | "channels"
  | "utm_campaign"
  | "utm_source"
  | "utm_medium";

/**
 * The `group_by` a cut asks the sources read for. The Channels cut asks the
 * api for one row per channel (`group_by=channel`): the api sums the deepest
 * tuple list it serves, where the card's own read stops at the default top
 * 100 tuples, so the api's channel totals are the one source of truth and the
 * card never sums its own shorter list into a second answer.
 */
export function sourcesGroupByFor(view: SourceView): "channel" | undefined {
  return view === "channels" ? "channel" : undefined;
}

/** The query a sources read adds to its range. */
export function sourcesReadParams(options: {
  groupBy?: "channel" | undefined;
  filters?: string | undefined;
}): Record<string, string> {
  return {
    ...(options.groupBy !== undefined ? { group_by: options.groupBy } : {}),
    ...(options.filters ? { filters: options.filters } : {}),
  };
}

/**
 * The widest range referring pages are read for, in days: the api's cap on a
 * raw-event read (`FILTERED_MAX_SPAN_DAYS`).
 */
export const REFERRER_PATHS_MAX_DAYS = 92;

/**
 * Whether referring pages can be read for a range. Pass the sources read's
 * `meta.effective_range`: the api checks the aligned range it actually
 * queries, which can be wider than the one the picker asked for.
 */
export function referrerPathsServable(effective: {
  from: string;
  to: string;
}): boolean {
  const span = Date.parse(effective.to) - Date.parse(effective.from);
  return span <= REFERRER_PATHS_MAX_DAYS * 86_400_000;
}

/** What the Channels cut calls each channel the server can send. */
export const CHANNEL_LABELS: Record<SourceChannel, string> = {
  paid: "Paid",
  email: "Email",
  affiliate: "Affiliate",
  ai: "AI",
  organic_search: "Organic search",
  social: "Social",
  referral: "Referral",
  direct: "Direct",
};

/**
 * The channel dimension: rows folded by the `channel` the server put on each
 * tuple. The rule that decides a channel lives on the server
 * (`packages/domain/src/channel.ts`) and nowhere here: this only groups.
 */
export function foldChannels(items: SourceRow[]): FoldedRow[] {
  const byChannel = new Map<SourceChannel, FoldedRow>();
  for (const row of items) {
    const bucket = byChannel.get(row.channel) ?? {
      label: CHANNEL_LABELS[row.channel],
      domain: null,
      direct: row.channel === "direct",
      views: 0,
      visitors: 0,
      raw: [],
      channel: row.channel,
    };
    bucket.views += row.views;
    bucket.visitors += row.visitors;
    byChannel.set(row.channel, bucket);
  }
  return [...byChannel.values()].sort(byVisitors);
}

/**
 * The hosts to ask for referring pages: every raw host of the top `max`
 * Referrers rows, Direct left out (it has no host). One read covers the
 * See-all list, so a row's expander is known before it is drawn.
 */
export function pathHostsOf(rows: FoldedRow[], max: number): string[] {
  const hosts: string[] = [];
  for (const row of rows) {
    for (const host of row.raw) {
      if (host === "" || hosts.includes(host)) continue;
      if (hosts.length === max) return hosts;
      hosts.push(host);
    }
  }
  return hosts;
}

/** One referring page under a Referrers row. */
export type ReferrerPathItem = {
  /** Host and path, the way the page is known: `lobste.rs/s/abc123/story`. */
  label: string;
  views: number;
  visitors: number;
};

/**
 * Referring pages keyed by the Referrers row they belong to (by label), for
 * the rows that have any. A row whose hosts sent only their origin gets no
 * entry, which is what keeps an empty expander off the screen. A row that
 * folds several hosts (X is x.com and t.co) ranks their pages together.
 */
export function referrerPathsByRow(
  rows: FoldedRow[],
  paths: ReferrerPathRow[]
): Map<string, ReferrerPathItem[]> {
  const labelOfHost = new Map<string, string>();
  for (const row of rows) {
    for (const host of row.raw) {
      if (host !== "") labelOfHost.set(host, row.label);
    }
  }
  const byRow = new Map<string, ReferrerPathItem[]>();
  for (const path of paths) {
    if (path.path === "" || path.path === "/") continue;
    const label = labelOfHost.get(path.referrer_domain);
    if (label === undefined) continue;
    const list = byRow.get(label) ?? [];
    list.push({
      label: `${path.referrer_domain}${path.path}`,
      views: path.views,
      visitors: path.visitors,
    });
    byRow.set(label, list);
  }
  for (const list of byRow.values()) {
    list.sort((a, b) => b.visitors - a.visitors || b.views - a.views);
  }
  return byRow;
}

/**
 * The AI referrals card's rows: the tuples the server put in the `ai` channel,
 * folded by assistant and ranked by visitors. Which tuples are AI is the
 * server's answer (the same rule as the Channels cut, so the two always
 * agree); this only names them. A tuple with a referrer is named by it; one
 * that qualified by its utm tag alone is named by the tag, and adds no filter
 * value (ADR-0075 filters match the canonical host).
 */
export function foldAiReferrals(items: SourceRow[]): FoldedRow[] {
  const byLabel = new Map<string, FoldedRow>();
  for (const row of items) {
    if (row.channel !== "ai") continue;
    const referrer = row.referrer_domain
      ? resolveReferrer(row.referrer_domain)
      : null;
    const source = referrer ??
      resolveAiUtm(row.utm_source, row.utm_medium) ?? {
        name: row.utm_source || row.utm_medium,
        domain: null,
      };
    const bucket = byLabel.get(source.name) ?? {
      label: source.name,
      domain: source.domain,
      direct: false,
      views: 0,
      visitors: 0,
      raw: [],
    };
    bucket.views += row.views;
    bucket.visitors += row.visitors;
    if (referrer !== null && !bucket.raw.includes(row.referrer_domain)) {
      bucket.raw.push(row.referrer_domain);
    }
    byLabel.set(source.name, bucket);
  }
  return [...byLabel.values()].sort(byVisitors);
}
