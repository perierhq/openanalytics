import { createHash } from 'node:crypto'
import { createClient, type ClickHouseClient } from '@clickhouse/client'

/**
 * The subscription lifecycle store (Perier fork, DataFast gap 7; migration
 * 0031).
 *
 * Insert-only for the worker, exactly like `revenue-events.ts`: the projection
 * builds rows that are a pure function of a Postgres head at one version, and
 * the content-derived `insert_deduplication_token` makes a replay after a crash
 * between insert and mark a no-op. The reads live in the query gateway, under
 * its read-only credential.
 */

export const SUBSCRIPTION_LIFECYCLE_TABLE = 'subscription_lifecycle'
export const SUBSCRIPTION_INVOICES_TABLE = 'subscription_invoices'

export interface SubscriptionLifecycleRow {
  readonly site_id: string
  readonly provider: string
  readonly subscription_id: string
  readonly seq: number
  readonly generation: number
  readonly kind: string
  /** `YYYY-MM-DD hh:mm:ss.sss`, UTC. */
  readonly occurred_at: string
  readonly status: string
  readonly livemode: number
  readonly billing_interval: string
  readonly currency: string
  readonly mrr_delta_minor: number
  readonly reporting_currency: string
  readonly reporting_mrr_delta_minor: number
  readonly conversion_source: string
  readonly active_delta: number
  readonly trial_delta: number
  readonly customer_hash: string
  readonly ingested_at: string
}

export interface SubscriptionInvoiceRow {
  readonly site_id: string
  readonly provider: string
  readonly invoice_id: string
  readonly generation: number
  readonly subscription_id: string
  readonly billing_reason: string
  readonly purchase_kind: string
  readonly order_id: string
  readonly charge_id: string
  readonly occurred_at: string
  readonly ingested_at: string
}

export interface SubscriptionLifecycleStoreOptions {
  readonly url: string
  readonly username: string
  readonly password: string
  readonly database: string
  readonly requestTimeoutMs?: number
}

export interface SubscriptionLifecycleStore {
  insertLifecycleRows(
    rows: readonly SubscriptionLifecycleRow[],
  ): Promise<{ readonly token: string | null }>
  insertInvoiceRows(
    rows: readonly SubscriptionInvoiceRow[],
  ): Promise<{ readonly token: string | null }>
  close(): Promise<void>
}

/** The insert token: the table name and the rows, hashed. Identical batches
 * deduplicate, which is the only replay a projection can produce. */
export function subscriptionLifecycleToken(table: string, rows: readonly unknown[]): string {
  return createHash('sha256')
    .update(table)
    .update('\n')
    .update(JSON.stringify(rows))
    .digest('hex')
    .slice(0, 32)
}

export function createSubscriptionLifecycleStore(
  options: SubscriptionLifecycleStoreOptions,
): SubscriptionLifecycleStore {
  const client: ClickHouseClient = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
    request_timeout: options.requestTimeoutMs ?? 60_000,
    clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 },
  })

  const insert = async (table: string, rows: readonly object[]) => {
    if (rows.length === 0) return { token: null }
    const token = subscriptionLifecycleToken(table, rows)
    await client.insert({
      table,
      values: rows as object[],
      format: 'JSONEachRow',
      clickhouse_settings: { insert_deduplication_token: token },
    })
    return { token }
  }

  return {
    insertLifecycleRows: async (rows) => await insert(SUBSCRIPTION_LIFECYCLE_TABLE, rows),
    insertInvoiceRows: async (rows) => await insert(SUBSCRIPTION_INVOICES_TABLE, rows),
    async close() {
      await client.close()
    },
  }
}
