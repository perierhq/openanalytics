import { describe, expect, it } from 'vitest'
import {
  MCP_TOOLS,
  buildToolRequest,
  inputSchema,
  isReadOnlyTool,
  toolArgumentRefusal,
  type McpToolDefinition,
} from '../../apps/api/src/http/mcp.ts'
import { ASSISTANT_TOOLS } from '../../apps/api/src/http/assistant.ts'
import { SITE_HEADER } from '../../apps/api/src/http/read-key.ts'

/**
 * ADR-0048 CP3: the tool table's write machinery — method, `{token}` path
 * substitution, JSON body, and the read-only annotation that keeps writes off
 * the assistant. The read-tool behaviour is pinned elsewhere and is unchanged;
 * this file is the write half.
 */

const ORIGIN = 'https://api.test'
const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'

const tool = (name: string): McpToolDefinition => {
  const found = MCP_TOOLS.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

const build = (name: string, args: Record<string, unknown>) =>
  buildToolRequest({
    tool: tool(name),
    args,
    resourceUrl: ORIGIN,
    credential: { header: 'authorization', value: 'Bearer tok' },
  })

describe('write tools carry method, path tokens and a JSON body', () => {
  it('create_site is a POST with a JSON body and no site header', async () => {
    const req = build('create_site', { body: { slug: 'acme', name: 'Acme' } })
    expect(req.method).toBe('POST')
    expect(new URL(req.url).pathname).toBe('/v1/sites')
    expect(req.headers.get('content-type')).toBe('application/json')
    expect(req.headers.get(SITE_HEADER)).toBeNull()
    expect(await req.json()).toEqual({ slug: 'acme', name: 'Acme' })
  })

  it('update_funnel substitutes both path tokens and URL-encodes them', () => {
    const req = build('update_funnel', {
      site_id: SITE,
      funnel_id: 'f/../x',
      body: { name: 'Renamed' },
    })
    expect(req.method).toBe('PATCH')
    // The funnel id is encoded, so a value can never escape its path segment.
    expect(new URL(req.url).pathname).toBe(`/v1/sites/${SITE}/funnels/f%2F..%2Fx`)
  })

  it('archive_funnel is a DELETE with no body', async () => {
    const req = build('archive_funnel', { site_id: SITE, funnel_id: 'f1' })
    expect(req.method).toBe('DELETE')
    expect(req.headers.get('content-type')).toBeNull()
    expect(await req.text()).toBe('')
  })

  it('update_share_settings is a PUT to the public-dashboard route', async () => {
    const req = build('update_share_settings', {
      site_id: SITE,
      body: { enabled: true, share_overview: true, rotate_slug: true },
    })
    expect(req.method).toBe('PUT')
    expect(new URL(req.url).pathname).toBe(`/v1/sites/${SITE}/public-dashboard`)
    expect(await req.json()).toEqual({ enabled: true, share_overview: true, rotate_slug: true })
  })
})

describe('the input schema of a write tool', () => {
  it('requires the path tokens and the body', () => {
    const schema = inputSchema(tool('update_funnel')) as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(schema.properties).toHaveProperty('site_id')
    expect(schema.properties).toHaveProperty('funnel_id')
    expect(schema.properties).toHaveProperty('body')
    expect(schema.required).toEqual(expect.arrayContaining(['site_id', 'funnel_id', 'body']))
  })

  it('exposes the body’s own schema so the model sees real field types', () => {
    const schema = inputSchema(tool('create_funnel')) as {
      properties: { body: { properties: { steps: { type: string } } } }
    }
    // steps is an array of strings, not a flat string param.
    expect(schema.properties.body.properties.steps.type).toBe('array')
  })
})

describe('argument refusals name what is missing', () => {
  it('flags a missing path token', () => {
    expect(toolArgumentRefusal(tool('update_funnel'), { site_id: SITE, body: {} })).toContain(
      'funnel_id',
    )
  })

  it('flags a missing body', () => {
    expect(toolArgumentRefusal(tool('create_site'), {})).toContain('body')
  })

  it('passes a complete write call', () => {
    expect(toolArgumentRefusal(tool('create_site'), { body: { slug: 'a', name: 'b' } })).toBeNull()
  })
})

/**
 * The roster, as a literal list — the pin the previous version of this file did
 * not have.
 *
 * What was here before derived "the writes" from `method !== 'GET'` and then
 * asserted those rows were annotated as writes. That is circular twice over: it
 * described the annotation from the field the annotation exists to describe, and
 * it only ever looked at rows that *were* in the table. So it stayed green while
 * five of ADR-0048 D3's nineteen tools were missing — including all four that
 * `events:write` reaches, which is how a scope shipped to a consent screen with
 * nothing behind it.
 *
 * A literal list is the only shape that can fail on an absence. Adding a tool
 * must break this file; that is the point, and the diff is where the reviewer
 * decides whether the row belongs on the read side or the write side.
 */
const EXPECTED_READ_TOOLS = [
  'list_sites',
  'site_overview',
  'site_timeseries',
  'top_pages',
  'top_sources',
  'geography',
  'devices',
  'sessions',
  'custom_events',
  'performance',
  'funnel_results',
  'revenue_summary',
  'revenue_timeseries',
  'site_install',
  'team_members',
  // `billing_usage` was here until the open-core split. It is registered by the
  // surface that serves `/v1/billing/usage` (`apps/api/src/cloud/mcp.ts`), so this
  // roster is what a build with no such surface advertises.
  'list_funnels',
  'list_event_definitions',
  'list_widgets',
  'share_settings',
] as const

const EXPECTED_WRITE_TOOLS = [
  'create_site',
  'update_site',
  'create_funnel',
  'update_funnel',
  'archive_funnel',
  'create_event_definition',
  'draft_event_version',
  'publish_event_definition',
  'rollback_event_definition',
  'create_widget',
  'update_widget',
  'update_share_settings',
] as const

describe('the tool roster is pinned by name, not derived', () => {
  it('is exactly these tools, in this order', () => {
    // Order too: `tools/list` serves the table as written, and the reads
    // preceding the writes is the shape of the file, so a row that moved
    // between the halves should show up as a diff here rather than be hidden
    // by a set comparison.
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([...EXPECTED_READ_TOOLS, ...EXPECTED_WRITE_TOOLS])
  })

  it('covers every tool ADR-0048 D3 named — nineteen, on top of the nine that predate it', () => {
    // Ten analytics and revenue reads predate the permission model (they are
    // the assistant's catalogue); D3 added seven management reads and twelve
    // writes. 10 + 19 = 29 was the arithmetic until the open-core split moved
    // `billing_usage` out to the surface that serves it, so a build with no such
    // surface advertised 28. The person-only analytics reads (`custom_events`,
    // `performance`, `funnel_results`) make it 31.
    expect(MCP_TOOLS).toHaveLength(31)
    expect(EXPECTED_READ_TOOLS.length + EXPECTED_WRITE_TOOLS.length).toBe(31)
    // The five that were missing until the roster was pinned. Named
    // individually so a regression says which one went.
    for (const name of [
      'list_event_definitions',
      'create_event_definition',
      'draft_event_version',
      'publish_event_definition',
      'rollback_event_definition',
    ]) {
      expect(
        MCP_TOOLS.map((t) => t.name),
        `${name} is an ADR-0048 D3 tool`,
      ).toContain(name)
    }
  })
})

describe('annotations divide reads from writes', () => {
  it('every named write tool is annotated not-read-only and non-destructive', () => {
    for (const name of EXPECTED_WRITE_TOOLS) {
      const t = tool(name)
      expect(t.method, `${name} is a write and must carry a method`).not.toBe(undefined)
      expect(t.method, `${name} is a write`).not.toBe('GET')
      expect(isReadOnlyTool(t), `${name} must not be read-only`).toBe(false)
      expect(t.annotations?.destructiveHint, `${name} exposes nothing destructive`).toBe(false)
    }
  })

  it('every named read tool is read-only and dispatches with GET', () => {
    for (const name of EXPECTED_READ_TOOLS) {
      const t = tool(name)
      expect(t.method ?? 'GET', `${name} is a read`).toBe('GET')
      expect(isReadOnlyTool(t), `${name} is a read`).toBe(true)
    }
  })

  it('the write scopes each reach at least one tool — a scope nobody can use is worse than a missing one', () => {
    // The defect this file missed: `events:write` was on both discovery
    // documents and on the consent screen, and no row could spend it. A human
    // approving a permission that grants nothing is the failure, not the gap.
    const writeScopes = MCP_TOOLS.filter((t) => !isReadOnlyTool(t)).map((t) => t.scope)
    for (const scope of [
      'sites:write',
      'funnels:write',
      'events:write',
      'widgets:write',
      'share:write',
    ] as const) {
      expect(writeScopes, `${scope} must be reachable from some tool`).toContain(scope)
    }
  })

  it('no write tool dispatches to the /read/ arm — writes ride the business routes', () => {
    for (const t of MCP_TOOLS) {
      if (!isReadOnlyTool(t)) {
        expect(
          t.path.startsWith('/read/'),
          `${t.name} is a write and must not be a /read path`,
        ).toBe(false)
      }
    }
  })
})

/**
 * The assistant's slice of the one catalogue (ADR-0046 D3, ADR-0048 D3).
 *
 * The filter is **two** conditions — `isReadOnlyTool` *and* an explicit
 * analytics/revenue path allowlist — and the second is the one that is easy to
 * lose. A session principal carries `site:read`, `analytics:read` and (since
 * ADR-0049) `revenue:read`, and nothing else: `team_members` or `billing_usage`
 * reaching this catalogue would put a tool in front of the model that answers
 * `403` every time it is called, and `list_event_definitions` would do the same.
 *
 * So the roster is pinned as a literal list rather than re-derived. A test that
 * recomputed the filter would agree with any filter, including a widened one.
 */
describe('the assistant sees the analytics and revenue reads, and nothing else', () => {
  it('is exactly these ten tools', () => {
    expect(ASSISTANT_TOOLS.map((t) => t.name)).toEqual([
      'list_sites',
      'site_overview',
      'site_timeseries',
      'top_pages',
      'top_sources',
      'geography',
      'devices',
      'sessions',
      'revenue_summary',
      'revenue_timeseries',
    ])
  })

  it('excludes the management reads the session principal carries no scope for', () => {
    const names = ASSISTANT_TOOLS.map((t) => t.name)
    // Read-only, so `isReadOnlyTool` alone would let all four through — these
    // are refused by the path allowlist, which is why it exists.
    for (const name of ['team_members', 'site_install', 'share_settings']) {
      expect(names, `${name} must not reach the assistant`).not.toContain(name)
    }
  })

  it('excludes the person-only analytics reads MCP gained after ADR-0046 D3', () => {
    const names = ASSISTANT_TOOLS.map((t) => t.name)
    for (const name of ['custom_events', 'performance', 'funnel_results']) {
      expect(names, `${name} was not decided for the assistant`).not.toContain(name)
    }
  })

  it('excludes every event-definition tool, read and write alike (ADR-0048 D3)', () => {
    const names = ASSISTANT_TOOLS.map((t) => t.name)
    for (const name of [
      'list_event_definitions',
      'create_event_definition',
      'draft_event_version',
      'publish_event_definition',
      'rollback_event_definition',
    ]) {
      expect(names, `${name} must not reach the assistant`).not.toContain(name)
    }
  })
})
