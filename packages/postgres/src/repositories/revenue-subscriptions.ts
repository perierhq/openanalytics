import {
  decideRevenueObject,
  type RevenueInvoiceHint,
  type RevenueObjectDecision,
  type RevenueSubscriptionChange,
  type RevenueSubscriptionObservation,
  type RevenueSubscriptionSnapshot,
} from '@openanalytics/domain'
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import type { Database, Executor } from '../client.ts'
import { newId } from '../ids.ts'
import {
  revenueInvoices,
  revenueSubscriptionChanges,
  revenueSubscriptions,
} from '../schema/revenue.ts'

/**
 * Subscription heads, subscription changes and invoice hints (Perier gap 7;
 * migration 0047).
 *
 * The same three rules the money repositories follow, applied to three tables
 * that hold no money:
 *
 * - A subscription head is decided by `decideRevenueObject` under its row
 *   lock, exactly like `applyRevenueObservation`: newer applies, older skips,
 *   an equal-time differing payload asks the caller to re-fetch.
 * - A change is insert-only and keyed by the provider event, so a redelivery is
 *   a no-op. A change that DID insert bumps its head's `version`, because the
 *   projected lifecycle depends on it.
 * - An invoice hint is filled forward like a checkout hint, and its `version`
 *   moves only when the merged row actually differs.
 *
 * Every projection marker is written with the literal version projected and
 * guarded `projected_version < that`, so a write that lands between the read and
 * the mark leaves the row due rather than losing it (0028).
 */

// --- Subscription heads -------------------------------------------------------

export interface ApplyRevenueSubscriptionInput {
  readonly siteId: string
  readonly provider: string
  readonly observation: RevenueSubscriptionObservation
  readonly payloadHash: string
  /** The tie-break re-fetch's force-apply. */
  readonly force?: boolean
  readonly now?: Date
}

export interface AppliedRevenueSubscription {
  readonly decision: RevenueObjectDecision
}

export async function applyRevenueSubscriptionObservation(
  db: Database,
  input: ApplyRevenueSubscriptionInput,
): Promise<AppliedRevenueSubscription> {
  // Two attempts for the same reason as the money head: two first observations
  // of one subscription racing the insert. The loser re-reads and decides
  // against the winner's row.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await applySubscriptionOnce(db, input)
    if (result) return result
  }
  throw new Error('revenue subscription head could not be materialized')
}

async function applySubscriptionOnce(
  db: Database,
  input: ApplyRevenueSubscriptionInput,
): Promise<AppliedRevenueSubscription | null> {
  const now = input.now ?? new Date()
  const { observation } = input

  return await db.transaction(async (tx) => {
    const [stored] = await tx
      .select({
        id: revenueSubscriptions.id,
        snapshotAt: revenueSubscriptions.snapshotAt,
        payloadHash: revenueSubscriptions.payloadHash,
        version: revenueSubscriptions.version,
      })
      .from(revenueSubscriptions)
      .where(
        and(
          eq(revenueSubscriptions.siteId, input.siteId),
          eq(revenueSubscriptions.provider, input.provider),
          eq(revenueSubscriptions.subscriptionId, observation.subscriptionId),
        ),
      )
      .for('update')

    const decision = decideRevenueObject(
      stored ?? null,
      { snapshotAt: observation.snapshotAt, payloadHash: input.payloadHash },
      input.force === true ? { force: true } : {},
    )
    if (decision.action !== 'apply') return { decision }

    if (stored) {
      await tx
        .update(revenueSubscriptions)
        .set({
          snapshotAt: observation.snapshotAt,
          payloadHash: input.payloadHash,
          version: decision.version,
          normalized: observation.normalized,
          updatedAt: now,
        })
        .where(eq(revenueSubscriptions.id, stored.id))
      return { decision }
    }

    const inserted = await tx
      .insert(revenueSubscriptions)
      .values({
        id: newId(),
        siteId: input.siteId,
        provider: input.provider,
        subscriptionId: observation.subscriptionId,
        snapshotAt: observation.snapshotAt,
        payloadHash: input.payloadHash,
        version: decision.version,
        normalized: observation.normalized,
        firstSeenAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          revenueSubscriptions.siteId,
          revenueSubscriptions.provider,
          revenueSubscriptions.subscriptionId,
        ],
      })
      .returning({ id: revenueSubscriptions.id })
    return inserted.length > 0 ? { decision } : null
  })
}

export interface RevenueSubscriptionHeadRow {
  readonly id: string
  readonly siteId: string
  readonly provider: string
  readonly subscriptionId: string
  readonly snapshotAt: Date
  readonly payloadHash: string
  readonly version: number
  readonly normalized: RevenueSubscriptionSnapshot
  readonly firstSeenAt: Date
  readonly updatedAt: Date
  readonly projectedVersion: number
}

/** Test and reconciliation helper: one head by its provider id. */
export async function readRevenueSubscription(
  db: Executor,
  input: { readonly siteId: string; readonly provider: string; readonly subscriptionId: string },
): Promise<RevenueSubscriptionHeadRow | null> {
  const [row] = await db
    .select()
    .from(revenueSubscriptions)
    .where(
      and(
        eq(revenueSubscriptions.siteId, input.siteId),
        eq(revenueSubscriptions.provider, input.provider),
        eq(revenueSubscriptions.subscriptionId, input.subscriptionId),
      ),
    )
  return row ?? null
}

// --- Subscription changes -----------------------------------------------------

/**
 * Insert changes, ignoring ones already recorded, and re-queue the heads they
 * belong to.
 *
 * The bump is `version + 1` with `updated_at` untouched-but-for-now, inside the
 * same transaction as the insert, so a change can never be recorded without
 * its head becoming due. A change for a head that does not exist yet bumps
 * nothing — the head's own first apply (version 1) will be projected with it.
 */
export async function recordRevenueSubscriptionChanges(
  db: Database,
  input: {
    readonly siteId: string
    readonly provider: string
    readonly changes: readonly RevenueSubscriptionChange[]
    readonly now?: Date
  },
): Promise<{ readonly inserted: number }> {
  if (input.changes.length === 0) return { inserted: 0 }
  const now = input.now ?? new Date()

  return await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(revenueSubscriptionChanges)
      .values(
        input.changes.map((change) => ({
          id: newId(),
          siteId: input.siteId,
          provider: input.provider,
          subscriptionId: change.subscriptionId,
          providerEventId: change.providerEventId,
          kind: change.kind,
          occurredAt: change.occurredAt,
          fromMrrMinor: change.fromMrrMinor,
          toMrrMinor: change.toMrrMinor,
          createdAt: now,
        })),
      )
      .onConflictDoNothing({
        target: [
          revenueSubscriptionChanges.siteId,
          revenueSubscriptionChanges.provider,
          revenueSubscriptionChanges.providerEventId,
          revenueSubscriptionChanges.kind,
        ],
      })
      .returning({ subscriptionId: revenueSubscriptionChanges.subscriptionId })

    const touched = [...new Set(inserted.map((row) => row.subscriptionId))]
    if (touched.length > 0) {
      await tx
        .update(revenueSubscriptions)
        .set({ version: sql`${revenueSubscriptions.version} + 1`, updatedAt: now })
        .where(
          and(
            eq(revenueSubscriptions.siteId, input.siteId),
            eq(revenueSubscriptions.provider, input.provider),
            inArray(revenueSubscriptions.subscriptionId, touched),
          ),
        )
    }
    return { inserted: inserted.length }
  })
}

/** Every change of a batch of subscriptions, grouped by subscription id. */
export async function readRevenueSubscriptionChanges(
  db: Executor,
  input: {
    readonly siteId: string
    readonly provider: string
    readonly subscriptionIds: readonly string[]
  },
): Promise<Map<string, RevenueSubscriptionChange[]>> {
  const wanted = [...new Set(input.subscriptionIds)]
  const out = new Map<string, RevenueSubscriptionChange[]>()
  if (wanted.length === 0) return out

  const rows = await db
    .select({
      subscriptionId: revenueSubscriptionChanges.subscriptionId,
      providerEventId: revenueSubscriptionChanges.providerEventId,
      kind: revenueSubscriptionChanges.kind,
      occurredAt: revenueSubscriptionChanges.occurredAt,
      fromMrrMinor: revenueSubscriptionChanges.fromMrrMinor,
      toMrrMinor: revenueSubscriptionChanges.toMrrMinor,
    })
    .from(revenueSubscriptionChanges)
    .where(
      and(
        eq(revenueSubscriptionChanges.siteId, input.siteId),
        eq(revenueSubscriptionChanges.provider, input.provider),
        inArray(revenueSubscriptionChanges.subscriptionId, wanted),
      ),
    )
    // Deterministic order, so the projection replays to identical rows.
    .orderBy(
      asc(revenueSubscriptionChanges.occurredAt),
      asc(revenueSubscriptionChanges.providerEventId),
      asc(revenueSubscriptionChanges.kind),
    )

  for (const row of rows) {
    const list = out.get(row.subscriptionId) ?? []
    list.push(row)
    out.set(row.subscriptionId, list)
  }
  return out
}

// --- Invoice hints ------------------------------------------------------------

const INVOICES_TABLE = 'revenue_invoices'
const fillForward = (column: string) =>
  `COALESCE(NULLIF(excluded.${column}, ''), ${INVOICES_TABLE}.${column})`
const FILLED_COLUMNS = [
  'subscription_id',
  'billing_reason',
  'order_id',
  'charge_id',
  'customer_id',
] as const

/**
 * Upsert invoice hints, filled forward, keyed on `(site, provider, invoice)`.
 *
 * `version` moves only when the merged row differs from the stored one — the
 * `setWhere` guard — so a redelivered `invoice.paid` updates nothing, writes no
 * new ClickHouse generation and re-queues no projection. `occurred_at` keeps the
 * EARLIER of the two: it is when the invoice was paid, and a later event about
 * the same payment does not move that.
 */
export async function recordRevenueInvoiceHints(
  db: Executor,
  input: {
    readonly siteId: string
    readonly provider: string
    readonly hints: readonly RevenueInvoiceHint[]
    readonly now?: Date
  },
): Promise<{ readonly written: number }> {
  if (input.hints.length === 0) return { written: 0 }
  const now = input.now ?? new Date()

  // One row per invoice per statement: Postgres refuses an ON CONFLICT DO
  // UPDATE that would touch the same row twice, and a list page can in
  // principle name an invoice twice. Later entries fill earlier ones forward.
  const merged = new Map<string, RevenueInvoiceHint>()
  for (const hint of input.hints) {
    const prior = merged.get(hint.invoiceId)
    merged.set(
      hint.invoiceId,
      prior === undefined
        ? hint
        : {
            invoiceId: hint.invoiceId,
            subscriptionId: hint.subscriptionId || prior.subscriptionId,
            billingReason: hint.billingReason || prior.billingReason,
            orderId: hint.orderId || prior.orderId,
            chargeId: hint.chargeId || prior.chargeId,
            customerId: hint.customerId || prior.customerId,
            occurredAt:
              hint.occurredAt.getTime() < prior.occurredAt.getTime()
                ? hint.occurredAt
                : prior.occurredAt,
          },
    )
  }

  const changed = sql.raw(
    `(${FILLED_COLUMNS.map(fillForward).join(', ')}, LEAST(excluded.occurred_at, ${INVOICES_TABLE}.occurred_at))` +
      ` IS DISTINCT FROM ` +
      `(${FILLED_COLUMNS.map((c) => `${INVOICES_TABLE}.${c}`).join(', ')}, ${INVOICES_TABLE}.occurred_at)`,
  )

  const written = await db
    .insert(revenueInvoices)
    .values(
      [...merged.values()].map((hint) => ({
        id: newId(),
        siteId: input.siteId,
        provider: input.provider,
        invoiceId: hint.invoiceId,
        subscriptionId: hint.subscriptionId,
        billingReason: hint.billingReason,
        orderId: hint.orderId,
        chargeId: hint.chargeId,
        customerId: hint.customerId,
        occurredAt: hint.occurredAt,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [revenueInvoices.siteId, revenueInvoices.provider, revenueInvoices.invoiceId],
      set: {
        subscriptionId: sql.raw(fillForward('subscription_id')),
        billingReason: sql.raw(fillForward('billing_reason')),
        orderId: sql.raw(fillForward('order_id')),
        chargeId: sql.raw(fillForward('charge_id')),
        customerId: sql.raw(fillForward('customer_id')),
        occurredAt: sql.raw(`LEAST(excluded.occurred_at, ${INVOICES_TABLE}.occurred_at)`),
        version: sql.raw(`${INVOICES_TABLE}.version + 1`),
        updatedAt: now,
      },
      setWhere: changed,
    })
    .returning({ id: revenueInvoices.id })

  return { written: written.length }
}

export interface RevenueInvoiceRow {
  readonly id: string
  readonly siteId: string
  readonly provider: string
  readonly invoiceId: string
  readonly subscriptionId: string
  readonly billingReason: string
  readonly orderId: string
  readonly chargeId: string
  readonly customerId: string
  readonly occurredAt: Date
  readonly version: number
  readonly projectedVersion: number
  readonly updatedAt: Date
}

/** Test and reconciliation helper: one invoice hint by its provider id. */
export async function readRevenueInvoice(
  db: Executor,
  input: { readonly siteId: string; readonly provider: string; readonly invoiceId: string },
): Promise<RevenueInvoiceRow | null> {
  const [row] = await db
    .select(invoiceColumns)
    .from(revenueInvoices)
    .where(
      and(
        eq(revenueInvoices.siteId, input.siteId),
        eq(revenueInvoices.provider, input.provider),
        eq(revenueInvoices.invoiceId, input.invoiceId),
      ),
    )
  return row ?? null
}

const invoiceColumns = {
  id: revenueInvoices.id,
  siteId: revenueInvoices.siteId,
  provider: revenueInvoices.provider,
  invoiceId: revenueInvoices.invoiceId,
  subscriptionId: revenueInvoices.subscriptionId,
  billingReason: revenueInvoices.billingReason,
  orderId: revenueInvoices.orderId,
  chargeId: revenueInvoices.chargeId,
  customerId: revenueInvoices.customerId,
  occurredAt: revenueInvoices.occurredAt,
  version: revenueInvoices.version,
  projectedVersion: revenueInvoices.projectedVersion,
  updatedAt: revenueInvoices.updatedAt,
}

// --- Projection discovery and marks -----------------------------------------

/** Sites with a subscription head or an invoice hint still to project. */
export async function listSitesWithUnprojectedLifecycle(
  db: Executor,
  input: { readonly limit: number },
): Promise<string[]> {
  // Two small partial-index scans merged here, rather than one UNION, so each
  // stays a plain Drizzle query against its own partial index.
  const [subscriptionSites, invoiceSites] = await Promise.all([
    db
      .selectDistinct({ siteId: revenueSubscriptions.siteId })
      .from(revenueSubscriptions)
      .where(lt(revenueSubscriptions.projectedVersion, revenueSubscriptions.version))
      .orderBy(asc(revenueSubscriptions.siteId))
      .limit(input.limit),
    db
      .selectDistinct({ siteId: revenueInvoices.siteId })
      .from(revenueInvoices)
      .where(lt(revenueInvoices.projectedVersion, revenueInvoices.version))
      .orderBy(asc(revenueInvoices.siteId))
      .limit(input.limit),
  ])
  const all = new Set([...subscriptionSites, ...invoiceSites].map((row) => row.siteId))
  return [...all].sort().slice(0, input.limit)
}

export async function listUnprojectedRevenueSubscriptions(
  db: Executor,
  input: { readonly siteId: string; readonly limit: number },
): Promise<RevenueSubscriptionHeadRow[]> {
  return await db
    .select()
    .from(revenueSubscriptions)
    .where(
      and(
        eq(revenueSubscriptions.siteId, input.siteId),
        lt(revenueSubscriptions.projectedVersion, revenueSubscriptions.version),
      ),
    )
    .orderBy(asc(revenueSubscriptions.updatedAt), asc(revenueSubscriptions.id))
    .limit(input.limit)
}

export async function listUnprojectedRevenueInvoices(
  db: Executor,
  input: { readonly siteId: string; readonly limit: number },
): Promise<RevenueInvoiceRow[]> {
  return await db
    .select(invoiceColumns)
    .from(revenueInvoices)
    .where(
      and(
        eq(revenueInvoices.siteId, input.siteId),
        lt(revenueInvoices.projectedVersion, revenueInvoices.version),
      ),
    )
    .orderBy(asc(revenueInvoices.updatedAt), asc(revenueInvoices.id))
    .limit(input.limit)
}

/** Mark projected heads, guarded so a concurrent bump stays due. */
export async function markRevenueSubscriptionsProjected(
  db: Executor,
  input: { readonly marks: readonly { readonly id: string; readonly version: number }[] },
): Promise<{ readonly marked: number }> {
  let marked = 0
  for (const mark of input.marks) {
    const updated = await db
      .update(revenueSubscriptions)
      .set({ projectedVersion: mark.version })
      .where(
        and(
          eq(revenueSubscriptions.id, mark.id),
          lt(revenueSubscriptions.projectedVersion, mark.version),
          sql`${revenueSubscriptions.version} >= ${mark.version}`,
        ),
      )
      .returning({ id: revenueSubscriptions.id })
    marked += updated.length
  }
  return { marked }
}

export async function markRevenueInvoicesProjected(
  db: Executor,
  input: { readonly marks: readonly { readonly id: string; readonly version: number }[] },
): Promise<{ readonly marked: number }> {
  let marked = 0
  for (const mark of input.marks) {
    const updated = await db
      .update(revenueInvoices)
      .set({ projectedVersion: mark.version })
      .where(
        and(
          eq(revenueInvoices.id, mark.id),
          lt(revenueInvoices.projectedVersion, mark.version),
          sql`${revenueInvoices.version} >= ${mark.version}`,
        ),
      )
      .returning({ id: revenueInvoices.id })
    marked += updated.length
  }
  return { marked }
}
