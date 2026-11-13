import type {
  SubscriptionInvoiceRow,
  SubscriptionLifecycleRow,
  SubscriptionLifecycleStore,
} from '@openanalytics/clickhouse'
import {
  convertMinorAmount,
  planSubscriptionLifecycle,
  purchaseKindFor,
  revenueCustomerHash,
  subscriptionInterval,
  type CurrencyConversionPlan,
  type IdentityKey,
  type RevenueSubscriptionChange,
  type SubscriptionLifecycleFact,
} from '@openanalytics/domain'
import type { Logger, Metrics } from '@openanalytics/observability'
import {
  listSitesWithUnprojectedLifecycle,
  listUnprojectedRevenueInvoices,
  listUnprojectedRevenueSubscriptions,
  markRevenueInvoicesProjected,
  markRevenueSubscriptionsProjected,
  readRevenueSubscriptionChanges,
  readSiteReportingCurrency,
  type Database,
  type RevenueInvoiceRow,
  type RevenueSubscriptionHeadRow,
} from '@openanalytics/postgres'
import { WORKER_METRICS } from '../ingest/metrics.ts'
import { createRateCache } from './project.ts'

/**
 * The subscription lifecycle projection (Perier gap 7): Postgres 0047 heads and
 * invoice hints → ClickHouse 0030.
 *
 * The revenue projection's shape, deliberately (`project.ts`): discover due
 * rows by their per-row marker, build rows that are a pure function of the head
 * at one version, insert with a content token, then mark with the literal
 * version projected. A crash between insert and mark re-inserts identical rows,
 * which the token makes a no-op.
 *
 * ## One conversion rate per subscription, applied to the running MRR
 *
 * A movement converted at its own date would leave an ended subscription with a
 * non-zero reporting-currency residue whenever rates moved between its start and
 * its end — MRR that never existed, summed into every later day forever. So
 * each subscription's movements are converted at ONE rate (the head's snapshot
 * date), and each reporting delta is the difference of the converted RUNNING
 * MRR before and after it. The deltas of an ended subscription then sum to
 * exactly zero, and a live one's to exactly its current MRR converted, with no
 * rounding drift. The cost is that a fact from last year is restated at this
 * year's rate when the head next moves, which is what "MRR in the reporting
 * currency" means anyway: today's value of the recurring book.
 */

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_SITE_LIMIT = 25
const DEFAULT_BATCH_SIZE = 500

export interface LifecycleProjectionDeps {
  readonly db: Database
  readonly logger: Logger
  readonly metrics: Metrics
  readonly store: SubscriptionLifecycleStore
  readonly identityKey: IdentityKey
  readonly siteLimit?: number
  readonly batchSize?: number
  readonly intervalMs?: number
  readonly stopped?: () => boolean
}

export interface LifecycleProjectionResult {
  readonly sites: number
  readonly lifecycleRows: number
  readonly invoiceRows: number
  readonly failed: number
}

export async function projectLifecycleOnce(
  deps: LifecycleProjectionDeps,
): Promise<LifecycleProjectionResult> {
  const siteIds = await listSitesWithUnprojectedLifecycle(deps.db, {
    limit: deps.siteLimit ?? DEFAULT_SITE_LIMIT,
  })
  let lifecycleRows = 0
  let invoiceRows = 0
  let failed = 0
  for (const siteId of siteIds) {
    if (deps.stopped?.() === true) break
    try {
      const outcome = await projectSite(deps, siteId)
      lifecycleRows += outcome.lifecycleRows
      invoiceRows += outcome.invoiceRows
    } catch (err) {
      failed += 1
      deps.metrics.increment(WORKER_METRICS.revenueProjectionFailed, { reason: 'lifecycle' })
      deps.logger.error('revenue_lifecycle_projection_failed', {
        err,
        site_id: siteId,
        retryable: true,
      })
    }
  }
  return { sites: siteIds.length, lifecycleRows, invoiceRows, failed }
}

async function projectSite(
  deps: LifecycleProjectionDeps,
  siteId: string,
): Promise<{ lifecycleRows: number; invoiceRows: number }> {
  const reportingCurrency = await readSiteReportingCurrency(deps.db, siteId)
  if (reportingCurrency === null) return { lifecycleRows: 0, invoiceRows: 0 }
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE

  // --- Subscriptions -----------------------------------------------------
  const heads = await listUnprojectedRevenueSubscriptions(deps.db, { siteId, limit: batchSize })
  const changesByProvider = new Map<string, Map<string, RevenueSubscriptionChange[]>>()
  for (const provider of new Set(heads.map((head) => head.provider))) {
    changesByProvider.set(
      provider,
      await readRevenueSubscriptionChanges(deps.db, {
        siteId,
        provider,
        subscriptionIds: heads
          .filter((head) => head.provider === provider)
          .map((head) => head.subscriptionId),
      }),
    )
  }
  const rates = createRateCache(deps)
  const lifecycle: SubscriptionLifecycleRow[] = []
  for (const head of heads) {
    const conversion = await rates.plan({
      currency: head.normalized.currency,
      reportingCurrency,
      occurredAt: head.snapshotAt.toISOString(),
    })
    lifecycle.push(
      ...buildSubscriptionLifecycleRows({
        head,
        changes: changesByProvider.get(head.provider)?.get(head.subscriptionId) ?? [],
        reportingCurrency,
        conversion,
        identityKey: deps.identityKey,
      }),
    )
  }
  if (lifecycle.length > 0) await deps.store.insertLifecycleRows(lifecycle)
  await markRevenueSubscriptionsProjected(deps.db, {
    marks: heads.map((head) => ({ id: head.id, version: head.version })),
  })

  // --- Invoices ------------------------------------------------------------
  const invoices = await listUnprojectedRevenueInvoices(deps.db, { siteId, limit: batchSize })
  const invoiceRows = invoices.map(buildSubscriptionInvoiceRow)
  if (invoiceRows.length > 0) await deps.store.insertInvoiceRows(invoiceRows)
  await markRevenueInvoicesProjected(deps.db, {
    marks: invoices.map((invoice) => ({ id: invoice.id, version: invoice.version })),
  })

  if (lifecycle.length > 0) {
    deps.metrics.increment(
      WORKER_METRICS.revenueLifecycleProjectedRows,
      { table: 'subscription_lifecycle' },
      lifecycle.length,
    )
  }
  if (invoiceRows.length > 0) {
    deps.metrics.increment(
      WORKER_METRICS.revenueLifecycleProjectedRows,
      { table: 'subscription_invoices' },
      invoiceRows.length,
    )
  }
  if (heads.length > 0 || invoices.length > 0) {
    deps.logger.info('revenue_lifecycle_projected', {
      site_id: siteId,
      subscriptions: heads.length,
      lifecycle_rows: lifecycle.length,
      invoices: invoices.length,
    })
  }
  return { lifecycleRows: lifecycle.length, invoiceRows: invoiceRows.length }
}

/**
 * The ClickHouse rows for one head at one version. Pure, so a replay builds
 * byte-identical rows. A plan with no facts is written as one `none` row, which
 * supersedes whatever an earlier generation of the subscription said.
 */
export function buildSubscriptionLifecycleRows(input: {
  readonly head: RevenueSubscriptionHeadRow
  readonly changes: readonly RevenueSubscriptionChange[]
  readonly reportingCurrency: string
  readonly conversion: CurrencyConversionPlan
  readonly identityKey: IdentityKey
}): SubscriptionLifecycleRow[] {
  const { head, conversion } = input
  const snapshot = head.normalized
  const facts: SubscriptionLifecycleFact[] = planSubscriptionLifecycle({
    snapshot,
    snapshotAt: head.snapshotAt,
    changes: input.changes,
  })
  const planned: SubscriptionLifecycleFact[] =
    facts.length > 0
      ? facts
      : [
          {
            kind: 'none' as SubscriptionLifecycleFact['kind'],
            occurredAt: head.snapshotAt,
            mrrDeltaMinor: 0,
            activeDelta: 0,
            trialDelta: 0,
          },
        ]

  const reporting = input.reportingCurrency.toLowerCase()
  const convert = (amount: number): number | null =>
    convertMinorAmount({
      amountMinor: amount,
      fromCurrency: snapshot.currency,
      toCurrency: reporting,
      conversion,
    })
  const customerHash =
    snapshot.customer_id === ''
      ? ''
      : revenueCustomerHash({
          siteId: head.siteId,
          customerId: snapshot.customer_id,
          key: input.identityKey,
        }).customerHash
  const ingestedAt = toClickHouseInstant(head.updatedAt)

  let running = 0
  let reportedRunning = 0
  return planned.map((fact, seq) => {
    running += fact.mrrDeltaMinor
    const reportedNow = convert(running)
    const reportingDelta = reportedNow === null ? 0 : reportedNow - reportedRunning
    if (reportedNow !== null) reportedRunning = reportedNow
    return {
      site_id: head.siteId,
      provider: head.provider,
      subscription_id: head.subscriptionId,
      seq,
      generation: head.version,
      kind: fact.kind,
      occurred_at: toClickHouseInstant(fact.occurredAt),
      status: snapshot.status,
      livemode: snapshot.livemode ? 1 : 0,
      billing_interval: subscriptionInterval(snapshot.items),
      currency: snapshot.currency,
      mrr_delta_minor: fact.mrrDeltaMinor,
      reporting_currency: reporting,
      reporting_mrr_delta_minor: reportingDelta,
      conversion_source: conversion.source,
      active_delta: fact.activeDelta,
      trial_delta: fact.trialDelta,
      customer_hash: customerHash,
      ingested_at: ingestedAt,
    }
  })
}

export function buildSubscriptionInvoiceRow(invoice: RevenueInvoiceRow): SubscriptionInvoiceRow {
  return {
    site_id: invoice.siteId,
    provider: invoice.provider,
    invoice_id: invoice.invoiceId,
    generation: invoice.version,
    subscription_id: invoice.subscriptionId,
    billing_reason: invoice.billingReason,
    // Unknown until the billing reason is: an `invoice_payment.paid` that came
    // first knows its PaymentIntent but not what the payment was for. The read
    // join ignores '' and the charge reads as a one-off until `invoice.paid`
    // fills the reason in and the row is projected again.
    purchase_kind:
      invoice.billingReason === ''
        ? ''
        : purchaseKindFor({
            billingReason: invoice.billingReason,
            subscriptionId: invoice.subscriptionId,
          }),
    order_id: invoice.orderId,
    charge_id: invoice.chargeId,
    occurred_at: toClickHouseInstant(invoice.occurredAt),
    ingested_at: toClickHouseInstant(invoice.updatedAt),
  }
}

function toClickHouseInstant(at: Date): string {
  return at.toISOString().replace('T', ' ').replace('Z', '')
}

export interface LifecycleProjectionLoop {
  stop(): Promise<void>
}

export function startLifecycleProjection(deps: LifecycleProjectionDeps): LifecycleProjectionLoop {
  let running = false
  let stopped = false

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const result = await projectLifecycleOnce({ ...deps, stopped: () => stopped })
      if (result.lifecycleRows > 0 || result.invoiceRows > 0 || result.failed > 0) {
        deps.logger.info('revenue_lifecycle_projection_swept', { ...result })
      }
    } catch (err) {
      deps.metrics.increment(WORKER_METRICS.revenueProjectionFailed, { reason: 'lifecycle_tick' })
      deps.logger.error('revenue_lifecycle_projection_tick_failed', { err, retryable: true })
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS)
  timer.unref()

  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
  }
}
