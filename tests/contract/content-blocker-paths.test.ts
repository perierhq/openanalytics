import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * No path the dashboard calls may look like an ad to a content blocker.
 *
 * Browser ad and content blockers drop a request whose URL has a segment such
 * as `/ads/` before it is sent: `fetch` throws `TypeError: Failed to fetch` and
 * the API never sees it. The Meta Ads card lived under
 * `/v1/sites/{site_id}/ads/...` and showed an error for most visitors while
 * every server-side test passed, because a test client has no blocker.
 *
 * So the names are checked here instead: every operation in `openapi.yaml`
 * that is not deprecated, and every `/v1/` path the web app spells out in its
 * source. A deprecated operation may keep such a path for server-side clients;
 * the dashboard must not call it.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SPEC_PATH = join(ROOT, 'packages/contracts/openapi/openapi.yaml')
const WEB_ROOT = join(ROOT, 'apps/web')

/** Segments the common filter lists block on their own. */
const BLOCKED_SEGMENTS = new Set([
  'ads',
  'ad',
  'adv',
  'advert',
  'adverts',
  'advertisement',
  'banner',
  'banners',
  'sponsor',
  'sponsored',
  'popup',
])
/** Substrings blocked wherever they appear in a segment. */
const BLOCKED_SUBSTRINGS = ['adserver', 'doubleclick']

/** The segments of `path` a blocker would match, or an empty list. */
function blockedSegments(path: string): string[] {
  const bare = path.split(/[?#]/u)[0] as string
  return bare
    .split('/')
    .map((segment) => segment.toLowerCase())
    .filter(
      (segment) =>
        BLOCKED_SEGMENTS.has(segment) ||
        BLOCKED_SUBSTRINGS.some((needle) => segment.includes(needle)),
    )
}

interface SpecOperation {
  readonly method: string
  readonly path: string
  readonly deprecated: boolean
  readonly description: string
}

/**
 * Every operation, its path and whether it is deprecated. A line reader, as in
 * `grant-arm-contract.test.ts`: the repository carries no YAML dependency and
 * the document's indentation is uniform.
 */
function readOperations(spec: string): SpecOperation[] {
  const operations: SpecOperation[] = []
  let path: string | null = null
  let method: string | null = null
  let deprecated = false
  let description: string[] = []
  let inDescription = false

  const flush = (): void => {
    if (path !== null && method !== null) {
      operations.push({
        method: method.toUpperCase(),
        path,
        deprecated,
        description: description.join(' ').replace(/\s+/gu, ' ').trim(),
      })
    }
    method = null
    deprecated = false
    description = []
    inDescription = false
  }

  for (const line of spec.split('\n')) {
    const pathMatch = /^ {2}(\/\S*):\s*$/u.exec(line)
    if (pathMatch) {
      flush()
      path = pathMatch[1] as string
      continue
    }
    if (/^\S/u.test(line)) {
      flush()
      path = null
      continue
    }
    const methodMatch = /^ {4}(get|post|put|patch|delete|head|options):\s*$/u.exec(line)
    if (methodMatch) {
      flush()
      method = methodMatch[1] as string
      continue
    }
    if (method === null) continue
    if (inDescription) {
      if (line.trim() === '' || /^ {8}/u.test(line)) {
        description.push(line.trim())
        continue
      }
      inDescription = false
    }
    if (/^ {6}deprecated:\s*true\s*$/u.test(line)) {
      deprecated = true
      continue
    }
    const descriptionMatch = /^ {6}description:\s*(.*)$/u.exec(line)
    if (descriptionMatch) {
      const rest = (descriptionMatch[1] as string).trim()
      if (rest === '|' || rest === '>') inDescription = true
      else description.push(rest.replace(/^'|'$/gu, ''))
    }
  }
  flush()
  return operations
}

/** Every non-test TypeScript source file of the web app, outside its build and dependencies. */
async function webSources(dir = WEB_ROOT): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await webSources(full)))
    else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) files.push(full)
  }
  return files
}

/**
 * The `/v1/...` paths a source file spells out, with each `${...}`
 * interpolation read as one `{param}` segment. Stops at the end of the
 * literal, a query string or whitespace.
 */
function v1Paths(source: string): string[] {
  const found: string[] = []
  let from = 0
  for (;;) {
    const start = source.indexOf('/v1/', from)
    if (start === -1) break
    let path = ''
    let i = start
    while (i < source.length) {
      const ch = source[i] as string
      if (ch === '$' && source[i + 1] === '{') {
        let depth = 0
        for (; i < source.length; i += 1) {
          if (source[i] === '{') depth += 1
          else if (source[i] === '}') {
            depth -= 1
            if (depth === 0) break
          }
        }
        path += '{param}'
        i += 1
        continue
      }
      if (/[`"'?#\s),;<>]/u.test(ch)) break
      path += ch
      i += 1
    }
    found.push(path)
    from = start + 4
  }
  return found
}

let operations: SpecOperation[]

beforeAll(async () => {
  operations = readOperations(await readFile(SPEC_PATH, 'utf8'))
})

describe('the blocker pattern itself', () => {
  it('matches a whole segment and the blocked substrings, and nothing else', () => {
    expect(blockedSegments('/v1/sites/{site_id}/ads/campaigns')).toEqual(['ads'])
    expect(blockedSegments('/v1/x/Banner?y=1')).toEqual(['banner'])
    expect(blockedSegments('/v1/my-adserver-proxy/x')).toEqual(['my-adserver-proxy'])
    expect(blockedSegments('/v1/sites/{site_id}/marketing/campaigns')).toEqual([])
    // A segment that merely contains "ad" is fine: `/admin`, `/read`, `/upload`.
    expect(blockedSegments('/v1/admin/read/upload/headers')).toEqual([])
  })

  it('reads an interpolated path out of a template literal', () => {
    const source =
      'api.get(`/v1/sites/${encodeURIComponent(siteId)}/ads/campaigns?${query}`, options)'
    expect(v1Paths(source)).toEqual(['/v1/sites/{param}/ads/campaigns'])
  })
})

describe('no browser-facing path looks like an ad to a content blocker', () => {
  it('reads the document at all', () => {
    expect(operations.length).toBeGreaterThan(40)
    expect(operations.filter((op) => !op.deprecated).length).toBeGreaterThan(40)
  })

  it('every operation that is not deprecated has a path no blocker drops', () => {
    const offending = operations
      .filter((op) => !op.deprecated && blockedSegments(op.path).length > 0)
      .map((op) => `${op.method} ${op.path}`)
    expect(offending).toEqual([])
  })

  it('every /v1/ path the web app builds has a path no blocker drops', async () => {
    const files = await webSources()
    const scanned: string[] = []
    const offending: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const path of v1Paths(source)) {
        scanned.push(path)
        if (blockedSegments(path).length > 0) offending.push(`${relative(ROOT, file)}: ${path}`)
      }
    }
    // The scanner found the client's paths: a reader that matched nothing
    // would pass vacuously.
    expect(scanned.length).toBeGreaterThan(80)
    expect(scanned).toContain('/v1/sites/{param}/revenue/connection')
    expect(offending).toEqual([])
  })
})

describe('the Meta Ads routes (the case that found this)', () => {
  const DEPRECATION =
    'Deprecated: browser content blockers drop URLs containing /ads/. Use /v1/sites/{site_id}/marketing/... instead; this path keeps working for server-side clients.'

  it('are served under /marketing/', () => {
    const live = operations
      .filter((op) => !op.deprecated && op.path.includes('/marketing/'))
      .map((op) => `${op.method} ${op.path}`)
      .sort()
    expect(live).toEqual([
      'DELETE /v1/sites/{site_id}/marketing/meta/connection',
      'GET /v1/sites/{site_id}/marketing/campaigns',
      'GET /v1/sites/{site_id}/marketing/meta/connection',
      'PUT /v1/sites/{site_id}/marketing/meta/connection',
    ])
  })

  it('keep the /ads/ paths, deprecated, for server-side clients', () => {
    const old = operations.filter((op) => op.path.includes('/ads/'))
    expect(old.map((op) => `${op.method} ${op.path}`).sort()).toEqual([
      'DELETE /v1/sites/{site_id}/ads/meta/connection',
      'GET /v1/sites/{site_id}/ads/campaigns',
      'GET /v1/sites/{site_id}/ads/meta/connection',
      'PUT /v1/sites/{site_id}/ads/meta/connection',
    ])
    for (const op of old) {
      expect(op.deprecated, `${op.method} ${op.path}`).toBe(true)
      expect(op.description, `${op.method} ${op.path}`).toContain(DEPRECATION)
    }
  })
})
