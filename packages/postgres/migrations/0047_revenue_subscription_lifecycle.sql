-- Subscription lifecycle and invoice hints (Perier fork, DataFast gap 7).
--
-- Rollout note: expand-only. Three brand-new tables and one widened CHECK on
-- `revenue_sync_state`. Nothing existing is rewritten or backfilled: the new
-- tables start empty and fill from the next `customer.subscription.*` /
-- `invoice.*` webhook and from the lifecycle half of the next sync pass (which
-- walks `subscriptions` and `invoices` after the three money resources). An app
-- rollback inside the compatibility window leaves the tables unused; the wider
-- CHECK accepts every value the older app writes.
--
-- Rollback (manual, only if the feature is abandoned -- there is no down
-- runner, D-214):
--   DROP TABLE revenue_invoices, revenue_subscription_changes, revenue_subscriptions;
--   DELETE FROM revenue_sync_state WHERE resource IN ('subscriptions', 'invoices');
--   ALTER TABLE revenue_sync_state DROP CONSTRAINT revenue_sync_state_resource_check,
--     ADD CONSTRAINT revenue_sync_state_resource_check
--     CHECK (resource IN ('charges', 'refunds', 'disputes'));
--
-- WHY NONE OF THIS TOUCHES `revenue_objects`
--
-- Money keeps its own head and its own three-way decision. A subscription is
-- not money -- a renewal is still a charge, already in `revenue_objects` -- and
-- an invoice here carries no amount at all. Every table below is beside money,
-- for the same reason `revenue_match_hints` is (0028): a row that is wrong,
-- late or missing can change a label or an MRR line, never a revenue total.

-- ============================================================================
-- Subscription heads
-- ============================================================================
--
-- The provider's subscription, normalized (`RevenueSubscriptionSnapshot`), under
-- the SAME ordering rule as a money head: `decideRevenueObject` over
-- `(snapshot_at, payload_hash)`, a monotonic `version` minted under the row
-- lock, and `projected_version` as the per-row projection marker (0028 explains
-- why a marker and not a timestamp watermark).
--
-- `version` also moves when a NEW change row (below) lands for the
-- subscription, without the snapshot moving: the projected lifecycle is a
-- function of the snapshot AND its changes, so a change must re-queue it. The
-- three-way decision only compares `snapshot_at`/`payload_hash`, so a version
-- bumped this way never makes a later snapshot look older or equal.
--
-- No projection epoch: the subscription projection writes every fact under the
-- head's version as its ClickHouse generation, and a reporting-currency
-- restatement for subscriptions is out of scope until the money side's own
-- re-materialization is (see `revenue_objects.projection_epoch`, TODO(CP5)).

CREATE TABLE revenue_subscriptions (
  id                 uuid PRIMARY KEY,
  site_id            uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  provider           text NOT NULL,
  -- The provider's own subscription id (`sub_...`).
  subscription_id    text NOT NULL,
  -- Webhook: the event's `created`. Backfill: the subscription's own `created`.
  snapshot_at        timestamptz NOT NULL,
  payload_hash       text NOT NULL,
  version            bigint NOT NULL DEFAULT 1,
  -- `RevenueSubscriptionSnapshot`. The customer is the provider's opaque id;
  -- no email, name or address is ever stored here.
  normalized         jsonb NOT NULL,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  projected_version  bigint NOT NULL DEFAULT 0,

  CONSTRAINT revenue_subscriptions_site_subscription_key
    UNIQUE (site_id, provider, subscription_id),
  CONSTRAINT revenue_subscriptions_version_check CHECK (version >= 1),
  CONSTRAINT revenue_subscriptions_projected_version_check
    CHECK (projected_version >= 0 AND projected_version <= version)
);

-- The projection loop's discovery query; partial, so it is the size of the
-- unfinished set (0028's `revenue_objects_unprojected_idx`, again).
CREATE INDEX revenue_subscriptions_unprojected_idx
  ON revenue_subscriptions (site_id, updated_at)
  WHERE projected_version < version;

-- ============================================================================
-- Subscription changes
-- ============================================================================
--
-- What a snapshot cannot say: that the plan was cheaper last month, or that a
-- cancellation was scheduled and undone. Read from Stripe's
-- `previous_attributes` on `customer.subscription.updated`
-- (`RevenueSubscriptionChange`). Insert-only, keyed by the provider EVENT id and
-- the kind, so a redelivery inserts nothing and one event can carry both a plan
-- change and a cancellation.

CREATE TABLE revenue_subscription_changes (
  id                 uuid PRIMARY KEY,
  site_id            uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  provider           text NOT NULL,
  subscription_id    text NOT NULL,
  provider_event_id  text NOT NULL,
  kind               text NOT NULL,
  occurred_at        timestamptz NOT NULL,
  -- Monthly-normalized MRR before and after, minor units of the subscription's
  -- own currency. Zero for the two cancellation kinds.
  from_mrr_minor     bigint NOT NULL DEFAULT 0,
  to_mrr_minor       bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT revenue_subscription_changes_event_key
    UNIQUE (site_id, provider, provider_event_id, kind),
  CONSTRAINT revenue_subscription_changes_kind_check
    CHECK (kind IN ('plan_changed', 'cancel_scheduled', 'cancel_undone'))
);

-- The projection's lookup: every change of a batch of subscriptions.
CREATE INDEX revenue_subscription_changes_subscription_idx
  ON revenue_subscription_changes (site_id, provider, subscription_id, occurred_at);

-- ============================================================================
-- Invoice hints
-- ============================================================================
--
-- An invoice reduced to the link between a payment and its subscription
-- (`RevenueInvoiceHint`): `billing_reason` is the only place Stripe says whether
-- a charge is a subscription's first payment or a renewal, and the charge itself
-- does not name its invoice (since basil). No amount column -- the money is on
-- the charge -- so a hint can relabel a charge and never re-price it.
--
-- Filled forward like `revenue_match_hints`: `invoice.paid` (basil) carries the
-- subscription but not the PaymentIntent, `invoice_payment.paid` carries the
-- PaymentIntent but not the subscription, and the row is the union. A populated
-- incoming value replaces anything, an empty one replaces nothing.
--
-- `version`/`projected_version` follow the head pattern: the upsert bumps
-- `version` only when the merged row actually differs, and the projection
-- writes `version` as the ClickHouse generation.

CREATE TABLE revenue_invoices (
  id                 uuid PRIMARY KEY,
  site_id            uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  provider           text NOT NULL,
  invoice_id         text NOT NULL,
  subscription_id    text NOT NULL DEFAULT '',
  billing_reason     text NOT NULL DEFAULT '',
  -- The PaymentIntent: a charge's `order_id`.
  order_id           text NOT NULL DEFAULT '',
  charge_id          text NOT NULL DEFAULT '',
  customer_id        text NOT NULL DEFAULT '',
  -- When the invoice was paid (`status_transitions.paid_at`), else the event's
  -- or the invoice's `created`.
  occurred_at        timestamptz NOT NULL,
  version            bigint NOT NULL DEFAULT 1,
  projected_version  bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT revenue_invoices_site_invoice_key UNIQUE (site_id, provider, invoice_id),
  CONSTRAINT revenue_invoices_version_check CHECK (version >= 1),
  CONSTRAINT revenue_invoices_projected_version_check
    CHECK (projected_version >= 0 AND projected_version <= version)
);

CREATE INDEX revenue_invoices_unprojected_idx
  ON revenue_invoices (site_id, updated_at)
  WHERE projected_version < version;

-- ============================================================================
-- The lifecycle resources of the sync walk
-- ============================================================================
--
-- One cursor per (credential, resource), exactly as for the money resources.
-- Widening a CHECK is an expand step: every value the older app writes is
-- still accepted.

ALTER TABLE revenue_sync_state
  DROP CONSTRAINT revenue_sync_state_resource_check;
ALTER TABLE revenue_sync_state
  ADD CONSTRAINT revenue_sync_state_resource_check
  CHECK (resource IN ('charges', 'refunds', 'disputes', 'subscriptions', 'invoices'));
