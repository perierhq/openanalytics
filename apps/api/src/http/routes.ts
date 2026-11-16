import { ApiError, isValidTimezone } from '@openanalytics/contracts'
import { isSiteRole, type Auth, type SiteRole } from '@openanalytics/auth'
import {
  API_KEY_HOLDERS,
  KEY_SCOPES,
  MINIMUM_READ_SCOPE,
  isApiKeyHolder,
  isKeyEligibleScope,
  isReadScope,
  isRecentReauth,
  isSiteSlug,
  keyScopeRefusal,
  normalizeReportingCurrency,
  normalizeSiteDomainSet,
  normalizeSiteName,
  normalizeTrackerSettingsPatch,
  SITE_DOMAIN_MAX_COUNT,
  type ApiKeyHolder,
  type AssistantConfig,
  type ReadScope,
  type RevenueAdapterRegistry,
  type ServiceEnv,
  type SiteTrackerSettings,
} from '@openanalytics/domain'
import {
  EMAIL_OUTBOX_TOPIC,
  buildInviteEmailPayload,
  type CredentialVault,
  type ObjectStorage,
  type OpenAiChatClient,
} from '@openanalytics/integrations'
import {
  InviteError,
  SiteDeletionError,
  acceptInvite,
  createApiKey,
  createInvite,
  createSite,
  enqueueOutbox,
  getMembership,
  getPublicDashboardSettings,
  getSiteBasics,
  getSiteForUser,
  listApiKeys,
  listMembers,
  listSiteInvites,
  listSitesForUser,
  readSiteIngestSettings,
  removeMember,
  resendInvite,
  resolveSlugForUser,
  revokeApiKey,
  revokeInvite,
  startSiteDeletion,
  updateMemberRole,
  updatePublicDashboardSettings,
  updateSiteSettings,
  upsertSiteIngestSettings,
  type ApiKeySummary,
  type ApiKeyType,
  type Database,
  type PublicDashboardSettings,
  type PublicSurfaceFlags,
  type SiteInviteSummary,
  type SiteForUser,
} from '@openanalytics/postgres'
import { REALTIME_SITE_EPOCH_SUBJECT, type RealtimeCache } from '@openanalytics/redis'
import type { Logger } from '@openanalytics/observability'
import { Hono } from 'hono'
import type { AnalyticsService } from '../analytics/service.ts'
import { createAnalyticsRoutes } from './analytics.ts'
import { createEventDefinitionRoutes } from './event-definitions.ts'
import { createFunnelRoutes } from './funnels.ts'
import { createMentionRoutes } from './mentions.ts'
import { createWidgetRoutes } from './widgets.ts'
import { createExportRoutes } from './exports.ts'
import { createImportCatalogRoutes, createImportRoutes } from './imports.ts'
import { createRevenueAnalyticsRoutes } from './revenue-analytics.ts'
import { createRevenueCatalogRoutes, createRevenueRoutes } from './revenue.ts'
import { idempotent } from './idempotency.ts'
import { createDeploymentSettingsRoutes } from './deployment-settings.ts'
import { createMeRoutes } from './me.ts'
import { createMeDeletionRoutes } from './me-deletion.ts'
import type { RateLimiter } from './rate-limit.ts'
import { createRealtimeRoutes } from './realtime.ts'
import { createAssistantRoutes } from './assistant.ts'
import { createAssistantClientResolver } from './assistant-provider.ts'
import { requireCapability, siteMembership, type ApiVariables } from './middleware.ts'
import { createSiteToApiError, ownershipToApiError } from './ownership-errors.ts'
import { principalAuth } from './grant-arm.ts'
import type { CredentialUseRecorder } from './credential-events.ts'
import type { SiteCardStatsReader, SiteCardSubject } from '../analytics/site-cards.ts'
import type { ApiCloudExtension } from '../cloud-extension.ts'

/**
 * The Milestone 2 business HTTP surface: sites, members, keys and invites.
 * Every route authorizes on the server through the session → membership →
 * capability chain (docs snapshot 02 §19); the site id/slug boundary is honoured
 * (docs snapshot 03 §8), and the public tracking key is accepted on no read
 * endpoint (docs snapshot 02 §20).
 */

export interface RoutesDeps {
  readonly db: Database
  readonly auth: Auth
  readonly env: ServiceEnv<'api'>
  /** G-010's credential events for grant-authored writes (ADR-0051 D5), handed
   * to `principalAuth`. Absent when no source secret is configured. */
  readonly recordCredentialUse?: CredentialUseRecorder
  /** Analytics read service. Present only when a query gateway is configured; the
   * `/analytics` surface is not mounted otherwise (the optional-until-used rule). */
  readonly analytics?: AnalyticsService
  /**
   * The sites-grid card figures (ADR-0080). Present only when the query gateway
   * is, for the same reason `analytics` is — and absent it the list still
   * answers, with `null` figures, which the contract defines as "not computed"
   * rather than zero. A deployment with no gateway therefore serves a correct
   * site list rather than a wrong one.
   */
  readonly siteCards?: SiteCardStatsReader
  /** Realtime cache. Present only when the realtime cache client is configured; it
   * mints the private realtime token (epoch seed) and drives the best-effort
   * revocation bumps (docs snapshot 02 §17, 05 D-213). */
  readonly realtime?: {
    readonly cache: RealtimeCache
  }
  /** Object storage. Present only when the whole `OBJECT_STORAGE_*` block is
   * configured; the `/imports` surface is not mounted otherwise (the
   * optional-until-used rule, exactly as analytics needs a gateway). */
  readonly objectStorage?: ObjectStorage
  /**
   * Revenue credential wiring (ADR-0033, D3). Present only when
   * `OA_CREDENTIAL_KEYRING` parsed; the site-scoped connection routes are not
   * mounted otherwise — no secret, no surface, the billing precedent. The
   * provider catalog mounts either way.
   */
  readonly revenue?: {
    readonly vault: CredentialVault
    readonly adapters: RevenueAdapterRegistry
  }
  /**
   * The assistant's wiring (ADR-0046, D2). **Required, not optional**, because
   * the surface mounts unconditionally: a deployment with no provider answers
   * `503` naming the cause, and an absent route under `/v1` would answer `401`
   * instead — "you are signed out" for a feature nobody configured.
   *
   * `dispatch` is `app.fetch` from the assembled app; it is safe to hand over
   * before assembly finishes because it is evaluated per request, which is the
   * same arrangement `createMcpRoutes` has had since M16.
   */
  readonly assistant: {
    readonly config: AssistantConfig
    readonly dispatch: (request: Request) => Promise<Response>
    readonly resourceUrl: string
    readonly client?: OpenAiChatClient
  }
  /**
   * The optional surfaces a deployment mounts inside this subtree
   * (`src/cloud-extension.ts`). Absent in every self-hosted build; `app.ts`
   * passes whatever the registry holds. Only `businessRoutes` is read here — the
   * pre-session half cannot live in this file by definition.
   */
  readonly cloud?: ApiCloudExtension
  /**
   * The credential keyring on its own (migration 0043), for the deployment
   * settings surface. The same object `revenue.vault` carries; hoisted because
   * storing an SMTP password has nothing to do with payments, and a build with a
   * ring and no revenue adapters still needs one.
   */
  readonly vault?: CredentialVault
  /** The deployment test-send ceiling. `app.ts` always supplies one. */
  readonly testEmailRateLimiter: RateLimiter
}

type Env = { Variables: ApiVariables }

/**
 * Best-effort realtime revocation from the api (the "immediate" bump of D-213).
 *
 * Called after the state change has committed, and it never fails the request: a
 * removed member is removed whether or not Redis is reachable this instant. The
 * durable half — an outbox row the worker replays until Redis acks — is written
 * in the same transaction as the removal, so a lost bump here is recovered there.
 * A double bump only over-revokes, which is safe.
 */
async function revokeRealtimeAccess(
  cache: RealtimeCache | undefined,
  input: { siteId: string; subject: string },
  logger: Logger | undefined,
): Promise<void> {
  if (!cache) return
  try {
    await cache.bumpEpochAndPublishDisconnect(input)
  } catch (err) {
    logger?.warn('realtime_revocation_bump_failed', {
      err,
      site_id: input.siteId,
      retryable: true,
      // Metric-style field: the durable outbox drain is the recovery path.
      realtime_revocation_bump_failed: 1,
    })
  }
}

/**
 * Where this site's tag has been seen loading (ADR-0081, D3).
 *
 * Three things decide the answer, and only one of them is a cache read:
 *
 * - the site already has `first_event_at` — the stronger install signal
 *   (ADR-0027) exists, so this weaker one has nothing left to say and is not
 *   computed at all. That is also what keeps the read off every other request:
 *   an installed site never touches the cache again;
 * - no realtime cache in this deployment — nothing was ever recorded, so
 *   nothing can be reported;
 * - the read itself failed.
 *
 * All three answer `null`, and **never `[]`**. An empty array is a measurement
 * with a meaning of its own here — the cache was read and the tag has not loaded
 * anywhere in 24 hours, which is the screen's "check that the script is on the
 * page" case. A failed read reported as `[]` would state that as fact
 * (AGENTS.md: a provider failure is never an empty result).
 */
async function tagSightingsFor(
  cache: RealtimeCache | undefined,
  site: SiteForUser,
  logger: Logger | undefined,
): Promise<{ origin: string; seen_at: string; allowed: boolean }[] | null> {
  if (site.firstEventAt !== null || !cache) return null

  try {
    const sightings = await cache.readTagSightings({ siteId: site.siteId })
    return sightings.map((sighting) => ({
      origin: sighting.origin,
      seen_at: sighting.at,
      allowed: sighting.allowed,
    }))
  } catch (err) {
    logger?.warn('tag_sightings_read_failed', {
      err,
      site_id: site.siteId,
      retryable: true,
    })
    return null
  }
}

function siteJson(site: SiteForUser) {
  return {
    site_id: site.siteId,
    slug: site.slug,
    name: site.name,
    status: site.status,
    role: site.role,
    is_billing_owner: site.isBillingOwner,
    // Always present, so an empty array unambiguously means "no allowlist
    // configured" rather than "unknown" — which is a different statement, and the
    // one the collector would act on differently (docs snapshot 02 §7.1 item 4).
    domains: site.domains,
    // The site's creation instant: the dashboard anchors its "All time" interval
    // here rather than guessing a start date.
    created_at: site.createdAt.toISOString(),
    // The install-verified signal (ADR-0027). Null means no event has ever
    // reached the pipeline for this site — which is a fact, not a gap, and is
    // what onboarding's "tracker installed" step reads instead of polling
    // analytics and guessing what an empty interval means.
    first_event_at: site.firstEventAt?.toISOString() ?? null,
    // When this site was suspended (ADR-0030, decision 9). Required-and-nullable,
    // the ADR-0027 convention, so `null` is a statement: this site is not
    // suspended. It was a triple until the open-core split — the ingest grace
    // window and the retention deadline travelled beside it — and both of those
    // are deadlines only a deployment that *bills* computes, so they moved to the
    // hosted surface with the sweeper that sets them.
    suspended_at: site.suspendedAt?.toISOString() ?? null,
    // The dashboard reporting currency (ADR-0033, D2c). Every money figure the
    // product renders is denominated in it, so it belongs on the summary the
    // shell already loads rather than only on the revenue surface — otherwise a
    // client shows the wrong symbol for the length of one request.
    reporting_currency: site.reportingCurrency,
    // The site's own reporting clock (ADR-0044 D4, ADR-0079 D5). Always a zone
    // since migration 0046: it is the default every window on this site is cut
    // on, for the dashboard, the share board and every widget alike, which is
    // why the summary the shell already loads carries it rather than a second
    // request per screen.
    reporting_timezone: site.reportingTimezone,
  }
}

function inviteJson(invite: SiteInviteSummary) {
  return {
    invite_id: invite.inviteId,
    // Returned to a team manager who legitimately needs to see who was invited.
    // It still never reaches the audit trail or a log line (AGENTS.md).
    email: invite.email,
    role: invite.role,
    invited_by_user_id: invite.invitedByUserId,
    created_at: invite.createdAt.toISOString(),
    expires_at: invite.expiresAt.toISOString(),
    // `pending` or `expired`. Without it the two rows are indistinguishable in a
    // list that now carries both, and the screen cannot say which link is dead.
    status: invite.status,
  }
}

/** A `VALIDATION_FAILED` that names the offending field, the shape the frontend
 * error catalog already documents (`details.issues`). */
function validationFailed(message: string, issues: readonly Record<string, unknown>[]): never {
  throw new ApiError('VALIDATION_FAILED', message, { details: { issues } })
}

function publicDashboardJson(settings: PublicDashboardSettings) {
  return {
    enabled: settings.enabled,
    share_slug: settings.shareSlug,
    share_overview: settings.shareOverview,
    share_geography: settings.shareGeography,
    share_realtime: settings.shareRealtime,
    // ADR-0039: one flag per surface, so an owner revokes the traffic chart
    // without revoking the page list.
    share_timeseries: settings.shareTimeseries,
    share_sessions: settings.shareSessions,
    share_pages: settings.sharePages,
    share_sources: settings.shareSources,
    share_devices: settings.shareDevices,
    // ADR-0044: the ninth surface. It is not a card — it decides whether the
    // share page may name the site at all.
    share_identity: settings.shareIdentity,
  }
}

/**
 * The per-surface opt-ins from a `PUT` body.
 *
 * `=== true` on every field, not a truthiness test and not a default: the `PUT`
 * is a full replace, so an omitted surface is **off**. That is the direction a
 * missing field must fail in — a client that has not learned about a surface
 * closes it rather than publishing it (ADR-0039, D2).
 */
function publicSurfaceFlagsFrom(body: Record<string, unknown>): PublicSurfaceFlags {
  return {
    shareOverview: body['share_overview'] === true,
    shareGeography: body['share_geography'] === true,
    shareRealtime: body['share_realtime'] === true,
    shareTimeseries: body['share_timeseries'] === true,
    shareSessions: body['share_sessions'] === true,
    sharePages: body['share_pages'] === true,
    shareSources: body['share_sources'] === true,
    shareDevices: body['share_devices'] === true,
    shareIdentity: body['share_identity'] === true,
  }
}

/**
 * The scopes a create request asked for (ADR-0042 D3; ADR-0043 D4 and D5).
 *
 * `undefined` means "not asked", which the repository turns into the minimum —
 * §20's default. Four refusals, each for a different mistake:
 *
 * - a scope string this build does not know, so a typo (`analytics.read`) is a
 *   named field error rather than a key silently minted without the grant its
 *   creator believed they were giving;
 * - `scopes` on a `tracking_write` key, which carries none — accepting and
 *   ignoring it would let an owner believe a public ingest token had been
 *   narrowed;
 * - an empty array, which is not "the minimum" but "nothing", and a key that can
 *   read nothing at all is a credential nobody meant to create;
 * - a scope that exists in the vocabulary but that **no key can ever hold** —
 *   `realtime:read` and `revenue:read` (ADR-0043 D5). Refused rather than
 *   accepted-and-ignored, because a key row listing a scope the resolver will
 *   never honour is a lie told once at mint time and read forever afterwards on
 *   the keys page. The refusal names the reason, not just the rule: the recovery
 *   is a different credential kind, not a plan or a setting, and `keyScopeRefusal`
 *   lives in `packages/domain` so this endpoint and the resolver cannot disagree
 *   about which scopes those are.
 */
function parseRequestedScopes(raw: unknown, type: ApiKeyType): ReadScope[] | undefined {
  if (raw === undefined) return undefined
  if (type !== 'private_read') {
    validationFailed('A tracking key carries no scopes', [
      { field: 'scopes', code: 'not_applicable' },
    ])
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    validationFailed('scopes must be a non-empty array of scope names', [
      { field: 'scopes', code: 'invalid' },
    ])
  }
  const unknown = raw.filter((scope) => !isReadScope(scope))
  if (unknown.length > 0) {
    validationFailed(`Unknown scope: ${unknown.map(String).join(', ')}`, [
      { field: 'scopes', code: 'unknown', allowed: [...KEY_SCOPES] },
    ])
  }
  const ineligible = (raw as ReadScope[]).filter((scope) => !isKeyEligibleScope(scope))
  if (ineligible[0] !== undefined) {
    validationFailed(keyScopeRefusal(ineligible[0]), [
      { field: 'scopes', code: 'not_available_to_keys', allowed: [...KEY_SCOPES] },
    ])
  }
  // Deduplicated, and `site:read` is always present: it is what every private
  // key has by construction, and a key granted `analytics:read` alone would not
  // be able to read the site context its own analytics numbers belong to.
  return [...new Set<ReadScope>([MINIMUM_READ_SCOPE, ...(raw as ReadScope[])])]
}

/**
 * Who will hold this key's secret (ADR-0043, D8).
 *
 * `undefined` means "not asked", which the repository turns into `user` — the
 * value that revokes when its holder leaves the site. An owner who is about to
 * paste the token into a machine says `site`, and that declaration is the only
 * thing that will keep the installation alive through a personnel change.
 *
 * Two refusals, mirroring `parseRequestedScopes`:
 *
 * - an unknown string, so a typo is a named field error rather than a key
 *   silently minted with the opposite survival rule from the one its creator
 *   believed they were choosing;
 * - `held_by` on a `tracking_write` key, which is the site's by construction.
 *   `'site'` there would be redundant and `'user'` would be false, and
 *   accepting either would let an owner believe they had changed something.
 */
function parseRequestedHolder(raw: unknown, type: ApiKeyType): ApiKeyHolder | undefined {
  if (raw === undefined) return undefined
  if (type !== 'private_read') {
    validationFailed('A tracking key is always held by the site', [
      { field: 'held_by', code: 'not_applicable' },
    ])
  }
  if (!isApiKeyHolder(raw)) {
    validationFailed(`Unknown holder: ${String(raw)}`, [
      { field: 'held_by', code: 'unknown', allowed: [...API_KEY_HOLDERS] },
    ])
  }
  return raw
}

function keyJson(key: ApiKeySummary) {
  return {
    id: key.id,
    type: key.type,
    name: key.name,
    key_prefix: key.keyPrefix,
    public_token: key.publicToken,
    // Required-and-nullable: `null` states "a tracking key, which has none",
    // and a private key always names its grant — including one minted before
    // scopes existed, which reads as the minimum (ADR-0042, D3).
    scopes: key.scopes === null ? null : [...key.scopes],
    // Who holds the secret, and whether somebody who was shown it has since
    // left the site (ADR-0043, D8). Both travel because D8's carve-out is only
    // defensible if the exposure it accepts is *visible*: a site-held key
    // survives its holder's departure rather than being revoked, and the owner
    // who has to decide whether to rotate it can only do that if the API says
    // so. A field written but never read would leave that argument unpaid.
    held_by: key.heldBy,
    rotation_required_at: key.rotationRequiredAt?.toISOString() ?? null,
    created_at: key.createdAt.toISOString(),
    last_used_at: key.lastUsedAt?.toISOString() ?? null,
    revoked_at: key.revokedAt?.toISOString() ?? null,
    expires_at: key.expiresAt?.toISOString() ?? null,
  }
}

/**
 * The invite flow's refusals.
 *
 * The two 409s are separate codes because they are separate situations with
 * separate recoveries, and the frontend branches on the code: an address that
 * already has a live invitation is fixed by revoking or resending that one,
 * while an address that already belongs to a member needs nothing done at all.
 * Collapsed into one `IDEMPOTENCY_CONFLICT` they were indistinguishable, and the
 * only honest message was a shrug.
 */
function inviteToApiError(error: unknown): never {
  if (error instanceof InviteError) {
    if (error.violation === 'email_mismatch') {
      throw new ApiError('FORBIDDEN', 'This invitation was issued to a different email')
    }
    if (error.violation === 'already_invited') {
      throw new ApiError(
        'IDEMPOTENCY_CONFLICT',
        'A live invitation for this address already exists',
      )
    }
    if (error.violation === 'already_member') {
      throw new ApiError('ALREADY_MEMBER', 'That address already belongs to a member of this site')
    }
    throw new ApiError('NOT_FOUND', 'The invitation is invalid, used or expired')
  }
  throw error
}

async function readJson(c: {
  req: { json: () => Promise<unknown> }
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    if (typeof body !== 'object' || body === null) throw new Error('not an object')
    return body as Record<string, unknown>
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'A JSON request body is required')
  }
}

export function createBusinessRoutes(deps: RoutesDeps): Hono<Env> {
  const { db, auth, env } = deps
  const app = new Hono<Env>()

  /**
   * The acceptance link an invitation email carries.
   *
   * It targets the FRONTEND, which calls `POST /v1/invites/accept` with the
   * token. The raw token is emailed and never returned in an API response.
   *
   * `APP_BASE_URL` is the frontend's origin; `AUTH_BASE_URL` is Better Auth's own
   * base and in production is the *api* host, so using it here sent invitees to a
   * page that does not exist. It stays as the fallback so a deployment that has
   * not set `APP_BASE_URL` yet keeps its old behaviour.
   */
  const inviteAcceptUrl = (rawToken: string): string => {
    const base = env.APP_BASE_URL ?? env.AUTH_BASE_URL ?? 'http://localhost:3000'
    return `${base}/invites/accept?token=${encodeURIComponent(rawToken)}`
  }

  // `GET /v1/read/site` used to live here, as the one bearer-key door in an
  // otherwise session-authenticated file. M14 gave the key six more reads, so
  // the whole door moved to `http/read-key.ts` and mounts in `app.ts` ahead of
  // this subtree — with the public dashboard and the notify form, the other two
  // surfaces that must never meet the session guard below (ADR-0042, D5).

  // --- Everything below authenticates a caller, and since ADR-0048 that is a
  // session *or* an OAuth grant. `principalAuth` resolves both: a cookie
  // request is unchanged, byte for byte; a bearer is held to the write
  // allowlist (`GRANT_WRITE_ALLOWLIST`) before it reaches any handler, so the
  // subtree opens to a narrow, enumerated set of writes without a parallel API.
  const authed = new Hono<Env>()
  authed.use(
    '*',
    principalAuth({
      db,
      auth,
      ...(deps.recordCredentialUse ? { recordCredentialUse: deps.recordCredentialUse } : {}),
    }),
  )

  // The caller's own account preferences (ADR-0026). Addressed by the session,
  // never by a user id in the path, so there is no other subject it could act on.
  // Unconditionally mounted: it needs only the database, which this whole subtree
  // already requires.
  authed.route('/', createMeRoutes({ db, productName: env.PRODUCT_NAME }))

  // `DELETE /v1/me` (ADR-0030, decision 8). Its own module and its own mount:
  // the preference handlers above and the erasure of an account are the same
  // subject addressed by the same session, and nothing else.
  authed.route('/', createMeDeletionRoutes({ db, env }))

  /**
   * What the operator configures from the dashboard rather than from a file on
   * the host (migration 0043).
   *
   * Mounted unconditionally, like the assistant and for the same reason: the
   * surface has three ways of being closed — the deployment turned it off, there
   * is no keyring, the caller is not the operator — and each of them is a
   * sentence the screen should be able to say. An absent route would say `401`
   * to all three, which is "you are signed out" for a decision somebody made on
   * purpose.
   */
  authed.route(
    '/',
    createDeploymentSettingsRoutes({
      db,
      env,
      testEmailRateLimiter: deps.testEmailRateLimiter,
      ...(deps.vault ? { vault: deps.vault } : {}),
    }),
  )

  // Analytics read surface, when a gateway is configured. Mounted on the
  // session-authenticated subtree; each route adds its own membership + billing
  // entitlement guard (docs snapshot 02 §19).
  if (deps.analytics) {
    authed.route('/', createAnalyticsRoutes({ db, service: deps.analytics }))
    // The revenue read surface (ADR-0033, D7). Gated on the same gateway and
    // mounted separately, because it is the first consumer of `revenue:read` and
    // that capability is owner-only: the analytics subtree above is deliberately
    // capability-free (a viewer reads analytics, 02 §19), so a shared mount
    // would be one `app.use` away from gating the whole dashboard for admins.
    authed.route('/', createRevenueAnalyticsRoutes({ db, service: deps.analytics }))
  }

  // Stored funnel definitions. Unconditional, unlike the analytics surface above:
  // saving a definition is a Postgres write and needs no query gateway, so the
  // funnels screen keeps working on a deployment that has no gateway configured.
  authed.route('/', createFunnelRoutes({ db }))

  // X mentions (migration 0048): settings and the stored posts. Unconditional
  // like funnels: it is Postgres only, and the poller that fills it runs in the
  // worker.
  authed.route('/', createMentionRoutes({ db }))

  // Embeddable widget configuration (ADR-0045, D13). Unconditional for the same
  // reason funnels is: a widget is stored configuration and needs no gateway,
  // so the widgets screen keeps working on a deployment that has none — and the
  // anonymous read that *does* need one is a different route entirely (CP2).
  //
  // `AUTH_BASE_URL` is the api's own public origin (ADR-0019: Better Auth's base
  // is the api host in production), and it is what `embed_url` is built from.
  // Deliberately not `c.req.url`: behind Caddy that carries the internal
  // `http://` scheme, and this URL is pasted into a customer's HTML rather than
  // followed once by us (ADR-0045 D13, the `b54c03d` lesson). The fallback is
  // the api's own local-development port, matching `apps/api/src/auth.ts`.
  authed.route(
    '/',
    createWidgetRoutes({ db, apiBaseUrl: env.AUTH_BASE_URL ?? 'http://localhost:4000' }),
  )

  /**
   * The AI analytics assistant (ADR-0046, D2), beside funnels and widgets and
   * **unconditionally**, like both of them.
   *
   * Here rather than in `app.ts` for one reason that decides it: the session is
   * the credential, and this subtree is where `sessionAuth` runs. A key or an
   * OAuth token reaching `/v1/assistant/questions` gets `401` from the guard the
   * subtree already has, not from a special refusal — which is the whole of D2's
   * "the browser dashboard is the only client in v1".
   *
   * Its `dispatch` still reaches the *assembled* app: `app.ts` passes
   * `async (request) => app.fetch(request)`, which is evaluated per request, so
   * a tool call is a real `/v1/read/*` request through every middleware that
   * route carries — the same arrangement MCP has had since M16, and the reason
   * neither surface needed a second read path.
   */
  authed.route(
    '/',
    createAssistantRoutes({
      db,
      config: deps.assistant.config,
      dispatch: deps.assistant.dispatch,
      resourceUrl: deps.assistant.resourceUrl,
      ...(deps.assistant.client ? { client: deps.assistant.client } : {}),
      // Which provider is in force is a per-request question since migration
      // 0043: a key typed into the deployment settings screen must work without
      // a restart. Falls back to the env-built client when nothing is stored.
      resolveClient: createAssistantClientResolver({
        db,
        config: deps.assistant.config,
        ...(deps.assistant.client ? { envClient: deps.assistant.client } : {}),
        ...(deps.vault ? { vault: deps.vault } : {}),
      }),
    }),
  )

  // Dashboard-defined custom events (ADR-0034). Unconditional for the same
  // reason as funnels: a definition is a Postgres write and needs no gateway.
  authed.route('/', createEventDefinitionRoutes({ db }))

  // The import provider catalog (ADR-0032, D11). Unconditional, like the funnels
  // surface and unlike the site-scoped import routes below: it is a static list
  // that touches neither the bucket nor the database, and its entire purpose is
  // to let the frontend replace its hardcoded provider list without a redeploy.
  // Behind the bucket check it would 404 on a deployment mid-configuration, and
  // the frontend cannot tell that from "this build is too old" — so it would keep
  // rendering the mock list this endpoint exists to retire.
  authed.route('/', createImportCatalogRoutes())

  // The revenue provider catalog (ADR-0033, D1). Unconditional for exactly the
  // reason the import catalog is: it is a static list touching neither the
  // keyring nor a provider, and hiding it behind `OA_CREDENTIAL_KEYRING` would
  // make a deployment mid-configuration answer 404 to a question ("what can this
  // build connect to?") whose answer does not depend on the secret at all.
  authed.route('/', createRevenueCatalogRoutes())

  // The site-scoped connection doors (ADR-0033, D3), mounted **unconditionally**
  // with the keyring gating only the two verbs that encrypt.
  //
  // The fail-closed rule is about writing a secret, not about the surface: `POST`
  // and `PATCH` need the ring and are simply not registered without it, while
  // `GET` and `DELETE` touch no vault at all — the status read renders columns,
  // and disconnect *nulls* the ciphertext columns rather than decrypting them. A
  // deployment whose ring went missing must not thereby lose the ability to cut
  // a live provider link; that is the one operation a customer might urgently
  // need, and taking it down with the secret would be exactly backwards.
  //
  // Deliberately NOT behind `requireAnalyticsAccess`: a billing-blocked site
  // must still be able to manage its provider connection.
  authed.route(
    '/',
    createRevenueRoutes({
      db,
      // The api's own public origin. ADR-0019: `AUTH_BASE_URL` is Better Auth's
      // base and in production is the api host, while `APP_BASE_URL` names the
      // frontend — and a provider webhook is delivered here, not to the
      // dashboard. The fallback is a local-development convenience and every
      // request that builds a URL from it warns.
      apiBaseUrl: env.AUTH_BASE_URL ?? 'http://localhost:3000',
      apiBaseUrlIsFallback: env.AUTH_BASE_URL === undefined,
      ...(deps.revenue ? { write: deps.revenue } : {}),
    }),
  )

  // The site-scoped import doors (ADR-0032). Mounted only with a bucket, the way
  // the analytics surface mounts only with a gateway: every route here either
  // mints a signed URL or reads the object one produced, so a mount without
  // storage could offer nothing but failures.
  if (deps.objectStorage) {
    authed.route(
      '/',
      createImportRoutes({
        db,
        objectStorage: deps.objectStorage,
        maxArchiveBytes: env.IMPORT_MAX_ARCHIVE_BYTES,
      }),
    )

    // The export door (ADR-0032, D8), behind the same bucket check and for the
    // same reason: every route on it either creates work that writes to storage
    // or mints a URL that reads from it, so a mount without storage could offer
    // nothing but failures.
    authed.route(
      '/',
      createExportRoutes({
        db,
        objectStorage: deps.objectStorage,
        objectTtlDays: env.EXPORT_OBJECT_TTL_DAYS,
      }),
    )
  }

  // Private realtime token endpoint, on the session subtree. Mounted only when the
  // signing key and the realtime cache are both configured (optional-until-used).
  if (env.REALTIME_TOKEN_SIGNING_KEY && deps.realtime) {
    authed.route(
      '/',
      createRealtimeRoutes({
        db,
        cache: deps.realtime.cache,
        signingKey: env.REALTIME_TOKEN_SIGNING_KEY,
        ttlSeconds: env.REALTIME_TOKEN_TTL_SECONDS,
        epochCheckSeconds: env.REALTIME_EPOCH_CHECK_SECONDS,
      }),
    )
  }

  /**
   * The caller's sites, each with the figures its card renders (ADR-0080).
   *
   * The figures are a decoration on a list that must always answer: the whole
   * dashboard shell loads through this route, so `SiteCardStatsReader` never
   * throws and a site it could not compute comes back with `null` figures rather
   * than a missing key or a 5xx. `null` is a statement in this contract — "not
   * computed for this response" — and is never the same claim as zero.
   */
  authed.get('/sites', async (c) => {
    const user = c.get('user')
    const sites = await listSitesForUser(db, user.id)
    const cards = deps.siteCards
      ? await deps.siteCards.read(
          user.id,
          sites.map((site): SiteCardSubject => ({
            siteId: site.siteId,
            role: site.role,
            status: site.status,
            firstEventAt: site.firstEventAt,
            reportingCurrency: site.reportingCurrency,
          })),
        )
      : undefined
    return c.json({
      items: sites.map((site) => ({
        ...siteJson(site),
        ...(cards?.get(site.siteId) ?? { all_time: null, sparkline: null }),
      })),
    })
  })

  /**
   * Create a site.
   *
   * Session-authenticated but deliberately *without* `siteMembership`: there is
   * no site yet to be a member of. The authorization that matters here is
   * commercial rather than membership-based — a live entitlement and a free plan
   * slot — and both are decided inside the repository's single transaction,
   * under a `FOR UPDATE` lock on the caller's subscription row, so two concurrent
   * creates cannot each find the same last slot free.
   *
   * The shape is validated here, before the transaction, because a malformed
   * slug is a client error that never needs a database round-trip; the taken-slug
   * case is the one that can only be answered by the unique index.
   */
  authed.post('/sites', idempotent({ db, scope: 'sites.create' }), async (c) => {
    const user = c.get('user')
    const body = await readJson(c)

    const rawSlug = body['slug']
    const slug = isSiteSlug(rawSlug) ? rawSlug : null
    const name = normalizeSiteName(body['name'])
    if (slug === null || name === null) {
      // Both fields are reported at once: fixing one at a time is a needlessly
      // slow form.
      const issues: Record<string, unknown>[] = []
      if (slug === null) issues.push({ field: 'slug', code: 'invalid' })
      if (name === null) issues.push({ field: 'name', code: 'invalid' })
      validationFailed('The site slug or name is not valid', issues)
    }

    try {
      const created = await createSite(db, { slug, name, ownerUserId: user.id })
      return c.json(
        {
          site_id: created.siteId,
          slug: created.slug,
          name: created.name,
          status: created.status,
          role: created.role,
          is_billing_owner: created.isBillingOwner,
          // The tracking key minted in the same transaction, so onboarding can
          // render the snippet without a second call. It is public by design and
          // is never read authorization (docs snapshot 01 §3.2).
          tracking_key: {
            id: created.trackingKey.id,
            public_token: created.trackingKey.publicToken,
            key_prefix: created.trackingKey.keyPrefix,
          },
          created_at: created.createdAt.toISOString(),
        },
        201,
      )
    } catch (error) {
      createSiteToApiError(error)
    }
  })

  authed.get('/sites/resolve', async (c) => {
    const user = c.get('user')
    const slug = c.req.query('slug')
    if (!slug) throw new ApiError('VALIDATION_FAILED', 'A slug is required')
    const resolved = await resolveSlugForUser(db, { slug, userId: user.id })
    if (!resolved) throw new ApiError('SITE_NOT_FOUND', 'No such site')
    return c.json({ site_id: resolved.siteId, slug: resolved.slug })
  })

  // Accepting an invite is account-scoped, not tied to an existing membership.
  authed.post('/invites/accept', async (c) => {
    const user = c.get('user')
    const body = await readJson(c)
    const token = body['token']
    if (typeof token !== 'string' || token.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'A token is required')
    }
    try {
      const accepted = await acceptInvite(db, { rawToken: token, userId: user.id })
      return c.json({ site_id: accepted.siteId, role: accepted.role })
    } catch (error) {
      inviteToApiError(error)
    }
  })

  authed.get('/sites/:site_id', siteMembership(db), async (c) => {
    const user = c.get('user')
    const { siteId } = c.get('membership')
    const site = await getSiteForUser(db, { siteId, userId: user.id })
    if (!site) throw new ApiError('SITE_NOT_FOUND', 'No such site')
    // The single-site read only (ADR-0081, D3): this is what the two waiting
    // screens poll, and the list is loaded on every screen of the product.
    return c.json({
      ...siteJson(site),
      tag_sightings: await tagSightingsFor(deps.realtime?.cache, site, c.get('logger')),
    })
  })

  /**
   * Delete a site (ADR-0030, decision 4).
   *
   * The most destructive endpoint in the product, and every guard in front of it
   * answers a different question:
   *
   * - `siteMembership` — is the caller party to this site at all;
   * - `requireCapability('site:delete')` — the capability has existed since M2,
   *     is owner-only and has never had a caller until now;
   * - `isRecentReauth` — was the *session* recently proven, not merely valid.
   *     Deletion sits beside the billing cutover in that respect: a stolen laptop
   *     with a live cookie must not be able to erase a customer's history;
   * - the name confirmation — the human typed the site's own name. It is checked
   *     against the site's *current* name read in this request, never against a
   *     value the client sent alongside it, which would make the confirmation
   *     self-referential;
   * - `idempotent` — a retried request replays instead of starting a second
   *     deletion. The repository is idempotent as well (it returns the live
   *     request for a site already `deleting`), so the two agree rather than one
   *     covering for the other.
   *
   * The answer is `202`, not `200`: deletion is a state machine that runs for as
   * long as ClickHouse takes to rewrite its parts. The client polls
   * `GET /v1/sites/{id}` and reads `status`, which stays `deleting` until the
   * tombstone lands and the site disappears from the list entirely.
   */
  authed.delete(
    '/sites/:site_id',
    siteMembership(db),
    requireCapability('site:delete'),
    idempotent({ db, scope: 'sites.delete' }),
    async (c) => {
      const user = c.get('user')
      const { siteId } = c.get('membership')
      const session = c.get('session')

      if (!isRecentReauth(session.createdAt, new Date())) {
        throw new ApiError('REAUTH_REQUIRED', 'Recent re-authentication required')
      }

      // Read before validating the confirmation: the name being confirmed is the
      // one stored right now. A `deleted` site is not visible here, which is the
      // 404 the ADR-0027 rule requires — the tombstone is not a site.
      const site = await getSiteForUser(db, { siteId, userId: user.id })
      if (!site) throw new ApiError('SITE_NOT_FOUND', 'No such site')

      const body = await readJson(c)
      const confirm = body['confirm']
      if (typeof confirm !== 'string' || confirm !== site.name) {
        validationFailed(`The confirmation must be the site's exact name, "${site.name}"`, [
          { field: 'confirm', code: 'name_mismatch' },
        ])
      }

      let started: Awaited<ReturnType<typeof startSiteDeletion>>
      try {
        started = await startSiteDeletion(db, { siteId, requestedByUserId: user.id })
      } catch (error) {
        if (error instanceof SiteDeletionError) {
          // Both reasons mean the same thing to a caller holding a site id that
          // no longer names a site they can act on.
          throw new ApiError('SITE_NOT_FOUND', 'No such site')
        }
        throw error
      }

      // After the commit, never inside it: cutting streams is a Redis side effect
      // and a transaction that still might roll back must not perform one. The
      // reserved `site` subject closes *every* client on the site (decision 5),
      // where the per-user subject would only close one member's.
      await revokeRealtimeAccess(
        deps.realtime?.cache,
        { siteId, subject: REALTIME_SITE_EPOCH_SUBJECT },
        c.get('logger'),
      )

      return c.json({ deletion_request_id: started.deletionRequestId, status: 'deleting' }, 202)
    },
  )

  /**
   * Rename a site, replace its origin allowlist, and/or set its reporting
   * currency.
   *
   * `site:settings` (owner and admin, never viewer). The domain list is
   * replace-set: what is sent becomes the exact allowlist, so every entry is
   * normalized and bounded here, before the write, and the repository bumps
   * `config_version` in the same transaction so the tracker-config ETag and the
   * collector's ingest-config cache both invalidate.
   *
   * An empty object is refused rather than accepted as a no-op: a settings save
   * that changed nothing is far more likely a client bug than an intention.
   *
   * **`reporting_currency` is the odd field here** (ADR-0033, D2c; CP5 is its
   * first writer). It is validated against a closed list rather than only
   * against the column's `^[A-Z]{3}$` CHECK, because `ZZZ` passes the regexp and
   * a site set to it gets `conversion_source = 'unavailable'` on every single
   * transaction — an entirely empty revenue dashboard produced by a typo, with
   * no error anywhere to explain it. And it is not merely a setting: changing it
   * re-materializes every stored fact and re-rolls every bucket, which the
   * repository performs in the same transaction as the write so the two halves
   * cannot commit apart. It deliberately does NOT bump `config_version` — the
   * collector has never heard of a reporting currency.
   *
   * The capability is `site:settings` rather than the owner-only `revenue:read`,
   * matching this route's existing model: an admin who may already replace the
   * origin allowlist is trusted with the label the numbers are denominated in.
   * Reading the numbers stays owner-only.
   *
   * **`reporting_timezone` is the site's own clock** (ADR-0044 D4, ADR-0079 D5),
   * and it is this route's second non-bumping field for the same reason as the
   * first. Every window this product cuts — the dashboard's, the share board's,
   * every widget's — starts and ends on it, so two viewers in two countries stop
   * cutting different buckets behind one link, and ADR-0026's user preference is
   * the fallback for a reader with no site to ask rather than the default.
   *
   * **`null` is refused.** It cleared the setting while the column was nullable;
   * since migration 0046 there is no such state to return to, and a site with no
   * clock is a site whose readers disagree about what a week is. A reader who
   * wants their own zone switches to it from the dashboard's header pill, which
   * is a view and writes nothing.
   */
  authed.patch(
    '/sites/:site_id',
    siteMembership(db),
    requireCapability('site:settings'),
    async (c) => {
      const actor = c.get('user')
      const { siteId, role, isBillingOwner } = c.get('membership')
      const body = await readJson(c)

      const hasName = Object.hasOwn(body, 'name')
      const hasDomains = Object.hasOwn(body, 'domains')
      const hasReportingCurrency = Object.hasOwn(body, 'reporting_currency')
      const hasReportingTimezone = Object.hasOwn(body, 'reporting_timezone')
      if (!hasName && !hasDomains && !hasReportingCurrency && !hasReportingTimezone) {
        validationFailed('At least one settable field is required', [
          { field: 'name', code: 'required_one_of' },
          { field: 'domains', code: 'required_one_of' },
          { field: 'reporting_currency', code: 'required_one_of' },
          { field: 'reporting_timezone', code: 'required_one_of' },
        ])
      }

      let reportingTimezone: string | undefined
      if (hasReportingTimezone) {
        const raw = body['reporting_timezone']
        // A string the *runtime's* tz database recognises, and nothing else —
        // `null` included, which used to clear the setting and no longer has a
        // state to clear it to (migration 0046). `isValidTimezone` is the
        // existence check, reused rather than reimplemented, so an offset zone
        // like `+05:00` is refused here too. Without its shape guard an offset
        // would pass and then be refused by the column CHECK as an unhandled
        // 500: a caller's mistake turned into our error.
        if (typeof raw !== 'string' || !isValidTimezone(raw)) {
          validationFailed('reporting_timezone must be a valid IANA identifier', [
            {
              field: 'reporting_timezone',
              code: 'invalid',
              // Echoed back: a zone name is site-owned configuration rather than
              // PII, and naming it is the difference between a fixable form
              // error and a mystery.
              value: typeof raw === 'string' ? raw : null,
            },
          ])
        }
        reportingTimezone = raw
      }

      let reportingCurrency: string | undefined
      if (hasReportingCurrency) {
        const normalized = normalizeReportingCurrency(body['reporting_currency'])
        if (normalized === null) {
          // The offending value is echoed back: a currency code is site-owned
          // configuration rather than PII, and naming it is the difference
          // between a fixable form error and a mystery. The supported list is
          // not echoed — it is in the contract, and a 400 body is the wrong
          // place for a fifty-element enum.
          validationFailed('reporting_currency must be a supported ISO-4217 code', [
            {
              field: 'reporting_currency',
              code: 'unsupported',
              value:
                typeof body['reporting_currency'] === 'string' ? body['reporting_currency'] : null,
            },
          ])
        }
        reportingCurrency = normalized
      }

      let name: string | undefined
      if (hasName) {
        const normalized = normalizeSiteName(body['name'])
        if (normalized === null) {
          validationFailed('The site name is not valid', [{ field: 'name', code: 'invalid' }])
        }
        name = normalized
      }

      let domains: string[] | undefined
      if (hasDomains) {
        const raw = body['domains']
        if (!Array.isArray(raw)) {
          validationFailed('domains must be an array', [{ field: 'domains', code: 'not_an_array' }])
        }
        const result = normalizeSiteDomainSet(raw)
        if (!result.ok) {
          // The rejected entry is echoed back: a domain name is site-owned
          // configuration rather than PII, and naming the offending entry is the
          // difference between a fixable form error and a mystery.
          if (result.error === 'invalid') {
            validationFailed('One of the domains is not a bare hostname', [
              { field: 'domains', code: 'invalid', index: result.index, value: result.value },
            ])
          }
          validationFailed(`At most ${SITE_DOMAIN_MAX_COUNT} domains are allowed`, [
            { field: 'domains', code: 'too_many', count: result.count },
          ])
        }
        domains = [...result.domains]
      }

      try {
        const updated = await updateSiteSettings(db, {
          siteId,
          ...(name === undefined ? {} : { name }),
          ...(domains === undefined ? {} : { domains }),
          ...(reportingCurrency === undefined ? {} : { reportingCurrency }),
          ...(reportingTimezone === undefined ? {} : { reportingTimezone }),
          actorUserId: actor.id,
        })
        // The caller's own role and billing-owner flag come from the membership
        // the middleware already resolved; re-reading them would be a second
        // query for an answer this request is already holding.
        return c.json(
          siteJson({
            siteId: updated.siteId,
            slug: updated.slug,
            name: updated.name,
            status: updated.status,
            role,
            isBillingOwner,
            domains: updated.domains,
            createdAt: updated.createdAt,
            firstEventAt: updated.firstEventAt,
            suspendedAt: updated.suspendedAt,
            reportingCurrency: updated.reportingCurrency,
            reportingTimezone: updated.reportingTimezone,
          }),
        )
      } catch (error) {
        ownershipToApiError(error)
      }
    },
  )

  authed.get('/sites/:site_id/members', siteMembership(db), async (c) => {
    const { siteId } = c.get('membership')
    const members = await listMembers(db, siteId)
    return c.json({
      items: members.map((m) => ({
        user_id: m.userId,
        role: m.role,
        // Shown to a fellow member, exactly as the pending-invite list already
        // shows an invitee's address. It never reaches the audit trail or a log.
        email: m.email,
        name: m.name,
      })),
    })
  })

  /**
   * Change a member's role.
   *
   * `team:manage`, plus one rule this route enforces itself: **only a caller
   * whose own role is `owner` may grant or revoke the `owner` role.** Without it
   * an `admin` — who holds `team:manage` — could promote themselves to owner,
   * which is a privilege escalation, or demote the owners above them.
   *
   * The target's current role is read *before* any write, because half of that
   * rule is about the target ("an admin may not demote an owner") and
   * `updateMemberRole` only reports `previousRole` once it has already written.
   * The window between this read and that write is not fully closed: the
   * repository's `SELECT ... FROM sites FOR UPDATE` serializes the *writes*
   * against each other — concurrent role changes, removals and the D-010 cutover
   * cannot interleave — but it is taken after this read, so it does not make the
   * read part of the same critical section. What bounds the residual risk is that
   * the invariants that actually matter are database-enforced and re-checked at
   * commit: a site keeps at least one owner (`OA001`) and the billing owner stays
   * an owner (`OA002`), whatever this route believed a moment earlier. Closing
   * the window entirely would mean moving the caller/target role comparison
   * inside the repository transaction.
   *
   * The two invariants are left to those deferred triggers rather than
   * pre-checked here, so they hold under concurrency instead of only in the
   * happy path.
   */
  authed.patch(
    '/sites/:site_id/members/:user_id',
    siteMembership(db),
    requireCapability('team:manage'),
    async (c) => {
      const actor = c.get('user')
      const { siteId, role: actorRole } = c.get('membership')
      const userId = c.req.param('user_id')
      const body = await readJson(c)
      const role = body['role']
      if (!isSiteRole(role)) {
        validationFailed('A valid role is required', [{ field: 'role', code: 'invalid' }])
      }

      const target = await getMembership(db, { siteId, userId })
      if (!target) {
        throw new ApiError('NOT_FOUND', 'The user is not a member of this site')
      }
      if ((role === 'owner' || target.role === 'owner') && actorRole !== 'owner') {
        throw new ApiError('FORBIDDEN', 'Only an owner can grant or revoke the owner role')
      }

      try {
        const updated = await updateMemberRole(db, {
          siteId,
          userId,
          role: role satisfies SiteRole,
          actorUserId: actor.id,
        })
        return c.json({ user_id: updated.userId, role: updated.role })
      } catch (error) {
        ownershipToApiError(error)
      }
    },
  )

  authed.delete(
    '/sites/:site_id/members/:user_id',
    siteMembership(db),
    requireCapability('team:manage'),
    async (c) => {
      const actor = c.get('user')
      const { siteId } = c.get('membership')
      const userId = c.req.param('user_id')
      try {
        await removeMember(db, { siteId, userId, actorUserId: actor.id })
      } catch (error) {
        ownershipToApiError(error)
      }
      // Immediate best-effort revocation; the durable outbox row removeMember wrote
      // in-transaction is the recovery path if this bump is lost (D-213).
      await revokeRealtimeAccess(deps.realtime?.cache, { siteId, subject: userId }, c.get('logger'))
      return c.body(null, 204)
    },
  )

  authed.get(
    '/sites/:site_id/keys',
    siteMembership(db),
    requireCapability('credentials:manage'),
    async (c) => {
      const { siteId } = c.get('membership')
      const keys = await listApiKeys(db, siteId)
      return c.json({ items: keys.map(keyJson) })
    },
  )

  authed.post(
    '/sites/:site_id/keys',
    siteMembership(db),
    requireCapability('credentials:manage'),
    async (c) => {
      const actor = c.get('user')
      const { siteId } = c.get('membership')
      const body = await readJson(c)
      const type = body['type']
      if (type !== 'tracking_write' && type !== 'private_read') {
        throw new ApiError('VALIDATION_FAILED', 'type must be tracking_write or private_read')
      }
      const name = typeof body['name'] === 'string' ? (body['name'] as string) : undefined
      const scopes = parseRequestedScopes(body['scopes'], type)
      const heldBy = parseRequestedHolder(body['held_by'], type)
      const created = await createApiKey(db, {
        siteId,
        type,
        createdByUserId: actor.id,
        ...(name === undefined ? {} : { name }),
        ...(scopes === undefined ? {} : { scopes }),
        ...(heldBy === undefined ? {} : { heldBy }),
      })
      return c.json(
        {
          id: created.id,
          type: created.type,
          key_prefix: created.keyPrefix,
          raw_token: created.rawToken,
        },
        201,
      )
    },
  )

  authed.delete(
    '/sites/:site_id/keys/:key_id',
    siteMembership(db),
    requireCapability('credentials:manage'),
    async (c) => {
      const actor = c.get('user')
      const { siteId } = c.get('membership')
      const keyId = c.req.param('key_id')
      const { revoked } = await revokeApiKey(db, { id: keyId, siteId, actorUserId: actor.id })
      if (!revoked) throw new ApiError('NOT_FOUND', 'No such key on this site')
      return c.body(null, 204)
    },
  )

  // Everything there is still something to do about: pending invitations, and
  // ones that expired recently enough to be worth resending. Accepted and revoked
  // rows stay out — those are settled, and neither of this screen's actions means
  // anything on them. The repository settles lapsed rows before reading, so no
  // row is reported `pending` past its expiry.
  authed.get(
    '/sites/:site_id/invites',
    siteMembership(db),
    requireCapability('team:manage'),
    async (c) => {
      const { siteId } = c.get('membership')
      const invites = await listSiteInvites(db, siteId)
      return c.json({ items: invites.map(inviteJson) })
    },
  )

  // Revocation is not idempotent by replay: a second DELETE 404s rather than
  // reporting a revocation that did not happen. The repository scopes the update
  // by both invite id and site id, so a manager cannot revoke another site's
  // invitation with an id they happen to hold.
  authed.delete(
    '/sites/:site_id/invites/:invite_id',
    siteMembership(db),
    requireCapability('team:manage'),
    async (c) => {
      const actor = c.get('user')
      const { siteId } = c.get('membership')
      const inviteId = c.req.param('invite_id')
      const { revoked } = await revokeInvite(db, { siteId, inviteId, actorUserId: actor.id })
      if (!revoked) throw new ApiError('NOT_FOUND', 'No pending invite with this id on this site')
      return c.body(null, 204)
    },
  )

  authed.post(
    '/sites/:site_id/invites',
    siteMembership(db),
    requireCapability('team:manage'),
    async (c) => {
      const actor = c.get('user')
      const { siteId } = c.get('membership')
      const body = await readJson(c)
      const email = body['email']
      const role = body['role']
      if (typeof email !== 'string' || email.length === 0) {
        throw new ApiError('VALIDATION_FAILED', 'An email is required')
      }
      if (!isSiteRole(role)) {
        throw new ApiError('VALIDATION_FAILED', 'A valid role is required')
      }

      const site = await getSiteBasics(db, siteId)
      if (!site) throw new ApiError('SITE_NOT_FOUND', 'No such site')

      let inviteId: string
      let rawToken: string
      try {
        const invite = await createInvite(db, {
          siteId,
          email,
          role: role satisfies SiteRole,
          invitedByUserId: actor.id,
        })
        inviteId = invite.inviteId
        rawToken = invite.rawToken
      } catch (error) {
        inviteToApiError(error)
      }

      await enqueueOutbox(db, {
        topic: EMAIL_OUTBOX_TOPIC,
        payload: buildInviteEmailPayload({
          to: email,
          acceptUrl: inviteAcceptUrl(rawToken),
          productName: env.PRODUCT_NAME,
          siteName: site.name,
        }) as unknown as Record<string, unknown>,
        // One notification per invitation. A retried request that replayed the
        // same invite row must not send a second email.
        idempotencyKey: `email.invite:${inviteId}`,
      })

      return c.json({ invite_id: inviteId }, 201)
    },
  )

  /**
   * Send an invitation again, with a new token and a new deadline.
   *
   * The same guards as creating one — `team:manage`, on this site — because it
   * mints an acceptance credential for an address, which is the same act.
   *
   * The outbox key is *not* the create route's `email.invite:{id}`.
   * `enqueueOutbox` is `ON CONFLICT (idempotency_key) DO NOTHING`, so reusing the
   * key would make every resend a silent no-op: a 200, no email, and a manager
   * who believes the invitee was written to. The key carries the new token's hash
   * prefix, which is new on every successful resend and therefore identifies this
   * resend event — while still de-duplicating an outbox retry of the same one. A
   * hash prefix discloses nothing the row does not already hold: the payload
   * beside it carries the raw token in the acceptance URL.
   */
  authed.post(
    '/sites/:site_id/invites/:invite_id/resend',
    siteMembership(db),
    requireCapability('team:manage'),
    async (c) => {
      const actor = c.get('user')
      const { siteId } = c.get('membership')
      const inviteId = c.req.param('invite_id')

      const site = await getSiteBasics(db, siteId)
      if (!site) throw new ApiError('SITE_NOT_FOUND', 'No such site')

      let resent
      try {
        resent = await resendInvite(db, { siteId, inviteId, actorUserId: actor.id })
      } catch (error) {
        inviteToApiError(error)
      }

      // Enqueued after the rotation commits, not inside it (enqueueOutbox does
      // not join the transaction). A crash in between leaves the old link dead
      // with no replacement mail sent - recovered by resending again, which
      // this endpoint exists to allow repeating.
      await enqueueOutbox(db, {
        topic: EMAIL_OUTBOX_TOPIC,
        payload: buildInviteEmailPayload({
          to: resent.email,
          acceptUrl: inviteAcceptUrl(resent.rawToken),
          productName: env.PRODUCT_NAME,
          siteName: site.name,
        }) as unknown as Record<string, unknown>,
        idempotencyKey: `email.invite:${resent.inviteId}:resend:${resent.tokenHashPrefix}`,
      })

      return c.json({
        invite_id: resent.inviteId,
        expires_at: resent.expiresAt.toISOString(),
        // A successful resend always leaves the invitation live, including one
        // that was expired a moment ago.
        status: 'pending',
      })
    },
  )

  /**
   * A site's tracker/ingest settings — the writer ADR-0064 F4 asked for.
   *
   * `site_ingest_settings` has existed since M5 and until now **no route wrote
   * any column of it**: the feature flags, the heatmap sampling fraction, the
   * heartbeat interval and the site timezone were settable only from the
   * repository, and `attributed_revenue` (ADR-0064 D4a) shipped into the same
   * hole — a switch the product describes as the customer's choice, that the
   * customer had no way to make. This closes it for the whole family rather than
   * for one flag, because the second field would otherwise be a second contract
   * change for no reason.
   *
   * `site:settings` (owner + admin), matching `PATCH /v1/sites/:site_id`: this
   * is the same class of administrative act as replacing the origin allowlist —
   * it configures how the site is measured, exposes no customer data and is not
   * destructive. Reading is gated the same way rather than left to any member,
   * because the read is the write's own form state and a viewer has nothing to
   * do with it.
   *
   * Deliberately session-only. An OAuth grant cannot reach these routes, so the
   * MCP surface gains no scope and `GRANT_WRITE_ALLOWLIST` gains no row
   * (ADR-0048): a settings toggle that changes what every visitor's browser does
   * is not a thing to hand to an agent on the strength of a scope name.
   */
  const ingestSettingsJson = (result: {
    settings: SiteTrackerSettings
    configVersion: number
  }) => ({
    config_version: result.configVersion,
    timezone: result.settings.timezone,
    redact_query_keys: [...result.settings.redactQueryKeys],
    interaction_sampling: result.settings.interactionSampling,
    heartbeat_interval_seconds: result.settings.heartbeatIntervalSeconds,
    features: { ...result.settings.features },
    attributed_revenue: result.settings.attributedRevenue,
  })

  authed.get(
    '/sites/:site_id/ingest-settings',
    siteMembership(db),
    requireCapability('site:settings'),
    async (c) => {
      const { siteId } = c.get('membership')
      const current = await readSiteIngestSettings(db, siteId)
      // The membership middleware already proved the site exists and the caller
      // is party to it, so a null here is a site deleted between the two reads.
      if (!current) throw new ApiError('SITE_NOT_FOUND', 'No such site')
      return c.json(ingestSettingsJson(current))
    },
  )

  authed.patch(
    '/sites/:site_id/ingest-settings',
    siteMembership(db),
    requireCapability('site:settings'),
    async (c) => {
      const { siteId } = c.get('membership')
      const body = await readJson(c)

      // Validation lives in the domain rather than here: every bound has a twin
      // in the published `TrackerConfig` contract or in a column CHECK, and a
      // value that got past the route and was refused by Postgres would reach
      // the caller as a 500 for what is a form mistake.
      const normalized = normalizeTrackerSettingsPatch(body, isValidTimezone)
      if (!normalized.ok) {
        validationFailed(
          'The ingest settings patch is not valid',
          normalized.issues.map((issue) => ({ field: issue.field, code: issue.code })),
        )
      }

      // The bump is inside this call, in the same transaction as the write
      // (ADR-0008). Nothing here has to remember it, which is the point.
      await upsertSiteIngestSettings(db, { siteId, ...normalized.patch })

      const current = await readSiteIngestSettings(db, siteId)
      if (!current) throw new ApiError('SITE_NOT_FOUND', 'No such site')
      return c.json(ingestSettingsJson(current))
    },
  )

  // Public-dashboard sharing config. Reading the settings is any member's right;
  // changing them mints/rotates a public share credential and exposes analytics
  // to the internet, so it is gated on `credentials:manage` (owner/admin) — the
  // same capability that governs the site's other shareable credentials.
  authed.get('/sites/:site_id/public-dashboard', siteMembership(db), async (c) => {
    const { siteId } = c.get('membership')
    const settings = await getPublicDashboardSettings(db, siteId)
    return c.json(publicDashboardJson(settings))
  })

  authed.put(
    '/sites/:site_id/public-dashboard',
    siteMembership(db),
    requireCapability('credentials:manage'),
    async (c) => {
      const actor = c.get('user')
      const { siteId } = c.get('membership')
      const body = await readJson(c)
      if (typeof body['enabled'] !== 'boolean') {
        throw new ApiError('VALIDATION_FAILED', 'enabled must be a boolean')
      }
      const rotateSlug = body['rotate_slug'] === true
      const settings = await updatePublicDashboardSettings(db, {
        siteId,
        actorUserId: actor.id,
        enabled: body['enabled'],
        ...publicSurfaceFlagsFrom(body),
        rotateSlug,
      })
      // Revoke outstanding public realtime tokens (subject `public`) when the new
      // state closes public realtime: master switch off, realtime surface off, or
      // the slug rotated (the old public address is dead). Over-revoking is safe.
      if (!settings.enabled || !settings.shareRealtime || rotateSlug) {
        await revokeRealtimeAccess(
          deps.realtime?.cache,
          { siteId, subject: 'public' },
          c.get('logger'),
        )
      }
      return c.json(publicDashboardJson(settings))
    },
  )

  /**
   * The authenticated routes an optional surface adds (`src/cloud-extension.ts`).
   *
   * Mounted last on `authed`, so every product route above keeps the position it
   * has always had and an extension can only add. It sits *inside* the subtree
   * because what it carries is a session (or a grant) acting on a membership: the
   * billing-transfer flow re-reads live membership through `siteMembership` and
   * re-auths the session, exactly as it did when these routes were declared in
   * this file.
   */
  if (deps.cloud?.businessRoutes) {
    authed.route(
      '/',
      deps.cloud.businessRoutes({
        db,
        env,
        ...(deps.realtime ? { realtime: deps.realtime } : {}),
      }),
    )
  }

  app.route('/', authed)
  return app
}
