import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { components, paths } from '@openanalytics/contracts'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The read-key surface, at the contract level (ADR-0042, M14 CP1).
 *
 * Contract before implementation: these assertions are written against
 * `openapi.yaml` and the client generated from it, before a single route
 * exists, so the WordPress plugin can be built against a mock.
 *
 * Two kinds of assertion, deliberately:
 *
 * - **Type-level pins** on the generated `paths`/`components`. Deleting a path,
 *   renaming a scope or narrowing a response shape fails `pnpm run typecheck`,
 *   not just this file — and a type pin cannot be satisfied by a comment that
 *   happens to contain the right words.
 * - **Block-scoped string assertions** on the YAML. Each one slices out the one
 *   path block it is about before looking inside it, because a whole-document
 *   `toContain` proves only that some other endpoint has the property.
 */

const SPEC_PATH = fileURLToPath(
  new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url),
)

let spec: string

beforeAll(async () => {
  spec = await readFile(SPEC_PATH, 'utf8')
})

/**
 * One path's YAML block: from its key line to the next top-level path key (or
 * the end of the `paths:` section). Without this, "the block declares
 * `privateApiKey`" would pass on a document where any other endpoint does.
 */
function pathBlock(path: string): string {
  const start = spec.indexOf(`\n  ${path}:\n`)
  expect(start, `${path} is not a documented path`).toBeGreaterThan(-1)
  const rest = spec.slice(start + 1)
  const end = rest.search(/\n {2}\/[^\n]*:\n|\n[a-z]/u)
  return end === -1 ? rest : rest.slice(0, end)
}

/** One component schema's YAML block, sliced the same way and for the reason. */
function schemaBlock(name: string): string {
  const start = spec.indexOf(`\n    ${name}:\n`)
  expect(start, `${name} is not a documented schema`).toBeGreaterThan(-1)
  const rest = spec.slice(start + 1)
  const end = rest.search(/\n {4}\S[^\n]*:\n/u)
  return end === -1 ? rest : rest.slice(0, end)
}

const ANALYTICS_READS = [
  'overview',
  'timeseries',
  'pages',
  'sources',
  'geography',
  'devices',
  'sessions',
] as const

describe('the read-key surface (ADR-0042)', () => {
  /**
   * The seven reads, pinned in the generated client.
   *
   * If a path leaves `openapi.yaml`, its entry in `paths` disappears, the
   * intersection with `keyof paths` collapses to `never`, and the literal below
   * stops being assignable. That is the whole point of writing it this way
   * rather than as a list of strings the compiler never looks at.
   */
  it('documents seven analytics reads plus the site context, keyed by the credential', () => {
    const documented: readonly (keyof paths)[] = [
      '/v1/read/site',
      '/v1/read/analytics/overview',
      '/v1/read/analytics/timeseries',
      '/v1/read/analytics/pages',
      '/v1/read/analytics/sources',
      '/v1/read/analytics/geography',
      '/v1/read/analytics/devices',
      '/v1/read/analytics/sessions',
    ]
    expect(documented).toHaveLength(8)
  })

  it('authenticates every read with the private key and nothing else', () => {
    for (const surface of ANALYTICS_READS) {
      const block = pathBlock(`/v1/read/analytics/${surface}`)
      expect(block, `${surface} must declare the bearer key`).toContain('- privateApiKey: []')
      // The document-level default is `sessionCookie`; a read that forgot its
      // own `security:` would inherit it and quietly become session-only.
      expect(block, `${surface} must not accept a session`).not.toContain('sessionCookie')
    }
    expect(pathBlock('/v1/read/site')).toContain('- privateApiKey: []')
  })

  /**
   * The key names the site (D5). A `site_id` in the path would be a second way
   * to name a site, and an oracle: "wrong site" and "no such site" would have to
   * be told apart by a caller holding a valid credential for neither.
   */
  it('takes no site id — the credential is the site', () => {
    for (const surface of ANALYTICS_READS) {
      const block = pathBlock(`/v1/read/analytics/${surface}`)
      expect(block, `${surface} must not take a site id`).not.toContain('site_id')
      expect(block).not.toContain('SiteIdPath')
    }
  })

  /**
   * The surfaces D4 excluded, asserted as absent rather than assumed absent —
   * the mirror of the test ADR-0024 D7 left on the public share surface.
   *
   * **`revenue` left this list on 2026-08-06** (ADR-0043 D5), and the reversal
   * is dated in ADR-0042's own file. It is not a key surface — no key can hold
   * `revenue:read` — but it is now a `/v1/read` path, so an assertion phrased as
   * "the string does not appear" no longer states what D4 meant. The three tests
   * below say it precisely instead: no key may reach it, and the row-level reads
   * are absent for everybody.
   */
  it('exposes no individual visitor, and no surface D4 excluded', () => {
    for (const excluded of ['recent-visitors', 'visitor']) {
      expect(spec, `${excluded} must not be readable here`).not.toContain(
        `/v1/read/analytics/${excluded}`,
      )
      expect(spec).not.toContain(`/v1/read/${excluded}`)
    }
  })

  it('keeps revenue off every key-accepting route', () => {
    // The precise form of what D4 meant, now that a revenue path exists. A key
    // cannot hold `revenue:read` (ADR-0043 D5), so the revenue routes must not
    // list `privateApiKey` as an accepted credential at all — and the contract,
    // not only the server, has to say so.
    for (const path of ['/v1/read/revenue/summary', '/v1/read/revenue/timeseries']) {
      const block = pathBlock(path)
      expect(block, `${path} must not accept a key`).not.toContain('privateApiKey')
      expect(block).toContain("oauthAccessToken: ['revenue:read']")
    }
  })

  it('keeps the person-only analytics reads off every key-accepting route', () => {
    // D4 kept these reports off the key surface. They are `/v1/read` paths now,
    // for an OAuth token or a session, so the precise form of D4 is the one
    // revenue uses: the contract must not list `privateApiKey` for them.
    for (const surface of ['custom-events', 'performance', 'funnel']) {
      const block = pathBlock(`/v1/read/analytics/${surface}`)
      expect(block, `${surface} must not accept a key`).not.toContain('privateApiKey')
      expect(block).toContain('- sessionCookie: []')
      expect(block).toContain("oauthAccessToken: ['analytics:read']")
      expect(block, `${surface} takes no site id`).not.toContain('SiteIdPath')
    }
  })

  it('keeps the row-level revenue reads off this surface entirely', () => {
    // `transactions` and `journey` carry per-customer rows. They are absent for
    // *both* credential kinds, which is a different statement from revenue being
    // owner-only, and it is the one that matters for an assistant's tool loop.
    expect(spec).not.toContain('/v1/read/revenue/transactions')
    expect(spec).not.toContain('/v1/read/analytics/revenue')
  })

  /**
   * D4: the key gets the **private** shapes, not ADR-0039's narrowed public
   * ones. Both directions, so neither surface can drift into the other.
   */
  it('serves the dashboard response shapes, not the narrowed public ones', () => {
    type KeyOverview =
      paths['/v1/read/analytics/overview']['get']['responses'][200]['content']['application/json']
    type DashboardOverview =
      paths['/v1/sites/{site_id}/analytics/overview']['get']['responses'][200]['content']['application/json']

    const fromKey: DashboardOverview = null as unknown as KeyOverview
    const fromDashboard: KeyOverview = null as unknown as DashboardOverview
    expect(fromKey).toBeNull()
    expect(fromDashboard).toBeNull()

    // And the public shape is NOT enough: it lost `meta.freshness` (D10) and
    // `billable_events`. If someone re-points the key read at the public schema
    // to save a line, this stops erroring and the test fails.
    // @ts-expect-error the narrowed public overview cannot satisfy a key read
    const fromPublic: KeyOverview =
      null as unknown as components['schemas']['PublicOverviewResponse']
    expect(fromPublic).toBeNull()
  })

  it('keeps the sessions layering watermark, which the public surface drops', () => {
    type KeySessions =
      paths['/v1/read/analytics/sessions']['get']['responses'][200]['content']['application/json']
    const layering: KeySessions['layering'] = null as unknown as KeySessions['layering']
    expect(layering).toBeNull()
  })

  it('answers a missing scope with 403 and a rate limit with 429 on every read', () => {
    for (const surface of ANALYTICS_READS) {
      const block = pathBlock(`/v1/read/analytics/${surface}`)
      // One 403 carrying both refusals since the open-core split: a missing scope
      // and a suspended site answer the same status, so the document names one
      // response for it (`MissingScopeOrSuspended`) rather than two that collide.
      expect(block, `${surface} needs the scope refusal`).toContain(
        "'403':\n          $ref: '#/components/responses/MissingScopeOrSuspended'",
      )
      expect(block, `${surface} needs the rate limit`).toContain(
        "'429':\n          $ref: '#/components/responses/RateLimited'",
      )
      // The suspension gate is the site's, not the door's (D5), and it rides the
      // same 403 asserted above — there is no separate payment status in the
      // product contract.
      expect(block, `${surface} must not carry a payment status`).not.toContain("'402':")
    }
  })
})

describe('scopes (ADR-0042 D3; ADR-0043 D4 and D5)', () => {
  /**
   * Every entry of an enum block, collected whole.
   *
   * Whole, and not matched with an alternation, because that is the hole
   * ADR-0043's implementation notes record: the first version of the holder
   * vocabulary test matched entries against `user|site`, so adding a third value
   * left it green. A list compared to a list cannot do that.
   */
  const enumOf = (name: string): (string | undefined)[] =>
    [...schemaBlock(name).matchAll(/^ {8}- '([^']+)'$/gmu)].map((match) => match[1])

  it('is one vocabulary of four strings, and the two M14 strings are unchanged', () => {
    const scopes: components['schemas']['ReadScope'][] = [
      'site:read',
      'analytics:read',
      'realtime:read',
      'revenue:read',
    ]
    expect(enumOf('ReadScope')).toEqual(scopes)

    // ADR-0042 D9's first condition, pinned rather than assumed: M16 grows the
    // vocabulary and does not respell it. A key minted under M14 carrying
    // `analytics:read` means today what it meant then.
    expect(enumOf('ReadScope').slice(0, 2)).toEqual(['site:read', 'analytics:read'])
  })

  it('narrows the key enum to a strict subset, and the two exclusions are the ones D5 names', () => {
    const keyScopes: components['schemas']['ApiKeyScope'][] = ['site:read', 'analytics:read']
    expect(enumOf('ApiKeyScope')).toEqual(keyScopes)

    // A subset relation, asserted as one: every key scope is a read scope, and
    // what is missing is exactly `realtime:read` and `revenue:read`. Written
    // this way rather than as a second literal list so that adding a fifth read
    // scope fails here — the new string is neither key-eligible nor named as an
    // exclusion until somebody decides which it is (D5's table).
    const read = enumOf('ReadScope')
    const key = enumOf('ApiKeyScope')
    expect(key.every((scope) => read.includes(scope))).toBe(true)
    expect(read.filter((scope) => !key.includes(scope))).toEqual(['realtime:read', 'revenue:read'])
  })

  it('reports scopes on every listed key, and accepts them when minting one', () => {
    type Summary = components['schemas']['ApiKeySummary']
    // Required, not optional: a `private_read` row stored before scopes existed
    // reads as `["site:read"]` rather than as an absent field (D3).
    const required: Summary['scopes'] = ['site:read']
    expect(required).toEqual(['site:read'])

    type CreateRequest = components['schemas']['CreateApiKeyRequest']
    // Optional on the way in — omitted means the minimum scope.
    const minted: CreateRequest = { type: 'private_read' }
    expect(minted.scopes).toBeUndefined()
  })

  /**
   * A rejected scope is `400`, and the document has to say so.
   *
   * This path documented `422` until M14 — as did the invite and checkout
   * creates — while the server has always mapped `VALIDATION_FAILED` to `400`
   * (`packages/contracts/src/errors.ts`). Nothing catches that class of drift:
   * `contracts:check` compares the generated client against the spec, and both
   * sides of that comparison were wrong together. Only `IMPORT_FAILED` and
   * `REVENUE_CREDENTIAL_REJECTED` map to `422`, and the spec's remaining `422`s
   * are exactly those.
   */
  it('documents a rejected create as 400, the status the server actually sends', () => {
    const block = pathBlock('/v1/sites/{site_id}/keys')
    expect(block).toContain("'400':\n          $ref: '#/components/responses/ValidationFailed'")
    expect(block).not.toContain("'422':")

    const stillLegitimate = [
      ...spec.matchAll(/'422':\n\s+\$ref: '#\/components\/responses\/(\w+)'/gu),
    ]
    expect(stillLegitimate.map((match) => match[1]).sort()).toEqual([
      'RevenueCredentialRejected',
      'RevenueCredentialRejected',
    ])
  })
})

describe('the install block (ADR-0042, D8)', () => {
  it('is required on the site context, with every member nullable', () => {
    type Context = components['schemas']['SiteReadContext']
    const install: Context['install'] = {
      tracking_key: null,
      script_url: null,
      collector_url: null,
    }
    expect(install).toEqual({ tracking_key: null, script_url: null, collector_url: null })

    const block = pathBlock('/v1/read/site')
    expect(block).toContain('SiteReadContext')
  })
})
