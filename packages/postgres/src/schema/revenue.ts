import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  integer,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import type {
  RevenueCredentialStatus,
  RevenueIngestSource,
  RevenueLedgerStatus,
  RevenueNormalizedObject,
  RevenueObjectKind,
  RevenueLifecycleSyncResource,
  RevenueSubscriptionSnapshot,
  RevenueSyncResource,
  SubscriptionChangeKind,
} from '@openanalytics/domain'
import { createdAt, idColumn, instant, primaryId, updatedAt } from './_shared.ts'
import { sites } from './sites.ts'
import { users } from './auth.ts'

/**
 * Revenue provider credentials (mirror of migration 0033; ADR-0033 D3).
 *
 * The first table in the repository holding an encrypted value. The cipher and
 * the keyring live in `packages/integrations/src/credential-vault.ts`; what this
 * mirror carries is the shape that makes the guarantees checkable — the key
 * version stored in plaintext beside the ciphertext, and the CHECK that forbids
 * a disabled row from holding either ciphertext at all.
 *
 * `sites.reporting_currency` (the other half of 0033) lives on the `sites`
 * mirror, where the column belongs.
 */
export const revenueCredentials = pgTable(
  'revenue_credentials',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** AES-256-GCM, AAD-bound to `revenue_credential:{id}:{site_id}`. Nullable
     * because disconnect erases it in the same UPDATE that disables the row. */
    encryptedApiKey: text('encrypted_api_key'),
    encryptedWebhookSecret: text('encrypted_webhook_secret'),
    /** Which keyring version wrote the ciphertexts. Plaintext so a rotation
     * sweep can find every row still on an old key with a SELECT. */
    keyVersion: text('key_version').notNull(),
    /** Display only, and the only part of the secret a read surface returns. */
    apiKeyLast4: text('api_key_last4').notNull(),
    /** The opaque per-credential webhook address (D4): 32 random bytes,
     * base64url. Globally unique — it is what CP2's endpoint resolves from. */
    webhookToken: text('webhook_token').notNull(),
    status: text('status').$type<RevenueCredentialStatus>().notNull().default('active'),
    /** NO ACTION on the user: account deletion tombstones the row rather than
     * deleting it, so "who connected this" stays answerable. */
    createdByUserId: idColumn('created_by_user_id')
      .notNull()
      .references(() => users.id),
    connectedAt: instant('connected_at').notNull().defaultNow(),
    lastVerifiedAt: instant('last_verified_at'),
    /** Never touched by a failure: a degraded credential must keep reporting
     * when its data was last actually correct (D4's outage semantics). */
    lastSyncedAt: instant('last_synced_at'),
    lastWebhookAt: instant('last_webhook_at'),
    /** A safe category. It is rendered to the customer, so never a raw body. */
    lastError: text('last_error'),
    disabledAt: instant('disabled_at'),
    /**
     * Which backfill generation this credential is on (migration 0034).
     *
     * The job runner's idempotency key embeds it, so bumping the counter mints a
     * *new* key and a terminal backfill stops being a permanent loss of the
     * customer's history. Rotation and reconnection each bump it; the
     * one-live-job-per-`(type, subject)` index still forbids two concurrent
     * walks.
     */
    backfillGeneration: integer('backfill_generation').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One live credential per (site, provider). Partial, so a disconnect keeps
    // its row and a fresh connect inserts a new one instead of resurrecting it.
    uniqueIndex('revenue_credentials_live_key')
      .on(t.siteId, t.provider)
      .where(sql`status <> 'disabled'`),
    unique('revenue_credentials_webhook_token_key').on(t.webhookToken),
    index('revenue_credentials_site_idx').on(t.siteId, t.connectedAt.desc()),
    // The rotation sweep's scan; partial because a disabled row pins no key.
    index('revenue_credentials_key_version_idx')
      .on(t.keyVersion)
      .where(sql`encrypted_api_key IS NOT NULL`),
    check(
      'revenue_credentials_status_check',
      sql`${t.status} IN ('active', 'degraded', 'disabled')`,
    ),
    // Disconnect erases the secret, enforced at the database.
    check(
      'revenue_credentials_disabled_erased_check',
      sql`${t.status} <> 'disabled' OR (${t.encryptedApiKey} IS NULL AND ${t.encryptedWebhookSecret} IS NULL)`,
    ),
  ],
)

/**
 * The revenue delivery ledger (mirror of migration 0034; ADR-0033 D4).
 *
 * The M3 `webhook_events` shape plus a site dimension, and that column is the
 * whole reason it is a separate table: the billing ledger is single-account by
 * construction, so one Stripe account connected to two OA sites would collide on
 * `(provider, provider_event_id)` and the second site would silently never
 * ingest. Here the same `evt_…` is processed once *per site*.
 *
 * Webhook deliveries and sync rows share it on purpose. A backfill row has no
 * provider event id, so it is recorded under a deterministic synthetic one
 * (`revenueBackfillEventId`) — which is what makes the reconcile sweep's
 * trailing-window overlap free rather than duplicative.
 */
export const revenueProviderEvents = pgTable(
  'revenue_provider_events',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    credentialId: idColumn('credential_id')
      .notNull()
      .references(() => revenueCredentials.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    /** sha256 of what was observed. The body itself is never stored (D5). */
    payloadHash: text('payload_hash').notNull(),
    source: text('source').$type<RevenueIngestSource>().notNull(),
    status: text('status').$type<RevenueLedgerStatus>().notNull().default('received'),
    receivedAt: instant('received_at').notNull().defaultNow(),
    processedAt: instant('processed_at'),
    /** Categorized counts and decisions. Never a raw provider body. */
    result: jsonb('result').$type<Record<string, unknown>>(),
  },
  (t) => [
    unique('revenue_provider_events_site_event_key').on(t.siteId, t.provider, t.providerEventId),
    index('revenue_provider_events_site_idx').on(t.siteId, t.receivedAt.desc()),
    // The stuck-delivery scan; partial so it is the size of the unfinished set.
    // No consumer in CP2 — the re-drive sweep it exists for belongs with CP3
    // (see the repository module header for the gap it leaves open).
    index('revenue_provider_events_unsettled_idx')
      .on(t.credentialId, t.receivedAt)
      .where(sql`status = 'received'`),
    check('revenue_provider_events_source_check', sql`${t.source} IN ('webhook', 'backfill')`),
    check(
      'revenue_provider_events_status_check',
      sql`${t.status} IN ('received', 'processed', 'ignored', 'failed')`,
    ),
  ],
)

/**
 * The object head (mirror of migration 0034; ADR-0033 D4).
 *
 * One row per money object per site. `version` is minted locally under this
 * row's lock and is what CP3's `ReplacingMergeTree(version)` orders by — a
 * provider timestamp could not do that job, because Stripe's `created` is
 * second-granular and two different states of one charge routinely share a
 * second.
 *
 * `normalized` is the canonical provider-agnostic snapshot: integer minor units,
 * opaque provider ids, no raw body and no raw email at any depth.
 */
export const revenueObjects = pgTable(
  'revenue_objects',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    objectId: text('object_id').notNull(),
    objectKind: text('object_kind').$type<RevenueObjectKind>().notNull(),
    /** Webhook: the event's `created`. Sync: the object's own `created`. */
    snapshotAt: instant('snapshot_at').notNull(),
    payloadHash: text('payload_hash').notNull(),
    /** `mode: 'number'` because a version counter is far inside `2^53` and the
     * three-way decision arithmetic reads as arithmetic rather than as bigint
     * ceremony. The column stays `bigint` so the ceiling is the database's. */
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    normalized: jsonb('normalized').$type<RevenueNormalizedObject>().notNull(),
    firstSeenAt: instant('first_seen_at').notNull().defaultNow(),
    updatedAt: updatedAt(),
    /**
     * The projection watermark, per row (migration 0035; ADR-0033 D5).
     *
     * `0` means never projected. A head needs writing to
     * `analytics.revenue_events` exactly when `projected_version < version`, and
     * that predicate contains no clock — which is the whole reason it is a
     * column rather than a per-site timestamp watermark. `updated_at` is stamped
     * in application code inside the transaction that writes the head, so under
     * concurrency the timestamp order and the commit order are different orders,
     * and a timestamp watermark can step over a row that committed late with an
     * earlier stamp. The migration states this in full.
     *
     * Written with the *literal* version that was projected and guarded on being
     * strictly greater than what is stored, so a concurrent observation that
     * bumped the head between the read and the mark leaves the row selected
     * rather than losing the bump.
     */
    projectedVersion: bigint('projected_version', { mode: 'number' }).notNull().default(0),
    /**
     * The re-materialization epoch (migration 0035; ADR-0033 D2c/D5).
     *
     * Bumped by `resetRevenueProjection` in the same statement that zeroes the
     * marker, and carried through the projection so a mark can require it to be
     * unchanged. Without it a reset that lands mid-batch is silently undone: the
     * batch's `projected_version < 3` guard accepts a freshly-zeroed row (0 < 3)
     * and that head is excluded from the re-materialization forever. The
     * migration works the interleaving through step by step.
     */
    projectionEpoch: bigint('projection_epoch', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    unique('revenue_objects_site_object_key').on(t.siteId, t.provider, t.objectId),
    index('revenue_objects_site_updated_idx').on(t.siteId, t.updatedAt.desc()),
    index('revenue_objects_parent_idx')
      .on(t.siteId, t.provider, sql`(normalized ->> 'parent_object_id')`)
      .where(sql`object_kind <> 'charge'`),
    // The projection loop's discovery scan. Partial, so on a steady-state
    // installation the index is the size of the unfinished set — usually empty.
    index('revenue_objects_unprojected_idx')
      .on(t.siteId, t.updatedAt)
      .where(sql`projected_version < version`),
    check('revenue_objects_kind_check', sql`${t.objectKind} IN ('charge', 'refund', 'dispute')`),
    check('revenue_objects_version_check', sql`${t.version} >= 1`),
    check(
      'revenue_objects_projected_version_check',
      sql`${t.projectedVersion} >= 0 AND ${t.projectedVersion} <= ${t.version}`,
    ),
    check('revenue_objects_projection_epoch_check', sql`${t.projectionEpoch} >= 0`),
  ],
)

/**
 * Checkout match hints (mirror of migration 0035; ADR-0033 D6).
 *
 * The matching signal `checkout.session.completed` carries and the object head
 * deliberately does not: a Checkout Session's `client_reference_id` and the
 * PaymentIntent it created. CP2 stored nothing from that event; this is where it
 * goes, and the reason it is a table of its own rather than an observation is
 * that **it must not be able to corrupt money state.**
 *
 * `applyRevenueObservation` decides on `(snapshot_at, payload_hash)` under the
 * premise that one hash describes one complete state. A hints-only observation
 * would carry the checkout event's `created` — equal to the charge's `created`
 * in the ordinary case, because the charge is created *by* the checkout — so it
 * would land on the equal-timestamp-different-payload branch and spend a
 * provider request per checkout resolving a tie that is not about money. And if
 * it applied, it would bump `version` and rewrite `normalized`, the document
 * holding `gross_minor`/`fee_minor`/`net_minor`, either zeroing them or forcing
 * a partial-merge path that dissolves the one-hash-one-state invariant every
 * later comparison depends on.
 *
 * This table has no money column and is read by the projection as a left join on
 * `(site_id, provider, order_id)`. A hint that is wrong, duplicated or missing
 * changes which journey a charge is attributed to. It cannot change what the
 * charge was worth.
 *
 * `client_reference_id` is stored raw — it is the site's own opaque user id, and
 * `revenue_objects.normalized` has held it raw since CP2. Its HMAC is computed
 * in the **worker** at projection time (the api holds no identity secret and
 * must keep holding none). An email is never stored here in any form.
 */
export const revenueMatchHints = pgTable(
  'revenue_match_hints',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** The hint's own identity: a session completes once. */
    checkoutSessionId: text('checkout_session_id').notNull(),
    /** The PaymentIntent, which is the charge's `order_id` — the join key.
     * Empty for a session that completed without a payment, in which case the
     * hint is kept and simply joins to nothing. */
    orderId: text('order_id').notNull().default(''),
    clientReferenceId: text('client_reference_id').notNull().default(''),
    /** The provider's opaque customer id. Never an email. */
    customerId: text('customer_id').notNull().default(''),
    occurredAt: instant('occurred_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('revenue_match_hints_session_key').on(t.siteId, t.provider, t.checkoutSessionId),
    index('revenue_match_hints_order_idx')
      .on(t.siteId, t.provider, t.orderId)
      .where(sql`order_id <> ''`),
    index('revenue_match_hints_site_idx').on(t.siteId, t.occurredAt.desc()),
  ],
)

/**
 * Per-`(credential, resource)` sync cursors (mirror of migration 0034; D4).
 *
 * Written after **every** page, which is what makes a crashed backfill resume
 * mid-resource rather than restart: a 90-day walk of a busy account is thousands
 * of objects, and restarting from the top on each worker restart would be a job
 * that never finishes on exactly the accounts that most need it.
 */
export const revenueSyncState = pgTable(
  'revenue_sync_state',
  {
    id: primaryId(),
    credentialId: idColumn('credential_id')
      .notNull()
      .references(() => revenueCredentials.id, { onDelete: 'cascade' }),
    /** Denormalized from the credential so the purge and every read are
     * site-scoped without a join. */
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    resource: text('resource')
      .$type<RevenueSyncResource | RevenueLifecycleSyncResource>()
      .notNull(),
    /** The provider's own opaque cursor, stored verbatim and never parsed. */
    cursor: text('cursor'),
    windowStart: instant('window_start'),
    windowEnd: instant('window_end'),
    completedAt: instant('completed_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('revenue_sync_state_credential_resource_key').on(t.credentialId, t.resource),
    index('revenue_sync_state_site_idx').on(t.siteId),
    check(
      'revenue_sync_state_resource_check',
      sql`${t.resource} IN ('charges', 'refunds', 'disputes', 'subscriptions', 'invoices')`,
    ),
  ],
)

/**
 * ECB daily reference rates (mirror of migration 0034; ADR-0033 D2c).
 *
 * **Global reference data with no `site_id`, and explicitly not a deletion
 * target.** These are the European Central Bank's published rates, shared by
 * every site's conversions; a site deletion that removed them would corrupt
 * every other tenant's historical reporting.
 *
 * `rate_per_eur` is `numeric` and is written as a *string* end to end — a rate
 * is one multiplication away from money, and float money has been forbidden
 * since M0.
 */
export const currencyRates = pgTable(
  'currency_rates',
  {
    /** The ECB's own banking-day stamp, not our fetch date. */
    rateDate: date('rate_date').notNull(),
    currency: text('currency').notNull(),
    ratePerEur: numeric('rate_per_eur').notNull(),
    fetchedAt: instant('fetched_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'currency_rates_pkey', columns: [t.rateDate, t.currency] }),
    index('currency_rates_currency_date_idx').on(t.currency, t.rateDate.desc()),
    check('currency_rates_currency_format', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('currency_rates_positive', sql`${t.ratePerEur} > 0`),
  ],
)

/**
 * The attribution job's per-site control state (mirror of migration 0036;
 * ADR-0033 D6). Milestone 12 Checkpoint 4.
 *
 * `session_finalizer_state` again, deliberately: per-site lease, monotonic
 * watermark, run counter. The attribution job is the finalizer idiom applied to
 * a different fact, and a second shape for the same problem would be a second
 * set of lease bugs.
 *
 * `computed_through` is **not** "everything before this is finished" — an
 * attribution depends on signals that arrive after the charge (a conversion
 * event up to 24 h late, a session that is not finalized until inactivity plus
 * that lateness has passed). It means "the instant whose inputs this site has
 * been computed against", and it is read twice: by discovery (a site is due when
 * a head or hint changed after it, or when it is older than the refresh
 * interval) and as the floor of the rolling recompute horizon (the epoch on a
 * fresh site, which is what makes the first run cover a backfill).
 */
export const revenueAttributionState = pgTable(
  'revenue_attribution_state',
  {
    // Integrity only, no cascade — the sites row becomes a tombstone rather than
    // being deleted, and `postgres_purge` removes this row explicitly so the
    // deletion target can record how many it removed.
    siteId: idColumn('site_id')
      .primaryKey()
      .references(() => sites.id),
    computedThrough: instant('computed_through')
      .notNull()
      .default(sql`'epoch'`),
    /** Monotonic run counter. A durable advance proof, never the version source. */
    runSeq: bigint('run_seq', { mode: 'number' }).notNull().default(0),
    claimedBy: text('claimed_by'),
    leaseExpiresAt: instant('lease_expires_at'),
    lastRunAt: instant('last_run_at'),
    /**
     * The full-site rollup re-roll floor (migration 0037; ADR-0033 D2c/D7).
     *
     * Non-null means "the reporting currency changed and buckets older than the
     * rolling horizon still hold amounts in the previous one". Set by the
     * reporting-currency PATCH in the same transaction as the projection reset;
     * cleared only by a pass that also observes the site fully re-projected, so
     * a rollup that ran ahead of the projection cannot declare the job done.
     */
    rollupRecomputeFrom: instant('rollup_recompute_from'),
    /**
     * The per-site swap-generation counter (migration 0037).
     *
     * Bumped inside the lease claim and used verbatim as the ClickHouse
     * `generation`, rather than 0014's `max(stored) + 1`. Nothing renews the
     * five-minute lease, so a long run and the worker that stole its lease would
     * otherwise read the same stored maximum and mint the same generation — a
     * tie ReplacingMergeTree cannot resolve. A counter the claim bumps gives the
     * newer run the higher number by construction.
     */
    rollupGenerationSeq: bigint('rollup_generation_seq', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'revenue_attribution_state_lease_check',
      sql`(${t.claimedBy} IS NULL) = (${t.leaseExpiresAt} IS NULL)`,
    ),
    check('revenue_attribution_state_run_seq_check', sql`${t.runSeq} >= 0`),
    check('revenue_attribution_state_rollup_generation_check', sql`${t.rollupGenerationSeq} >= 0`),
    index('revenue_attribution_state_lease_idx').on(t.leaseExpiresAt),
    index('revenue_attribution_state_computed_idx').on(t.computedThrough),
  ],
)

/**
 * Subscription heads, their event-only changes and invoice hints (mirror of
 * migration 0047; Perier gap 7). The SQL file carries the reasoning.
 */
export const revenueSubscriptions = pgTable(
  'revenue_subscriptions',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    subscriptionId: text('subscription_id').notNull(),
    snapshotAt: instant('snapshot_at').notNull(),
    payloadHash: text('payload_hash').notNull(),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    normalized: jsonb('normalized').$type<RevenueSubscriptionSnapshot>().notNull(),
    firstSeenAt: instant('first_seen_at').notNull().defaultNow(),
    updatedAt: updatedAt(),
    projectedVersion: bigint('projected_version', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    unique('revenue_subscriptions_site_subscription_key').on(
      t.siteId,
      t.provider,
      t.subscriptionId,
    ),
    index('revenue_subscriptions_unprojected_idx')
      .on(t.siteId, t.updatedAt)
      .where(sql`projected_version < version`),
    check('revenue_subscriptions_version_check', sql`${t.version} >= 1`),
    check(
      'revenue_subscriptions_projected_version_check',
      sql`${t.projectedVersion} >= 0 AND ${t.projectedVersion} <= ${t.version}`,
    ),
  ],
)

export const revenueSubscriptionChanges = pgTable(
  'revenue_subscription_changes',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    subscriptionId: text('subscription_id').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    kind: text('kind').$type<SubscriptionChangeKind>().notNull(),
    occurredAt: instant('occurred_at').notNull(),
    fromMrrMinor: bigint('from_mrr_minor', { mode: 'number' }).notNull().default(0),
    toMrrMinor: bigint('to_mrr_minor', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique('revenue_subscription_changes_event_key').on(
      t.siteId,
      t.provider,
      t.providerEventId,
      t.kind,
    ),
    index('revenue_subscription_changes_subscription_idx').on(
      t.siteId,
      t.provider,
      t.subscriptionId,
      t.occurredAt,
    ),
    check(
      'revenue_subscription_changes_kind_check',
      sql`${t.kind} IN ('plan_changed', 'cancel_scheduled', 'cancel_undone')`,
    ),
  ],
)

export const revenueInvoices = pgTable(
  'revenue_invoices',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    invoiceId: text('invoice_id').notNull(),
    subscriptionId: text('subscription_id').notNull().default(''),
    billingReason: text('billing_reason').notNull().default(''),
    orderId: text('order_id').notNull().default(''),
    chargeId: text('charge_id').notNull().default(''),
    customerId: text('customer_id').notNull().default(''),
    occurredAt: instant('occurred_at').notNull(),
    version: bigint('version', { mode: 'number' }).notNull().default(1),
    projectedVersion: bigint('projected_version', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('revenue_invoices_site_invoice_key').on(t.siteId, t.provider, t.invoiceId),
    index('revenue_invoices_unprojected_idx')
      .on(t.siteId, t.updatedAt)
      .where(sql`projected_version < version`),
    check('revenue_invoices_version_check', sql`${t.version} >= 1`),
    check(
      'revenue_invoices_projected_version_check',
      sql`${t.projectedVersion} >= 0 AND ${t.projectedVersion} <= ${t.version}`,
    ),
  ],
)
