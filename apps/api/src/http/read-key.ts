import { randomUUID } from 'node:crypto'
import { ApiError, type Resolution } from '@openanalytics/contracts'
import { roleHasCapability, signRealtimeToken, type Auth, type SiteRole } from '@openanalytics/auth'
import {
  READ_KEY_LAST_USED_STALE_SECONDS,
  apiKeyCredentialRef,
  checkDeclaredRange,
  costRetryAfterSeconds,
  hasReadScope,
  oauthGrantCredentialRef,
  readScopesFromGrant,
  type ReadScope,
  type ImportPointer,
} from '@openanalytics/domain'
import {
  chargeReadCost,
  getFinalizerState,
  getFunnel,
  getLiveTrackingToken,
  getMembership,
  getSiteBasics,
  listSitesForUser,
  readCostSpent,
  resolveOAuthAccessToken,
  resolveReadApiKey,
  touchApiKeyUsage,
  type Database,
} from '@openanalytics/postgres'
import type { Logger } from '@openanalytics/observability'
import type { RequestContextVariables } from '@openanalytics/observability/hono'
import { REALTIME_SITE_EPOCH_SUBJECT, type RealtimeCache } from '@openanalytics/redis'
import { Hono, type MiddlewareHandler } from 'hono'
import type { AnalyticsReportRequest, AnalyticsService } from '../analytics/service.ts'
import {
  OVERVIEW_RESOLUTIONS,
  TIMESERIES_RESOLUTIONS,
  customEventPropertiesWithAllowlist,
  customEventsWithLabels,
  parseCustomEventPropertiesQuery,
  parseCompare,
  parseFunnel,
  parseRecentHours,
  parseRecentLimit,
  parseTimezone,
  parseVisitorHash,
  recentWindow,
  type FunnelQuery,
  parseFilters,
  parseLimit,
  parsePagesSort,
  parseRange,
  parseResolution,
} from './analytics.ts'
import type { CredentialUseRecorder } from './credential-events.ts'
import { bearerToken, canonicalSiteId } from './middleware.ts'
import {
  parseEventsBeforePurchase,
  parseRevenueAttribution,
  readConnection,
} from './revenue-analytics.ts'
import type { RateLimiter } from './rate-limit.ts'

/**
 * The key-authenticated read surface (ADR-0042; plan 04 §Milestone 14 items 1
 * and 2).
 *
 * A third door into the same analytics service, beside the session-authenticated
 * dashboard and the slug-addressed public share. What makes it a door and not a
 * second surface: every route here calls the *private* service method the
 * dashboard calls, with the same query gateway, the same `cache_epoch` and the
 * same import pointer. The difference is who is asking and how they proved it.
 *
 * It is deliberately NOT a second auth path bolted onto
 * `/v1/sites/{site_id}/analytics/*`. Those handlers read `membership` for the
 * site *and the role*, and the role is what withholds revenue from a viewer
 * (ADR-0036 CP7). Manufacturing a membership for a key would make that check
 * depend on a value we invent per request — the fabricated role would be the
 * only thing standing between a key and the revenue fields.
 */

/**
 * The `/v1/read/analytics/*` paths only a person may read: an OAuth token or a
 * session, never a site-bound API key. Exported so the tests pin the same list
 * the middleware enforces.
 */
export const PERSON_ONLY_ANALYTICS_READS: readonly string[] = [
  '/custom-events',
  '/custom-events/properties',
  '/performance',
  '/funnel',
  '/recent-visitors',
  '/visitor',
]

/**
 * Who is asking, and what they are allowed to ask for.
 *
 * **This is the seam M16 extends** (ADR-0042, D9). Adding OAuth means adding one
 * resolver that returns a `ReadPrincipal` for a token; it must not mean new
 * routes, a second rate limiter, a second set of response shapes or a second
 * billing gate. The handlers below never see a key — they see a site id and a
 * scope list, which is exactly what an access token also carries.
 */
export type ReadPrincipal =
  | {
      readonly kind: 'api_key'
      /** The credential's id — never its token, and never its hash. */
      readonly credentialId: string
      readonly siteId: string
      readonly scopes: readonly ReadScope[]
    }
  | {
      readonly kind: 'oauth'
      readonly credentialId: string
      /** The site selected by `X-OA-Site`, re-authorized on this request (D3). */
      readonly siteId: string
      readonly scopes: readonly ReadScope[]
      /**
       * The person this token belongs to.
       *
       * **Present on exactly one arm, and TypeScript is what keeps that
       * honest** (ADR-0043 D2). A handler that wants a user must narrow on
       * `kind`, and there is no branch in which a key produces one. This is the
       * difference between "the key has no user" being a sentence in an ADR and
       * being a fact the compiler enforces.
       */
      readonly userId: string
      /** Their role on the selected site — the floor a scope cannot lift (D4). */
      readonly role: SiteRole
    }
  | {
      /**
       * A browser with a live Better Auth session (ADR-0046 D4).
       *
       * **No `credentialId`, and that absence is the type doing work.** There is
       * no credential row to key a ledger by — the budget is the person's,
       * `user:{userId}`.
       *
       * **`role` arrived with ADR-0049 D3, and that is the moment ADR-0046 D4
       * named.** The field was withheld precisely so that opening revenue to a
       * session would have to be argued rather than assumed, and it is read from
       * the membership `selectSite` has already fetched — the same row, the same
       * request, no second query. It is not a widening on its own: a scope is a
       * ceiling and this role is the floor under it, so a viewer's session
       * reaches the capability check and is refused there exactly as their
       * dashboard is.
       */
      readonly kind: 'session'
      readonly siteId: string
      readonly scopes: readonly ReadScope[]
      readonly userId: string
      /** Their role on the selected site — the floor a scope cannot lift (D4). */
      readonly role: SiteRole
    }

/**
 * The credential, before a site has been chosen (ADR-0043 D3).
 *
 * `ReadPrincipal` is this plus a site. They are separate because the questions
 * are separate: `GET /v1/read/sites` needs to know *who* is asking and cannot
 * possibly know *which site* yet — it is the route that answers that.
 */
export type ReadCredential =
  | {
      readonly kind: 'api_key'
      readonly credentialId: string
      /** A key is bound to one site, so it arrives with its answer. */
      readonly siteId: string
      readonly scopes: readonly ReadScope[]
    }
  | {
      readonly kind: 'oauth'
      readonly credentialId: string
      readonly scopes: readonly ReadScope[]
      readonly userId: string
    }
  | {
      readonly kind: 'session'
      readonly scopes: readonly ReadScope[]
      readonly userId: string
    }

/**
 * What a session may ask for, fixed rather than derived (ADR-0046 D4, widened by
 * ADR-0049 D3).
 *
 * Not configurable, and it still matches the assistant's tool list exactly — so
 * the catalogue and the credential cannot disagree about what is reachable. The
 * list moved by exactly one string when revenue's aggregates became tools.
 *
 * Deliberately still **not** `realtime:read`: that scope mints a stream token
 * rather than returning a read, and a browser that wants one has the dashboard's
 * own endpoint.
 *
 * `revenue:read` here is a **ceiling, not a grant**. The revenue subtree
 * intersects it with the owner-only capability of the same name, so a viewer's
 * or an admin's session reaches that check and is refused by it — the same `403`
 * their dashboard gives them. Raising the ceiling is what lets an owner through;
 * it is not what decides they may pass.
 */
const SESSION_SCOPES: readonly ReadScope[] = ['site:read', 'analytics:read', 'revenue:read']

type Env = {
  Variables: RequestContextVariables & {
    readCredential: ReadCredential
    readPrincipal: ReadPrincipal
    /** The site's `config_version`, as the dashboard's guard sets it. */
    siteCacheEpoch: number
    siteImportPointer: ImportPointer | null
    /** The site's `reporting_currency`, for the revenue reads (ADR-0033 D2c). */
    siteReportingCurrency: string
  }
}

export interface ReadKeyDeps {
  readonly db: Database
  /**
   * The Better Auth instance, for the session arm (ADR-0046 D4).
   *
   * The *same* `auth.api.getSession({ headers })` call `sessionAuth` makes, so
   * "is this session live" keeps one answer — the `51c0d7f` lesson from M16,
   * where `/mcp` and `/v1/read` briefly had two answers to "is this token live".
   *
   * Optional because this surface mounts on `deps.db` alone and deliberately
   * outside `app.ts`'s auth gate: a deployment with no auth instance still
   * serves keys and tokens, and there is simply no session to resolve.
   */
  readonly auth?: Auth
  /**
   * The analytics service, present only when a query gateway is configured.
   *
   * Absent, the seven analytics reads answer `SERVICE_UNAVAILABLE` rather than
   * not being mounted. The collector's tracker-config endpoint set that
   * precedent and gave the reason: an unwired deployment is an operator problem,
   * and the caller must be able to tell "not ready" from "you may not". Here the
   * alternative is worse than a 404 — an unmounted `/v1/read/...` falls through
   * to the business subtree's session guard and answers `401`, telling a caller
   * holding a perfectly good key to go re-check it.
   */
  readonly service?: AnalyticsService
  readonly rateLimiter: RateLimiter
  /** `COLLECTOR_BASE_URL` — the install block's two URLs, or null. */
  readonly collectorBaseUrl?: string | undefined
  /**
   * Realtime token wiring, for `realtime:read` (ADR-0043 D5).
   *
   * Present only when the signing key and the cache are both configured, which is
   * the same optional-until-used gate the dashboard's own token endpoint carries.
   * Absent, `POST /v1/read/realtime/token` is not registered and the catch-all
   * answers `404` — true, and better than a 503 for a deployment that simply has
   * no realtime.
   */
  readonly realtime?: {
    readonly cache: Pick<RealtimeCache, 'ensureEpoch'>
    readonly signingKey: string
    readonly ttlSeconds: number
    readonly epochCheckSeconds: number
  }
  /**
   * The expensive-query gate's two numbers (ADR-0043 D7). Required rather than
   * optional: unlike a rate limiter, there is no conservative default that is
   * also correct — `0` means "no budget" and a wrong ceiling refuses honest
   * questions — so the caller states both and `app.ts` reads them from
   * environment.
   */
  readonly cost: {
    readonly maxRangeDays: number
    readonly dailyBudgetMs: number
  }
  /**
   * G-010's credential-event recorder (ADR-0051 D5).
   *
   * Handed in rather than built here, because `principalAuth` needs the same one
   * — a credential used only for writes must not be invisible to the journal —
   * and two constructions would be two places to get the fingerprint's input
   * wrong. Absent when no source secret is configured, which is the whole
   * feature off (D4); `main.ts` warns once at startup.
   */
  readonly recordCredentialUse?: CredentialUseRecorder
  readonly logger?: Logger
}

/** Revenue's two grains, as `revenue-analytics.ts` defines them. */
const REVENUE_RESOLUTIONS: readonly Resolution[] = ['hour', 'day']

/** Best-effort client IP, for the budget an unauthenticated caller draws on. */
function clientIp(headerValue: string | undefined): string {
  if (!headerValue) return 'unknown'
  return headerValue.split(',')[0]?.trim() || 'unknown'
}

/** The private key's scheme prefix (`packages/postgres` mints it). */
const PRIVATE_KEY_PREFIX = 'oa_sk_'

/**
 * The site selector for a token-authenticated request (ADR-0043 D3).
 *
 * A header rather than a query parameter, so it never mixes with the analytics
 * parameters every route here already parses, and so the same URL means the same
 * query for both credential kinds.
 */
export const SITE_HEADER = 'X-OA-Site'

/**
 * The shape an OAuth access token can have, checked before any query.
 *
 * The same cheap-refusal property `PRIVATE_KEY_PREFIX` gives the key path, for
 * the credential class that has no scheme prefix: Better Auth issues 32 letters,
 * our device exchange issues 32 base64url characters, and neither is 4 characters
 * or 400. Without this, an arbitrary-string flood would cost one indexed lookup
 * per request instead of none.
 */
const OAUTH_TOKEN_SHAPE = /^[A-Za-z0-9_-]{24,128}$/u

export function createReadKeyRoutes(deps: ReadKeyDeps): Hono<Env> {
  const { db, rateLimiter, logger } = deps
  const app = new Hono<Env>()
  // G-010's credential events (ADR-0051). The same recorder *object* the grant
  // arm holds, so a credential used only for writes is not invisible to the
  // journal and there is one place the fingerprint's input is chosen.
  const recordCredentialUse = deps.recordCredentialUse

  /**
   * Resolve the credential, charge its budget, and record that it was used.
   *
   * **One middleware, two credential kinds, and no second anything** — ADR-0042
   * D9's condition and ADR-0043 D2's promise. The routes below never learn which
   * arm produced the principal; they read `siteId` and `scopes`, exactly as they
   * did when a key was the only way in.
   *
   * Order is not incidental:
   *
   * 1. **Shape first.** A bearer that is neither a private key by its prefix nor
   *    a plausible access token by its alphabet is refused before any database
   *    work, so the cheapest flood — arbitrary strings — costs no query at all.
   * 2. **Resolve**, one indexed lookup: the token hash for a key, the token
   *    itself for a grant.
   * 3. **Charge the right budget**, on the *same limiter object* with a
   *    different key prefix — `key:` / `oauth:` / `ip:`. A resolved caller draws
   *    on its own credential's line; an unresolved one draws on the IP's.
   *    Charging a legitimate caller by IP is what ADR-0042 D6 refuses: a
   *    WordPress site behind a shared host shares an address with hundreds of
   *    unrelated sites, and the credential is the thing that is actually one
   *    caller.
   * 4. **Select and re-authorize the site.** For a key it is the key's own site
   *    and `X-OA-Site` is refused; for a token it is the header, checked against
   *    live membership on every single request. That check is the strongest
   *    revocation story either credential has and it costs one query: a member
   *    removed from a site loses it on their next request, with no token
   *    revocation, no epoch and no new mechanism.
   * 5. **Touch `last_used_at`** for a key, throttled in the statement, never
   *    fatal.
   */
  const readAuth: MiddlewareHandler<Env> = async (c, next) => {
    const authorization = c.req.header('authorization')
    const token = bearerToken(authorization)
    // Explicitly typed, not inferred: TypeScript only narrows after a
    // never-returning call when the callee carries a type annotation, and
    // without the narrowing every `resolved.` below reads as possibly-null.
    const refuse: () => never = () => {
      const ip = clientIp(c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'))
      const decision = rateLimiter.check(`ip:${ip}`)
      if (!decision.allowed) {
        c.header('Retry-After', String(decision.retryAfterSeconds))
        throw new ApiError('RATE_LIMITED', 'Too many requests', {
          details: { retry_after_seconds: decision.retryAfterSeconds },
        })
      }
      throw new ApiError('UNAUTHENTICATED', 'Invalid or expired credential')
    }

    const charge = (budgetKey: string): void => {
      const decision = rateLimiter.check(budgetKey)
      if (!decision.allowed) {
        c.header('Retry-After', String(decision.retryAfterSeconds))
        throw new ApiError('RATE_LIMITED', 'Too many requests', {
          details: { retry_after_seconds: decision.retryAfterSeconds },
        })
      }
    }

    /**
     * The session arm (ADR-0046 D4), and its condition is exact: **a session is
     * resolved when and only when there is no `Authorization` header at all.**
     *
     * Not "when the bearer fails to resolve". A caller who presented a
     * credential gets that credential's answer, because falling back to a cookie
     * on a revoked token would mean a withdrawn key silently keeps working in a
     * browser that also has a session. That is why this branch reads the raw
     * header rather than `token`, which is also null for a malformed one.
     */
    if (authorization === undefined) {
      const session = deps.auth
        ? await deps.auth.api.getSession({ headers: c.req.raw.headers })
        : null
      if (!session?.user) throw new ApiError('UNAUTHENTICATED', 'A credential is required')

      // A third prefix on the *same* limiter object and the same
      // `read_cost_ledger` (ADR-0043 D6's "a key prefix, not a second limiter").
      // A person's assistant turn and that same person's dashboard session are
      // one human's load on one query gateway.
      charge(`user:${session.user.id}`)

      c.set('readCredential', {
        kind: 'session',
        scopes: SESSION_SCOPES,
        userId: session.user.id,
      })

      await next()
      return
    }

    if (!token) throw new ApiError('UNAUTHENTICATED', 'A credential is required')

    if (token.startsWith(PRIVATE_KEY_PREFIX)) {
      const resolved = await resolveReadApiKey(db, token)
      if (!resolved) refuse()
      charge(`key:${resolved.id}`)

      // **A key-authenticated request that names a site is refused** (D3), not
      // silently ignored. The key *is* the site; a caller that names one is
      // asserting something, and one that agrees by accident today would
      // disagree tomorrow when somebody points the plugin at the wrong site.
      if (c.req.header(SITE_HEADER) !== undefined) {
        throw new ApiError(
          'VALIDATION_FAILED',
          `${SITE_HEADER} is not accepted with an API key: the key is bound to one site`,
          { details: { field: SITE_HEADER, code: 'not_applicable' } },
        )
      }

      c.set('readCredential', {
        kind: 'api_key',
        credentialId: resolved.id,
        siteId: resolved.siteId,
        scopes: resolved.scopes,
      })

      try {
        await touchApiKeyUsage(db, {
          id: resolved.id,
          staleAfterSeconds: READ_KEY_LAST_USED_STALE_SECONDS,
        })
      } catch (error) {
        // A last-used signal is not worth failing a read over. The key id is
        // safe to log; the token is not, and is not in scope here to log by
        // accident.
        logger?.warn('read_key_last_used_write_failed', { err: error, retryable: true })
      }

      await recordCredentialUse?.(c.req.raw, {
        kind: 'api_key',
        ref: apiKeyCredentialRef(resolved.id),
        siteId: resolved.siteId,
      })

      await next()
      return
    }

    if (!OAUTH_TOKEN_SHAPE.test(token)) refuse()
    const grant = await resolveOAuthAccessToken(db, token)
    if (!grant) refuse()
    charge(`oauth:${grant.id}`)

    c.set('readCredential', {
      kind: 'oauth',
      credentialId: grant.id,
      // Read through the vocabulary rather than trusted as stored, exactly as a
      // key's column is: a grant string carrying something this build cannot
      // name confers what it can name and no more.
      scopes: readScopesFromGrant(grant.scopes),
      userId: grant.userId,
    })

    // The grant, not the token row: Better Auth's refresh inserts a new row each
    // time, so keying this on `grant.id` would report a new first use every hour
    // (ADR-0051 D6). No `siteId` — the site is chosen later, by `X-OA-Site`, and
    // a grant is not bound to one.
    await recordCredentialUse?.(c.req.raw, {
      kind: 'oauth_grant',
      ref: oauthGrantCredentialRef(grant.userId, grant.clientId),
      userId: grant.userId,
    })

    await next()
  }

  /**
   * Turn a credential into a principal *on a site* (ADR-0043 D3).
   *
   * **Separate from `readAuth`, and the separation is a defect this milestone
   * shipped and then found.** The first version required `X-OA-Site` inside the
   * resolver, on every path under `/read/*` — which made `GET /v1/read/sites`
   * unusable: it is the route you call *before* you know a site id, and it
   * demanded one. The two questions are genuinely different — "who are you" and
   * "which of your sites is this about" — and only routes that read a site's data
   * ask the second.
   *
   * For a key the answer needs no header: the key **is** the site. For a token:
   *
   * - **The header is required**, naming itself in the refusal. There is no "your
   *   first site" default — a CLI that silently reports on the wrong site is
   *   worse than one that asks.
   * - **A selector that is not a uuid and a site the user cannot see get the same
   *   answer.** Copied from `siteMembership`'s two answers rather than its body
   *   (which reads the path, not a header): "that is not an id" and "you cannot
   *   see it" must stay indistinguishable to somebody holding an id.
   * - **Membership is read live, on this request.** Not a grant frozen at consent
   *   time — which is what makes removing a member revoke their access with no
   *   token revocation at all.
   */
  const selectSite: MiddlewareHandler<Env> = async (c, next) => {
    const credential = c.get('readCredential')

    if (credential.kind === 'api_key') {
      c.set('readPrincipal', {
        kind: 'api_key',
        credentialId: credential.credentialId,
        siteId: credential.siteId,
        scopes: credential.scopes,
      })
      await next()
      return
    }

    const selector = c.req.header(SITE_HEADER)
    if (selector === undefined || selector.trim().length === 0) {
      throw new ApiError('VALIDATION_FAILED', `${SITE_HEADER} is required to select a site`, {
        details: { field: SITE_HEADER, code: 'required' },
      })
    }
    const siteId = canonicalSiteId(selector)
    if (siteId === null) throw new ApiError('SITE_NOT_FOUND', 'No such site')

    const membership = await getMembership(db, { siteId, userId: credential.userId })
    if (!membership) throw new ApiError('SITE_NOT_FOUND', 'No such site')

    // The two person-credential arms share every line above — the header, the
    // canonical spelling, the live membership read — and differ only in what the
    // principal may carry. Both now carry the role, read off the membership row
    // this middleware has already fetched (ADR-0049 D3): no second query, and no
    // way for the role a capability check sees to be older than the membership
    // check that admitted the request.
    c.set(
      'readPrincipal',
      credential.kind === 'session'
        ? {
            kind: 'session',
            siteId,
            scopes: credential.scopes,
            userId: credential.userId,
            role: membership.role,
          }
        : {
            kind: 'oauth',
            credentialId: credential.credentialId,
            siteId,
            scopes: credential.scopes,
            userId: credential.userId,
            role: membership.role,
          },
    )

    await next()
  }

  /**
   * A valid key without the scope is `403`, not `401` (ADR-0042, D3).
   *
   * Authentication succeeded and it is the permission that is absent. A `401`
   * would send an integrator off to re-check a token that is fine, and the
   * recovery — mint a key with `analytics:read` — would be invisible.
   */
  const requireScope = (scope: ReadScope): MiddlewareHandler<Env> => {
    return async (c, next) => {
      // Read off the *credential*, not the principal: the scope check runs on
      // `/read/sites` too, where no site has been selected yet.
      if (!hasReadScope(c.get('readCredential').scopes, scope)) {
        throw new ApiError('FORBIDDEN', `This credential does not carry the ${scope} scope`)
      }
      await next()
    }
  }

  /**
   * The two scopes only a person's credential can hold (ADR-0043 D5).
   *
   * A key cannot be minted with either — `packages/domain` refuses it and the
   * create endpoint returns `400` naming the reason — so in a correct system this
   * never fires. It is here because "cannot be minted" and "cannot be used" are
   * different claims, and only the second is the one the read path depends on: a
   * row edited directly, or a scope this build later adds to `KEY_SCOPES` by
   * accident, would otherwise reach a handler that reads `userId` off a principal
   * that has none.
   *
   * **The test is "is this a key", not "is this OAuth"** (ADR-0049 D3). The
   * decision this guard implements is ADR-0043 D5's — a key resolves to a site
   * and never to a person, so it has no membership and no role, and a capability
   * check with nothing behind it is what ADR-0042 D3 refused to build. A session
   * is a person; naming the one arm that is not is what keeps this middleware
   * saying what it means, and it is why adding a third person-credential did not
   * need a third branch here.
   *
   * The message names the recovery rather than the rule, for the reason the mint
   * refusal does: the answer is a different credential kind, not a setting.
   */
  const requireUserPrincipal = (scope: ReadScope): MiddlewareHandler<Env> => {
    return async (c, next) => {
      if (c.get('readCredential').kind === 'api_key') {
        throw new ApiError(
          'FORBIDDEN',
          `${scope} needs a credential that belongs to a person; an API key belongs to a site. Use an OAuth token or a signed-in session.`,
        )
      }
      await next()
    }
  }

  /**
   * The site's own gates, resolved from the credential rather than a membership.
   *
   * Identical rules to `requireAnalyticsAccess` (docs snapshot 02 §19), and that
   * is the point of D5: the billing and lifecycle gates belong to the site, not
   * to the door. A key is not a way around the entitlement gate, and a torn-down
   * site is `SITE_NOT_FOUND` from here exactly as it is from the dashboard.
   */
  const requireSiteReadable: MiddlewareHandler<Env> = async (c, next) => {
    const { siteId } = c.get('readPrincipal')
    const site = await getSiteBasics(db, siteId)
    if (!site || site.status === 'deleting' || site.status === 'deleted') {
      throw new ApiError('SITE_NOT_FOUND', 'No such site')
    }
    if (site.status === 'suspended') {
      throw new ApiError('SITE_SUSPENDED', 'Analytics is unavailable while this site is suspended')
    }
    c.set('siteCacheEpoch', site.configVersion)
    c.set('siteReportingCurrency', site.reportingCurrency)
    c.set(
      'siteImportPointer',
      site.publishedImportRunId !== null && site.importCutoverDate !== null
        ? { runId: site.publishedImportRunId, cutoverDate: site.importCutoverDate }
        : null,
    )
    await next()
  }

  /** The configured service, or the honest refusal (see `ReadKeyDeps.service`). */
  const analytics = (): AnalyticsService => {
    if (!deps.service) {
      throw new ApiError(
        'SERVICE_UNAVAILABLE',
        'Analytics reads are not available on this deployment',
      )
    }
    return deps.service
  }

  app.use('/read/*', readAuth)

  /**
   * The site the key belongs to, plus what an unattended integration needs to
   * install the tracker (ADR-0042, D8).
   *
   * Under `site:read`, the minimum every private key has — including one minted
   * before scopes existed, whose NULL column reads as exactly this.
   *
   * The tracking key travels because it is **public**: it ships in the HTML of
   * every page of the site and is an ingest identifier, never read authorization
   * (docs snapshot 01 §3.2). What the read key adds is that a plugin can find it
   * without a dashboard session, which is the whole of "script injection" on this
   * side.
   *
   * **`requireSiteReadable` is deliberately absent from this chain, and the
   * absence is the decision.** That gate closes the *analytics* reads
   * (`reads.use('*', …)`) when billing is blocked; the install read is not one
   * of them. D8's whole point is that an unattended integration can fetch the
   * tracking key and render `status`, and the site somebody is installing on is
   * frequently one that has never been funded at all — a site may exist before
   * it is funded (ADR-0040), and that state is `suspended`. Gating this
   * route would answer `SITE_SUSPENDED` to a question whose honest answer is
   * `status: 'suspended'`, and would make paying a precondition for
   * finishing an install rather than for reading the numbers it produces.
   */
  app.get('/read/site', requireScope('site:read'), selectSite, async (c) => {
    const { siteId } = c.get('readPrincipal')
    const site = await getSiteBasics(db, siteId)
    if (!site) throw new ApiError('SITE_NOT_FOUND', 'No such site')
    const base = deps.collectorBaseUrl
    return c.json({
      site_id: site.siteId,
      slug: site.slug,
      name: site.name,
      status: site.status,
      install: {
        tracking_key: await getLiveTrackingToken(db, siteId),
        // Both derived from one configured origin, exactly as the dashboard's
        // own snippet builder derives them. Unset, both are null and the caller
        // falls back to its own setting — a hardcoded host would be wrong for
        // every self-hosted deployment.
        script_url: base ? `${base.replace(/\/$/u, '')}/oa.js` : null,
        collector_url: base ? base.replace(/\/$/u, '') : null,
      },
    })
  })

  /**
   * The sites this credential may select (ADR-0043 D3).
   *
   * **The one new route M16 adds, and it is not an analytics surface.** It
   * exists because a human types `oa stats --site my-blog` and something has to
   * turn a slug into an id, and it is deliberately the same route for both
   * credential kinds rather than an OAuth-only endpoint: D9 forbids a parallel
   * surface, and "the sites you may select" is the same question for both.
   *
   * - **A token** lists the user's live memberships, which is also the exact set
   *   `X-OA-Site` will accept on the next request — the list and the check read
   *   the same table, so they cannot disagree.
   * - **A session** lists the same live memberships a token does, from the same
   *   query (ADR-0046 D4). It is what makes the assistant's `list_sites` tool
   *   work, and what lets the model choose a site without the client naming one.
   * - **A key** lists the one site it is bound to, as a one-element list. Not an
   *   error and not an empty list: the answer to "which sites may you select" for
   *   a credential bound to one site is that site, and a caller can write one
   *   code path for both.
   *
   * Served under `site:read`, the minimum both credentials have. Registered
   * before `/read/site` would be — Hono matches in registration order and
   * `/read/sites` is a distinct literal path, but keeping them adjacent is how a
   * reader sees they are two different questions.
   */
  app.get('/read/sites', requireScope('site:read'), async (c) => {
    // The one route that reads the credential rather than a principal: it is
    // what a caller uses to *find* a site, so demanding one first would be a
    // chicken and egg. This is the whole reason `selectSite` is its own step.
    const principal = c.get('readCredential')

    if (principal.kind === 'api_key') {
      const site = await getSiteBasics(db, principal.siteId)
      // A torn-down site is an empty list rather than a 404: the question is
      // "what may you select", and the honest answer for a key whose site is
      // gone is "nothing", which is what the caller can act on.
      if (!site || site.status === 'deleting' || site.status === 'deleted') {
        return c.json({ items: [] })
      }
      return c.json({
        items: [
          {
            site_id: site.siteId,
            slug: site.slug,
            name: site.name,
            status: site.status,
            role: null,
          },
        ],
      })
    }

    const sites = await listSitesForUser(db, principal.userId)
    return c.json({
      items: sites
        .filter((site) => site.status !== 'deleting')
        .map((site) => ({
          site_id: site.siteId,
          slug: site.slug,
          name: site.name,
          status: site.status,
          // The role travels because a client can then say *why* revenue is
          // absent on a site — "you are an admin here" — instead of showing an
          // unexplained empty panel. It is a fact about the reader, not a grant.
          role: site.role,
        })),
    })
  })

  /**
   * The expensive-query gate (ADR-0043 D7), both halves, in one middleware.
   *
   * **Before: the declared range.** The span between `from` and `to` is in the
   * request and costs one subtraction to judge — and it is the *only* thing about
   * a request's cost that can honestly be known in advance, because the query
   * gateway reports elapsed time and no ClickHouse row or byte counts. Over the
   * ceiling is `RANGE_TOO_LARGE`, which a caller acts on by narrowing.
   *
   * **Before, again: the budget already spent.** One indexed sum over the last 24
   * hourly buckets. Over budget is `RATE_LIMITED` with `Retry-After` — the status
   * a caller already handles, rather than a new error class for the same
   * recovery.
   *
   * **After: the charge.** Wall clock around the handler, written on the way out.
   *
   * Two things about the measurement, both deliberate:
   *
   * - **It is the api's wall clock, not the gateway's `elapsed_ms`.** D7 named
   *   the latter; the former is what is reachable without threading a meta field
   *   through every service method, and it is the better number anyway — it
   *   includes the round trip and our own serialization, which is what the
   *   request actually cost this system. The amendment is recorded in D7.
   * - **A failed read is still charged.** A query that times out or errors has
   *   already spent the time, and not charging it would make failure the cheapest
   *   way to hold the gateway open. The charge is in a `finally`.
   *
   * The charge is best-effort: a ledger write that fails is logged and swallowed,
   * because refusing a read that already succeeded over an accounting row would
   * turn a Postgres blip into an outage on a surface whose data is already in
   * the response.
   */
  const costGate: MiddlewareHandler<Env> = async (c, next) => {
    const principal = c.get('readPrincipal')
    // Three prefixes, one ledger. The session's key is the *person* (ADR-0046
    // D4): there is no credential row to key it by, and the budget is the one
    // that human's dashboard already draws on.
    const credentialKey =
      principal.kind === 'session'
        ? `user:${principal.userId}`
        : `${principal.kind === 'oauth' ? 'oauth' : 'key'}:${principal.credentialId}`
    const query = c.req.query()

    // Only when the request actually declares one. `/v1/read/site` and
    // `/v1/read/sites` carry no range and are not analytics queries; this
    // middleware guards the ones that are.
    if (query['from'] !== undefined && query['to'] !== undefined) {
      const from = new Date(query['from'])
      const to = new Date(query['to'])
      if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
        const verdict = checkDeclaredRange({ from, to, maxDays: deps.cost.maxRangeDays })
        if (!verdict.allowed) {
          throw new ApiError(
            'RANGE_TOO_LARGE',
            `This surface serves at most ${verdict.maxDays} days per request; ask for a narrower window`,
            {
              details: { requested_days: verdict.requestedDays, max_days: verdict.maxDays },
            },
          )
        }
      }
      // A malformed instant is left to `parseRange`, which names the field. A
      // `RANGE_TOO_LARGE` for `from=yesterday` would send an integrator looking
      // for a width problem in a parsing one.
    }

    if (deps.cost.dailyBudgetMs > 0) {
      const spent = await readCostSpent(db, credentialKey)
      if (spent >= deps.cost.dailyBudgetMs) {
        const retryAfterSeconds = costRetryAfterSeconds(new Date())
        c.header('Retry-After', String(retryAfterSeconds))
        throw new ApiError('RATE_LIMITED', 'This credential has used its query budget for today', {
          details: { retry_after_seconds: retryAfterSeconds },
        })
      }
    }

    const startedAt = performance.now()
    try {
      await next()
    } finally {
      if (deps.cost.dailyBudgetMs > 0) {
        const elapsedMs = performance.now() - startedAt
        try {
          await chargeReadCost(db, { credentialKey, elapsedMs })
        } catch (error) {
          logger?.warn('read_cost_charge_failed', { err: error, retryable: true })
        }
      }
    }
  }

  // Everything below reads analytics, so it needs the scope, the site's gates,
  // the cost gate, and a configured gateway.
  const reads = new Hono<Env>()
  /**
   * The dashboard's remaining analytics reads, for a **person** only.
   *
   * ADR-0042 D4 kept custom events, performance, funnels and the visitor
   * reads off this surface, which was a surface for site-bound keys and
   * unattended integrations. An OAuth token and a session are neither: each
   * resolves to a user whose live membership `selectSite` re-reads on every
   * request, which is exactly what the dashboard's own route checks. So these
   * paths take the person arms and refuse a key with `403`, the way the revenue
   * reads do — a key still reads what D4 gave it and nothing more.
   *
   * Registered before the `'*'` gate, so a key is refused before it is
   * charged to the cost ledger or reaches the gateway.
   */
  for (const path of PERSON_ONLY_ANALYTICS_READS) {
    reads.use(path, async (c, next) => {
      if (c.get('readCredential').kind === 'api_key') {
        throw new ApiError(
          'FORBIDDEN',
          'This read needs a credential that belongs to a person; an API key belongs to a site. Use an OAuth token or a signed-in session.',
        )
      }
      await next()
    })
  }
  reads.use('*', requireScope('analytics:read'), selectSite, requireSiteReadable, costGate)

  reads.get('/overview', async (c) => {
    const query = c.req.query()
    return c.json(
      await analytics().overview({
        siteId: c.get('readPrincipal').siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...parseRange(query),
        filters: parseFilters(query),
        compare: parseCompare(query),
        resolution: parseResolution(query, OVERVIEW_RESOLUTIONS),
      }),
    )
  })

  reads.get('/timeseries', async (c) => {
    const query = c.req.query()
    return c.json(
      await analytics().timeseries({
        siteId: c.get('readPrincipal').siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...parseRange(query),
        filters: parseFilters(query),
        compare: parseCompare(query),
        resolution: parseResolution(query, TIMESERIES_RESOLUTIONS),
      }),
    )
  })

  /**
   * The four top-N reports.
   *
   * Geography is in this list rather than in a coarsened variant of its own:
   * `publicGeography` exists because an *anonymous* audience gets a narrowed row
   * (ADR-0017's city threshold). The owner sees their own cities in the
   * dashboard and sees the same ones through their own key (ADR-0042, D4).
   */
  const report = <T>(
    path: string,
    handler: (s: AnalyticsService, req: AnalyticsReportRequest) => Promise<T>,
  ) => {
    reads.get(`/${path}`, async (c) => {
      const query = c.req.query()
      return c.json(
        await handler(analytics(), {
          siteId: c.get('readPrincipal').siteId,
          cacheEpoch: c.get('siteCacheEpoch'),
          importPointer: c.get('siteImportPointer'),
          ...parseRange(query),
          limit: parseLimit(query),
          // Every report reachable through `report` is filterable (ADR-0075,
          // D-F2) — custom events and performance are not mounted here.
          filters: parseFilters(query),
        }),
      )
    })
  }

  // Pages carries the session decoration and the `sort` parameter (ADR-0075,
  // D-E1/D-E2), so it is spelled out rather than folded into `report`. An
  // unattended caller gets exactly what the dashboard gets — ADR-0042 D4's rule
  // that an owner's own key sees what the owner sees.
  reads.get('/pages', async (c) => {
    const query = c.req.query()
    return c.json(
      await analytics().pages({
        siteId: c.get('readPrincipal').siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...parseRange(query),
        limit: parseLimit(query),
        filters: parseFilters(query),
        sessionMetrics: true,
        sort: parsePagesSort(query),
      }),
    )
  })
  report('sources', (s, req) => s.sources(req))
  report('geography', (s, req) => s.geography(req))
  report('devices', (s, req) => s.devices(req))

  /**
   * Sessions, with `layering` intact.
   *
   * ADR-0039 D4 drops the watermark from the *public* share, so a share link
   * cannot be used as an unauthenticated probe of our session finalizer. A
   * revocable, owner-minted credential is not that, and an unattended caller is
   * the one that most needs to know when a number can still be revised — there
   * is no human at the other end to wonder.
   */
  reads.get('/sessions', async (c) => {
    const { siteId } = c.get('readPrincipal')
    const state = await getFinalizerState(db, siteId)
    return c.json(
      await analytics().sessions({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...parseRange(c.req.query()),
        finalizedThrough: state ? state.finalizedThrough : null,
      }),
    )
  })

  // Custom events with their dashboard labels, and web vitals. Person-only
  // (see `PERSON_ONLY_ANALYTICS_READS`); neither takes `filters`, because
  // neither has a filtered operation (ADR-0075, D-F2).
  reads.get('/custom-events', async (c) => {
    const query = c.req.query()
    return c.json(
      await customEventsWithLabels(db, analytics(), {
        siteId: c.get('readPrincipal').siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...parseRange(query),
        limit: parseLimit(query),
      }),
    )
  })

  // One custom event's property values (DataFast gap 6). Person-only, like
  // the custom-events report it breaks down.
  reads.get('/custom-events/properties', async (c) => {
    const query = c.req.query()
    return c.json(
      await customEventPropertiesWithAllowlist(db, analytics(), {
        siteId: c.get('readPrincipal').siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...parseRange(query),
        ...parseCustomEventPropertiesQuery(query),
      }),
    )
  })

  reads.get('/performance', async (c) => {
    const query = c.req.query()
    return c.json(
      await analytics().performance({
        siteId: c.get('readPrincipal').siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...parseRange(query),
        limit: parseLimit(query),
      }),
    )
  })

  /**
   * A funnel over a range: a stored one by `funnel_id`, or ad-hoc steps.
   *
   * A stored funnel is a saved question (migration 0024), and running it is
   * the same computation the dashboard runs with the definition's steps, scope
   * and window. Reading the definition here, under the caller's own site, is
   * what lets a caller say "run my checkout funnel" without restating it. The
   * lookup is site-scoped, so another site's funnel id reads as absent.
   *
   * Both forms at once is refused rather than merged: which steps were run
   * would otherwise depend on a precedence rule nobody asked for.
   */
  reads.get('/funnel', async (c) => {
    const principal = c.get('readPrincipal')
    const { siteId } = principal
    const query = c.req.query()
    const range = parseRange(query)
    const funnelId = query['funnel_id']
    const steps = c.req.queries('steps') ?? []

    let funnel: FunnelQuery
    if (funnelId !== undefined) {
      if (steps.length > 0 || query['window_ms'] !== undefined || query['scope'] !== undefined) {
        throw new ApiError(
          'VALIDATION_FAILED',
          'Name a stored funnel with funnel_id, or give steps, window_ms and scope — not both',
          {
            details: {
              issues: [{ path: 'funnel_id', message: 'cannot be combined with ad-hoc steps' }],
            },
          },
        )
      }
      // A malformed id and a missing one are the same answer, for the reason a
      // site id is: a 400 for one would tell them apart.
      const id = canonicalSiteId(funnelId)
      const stored = id === null ? null : await getFunnel(db, { id, siteId })
      if (!stored) throw new ApiError('NOT_FOUND', 'No funnel with this id on this site')
      funnel = { steps: stored.steps, scope: stored.scope, windowMs: stored.windowMs }
    } else {
      funnel = parseFunnel(steps, query)
    }

    return c.json(
      await analytics().funnel({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...range,
        ...funnel,
        // Buyers and revenue per step follow the visitor reads' revenue rule.
        withRevenue: servesVisitorRevenue(principal),
      }),
    )
  })

  /**
   * Whether this caller is served the visitor reads' revenue marker.
   *
   * The dashboard's rule is the owner-only capability (ADR-0036 CP7). Here the
   * scope is a ceiling on top of it, as on the revenue reads (ADR-0043 D4): an
   * owner whose client never asked for `revenue:read` is not shown money
   * through `analytics:read`. Absent, never zero, either way.
   */
  const servesVisitorRevenue = (principal: ReadPrincipal): boolean =>
    principal.kind !== 'api_key' &&
    roleHasCapability(principal.role, 'revenue:read') &&
    hasReadScope(principal.scopes, 'revenue:read')

  /**
   * Recent visitors and one visitor's trail (ADR-0024), for a person.
   *
   * The dashboard's own reads, with one subtraction: `revenue_events` is never
   * served here. Those entries are the transaction journey's vocabulary, and
   * the journey stays off `/v1/read` for every credential (ADR-0043 D15). The
   * summed `revenue` marker, an aggregate with no customer or order in it,
   * follows `servesVisitorRevenue`.
   */
  reads.get('/recent-visitors', async (c) => {
    const principal = c.get('readPrincipal')
    const query = c.req.query()
    const timezone = parseTimezone(query)
    const window = recentWindow(parseRecentHours(query), new Date())
    return c.json(
      await analytics().recentVisitors({
        siteId: principal.siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        importPointer: c.get('siteImportPointer'),
        ...window,
        timezone,
        limit: parseRecentLimit(query),
        includeRevenue: servesVisitorRevenue(principal),
      }),
    )
  })

  reads.get('/visitor', async (c) => {
    const principal = c.get('readPrincipal')
    const query = c.req.query()
    const timezone = parseTimezone(query)
    const window = recentWindow(parseRecentHours(query), new Date())
    const { revenue_events: _journeyEntries, ...trail } = await analytics().visitorTrail({
      siteId: principal.siteId,
      cacheEpoch: c.get('siteCacheEpoch'),
      importPointer: c.get('siteImportPointer'),
      ...window,
      timezone,
      visitor: parseVisitorHash(query),
      includeRevenue: servesVisitorRevenue(principal),
    })
    return c.json(trail)
  })

  app.route('/read/analytics', reads)

  /**
   * Revenue, under `revenue:read` **intersected with** the owner-only capability
   * of the same name (ADR-0043 D4 and D5).
   *
   * This is where "a scope is a ceiling, never a floor" stops being a sentence.
   * Two checks, and neither substitutes for the other:
   *
   * - the **scope** says the credential's holder agreed to let this client ask
   *   about revenue at all;
   * - the **role** says whether this person may see it, and revenue has been
   *   owner-only since ADR-0036 CP7.
   *
   * A token carrying `revenue:read` whose user is an `admin` on the selected
   * site therefore reads nothing. The scope did not grant it; it only failed to
   * forbid it. Getting this backwards — treating the scope as sufficient — would
   * make an OAuth token a way for an admin to reach data the dashboard withholds
   * from them, which is the whole reason ADR-0042 D3 declined to define this
   * scope before there was a role behind it.
   *
   * **Since ADR-0049 a session reaches here too**, and the intersection is what
   * makes that safe rather than the scope list being short. A session's ceiling
   * now carries `revenue:read`, so the check below is the only thing standing
   * between a viewer and this data — which is exactly the check that stands
   * between them and the dashboard's own revenue panel. Both arms carry `role`
   * off the same live membership read, so there is one answer to "may this
   * person see the money" no matter which door they came through.
   *
   * **Two of the dashboard's four revenue reads travel, and two do not.**
   * `summary` and `timeseries` are aggregates. `transactions` and its `journey`
   * return per-customer rows — an email, a customer id, an order id — and the
   * callers of this surface are an assistant's tool loop and a terminal that may
   * be logged or shared on a screen. Docs snapshot 02 §21 puts PII redaction on
   * the assistant's own list, and handing it customer rows through a *different*
   * door would be the same exposure by another route. **ADR-0049 opened the
   * aggregates and left this half exactly where it was**: the row-level reads
   * stay where a human is looking at them, on the session surface, and a caller
   * asking for them here gets `404` from the catch-all rather than `403` —
   * because there is no route, not because they may not have it.
   */
  const revenue = new Hono<Env>()
  revenue.use(
    '*',
    requireScope('revenue:read'),
    requireUserPrincipal('revenue:read'),
    selectSite,
    requireSiteReadable,
    // The same gate the analytics reads carry: revenue rollups are a ClickHouse
    // query like any other, and a surface that budgeted six of its reads and not
    // the other two would have a hole shaped exactly like the widest question a
    // caller can ask.
    costGate,
    async (c, next) => {
      const principal = c.get('readPrincipal')
      // Narrowing, not a cast: `role` exists on the two person arms and not on
      // the key, and `requireUserPrincipal` above is what has already excluded
      // the key. Written as "not a key" rather than as a list of the arms that
      // are allowed, so a fourth person-credential inherits the capability check
      // instead of silently falling past it (ADR-0049 D3).
      if (principal.kind === 'api_key' || !roleHasCapability(principal.role, 'revenue:read')) {
        throw new ApiError('FORBIDDEN', 'Revenue is available to a site owner only')
      }
      await next()
    },
  )

  revenue.get('/summary', async (c) => {
    const { siteId } = c.get('readPrincipal')
    const query = c.req.query()
    return c.json(
      await analytics().revenueSummary({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        reportingCurrency: c.get('siteReportingCurrency'),
        connection: await readConnection(db, siteId),
        ...parseRange(query),
        compare: parseCompare(query),
        resolution: parseResolution(query, REVENUE_RESOLUTIONS),
      }),
    )
  })

  revenue.get('/timeseries', async (c) => {
    const { siteId } = c.get('readPrincipal')
    const query = c.req.query()
    return c.json(
      await analytics().revenueTimeseries({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        reportingCurrency: c.get('siteReportingCurrency'),
        connection: await readConnection(db, siteId),
        ...parseRange(query),
        resolution: parseResolution(query, REVENUE_RESOLUTIONS),
      }),
    )
  })

  // Perier fork, DataFast gaps 3 and 4. Aggregates only — a dimension value or
  // an event name with counts, never a customer, order or visitor id — so they
  // travel here on the same footing as `summary` and `timeseries` (ADR-0049).
  revenue.get('/attribution', async (c) => {
    const { siteId } = c.get('readPrincipal')
    const query = c.req.query()
    return c.json(
      await analytics().revenueAttribution({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        reportingCurrency: c.get('siteReportingCurrency'),
        connection: await readConnection(db, siteId),
        ...parseRange(query),
        ...parseRevenueAttribution(query),
      }),
    )
  })

  revenue.get('/events-before-purchase', async (c) => {
    const { siteId } = c.get('readPrincipal')
    const query = c.req.query()
    return c.json(
      await analytics().revenueEventsBeforePurchase({
        siteId,
        cacheEpoch: c.get('siteCacheEpoch'),
        reportingCurrency: c.get('siteReportingCurrency'),
        connection: await readConnection(db, siteId),
        ...parseRange(query),
        ...parseEventsBeforePurchase(query),
      }),
    )
  })

  app.route('/read/revenue', revenue)

  /**
   * A realtime token for the selected site, under `realtime:read`
   * (ADR-0043 D5).
   *
   * **Four lines of resolver, which is exactly the argument D5 made.** The token
   * is minted from `readPrincipal.userId` — the same subject the dashboard's own
   * `POST /v1/sites/{id}/realtime/token` uses — so it inherits that subject's
   * access epoch, and revocation stays the one mechanism ADR-0030 D5 built:
   * `removeMember` enqueues `realtime.access_revoked` for a `user_id` and the
   * outbox replays it until Redis acknowledges. Nothing new was invented, which
   * is why a key can never have this: it has no subject to mint under, and giving
   * it one would mean a second revocation system for a credential whose
   * revocation is already "delete the row".
   *
   * Mounted only when the signing key and the realtime cache are both configured
   * — the optional-until-used rule the private and public token endpoints already
   * follow. Absent them the path answers `404` through the catch-all below, which
   * is true: this deployment has no realtime.
   */
  if (deps.realtime) {
    const realtime = deps.realtime
    app.post(
      '/read/realtime/token',
      requireScope('realtime:read'),
      requireUserPrincipal('realtime:read'),
      selectSite,
      requireSiteReadable,
      async (c) => {
        const principal = c.get('readPrincipal')
        // Still exactly the OAuth arm, and still unreachable otherwise: a key
        // is stopped by `requireUserPrincipal` and a session by `requireScope`,
        // because `SESSION_SCOPES` deliberately withholds `realtime:read`
        // (ADR-0049 D3 moved one scope and this is not it).
        if (principal.kind !== 'oauth') throw new ApiError('FORBIDDEN', 'Unreachable')
        const { siteId, userId } = principal

        // Both epochs seeded here and nowhere else, exactly as the dashboard's
        // endpoint does: the gateway treats a missing epoch as fail-closed, so a
        // token must never exist without the counters it is anchored to.
        let epoch: number
        let siteEpoch: number
        try {
          epoch = await realtime.cache.ensureEpoch({ siteId, subject: userId })
          siteEpoch = await realtime.cache.ensureEpoch({
            siteId,
            subject: REALTIME_SITE_EPOCH_SUBJECT,
          })
        } catch (error) {
          logger?.warn('realtime_epoch_seed_failed', {
            err: error,
            site_id: siteId,
            scope: 'private',
            retryable: true,
          })
          throw new ApiError('SERVICE_UNAVAILABLE', 'Realtime is temporarily unavailable')
        }

        const now = new Date()
        const issuedAtSeconds = Math.floor(now.getTime() / 1000)
        const jti = randomUUID()
        const token = signRealtimeToken({
          privateKeyPem: realtime.signingKey,
          siteId,
          subject: userId,
          scope: 'private',
          epoch,
          siteEpoch,
          issuedAt: now,
          ttlSeconds: realtime.ttlSeconds,
          jti,
        })
        logger?.info('realtime_token_issued', { site_id: siteId, scope: 'private', jti })
        return c.json({
          token,
          expires_at: new Date((issuedAtSeconds + realtime.ttlSeconds) * 1000).toISOString(),
          epoch_check_seconds: realtime.epochCheckSeconds,
        })
      },
    )
  }

  /**
   * A path under `/read/` that does not exist answers `404` — to an
   * authenticated caller.
   *
   * Without this it falls through to the business subtree's blanket session
   * guard and answers `401`, which AGENTS.md records as a general property of
   * `/v1` (ADR-0041 D3 met the same thing). On *this* surface that answer is
   * actively misleading: it tells a caller holding a perfectly good key to go
   * re-check it, which is the exact failure the `SERVICE_UNAVAILABLE` decision
   * above exists to avoid. `GET /v1/read/analytics/revenue` is not a permission
   * problem and not an authentication problem; it is a path that does not exist,
   * and the surfaces D4 excluded are the ones a caller will actually try.
   *
   * Registered last, so it catches only what the real routes did not, and it
   * sits *behind* `readKeyAuth` — an anonymous caller still gets `401` and
   * learns nothing about which paths exist.
   */
  app.all('/read/*', () => {
    throw new ApiError('NOT_FOUND', 'No such read endpoint')
  })

  return app
}
