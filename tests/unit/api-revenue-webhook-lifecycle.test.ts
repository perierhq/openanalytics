import { randomBytes } from 'node:crypto'
import { createRevenueAdapterRegistry, revenueCredentialAad } from '@openanalytics/domain'
import { createCredentialVault, createStripeRevenueAdapter } from '@openanalytics/integrations'
import type { Database, RevenueCredentialRow } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { signStripeWebhook } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  stripeEvent,
  stripeInvoice,
  stripeInvoicePayment,
  stripeSubscription,
} from '../support/revenue-fixtures.ts'
import type { RevenueWebhookDeps } from '../../apps/api/src/http/revenue-webhook.ts'

/**
 * The webhook route's lifecycle writes (Perier gap 7), driven through the REAL
 * Stripe adapter so the route sees exactly what a Stripe delivery normalizes
 * to. The repository is stubbed at the module boundary, as in
 * `api-revenue-webhook.test.ts`; the Postgres semantics of the three writes
 * have their own suite (`tests/migration/revenue-subscriptions.test.ts`).
 */

const SITE = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const CREDENTIAL = '7c9e2f10-0000-4000-8000-0000000c0ffe'
const TOKEN = 'tok_opaque_lifecycle'
const WEBHOOK_SECRET = 'whsec_test_lifecycle'
const API_KEY = 'rk_test_restricted_lifecycle'

const vault = createCredentialVault(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
)
const aad = revenueCredentialAad({ credentialId: CREDENTIAL, siteId: SITE })

const credential: RevenueCredentialRow = {
  id: CREDENTIAL,
  siteId: SITE,
  provider: 'stripe',
  encryptedApiKey: vault.encrypt(API_KEY, aad).stored,
  encryptedWebhookSecret: vault.encrypt(WEBHOOK_SECRET, aad).stored,
  keyVersion: 'k1',
  apiKeyLast4: '1234',
  webhookToken: TOKEN,
  status: 'active',
  createdByUserId: 'u-owner',
  connectedAt: new Date('2026-07-31T00:00:00.000Z'),
  lastVerifiedAt: new Date('2026-07-31T00:00:00.000Z'),
  lastSyncedAt: null,
  lastWebhookAt: null,
  lastError: null,
  disabledAt: null,
  backfillGeneration: 0,
  createdAt: new Date('2026-07-31T00:00:00.000Z'),
  updatedAt: new Date('2026-07-31T00:00:00.000Z'),
}

const world = {
  subscriptionDecision: 'apply' as 'apply' | 'skip' | 'refetch_from_provider',
}
const calls = {
  settlements: [] as Record<string, unknown>[],
  invoiceHints: [] as Record<string, unknown>[],
  changes: [] as Record<string, unknown>[],
  subscriptionApplies: [] as Record<string, unknown>[],
  moneyApplies: 0,
  fetches: [] as string[],
}

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    readRevenueCredentialByWebhookToken: async () => credential,
    recordRevenueProviderEvent: async () => ({
      id: 'ledger-1',
      firstSeen: true,
      status: 'received',
    }),
    markRevenueProviderEvent: async (_db: unknown, input: Record<string, unknown>) => {
      calls.settlements.push(input)
    },
    updateRevenueCredentialState: async () => {},
    applyRevenueObservation: async () => {
      calls.moneyApplies += 1
      return { decision: { action: 'apply', version: 1, reason: 'first_observation' } }
    },
    recordRevenueInvoiceHints: async (_db: unknown, input: Record<string, unknown>) => {
      calls.invoiceHints.push(input)
      return { written: 1 }
    },
    recordRevenueSubscriptionChanges: async (_db: unknown, input: Record<string, unknown>) => {
      calls.changes.push(input)
      return { inserted: (input['changes'] as unknown[]).length }
    },
    applyRevenueSubscriptionObservation: async (_db: unknown, input: Record<string, unknown>) => {
      calls.subscriptionApplies.push(input)
      if (input['force'] === true || world.subscriptionDecision === 'apply') {
        return { decision: { action: 'apply', version: 1, reason: 'first_observation' } }
      }
      if (world.subscriptionDecision === 'skip') {
        return { decision: { action: 'skip', reason: 'older_snapshot' } }
      }
      return {
        decision: { action: 'refetch_from_provider', reason: 'equal_snapshot_differing_payload' },
      }
    },
  }
})

const { processRevenueWebhook } = await import('../../apps/api/src/http/revenue-webhook.ts')

function deps(): RevenueWebhookDeps {
  const adapter = createStripeRevenueAdapter(async (input, init) => {
    calls.fetches.push(
      `${String(input)} ${String((init?.headers as Record<string, string>)['authorization'])}`,
    )
    return new Response(JSON.stringify(stripeSubscription({ status: 'past_due' })), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return {
    db: {} as Database,
    vault,
    adapters: createRevenueAdapterRegistry([adapter]),
  }
}

async function deliver(event: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000)
  const body = JSON.stringify({ ...event, created: now })
  return await processRevenueWebhook(deps(), {
    provider: 'stripe',
    webhookToken: TOKEN,
    rawBody: body,
    signatureHeader: signStripeWebhook({ payload: body, secret: WEBHOOK_SECRET, timestamp: now }),
    now: new Date(now * 1000),
  })
}

beforeEach(() => {
  world.subscriptionDecision = 'apply'
  calls.settlements.length = 0
  calls.invoiceHints.length = 0
  calls.changes.length = 0
  calls.subscriptionApplies.length = 0
  calls.moneyApplies = 0
  calls.fetches.length = 0
})

describe('processRevenueWebhook — subscription lifecycle', () => {
  it('stores a subscription head and its changes, and settles `processed`', async () => {
    const subscription = stripeSubscription({ cancel_at_period_end: true })
    const result = await deliver(
      stripeEvent('customer.subscription.updated', subscription, {
        data: { object: subscription, previous_attributes: { cancel_at_period_end: false } },
      }),
    )
    expect(result).toEqual({ status: 'ok', ledger: 'processed' })
    expect(calls.moneyApplies).toBe(0)
    expect(calls.changes[0]).toMatchObject({ siteId: SITE, provider: 'stripe' })
    expect((calls.changes[0]?.['changes'] as { kind: string }[])[0]?.kind).toBe('cancel_scheduled')
    expect(calls.subscriptionApplies).toHaveLength(1)
    expect(calls.subscriptionApplies[0]?.['payloadHash']).toMatch(/^[0-9a-f]{64}$/u)
    expect(calls.settlements[0]).toMatchObject({
      status: 'processed',
      result: { subscriptions_applied: 1, subscription_changes: 1, invoice_hints: 0 },
    })
  })

  it('stores invoice hints from invoice.paid and invoice_payment.paid', async () => {
    expect(await deliver(stripeEvent('invoice.paid', stripeInvoice()))).toEqual({
      status: 'ok',
      ledger: 'processed',
    })
    expect(await deliver(stripeEvent('invoice_payment.paid', stripeInvoicePayment()))).toEqual({
      status: 'ok',
      ledger: 'processed',
    })
    expect(calls.invoiceHints.map((c) => (c['hints'] as { invoiceId: string }[])[0])).toEqual([
      expect.objectContaining({ invoiceId: 'in_test_1', billingReason: 'subscription_create' }),
      expect.objectContaining({ invoiceId: 'in_test_1', orderId: 'pi_sub_1' }),
    ])
  })

  it('re-fetches a subscription tie with the decrypted key and force-applies it', async () => {
    world.subscriptionDecision = 'refetch_from_provider'
    const result = await deliver(stripeEvent('customer.subscription.updated', stripeSubscription()))
    expect(result).toEqual({ status: 'ok', ledger: 'processed' })
    expect(calls.fetches).toHaveLength(1)
    expect(calls.fetches[0]).toContain('/v1/subscriptions/sub_test_1')
    expect(calls.fetches[0]).toContain(API_KEY)
    expect(calls.subscriptionApplies[1]).toMatchObject({ force: true })
    // Applied at the event's instant, not the subscription's own `created`.
    expect(
      (calls.subscriptionApplies[1]?.['observation'] as { snapshotAt: Date }).snapshotAt,
    ).toEqual((calls.subscriptionApplies[0]?.['observation'] as { snapshotAt: Date }).snapshotAt)
  })

  it('ledgers an unreadable subscription object as ignored', async () => {
    const result = await deliver(stripeEvent('customer.subscription.created', { id: 'sub_x' }))
    expect(result).toEqual({ status: 'ok', ledger: 'ignored', reason: 'unsupported_object_shape' })
    expect(calls.subscriptionApplies).toHaveLength(0)
  })
})
