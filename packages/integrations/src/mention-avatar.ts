import {
  MENTION_AVATAR_MAX_BYTES,
  isMentionAvatarUrl,
  sniffMentionAvatarType,
  type MentionAvatarContentType,
} from '@openanalytics/domain'

/**
 * The author-picture download client (X mentions, migration 0049).
 *
 * One unauthenticated GET to a URL the parser already held to
 * `https://pbs.twimg.com/...`. The check is made again here before anything is
 * requested, because this is the function that opens the socket: a URL from
 * anywhere else is refused unfetched. What it refuses to do:
 *
 * - **Follow a redirect.** `redirect: 'error'`, so a 3xx can never move the
 *   request to another host; a fetch that hands back the 3xx anyway is a
 *   non-2xx answer and refused as well.
 * - **Buffer much.** A declared length over 32 KB is refused unread, and an
 *   undeclared body is abandoned once it passes 32 KB.
 * - **Believe a header.** The type is read from the first bytes (JPEG, PNG or
 *   WebP); a `Content-Type: image/png` over HTML or SVG is refused, so nothing
 *   the API later serves can be a document.
 * - **Throw.** Every failure is a typed outcome: the poller shares a process
 *   with batch ingest and email delivery.
 */

export { MENTION_AVATAR_MAX_BYTES }

/** Bounded so a slow CDN edge cannot hold a poller tick for long. */
const FETCH_TIMEOUT_MS = 10_000

const USER_AGENT_CONTACT = '+https://github.com/OpenLabs-so/openanalytics'

export type MentionAvatarFetchResult =
  | {
      readonly ok: true
      /** From the bytes, never from the response header. */
      readonly contentType: MentionAvatarContentType
      readonly bytes: Uint8Array
    }
  | {
      readonly ok: false
      /**
       * `refused`: not an allowlisted URL, nothing was requested.
       * `unavailable`: network, timeout, stop, redirect or a non-2xx answer.
       * `too_large`: over 32 KB, declared or read.
       * `unsupported_type`: the bytes are not a JPEG, PNG or WebP.
       */
      readonly reason: 'refused' | 'unavailable' | 'too_large' | 'unsupported_type'
    }

export interface MentionAvatarFetchOptions {
  /** Aborts the download, alongside the client's own 10 s deadline. */
  readonly signal?: AbortSignal
}

export interface MentionAvatarClient {
  fetchAvatar(url: string, options?: MentionAvatarFetchOptions): Promise<MentionAvatarFetchResult>
}

export interface MentionAvatarClientConfig {
  /** Sent in the User-Agent, as the search client does. */
  readonly version?: string
}

/** The body, or null once it passes the cap. Read in chunks and abandoned there. */
async function readCapped(response: Response): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MENTION_AVATAR_MAX_BYTES) {
      void reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export function createMentionAvatarClient(
  config: MentionAvatarClientConfig = {},
  fetchImpl: typeof fetch = fetch,
): MentionAvatarClient {
  const userAgent = `OpenAnalytics-Mentions/${config.version ?? '0.0.0'} (${USER_AGENT_CONTACT})`

  return {
    async fetchAvatar(url, options) {
      if (!isMentionAvatarUrl(url)) return { ok: false, reason: 'refused' }
      if (options?.signal?.aborted === true) return { ok: false, reason: 'unavailable' }

      const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS)
      const signal =
        options?.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])

      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { 'user-agent': userAgent, accept: 'image/jpeg, image/png, image/webp' },
          redirect: 'error',
          signal,
        })
      } catch {
        return { ok: false, reason: 'unavailable' }
      }

      if (response.status < 200 || response.status > 299) {
        void response.body?.cancel().catch(() => {})
        return { ok: false, reason: 'unavailable' }
      }

      const declared = Number(response.headers.get('content-length') ?? '0')
      if (declared > MENTION_AVATAR_MAX_BYTES) {
        void response.body?.cancel().catch(() => {})
        return { ok: false, reason: 'too_large' }
      }

      let bytes: Uint8Array | null
      try {
        bytes = await readCapped(response)
      } catch {
        return { ok: false, reason: 'unavailable' }
      }
      if (bytes === null) return { ok: false, reason: 'too_large' }

      const contentType = sniffMentionAvatarType(bytes)
      if (contentType === null) return { ok: false, reason: 'unsupported_type' }
      return { ok: true, contentType, bytes }
    },
  }
}
