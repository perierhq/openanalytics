import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '@openanalytics/contracts'
import {
  REVENUE_JOURNEY_DISPLAY_KINDS,
  SUPPORTED_REPORTING_CURRENCIES,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

const SPEC_PATH = fileURLToPath(
  new URL('../../packages/contracts/openapi/openapi.yaml', import.meta.url),
)

/**
 * The revenue read contract (ADR-0033, D7). Milestone 12 Checkpoint 5.
 *
 * The contract is edited before the implementation (AGENTS.md), so this asserts
 * the document itself. Four of its claims are worth a test rather than a review
 * comment, because each is a property the frontend generates code against:
 *
 * - every revenue response's `meta` carries the connection block, which is the
 *   only thing that makes an empty response interpretable;
 * - `reporting` and `conversion` on a transaction are **nullable**, so an
 *   unconverted amount cannot be typed as a number a client would add up;
 * - the pagination envelope is `{ items, next_cursor, has_more }` and the limit
 *   bound matches the contract package's own constant;
 * - the `display.kind` vocabulary in the document equals the one the renderer
 *   can actually produce — a frontend switch built from a stale enum is a
 *   silent rendering gap.
 */

async function spec(): Promise<string> {
  return await readFile(SPEC_PATH, 'utf8')
}

function schemaBlock(text: string, name: string): string {
  const marker = `\n    ${name}:\n`
  const at = text.indexOf(marker)
  expect(at, `openapi.yaml is missing schema ${name}`).toBeGreaterThan(-1)
  const rest = text.slice(at + marker.length)
  const next = /\n {4}[A-Za-z][A-Za-z0-9]*:\n/u.exec(rest)
  return rest.slice(0, next?.index ?? rest.length)
}

function pathBlock(text: string, path: string): string {
  const marker = `\n  ${path}:\n`
  const at = text.indexOf(marker)
  expect(at, `openapi.yaml is missing path ${path}`).toBeGreaterThan(-1)
  const rest = text.slice(at + marker.length)
  const next = /\n {2}\/v1\//u.exec(rest)
  return rest.slice(0, next?.index ?? rest.length)
}

const PATHS = [
  '/v1/sites/{site_id}/revenue/summary',
  '/v1/sites/{site_id}/revenue/timeseries',
  '/v1/sites/{site_id}/revenue/transactions',
  '/v1/sites/{site_id}/revenue/transactions/{object_id}/journey',
] as const

describe('the four revenue read paths', () => {
  it('declares each operationId exactly once', async () => {
    const text = await spec()
    for (const operationId of [
      'getRevenueSummary',
      'getRevenueTimeseries',
      'getRevenueTransactions',
      'getRevenueTransactionJourney',
    ]) {
      expect(text.split(`operationId: ${operationId}\n`)).toHaveLength(2)
    }
  })

  it('documents the whole authorization stack’s answers on every path', async () => {
    const text = await spec()
    for (const path of PATHS) {
      const block = pathBlock(text, path)
      // One 403 since the open-core split: the suspension gate (02 §23) and the
      // owner-only capability answer the same status, and the document names one
      // response carrying both rather than a payment status the product has no
      // error code for.
      // A path missing either would generate a client that cannot branch on the
      // two states the dashboard renders differently.
      expect(block, `${path} must document 401`).toContain("'401':")
      expect(block, `${path} must not carry a payment status`).not.toContain("'402':")
      expect(block, `${path} must document 403`).toContain("'403':")
      expect(block, `${path} must document 404`).toContain("'404':")
      expect(block, `${path} must document 503`).toContain("'503':")
      expect(block).toContain('revenue:read')
    }
  })

  it('requires a range on the journey path, because the object read is bounded by it', async () => {
    const text = await spec()
    const block = pathBlock(text, '/v1/sites/{site_id}/revenue/transactions/{object_id}/journey')
    expect(block).toContain("$ref: '#/components/parameters/RangeFrom'")
    expect(block).toContain("$ref: '#/components/parameters/RangeTo'")
    // Documented as load-bearing rather than decoration, so a client does not
    // "helpfully" widen it to all time.
    expect(block).toContain('load-bearing')
  })

  it('gives the transactions list a cursor and a bounded limit', async () => {
    const text = await spec()
    const block = pathBlock(text, '/v1/sites/{site_id}/revenue/transactions')
    expect(block).toContain("$ref: '#/components/parameters/Cursor'")
    expect(block).toContain("$ref: '#/components/parameters/PageLimit'")

    const limit = text.slice(text.indexOf('\n    PageLimit:\n'))
    expect(limit).toContain(`maximum: ${MAX_PAGE_SIZE}`)
    expect(limit).toContain(`default: ${DEFAULT_PAGE_SIZE}`)
  })

  it('offers only hour and day on the revenue resolution parameter', async () => {
    const text = await spec()
    const block = text.slice(
      text.indexOf('\n    RevenueResolution:\n'),
      text.indexOf('\n    Cursor:\n'),
    )
    // The enum, not the prose: the description names `minute` and `week`
    // precisely to say they are refused.
    expect(block).toContain('enum: [hour, day]')
    expect(block).not.toContain('enum: [minute')
  })
})

describe('the metadata contract', () => {
  it('puts the connection block on AnalyticsMeta', async () => {
    const text = await spec()
    const meta = schemaBlock(text, 'AnalyticsMeta')
    expect(meta).toContain("$ref: '#/components/schemas/RevenueConnectionMeta'")
    // Optional, because it is absent on every non-revenue surface. Its presence
    // on a revenue response is asserted by the route suite, which drives the
    // real handler.
    expect(meta.replace(/\s+/gu, ' ')).not.toContain('- revenue')
  })

  it('enumerates the four connection statuses', async () => {
    const text = await spec()
    const block = schemaBlock(text, 'RevenueConnectionMeta')
    expect(block).toContain('enum: [connected, degraded, disconnected, not_connected]')
    // The three fields that make the trichotomy decidable without a second call.
    expect(block).toContain('provider:')
    expect(block).toContain('last_synced_at:')
    expect(block).toContain('last_webhook_at:')
  })

  it('carries OUR pipeline’s watermark, not only the provider’s', async () => {
    // The internal half of "a provider outage is never revenue of zero": the
    // provider can be answering perfectly while our own loop is dead, and
    // nothing in the credential row can see that.
    const text = await spec()
    const block = schemaBlock(text, 'RevenueConnectionMeta')
    expect(block).toContain('rollup_through:')
    expect(block.replace(/\s+/gu, ' ')).toContain(
      '[provider, connection_status, last_synced_at, last_webhook_at, rollup_through]',
    )
  })
})

describe('money on the wire (docs snapshot 03 §6.5)', () => {
  it('keeps gross, refund, fee and net as separate Money fields', async () => {
    const text = await spec()
    const block = schemaBlock(text, 'RevenueTransaction')
    for (const field of ['gross:', 'refund:', 'fee:', 'net:']) {
      expect(block, field).toContain(field)
    }
    // Never inferred by subtracting rounded values.
    expect(block.match(/\$ref: '#\/components\/schemas\/Money'/gu)?.length).toBeGreaterThanOrEqual(
      4,
    )
  })

  it('makes reporting and conversion nullable, so unconverted is not zero', async () => {
    const text = await spec()
    const block = schemaBlock(text, 'RevenueTransaction')
    const reporting = block.slice(
      block.indexOf('        reporting:'),
      block.indexOf('        parent_object_id:'),
    )
    expect(reporting).toContain("type: 'null'")
    expect(reporting).toContain("$ref: '#/components/schemas/Money'")
    expect(reporting).toContain("$ref: '#/components/schemas/CurrencyConversion'")
  })

  it('types every rollup total as an int64 minor-unit integer', async () => {
    const text = await spec()
    const block = schemaBlock(text, 'RevenueTotals')
    for (const field of [
      'charge_gross_minor',
      'refund_minor',
      'dispute_withdrawn_minor',
      'dispute_reinstated_minor',
      'fee_minor',
      'net_minor',
      'charge_count',
      'refund_count',
      'dispute_count',
      'unconverted_count',
    ]) {
      expect(block, field).toContain(`${field}:`)
    }
    expect(block).not.toContain('type: number')
  })

  it('reports the unconverted remainder per ORIGINAL currency', async () => {
    const text = await spec()
    const block = schemaBlock(text, 'RevenueUnconvertedCurrency')
    // The unconstrained `Currency`, not `ReportingCurrency`: this is a currency
    // a provider reported, not one the customer chose.
    expect(block).toContain("$ref: '#/components/schemas/Currency'")
    expect(schemaBlock(text, 'RevenueSummaryResponse')).toContain(
      "$ref: '#/components/schemas/RevenueUnconvertedCurrency'",
    )
  })
})

describe('the journey display contract (docs snapshot 03 §11)', () => {
  it('uses §11’s literal field names', async () => {
    const text = await spec()
    const block = schemaBlock(text, 'RevenueJourneyEntry')
    expect(block).toContain('required: [event_id, occurred_at, name, display, properties]')
  })

  it('declares exactly the kinds the renderer can produce', async () => {
    const text = await spec()
    const block = schemaBlock(text, 'RevenueJourneyDisplay')
    const match = /enum: \[([^\]]+)\]/u.exec(block)
    expect(match).not.toBeNull()
    const declared = (match?.[1] ?? '').split(',').map((value) => value.trim())
    // A frontend switch built from a stale enum is a silent rendering gap, so
    // the document and the pure renderer are asserted to agree.
    expect(declared).toEqual([...REVENUE_JOURNEY_DISPLAY_KINDS])
  })

  it('requires a non-empty text and an icon', async () => {
    const text = await spec()
    const block = schemaBlock(text, 'RevenueJourneyDisplay')
    expect(block).toContain('required: [kind, text, icon]')
    expect(block).toContain('minLength: 1')
  })

  it('carries the model metadata the honesty flags need', async () => {
    const text = await spec()
    const block = schemaBlock(text, 'RevenueJourneyResponse')
    for (const field of [
      'identity_scope',
      'model_version',
      'window_days',
      'touchpoint_count',
      'journey_truncated',
      'first_touch',
      'last_touch',
    ]) {
      expect(block, field).toContain(`${field}:`)
    }
    expect(schemaBlock(text, 'RevenueIdentityScope')).toContain('enum: [identified, anonymous_day]')
  })
})

describe('reporting currency', () => {
  it('is writable through PATCH /v1/sites/{site_id} and readable on the summary', async () => {
    const text = await spec()
    expect(schemaBlock(text, 'UpdateSiteRequest')).toContain(
      "$ref: '#/components/schemas/ReportingCurrency'",
    )
    expect(schemaBlock(text, 'SiteSummary')).toContain(
      "$ref: '#/components/schemas/ReportingCurrency'",
    )
    expect(schemaBlock(text, 'SiteSummary')).toContain('reporting_currency,')
  })

  it('documents the closed-list rule rather than only the pattern', async () => {
    const text = await spec()
    const block = schemaBlock(text, 'ReportingCurrency')
    expect(block).toContain("pattern: '^[A-Z]{3}$'")
    // The pattern alone accepts `ZZZ`, which would make every transaction
    // unconvertible — an empty dashboard produced by a typo.
    expect(block).toContain('closed list')
    expect(SUPPORTED_REPORTING_CURRENCIES.length).toBeGreaterThan(30)
  })
})

describe('subscription lifecycle (Perier gap 7)', () => {
  const SUB_PATHS = [
    '/v1/sites/{site_id}/revenue/subscriptions/summary',
    '/v1/sites/{site_id}/revenue/subscriptions/timeseries',
    '/v1/read/revenue/subscriptions/summary',
    '/v1/read/revenue/subscriptions/timeseries',
  ] as const

  it('documents revenue:read and the error statuses on every subscription path', async () => {
    const text = await spec()
    for (const path of SUB_PATHS) {
      const block = pathBlock(text, path)
      for (const status of ['401', '403', '404', '503']) {
        expect(block, `${path} must document ${status}`).toContain(`'${status}':`)
      }
      expect(block).toContain('revenue:read')
    }
  })

  it('keeps private keys off the /v1/read subscription paths', async () => {
    const text = await spec()
    for (const path of SUB_PATHS.slice(2)) {
      const block = pathBlock(text, path)
      expect(block).not.toContain('privateApiKey')
      expect(block).toContain("oauthAccessToken: ['revenue:read']")
    }
  })

  it('types MRR as int64 minor units and pre-divides nothing', async () => {
    const text = await spec()
    const block = schemaBlock(text, 'SubscriptionTotals')
    for (const field of ['mrr_start_minor', 'mrr_end_minor', 'churned_mrr_minor', 'active_end']) {
      expect(block, field).toContain(`${field}:`)
    }
    expect(block).not.toContain('rate:')
    expect(block).not.toContain('type: number')
  })

  it('makes purchase_kind on a transaction nullable and closes its vocabulary', async () => {
    const text = await spec()
    const kind = schemaBlock(text, 'SubscriptionPurchaseKind')
    expect(kind).toContain('enum: [new, renewal, plan_change, one_off]')
    const tx = schemaBlock(text, 'RevenueTransaction')
    const field = tx.slice(tx.indexOf('        purchase_kind:'))
    expect(field).toContain("$ref: '#/components/schemas/SubscriptionPurchaseKind'")
    expect(field).toContain("type: 'null'")
  })
})
