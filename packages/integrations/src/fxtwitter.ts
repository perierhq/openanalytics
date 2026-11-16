import { parseFxTwitterSearch, type ParsedPost } from '@openanalytics/domain'

/**
 * The fxtwitter search client (X mentions, migration 0048).
 *
 * One unauthenticated GET to `{baseUrl}/2/search`. `baseUrl` is the
 * operator's `MENTIONS_X_API_URL`, so an install can point at its own
 * fxtwitter deployment instead of the public one. What is sent is the query
 * string (a site's domain or one of its search terms) and nothing about any
 * visitor.
 *
 * Every failure is a typed outcome and the function never throws: the poller
 * shares a process with batch ingest and email delivery, and a third-party
 * search service having a bad day must not reach either. Failure details are
 * categorized strings, never an upstream body.
 */

/** Results asked for per page. */
export const FXTWITTER_SEARCH_COUNT = 20

/** Bounded so a hung socket cannot hold a poller tick forever. */
const FETCH_TIMEOUT_MS = 15_000

/** A search page is tens of kilobytes; anything past this is not one. */
const MAX_BODY_BYTES = 2_000_000

/**
 * The body as text, or null once it passes `MAX_BODY_BYTES`. Read in chunks
 * and abandoned at the cap, so a body with no declared length cannot make the
 * worker buffer an unbounded amount.
 */
async function readCapped(response: Response): Promise<string | null> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_BODY_BYTES) {
      void reader.cancel().catch(() => {})
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

const USER_AGENT_CONTACT = '+https://github.com/OpenLabs-so/openanalytics'

export interface FxTwitterClientConfig {
  readonly baseUrl: string
  /** Sent in the User-Agent so the service's operator can tell who is calling. */
  readonly version?: string
}

export interface FxTwitterSearchPage {
  readonly posts: ParsedPost[]
  /** Pass back as `cursor` for older posts; null when there are none. */
  readonly nextCursor: string | null
}

export type FxTwitterSearchResult =
  | { readonly ok: true; readonly data: FxTwitterSearchPage }
  | {
      readonly ok: false
      readonly reason: 'unavailable' | 'invalid_response'
      /** Safe, categorized detail — never a raw upstream body. */
      readonly detail: string
    }

export interface FxTwitterSearchOptions {
  /** Aborts the call, alongside the client's own 15 s deadline. The poller
   * passes one that `stop()` aborts, so shutdown does not wait on a socket. */
  readonly signal?: AbortSignal
}

export interface FxTwitterClient {
  search(
    query: string,
    cursor?: string,
    options?: FxTwitterSearchOptions,
  ): Promise<FxTwitterSearchResult>
}

export function createFxTwitterClient(
  config: FxTwitterClientConfig,
  fetchImpl: typeof fetch = fetch,
): FxTwitterClient {
  const base = config.baseUrl.replace(/\/+$/u, '')
  const userAgent = `OpenAnalytics-Mentions/${config.version ?? '0.0.0'} (${USER_AGENT_CONTACT})`

  return {
    async search(query, cursor, options) {
      const params = new URLSearchParams({ q: query, count: String(FXTWITTER_SEARCH_COUNT) })
      if (cursor !== undefined && cursor.length > 0) params.set('cursor', cursor)
      const url = `${base}/2/search?${params.toString()}`
      const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS)
      const signal =
        options?.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])

      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { 'user-agent': userAgent, accept: 'application/json' },
          signal,
        })
      } catch {
        // DNS, TLS, a reset socket, our own deadline or the caller's stop: the
        // remedy is the same, which is to try again on a later poll.
        return { ok: false, reason: 'unavailable', detail: 'search request did not complete' }
      }

      if (!response.ok) {
        return {
          ok: false,
          reason: 'unavailable',
          detail: `search responded ${String(response.status)}`,
        }
      }

      // Refused unread when the length is declared, and checked again after
      // reading because a length is not always declared.
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (declared > MAX_BODY_BYTES) {
        void response.body?.cancel().catch(() => {})
        return { ok: false, reason: 'invalid_response', detail: 'search body is too large' }
      }

      let text: string | null
      try {
        text = await readCapped(response)
      } catch {
        return { ok: false, reason: 'unavailable', detail: 'search body did not arrive' }
      }
      if (text === null) {
        return { ok: false, reason: 'invalid_response', detail: 'search body is too large' }
      }

      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        return { ok: false, reason: 'invalid_response', detail: 'search body is not JSON' }
      }

      const parsed = parseFxTwitterSearch(body)
      if (!parsed.ok) return { ok: false, reason: 'invalid_response', detail: parsed.detail }
      return { ok: true, data: { posts: parsed.posts, nextCursor: parsed.nextCursor } }
    },
  }
}
