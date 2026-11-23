import { ApiError } from '@openanalytics/contracts'
import {
  grantScopesFromGrant,
  oauthGrantCredentialRef,
  type GrantScope,
} from '@openanalytics/domain'
import { getAuthedUserById, resolveOAuthAccessToken, type Database } from '@openanalytics/postgres'
import type { Auth } from '@openanalytics/auth'
import { setRequestContextFields, type Logger } from '@openanalytics/observability'
import type { MiddlewareHandler } from 'hono'
import type { CredentialUseRecorder } from './credential-events.ts'
import type { ApiVariables } from './middleware.ts'
import { bearerToken } from './middleware.ts'

/**
 * The business subtree, opened to OAuth grants under a default-deny allowlist
 * (ADR-0048 D2).
 *
 * Everything on `/v1/*` behind this middleware has always required a browser
 * session. An MCP client holds a bearer, not a cookie, and the four read
 * scopes reach only `/v1/read/*` and `/mcp` — never a mutation. This is the
 * seam that lets a narrow, enumerated set of writes ride the *real* business
 * routes: no parallel `/v1/write/*` API, no duplicated membership or billing
 * gate, one place the rules live.
 *
 * The shape of the safety is a table, not a flag. A grant-authenticated
 * request proceeds only when `(method, path)` matches a row in
 * `GRANT_WRITE_ALLOWLIST` **and** the grant carries that row's scope;
 * everything else on the subtree answers `403` to a bearer. Site deletion,
 * member and invite management, API keys, billing movement, imports/exports,
 * event and widget *deletion* — none has a row, so none is reachable however
 * the grant's scope string reads. The Vercel/Stripe/Supabase line (no
 * deletion, no members, no money) is this table. The one deletion it carries
 * is a chart note's: hand-written text, not collected data.
 *
 * A matched request is then indistinguishable from a session request to every
 * downstream handler: `siteMembership` re-reads live membership,
 * `requireCapability` refuses a viewer exactly as it does in a browser, and the
 * billing/lifecycle gates run untouched. The scope is a ceiling, the role is
 * the authority, and they are intersected — a viewer with a write-scoped token
 * writes nothing (ADR-0042 D3, ADR-0043 D4).
 */

type Env = { Variables: ApiVariables }

export interface GrantAllowRow {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** The full `/v1/...` path template; `:seg` matches one non-empty segment. */
  readonly path: string
  /** The scope the grant must carry to pass. */
  readonly scope: GrantScope
  /**
   * For a mutation whose body must be narrowed below what the session handler
   * accepts (only `PATCH /sites`): the exact set of top-level keys a grant may
   * send. Any other key refuses the whole request — `domains` above all, an
   * empty allowlist meaning "accept events from anywhere" that a prompt
   * injection must never be able to open silently (ADR-0048 D2).
   */
  readonly bodyKeys?: readonly string[]
}

/**
 * The allowlist, exhaustively (ADR-0048 D2). This table *is* the review
 * surface: a new business route is invisible to a grant until it appears here,
 * which is the obligation the ADR names as the cost of the design.
 *
 * The definition **reads** carry `analytics:read`, not a bespoke scope:
 * reading a funnel's or widget's shape is part of analyzing the site the user
 * already consented to expose, and a scope that gated only metadata would be
 * consent-screen noise.
 */
const allowlist: GrantAllowRow[] = [
  // Sites — creation, and the harmless settings subset only.
  { method: 'POST', path: '/v1/sites', scope: 'sites:write' },
  {
    method: 'PATCH',
    path: '/v1/sites/:site',
    scope: 'sites:write',
    bodyKeys: ['name', 'reporting_timezone'],
  },

  // Funnels — create / edit / archive, and the list that analyzing them needs.
  { method: 'GET', path: '/v1/sites/:site/funnels', scope: 'analytics:read' },
  { method: 'POST', path: '/v1/sites/:site/funnels', scope: 'funnels:write' },
  { method: 'PATCH', path: '/v1/sites/:site/funnels/:funnel', scope: 'funnels:write' },
  { method: 'DELETE', path: '/v1/sites/:site/funnels/:funnel', scope: 'funnels:write' },

  // Mentions — the list only (the `list_mentions` tool). The settings routes
  // have no row: what this install sends to a third-party search service is
  // not something a grant may change.
  { method: 'GET', path: '/v1/sites/:site/mentions', scope: 'analytics:read' },

  // Chart notes — the list (`list_notes`) and create / edit / delete. The one
  // DELETE on this table that removes a row for good: a note is a line of text
  // people wrote by hand, and removing it touches no collected data, no
  // configuration a visitor depends on and no money.
  { method: 'GET', path: '/v1/sites/:site/notes', scope: 'analytics:read' },
  { method: 'POST', path: '/v1/sites/:site/notes', scope: 'notes:write' },
  { method: 'PATCH', path: '/v1/sites/:site/notes/:note', scope: 'notes:write' },
  { method: 'DELETE', path: '/v1/sites/:site/notes/:note', scope: 'notes:write' },

  // Meta Ads — the campaigns read only (the `ads_campaigns` tool), under the
  // scope every revenue read carries; the role check on the route still makes
  // it owner-only. The connection has no row: which token this install holds
  // for an ad account is not something a grant may read or change. The
  // `/ads/` path is the deprecated spelling of the same route, kept for
  // server-side clients (browser content blockers drop `/ads/`).
  { method: 'GET', path: '/v1/sites/:site/marketing/campaigns', scope: 'revenue:read' },
  { method: 'GET', path: '/v1/sites/:site/ads/campaigns', scope: 'revenue:read' },

  // Event definitions — create / draft / publish / rollback (publish is
  // reversible because rollback exists); no DELETE.
  { method: 'GET', path: '/v1/sites/:site/event-definitions', scope: 'analytics:read' },
  { method: 'GET', path: '/v1/sites/:site/event-definitions/:def', scope: 'analytics:read' },
  {
    method: 'GET',
    path: '/v1/sites/:site/event-definitions/:def/versions',
    scope: 'analytics:read',
  },
  {
    method: 'GET',
    path: '/v1/sites/:site/event-definitions/:def/versions/:version',
    scope: 'analytics:read',
  },
  { method: 'POST', path: '/v1/sites/:site/event-definitions', scope: 'events:write' },
  {
    method: 'POST',
    path: '/v1/sites/:site/event-definitions/:def/versions',
    scope: 'events:write',
  },
  {
    method: 'POST',
    path: '/v1/sites/:site/event-definitions/:def/publish',
    scope: 'events:write',
  },
  {
    method: 'POST',
    path: '/v1/sites/:site/event-definitions/:def/rollback',
    scope: 'events:write',
  },

  // Widgets — create / edit / enable-disable (the enable is a PATCH field); no
  // DELETE (the id is never reissued; `enabled: false` is the reversible form).
  { method: 'GET', path: '/v1/sites/:site/widgets', scope: 'analytics:read' },
  { method: 'GET', path: '/v1/sites/:site/widgets/:widget', scope: 'analytics:read' },
  { method: 'POST', path: '/v1/sites/:site/widgets', scope: 'widgets:write' },
  { method: 'PATCH', path: '/v1/sites/:site/widgets/:widget', scope: 'widgets:write' },

  // Public share — surface toggles + slug rotation (rotation is a revoke, the
  // safe direction).
  { method: 'GET', path: '/v1/sites/:site/public-dashboard', scope: 'analytics:read' },
  { method: 'PUT', path: '/v1/sites/:site/public-dashboard', scope: 'share:write' },

  // Team reads — carry emails, so their own scope (invite *management* is absent).
  { method: 'GET', path: '/v1/sites/:site/members', scope: 'team:read' },
  { method: 'GET', path: '/v1/sites/:site/invites', scope: 'team:read' },
]

/**
 * The allowlist this build enforces.
 *
 * A live view of the table above, because a surface a deployment mounts brings
 * its own routes and they are invisible to a grant until they appear here: the
 * hosted `GET /v1/billing/usage` row was declared inline until the open-core
 * split. Additive only — nothing removes a row — so the review surface the ADR
 * asks for is still one table plus whatever each registered surface declares
 * beside its own routes.
 */
export const GRANT_WRITE_ALLOWLIST: readonly GrantAllowRow[] = allowlist

/**
 * Declares the allowlist rows an optional surface adds. Idempotent on
 * `(method, path)`; a second row for one pair is refused rather than appended,
 * because which of the two governed a request would then depend on order.
 */
export function registerGrantAllowRows(rows: readonly GrantAllowRow[]): void {
  for (const row of rows) {
    const existing = allowlist.find(
      (candidate) => candidate.method === row.method && candidate.path === row.path,
    )
    if (existing === row) continue
    if (existing) throw new Error(`a grant allowlist row for ${row.method} ${row.path} exists`)
    allowlist.push(row)
    compiled.push({ row, match: pathMatcher(row.path) })
  }
}

/** Compiles a `:seg` template into an anchored matcher over concrete segments. */
function pathMatcher(template: string): RegExp {
  const source = template
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : escapeSegment(segment)))
    .join('/')
  return new RegExp(`^${source}$`, 'u')
}

function escapeSegment(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

const compiled = allowlist.map((row) => ({ row, match: pathMatcher(row.path) }))

/** The allowlist row for a request, or null when a grant may not make it. */
export function matchGrantRoute(method: string, path: string): GrantAllowRow | null {
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  for (const { row, match } of compiled) {
    if (row.method === method && match.test(normalized)) return row
  }
  return null
}

export interface PrincipalAuthDeps {
  readonly db: Database
  readonly auth: Auth
  /**
   * G-010's credential events (ADR-0051), for the writes a grant makes.
   *
   * The read surface has its own recorder over the same helper, and both are
   * needed: an MCP client that only ever creates funnels never touches
   * `/v1/read`, and a journal that watched only reads would report a credential
   * in daily use as never used.
   */
  readonly recordCredentialUse?: CredentialUseRecorder
  readonly logger?: Logger
}

/**
 * The business subtree's authenticator: a session as before, or an OAuth grant
 * held to the allowlist (ADR-0048 D2).
 *
 * A request with no `Authorization` header resolves exactly as `sessionAuth`
 * did — the cookie path is unchanged, byte for byte. A `Bearer` header is
 * resolved to a live grant and then gated: the `(method, path)` must be an
 * allowlist row and the grant must carry its scope, or the request is refused
 * before it reaches a handler. Only then is `user` populated (from the grant's
 * own `user_id`, fetched so the principal is complete) and a `grant` marker
 * set for the handlers that want to log which client acted.
 */
export function principalAuth(deps: PrincipalAuthDeps): MiddlewareHandler<Env> {
  return async (c, next) => {
    const header = c.req.header('authorization')

    // No header at all → the session arm, identical to `sessionAuth`. A
    // *failed* bearer must not fall back to a cookie, so the branch is the
    // header's presence, not whether it resolved.
    if (header === undefined) {
      const result = await deps.auth.api.getSession({ headers: c.req.raw.headers })
      if (!result?.user) {
        throw new ApiError('UNAUTHENTICATED', 'Authentication required')
      }
      c.set('user', {
        id: result.user.id,
        email: result.user.email,
        emailVerified: result.user.emailVerified === true,
        createdAt: new Date(result.user.createdAt),
      })
      c.set('session', { createdAt: new Date(result.session.createdAt) })
      await next()
      return
    }

    const token = bearerToken(header)
    if (token === null) {
      throw new ApiError('UNAUTHENTICATED', 'Authentication required')
    }
    const grant = await resolveOAuthAccessToken(deps.db, token)
    if (grant === null) {
      throw new ApiError('UNAUTHENTICATED', 'Authentication required')
    }

    // The default-deny gate. An unmatched route is `403`, not `404`: a grant is
    // a real principal that simply lacks this door, and the honest answer is
    // "you may not", the same answer a viewer gets for a capability.
    const row = matchGrantRoute(c.req.method, c.req.path)
    if (row === null) {
      throw new ApiError('FORBIDDEN', 'This application is not permitted to perform that operation')
    }
    const scopes = grantScopesFromGrant(grant.scopes)
    if (!scopes.includes(row.scope)) {
      throw new ApiError(
        'FORBIDDEN',
        `This application's authorization does not include the ${row.scope} scope`,
      )
    }

    // Body narrowing, where a grant may send fewer fields than a session
    // (only `PATCH /sites`). Enforced before the handler so a disallowed field
    // — `domains` above all — never reaches the code that would act on it. A
    // body that will not parse is left to the handler's own validation.
    if (row.bodyKeys !== undefined) {
      const allowed = new Set(row.bodyKeys)
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        body = undefined
      }
      if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
        const offending = Object.keys(body).filter((key) => !allowed.has(key))
        if (offending.length > 0) {
          throw new ApiError(
            'FORBIDDEN',
            `This application may only change ${row.bodyKeys.join(' and ')} on a site; it may not set ${offending.join(', ')}`,
          )
        }
      }
    }

    const user = await getAuthedUserById(deps.db, grant.userId)
    if (user === null) {
      // The grant's user was deleted between issuance and now.
      throw new ApiError('UNAUTHENTICATED', 'Authentication required')
    }
    c.set('user', user)
    // A grant has no session, so nothing re-auth-gated is reachable — and it is
    // not, since no such route has an allowlist row. Epoch-0 makes any
    // `isRecentReauth` check that somehow ran fail closed.
    c.set('session', { createdAt: new Date(0) })
    c.set('grant', { clientId: grant.clientId, grantId: grant.id, scopes })

    // The grant journal (ADR-0048 D5, delivered by ADR-0051 D10). Merged into
    // the ambient request context rather than passed down, because the thing
    // that has to name the client is not this middleware — it is every log line
    // and every audit row the *handlers* produce, and threading a parameter
    // through them would have to be repeated at each new write.
    //
    // `c.set('grant', …)` above stays: it is the typed value a handler reads
    // when it needs to branch on the caller being an application. What was
    // missing until now was any reader at all, which is how D5's promise came to
    // be carried for a milestone without being kept.
    //
    // The *unscoped* setter, deliberately. The scoped one would end when this
    // middleware returns, and the one line that summarises a request —
    // `http_request` — is written after that, by the frame above.
    setRequestContextFields({ clientId: grant.clientId, grantId: grant.id })

    // The grant is a credential and this is a use of it (ADR-0051 D5). Keyed on
    // `(user, client)` rather than the token row, for the reason D6 gives.
    await deps.recordCredentialUse?.(c.req.raw, {
      kind: 'oauth_grant',
      ref: oauthGrantCredentialRef(grant.userId, grant.clientId),
      userId: grant.userId,
    })

    await next()
  }
}
