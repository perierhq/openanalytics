/**
 * Faces on the overview chart's markers: when there is room for them, and
 * whose.
 *
 * **A mention shows its author**, from the picture our API stores and serves.
 *
 * **A sale shows its buyer**, drawn with `UserAvatar` from the transaction's
 * `visitor`: the anonymous id the buyer had in the purchase's last-touch
 * session, which is the same seed the globe, the realtime board and the
 * revenue card's "Paying visitors" draw that visitor from, so it is the same
 * face. The id rotates daily and is never the identify() hash. A sale that
 * matched no visitor has `visitor: null` and keeps its diamond; a face made
 * up from the transaction id would match the buyer nowhere else.
 */

import type { Mention, RevenueTransaction } from "./api";

// When faces fit is the marker layer's rule, kept with it (generic, like it).
export { FACE_BUCKET_LIMIT, FACE_MIN_COLUMN, markerFaceMode } from "./event-markers";

type Author = Mention["author"];

/** Most followers first (unknown counts last), then the newest post. */
function compareMentions(a: Mention, b: Mention): number {
  const followers = (b.author.followers ?? -1) - (a.author.followers ?? -1);
  if (followers !== 0) return followers;
  return Date.parse(b.posted_at) - Date.parse(a.posted_at);
}

/** The author a bucket's marker shows: the most followed, ties to the newest post. */
export function topMentionAuthor(mentions: readonly Mention[]): Author | null {
  return [...mentions].sort(compareMentions)[0]?.author ?? null;
}

/** The marker's face and its "+N": every other mention in the bucket. */
export function mentionFace(
  mentions: readonly Mention[]
): { author: Author; more: number } | null {
  const author = topMentionAuthor(mentions);
  return author ? { author, more: mentions.length - 1 } : null;
}

/**
 * Distinct authors in the same order, for the tooltip's row of small faces.
 * `withPicture` keeps only authors with a stored picture: initials at 16px
 * say nothing.
 */
export function rankMentionAuthors(
  mentions: readonly Mention[],
  { limit, withPicture = false }: { limit: number; withPicture?: boolean }
): Author[] {
  const seen = new Set<string>();
  const authors: Author[] = [];
  for (const mention of [...mentions].sort(compareMentions)) {
    const key = mention.author.handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (withPicture && !mention.author.avatar_url) continue;
    authors.push(mention.author);
    if (authors.length === limit) break;
  }
  return authors;
}

/**
 * The buyer a bucket's sales marker shows: the newest sale that matched a
 * visitor (`sales` arrive newest first), with "+N" for every other sale in
 * the bucket, faceless ones included. Null when none matched a visitor.
 */
export type SaleFace = { visitor: string; more: number };

export function saleFace(sales: readonly RevenueTransaction[]): SaleFace | null {
  const visitor = sales.find((sale) => sale.visitor)?.visitor;
  return visitor ? { visitor, more: sales.length - 1 } : null;
}

/** Distinct buyers, newest sale first, for the tooltip's row of small faces. */
export function rankSaleVisitors(
  sales: readonly RevenueTransaction[],
  { limit }: { limit: number }
): string[] {
  const visitors: string[] = [];
  for (const sale of sales) {
    if (!sale.visitor || visitors.includes(sale.visitor)) continue;
    visitors.push(sale.visitor);
    if (visitors.length === limit) break;
  }
  return visitors;
}
