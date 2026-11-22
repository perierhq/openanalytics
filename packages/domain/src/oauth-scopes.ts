import { READ_SCOPES, isReadScope, type ReadScope } from './read-scopes.ts'

/**
 * The scopes only an OAuth consent can confer (ADR-0048 D1).
 *
 * A second dictionary beside `READ_SCOPES`, not an extension of it, and the
 * separation is load-bearing three times over:
 *
 * - `KEY_SCOPES` is derived by filtering `READ_SCOPES`, so a scope that never
 *   enters that dictionary can never be minted onto a `private_read` key — by
 *   construction, not by remembering to extend an exclusion list.
 * - The device exchange narrows grants through `readScopesFromGrant`, which
 *   drops everything outside `READ_SCOPES`. The CLI therefore cannot acquire
 *   these scopes even if a device authorization asks for them — "the CLI stays
 *   exactly as it is" enforced by the same function that already enforces scope
 *   hygiene.
 * - `SESSION_SCOPES` on the read arm is a fixed literal; the assistant gains
 *   nothing.
 *
 * The only route to holding one of these is the authorization-code flow,
 * behind the consent screen — which is why their names are sentences a person
 * can decide about (`GRANT_SCOPE_DESCRIPTIONS` below).
 */

/** Account-level reads. `team:read` carries member emails, which is why it is
 * its own scope and never folded into `site:read`.
 *
 * `billing:read` was the second entry until the open-core split and is now
 * registered by `packages/domain/src/cloud/oauth-scopes.ts`: a deployment that
 * sells nothing has no plan, no usage window and no billing period, and a
 * consent screen offering to read them would be asking a person to approve
 * access to something the build cannot answer. */
export const ACCOUNT_READ_SCOPES = ['team:read'] as const

/**
 * The write scopes, Vercel/Stripe/Supabase-shaped (ADR-0048 D2): narrow,
 * additive, reversible. What each one covers — and pointedly does not — is
 * `GRANT_WRITE_ALLOWLIST`'s table; deletion, member management, credentials
 * and money appear in no scope at all. The one exception is `notes:write`,
 * which deletes a chart note: text people wrote by hand, not collected data.
 */
export const WRITE_SCOPES = [
  'sites:write',
  'funnels:write',
  'events:write',
  'widgets:write',
  'share:write',
  'notes:write',
] as const

export const OAUTH_ONLY_SCOPES = [...ACCOUNT_READ_SCOPES, ...WRITE_SCOPES] as const

export type OAuthOnlyScope = (typeof OAUTH_ONLY_SCOPES)[number]

declare const EXTENSION_GRANT_SCOPE: unique symbol

/**
 * A grant scope an optional surface contributed (`registerGrantScopes`).
 *
 * `ExtensionErrorCode`'s brand, applied to the consent vocabulary and for the
 * same reason: every *other* mention of a scope in this codebase is still
 * spell-checked against a closed union, and a surface that wants one of its own
 * has to come through `registerGrantScopes` and say what a human reads on the
 * consent screen when it appears there.
 */
export type ExtensionGrantScope = string & { readonly [EXTENSION_GRANT_SCOPE]: true }

const grantScopes: GrantScope[] = [...READ_SCOPES, ...OAUTH_ONLY_SCOPES]

/**
 * Every scope an OAuth grant may carry that this API can act on.
 *
 * A live array rather than a frozen snapshot: an optional surface registers its
 * scopes at import time, and this is the list the authorization server's
 * `scopes_supported`, the MCP resource document and the consent screen all read.
 * Nothing mutates it except `registerGrantScopes`.
 */
export const GRANT_SCOPES: readonly GrantScope[] = grantScopes

export type GrantScope = ReadScope | OAuthOnlyScope | ExtensionGrantScope

const KNOWN_GRANT_SCOPES = new Set<string>(grantScopes)

/**
 * How a human reads each grantable scope on the consent screen (ADR-0048 D1;
 * the one-dictionary rule of ADR-0043 D14).
 *
 * The read four repeat `READ_SCOPE_DESCRIPTIONS` verbatim — asserted equal by
 * a unit test rather than imported-and-spread, so this table is readable as
 * the complete consent vocabulary in one place. Write sentences say what the
 * client can *do*; `team:read`'s says *email addresses*, because that is the
 * thing being decided.
 */
const productScopeDescriptions = {
  'site:read': 'See which sites you have access to, and their install details',
  'analytics:read': 'Read your sites’ traffic reports',
  'realtime:read': 'Watch your sites’ live visitor stream',
  'revenue:read': 'Read your sites’ revenue — only on sites you own',
  'team:read': 'See who is on your sites’ teams, including their email addresses',
  'sites:write': 'Create sites, and rename them or change their reporting timezone',
  'funnels:write': 'Create, edit and archive funnels on your sites',
  'events:write': 'Create, publish and roll back event definitions on your sites',
  'widgets:write': 'Create, edit, enable and disable widgets on your sites',
  'share:write': 'Change what your public dashboards show, and rotate their links',
  'notes:write': 'Add, edit and delete notes on your sites’ charts',
} as const satisfies Record<ReadScope | OAuthOnlyScope, string>

const scopeDescriptions = new Map<string, string>(Object.entries(productScopeDescriptions))

export function isGrantScope(value: unknown): value is GrantScope {
  return isReadScope(value) || (typeof value === 'string' && KNOWN_GRANT_SCOPES.has(value))
}

/**
 * Declares the scopes an optional surface adds, with the sentence each one shows
 * on the consent screen.
 *
 * Idempotent, so importing the surface twice registers once. Re-registering a
 * *product* scope is refused rather than ignored: a surface that could rewrite
 * `team:read`'s sentence could change what a person believes they approved.
 */
export function registerGrantScopes(entries: Readonly<Record<string, string>>): void {
  for (const [scope, description] of Object.entries(entries)) {
    if (scope in productScopeDescriptions) {
      throw new Error(`grant scope "${scope}" is already part of the product vocabulary`)
    }
    if (KNOWN_GRANT_SCOPES.has(scope)) continue
    KNOWN_GRANT_SCOPES.add(scope)
    grantScopes.push(scope as ExtensionGrantScope)
    scopeDescriptions.set(scope, description)
  }
}

/**
 * The grant scopes a stored grant string actually names, for surfaces that can
 * act on all of them — the consent screen and the business subtree's grant arm.
 *
 * Unlike `readScopesFromGrant`, nothing is folded in: `site:read` is the read
 * surface's implied minimum, but a consent screen that *displays* an implied
 * scope the client did not ask for would be asking the human to approve more
 * than the request said. Unknown strings (the OIDC basics among them) drop out
 * exactly as they do everywhere else.
 */
export function grantScopesFromGrant(grant: string | null | undefined): GrantScope[] {
  if (!grant) return []
  const seen = new Set<GrantScope>()
  for (const part of grant.split(/[\s,]+/u)) {
    if (isGrantScope(part)) seen.add(part)
  }
  return [...seen]
}

export function grantHasScope(grant: string | null | undefined, required: GrantScope): boolean {
  return grantScopesFromGrant(grant).includes(required)
}

/**
 * How a human reads one grantable scope.
 *
 * A lookup rather than the table it used to be, because the vocabulary is now
 * extensible and `Record<GrantScope, string>` cannot be exhaustive over a brand.
 * The fallback is the scope's own name: unreachable for anything `isGrantScope`
 * admits — a registered scope registers its sentence in the same call — and a
 * raw name on a consent screen is the least misleading way to fail.
 */
export function grantScopeDescription(scope: GrantScope): string {
  return scopeDescriptions.get(scope) ?? scope
}

/** The product's own sentences, for the tests that assert them and for anything
 * that wants the vocabulary a bare build ships. Registered scopes are reached
 * through `grantScopeDescription`. */
export const GRANT_SCOPE_DESCRIPTIONS: Readonly<Record<ReadScope | OAuthOnlyScope, string>> =
  productScopeDescriptions
