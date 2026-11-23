import { localDay } from './zoned-calendar.ts'
import {
  convertMinorAmount,
  minorUnitExponent,
  planCurrencyConversion,
  shiftUtcDate,
  type RateAtDate,
} from './money-conversion.ts'

/**
 * Meta Ads spend and ROAS (migration 0052): the pure half.
 *
 * An owner connects a Meta ad account with a System User token that has
 * `ads_read`. The worker reads the account's daily spend per campaign from the
 * Marketing API's insights edge, and the API joins each campaign to the
 * last-touch revenue whose `utm_campaign` names it. Everything here is pure, so
 * the parser, the rate-limit reading, the error categories, the sync windows
 * and the join are tested without a network or a database.
 *
 * Facts this module encodes, checked against Meta's own documentation:
 *
 * - The Graph API version is pinned (`META_GRAPH_API_VERSION`): v27.0 was
 *   introduced on 4 November 2026 and is the latest listed at
 *   https://developers.facebook.com/docs/graph-api/changelog.
 * - Insights rows carry `spend` as a decimal string ("5339.5") in the ad
 *   account's currency, and `date_start`/`date_stop` as `YYYY-MM-DD`
 *   (https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/insights).
 * - A list is over when `paging.next` is absent; an empty page can still carry
 *   one (https://developers.facebook.com/docs/graph-api/results).
 * - Usage comes back in `x-app-usage` and `x-business-use-case-usage` as
 *   percentages, the second with `estimated_time_to_regain_access` in minutes
 *   (https://developers.facebook.com/docs/graph-api/overview/rate-limiting).
 */

/** The Graph API version every request names. */
export const META_GRAPH_API_VERSION = 'v27.0'
/** The one host the worker and the API send the token to. */
export const META_GRAPH_HOST = 'graph.facebook.com'

/** How long a site waits between two syncs. */
export const META_ADS_SYNC_INTERVAL_HOURS = 6
/** A routine sync re-reads this many days, today included: Meta restates spend. */
export const META_ADS_RESYNC_DAYS = 3
/** The first sync of a connection reads this many days, today included. */
export const META_ADS_FIRST_SYNC_DAYS = 90
/** Above this share of any rate-limit budget the worker stops calling. */
export const META_ADS_USAGE_BACKOFF_PERCENT = 75

/**
 * Why a sync failed, as stored in `last_error` and shown on the settings card.
 *
 * `credential_undecryptable` is ours, not Meta's: this install's keyring cannot
 * read the stored token (a key was removed from `OA_CREDENTIAL_KEYRING`, or the
 * row was tampered with). Meta is never called for it, and polling does not
 * stop: restoring the key and restarting the worker is enough.
 */
export const META_ADS_ERRORS = [
  'unauthorized',
  'credential_undecryptable',
  'rate_limited',
  'unavailable',
  'invalid_response',
] as const
export type MetaAdsError = (typeof META_ADS_ERRORS)[number]

/**
 * `active` is synced on schedule. `needs_reconnect` is a connection whose token
 * Meta refused: polling stops until the owner connects again, because every
 * further call would be refused the same way.
 */
export const META_ADS_STATUSES = ['active', 'needs_reconnect'] as const
export type MetaAdsStatus = (typeof META_ADS_STATUSES)[number]

const AD_ACCOUNT_DIGITS = /^[0-9]{1,20}$/u

/**
 * An ad account id as `act_` plus digits, or null.
 *
 * Bare digits are accepted too, because Ads Manager shows the account id
 * without the prefix and people paste what they see.
 */
export function normalizeMetaAdAccountId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  const digits = trimmed.startsWith('act_') ? trimmed.slice(4) : trimmed
  return AD_ACCOUNT_DIGITS.test(digits) ? `act_${digits}` : null
}

const TOKEN_MIN_LENGTH = 20
const TOKEN_MAX_LENGTH = 1024
const TOKEN_SHAPE = /^[A-Za-z0-9_.|-]+$/u

/**
 * An access token, trimmed, or null when it cannot be one.
 *
 * Only the shape is checked here: whether Meta accepts it is the connect
 * probe's question. The bound keeps a pasted paragraph out of the vault.
 */
export function normalizeMetaAccessToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length < TOKEN_MIN_LENGTH || trimmed.length > TOKEN_MAX_LENGTH) return null
  return TOKEN_SHAPE.test(trimmed) ? trimmed : null
}

/**
 * The additional authenticated data the token's ciphertext is bound to: the
 * site and the ad account. A ciphertext copied onto another site's row, or
 * left behind after the account changed, does not decrypt.
 */
export function metaAdsCredentialAad(input: {
  readonly siteId: string
  readonly adAccountId: string
}): string {
  return `meta_ads_connection:${input.siteId}:${input.adAccountId}`
}

const DECIMAL = /^([0-9]+)(?:\.([0-9]+))?$/u

/**
 * Meta's decimal spend string as integer minor units of `currency`.
 *
 * Exact: the digits are shifted, never multiplied as a float. A third decimal
 * (which Meta does not normally send) is rounded half to even, the rounding
 * the currency conversion uses. The exponent is `minorUnitExponent`'s, so the
 * conversion that reads these amounts later agrees with how they were written.
 * A number is accepted as a fallback for a provider that ever sends one.
 */
export function parseMetaSpendMinor(raw: unknown, currency: string): number | null {
  let text: string
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null
    text = String(raw)
    if (!DECIMAL.test(text)) return null
  } else if (typeof raw === 'string') {
    text = raw.trim()
  } else {
    return null
  }
  const match = DECIMAL.exec(text)
  if (!match) return null
  const whole = match[1] as string
  const fraction = match[2] ?? ''
  const exponent = minorUnitExponent(currency)

  const kept = fraction.slice(0, exponent).padEnd(exponent, '0')
  let minor = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(kept === '' ? '0' : kept)
  const rest = fraction.slice(exponent)
  if (rest.length > 0 && /[1-9]/u.test(rest)) {
    const first = Number(rest[0])
    const tail = rest.slice(1)
    const aboveHalf = first > 5 || (first === 5 && /[1-9]/u.test(tail))
    const exactlyHalf = first === 5 && !/[1-9]/u.test(tail)
    if (aboveHalf || (exactlyHalf && minor % 2n === 1n)) minor += 1n
  }
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(minor)
}

/** One campaign's spend on one day, as the worker stores it. */
export interface MetaSpendRow {
  readonly campaignId: string
  /** Empty when Meta sent no name; the dashboard then shows the id. */
  readonly campaignName: string
  /** `YYYY-MM-DD`, a day in the ad account's own timezone. */
  readonly day: string
  readonly spendMinor: number
  readonly currency: string
}

export type MetaInsightsParse =
  | {
      readonly ok: true
      readonly rows: MetaSpendRow[]
      /** The next page's URL, or null on the last page. */
      readonly next: string | null
      /** Rows that could not be placed (no campaign, no day, no spend). */
      readonly skipped: number
    }
  | { readonly ok: false; readonly detail: string }

const CAMPAIGN_ID = /^[0-9]{1,32}$/u
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u
const CURRENCY = /^[A-Za-z]{3}$/u
const CAMPAIGN_NAME_MAX_LENGTH = 400

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A `paging.next` URL the client may follow, or null.
 *
 * Only `https://graph.facebook.com` on its default port, with no userinfo, and
 * under the pinned version (`/v27.0/...`): the client sends the token in a
 * header on every page, so a next link pointing anywhere else would be a link
 * that receives the token, and one on another version would read a different
 * API than the one this parser was written against.
 */
function graphNextUrl(raw: unknown): string | null | 'invalid' {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return 'invalid'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'invalid'
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== META_GRAPH_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !url.pathname.startsWith(`/${META_GRAPH_API_VERSION}/`)
  ) {
    return 'invalid'
  }
  return raw
}

/**
 * One page of `GET /act_{id}/insights?level=campaign&time_increment=1`.
 *
 * Strict about the document and tolerant about rows: a body without a `data`
 * array is a failure the worker records as `invalid_response`, never an empty
 * page that would read as "nothing was spent". A row without a campaign id, a
 * day or a usable spend is skipped and counted; a row without a name keeps an
 * empty one; a row without `account_currency` takes the connection's.
 */
export function parseMetaInsightsPage(
  body: unknown,
  options: { readonly fallbackCurrency: string },
): MetaInsightsParse {
  if (!isRecord(body)) return { ok: false, detail: 'insights body is not an object' }
  const data = body['data']
  if (!Array.isArray(data)) return { ok: false, detail: 'insights body has no data array' }

  let next: string | null = null
  const paging = body['paging']
  if (isRecord(paging)) {
    const parsed = graphNextUrl(paging['next'])
    if (parsed === 'invalid') return { ok: false, detail: 'insights next link is not a Graph URL' }
    next = parsed
  }

  const rows: MetaSpendRow[] = []
  let skipped = 0
  for (const item of data) {
    if (!isRecord(item)) {
      skipped += 1
      continue
    }
    const campaignId = item['campaign_id']
    const day = item['date_start']
    if (typeof campaignId !== 'string' || !CAMPAIGN_ID.test(campaignId)) {
      skipped += 1
      continue
    }
    if (typeof day !== 'string' || !DAY.test(day)) {
      skipped += 1
      continue
    }
    const rawCurrency = item['account_currency']
    const currency = (
      typeof rawCurrency === 'string' && CURRENCY.test(rawCurrency)
        ? rawCurrency
        : options.fallbackCurrency
    ).toUpperCase()
    const spendMinor = parseMetaSpendMinor(item['spend'], currency)
    if (spendMinor === null) {
      skipped += 1
      continue
    }
    const rawName = item['campaign_name']
    const campaignName =
      typeof rawName === 'string' ? rawName.trim().slice(0, CAMPAIGN_NAME_MAX_LENGTH) : ''
    rows.push({ campaignId, campaignName, day, spendMinor, currency })
  }
  return { ok: true, rows, next, skipped }
}

/** A header reader: `Headers` satisfies it, and so does a test's plain object. */
export interface HeaderReader {
  get(name: string): string | null
}

export interface MetaUsage {
  /** The highest percentage of any budget used, or null when Meta sent none. */
  readonly percent: number | null
  /** Meta's own estimate of when access returns, in minutes; 0 when none. */
  readonly regainMinutes: number
}

const USAGE_FIELDS = ['call_count', 'total_cputime', 'total_time'] as const

function parseJsonHeader(headers: HeaderReader, name: string): unknown {
  const raw = headers.get(name)
  if (raw === null || raw.length === 0 || raw.length > 16_384) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * How close this app, this business and this ad account are to Meta's rate
 * limits, read from `x-app-usage` (`{call_count, total_cputime, total_time}`),
 * `x-business-use-case-usage` (`{business_id: [{type, call_count, …,
 * estimated_time_to_regain_access}]}`, minutes) and `x-ad-account-usage`
 * (`{acc_id_util_pct, reset_time_duration}`, the reset in seconds). Malformed
 * headers count as absent.
 */
export function metaUsage(headers: HeaderReader): MetaUsage {
  let percent: number | null = null
  let regainMinutes = 0
  const take = (entry: unknown) => {
    if (!isRecord(entry)) return
    for (const field of USAGE_FIELDS) {
      const value = finiteNumber(entry[field])
      if (value !== null) percent = Math.max(percent ?? 0, value)
    }
    const regain = finiteNumber(entry['estimated_time_to_regain_access'])
    if (regain !== null) regainMinutes = Math.max(regainMinutes, regain)
  }

  take(parseJsonHeader(headers, 'x-app-usage'))
  const account = parseJsonHeader(headers, 'x-ad-account-usage')
  if (isRecord(account)) {
    const used = finiteNumber(account['acc_id_util_pct'])
    if (used !== null) percent = Math.max(percent ?? 0, used)
    const resetSeconds = finiteNumber(account['reset_time_duration'])
    if (resetSeconds !== null) regainMinutes = Math.max(regainMinutes, Math.ceil(resetSeconds / 60))
  }
  const business = parseJsonHeader(headers, 'x-business-use-case-usage')
  if (isRecord(business)) {
    for (const entries of Object.values(business)) {
      if (Array.isArray(entries)) for (const entry of entries) take(entry)
    }
  }
  return { percent, regainMinutes }
}

/** Graph error codes that mean "the token cannot do this" (error handling guide). */
function isAuthCode(code: number, subcode: number | null): boolean {
  if (code === 190 || code === 102 || code === 10) return true
  if (code >= 200 && code <= 299) return true
  // "Object does not exist, cannot be loaded due to missing permissions": the
  // token cannot see this ad account.
  return code === 100 && subcode === 33
}

/** Throttling codes: platform (4, 17, 32, 341, 613) and business use case (80000–80014). */
function isThrottleCode(code: number): boolean {
  return (
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 341 ||
    code === 613 ||
    (code >= 80000 && code <= 80014)
  )
}

/**
 * The category a failed Graph response falls in. Read from the error body's
 * `code` and `error_subcode` first, the HTTP status second, and never from the
 * message, which is prose and may carry identifiers.
 */
export function classifyMetaGraphError(status: number, body: unknown): MetaAdsError {
  const error = isRecord(body) && isRecord(body['error']) ? body['error'] : null
  const code = error === null ? null : finiteNumber(error['code'])
  const subcode = error === null ? null : finiteNumber(error['error_subcode'])
  if (code !== null) {
    if (isAuthCode(code, subcode)) return 'unauthorized'
    if (isThrottleCode(code)) return 'rate_limited'
    if (code === 1 || code === 2) return 'unavailable'
  }
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'unavailable'
  return 'invalid_response'
}

/** Days per insights read of a first sync's backfill. */
export const META_ADS_BACKFILL_CHUNK_DAYS = 30

/**
 * The next chunk of a connection's first-sync backfill, or null when it is
 * done. Inclusive `YYYY-MM-DD` days.
 *
 * A first sync reads the recent window first (`metaSyncWindow`), then the
 * ninety days before it, oldest first, in chunks of thirty. `cursor` is the
 * last day a chunk stored (`backfill_cursor`), moved in the same transaction
 * as the chunk's spend, so an attempt cut short by a rate limit resumes after
 * the last whole chunk instead of starting the ninety days over. Reading
 * oldest first is what keeps a resumed backfill gapless: it always runs up to
 * the day before today's recent window, wherever that has moved since.
 */
export function metaBackfillChunk(input: {
  readonly today: string
  readonly cursor: string | null
}): { readonly since: string; readonly until: string } | null {
  const floor = shiftUtcDate(input.today, -(META_ADS_FIRST_SYNC_DAYS - 1))
  const end = shiftUtcDate(input.today, -META_ADS_RESYNC_DAYS)
  const next = input.cursor === null ? floor : shiftUtcDate(input.cursor, 1)
  const since = next < floor ? floor : next
  if (since > end) return null
  const last = shiftUtcDate(since, META_ADS_BACKFILL_CHUNK_DAYS - 1)
  return { since, until: last > end ? end : last }
}

/**
 * The days a sync reads, inclusive at both ends: the last three on a routine
 * sync (Meta restates recent spend), ninety on a connection's first.
 *
 * `today` is the worker's UTC date. An ad account's own timezone can be a day
 * either side of it, and the three-day overlap is what covers that.
 */
export function metaSyncWindow(input: { readonly today: string; readonly firstSync: boolean }): {
  readonly since: string
  readonly until: string
} {
  const days = input.firstSync ? META_ADS_FIRST_SYNC_DAYS : META_ADS_RESYNC_DAYS
  return { since: shiftUtcDate(input.today, -(days - 1)), until: input.today }
}

/**
 * The spend days a half-open instant range covers, read in the dashboard's
 * timezone: the day `from` falls on through the day just before `to`.
 *
 * A spend day is a day in the ad account's timezone, which the API cannot see
 * per row; reading it in the timezone the reader picked is the closest honest
 * match, and an account set to the same zone as the site matches exactly.
 */
export function spendDayRange(input: {
  readonly from: string
  readonly to: string
  readonly timezone: string
}): { readonly fromDay: string; readonly toDay: string } {
  const fromDay = localDay(new Date(input.from), input.timezone)
  const toDay = localDay(new Date(Date.parse(input.to) - 1), input.timezone)
  return { fromDay, toDay: toDay < fromDay ? fromDay : toDay }
}

/** `utm_campaign` and campaign names are compared trimmed and case-folded. */
export function normalizeUtmCampaign(value: string): string {
  return value.trim().toLowerCase()
}

/** One campaign's spend over a range, in its own currency and converted. */
export interface CampaignSpend {
  readonly campaignId: string
  readonly campaignName: string
  readonly spendMinor: number
  readonly currency: string
  /** In the reporting currency; null when any day had no exchange rate. */
  readonly convertedMinor: number | null
}

/**
 * Sum each campaign's days and convert every day at that day's ECB rate.
 *
 * `rateFor(currency, day)` answers the usable rate for a day (the caller
 * applies the lookback) or null. One unconvertible day leaves the campaign's
 * converted spend null rather than smaller: a partial sum would make the ROAS
 * look better than it is.
 */
export function convertCampaignSpend(
  rows: readonly MetaSpendRow[],
  reportingCurrency: string,
  rateFor: (currency: string, day: string) => RateAtDate | null,
): CampaignSpend[] {
  const to = reportingCurrency.trim().toUpperCase()
  const byCampaign = new Map<
    string,
    {
      campaignId: string
      campaignName: string
      nameDay: string
      spendMinor: number
      currency: string
      convertedMinor: number | null
    }
  >()
  for (const row of rows) {
    const from = row.currency.toUpperCase()
    const plan = planCurrencyConversion({
      fromCurrency: from,
      toCurrency: to,
      fromRate: from === to ? null : rateFor(from, row.day),
      toRate: from === to ? null : rateFor(to, row.day),
    })
    const converted = convertMinorAmount({
      amountMinor: row.spendMinor,
      fromCurrency: from,
      toCurrency: to,
      conversion: plan,
    })
    const entry = byCampaign.get(row.campaignId)
    if (entry === undefined) {
      byCampaign.set(row.campaignId, {
        campaignId: row.campaignId,
        campaignName: row.campaignName,
        nameDay: row.day,
        spendMinor: row.spendMinor,
        currency: from,
        convertedMinor: converted,
      })
      continue
    }
    entry.spendMinor += row.spendMinor
    entry.convertedMinor =
      entry.convertedMinor === null || converted === null ? null : entry.convertedMinor + converted
    if (row.campaignName !== '' && (entry.campaignName === '' || row.day >= entry.nameDay)) {
      entry.campaignName = row.campaignName
      entry.nameDay = row.day
    }
  }
  return [...byCampaign.values()].map(({ nameDay: _nameDay, ...campaign }) => campaign)
}

/** Last-touch revenue for one `utm_campaign` value (`/revenue/attribution`). */
export interface UtmCampaignRevenue {
  /** Null is the unattributed row; it never matches a campaign. */
  readonly value: string | null
  readonly revenueMinor: number
  readonly orders: number
}

export type CampaignMatch = 'id' | 'name' | 'id_and_name'
export type RoasUnavailable = 'no_spend' | 'no_rate'

export interface CampaignResult extends CampaignSpend {
  readonly revenueMinor: number
  readonly orders: number
  readonly matchedBy: CampaignMatch | null
  /** Revenue over converted spend; null with a reason when it cannot be had. */
  readonly roas: number | null
  readonly roasUnavailable: RoasUnavailable | null
}

export interface CampaignJoin {
  readonly campaigns: CampaignResult[]
  readonly totals: {
    readonly spendMinor: number
    readonly spendConvertedMinor: number | null
    readonly revenueMinor: number
    readonly orders: number
    readonly roas: number | null
    readonly roasUnavailable: RoasUnavailable | null
  }
  /** Campaigns that spent and matched no `utm_campaign` value. */
  readonly unmatched: {
    readonly campaigns: number
    readonly spendMinor: number
    readonly spendConvertedMinor: number | null
  }
}

function roasOf(
  revenueMinor: number,
  spendConvertedMinor: number | null,
  spendMinor: number,
): { roas: number | null; roasUnavailable: RoasUnavailable | null } {
  if (spendMinor <= 0) return { roas: null, roasUnavailable: 'no_spend' }
  if (spendConvertedMinor === null) return { roas: null, roasUnavailable: 'no_rate' }
  if (spendConvertedMinor <= 0) return { roas: null, roasUnavailable: 'no_spend' }
  return { roas: revenueMinor / spendConvertedMinor, roasUnavailable: null }
}

/**
 * Join campaigns to last-touch revenue by `utm_campaign`.
 *
 * A value matches a campaign when, trimmed and case-folded, it equals the
 * campaign's **id** (people tag `utm_campaign={{campaign.id}}`) or its
 * **name**. Each value is counted once: an id match wins, and a name shared by
 * several campaigns goes to the one that spent the most in the range (the
 * lower id on a tie), so revenue is never counted twice. The unattributed row
 * and the empty value match nothing.
 *
 * Revenue is in the reporting currency and so is converted spend, so ROAS is a
 * plain ratio of the two minor-unit amounts.
 */
export function joinCampaignRevenue(
  campaigns: readonly CampaignSpend[],
  revenue: readonly UtmCampaignRevenue[],
): CampaignJoin {
  const byId = new Map<string, CampaignSpend>()
  const byName = new Map<string, CampaignSpend>()
  for (const campaign of campaigns) {
    byId.set(normalizeUtmCampaign(campaign.campaignId), campaign)
    const name = normalizeUtmCampaign(campaign.campaignName)
    if (name === '') continue
    const holder = byName.get(name)
    if (
      holder === undefined ||
      campaign.spendMinor > holder.spendMinor ||
      (campaign.spendMinor === holder.spendMinor && campaign.campaignId < holder.campaignId)
    ) {
      byName.set(name, campaign)
    }
  }

  const matched = new Map<
    string,
    { revenueMinor: number; orders: number; id: boolean; name: boolean }
  >()
  for (const row of revenue) {
    if (row.value === null) continue
    const value = normalizeUtmCampaign(row.value)
    if (value === '') continue
    const viaId = byId.get(value)
    const campaign = viaId ?? byName.get(value)
    if (campaign === undefined) continue
    const entry = matched.get(campaign.campaignId) ?? {
      revenueMinor: 0,
      orders: 0,
      id: false,
      name: false,
    }
    entry.revenueMinor += row.revenueMinor
    entry.orders += row.orders
    if (viaId !== undefined) entry.id = true
    else entry.name = true
    matched.set(campaign.campaignId, entry)
  }

  const results: CampaignResult[] = campaigns.map((campaign) => {
    const hit = matched.get(campaign.campaignId)
    const revenueMinor = hit?.revenueMinor ?? 0
    const matchedBy: CampaignMatch | null =
      hit === undefined ? null : hit.id && hit.name ? 'id_and_name' : hit.id ? 'id' : 'name'
    return {
      ...campaign,
      revenueMinor,
      orders: hit?.orders ?? 0,
      matchedBy,
      ...roasOf(revenueMinor, campaign.convertedMinor, campaign.spendMinor),
    }
  })

  let spendMinor = 0
  let spendConvertedMinor: number | null = 0
  let revenueMinor = 0
  let orders = 0
  let unmatchedCampaigns = 0
  let unmatchedSpend = 0
  let unmatchedConverted: number | null = 0
  for (const result of results) {
    spendMinor += result.spendMinor
    if (result.spendMinor > 0) {
      spendConvertedMinor =
        spendConvertedMinor === null || result.convertedMinor === null
          ? null
          : spendConvertedMinor + result.convertedMinor
    }
    revenueMinor += result.revenueMinor
    orders += result.orders
    if (result.matchedBy === null && result.spendMinor > 0) {
      unmatchedCampaigns += 1
      unmatchedSpend += result.spendMinor
      unmatchedConverted =
        unmatchedConverted === null || result.convertedMinor === null
          ? null
          : unmatchedConverted + result.convertedMinor
    }
  }

  return {
    campaigns: results,
    totals: {
      spendMinor,
      spendConvertedMinor,
      revenueMinor,
      orders,
      ...roasOf(revenueMinor, spendConvertedMinor, spendMinor),
    },
    unmatched: {
      campaigns: unmatchedCampaigns,
      spendMinor: unmatchedSpend,
      spendConvertedMinor: unmatchedConverted,
    },
  }
}
