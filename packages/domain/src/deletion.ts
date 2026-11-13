/**
 * The deletion target vocabulary (ADR-0030, decision 7).
 *
 * A site deletion snapshots this list into `deletion_targets` at the instant it
 * starts, and the worker then works the snapshot rather than re-deriving it.
 * That is the whole reason the vocabulary is fixed and lives in one pure module:
 *
 * - **The snapshot is the contract.** A job resumed a week later purges what the
 *   customer's deletion promised to purge, not what a redeployed build happens
 *   to enumerate. If a future milestone adds a store, existing in-flight
 *   deletions keep their original target set and the new one is covered by the
 *   deletions started after it — which is auditable, whereas a live-derived list
 *   silently changes the meaning of a request already made.
 * - **Three packages must agree.** Postgres writes the snapshot rows, ClickHouse
 *   executes the thirty `ALTER … DELETE`s, and the worker matches phases to
 *   stores. A literal repeated in three places is a purge that quietly stops
 *   covering a table the day one of them is edited. A vocabulary name with no
 *   purge statement behind it is worse than an omission: it verifies silently at
 *   `deleted: 0`, so the per-table effect is asserted, not only the count.
 *
 * The list is deliberately *not* derived from `system.tables`, from the Drizzle
 * schema barrel or from the Redis key prefixes. Derivation would make every new
 * table a deletion target with nobody deciding that it should be, and — worse —
 * would make a renamed one silently stop being purged. Here, a table that is
 * missing is a verification error.
 */

/**
 * Where a target lives. `object` was reserved by ADR-0030 and is spent by
 * ADR-0032 D9, now that M11 has a bucket with customer bytes in it. A store
 * outside our own infrastructure — a payment provider's — is contributed by
 * whichever surface talks to it, through `registerDeletionExtension`.
 */
export const DELETION_STORES = ['clickhouse', 'redis', 'postgres', 'object'] as const
export type DeletionStore = (typeof DELETION_STORES)[number]

declare const REGISTERED_DELETION_STORE: unique symbol

/**
 * A store a registered surface deletes from, named by that surface rather than
 * declared here. Branded like `ExtensionErrorCode` and for the same reason: a
 * typo in a product target stays a compile error, and a target naming a store
 * outside the list above has to say so out loud through `deletionStore()`.
 */
export type RegisteredDeletionStore = string & { readonly [REGISTERED_DELETION_STORE]: true }

export function deletionStore(name: string): RegisteredDeletionStore {
  return name as RegisteredDeletionStore
}

/**
 * Every ClickHouse table that stores a `site_id` — the MergeTree targets the
 * analytics migrations create. The materialized views are not listed because
 * they store nothing of their own: each writes into one of these, so purging the
 * targets purges everything the site ever produced.
 */
export const DELETION_CLICKHOUSE_TARGETS = [
  'events_raw',
  'performance_events',
  'metrics_1m',
  'metrics_1d',
  'pages_1d',
  'sources_1d',
  'geography_1d',
  'devices_1d',
  'custom_events_1d',
  'performance_1d',
  'session_facts_versions',
  'session_rollups_1d',
  // The imported aggregate family (ADR-0032, D2/D9; ClickHouse migration 0015).
  //
  // Restated as literals rather than spread from `IMPORTED_REPORT_TABLES`, and
  // that is this list's whole rule: the vocabulary a deletion snapshots is a
  // fixed decision, not a derivation. Derived, a renamed table would silently
  // stop being purged; here it is a failing test. `tests/unit/deletion-registry`
  // asserts the two agree, which is the check the derivation would have removed.
  //
  // They are keyed by `site_id` like every other target, so the existing
  // delete-by-site statement covers them unchanged — a site deleted mid-import
  // is a site whose staged rows go with it, whether or not the run was ever
  // published.
  'imported_metrics_1d',
  'imported_pages_1d',
  'imported_sources_1d',
  'imported_geography_1d',
  'imported_devices_1d',
  'imported_browsers_1d',
  'imported_os_1d',
  'imported_custom_events_1d',
  // The canonical revenue fact (ADR-0033, D5/D8; ClickHouse migration 0016).
  //
  // One row per money object per version, keyed by `site_id` like every other
  // target, so the existing delete-by-site statement covers it unchanged. It is
  // the first of the four ClickHouse names D8 books across CP3-CP5;
  // `revenue_attributions` (0017) landed with CP4 below, and
  // `revenue_1h`/`revenue_1d` (0018) arrive with their own migration in CP5.
  //
  // Listed rather than derived, for this list's standing rule: a derived name
  // would silently stop being purged the day the table was renamed, where a
  // literal one fails `tests/migration/clickhouse-maintenance.test.ts` instead.
  'revenue_events',
  // The attribution fact (ADR-0033, D6/D8; ClickHouse migration 0017).
  //
  // Keyed by `site_id` like every other target, so the existing delete-by-site
  // statement covers it unchanged. It is the second of the four ClickHouse names
  // D8 books across CP3-CP5; `revenue_1h`/`revenue_1d` (0018) arrive with their
  // own migration in CP5 and move these counts in their own commit.
  //
  // Deleting it is not optional and is not inherited: purging `revenue_events`
  // removes the money objects a journey explains and leaves the journeys
  // themselves — visitor pseudonyms, first-touch sources, the whole ordered
  // session history of a customer's buyers — sitting in a table nothing points
  // at any more. Of the two revenue tables, this is the one that holds
  // behavioural data about people.
  'revenue_attributions',
  // The two revenue rollups (ADR-0033, D7/D8; ClickHouse migration 0018).
  //
  // The last two of the four ClickHouse names D8 books across CP3-CP5, and the
  // end of the milestone's registry growth. Keyed by `site_id` like every other
  // target, so the existing delete-by-site statement covers them unchanged.
  //
  // They are targets in their own right rather than something purging
  // `revenue_events` handles: a rollup bucket is a *derived* row that outlives
  // the facts it was derived from, so removing the facts and leaving these would
  // leave a site's revenue totals — down to the hour — readable from a table
  // nothing points at any more. The generation-swap design makes that worse than
  // it sounds, because nothing recomputes a bucket whose facts are gone: the
  // last stored generation would simply stand forever.
  'revenue_1d',
  // The subscription lifecycle facts and invoice purchase kinds (Perier gap 7,
  // ClickHouse migration 0031). Keyed by `site_id`, so the existing
  // delete-by-site statement covers them unchanged. Targets in their own right
  // for the rollups' reason: they are derived rows nothing recomputes once the
  // Postgres heads are gone, and they hold a site's MRR history and a
  // pseudonymous customer hash per subscription.
  'subscription_lifecycle',
  'subscription_invoices',
  // What a custom-events row may say beyond a count (ADR-0038, D5/D8;
  // ClickHouse migration 0021).
  //
  // Site-scoped like every other target, so the existing delete-by-site
  // statement covers them unchanged. They are targets in their own right rather
  // than something purging `events_raw` handles: an aggregate outlives the rows
  // it was derived from and nothing recomputes a bucket whose source events are
  // gone, so leaving them would leave a deleted site's last event path and last
  // property bag readable, per event name, from a table nothing else points at.
  'custom_event_samples_1d',
  // The fifteen-minute rollup family (ADR-0079, D1; ClickHouse migration 0025).
  //
  // Eight tables, one per additive family, each the 15m twin of a 1h target
  // above with the same columns and the same site_id key, so the existing
  // delete-by-site statement covers them unchanged. They are targets in their
  // own right for the reason every rollup is: an aggregate outlives the raw
  // rows it came from, and nothing recomputes a bucket whose events are gone.
  // Listed as literals rather than derived from the 1h names, per this list's
  // standing rule -- a derived name would silently stop being purged.
  'metrics_15m',
  'pages_15m',
  'sources_15m',
  'geography_15m',
  'devices_15m',
  'custom_events_15m',
  'performance_15m',
  'custom_event_samples_15m',
  // The fifteen-minute grain of the two SWAP rollups (ADR-0079, step 2;
  // ClickHouse migration 0026).
  //
  // The eight above are materialized views. These two the worker writes: the
  // session finalizer and the revenue attribution job. That difference decides
  // how they are filled and who is granted what, and decides nothing at all
  // here -- both are site-keyed derived rows that outlive the facts they came
  // from, so both are purge targets on exactly the argument their hour twins
  // are. A deleted site whose `session_rollups_15m` survived would leave its
  // session counts, and one whose `revenue_15m` survived would leave its
  // revenue totals, readable at a finer grain than the hour tables that WERE
  // purged. Listed as literals, per this list's standing rule.
  'session_rollups_15m',
  'revenue_15m',
  // The custom-event property breakdowns (DataFast gap 6; ClickHouse
  // migration 0030).
  //
  // Site-scoped view targets like the rest of the family, so the existing
  // delete-by-site statement covers them unchanged. Targets in their own right
  // for the rollup reason: an aggregate outlives the raw rows it came from, and
  // a deleted site whose breakdowns survived would leave every property value
  // its events carried, per event name and quarter hour, readable from a table
  // nothing else points at. Listed as literals, per this list's standing rule.
  'custom_event_properties_15m',
  'custom_event_properties_1d',
] as const
export type DeletionClickhouseTarget = (typeof DELETION_CLICKHOUSE_TARGETS)[number]

/**
 * Redis targets, grouped by the *shape of the walk* rather than by key prefix.
 *
 * Each name is one bounded enumeration the purge can perform without a `SCAN`,
 * which is the property that makes deletion safe to run against a live instance:
 *
 * - `queue_index` — the day buckets, the stream entries they name and the dedup
 *   records those entries carry.
 * - `realtime_presence` — the presence ZSET, whose members enumerate the
 *   per-visitor `rt_meta` HASHes and `rt_pages` LISTs.
 * - `realtime_feed` — the site's rolling page-view feed LIST.
 * - `realtime_epochs` — one key per subject, and the subject list comes from
 *   Postgres membership plus the two reserved names.
 * - `day_counters` — the accepted-event and billable per-UTC-day counters.
 *
 * Short-TTL keys (`rl_*`, `sec_bot`) are deliberately absent: they expire within
 * two days on their own, and enumerating them would need a `SCAN` over the whole
 * keyspace to remove data that is gone before an operator could look at it.
 */
export const DELETION_REDIS_TARGETS = [
  'queue_index',
  'realtime_presence',
  'realtime_feed',
  'realtime_epochs',
  'day_counters',
] as const
export type DeletionRedisTarget = (typeof DELETION_REDIS_TARGETS)[number]

/**
 * Postgres targets — the site-scoped rows the purge deletes.
 *
 * Three tables are site-scoped and deliberately *not* here, and each absence is
 * a decision rather than an omission:
 *
 * - `ingest_batch_sites` is the write fence's own ledger. It is what proves the
 *   drain happened and what a late worker's registration is checked against; a
 *   purge that deleted it would erase the evidence for its own correctness.
 * - `audit_logs` is the audit trail, including this deletion's own two rows.
 * - `site_billing_assignments` is billing history, which belongs to the payer
 *   and outlives the site (the same reason account deletion scrubs the users row
 *   instead of deleting it).
 */
export const DELETION_POSTGRES_TARGETS = [
  'site_domains',
  'site_members',
  'site_invites',
  'api_keys',
  'site_ingest_settings',
  'site_public_dashboard_settings',
  'funnels',
  'session_finalizer_state',
  'ingest_batch_items',
  // The import pair (ADR-0032, D9), and the order between them is load-bearing:
  // `import_uploads` references `import_runs`, so the child goes first. The
  // purge additionally nulls `sites.published_import_run_id` before deleting the
  // runs — that FK points the *other* way (D9's declared cycle), and
  // `ON DELETE SET NULL` is the schema-level backstop rather than the mechanism.
  'import_uploads',
  'import_runs',
  // The export half (ADR-0032, D8/D9). Last in the *vocabulary*, which is a
  // reading order rather than an execution one: nothing references
  // `export_runs`, and its own two references (`sites`, `import_runs`) point
  // outward, so it has no ordering constraint at all. The purge deletes it just
  // before `import_runs` — `pinned_import_run_id` is `ON DELETE SET NULL`, and
  // removing the pointing rows first means the runs go without any row being
  // rewritten on the way.
  //
  // Its object keys join the single `site_objects` target rather than a target
  // of their own — an export's chunk keys are recorded on this row as they are
  // uploaded, and `startSiteDeletion` unions them with the import archive keys
  // into one snapshotted list.
  'export_runs',
  // The revenue credential store (ADR-0033, D3/D8; Postgres migration 0033).
  //
  // It has no ordering constraint: nothing references it, and its own two
  // references (`sites`, `users`) point outward. It is last because it is M12's
  // first addition and the list reads chronologically.
  //
  // The ciphertexts are already gone by the time this runs — `startSiteDeletion`
  // erases them in its own transaction (D8), long before the purge phases begin,
  // because a site on its way out must not hold a decryptable provider key even
  // transiently and `clickhouse_purge` can take as long as ClickHouse takes to
  // rewrite its parts. This target removes the rows themselves.
  //
  // **Order below it is load-bearing.** The three CP2 tables all reference
  // `revenue_credentials` (`revenue_provider_events` and `revenue_sync_state`
  // directly, both `ON DELETE CASCADE`), so they are children and go first — the
  // same rule `import_uploads` before `import_runs` follows. They are listed
  // after the parent here because this vocabulary reads chronologically, and the
  // *purge* is what enforces the execution order; a cascade would remove them
  // without telling anybody how many rows it took, and the target row's whole
  // job is to record that number.
  'revenue_credentials',
  'revenue_provider_events',
  'revenue_objects',
  'revenue_sync_state',
  // The checkout match hints (ADR-0033, D6 and the CP3 amendment to D8;
  // migration 0035).
  //
  // Not booked by D8's original arithmetic, because D6 as written expected the
  // matching signal to be reconstructible from a Checkout Sessions re-list. CP3
  // stores it instead, for a reason the ADR amendment states: a hint attached to
  // the object head would have to pass through the three-way decision, where it
  // would either tie on snapshot time (costing a provider request per checkout)
  // or apply and rewrite the document that holds the amounts.
  //
  // It references only `sites`, so unlike its three neighbours it has no
  // ordering constraint at all -- it is last because this vocabulary reads
  // chronologically.
  'revenue_match_hints',
  // The attribution job's control row (ADR-0033, D6/D8; migration 0036).
  //
  // The `session_finalizer_state` analogue, one milestone later, and it is a
  // target for the identical reason that one is: the row is site-scoped, it
  // references `sites` for integrity WITHOUT a cascade (the sites row becomes a
  // tombstone rather than being deleted), and a lease left behind would be a
  // control row for a site that no longer exists. It references nothing else, so
  // it has no ordering constraint -- it is last because this vocabulary reads
  // chronologically.
  'revenue_attribution_state',
  // The dashboard event builder's two tables (ADR-0034, D9; migration 0038).
  //
  // **Order below is load-bearing**, and it is the `import_uploads` /
  // `import_runs` rule again: `event_definition_versions` references
  // `event_definitions`, so the child goes first. There is a second reference
  // pointing the other way — `event_definitions.published_version` names a
  // version row — which is why the child cannot simply be left to a cascade
  // here: deleting the parent first would have to break that pointer, and the
  // purge would then be unable to say how many version rows it removed.
  //
  // Both are named even though the child cascades from the parent and the parent
  // cascades from `sites`. A target that is only implied by a cascade cannot be
  // verified at `deleted: N`, and verification is what this registry is for
  // (ADR-0030, decision 4).
  //
  // The rule-preview *token* was deliberately never here: it was an
  // Ed25519-signed value with a 15-minute expiry, held in no table (ADR-0034,
  // D6) — nothing to purge. The whole mechanism is gone now (ADR-0068).
  'event_definition_versions',
  'event_definitions',
  // The embeddable widget configuration (ADR-0045, D8; migration 0048).
  //
  // Site-scoped like every other target, and it has no ordering constraint at
  // all: nothing references `widgets`, and its own two references (`sites`,
  // `users`) point outward. It is last because this vocabulary reads
  // chronologically.
  //
  // Named rather than left to the `sites` cascade, for this list's standing
  // rule: a cascade removes the rows without returning them, and the target
  // row's whole job is to record how many *this name* removed. It matters
  // particularly here, because what these rows carry is a set of live public
  // credentials — every one of them is a URL sitting in the HTML of a page that
  // is not ours, and "the deletion covered the customer's public embeds" has to
  // be answerable from the snapshot rather than inferred from a foreign key.
  'widgets',
  // Where this site's API keys have been used from (ADR-0051, D5; migration
  // 0050).
  //
  // Only the `api_key` rows: the same table holds `oauth_grant` rows keyed by a
  // *person*, and those are the account vocabulary's
  // (`credential_sources_user`). One table, two purges, two different row sets —
  // which is exactly why the two vocabularies spell the name differently.
  //
  // No ordering constraint: nothing references it, and its own two references
  // (`sites`, `users`) point outward and carry no ON DELETE action. It goes
  // *after* `api_keys` in this list only because it reads better beside the
  // keys it describes; the transaction could run it anywhere.
  //
  // What is being removed is a set of keyed hashes of network addresses. They
  // are not addresses and cannot be turned back into any, but they are still
  // telemetry about the customer's own infrastructure, and a deletion that left
  // them would leave a record of where a deleted site was administered from.
  'credential_sources',
  // The subscription lifecycle (Perier gap 7; migration 0047): subscription
  // heads, their event-only changes and the invoice hints. Site-scoped, each
  // referencing only `sites`, so no ordering constraint among them or against
  // their neighbours. Named rather than left to the `sites` cascade, for this
  // list's standing rule: the target row records how many rows *this name*
  // removed.
  'revenue_subscriptions',
  'revenue_subscription_changes',
  'revenue_invoices',
] as const
export type DeletionPostgresTarget = (typeof DELETION_POSTGRES_TARGETS)[number]

/**
 * The single object target (ADR-0032, D9).
 *
 * One row, not one per key, because the port deliberately has no `list`: the
 * keys are *enumerated from Postgres* — every upload and export chunk records
 * its key on its own row — and snapshotted into this target's `verification` at
 * deletion start, before `postgres_purge` deletes the rows that carry them.
 * That is what the target snapshot is for, and it is why the object phase runs
 * long before the Postgres one.
 *
 * A site with no uploads gets the row anyway, with an empty key list, and the
 * phase completes it trivially. The alternative — omitting the row for such a
 * site — would make the target count vary per site, and "did the deletion cover
 * object storage?" would stop being answerable from the snapshot alone.
 */
export const DELETION_OBJECT_TARGETS = ['site_objects'] as const
export type DeletionObjectTarget = (typeof DELETION_OBJECT_TARGETS)[number]

export interface DeletionTargetName {
  readonly store: DeletionStore | RegisteredDeletionStore
  readonly target: string
}

/**
 * The full snapshot a site deletion writes: 35 ClickHouse + 5 Redis + 23
 * Postgres + 1 object target, in that order. **64**, and the number changes on
 * purpose as stores are added — the assertions that name it are the contract.
 *
 * How it got here, kept because each step is a decision somebody can check:
 *
 * - 35 before M11 — 20 ClickHouse, 5 Redis, 10 Postgres, and the `object` store
 *   reserved by ADR-0030 with no row, because no bucket existed yet;
 * - M11 CP1 added `import_runs` and `import_uploads` and spent the `object`
 *   reservation — 35 became 38;
 * - M11 CP2 staged imported aggregates into the **eight** `imported_*`
 *   ClickHouse tables of ADR-0032 D2 — 20 became 28, so 38 became 46;
 * - M11 CP4 added the `export_runs` Postgres table (ADR-0032 D8) — 12 became
 *   13, so 46 became 47, which was M11's end state;
 * - M12 CP1 added `revenue_credentials` (ADR-0033, D3/D8) — 13 became 14, so
 *   47 became 48;
 * - M12 CP2 added the three ingest tables — `revenue_provider_events`,
 *   `revenue_objects`, `revenue_sync_state` (Postgres migration 0034) — 14
 *   became 17, so 48 became 51;
 * - M12 CP3 added `revenue_events` on the ClickHouse side (migration 0016) —
 *   28 became 29 — and `revenue_match_hints` on the Postgres side (migration
 *   0035) — 17 became 18 — so 51 became 53. The hints table is the one
 *   D8 did not book: the amendment recorded under D8 says why it exists and
 *   restates the milestone's end state as **57** rather than 56;
 * - M12 CP4 added `revenue_attributions` on the ClickHouse side (migration
 *   0017) — 29 became 30 — and `revenue_attribution_state` on the Postgres side
 *   (migration 0036) — 18 became 19 — so 53 became **55**;
 * - M12 CP5 added `revenue_1h` and `revenue_1d` on the ClickHouse side
 *   (migration 0018) — 30 became 32 — and nothing on the Postgres side, so 55
 *   became **57**, which is the milestone's end state (ADR-0033, D8 as amended
 *   by CP3). Redis stayed 5 and the object store stayed 1 throughout M12: the
 *   revenue surface persists no key and no cached value of its own;
 * - M13 CP1 added `event_definitions` and `event_definition_versions` (Postgres
 *   migration 0038) — 19 became 21, so 57 became **59**;
 * - M13 CP5 added `events_preview` on the ClickHouse side (migration 0020) — 32
 *   became 33, so 59 became **60**, which is the milestone's end state
 *   (ADR-0034, D9). Redis stayed 5 throughout — the event builder holds no key —
 *   and the object store stayed 1;
 * - ADR-0038 CP2 added `custom_event_samples_1h` and `custom_event_samples_1d`
 *   (migration 0021) — 33 became 35, so 60 became **62**. Two tables and not
 *   one, for the reason the rollup families are all pairs: an hour grain cannot
 *   answer a ninety-day range and a day grain cannot answer a two-hour one.
 *   Nothing else moved — the widened read adds no Postgres row, no Redis key
 *   and no object;
 * - M15 CP1 added `widgets` (Postgres migration 0048) — 21 became 22, so 62
 *   became **63** (ADR-0045, D8). One table and not two: a widget's origin
 *   allowlist is a bounded `text[]` on the row rather than a child table, so
 *   there is nothing beside it to enumerate. ClickHouse stayed 35 — a widget
 *   read computes through the existing public pipeline and persists no fact of
 *   its own — Redis stayed 5, and the object store stayed 1;
 * - M18's first work item added `credential_sources` (Postgres migration 0050)
 *   — 22 became 23, so 63 became **64** (ADR-0051, D5). One table and one
 *   target, even though the table also holds rows an account deletion removes:
 *   this vocabulary purges the `api_key` half by `site_id`, the account one
 *   purges the `oauth_grant` half by `user_id`, and the two never overlap
 *   because exactly one of those columns is set per row. ClickHouse stayed 35 —
 *   a credential event is a Postgres row and nothing else — Redis stayed 5, and
 *   the object store stayed 1;
 * - ADR-0068 dropped `events_preview` (ClickHouse migration 0022) — 35 became
 *   34, the first time the ClickHouse set has ever shrunk;
 * - ADR-0079 added the eight `*_15m` rollups (ClickHouse migration 0025) — 34
 *   became **42**. One 15m twin per additive 1h family and nothing else: the
 *   session and revenue rollups are finalizer swap targets rather than views
 *   and get their fifteen-minute grain in a later step, and the read path does
 *   not change here, so no Postgres row, Redis key or object moved with it;
 * - ADR-0079's second step added that later grain — `session_rollups_15m` and
 *   `revenue_15m` (ClickHouse migration 0026) — so 42 became **44**, and the
 *   site total 70 became **72** (71 became **73** on hosted). Two tables, no
 *   view: the worker writes them, which is why they needed an `oa_ingest`
 *   grant and a container recreate that the eight views did not, and why their
 *   history is backfilled rather than materialized. As purge targets they are
 *   indistinguishable from their hour twins, which is the only thing this list
 *   cares about;
 * - ClickHouse migration 0029 (v0.8.0) dropped the ten hour tables — the eight
 *   `*_1h` view targets, `session_rollups_1h` and `revenue_1h` — so 44
 *   became **34** and the site total 72 became **62** (73 became **63** on
 *   hosted), the second time the ClickHouse set has shrunk. Nothing had
 *   written them since 0027 (ADR-0079 step 4), and the one thing that still
 *   read them, the 15m backfill's equality gate, compares with `events_raw`
 *   now. They leave this list in the same release that drops them: a target
 *   naming a table that no longer exists would fail every deletion, and a
 *   dropped table listed a release late would leave nothing to purge anyway;
 * - ClickHouse migration 0030 (Perier fork, DataFast gap 6) added the
 *   custom-event property breakdowns, `custom_event_properties_15m` and
 *   `custom_event_properties_1d` — so 34 became **36** and the site total 62
 *   became **64** (63 became **65** on hosted);
 * - the Perier fork's subscription lifecycle (DataFast gap 7) added
 *   `revenue_subscriptions`, `revenue_subscription_changes` and
 *   `revenue_invoices` (Postgres migration 0047) and `subscription_lifecycle`
 *   and `subscription_invoices` (ClickHouse migration 0031), so the site total
 *   64 became **69** (Postgres 22 → 25, ClickHouse 36 → 38; 65 became **70**
 *   on hosted).
 *
 * `currency_rates` (migration 0034) is deliberately **not** here and never will
 * be. It is global reference data — one row per `(rate_date, currency)`, with no
 * `site_id` column to purge by — and D2c says so explicitly. Deleting a site's
 * data must not delete the ECB's published exchange rates; they are not the
 * customer's bytes, they belong to every other site's conversions, and a target
 * naming a table with no site dimension could only ever be a delete-everything
 * statement or a no-op that verifies at `deleted: 0`.
 *
 * The `object` target did **not** multiply, which is the property that made it
 * one target instead of one per key: export chunks record their keys on
 * `export_runs` rows and join the one snapshotted key list beside the import
 * archives. Revenue adds no object target at all — provider payload bodies are
 * never persisted (ADR-0033, D5).
 *
 * Still no provider row: a site deletion cancels no subscription, because the
 * site is one of possibly several the same person is answerable for.
 *
 * **The array is appended to by `registerDeletionExtension`**, and every holder
 * of this binding sees those entries because it is the same array object. That
 * is the whole mechanism behind the composite dictionary: a surface that owns
 * tables of its own contributes its targets at import time, before anything
 * snapshots them, and neither the writer that stamps the snapshot nor the
 * executor that works it needs to know which surfaces a deployment mounted. The
 * appended entries land after the product's, which is a reading order rather
 * than an execution constraint — the whole snapshot is one transaction, and no
 * contributed table is referenced by a product one.
 */
const siteDeletionTargets: DeletionTargetName[] = [
  ...DELETION_CLICKHOUSE_TARGETS.map((target) => ({ store: 'clickhouse' as const, target })),
  ...DELETION_REDIS_TARGETS.map((target) => ({ store: 'redis' as const, target })),
  ...DELETION_POSTGRES_TARGETS.map((target) => ({ store: 'postgres' as const, target })),
  ...DELETION_OBJECT_TARGETS.map((target) => ({ store: 'object' as const, target })),
]

export const SITE_DELETION_TARGETS: readonly DeletionTargetName[] = siteDeletionTargets

/**
 * The deletion job's phases, in the order they must run (ADR-0030, decision 4).
 *
 * The order is not a preference. `fence_drain` must precede everything because
 * nothing may be purged while a writer can still admit rows. `finalizer_fence`
 * must precede `clickhouse_purge` because a finalizer run that claimed before
 * deletion started could otherwise insert fact/rollup rows *after* a verified
 * purge. `redis_purge` must precede `postgres_purge` because the realtime epoch
 * keys are enumerated from the very `site_members` rows the Postgres purge
 * deletes — reversing them would leave one epoch key per member, unfindable
 * without a `SCAN`.
 *
 * `object_purge` sits between `redis_purge` and `clickhouse_purge` (ADR-0032,
 * D9). It could be almost anywhere before `postgres_purge` — its key list came
 * from the snapshot, not from a live read — and it is placed early for a
 * practical reason: it is fast and cheap, while `clickhouse_purge` polls
 * mutations for as long as ClickHouse takes to rewrite its parts. Doing the
 * quick, certain work first means a deletion that stalls stalls with the bucket
 * already empty.
 */
export const SITE_DELETION_PHASES = [
  'fence_drain',
  'finalizer_fence',
  'redis_purge',
  'object_purge',
  'clickhouse_purge',
  'postgres_purge',
  'verify_finalize',
] as const
export type SiteDeletionPhase = (typeof SITE_DELETION_PHASES)[number]

export function isSiteDeletionPhase(value: unknown): value is SiteDeletionPhase {
  return typeof value === 'string' && (SITE_DELETION_PHASES as readonly string[]).includes(value)
}

// --- Account deletion (ADR-0030, decision 8) ---------------------------------

/**
 * The account-scoped Postgres targets, in teardown order.
 *
 * The names are *deletion vocabulary*, not always table names, and the three
 * that differ each say something the table name would not:
 *
 * - `memberships` / `invites` / `transfer_offers` cover `site_members`,
 *   `site_invites` and `billing_transfer_offers` — the rows this user holds
 *   across sites that are not theirs and are not being deleted. A site-scoped
 *   purge names the same tables for a different set of rows, and reusing the
 *   table name in both vocabularies would make the two snapshots look
 *   interchangeable when they are not.
 * - `trial_claims_unlink` is not a delete at all. The claim row is the D-021
 *   one-time-trial tombstone and survives forever; what this target does is
 *   sever it from the account — `user_id` and `stripe_subscription_id` nulled,
 *   `identity_hash` untouched. Calling it `trial_claims` would read as "the
 *   trial history was erased", which is the opposite of what happens.
 * - `api_keys_revoke` is not a delete either, and it is not the site vocabulary's
 *   `api_keys`. An account's `private_read` keys are secrets *this person*
 *   minted, but the rows are site-scoped and live on sites that are not being
 *   deleted — so nothing else in this snapshot would ever touch them, and a
 *   deleted account's token would keep reading a live customer's analytics.
 *   Revoked rather than deleted, because `api_keys` is what "who could read this
 *   site" is reconstructed from; the site's public `tracking_write` token is
 *   deliberately out of scope, being the site's credential and not the user's.
 * - `api_keys_rotation_required` is the disposition `api_keys_revoke` does not
 *   cover, added 2026-08-06 (ADR-0043, D8). Not every private key this person
 *   minted is revoked: one they installed into a machine (`held_by = 'site'` —
 *   the WordPress plugin's) stays alive on a site that now belongs to somebody
 *   else, because revoking it would take a working installation down over a
 *   departure. It is stamped `rotation_required_at` instead, so the site's
 *   remaining owners can see that a departed stranger still knows its value.
 *   It is a target rather than a silence for the reason `idempotency_keys` is
 *   one: a snapshot that reported only `api_keys_revoke` would read as "every
 *   key this account held is gone", and here that is exactly what did not
 *   happen. The two counts partition the same set.
 * - `revenue_credentials_revoke` is the same shape and the same argument, one
 *   milestone later (ADR-0033, D3/D8). A credential this person connected is a
 *   **customer's payment-provider key** living on a site that is not being
 *   deleted, so nothing else in this snapshot reaches it — and the sync loop
 *   would keep decrypting and using it forever on behalf of an account that no
 *   longer exists. It is disabled with both ciphertexts erased rather than
 *   deleted, because the row is the site's connection history and the site is
 *   still alive; the site's own `revenue_credentials` target (a delete) belongs
 *   to the *site* vocabulary and is a different set of rows, exactly as
 *   `api_keys` and `api_keys_revoke` are.
 * - `idempotency_keys` is a delete, added 2026-08-06, and it is here because a
 *   foreign key that looks like it already covers this does not. The column is
 *   `REFERENCES users (id) ON DELETE CASCADE`, and the cascade **never fires**:
 *   `user_tombstone` below scrubs the `users` row rather than deleting it, so
 *   nothing ever cascades from it. Meanwhile the rows hold `response_body` —
 *   the stored response a create replayed, which for `sites.create` carries the
 *   site's slug and name. A declared cascade that cannot run is worse than none,
 *   because it reads as coverage.
 * - `oauth_access_tokens`, `oauth_consents` and `device_codes` are three deletes,
 *   added 2026-08-06 with migration 0045, and they are here for exactly the
 *   reason `idempotency_keys` is — one milestone's lesson applied at the moment
 *   the tables were written rather than a year later. Every one of them is
 *   *a person's*: an access token that reads their sites' analytics, a standing
 *   consent naming what they let a client do, and any device authorization they
 *   have in flight. Better Auth's declared schema puts
 *   `ON DELETE CASCADE` on all three `user_id` columns and migration 0045
 *   deliberately omits it, because `user_tombstone` scrubs the `users` row and a
 *   cascade that cannot fire reads as coverage. Left out, a deleted account's
 *   CLI would keep reading a live customer's analytics until the token expired,
 *   and its refresh token would keep renewing it for a month.
 *
 *   `oauth_applications` is **not** a target, and since ADR-0047 the reason is
 *   construction rather than a disabled flag: dynamic client registration is
 *   live (`POST /v1/oauth/register`), but its writer never stamps `user_id` —
 *   a registered client introduces *itself* and belongs to nobody — so no
 *   user-owned row can exist and there is nothing for deletion to find. A dead
 *   user's tokens and consents die in the two targets above, which is what
 *   makes the surviving client row inert. The unit test that used to pin the
 *   registration flag now pins the anonymous write instead.
 * - `assistant_usage_ledger` is a delete, added 2026-08-08 with migration 0049
 *   (ADR-0046, D5), and it is enumerated in the same change that created the
 *   table rather than being discovered later. The rows hold no message text, no
 *   tool arguments and no answers — the server stores no conversation at all
 *   (D12) — only how many questions this person asked in an hour and what the
 *   tokens came to. Counts under a user id are still that user's data. The
 *   contrast with `read_cost_ledger`, which is in *neither* registry, is the
 *   whole distinction: that table is keyed by a credential and what survives it
 *   "is a number that describes nothing about anybody", while this one is keyed
 *   by a person. Its foreign key declares no `ON DELETE` action for the reason
 *   the three above give, so this statement is what actually removes the rows.
 * - `user_tombstone` is the scrub, not a delete. The `users` row survives
 *   because `site_billing_assignments.billing_user_id` is `NOT NULL RESTRICT`
 *   and that history belongs to the *surviving* site's owner (ADR-0030, D8).
 *
 * The order is the one the teardown transaction runs in, and one step of it is
 * load-bearing: `verifications` is keyed by the email *identifier*, so it must
 * be emptied before `user_tombstone` rewrites the email, or the rows become
 * unfindable. The rest could commute — they are one transaction — but a stable
 * order makes a partially-recorded snapshot readable by an operator, which is
 * why `api_keys_revoke` and `revenue_credentials_revoke` sit with the other
 * credential targets rather than at the end.
 */
export const ACCOUNT_DELETION_POSTGRES_TARGETS = [
  'verifications',
  'sessions',
  'accounts',
  'oauth_access_tokens',
  'oauth_consents',
  'device_codes',
  'idempotency_keys',
  'api_keys_revoke',
  'api_keys_rotation_required',
  'revenue_credentials_revoke',
  'memberships',
  'invites',
  'assistant_usage_ledger',
  // Where this person's OAuth grants have been used from (ADR-0051, D5;
  // migration 0050).
  //
  // A fourth name that is not its table's, and the reason is the one
  // `memberships` gives: `credential_sources` also holds rows for API keys,
  // which are *site* data and which this teardown must not touch. An account
  // deletion revokes the person's keys (`api_keys_revoke`) rather than deleting
  // them, and the sites those keys belong to survive — so their source rows
  // survive too. This target removes only the `oauth_grant` rows, found by
  // `user_id`, and calling it `credential_sources` would make the site
  // snapshot and this one look interchangeable when they purge disjoint halves
  // of the same table.
  //
  // Placed with the credential targets rather than at the end, beside the
  // `oauth_access_tokens` and `oauth_consents` rows it describes — though the
  // teardown is one transaction and the position is a reading order, not an
  // ordering constraint.
  'credential_sources_user',
  'user_tombstone',
] as const
export type AccountDeletionPostgresTarget = (typeof ACCOUNT_DELETION_POSTGRES_TARGETS)[number]

/**
 * The full snapshot an account deletion writes: one `stripe` target and
 * eighteen `postgres` ones.
 *
 * No `clickhouse` and no `redis` row, and the absence is the design rather than
 * an omission: an account owns no analytics data of its own. Everything stored
 * in those two lives under a *site*, and the gate (ADR-0030, D8) is what
 * guarantees the sites are already `deleting`/`deleted` — each with its own
 * request and its own 57 targets — before this snapshot is written. Duplicating
 * them here would give one row two deletions claiming to have purged it.
 */
const accountDeletionTargets: DeletionTargetName[] = [
  ...ACCOUNT_DELETION_POSTGRES_TARGETS.map((target) => ({ store: 'postgres' as const, target })),
]

export const ACCOUNT_DELETION_TARGETS: readonly DeletionTargetName[] = accountDeletionTargets

/**
 * The account-deletion job's phases, in the order they must run
 * (ADR-0030, decision 8).
 *
 * - `await_site_deletions` is first because the account's sites are being
 *   deleted by their *own* jobs, and each of those jobs still needs the rows
 *   this account's teardown would remove — `site_members` is read by
 *   `redis_purge` to enumerate the realtime epoch keys, and a membership deleted
 *   from under it would leave one key per member unreachable without a `SCAN`.
 * - `stripe_cancel` precedes `postgres_teardown` because the teardown deletes
 *   the `subscriptions` row that names the subscription to cancel. Reversed, a
 *   crash between the two phases would leave a live Stripe subscription with
 *   nothing in our database pointing at it — a customer still being charged for
 *   an account that no longer exists.
 * - `verify_finalize` is last and re-reads every target rather than trusting the
 *   phases, for the reason site deletion gives: the phases may have run in
 *   different processes across restarts, and the table is the only thing that
 *   knows what all of them observed.
 */
const accountDeletionPhases: string[] = [
  'await_site_deletions',
  'postgres_teardown',
  'verify_finalize',
]

/**
 * The phases, in order, with any a registered surface inserted.
 *
 * A phase list rather than a closed union since the split: a surface that owns
 * a store outside our infrastructure owns a phase that talks to it, and the
 * executor dispatches on the name. `registerDeletionExtension` splices its
 * phases in at a named position, because where a phase runs is the whole of
 * what a phase order says.
 */
export const ACCOUNT_DELETION_PHASES: readonly string[] = accountDeletionPhases
export type AccountDeletionPhase = string

export function isAccountDeletionPhase(value: unknown): value is AccountDeletionPhase {
  return typeof value === 'string' && (ACCOUNT_DELETION_PHASES as readonly string[]).includes(value)
}

/**
 * What a surface contributes to the deletion dictionary.
 *
 * The dictionary is the *snapshot* a deletion writes and the executor works, so
 * it has to be complete before the first target row is stamped — and it cannot
 * be a fixed list, because which tables exist depends on which surfaces a
 * deployment mounted. Registration at import time is the shape that satisfies
 * both: everything a surface owns is declared beside the code that owns it, and
 * every reader still sees one list.
 */
export interface DeletionExtension {
  readonly name: string
  /** Stores this surface deletes from, beyond `DELETION_STORES`. */
  readonly stores?: readonly RegisteredDeletionStore[]
  readonly siteTargets?: readonly DeletionTargetName[]
  readonly accountTargets?: readonly DeletionTargetName[]
  /** Phases to run, each named with the product phase it must precede. */
  readonly accountPhases?: readonly { readonly phase: string; readonly before: string }[]
}

const registeredStores: RegisteredDeletionStore[] = []
const registeredExtensions = new Set<string>()

/** Every store a deletion in this deployment can name. */
export function deletionStores(): readonly (DeletionStore | RegisteredDeletionStore)[] {
  return [...DELETION_STORES, ...registeredStores]
}

export function registerDeletionExtension(extension: DeletionExtension): void {
  if (registeredExtensions.has(extension.name)) return
  registeredExtensions.add(extension.name)

  registeredStores.push(...(extension.stores ?? []))
  siteDeletionTargets.push(...(extension.siteTargets ?? []))
  accountDeletionTargets.push(...(extension.accountTargets ?? []))

  for (const entry of extension.accountPhases ?? []) {
    const index = accountDeletionPhases.indexOf(entry.before)
    if (index < 0) {
      throw new Error(
        `deletion extension "${extension.name}" wants ${entry.phase} before unknown phase ${entry.before}`,
      )
    }
    accountDeletionPhases.splice(index, 0, entry.phase)
  }
}
