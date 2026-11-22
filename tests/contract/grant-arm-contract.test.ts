import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { GRANT_WRITE_ALLOWLIST } from '../../apps/api/src/http/grant-arm.ts'

/**
 * The grant arm, as the contract describes it (ADR-0048 D2).
 *
 * **This file exists because `pnpm contracts:check` structurally cannot catch
 * what it is about.** That check regenerates `api.ts` from the spec and
 * compares it to the committed copy, so it proves the *types* match the
 * document — and `openapi-typescript` emits nothing at all for `security`. A
 * spec that declared every business route open to an OAuth grant, or none of
 * them, would pass it either way. The drift it cannot see is exactly the drift
 * that matters here: the allowlist is the whole safety argument, and a contract
 * that misdescribes it is a contract that tells an integrator they may do
 * something the server will refuse — or, worse, that they may not do something
 * the server allows, which is how a permission surface stops being reviewed.
 *
 * So the two are compared directly: `GRANT_WRITE_ALLOWLIST` in
 * `apps/api/src/http/grant-arm.ts` against the `oauthAccessToken` entries in
 * `openapi.yaml`, on both method and scope, in both directions.
 */

const SPEC_PATH = fileURLToPath(
  new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url),
)

/** `:seg` and `{seg}` both become `*`, so the two spellings can be compared. */
function normalize(path: string): string {
  return path.replace(/\{[^}]+\}/gu, '*').replace(/:[^/]+/gu, '*')
}

interface SpecOperation {
  readonly method: string
  readonly path: string
  /** The scopes the `oauthAccessToken` entry names, or null when the operation
   * declares no such entry. */
  readonly oauthScopes: readonly string[] | null
  readonly schemes: readonly string[]
}

/**
 * Every operation's declared security, read off the document.
 *
 * A line reader rather than a YAML parse: this repository carries no YAML
 * dependency, the spec's indentation is uniform, and the shape being read is
 * three nesting levels deep. A malformed document would fail
 * `pnpm contracts:lint` long before it reached here.
 */
function readOperations(spec: string): SpecOperation[] {
  const operations: SpecOperation[] = []
  let path: string | null = null
  let method: string | null = null
  let schemes: { name: string; scopes: string[] }[] | null = null
  let collecting = false

  const flush = (): void => {
    if (path === null || method === null) return
    const found = schemes ?? []
    const oauth = found.find((entry) => entry.name === 'oauthAccessToken')
    operations.push({
      method: method.toUpperCase(),
      path,
      oauthScopes: oauth ? oauth.scopes : null,
      schemes: found.map((entry) => entry.name),
    })
    method = null
    schemes = null
    collecting = false
  }

  for (const line of spec.split('\n')) {
    const pathMatch = /^ {2}(\/\S*):\s*$/u.exec(line)
    if (pathMatch) {
      flush()
      path = pathMatch[1] as string
      continue
    }
    const methodMatch = /^ {4}(get|post|put|patch|delete):\s*$/u.exec(line)
    if (methodMatch) {
      flush()
      method = methodMatch[1] as string
      continue
    }
    if (collecting) {
      const entry = /^ {8}- (\w+):\s*(\[.*\])\s*$/u.exec(line)
      if (entry) {
        const raw = (entry[2] as string).slice(1, -1).trim()
        const scopes = raw === '' ? [] : raw.split(',').map((s) => s.trim().replace(/^'|'$/gu, ''))
        ;(schemes as { name: string; scopes: string[] }[]).push({
          name: entry[1] as string,
          scopes,
        })
        continue
      }
      collecting = false
    }
    if (/^ {6}security:\s*\[\]\s*$/u.test(line)) {
      schemes = []
      continue
    }
    if (/^ {6}security:\s*$/u.test(line)) {
      schemes = []
      collecting = true
      continue
    }
  }
  flush()
  return operations
}

let operations: SpecOperation[]

beforeAll(async () => {
  operations = readOperations(await readFile(SPEC_PATH, 'utf8'))
})

/** The business routes only — `/v1/read/*` and `/mcp` are the read arm, which
 * the allowlist has nothing to say about. */
const isBusinessPath = (path: string): boolean =>
  path.startsWith('/v1/') && !path.startsWith('/v1/read/')

describe('the contract describes the grant allowlist exactly (ADR-0048 D2)', () => {
  it('reads the document at all — the parser is not silently finding nothing', () => {
    // A line reader that matched nothing would make every assertion below
    // vacuously true, which is the failure mode this whole file was written to
    // avoid in someone else's test.
    expect(operations.length).toBeGreaterThan(40)
    expect(
      operations.filter((op) => op.oauthScopes !== null).length,
      'some operations declare oauthAccessToken',
    ).toBeGreaterThan(20)
  })

  it('marks every allowlisted business route, and only those', () => {
    const fromServer = new Set(
      GRANT_WRITE_ALLOWLIST.map((row) => `${row.method} ${normalize(row.path)}`),
    )
    const fromSpec = new Set(
      operations
        .filter((op) => op.oauthScopes !== null && isBusinessPath(op.path))
        .map((op) => `${op.method} ${normalize(op.path)}`),
    )
    // Sorted arrays rather than set equality, so a failure prints which route
    // is on which side.
    expect([...fromSpec].sort()).toEqual([...fromServer].sort())
  })

  it('names the same scope the server checks, route by route', () => {
    for (const row of GRANT_WRITE_ALLOWLIST) {
      const key = `${row.method} ${normalize(row.path)}`
      const op = operations.find(
        (candidate) => `${candidate.method} ${normalize(candidate.path)}` === key,
      )
      expect(op, `${key} is documented`).toBeDefined()
      // One scope per entry: a document naming two would read as "either will
      // do", which is not what the middleware does.
      expect(op?.oauthScopes, key).toEqual([row.scope])
    }
  })

  it('keeps the browser session on every allowlisted route beside the token', () => {
    // The grant arm *adds* a credential; it never replaces one. An operation
    // that listed only `oauthAccessToken` would be telling the dashboard it had
    // lost a route it still has.
    for (const op of operations) {
      if (op.oauthScopes === null || !isBusinessPath(op.path)) continue
      expect(op.schemes, `${op.method} ${op.path}`).toContain('sessionCookie')
    }
  })

  it('leaves the never-writable operations unmarked', () => {
    // The named refusals of D2, spelled out rather than inferred from the
    // absence above: deletion, member and invite management, and credentials.
    const unmarked = [
      ['DELETE', '/v1/sites/{site_id}'],
      ['PATCH', '/v1/sites/{site_id}/members/{user_id}'],
      ['DELETE', '/v1/sites/{site_id}/members/{user_id}'],
      ['POST', '/v1/sites/{site_id}/invites'],
      ['POST', '/v1/sites/{site_id}/keys'],
      ['DELETE', '/v1/sites/{site_id}/widgets/{widget_id}'],
      ['DELETE', '/v1/sites/{site_id}/event-definitions/{definition_id}'],
      ['DELETE', '/v1/me'],
      ['POST', '/v1/assistant/questions'],
    ] as const

    for (const [method, path] of unmarked) {
      const op = operations.find(
        (candidate) => candidate.method === method && candidate.path === path,
      )
      expect(op, `${method} ${path} is a documented operation`).toBeDefined()
      expect(op?.oauthScopes, `${method} ${path} must not be reachable by a grant`).toBeNull()
    }
  })
})

describe('the four read scopes reach the read arm, and the seven grant scopes do not', () => {
  it('declares every scope the security scheme offers', async () => {
    const spec = await readFile(SPEC_PATH, 'utf8')
    const start = spec.indexOf('    oauthAccessToken:')
    const scopesAt = spec.indexOf('          scopes:', start)
    const block = spec.slice(scopesAt, spec.indexOf('\n    realtimeBearer:', scopesAt))
    // The whole vocabulary, in the order `GRANT_SCOPES` builds it. A scope the
    // scheme does not declare cannot be named by any operation, so an omission
    // here silently removes a route's documented authorization.
    const declared = [...block.matchAll(/^ {12}'([^']+)':/gmu)].map((match) => match[1])
    expect(declared).toEqual([
      'site:read',
      'analytics:read',
      'realtime:read',
      'revenue:read',
      'team:read',
      // `billing:read` was here until the open-core split; it is declared by the
      // cloud document, which is where the route it guards is.
      'sites:write',
      'funnels:write',
      'events:write',
      'widgets:write',
      'share:write',
      'notes:write',
    ])
  })

  it('gives the revenue reads the session cookie ADR-0049 D3 granted them', () => {
    for (const path of ['/v1/read/revenue/summary', '/v1/read/revenue/timeseries']) {
      const op = operations.find((candidate) => candidate.path === path)
      expect(op?.schemes, path).toEqual(['sessionCookie', 'oauthAccessToken'])
      expect(op?.oauthScopes, path).toEqual(['revenue:read'])
      // Still not a private key: a key resolves to a site and has no
      // membership, so the owner-only capability would have nothing to check.
      expect(op?.schemes, path).not.toContain('privateApiKey')
    }
  })
})
