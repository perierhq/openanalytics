import { ApiError } from '@openanalytics/contracts'
import {
  CURRENCY_RATE_LOOKBACK_DAYS,
  convertCampaignSpend,
  isRateWithinLookback,
  joinCampaignRevenue,
  metaAdsCredentialAad,
  normalizeMetaAccessToken,
  normalizeMetaAdAccountId,
  shiftUtcDate,
  spendDayRange,
  type CampaignResult,
  type RateAtDate,
} from '@openanalytics/domain'
import {
  credentialLast4,
  type CredentialVault,
  type MetaAdsClient,
} from '@openanalytics/integrations'
import {
  deleteMetaAdsConnection,
  getSiteBasics,
  listCurrencyRatesBetween,
  listMetaAdsSpend,
  readMetaAdsConnection,
  saveMetaAdsConnection,
  writeAudit,
  type CurrencyRateRow,
  type Database,
  type MetaAdsConnectionRecord,
} from '@openanalytics/postgres'
import { Hono, type Handler } from 'hono'
import type { AnalyticsService } from '../analytics/service.ts'
import { parseRange } from './analytics.ts'
import {
  requireAnalyticsAccess,
  requireCapability,
  siteMembership,
  type ApiVariables,
} from './middleware.ts'

/**
 * Meta Ads (migration 0052): the ad account connection and the campaigns read.
 *
 * **Owner-only on both.** The capability is `revenue:read`, the owner-only one
 * every revenue read uses: return on ad spend is a statement about money, and
 * the connection decides whose ad account's spend sits beside it. An admin and
 * a viewer get 403, and Meta is never called on their behalf.
 *
 * **The connection is session-only.** It has no `GRANT_WRITE_ALLOWLIST` row, so
 * an OAuth grant gets 403 on every verb: what token this install holds for an
 * ad account is not something an MCP client may read or change. The campaigns
 * read has a row (`revenue:read`), which the `ads_campaigns` tool reaches.
 *
 * **The token goes in and never comes out.** It is checked with one read of the
 * ad account before anything is stored, encrypted with the credential keyring
 * bound to the site and the ad account, and rendered back only as its last four
 * characters. A validation error names the field, never its value; a refusal
 * from Meta is a category; logs and audit rows carry neither the token nor the
 * ad account id.
 *
 * Like the revenue connection, `GET` and `DELETE` mount with or without a
 * keyring (neither decrypts anything) and are not behind the analytics gate,
 * so a suspended site can still cut the link; `PUT` mounts only with a keyring.
 * The campaigns read mounts only with a query gateway, because the revenue half
 * of it is a gateway read.
 *
 * **Two paths, one handler.** The routes live under `/marketing/`. They were
 * first mounted under `/ads/`, which browser ad and content blockers drop
 * before the request is sent, so the dashboard card failed for most visitors.
 * The `/ads/` paths stay, deprecated, for server-side clients; each is the same
 * handler and the same middleware, never a copy.
 */

type Env = { Variables: ApiVariables }

/** The connection's paths: the current one first, then the deprecated one. */
const CONNECTION_PATHS = [
  '/sites/:site_id/marketing/meta/connection',
  '/sites/:site_id/ads/meta/connection',
] as const

/** The campaigns read's paths: the current one first, then the deprecated one. */
const CAMPAIGNS_PATHS = [
  '/sites/:site_id/marketing/campaigns',
  '/sites/:site_id/ads/campaigns',
] as const

/**
 * `utm_campaign` rows read per request: the gateway's own ceiling. The
 * unattributed row sorts first and takes one place, so revenue is read for
 * the 499 values with the most revenue in the range; a campaign whose value
 * ranks below them shows no revenue. The OpenAPI description and the MCP
 * tool say so.
 */
const UTM_CAMPAIGN_ROWS = 500

/** Meta's `account_status` for an active ad account. */
const META_ACCOUNT_ACTIVE = 1

/** Whether Meta reported the account active; null when it did not say. */
function accountActive(status: number | null): boolean | null {
  return status === null ? null : status === META_ACCOUNT_ACTIVE
}

export interface AdsRoutesDeps {
  readonly db: Database
  /** Present only with a query gateway; the campaigns read mounts with it. */
  readonly analytics?: AnalyticsService
  /** Present only with a usable keyring; `PUT` mounts with it. */
  readonly write?: {
    readonly vault: CredentialVault
    readonly client: MetaAdsClient
  }
}

/** The wire shape of a connection. Names every field it returns; never the token. */
function connectionJson(row: MetaAdsConnectionRecord) {
  return {
    status: row.status,
    ad_account_id: row.adAccountId,
    ad_account_name: row.adAccountName,
    ad_account_active: accountActive(row.accountStatus),
    currency: row.currency,
    token_last4: row.tokenLast4,
    connected_at: row.connectedAt.toISOString(),
    last_attempted_at: row.lastAttemptedAt?.toISOString() ?? null,
    last_synced_at: row.lastSyncedAt?.toISOString() ?? null,
    next_sync_at: row.nextSyncAt.toISOString(),
    last_error: row.lastError,
  }
}

async function readBody(c: {
  req: { json: () => Promise<unknown> }
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('shape')
    return body as Record<string, unknown>
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'A JSON request body is required')
  }
}

/**
 * The usable rate for a currency on a day: the newest at or before it, within
 * the lookback the revenue conversion uses. `rows` is ascending by date.
 */
function rateLookup(rows: readonly CurrencyRateRow[]) {
  const byCurrency = new Map<string, CurrencyRateRow[]>()
  for (const row of rows) {
    const list = byCurrency.get(row.currency) ?? []
    list.push(row)
    byCurrency.set(row.currency, list)
  }
  return (currency: string, day: string): RateAtDate | null => {
    const list = byCurrency.get(currency.toUpperCase()) ?? []
    let found: CurrencyRateRow | null = null
    for (const row of list) {
      if (row.rateDate > day) break
      found = row
    }
    if (found === null || !isRateWithinLookback(found.rateDate, day)) return null
    return { ratePerEur: found.ratePerEur, rateDate: found.rateDate }
  }
}

function campaignJson(row: CampaignResult) {
  return {
    id: row.campaignId,
    name: row.campaignName,
    spend: { amount_minor: row.spendMinor, currency: row.currency },
    spend_converted_minor: row.convertedMinor,
    revenue_minor: row.revenueMinor,
    orders: row.orders,
    roas: row.roas,
    roas_unavailable: row.roasUnavailable,
    matched_by: row.matchedBy,
  }
}

export function createAdsRoutes(deps: AdsRoutesDeps): Hono<Env> {
  const { db } = deps
  const app = new Hono<Env>()

  const readConnection: Handler<Env> = async (c) => {
    const { siteId } = c.get('membership')
    const row = await readMetaAdsConnection(db, siteId)
    return c.json(row === null ? { status: 'not_connected' } : connectionJson(row))
  }

  const disconnect: Handler<Env> = async (c) => {
    const { siteId } = c.get('membership')
    const removed = await deleteMetaAdsConnection(db, { siteId, actorUserId: c.get('user').id })
    if (!removed.deleted) throw new ApiError('NOT_FOUND', 'This site has no Meta Ads connection')
    return c.body(null, 204)
  }

  for (const path of CONNECTION_PATHS) {
    app.use(path, siteMembership(db), requireCapability('revenue:read'))
    app.get(path, readConnection)
    app.delete(path, disconnect)
  }

  if (deps.write) {
    const { vault, client } = deps.write
    const connect: Handler<Env> = async (c) => {
      const actor = c.get('user')
      const { siteId } = c.get('membership')
      const body = await readBody(c)

      const adAccountId = normalizeMetaAdAccountId(body['ad_account_id'])
      const token = normalizeMetaAccessToken(body['access_token'])
      const issues: { field: string; code: string; message: string }[] = []
      if (adAccountId === null) {
        issues.push({
          field: 'ad_account_id',
          code: 'invalid',
          message: 'An ad account id is act_ followed by digits.',
        })
      }
      if (token === null) {
        // The value is never repeated: it may be a real token pasted with a
        // stray character.
        issues.push({
          field: 'access_token',
          code: 'invalid',
          message: 'An access token is 20 to 1024 characters with no spaces.',
        })
      }
      if (adAccountId === null || token === null) {
        throw new ApiError('VALIDATION_FAILED', 'The Meta Ads connection is not valid', {
          details: { issues },
        })
      }

      // Before the probe, so a site on its way out never sends a token to Meta.
      const site = await getSiteBasics(db, siteId)
      if (!site || site.status === 'deleting' || site.status === 'deleted') {
        throw new ApiError('SITE_NOT_FOUND', 'No such site')
      }

      const verified = await client.verifyAccount(adAccountId, token)
      if (!verified.ok) {
        await writeAudit(db, {
          action: 'site.meta_ads.verify_failed',
          actorUserId: actor.id,
          siteId,
          targetType: 'meta_ads_connection',
          // A category and a detail built from status codes; never Meta's message.
          metadata: { outcome: verified.reason, detail: verified.detail },
        })
        c.get('logger')?.warn('meta_ads_verify_failed', {
          site_id: siteId,
          reason: verified.reason,
          retryable: verified.reason !== 'unauthorized',
        })
        if (verified.reason === 'unauthorized') {
          throw new ApiError(
            'ADS_CREDENTIAL_REJECTED',
            'Meta refused this token, or it cannot read that ad account. Nothing was stored.',
          )
        }
        throw new ApiError(
          'PROVIDER_UNAVAILABLE',
          'Meta did not answer usefully; the token was not stored',
          { details: { provider: 'meta', reason: verified.reason, retryable: true } },
        )
      }

      const encrypted = vault.encrypt(token, metaAdsCredentialAad({ siteId, adAccountId }))
      const saved = await saveMetaAdsConnection(db, {
        siteId,
        adAccountId,
        adAccountName: verified.name,
        currency: verified.currency,
        accountStatus: verified.accountStatus,
        encryptedToken: encrypted.stored,
        keyVersion: encrypted.keyVersion,
        tokenLast4: credentialLast4(token),
        actorUserId: actor.id,
      })
      // The deletion started after the check above: the save read `deleting`
      // under the site row's lock and stored nothing.
      if (!saved.ok) throw new ApiError('SITE_NOT_FOUND', 'No such site')
      c.get('logger')?.info('meta_ads_connected', {
        site_id: siteId,
        account_changed: saved.accountChanged,
      })
      if (accountActive(verified.accountStatus) === false) {
        // Allowed: the owner may be connecting ahead of reactivating it. The
        // settings card says the account is disabled.
        c.get('logger')?.warn('meta_ads_account_inactive', {
          site_id: siteId,
          account_status: verified.accountStatus,
        })
      }
      return c.json(connectionJson(saved.connection))
    }
    for (const path of CONNECTION_PATHS) app.put(path, connect)
  }

  if (deps.analytics) {
    const service = deps.analytics
    const readCampaigns: Handler<Env> = async (c) => {
      const { siteId } = c.get('membership')
      const reporting = c.get('siteReportingCurrency').toUpperCase()
      const range = parseRange(c.req.query())
      if (Date.parse(range.to) <= Date.parse(range.from)) {
        throw new ApiError('VALIDATION_FAILED', 'range must be half-open with from < to', {
          details: { issues: [{ path: 'from', message: 'must be before to' }] },
        })
      }
      const { fromDay, toDay } = spendDayRange(range)

      const row = await readMetaAdsConnection(db, siteId)
      if (row === null) {
        return c.json({
          connection: null,
          currency: reporting,
          from_day: fromDay,
          to_day: toDay,
          campaigns: [],
          totals: {
            spend: { amount_minor: 0, currency: reporting },
            spend_converted_minor: 0,
            revenue_minor: 0,
            orders: 0,
            roas: null,
            roas_unavailable: 'no_spend',
          },
          unmatched: {
            campaigns: 0,
            spend: { amount_minor: 0, currency: reporting },
            spend_converted_minor: 0,
          },
        })
      }

      const [spend, revenue] = await Promise.all([
        listMetaAdsSpend(db, { siteId, fromDay, toDay }),
        service.lastTouchUtmCampaignRevenue({
          siteId,
          cacheEpoch: c.get('siteCacheEpoch'),
          from: range.from,
          to: range.to,
          limit: UTM_CAMPAIGN_ROWS,
        }),
      ])
      const currencies = new Set([reporting, row.currency, ...spend.map((s) => s.currency)])
      const rates = await listCurrencyRatesBetween(db, {
        currencies: [...currencies],
        from: shiftUtcDate(fromDay, -CURRENCY_RATE_LOOKBACK_DAYS),
        to: toDay,
      })

      const joined = joinCampaignRevenue(
        convertCampaignSpend(spend, reporting, rateLookup(rates)),
        revenue,
      )
      // Largest spend first: converted where it could be, so campaigns rank
      // in one currency; an unconvertible one ranks by its own amount.
      const ranked = [...joined.campaigns].sort(
        (a, b) =>
          (b.convertedMinor ?? b.spendMinor) - (a.convertedMinor ?? a.spendMinor) ||
          (a.campaignId < b.campaignId ? -1 : 1),
      )

      return c.json({
        connection: {
          status: row.status,
          ad_account_name: row.adAccountName,
          currency: row.currency,
          last_synced_at: row.lastSyncedAt?.toISOString() ?? null,
          last_error: row.lastError,
        },
        currency: reporting,
        from_day: fromDay,
        to_day: toDay,
        campaigns: ranked.map(campaignJson),
        totals: {
          // One ad account, one currency: Meta does not change an account's
          // currency, and a new account replaces the old one's spend.
          spend: { amount_minor: joined.totals.spendMinor, currency: row.currency },
          spend_converted_minor: joined.totals.spendConvertedMinor,
          revenue_minor: joined.totals.revenueMinor,
          orders: joined.totals.orders,
          roas: joined.totals.roas,
          roas_unavailable: joined.totals.roasUnavailable,
        },
        unmatched: {
          campaigns: joined.unmatched.campaigns,
          spend: { amount_minor: joined.unmatched.spendMinor, currency: row.currency },
          spend_converted_minor: joined.unmatched.spendConvertedMinor,
        },
      })
    }

    for (const path of CAMPAIGNS_PATHS) {
      app.use(
        path,
        siteMembership(db),
        requireAnalyticsAccess(db),
        requireCapability('revenue:read'),
      )
      app.get(path, readCampaigns)
    }
  }

  return app
}
