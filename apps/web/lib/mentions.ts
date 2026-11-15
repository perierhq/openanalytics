/**
 * Mentions: the rules the settings block and the Mentions list share.
 *
 * Kept free of React so the contract's limits are tested once, here, and the
 * screens only ask. The limits are the contract's (`SiteMentionSettings`):
 * at most five extra terms, each 2–64 characters. The domain is always
 * searched and never stored as a term, so typing it is refused with a reason
 * instead of being saved as a duplicate the server would have to explain.
 */

import type { Mention, SiteRole } from "./api";

export const MAX_TERMS = 5;
export const MIN_TERM_LENGTH = 2;
export const MAX_TERM_LENGTH = 64;

/** `PATCH /mentions/settings` is owner or admin; a viewer's is a `403`. */
export function canEditMentions(role: SiteRole): boolean {
  return role === "owner" || role === "admin";
}

const fold = (value: string) => value.trim().toLowerCase();

/** One term's own length rule, or null when it passes. */
function lengthProblem(term: string): string | null {
  const trimmed = term.trim();
  if (trimmed.length < MIN_TERM_LENGTH) {
    return `A term needs at least ${MIN_TERM_LENGTH} characters.`;
  }
  if (trimmed.length > MAX_TERM_LENGTH) {
    return `A term can be at most ${MAX_TERM_LENGTH} characters.`;
  }
  return null;
}

/**
 * Why `candidate` can't join `existing`, or null when it can. The message is
 * shown under the field, so it says what to do as well as what is wrong.
 */
export function validateNewTerm(
  candidate: string,
  existing: readonly string[],
  domain: string
): string | null {
  if (existing.length >= MAX_TERMS) {
    return `You can add up to ${MAX_TERMS} terms. Remove one to add another.`;
  }
  const problem = lengthProblem(candidate);
  if (problem) return problem;
  if (fold(candidate) === fold(domain)) {
    return `${domain} is always searched, so it doesn't need to be a term.`;
  }
  if (existing.some((term) => fold(term) === fold(candidate))) {
    return "That term is already in the list.";
  }
  return null;
}

/** The whole list against the contract, or null when it would be accepted. */
export function validateTerms(terms: readonly string[]): string | null {
  if (terms.length > MAX_TERMS) {
    return `You can add up to ${MAX_TERMS} terms.`;
  }
  for (const term of terms) {
    const problem = lengthProblem(term);
    if (problem) return problem;
  }
  return null;
}

export type MentionCount = {
  key: "likes" | "reposts" | "replies" | "views";
  label: string;
  value: number;
};

const COUNT_LABELS: ReadonlyArray<[MentionCount["key"], string, string]> = [
  ["likes", "like", "likes"],
  ["reposts", "repost", "reposts"],
  ["replies", "reply", "replies"],
  ["views", "view", "views"],
];

/**
 * The counts a row shows, in a fixed order. A null count is one the search
 * service did not report: it is left out rather than drawn as a zero, because
 * zero is a claim about the post.
 */
export function mentionCounts(mention: Mention): MentionCount[] {
  const counts: MentionCount[] = [];
  for (const [key, one, many] of COUNT_LABELS) {
    const value = mention[key];
    if (value === null) continue;
    counts.push({ key, label: value === 1 ? one : many, value });
  }
  return counts;
}

/**
 * The term that found the post, when it is worth saying. A post found by the
 * domain says nothing new by naming it, so that case is null.
 */
export function matchedTermLabel(mention: Mention, domain: string): string | null {
  return fold(mention.matched_term) === fold(domain) ? null : mention.matched_term;
}

/** About the first 80 characters of a post, cut on a word boundary. */
export function mentionExcerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** 1200 → "1.2K": follower and view counts are read at a glance. */
export function formatCompact(value: number): string {
  return compact.format(value);
}

/** "AL" from "Ada Lovelace", "A" from "ada": the initials avatar. */
export function initialsOf(name: string, handle: string): string {
  const source = name.trim() || handle;
  const words = source.split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words[words.length - 1]?.[0] ?? ""}`
      : (words[0]?.[0] ?? "?");
  return letters.toUpperCase();
}
