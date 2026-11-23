import {
  META_ADS_USAGE_BACKOFF_PERCENT,
  META_GRAPH_API_VERSION,
  META_GRAPH_HOST,
  classifyMetaGraphError,
  metaUsage,
  parseMetaInsightsPage,
  type MetaAdsError,
  type MetaSpendRow,
  type MetaUsage,
} from '@openanalytics/domain'

/**
 * The Meta Graph client for ad spend (migration 0052).
 *
 * Two reads, both `GET` to `https://graph.facebook.com/{version}`:
 *
 * - `verifyAccount`: `/act_{id}?fields=name,currency,account_status`, the one
 *   cheap call the connect route makes before it stores a token;
 * - `fetchInsights`: `/act_{id}/insights?level=campaign&time_increment=1`,
 *   daily spend per campaign, following `paging.next` to the end.
 *
 * The rules this file exists to keep:
 *
 * - **The token is a header, never a URL.** `Authorization: Bearer`, on every
 *   page. Meta puts `access_token` into the `paging.next` links it returns, so
 *   that parameter is removed before a link is followed, and a link to any
 *   other host is refused (`parseMetaInsightsPage`). Nothing that could reach a
 *   log line ever holds the token.
 * - **Every failure is a category.** `unauthorized`, `rate_limited`,
 *   `unavailable` or `invalid_response`, with a detail built from the HTTP
 *   status and Meta's numeric error code only. Meta's error message is prose,
 *   can echo identifiers, and is never copied; neither is a thrown error's.
 * - **It backs off.** After each page the usage headers are read, and above
 *   75% of any budget it stops before asking for another page. What it read so
 *   far is returned beside the `rate_limited` outcome.
 * - **It never throws.** It runs in the worker beside batch ingest.
 */

/** Rows asked for per insights page. */
export const META_INSIGHTS_PAGE_LIMIT = 500

/** Bounded so a hung socket cannot hold a sync forever. */
const FETCH_TIMEOUT_MS = 20_000
/** An insights page of 500 rows is well under this. */
const MAX_BODY_BYTES = 4_000_000
/** Ninety days of a large account is a handful of pages; this is a runaway guard. */
const MAX_PAGES = 50
const INSIGHTS_FIELDS = 'campaign_id,campaign_name,spend,account_currency,date_start,date_stop'
const USER_AGENT_CONTACT = '+https://github.com/OpenLabs-so/openanalytics'

export interface MetaAdsClientConfig {
  /** Sent in the User-Agent. */
  readonly version?: string
}

export interface MetaAdsRequestOptions {
  /** Aborts the call alongside the client's own deadline. */
  readonly signal?: AbortSignal
}

export type MetaAccountResult =
  | {
      readonly ok: true
      readonly name: string
      readonly currency: string
      /** Meta's `account_status`: 1 is active; null when not reported. */
      readonly accountStatus: number | null
    }
  | { readonly ok: false; readonly reason: MetaAdsError; readonly detail: string }

export type MetaInsightsResult =
  | {
      readonly ok: true
      readonly rows: MetaSpendRow[]
      readonly skipped: number
      readonly pages: number
      /** The usage the last response reported. */
      readonly usage: MetaUsage
    }
  | {
      readonly ok: false
      readonly reason: MetaAdsError
      readonly detail: string
      /** Rows read before the failure or the backoff; whole campaign-days. */
      readonly rows: MetaSpendRow[]
      readonly usage: MetaUsage
    }

export interface MetaInsightsInput {
  readonly adAccountId: string
  readonly token: string
  /** Inclusive `YYYY-MM-DD` days. */
  readonly since: string
  readonly until: string
  /** The connection's currency, for a row that does not name one. */
  readonly fallbackCurrency: string
}

export interface MetaAdsClient {
  verifyAccount(
    adAccountId: string,
    token: string,
    options?: MetaAdsRequestOptions,
  ): Promise<MetaAccountResult>
  fetchInsights(
    input: MetaInsightsInput,
    options?: MetaAdsRequestOptions,
  ): Promise<MetaInsightsResult>
}

const NO_USAGE: MetaUsage = { percent: null, regainMinutes: 0 }

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

type Fetched =
  | { readonly ok: true; readonly body: unknown; readonly usage: MetaUsage }
  | {
      readonly ok: false
      readonly reason: MetaAdsError
      readonly detail: string
      readonly usage: MetaUsage
    }

/** Meta's numeric error code, for a detail string; never its message. */
function graphCode(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const error = (body as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return ''
  const code = (error as { code?: unknown }).code
  const subcode = (error as { error_subcode?: unknown }).error_subcode
  if (typeof code !== 'number' || !Number.isInteger(code)) return ''
  return typeof subcode === 'number' && Number.isInteger(subcode)
    ? ` (code ${String(code)}/${String(subcode)})`
    : ` (code ${String(code)})`
}

/** The link without any `access_token` Meta added to it. */
function withoutTokenParam(link: string): string {
  const url = new URL(link)
  url.searchParams.delete('access_token')
  return url.toString()
}

export function createMetaAdsClient(
  config: MetaAdsClientConfig = {},
  fetchImpl: typeof fetch = fetch,
): MetaAdsClient {
  const base = `https://${META_GRAPH_HOST}/${META_GRAPH_API_VERSION}`
  const userAgent = `OpenAnalytics-MetaAds/${config.version ?? '0.0.0'} (${USER_AGENT_CONTACT})`

  const get = async (
    url: string,
    token: string,
    what: string,
    options: MetaAdsRequestOptions | undefined,
  ): Promise<Fetched> => {
    const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const signal =
      options?.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'user-agent': userAgent,
        },
        signal,
      })
    } catch {
      // DNS, TLS, a reset socket or a deadline. The thrown error is not
      // repeated: some runtimes put the request URL in its message.
      return {
        ok: false,
        reason: 'unavailable',
        detail: `${what} request did not complete`,
        usage: NO_USAGE,
      }
    }

    const usage = metaUsage(response.headers)
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_BODY_BYTES) {
      void response.body?.cancel().catch(() => {})
      return { ok: false, reason: 'invalid_response', detail: `${what} body is too large`, usage }
    }
    let text: string | null
    try {
      text = await readCapped(response)
    } catch {
      return { ok: false, reason: 'unavailable', detail: `${what} body did not arrive`, usage }
    }
    if (text === null) {
      return { ok: false, reason: 'invalid_response', detail: `${what} body is too large`, usage }
    }
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      // Left as text: a 5xx page is HTML, and the status decides its category.
      if (response.ok) {
        return { ok: false, reason: 'invalid_response', detail: `${what} body is not JSON`, usage }
      }
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: classifyMetaGraphError(response.status, body),
        detail: `${what} responded ${String(response.status)}${graphCode(body)}`,
        usage,
      }
    }
    return { ok: true, body, usage }
  }

  return {
    async verifyAccount(adAccountId, token, options) {
      const url = `${base}/${encodeURIComponent(adAccountId)}?${new URLSearchParams({
        fields: 'name,currency,account_status',
      }).toString()}`
      const fetched = await get(url, token, 'account', options)
      if (!fetched.ok) return { ok: false, reason: fetched.reason, detail: fetched.detail }
      const body = fetched.body
      if (typeof body !== 'object' || body === null) {
        return { ok: false, reason: 'invalid_response', detail: 'account body is not an object' }
      }
      const record = body as Record<string, unknown>
      const currency = record['currency']
      if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/u.test(currency)) {
        return { ok: false, reason: 'invalid_response', detail: 'account has no currency' }
      }
      const name = typeof record['name'] === 'string' ? record['name'].trim().slice(0, 200) : ''
      const status = record['account_status']
      return {
        ok: true,
        name,
        currency: currency.toUpperCase(),
        accountStatus: typeof status === 'number' && Number.isInteger(status) ? status : null,
      }
    },

    async fetchInsights(input, options) {
      const params = new URLSearchParams({
        level: 'campaign',
        time_increment: '1',
        fields: INSIGHTS_FIELDS,
        time_range: JSON.stringify({ since: input.since, until: input.until }),
        limit: String(META_INSIGHTS_PAGE_LIMIT),
      })
      let url: string | null =
        `${base}/${encodeURIComponent(input.adAccountId)}/insights?${params.toString()}`
      const rows: MetaSpendRow[] = []
      let skipped = 0
      let pages = 0
      let usage: MetaUsage = NO_USAGE

      while (url !== null) {
        if (pages >= MAX_PAGES) {
          return {
            ok: false,
            reason: 'invalid_response',
            detail: `insights ran past ${String(MAX_PAGES)} pages`,
            rows,
            usage,
          }
        }
        const fetched = await get(url, input.token, 'insights', options)
        usage = fetched.usage
        if (!fetched.ok) {
          return { ok: false, reason: fetched.reason, detail: fetched.detail, rows, usage }
        }
        pages += 1
        const parsed = parseMetaInsightsPage(fetched.body, {
          fallbackCurrency: input.fallbackCurrency,
        })
        if (!parsed.ok) {
          return { ok: false, reason: 'invalid_response', detail: parsed.detail, rows, usage }
        }
        rows.push(...parsed.rows)
        skipped += parsed.skipped
        url = parsed.next === null ? null : withoutTokenParam(parsed.next)

        if (
          url !== null &&
          usage.percent !== null &&
          usage.percent > META_ADS_USAGE_BACKOFF_PERCENT
        ) {
          return {
            ok: false,
            reason: 'rate_limited',
            detail: `usage at ${String(Math.round(usage.percent))}% after ${String(pages)} pages`,
            rows,
            usage,
          }
        }
      }
      return { ok: true, rows, skipped, pages, usage }
    },
  }
}
