/**
 * fxtwitter `/2/search` fixtures for the mentions suites.
 *
 * `fxStatus` is a real result as the search endpoint returned it (trimmed of
 * fields the parser never reads), so a parser change that only works on
 * hand-made shapes fails here first.
 */

export const fxStatus = {
  type: 'status',
  id: '2119776680621285605',
  url: 'https://x.com/hampfh/status/2119776680621285605',
  text: "I'm so sad to se https://conductor.build go away...",
  raw_text: {
    text: "I'm so sad to se https://t.co/hFNUFsM2Rk go away...",
    facets: [
      {
        type: 'url',
        original: 'https://t.co/hFNUFsM2Rk',
        replacement: 'https://conductor.build',
        display: 'conductor.build',
      },
    ],
  },
  author: {
    screen_name: 'hampfh',
    name: 'Hampus Hallkvist',
    url: 'https://x.com/hampfh',
    followers: 5,
    avatar_url: 'https://pbs.twimg.com/profile_images/1/avatar.jpg',
  },
  replies: 1,
  reposts: 0,
  likes: 1,
  quotes: 0,
  views: 23,
  created_timestamp: 1794229118,
  lang: 'en',
} as const

/** A status with a given id, otherwise identical to `fxStatus`. */
export function fxStatusWithId(id: string, overrides: Record<string, unknown> = {}) {
  return {
    ...fxStatus,
    id,
    url: `https://x.com/hampfh/status/${id}`,
    ...overrides,
  }
}

/** A whole `/2/search` response body. */
export function fxSearchBody(
  results: readonly unknown[],
  bottom: string | null = 'cursor-bottom-1',
): Record<string, unknown> {
  return {
    code: 200,
    results,
    cursor: { top: 'cursor-top-1', ...(bottom === null ? {} : { bottom }) },
  }
}
