/**
 * Where a mention author's picture is loaded from, decided in one place.
 *
 * The contract's `author.avatar_url` is a path on our own API
 * (`/v1/sites/{site_id}/mentions/avatars/x/{handle}`): the worker downloads
 * the picture once and the API serves it, so a dashboard viewer's browser
 * never asks X for anything. The path goes on the API origin the same way
 * every request in `lib/api.ts` is built (`API_BASE_URL` + path).
 *
 * Anything else is refused, so a bad value can only cost the picture (the
 * initials stay), never a request to X: an absolute address must already be
 * on the API origin, protocol-relative addresses are refused, and image data
 * is accepted only where mock mode asks for it.
 */

export type MentionAvatarSrcOptions = {
  /** `API_BASE_URL`; empty makes the path relative, like every other call. */
  apiBase: string;
  /** Mock mode's placeholder pictures are `data:image/…` addresses. */
  allowDataUrls?: boolean;
};

const DATA_IMAGE = /^data:image\/(?:svg\+xml|png|jpeg|webp)[;,]/i;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The only relative shape the API emits. Matching it exactly, rather than
 * "starts with one slash", also refuses paths a browser would resolve to
 * another host, such as `/\\host` or a slash, a tab and a slash.
 */
const API_AVATAR_PATH = /^\/v1\/sites\/[A-Za-z0-9_-]+\/mentions\/avatars\/x\/[A-Za-z0-9_]{1,15}$/;

export function mentionAvatarSrc(
  avatarUrl: string | null | undefined,
  { apiBase, allowDataUrls = false }: MentionAvatarSrcOptions
): string | null {
  if (!avatarUrl) return null;

  if (API_AVATAR_PATH.test(avatarUrl)) {
    return `${apiBase.replace(/\/+$/, "")}${avatarUrl}`;
  }

  if (allowDataUrls && DATA_IMAGE.test(avatarUrl)) return avatarUrl;

  if (/^https?:\/\//i.test(avatarUrl)) {
    const api = apiBase ? originOf(apiBase) : null;
    return api !== null && originOf(avatarUrl) === api ? avatarUrl : null;
  }

  return null;
}
