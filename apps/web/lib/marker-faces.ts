/**
 * Faces on the overview chart's markers: when there is room for them, and
 * whose.
 *
 * **Only mentions get faces.** A mention's author has a real picture (stored
 * and served by our API). A sale's buyer would need the visitor seed the rest
 * of the dashboard draws `UserAvatar` from (`visitor.visitor` on the revenue
 * card, `visitor.hash` on the globe), and a revenue transaction carries none:
 * a face made up from the transaction id would not match the same buyer
 * anywhere else, so sales keep their diamond.
 */

import type { Mention } from "./api";

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
