-- Subscription lifecycle facts and invoice purchase kinds (Perier fork, DataFast gap 7).
--
-- Two worker-written tables, projected from Postgres 0047 the way
-- `revenue_events` is projected from `revenue_objects`: a per-row marker in
-- Postgres says what is due, the row carries the head's monotonic version as
-- its replacing column, and a content-derived insert token makes a replay a
-- no-op. Neither table holds money. A renewal's amount stays in
-- `revenue_events` and in every revenue total, and these two only say what kind
-- of payment it was and how MRR moved.
--
-- Rollout note: additive. Two new tables, nothing existing altered. The worker
-- needs INSERT on both (infra/selfhost/clickhouse/oa-entrypoint.sh), which on
-- the self-hosted profile takes effect on a container RECREATE. Until then the
-- projection loop logs and retries, and the Postgres rows stay due.
--
-- Rollback (manual, only if the feature is abandoned):
--   DROP TABLE IF EXISTS subscription_lifecycle
--   DROP TABLE IF EXISTS subscription_invoices
--
-- Both are site deletion targets (`packages/domain/src/deletion.ts`), deleted
-- by the same delete-by-site statement as every other table.
--
-- Note on style: no comment in a migration file may contain a semicolon. The
-- runner splits statements on the semicolon before it strips comments.

-- ----------------------------------------------------------------------------
-- subscription_lifecycle
-- ----------------------------------------------------------------------------
--
-- One row per planned lifecycle fact (`planSubscriptionLifecycle`): trial
-- started, converted or expired, started paying, plan changed, cancellation
-- scheduled or undone, ended. MRR movements are signed and monthly-normalized,
-- in the subscription's own currency and converted to the site's reporting
-- currency at the fact's own date.
--
-- WHY `seq` IS IN THE KEY AND `generation` IS NOT
--
-- A subscription's planned list is recomputed from scratch at every head
-- version and can change length (a trial that converts gains two facts, a
-- reconciling plan change can appear or vanish). Keying by position means a
-- re-projection replaces the facts it still has, and the read rule below drops
-- the tail it no longer has: every read takes, per subscription, ONLY the rows
-- of its highest generation. A shorter list therefore never leaves a stale fact
-- counted, whether or not the parts have merged yet. A plan with no facts at
-- all (a subscription that never paid and had no trial) is written as one
-- `none` row so that it, too, supersedes whatever an earlier generation said.
--
-- No partition: replacement only happens inside a partition, and a fact's
-- `occurred_at` can move between generations (a trial end that Stripe extended),
-- so a time partition could strand the old row in another part forever. The
-- table is small by construction -- a handful of rows per subscription.

CREATE TABLE IF NOT EXISTS subscription_lifecycle
(
  site_id                    UUID,
  provider                   LowCardinality(String),
  subscription_id            String,
  -- Position in the planned list, 0-based.
  seq                        UInt16,
  -- `revenue_subscriptions.version`. The replacing column, and the read rule's
  -- "current generation" per subscription.
  generation                 UInt64,
  -- trial_started | trial_converted | trial_expired | started | plan_changed |
  -- cancel_scheduled | cancel_undone | ended | none
  kind                       LowCardinality(String),
  occurred_at                DateTime64(3, 'UTC'),
  -- The subscription as the provider last reported it. Diagnostic: the read
  -- counts come from the deltas, which also answer "how many on 1 March".
  status                     LowCardinality(String),
  livemode                   UInt8,
  -- day | week | month | year, the first licensed item's.
  billing_interval           LowCardinality(String),
  -- Lowercase ISO-4217, the subscription's own.
  currency                   LowCardinality(String),
  mrr_delta_minor            Int64,
  -- The site's reporting currency at projection time, lowercase, and the
  -- movement converted at the fact's date (ECB, as `revenue_events`). Zero with
  -- conversion_source = 'unavailable' when no rate was usable.
  reporting_currency         LowCardinality(String),
  reporting_mrr_delta_minor  Int64,
  conversion_source          LowCardinality(String),
  -- +1 when the subscription becomes paying, -1 when it churns.
  active_delta               Int8,
  -- +1 when a trial starts, -1 when it converts or expires.
  trial_delta                Int8,
  -- Site-scoped HMAC of the provider customer id (`revenueCustomerHash`), the
  -- same pseudonym `revenue_events.customer_hash` carries.
  customer_hash              String,
  -- `revenue_subscriptions.updated_at`: stable per (head, version), so a replay
  -- rebuilds byte-identical rows and the insert token deduplicates it.
  ingested_at                DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(generation)
ORDER BY (site_id, provider, subscription_id, seq)
SETTINGS non_replicated_deduplication_window = 1000;

-- ----------------------------------------------------------------------------
-- subscription_invoices
-- ----------------------------------------------------------------------------
--
-- One row per invoice: the link from a charge (by PaymentIntent `order_id` or
-- by charge id) to its `billing_reason`, and the purchase kind derived from it
-- (`purchaseKindFor`): new | renewal | plan_change | one_off, or '' while the
-- billing reason is still unknown (an `invoice_payment.paid` that arrived
-- before its `invoice.paid`). Charges are labelled by joining this at READ
-- time, so a late invoice relabels a charge without re-projecting it.

CREATE TABLE IF NOT EXISTS subscription_invoices
(
  site_id          UUID,
  provider         LowCardinality(String),
  invoice_id       String,
  -- `revenue_invoices.version`, the replacing column.
  generation       UInt64,
  subscription_id  String,
  billing_reason   LowCardinality(String),
  purchase_kind    LowCardinality(String),
  order_id         String,
  charge_id        String,
  occurred_at      DateTime64(3, 'UTC'),
  ingested_at      DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(generation)
ORDER BY (site_id, provider, invoice_id)
SETTINGS non_replicated_deduplication_window = 1000;
