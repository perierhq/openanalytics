import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { components, paths } from '@openanalytics/contracts'
import { assistantConfigSchema } from '@openanalytics/domain'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * The assistant surface, at the contract level (ADR-0046).
 *
 * Two kinds of assertion, the shape `read-key-contract.test.ts` established:
 *
 * - **Type-level pins** on the generated `paths`/`components`. Deleting a path
 *   or narrowing a response fails `pnpm run typecheck`, not only this file, and
 *   a type pin cannot be satisfied by a comment that happens to contain the
 *   right words.
 * - **Block-scoped string assertions** on the YAML. Each one slices out the one
 *   block it is about before looking inside it, because a whole-document
 *   `toContain` proves only that some *other* endpoint has the property.
 *
 * `POST /v1/assistant/questions` is an event stream, and OpenAPI 3.1 has no
 * vocabulary for one — so it is documented the way `GET /v1/realtime/stream`
 * already is (a `200` whose schema is `type: string`, whose named events are
 * prose), and it is asserted here the way that endpoint already is.
 */

const SPEC_PATH = fileURLToPath(
  new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url),
)

let spec: string

beforeAll(async () => {
  spec = await readFile(SPEC_PATH, 'utf8')
})

function pathBlock(path: string): string {
  const start = spec.indexOf(`\n  ${path}:\n`)
  expect(start, `${path} is not a documented path`).toBeGreaterThan(-1)
  const rest = spec.slice(start + 1)
  const end = rest.search(/\n {2}\/[^\n]*:\n|\n[a-z]/u)
  return end === -1 ? rest : rest.slice(0, end)
}

function tagBlock(name: string): string {
  const start = spec.indexOf(`\n  - name: ${name}\n`)
  expect(start, `${name} is not a documented tag`).toBeGreaterThan(-1)
  const rest = spec.slice(start + 1)
  const end = rest.indexOf('\n  - name: ')
  return end === -1 ? rest : rest.slice(0, end)
}

function schemaBlock(name: string): string {
  const start = spec.indexOf(`\n    ${name}:\n`)
  expect(start, `${name} is not a documented schema`).toBeGreaterThan(-1)
  const rest = spec.slice(start + 1)
  const end = rest.search(/\n {4}\S[^\n]*:\n/u)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('the assistant’s two operations (ADR-0046 D2)', () => {
  it('documents exactly two paths, and no conversation store beside them', () => {
    const documented: readonly (keyof paths)[] = ['/v1/assistant/questions', '/v1/assistant/usage']
    expect(documented).toHaveLength(2)

    // D12: the server stores nothing but ledger rows. A conversation resource
    // would be a retention decision, an account-deletion target carrying free
    // text and a redaction story for data at rest — its own ADR, the day
    // somebody asks.
    for (const absent of [
      '/v1/assistant/conversations',
      '/v1/assistant/messages',
      '/v1/assistant/threads',
    ]) {
      expect(spec, `${absent} must not exist`).not.toContain(absent)
    }
  })

  it('is session-authenticated by inheriting the document default, on both', () => {
    for (const path of ['/v1/assistant/questions', '/v1/assistant/usage']) {
      const block = pathBlock(path)
      // The global scheme is `sessionCookie`, so a session-authenticated
      // operation declares nothing of its own; the ones that are *not* session
      // authenticated override it. A `security:` here would be one of those.
      expect(block, `${path} must not override the session default`).not.toContain('security:')
      expect(block).not.toContain('privateApiKey')
      expect(block).not.toContain('oauthAccessToken')
      // A key or a token gets `401` from the guard the subtree already has.
      expect(block).toContain("'401':\n          $ref: '#/components/responses/Unauthenticated'")
    }
  })

  it('takes no site parameter — the model selects sites through list_sites (D3)', () => {
    const block = pathBlock('/v1/assistant/questions')
    expect(block).not.toContain('SiteIdPath')
    expect(block).not.toContain('site_id:')
  })
})

describe('the answer is a stream, and the stream is the contract (D10)', () => {
  it('answers text/event-stream on the realtime precedent', () => {
    const block = pathBlock('/v1/assistant/questions')
    expect(block).toContain('text/event-stream:')
    // OpenAPI 3.1 cannot describe an event stream; the repository already
    // decided what to do about that, and this is the same decision.
    expect(block).toMatch(/text\/event-stream:\n\s+schema:\n\s+type: string/u)
    // The slice is real: the sibling operation is JSON, and a whole-document
    // `toContain` would have passed on both.
    expect(pathBlock('/v1/assistant/usage')).not.toContain('text/event-stream')
  })

  it('names all four events, and says an error carries no done', () => {
    const block = pathBlock('/v1/assistant/questions')
    for (const event of ['`trace`', '`delta`', '`done`', '`error`']) {
      expect(block, `${event} must be documented`).toContain(event)
    }
    expect(block).toMatch(/carrying `error` carries no `done`/u)
    // The trace is provenance inside the conversation and explicitly not
    // G-010's audit journal (D11).
    expect(block).toMatch(/not\*\* a\n\s+stored audit journal/u)
  })

  /**
   * The second half of that sentence, which nothing pinned until ADR-0051
   * landed and made it false.
   *
   * The paragraph used to end "no read path writes an audit row, and none may
   * before M18". The assertion above matches only the first clause, so the
   * published contract carried a claim about the *server's* behaviour that no
   * test could contradict — and G-010 shipping is precisely the event that turns
   * it into something untrue told to integrators. `contracts:check` cannot help
   * here: it compares the spec to the generated types, and prose generates
   * nothing.
   *
   * So the two facts that replaced it are pinned by their meaning, and the dead
   * deadline is pinned by its absence. What must stay true: an assistant
   * question writes nothing because a session is not a credential, and a
   * credential-authenticated read never writes one row per read.
   */
  it('describes the journal as it is now, not as the M18 deadline that passed', () => {
    const block = pathBlock('/v1/assistant/questions')
    expect(block).toMatch(/session is not a credential/u)
    expect(block).toMatch(/never one row per read/u)
    expect(block).toContain('ADR-0051')
    // The claim ADR-0051 falsified, and the deadline it retired.
    expect(block).not.toMatch(/no read path writes an audit row/u)
    expect(block).not.toMatch(/before M18/u)
  })

  it('keeps the pre-stream refusals as real statuses with real headers', () => {
    const block = pathBlock('/v1/assistant/questions')
    expect(block).toContain("'400':\n          $ref: '#/components/responses/ValidationFailed'")
    expect(block).toContain("'429':\n          $ref: '#/components/responses/RateLimited'")
    expect(block).toContain("'503':\n          $ref: '#/components/responses/AssistantUnavailable'")
  })

  it('tells the two 503s apart by code, because the two recoveries are different people’s', () => {
    const block = spec.slice(
      spec.indexOf('    AssistantUnavailable:'),
      spec.indexOf('    ImportInProgress:'),
    )
    expect(block).toContain('`SERVICE_UNAVAILABLE`')
    expect(block).toContain('`PROVIDER_UNAVAILABLE`')
  })
})

describe('the client may send exactly two roles (D7)', () => {
  it('enumerates user and assistant, and nothing else', () => {
    const roles: components['schemas']['AssistantMessage']['role'][] = ['user', 'assistant']
    expect(roles).toEqual(['user', 'assistant'])

    const block = schemaBlock('AssistantMessage')
    expect(block).toContain('enum: [user, assistant]')
    // `system` and `tool` are refused rather than stripped — the schema is the
    // first place that has to say so.
    expect(block).not.toContain('- system')
    expect(block).not.toContain('- tool')
    expect(block).toContain('additionalProperties: false')
  })

  it('bounds the conversation at the caps D7 names, in the caps’ own units', () => {
    const config = assistantConfigSchema.parse({})
    const request = schemaBlock('AssistantQuestionRequest')
    // The document's numbers are the defaults', so a schema-valid message is
    // never refused by the server for its size alone.
    expect(request).toContain(`maxItems: ${String(config.ASSISTANT_MAX_MESSAGES)}`)
    expect(request).toContain('minItems: 1')
    expect(schemaBlock('AssistantMessage')).toContain(
      `maxLength: ${String(config.ASSISTANT_MAX_MESSAGE_CHARS)}`,
    )
  })

  it('requires the array and nothing else', () => {
    const body: components['schemas']['AssistantQuestionRequest'] = {
      messages: [{ role: 'user', content: 'How did last week go?' }],
    }
    expect(body.messages).toHaveLength(1)
  })
})

describe('the usage report is the ledger’s own numbers (D5)', () => {
  it('requires every field, so a client never has to guess an absent one', () => {
    const usage: components['schemas']['AssistantUsage'] = {
      available: true,
      window_hours: 24,
      limit: 20,
      used: 3,
      remaining: 17,
      input_tokens: 900,
      output_tokens: 120,
      retry_after_seconds: null,
    }
    expect(usage.remaining).toBe(17)

    const block = schemaBlock('AssistantUsage')
    for (const field of [
      // `available` first, because it is the field a client must consult
      // before it draws anything: a deployment with no model provider answers
      // `SERVICE_UNAVAILABLE` to every question, and a control offered on top
      // of that is a button whose only outcome is an error.
      'available',
      'window_hours',
      'limit',
      'used',
      'remaining',
      'input_tokens',
      'output_tokens',
      'retry_after_seconds',
    ]) {
      expect(block, `${field} must be required`).toContain(`- ${field}`)
    }
  })

  it('reports the window rather than letting a client hardcode "per day"', () => {
    const block = schemaBlock('AssistantUsage')
    expect(block).toMatch(/rolling window, in hourly buckets/u)
    // `used + remaining` need not equal `limit` — a limit lowered under a spent
    // window is the case, and the document says which way it resolves.
    expect(block).toMatch(/`remaining` is `0`/u)
  })

  it('answers the AssistantUsage shape on the operation itself', () => {
    type Usage =
      paths['/v1/assistant/usage']['get']['responses'][200]['content']['application/json']
    const fromOperation: components['schemas']['AssistantUsage'] = null as unknown as Usage
    expect(fromOperation).toBeNull()
  })
})

describe('what the assistant may read is the tool table, verbatim (D3, widened by ADR-0049)', () => {
  it('names the twelve tools in the operation, and excludes customer rows and realtime', () => {
    const block = pathBlock('/v1/assistant/questions')
    for (const tool of [
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
      'subscription_summary',
      'subscription_timeseries',
    ]) {
      expect(block, `${tool} must be named`).toContain(tool)
    }
    // Stated as exclusions rather than merely absent, because "the string does
    // not appear" would also pass on a document that stopped mentioning them.
    // ADR-0049 opened the aggregates; the customer-row half of ADR-0043 D15 and
    // the realtime exclusion both still hold and the contract must keep saying so.
    expect(block).toMatch(/`transactions`, `journey`\) are not tools/u)
    expect(block).toMatch(/realtime is not a tool/u)
    expect(block).toMatch(/owner-only/u)
  })

  it('says the tool call re-runs the real gates, rather than resembling them', () => {
    const block = pathBlock('/v1/assistant/questions')
    expect(block).toMatch(/dispatched\s+as a real request against this API's own `\/v1\/read\/\*`/u)
    expect(block).toMatch(/live-membership\s+check/u)
    expect(block).toMatch(/`meta` block/u)
  })
})

/**
 * The `assistant` tag's prose, pinned.
 *
 * Every assertion above slices an operation or a schema, and the tag block is
 * neither — so when ADR-0049 widened the session ceiling, the tag went on
 * saying the old two-scope sentence for two days with a green suite. Nothing
 * here is new policy; it is the same claims the operation already pins, held
 * at the one place in the document that had no test looking at it.
 */
describe('the assistant tag says the same thing the operation does', () => {
  it('names the third scope, so the ceiling cannot silently revert to two', () => {
    const block = tagBlock('assistant')
    expect(block).toMatch(
      /a session carries\s+`site:read`, `analytics:read` and `revenue:read` and nothing else/u,
    )
    // The slice is real: the neighbouring tags are about other surfaces, and a
    // whole-document match would pass on `read-key`'s scope table instead.
    expect(tagBlock('widgets')).not.toContain('`analytics:read`')
  })

  it('attributes the revenue pair to the decision that opened it', () => {
    const block = tagBlock('assistant')
    expect(block).toMatch(/since ADR-0049 D3 — `revenue_summary` and\s+`revenue_timeseries`/u)
    expect(block).toMatch(/owner-only and carry no per-customer\s+dimension/u)
  })

  it('keeps realtime and the management reads out in words, not by omission', () => {
    const block = tagBlock('assistant')
    expect(block).toMatch(/\*\*Realtime is still deliberately absent\*\* \(ADR-0046 D3\)/u)
    // ADR-0048 added the event-definition tools to the MCP arm. The tag has to
    // keep saying they are not the assistant's, or the next widening reads as
    // though it had always included them.
    expect(block).toMatch(/`team_members`, `billing_usage` and the event-definition tools/u)
    expect(block).toMatch(/they would answer `403` on every call/u)
  })

  it('says the assistant is in the plan rather than a payment status (F-306)', () => {
    const block = tagBlock('assistant')
    expect(block).toMatch(/never a payment status/u)
    expect(block).toContain('F-306, 8 August 2026')
  })
})
