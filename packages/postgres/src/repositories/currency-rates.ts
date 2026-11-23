import type { EcbDailyRates } from '@openanalytics/domain'
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { Executor } from '../client.ts'
import { currencyRates } from '../schema/revenue.ts'

/**
 * Currency reference rates (ADR-0033, D2c; migration 0034).
 *
 * **Global data.** There is no `site_id` in this table and no site-scoped
 * function in this module, which is the whole point: these are the ECB's
 * published rates, shared by every site's conversions, and the deletion
 * vocabulary deliberately excludes them (`deletion.ts` says so where a reader
 * would otherwise assume an omission).
 *
 * Rates are handled as **strings** end to end — parsed out of the ECB document
 * as an exact decimal, stored in a `numeric` column, read back as a string. A
 * rate is one multiplication away from money, and float money has been
 * forbidden since M0 (`packages/contracts/src/money.ts`, 03 §6.5). The one place
 * a number appears in this module is a row count.
 */

export interface UpsertCurrencyRatesResult {
  /** Rows written. Equal to the input length; a conflict is an update, not a
   * skip, because the ECB republishes the last banking day over weekends. */
  readonly written: number
}

/**
 * Write a day's rates, idempotently.
 *
 * `ON CONFLICT (rate_date, currency) DO UPDATE` rather than `DO NOTHING`, and
 * that is the weekend behaviour rather than an edge case: the ECB republishes
 * the previous banking day's file on Saturdays, Sundays and holidays, so the
 * loop legitimately sees the same `(date, currency)` several days running. An
 * update refreshes `fetched_at` — which is how "our rate table is being kept
 * alive" stays distinguishable from "our rate table stopped being written to"
 * on a long holiday weekend, when `rate_date` alone would look identically
 * stale in both cases.
 *
 * One statement rather than a loop: thirty-one rows is one round trip, and a
 * partial write here would leave a day half-converted with nothing to say so.
 */
export async function upsertCurrencyRates(
  db: Executor,
  input: { readonly rates: EcbDailyRates; readonly fetchedAt?: Date },
): Promise<UpsertCurrencyRatesResult> {
  if (input.rates.rates.length === 0) return { written: 0 }
  const fetchedAt = input.fetchedAt ?? new Date()

  await db
    .insert(currencyRates)
    .values(
      input.rates.rates.map((rate) => ({
        rateDate: input.rates.rateDate,
        currency: rate.currency,
        // The exact decimal string the provider published. Never `Number(...)`.
        ratePerEur: rate.ratePerEur,
        fetchedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [currencyRates.rateDate, currencyRates.currency],
      set: {
        ratePerEur: sqlExcluded('rate_per_eur'),
        fetchedAt,
      },
    })

  return { written: input.rates.rates.length }
}

export interface CurrencyRateRow {
  readonly rateDate: string
  readonly currency: string
  /** An exact decimal string, as `numeric` is read. */
  readonly ratePerEur: string
  readonly fetchedAt: Date
}

/**
 * The newest rate for a currency at or before a date — CP3's per-transaction
 * lookup.
 *
 * "At or before" rather than "on", because a transaction that happened on a
 * Sunday has no Sunday rate: the ECB publishes on banking days only. Falling
 * back to the last published day is what the ECB's own guidance describes, and
 * the returned `rateDate` is stored on the fact so a reader can see which day's
 * rate was actually used (03 §6.5's rate/time metadata) rather than assuming it
 * matched the transaction.
 *
 * Null means the currency is not one the ECB lists — the `conversion_source =
 * 'unavailable'` case, which stays visible in the read surface and is never a
 * silent zero.
 */
export async function readCurrencyRate(
  db: Executor,
  input: { readonly currency: string; readonly onOrBefore: string },
): Promise<CurrencyRateRow | null> {
  const [row] = await db
    .select()
    .from(currencyRates)
    .where(
      and(
        eq(currencyRates.currency, input.currency.toUpperCase()),
        lte(currencyRates.rateDate, input.onOrBefore),
      ),
    )
    .orderBy(desc(currencyRates.rateDate))
    .limit(1)
  return (row as CurrencyRateRow | undefined) ?? null
}

/** The most recent day this table holds anything for — the freshness signal the
 * CP3 conversion metadata and the worker's own gauge both read. */
export async function readLatestCurrencyRateDate(db: Executor): Promise<string | null> {
  const [row] = await db
    .select({ rateDate: currencyRates.rateDate })
    .from(currencyRates)
    .orderBy(desc(currencyRates.rateDate))
    .limit(1)
  return row?.rateDate ?? null
}

/**
 * `excluded.<column>` in an upsert's `SET`.
 *
 * Drizzle's `set` takes values rather than expressions, so the proposed row's
 * value has to be named explicitly. Written as a named helper rather than inline
 * so the column name appears once: a rename that missed a second occurrence
 * would leave a statement silently writing the *old* rate on every conflict,
 * which is the one failure this whole table exists to make impossible.
 */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`)
}

/**
 * Every rate for these currencies with a `rate_date` in `[from, to]` — the
 * Meta Ads campaigns read (migration 0052), which converts each day's spend at
 * that day's rate and would otherwise look one rate up per day. The caller
 * widens `from` by the lookback and picks, per day, the newest rate at or
 * before it.
 */
export async function listCurrencyRatesBetween(
  db: Executor,
  input: { readonly currencies: readonly string[]; readonly from: string; readonly to: string },
): Promise<CurrencyRateRow[]> {
  const currencies = [...new Set(input.currencies.map((code) => code.toUpperCase()))]
  if (currencies.length === 0) return []
  const rows = await db
    .select()
    .from(currencyRates)
    .where(
      and(
        inArray(currencyRates.currency, currencies),
        gte(currencyRates.rateDate, input.from),
        lte(currencyRates.rateDate, input.to),
      ),
    )
    .orderBy(asc(currencyRates.rateDate))
  return rows as CurrencyRateRow[]
}
