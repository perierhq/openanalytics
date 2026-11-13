import type { RevenueEventRow, RevenueEventsStore } from '@openanalytics/clickhouse'
import {
  conversionDateOf,
  convertMinorAmount,
  externalUserIdHash,
  isRateWithinLookback,
  planCurrencyConversion,
  resolveRevenueExternalUserId,
  revenueCustomerHash,
  type CurrencyConversionPlan,
  type IdentityKey,
  type RateAtDate,
} from '@openanalytics/domain'
import type { Logger, Metrics } from '@openanalytics/observability'
import {
  listSitesWithUnprojectedRevenue,
  listUnprojectedRevenueObjects,
  markRevenueObjectsProjected,
  readCurrencyRate,
  readOldestUnprojectedRevenueChange,
  readRevenueMatchHintsByOrder,
  readSiteReportingCurrency,
  type Database,
  type RevenueMatchHintRow,
  type UnprojectedRevenueObject,
} from '@openanalytics/postgres'
import { WORKER_METRICS } from '../ingest/metrics.ts'

/**
 * The revenue projection loop (ADR-0033, D5). Milestone 12 Checkpoint 3.
 *
 * Drains changed object heads out of Postgres into `analytics.revenue_events`,
 * materializing the site's reporting currency and the two identity hashes on the
 * way. It is the only writer of that table, and it lives in the **worker**
 * because the api holds no ClickHouse credential at all (D-208) and must keep
 * holding none.
 *
 * ## Why it is a projection rather than a second ingest
 *
 * Nothing here decides anything about money. The head already holds the
 * canonical snapshot and the monotonic version Postgres minted under a row lock
 * (D4); this loop reads it, converts, hashes, and writes. That separation is
 * what makes every downstream change a *recompute*: a reporting-currency change,
 * a widened identity resolution, a corrected exponent table — each is a
 * re-projection over stored heads, never a re-ingest from the provider, which is
 * exactly the split D6 was built to preserve.
 *
 * ## Exactly-once, without a clock
 *
 * A head is due when `projected_version < version`, a predicate with no
 * timestamp in it (the migration argues this at length against the two
 * timestamp-watermark designs that were rejected). The tick then does, strictly
 * in this order:
 *
 *   1. read the due heads,
 *   2. build rows — pure over `(head, reporting currency, rates, hint)`,
 *   3. insert into ClickHouse under a content-derived deduplication token,
 *   4. mark the heads at the **literal** versions that were projected.
 *
 * A crash anywhere between 3 and 4 re-projects heads whose rows are already
 * there. Because step 2 is a pure function of `(head, reporting currency, rate
 * plan, hint)` — **with no clock in it**, which is why `ingested_at` is
 * `head.updatedAt` rather than the tick's time — the rebuilt rows are
 * byte-identical, so the token is identical, so ClickHouse drops them. The
 * re-projection costs a request and changes nothing. The reverse order would
 * mark heads whose rows were never written, and a marker (unlike a watermark)
 * never comes back.
 *
 * The one input to step 2 that can legitimately move between attempts is the
 * rate table: an ECB refresh between a failed insert and its retry produces
 * different reporting amounts, a different token, and a second row at the same
 * version. Two rows at one version is the hazard `argMax` cannot resolve —
 * it evaluates **per column**, so a mixed read is possible — and it is bounded
 * to the retry window of a single batch against a table that refreshes every few
 * hours. Recorded rather than solved: the general fix is the same version bump
 * `resetRevenueProjection` needs, and it is CP5's wiring.
 *
 * ## What it refuses to do
 *
 * - **It never converts with a stale rate.** A currency the ECB does not list,
 *   or one whose newest rate predates the transaction by more than the lookback
 *   window, produces `conversion_source = 'unavailable'` with zeroed reporting
 *   amounts and the original currency and amount fully intact. CP5's read layer
 *   MUST surface those rows as an explicit unconverted remainder; folding the
 *   zeros into a reporting total is the confident-zero failure this milestone is
 *   named after.
 * - **It never writes an identifier.** Only the two site-scoped HMACs, under two
 *   different purpose tags. Nothing in this file logs a customer id, a client
 *   reference or a hash.
 * - **It never crashes the worker.** A ClickHouse outage is a counted failure
 *   and a return; this loop shares a process with batch ingest and email
 *   delivery.
 */

const DEFAULT_INTERVAL_MS = 30_000

/** Sites touched per tick. Bounded for the reason every sweep here is bounded:
 * one enormous account must not consume a tick that others are waiting in. */
const DEFAULT_SITE_LIMIT = 25

/** Heads projected per site per tick. One ClickHouse insert per batch, so this
 * is also the insert's row count — a few hundred rows of ~30 small columns is a
 * comfortable block and keeps the deduplication token's scope small enough that
 * a retry re-sends a bounded amount. */
const DEFAULT_BATCH_SIZE = 500

/** The `Date` a fact carries when there was no conversion at all. ClickHouse's
 * `Date` has no null and 1970-01-01 is its zero, so it reads as "absent" rather
 * than as a real banking day. */
const NO_RATE_DATE = '1970-01-01'

export interface RevenueProjectionDeps {
  readonly db: Database
  readonly logger: Logger
  readonly metrics: Metrics
  readonly store: RevenueEventsStore
  /**
   * `ANONYMOUS_IDENTITY_SECRET` + `ANONYMOUS_IDENTITY_KEY_VERSION`.
   *
   * Passed in rather than read here, so the loop cannot be constructed without a
   * caller having decided the key exists — and so a test drives the identical
   * derivation with a test secret. The key version travels with the derivation
   * (`externalUserIdHash` returns it) exactly as it does on the collector, which
   * is what lets a rotation still recognise old material.
   */
  readonly identityKey: IdentityKey
  readonly siteLimit?: number
  readonly batchSize?: number
  readonly intervalMs?: number
  /** Cooperative cancellation, checked between sites. Stopping mid-tick loses
   * nothing: every batch's marker is durable before the next one starts. */
  readonly stopped?: () => boolean
  readonly now?: () => Date
}

export interface RevenueProjectionResult {
  readonly sites: number
  readonly rows: number
  readonly marked: number
  readonly unavailableConversions: number
  readonly failed: number
  readonly skipped: number
}

/** One tick. Extracted so tests drive it directly rather than through a timer. */
export async function projectRevenueOnce(
  deps: RevenueProjectionDeps,
): Promise<RevenueProjectionResult> {
  const clock = deps.now ?? (() => new Date())
  const siteLimit = deps.siteLimit ?? DEFAULT_SITE_LIMIT
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE

  const siteIds = await listSitesWithUnprojectedRevenue(deps.db, { limit: siteLimit })
  await publishLag(deps, clock())

  if (siteIds.length === 0) {
    return { sites: 0, rows: 0, marked: 0, unavailableConversions: 0, failed: 0, skipped: 0 }
  }

  let rows = 0
  let marked = 0
  let unavailable = 0
  let failed = 0
  let skipped = 0

  for (const siteId of siteIds) {
    if (deps.stopped?.() === true) {
      skipped += 1
      continue
    }
    const outcome = await projectSite(deps, { siteId, batchSize })
    rows += outcome.rows
    marked += outcome.marked
    unavailable += outcome.unavailable
    if (outcome.status === 'failed') failed += 1
    if (outcome.status === 'skipped') skipped += 1
  }

  return {
    sites: siteIds.length,
    rows,
    marked,
    unavailableConversions: unavailable,
    failed,
    skipped,
  }
}

interface SiteOutcome {
  readonly status: 'ok' | 'failed' | 'skipped'
  readonly rows: number
  readonly marked: number
  readonly unavailable: number
}

/**
 * One site's batch.
 *
 * **The whole body is inside one `try`, row building included**, and that is a
 * containment decision rather than defensive habit. Building a row runs
 * `new Date(normalized.occurred_at)` and BigInt arithmetic over
 * `normalized.gross_minor`; a head whose stored snapshot is malformed — an
 * unparseable timestamp, a non-integer amount an adapter change let through —
 * therefore throws *before* any insert. Left uncaught, the throw escapes
 * `projectRevenueOnce`'s loop, and because discovery is `ORDER BY site_id LIMIT
 * 25` the same poisoned site is rediscovered every tick and **every site sorting
 * after it never projects again**. One customer's bad row would freeze an
 * unbounded set of other customers' revenue, permanently and silently.
 *
 * Caught here, the poisoned site is skipped for the tick, counted, logged with
 * its id, and every other site in the batch drains normally. Nothing is marked
 * for it, so the head is still due — the moment the data or the code is fixed it
 * projects, with no backfill needed.
 */
async function projectSite(
  deps: RevenueProjectionDeps,
  input: { siteId: string; batchSize: number },
): Promise<SiteOutcome> {
  // Declared outside the `try` so the failure branch can report how far the
  // batch got, which is what separates "the insert failed" (rows equals the
  // batch size) from "a head could not be read" (rows is where it died).
  const rows: RevenueEventRow[] = []
  let unavailable = 0

  try {
    const reportingCurrency = await readSiteReportingCurrency(deps.db, input.siteId)
    if (reportingCurrency === null) {
      // The site was discovered from `revenue_objects` and its `sites` row is
      // gone — a purge ran between the two reads. Skipped rather than defaulted:
      // materializing a whole site's reporting amounts under a guessed currency
      // is worse than not materializing them, and the heads are about to be
      // deleted anyway.
      deps.logger.warn('revenue_projection_site_missing', {
        site_id: input.siteId,
        retryable: false,
      })
      return { status: 'skipped', rows: 0, marked: 0, unavailable: 0 }
    }

    const heads = await listUnprojectedRevenueObjects(deps.db, {
      siteId: input.siteId,
      limit: input.batchSize,
    })
    if (heads.length === 0) return { status: 'ok', rows: 0, marked: 0, unavailable: 0 }

    // Hints are looked up per provider, because `revenue_match_hints` is keyed
    // by it: two providers could in principle mint the same PaymentIntent-shaped
    // id, and a cross-provider join would attribute one site's checkout to
    // another provider's charge.
    const hintsByProvider = new Map<string, Map<string, RevenueMatchHintRow>>()
    for (const provider of new Set(heads.map((head) => head.provider))) {
      const orderIds = heads
        .filter((head) => head.provider === provider)
        .map((head) => head.normalized.order_id)
      hintsByProvider.set(
        provider,
        await readRevenueMatchHintsByOrder(deps.db, {
          siteId: input.siteId,
          provider,
          orderIds,
        }),
      )
    }

    const rates = createRateCache(deps)
    const marks: { id: string; version: number; epoch: number }[] = []

    for (const head of heads) {
      const conversion = await planHeadConversion(rates, {
        currency: head.normalized.currency,
        reportingCurrency,
        occurredAt: head.normalized.occurred_at,
      })
      if (conversion.source === 'unavailable') {
        unavailable += 1
        deps.metrics.increment(WORKER_METRICS.revenueConversionUnavailable, {
          currency: head.normalized.currency,
          reason: conversion.reason,
        })
      }

      rows.push(
        buildRevenueEventRow({
          head,
          reportingCurrency,
          conversion,
          hint: hintsByProvider.get(head.provider)?.get(head.normalized.order_id) ?? null,
          identityKey: deps.identityKey,
        }),
      )
      // The epoch travels with the mark so a re-materialization that landed
      // while this batch was in flight is not overwritten by it — see
      // `markRevenueObjectsProjected`.
      marks.push({ id: head.id, version: head.version, epoch: head.projectionEpoch })
    }

    const inserted = await deps.store.insertRows(rows)
    // Only after the insert has RESOLVED. See the module header: a crash here
    // re-projects rows the token then drops, which is the safe direction.
    const { marked } = await markRevenueObjectsProjected(deps.db, { marks })

    deps.metrics.increment(WORKER_METRICS.revenueProjectionBatches, { site_id: input.siteId })
    deps.metrics.increment(WORKER_METRICS.revenueProjectedRows, {}, rows.length)
    deps.logger.info('revenue_projected', {
      site_id: input.siteId,
      rows: rows.length,
      marked,
      unavailable_conversions: unavailable,
      reporting_currency: reportingCurrency,
      // The token, not the rows. A re-projection that wrote nothing carries the
      // identical token, which is the evidence that it was deduplicated rather
      // than lost.
      dedup_token: inserted.token,
    })
    return { status: 'ok', rows: rows.length, marked, unavailable }
  } catch (err) {
    // Nothing is marked, so the same heads are due on the next tick — and, far
    // more importantly, the loop continues to the next site. The two ordinary
    // causes are a ClickHouse insert that failed (on a fresh deployment, almost
    // always the missing `oa_ingest` grant on `revenue_events`, which is an
    // entrypoint XML recreate rather than a SQL GRANT) and a malformed stored
    // snapshot that threw while its row was being built.
    deps.metrics.increment(WORKER_METRICS.revenueProjectionFailed, { reason: 'site' })
    deps.logger.error('revenue_projection_failed', {
      err,
      site_id: input.siteId,
      // How far the batch got before it threw, which is what separates "the
      // insert failed" (rows equals the batch size) from "a head could not be
      // read" (rows is where in the batch it died).
      rows: rows.length,
      retryable: true,
    })
    return { status: 'failed', rows: 0, marked: 0, unavailable }
  }
}

// --- Row building ------------------------------------------------------------

export interface BuildRevenueEventRowInput {
  readonly head: UnprojectedRevenueObject
  readonly reportingCurrency: string
  readonly conversion: CurrencyConversionPlan
  readonly hint: RevenueMatchHintRow | null
  readonly identityKey: IdentityKey
}

/**
 * One head → one ClickHouse fact row.
 *
 * **Pure, and a pure function of `(head, reporting currency, rate plan, hint)`
 * alone.** That is a correctness requirement rather than a style, and it is the
 * single property the exactly-once story rests on: the insert's deduplication
 * token is a hash of the rows, so re-projecting an unchanged head after a crash
 * must rebuild a *byte-identical* row, or the token differs and the retry writes
 * a second fact at the same version.
 *
 * **`ingested_at` is therefore `head.updatedAt`, not a clock.** It was the tick
 * clock in the first draft of CP3 and that silently destroyed the guarantee: the
 * replay after "insert succeeded, marker never landed" runs on a later tick, so
 * the clock differs, so the row differs, so the token differs, so ClickHouse
 * accepts a duplicate. `updatedAt` is stable per `(head, version)` — the object
 * head only rewrites it when it applies a new version — so an unchanged head
 * projects to the same bytes forever, while a genuinely new version brings a new
 * `updatedAt` and a new token with it.
 *
 * The column keeps its meaning: it is when this *state* became ours, which is
 * exactly what a freshness reader wants, and is strictly better than "when a
 * worker happened to copy it".
 */
export function buildRevenueEventRow(input: BuildRevenueEventRowInput): RevenueEventRow {
  const { head, conversion } = input
  const normalized = head.normalized
  // Uppercase for the arithmetic (the exponent table and the rate rows are keyed
  // that way); lowercase on the row, because `currency` carries the provider's
  // own lowercase ISO-4217 and a fact whose two currency columns disagree on
  // case makes `currency = reporting_currency` — the obvious "was this
  // converted?" predicate — quietly false for every unconverted row.
  const reportingCurrency = input.reportingCurrency.toUpperCase()

  const reportingGross = convertMinorAmount({
    amountMinor: normalized.gross_minor,
    fromCurrency: normalized.currency,
    toCurrency: reportingCurrency,
    conversion,
  })
  const reportingNet = convertMinorAmount({
    amountMinor: normalized.net_minor,
    fromCurrency: normalized.currency,
    toCurrency: reportingCurrency,
    conversion,
  })

  // The site's own user id, from the head when the charge carried one and
  // otherwise from the checkout hint. `resolveRevenueExternalUserId` records
  // which of D5's sources are still out of reach in CP3 and why.
  const externalUserId = resolveRevenueExternalUserId({
    clientReferenceId: normalized.client_reference_id,
    hintClientReferenceId: input.hint?.clientReferenceId,
  })
  // The hint's customer is the fallback for a charge that carries none — a
  // Checkout-created charge does not always name the customer directly.
  const customerId =
    normalized.customer_id !== '' ? normalized.customer_id : (input.hint?.customerId ?? '')

  return {
    site_id: head.siteId,
    provider: head.provider,
    object_id: head.objectId,
    object_kind: head.objectKind,
    version: head.version,
    occurred_at: toClickHouseInstant(normalized.occurred_at),
    status: normalized.status,
    livemode: normalized.livemode ? 1 : 0,
    currency: normalized.currency,
    gross_minor: normalized.gross_minor,
    fee_minor: normalized.fee_minor,
    // Carried through verbatim rather than defaulted to `currency`. It is
    // `''` for every fee the adapter could not read, and collapsing that into
    // the object's own currency would relabel an unread fee as an observed zero
    // (migration 0019).
    fee_currency: normalized.fee_currency,
    net_minor: normalized.net_minor,
    // Lowercase, matching `currency` above — see the case note where
    // `reportingCurrency` is derived.
    reporting_currency: reportingCurrency.toLowerCase(),
    // Null from `convertMinorAmount` means exactly one thing: no usable rate.
    // The zeros are written beside the flag that says so, and the read layer is
    // contractually required to treat the pair as an unconverted remainder
    // rather than as revenue of zero.
    reporting_gross_minor: reportingGross ?? 0,
    reporting_net_minor: reportingNet ?? 0,
    conversion_source: conversion.source,
    conversion_rate: conversion.rate,
    conversion_rate_date: conversion.rateDate ?? NO_RATE_DATE,
    parent_object_id: normalized.parent_object_id,
    order_id: normalized.order_id,
    // The two the charge payload never carries. They come from the checkout hint
    // when one matched, and are empty otherwise — an unmatched transaction is a
    // first-class outcome (D6), it simply has no journey.
    checkout_session_id:
      normalized.checkout_session_id !== ''
        ? normalized.checkout_session_id
        : (input.hint?.checkoutSessionId ?? ''),
    client_reference_id:
      normalized.client_reference_id !== ''
        ? normalized.client_reference_id
        : (input.hint?.clientReferenceId ?? ''),
    subscription_id: normalized.subscription_id,
    product_id: normalized.product_id,
    product_name: normalized.product_name,
    // Two different purpose tags over the same secret, and the separation is the
    // decision: this one is a pseudonym that must NOT collide with a `user_id`,
    // the next one must equal one byte for byte.
    customer_hash:
      customerId === ''
        ? ''
        : revenueCustomerHash({
            siteId: head.siteId,
            customerId,
            key: input.identityKey,
          }).customerHash,
    external_user_hash:
      externalUserId === ''
        ? ''
        : externalUserIdHash({
            siteId: head.siteId,
            externalUserId,
            key: input.identityKey,
          }).userId,
    // Derived rather than stored on the head, because the head does not record
    // which path last wrote it and adding a column for a diagnostic would be a
    // migration for a label. A head whose ledger receipt came from the sync walk
    // and one that came from a webhook are indistinguishable *by state*, which
    // is the design (both land in the same head, that is why overlap is free) —
    // so this reports the honest thing it can know: whether the object was ever
    // updated after it was first seen. CP4 can promote it to a real column if a
    // read surface ever needs the true provenance.
    ingested_via: head.updatedAt.getTime() > head.firstSeenAt.getTime() ? 'webhook' : 'backfill',
    // Stable per (head, version) — see the doc comment. Never a clock.
    ingested_at: toClickHouseInstant(head.updatedAt.toISOString()),
  }
}

/** ISO-8601 → ClickHouse `DateTime64(3)` literal, `YYYY-MM-DD HH:MM:SS.mmm`. */
function toClickHouseInstant(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace('Z', '')
}

// --- Rates -------------------------------------------------------------------

export interface RateCache {
  plan(input: {
    currency: string
    reportingCurrency: string
    occurredAt: string
  }): Promise<CurrencyConversionPlan>
}

/**
 * Per-tick rate lookups, memoized on `(currency, date)`.
 *
 * A ninety-day backfill converts thousands of charges that overwhelmingly share
 * a handful of currencies and a few dozen dates, so the uncached shape would be
 * two index lookups per transaction for an answer that does not change within a
 * tick. The cache lives for one `projectSite` call and is thrown away — long
 * enough to matter, short enough that an ECB refresh is picked up on the next
 * batch rather than at process restart.
 */
export function createRateCache(deps: { readonly db: Database }): RateCache {
  const cache = new Map<string, RateAtDate | null>()

  const lookup = async (currency: string, onOrBefore: string): Promise<RateAtDate | null> => {
    const key = `${currency.toUpperCase()}|${onOrBefore}`
    const hit = cache.get(key)
    if (hit !== undefined) return hit

    const row = await readCurrencyRate(deps.db, { currency, onOrBefore })
    // The lookback bound is applied HERE rather than in the query, so the reason
    // a conversion failed stays distinguishable: "no rate at all" and "a rate too
    // old to use" are the same SQL result and very different operational
    // problems. The repository's own query is deliberately unbounded for that
    // reason.
    const usable =
      row !== null && isRateWithinLookback(row.rateDate, onOrBefore)
        ? { ratePerEur: row.ratePerEur, rateDate: row.rateDate }
        : null
    cache.set(key, usable)
    return usable
  }

  return {
    async plan({ currency, reportingCurrency, occurredAt }) {
      const from = currency.toUpperCase()
      const to = reportingCurrency.toUpperCase()
      if (from === to) {
        return planCurrencyConversion({
          fromCurrency: from,
          toCurrency: to,
          fromRate: null,
          toRate: null,
        })
      }
      // Anchored on the transaction's own UTC date, never on today's: a ninety-
      // day backfill must convert a charge from June at June's rate, or every
      // historical total would silently move whenever the euro did.
      const onOrBefore = conversionDateOf(occurredAt)
      const [fromRate, toRate] = await Promise.all([
        lookup(from, onOrBefore),
        lookup(to, onOrBefore),
      ])
      return planCurrencyConversion({
        fromCurrency: from,
        toCurrency: to,
        fromRate,
        toRate,
      })
    },
  }
}

async function planHeadConversion(
  rates: RateCache,
  input: { currency: string; reportingCurrency: string; occurredAt: string },
): Promise<CurrencyConversionPlan> {
  return await rates.plan(input)
}

// --- Observability -----------------------------------------------------------

/**
 * Publish the projection lag gauge, zero-filled.
 *
 * The age of the OLDEST unprojected change, not the newest — see the metric's
 * own comment. Zero when nothing is pending, for the reason every backlog gauge
 * in this worker is zero-filled: a series that exists only while the loop is
 * behind is indistinguishable from a loop that stopped running, and an alert on
 * it would stay dark exactly when it mattered.
 */
async function publishLag(deps: RevenueProjectionDeps, now: Date): Promise<void> {
  const oldest = await readOldestUnprojectedRevenueChange(deps.db)
  const lagMs = oldest === null ? 0 : Math.max(0, now.getTime() - oldest.getTime())
  deps.metrics.gauge(WORKER_METRICS.revenueProjectionLagMs, lagMs, {})
}

// --- The loop ----------------------------------------------------------------

export interface RevenueProjectionLoop {
  stop(): Promise<void>
}

/**
 * The interval loop, in the `email-drain.ts` shape: a re-entrancy guard, an
 * unref'd timer so the loop alone never keeps the process alive, and a `stop`
 * that drains an in-flight tick.
 *
 * The stop flag is threaded *into* the tick rather than only guarding its start,
 * so a shutdown during a large drain cuts between sites instead of waiting out
 * every batch. Cutting there loses nothing: each site's marker is durable before
 * the next site is touched.
 */
export function startRevenueProjection(deps: RevenueProjectionDeps): RevenueProjectionLoop {
  let running = false
  let stopped = false

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const result = await projectRevenueOnce({ ...deps, stopped: () => stopped })
      if (result.rows > 0 || result.failed > 0) {
        deps.logger.info('revenue_projection_swept', { ...result })
      }
    } catch (err) {
      // A throw here is a bug or a Postgres outage. Logged and swallowed: this
      // loop shares a process with batch ingest and email delivery, and an
      // unhandled rejection would take both down over a revenue projection.
      deps.metrics.increment(WORKER_METRICS.revenueProjectionFailed, { reason: 'tick' })
      deps.logger.error('revenue_projection_tick_failed', { err, retryable: true })
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
