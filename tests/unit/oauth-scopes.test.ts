import { supportedOAuthScopes } from '@openanalytics/auth'
import {
  ACCOUNT_READ_SCOPES,
  GRANT_SCOPES,
  GRANT_SCOPE_DESCRIPTIONS,
  grantScopeDescription,
  KEY_SCOPES,
  OAUTH_ONLY_SCOPES,
  READ_SCOPES,
  READ_SCOPE_DESCRIPTIONS,
  WRITE_SCOPES,
  grantHasScope,
  grantScopesFromGrant,
  readScopesFromGrant,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * ADR-0048 D1: the second dictionary, and the three constructions its
 * separation from `READ_SCOPES` exists to protect. Every test here that pins
 * an *unchanged* value is deliberate — the decision was "READ_SCOPES does not
 * move", and this file is where moving it fails.
 */

describe('the grant-scope vocabulary (ADR-0048 D1)', () => {
  it('spells exactly the approved eleven', () => {
    expect(READ_SCOPES).toEqual(['site:read', 'analytics:read', 'realtime:read', 'revenue:read'])
    // `billing:read` was the second entry until the open-core split; it is
    // registered by the hosted surface now (tests/unit/cloud/oauth-scopes.test.ts).
    expect(ACCOUNT_READ_SCOPES).toEqual(['team:read'])
    expect(WRITE_SCOPES).toEqual([
      'sites:write',
      'funnels:write',
      'events:write',
      'widgets:write',
      'share:write',
      // Chart notes (migration 0050): add, edit and delete notes on a chart.
      'notes:write',
    ])
    expect(GRANT_SCOPES).toEqual([...READ_SCOPES, ...OAUTH_ONLY_SCOPES])
  })

  it('keeps keys at the two key scopes — a new scope must not become mintable', () => {
    // `KEY_SCOPES` is derived by filtering `READ_SCOPES`; the OAuth-only
    // dictionary never enters it, so this cannot drift without an edit to the
    // read dictionary itself — which is exactly the edit ADR-0048 forbids.
    expect(KEY_SCOPES).toEqual(['site:read', 'analytics:read'])
  })

  it('keeps the device exchange blind to every OAuth-only scope — the CLI does not move', () => {
    // The device token exchange narrows through `readScopesFromGrant`. If any
    // of the seven ever survives it, a CLI login has acquired a scope ADR-0048
    // says it must never hold.
    for (const scope of OAUTH_ONLY_SCOPES) {
      expect(
        readScopesFromGrant(`site:read ${scope}`),
        `${scope} must be dropped by the device narrowing`,
      ).toEqual(['site:read'])
    }
  })

  it('is entirely inside the authorization server’s ceiling', () => {
    for (const scope of GRANT_SCOPES) {
      expect(supportedOAuthScopes(), `${scope} must be grantable`).toContain(scope)
    }
  })

  describe('grantScopesFromGrant', () => {
    it('reads the full vocabulary, drops OIDC and unknown strings, dedups', () => {
      expect(
        grantScopesFromGrant('openid offline_access funnels:write analytics:read funnels:write x'),
      ).toEqual(['funnels:write', 'analytics:read'])
    })

    it('folds nothing in — the consent screen shows what was asked, not the implied minimum', () => {
      expect(grantScopesFromGrant('funnels:write')).toEqual(['funnels:write'])
      expect(grantScopesFromGrant('openid profile')).toEqual([])
      expect(grantScopesFromGrant(null)).toEqual([])
    })

    it('answers membership through grantHasScope', () => {
      expect(grantHasScope('openid team:read', 'team:read')).toBe(true)
      expect(grantHasScope('openid team:read', 'analytics:read')).toBe(false)
    })
  })

  describe('GRANT_SCOPE_DESCRIPTIONS', () => {
    it('has a human sentence for every grantable scope', () => {
      for (const scope of GRANT_SCOPES) {
        // Through the lookup, not the table: the vocabulary is extensible now, so
        // `Record<GrantScope, string>` cannot be exhaustive over it.
        expect(grantScopeDescription(scope), scope).toBeTruthy()
      }
    })

    it('repeats the read four verbatim — one vocabulary, not a fork', () => {
      for (const scope of READ_SCOPES) {
        expect(GRANT_SCOPE_DESCRIPTIONS[scope]).toBe(READ_SCOPE_DESCRIPTIONS[scope])
      }
    })

    it('says “email addresses” where emails are the thing being decided', () => {
      expect(GRANT_SCOPE_DESCRIPTIONS['team:read']).toContain('email addresses')
    })
  })
})
