import type { components } from '@openanalytics/contracts'
import { zonedDayStart } from '@openanalytics/domain'

/**
 * Subscription lifecycle reads (Perier fork, DataFast gap 7): the pure half.
 *
 * The service runs the three gateway operations of ClickHouse 0031
 * (`subscription_lifecycle_totals`, `subscription_timeseries_day`,
 * `revenue_purchase_kinds`); everything that turns their rows into the wire
 * shapes lives here, apart from the service class, so it can be tested without
 * a gateway and so neighbouring gaps rebasing `service.ts` meet one small block.
 */

type Schemas = components['schemas']

/** ClickHouse JSON scalars: UInt64/Int64 arrive as strings. */
function n(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function s(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/** `YYYY-MM-DD HH:MM:SS(.mmm)` in UTC (see `bucketToIso` in service.ts) → epoch ms. */
function bucketMs(value: unknown): number {
  const raw = s(value)
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?Z?$/.exec(raw)
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3] ?? ''}Z`) : Date.parse(raw)
}

type Movements = Pick<
  Schemas['SubscriptionTotals'],
  | 'new_mrr_minor'
  | 'expansion_mrr_minor'
  | 'contraction_mrr_minor'
  | 'churned_mrr_minor'
  | 'new_subscriptions'
  | 'churned_subscriptions'
  | 'trials_started'
  | 'trials_converted'
  | 'trials_expired'
  | 'cancels_scheduled'
  | 'cancels_undone'
>

const MOVEMENT_KEYS: readonly (keyof Movements)[] = [
  'new_mrr_minor',
  'expansion_mrr_minor',
  'contraction_mrr_minor',
  'churned_mrr_minor',
  'new_subscriptions',
  'churned_subscriptions',
  'trials_started',
  'trials_converted',
  'trials_expired',
  'cancels_scheduled',
  'cancels_undone',
]

function movements(row: Record<string, unknown> | undefined): Movements {
  const out = {} as Record<keyof Movements, number>
  for (const key of MOVEMENT_KEYS) out[key] = n(row?.[key])
  return out
}

/** The totals row, or all zeros for a site with no subscription facts. */
export function mapSubscriptionTotals(
  row: Record<string, unknown> | undefined,
  currency: string,
): Schemas['SubscriptionTotals'] {
  return {
    currency,
    mrr_start_minor: n(row?.['mrr_start_minor']),
    mrr_end_minor: n(row?.['mrr_end_minor']),
    active_start: n(row?.['active_start']),
    active_end: n(row?.['active_end']),
    trialing_start: n(row?.['trialing_start']),
    trialing_end: n(row?.['trialing_end']),
    ...movements(row),
    unconverted_subscriptions: n(row?.['unconverted_subscriptions']),
  }
}

const PURCHASE_KINDS: readonly Schemas['SubscriptionPurchaseKind'][] = [
  'new',
  'renewal',
  'plan_change',
  'one_off',
]

/** A stored purchase kind, or null for '' (a refund or dispute) and anything unknown. */
export function purchaseKindOrNull(value: unknown): Schemas['SubscriptionPurchaseKind'] | null {
  const raw = s(value)
  return (PURCHASE_KINDS as readonly string[]).includes(raw)
    ? (raw as Schemas['SubscriptionPurchaseKind'])
    : null
}

/** The purchase-kind rows in enum order; a row with a kind outside the enum is dropped. */
export function mapPurchaseKinds(
  rows: readonly Record<string, unknown>[],
): Schemas['SubscriptionPurchaseKindRow'][] {
  const byKind = new Map<string, Record<string, unknown>>()
  for (const row of rows) byKind.set(s(row['purchase_kind']), row)
  const out: Schemas['SubscriptionPurchaseKindRow'][] = []
  for (const kind of PURCHASE_KINDS) {
    const row = byKind.get(kind)
    if (row === undefined) continue
    out.push({
      purchase_kind: kind,
      charges: n(row['charges']),
      charge_gross_minor: n(row['reporting_gross_minor']),
      unconverted_count: n(row['unconverted_count']),
    })
  }
  return out
}

/**
 * The daily series: every site-local day that overlaps `[from, to)`, levels run
 * forward from the range's `*_start` values, days without a movement filled
 * with zero movements and the previous day's levels.
 *
 * A day is labelled by its local midnight as a UTC instant, exactly what the
 * gateway's `toStartOfDay(occurred_at, tz)` produces, so a movement row lands on
 * the day it belongs to. The first day can begin before `from` when the range
 * does not start at local midnight; only the movements inside the range are in
 * it, which is what the gateway read was bounded by.
 */
export function buildSubscriptionSeries(input: {
  readonly rows: readonly Record<string, unknown>[]
  readonly start: { mrr: number; active: number; trialing: number }
  readonly from: string
  readonly to: string
  readonly timezone: string
  readonly currency: string
}): Schemas['SubscriptionTimeseriesPoint'][] {
  const byDay = new Map<number, Record<string, unknown>>()
  for (const row of input.rows) byDay.set(bucketMs(row['bucket']), row)

  const toMs = Date.parse(input.to)
  let mrr = input.start.mrr
  let active = input.start.active
  let trialing = input.start.trialing
  const series: Schemas['SubscriptionTimeseriesPoint'][] = []
  for (
    let day = zonedDayStart(new Date(input.from), input.timezone);
    day.getTime() < toMs;
    day = zonedDayStart(day, input.timezone, { days: 1 })
  ) {
    const row = byDay.get(day.getTime())
    const net = n(row?.['net_mrr_minor'])
    mrr += net
    active += n(row?.['active_delta'])
    trialing += n(row?.['trial_delta'])
    series.push({
      bucket: day.toISOString(),
      currency: input.currency,
      mrr_minor: mrr,
      active,
      trialing,
      net_mrr_minor: net,
      ...movements(row),
    })
  }
  return series
}
