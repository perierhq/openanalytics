/**
 * Metric names the batch worker emits.
 *
 * Centralised because an alert rule keys on the string, and a name that drifts
 * takes its alert with it silently (docs snapshot 02 §26). Two of these are
 * named by G-006 as the minimal pipeline's alerts and must not be renamed
 * without changing the Grafana rules in the same commit:
 * `worker_queue_oldest_age_ms` and `worker_clickhouse_insert_error`.
 *
 * Durations are a `_ms` counter beside a `_total` counter, so the ratio is the
 * average and both halves survive a counter-only backend.
 */
export const WORKER_METRICS = {
  batchFlushed: 'worker_batch_flushed',
  batchRows: 'worker_batch_rows',
  batchBytes: 'worker_batch_bytes',

  manifestCreated: 'worker_manifest_created',
  manifestContinued: 'worker_manifest_continued',
  manifestRecovered: 'worker_manifest_recovered',

  fenceDropped: 'worker_fence_dropped',
  fenceDroppedRows: 'worker_fence_dropped_rows',

  /** A manifest message whose stream entry is gone — the D-210 deletion case. */
  messageMissing: 'worker_message_missing',
  payloadInvalid: 'worker_payload_invalid',

  insertTotal: 'worker_clickhouse_insert_total',
  insertMs: 'worker_clickhouse_insert_ms',
  insertRows: 'worker_clickhouse_insert_rows',
  /** G-006 alert. Labelled `ambiguous` so a timeout is distinguishable. */
  insertError: 'worker_clickhouse_insert_error',

  usageApplied: 'worker_usage_applied',
  usageAlreadyApplied: 'worker_usage_already_applied',
  usageWindowUnresolved: 'worker_usage_window_unresolved',
  assignmentCorrected: 'worker_assignment_corrected',
  usageCounterReconciled: 'worker_usage_counter_reconciled',

  batchRetried: 'worker_batch_retried',
  batchDeadLettered: 'worker_batch_dead_lettered',
  batchCompleted: 'worker_batch_completed',

  acked: 'worker_messages_acked',
  reclaimed: 'worker_messages_reclaimed',

  /** G-006 alert. A gauge: it falls again when the worker catches up. */
  queueOldestAgeMs: 'worker_queue_oldest_age_ms',
  queueTrimmed: 'worker_queue_trimmed',
  /**
   * Valkey's `used_memory` as a fraction of its `maxmemory`, for the queue
   * instance. A gauge, and the only capacity series this repository publishes
   * about either store.
   *
   * It exists because of what its absence cost. On 2026-08-22 the queue
   * instance filled, `noeviction` turned every `XADD` into an error, and the
   * collector returned 503 for twenty-five minutes; 9,831 events were lost. The
   * alert-rules header said in as many words that "this repo publishes no disk,
   * memory or connection counter" — accurately, and that was the outage.
   *
   * NOT zero-filled, unlike every backlog gauge in this file, and the
   * difference is deliberate: `memoryUsageRatio` returns null for an instance
   * with no `maxmemory`, where there is no ratio and zero would read as the
   * healthiest possible value. Its rule's `noDataState` carries that case
   * instead.
   */
  valkeyMemoryRatio: 'worker_valkey_memory_ratio',

  /** accepted_at → durable in ClickHouse. The plan's freshness criterion. */
  freshnessMs: 'worker_freshness_ms',
  freshnessTotal: 'worker_freshness_total',

  /**
   * Billable rows in ClickHouse minus the usage ledger, over recent completed
   * batches (docs snapshot 02 §26, plan M6 item 11). A gauge, and published as
   * zero when there is no drift: a series that only appears when something is
   * wrong is indistinguishable from a job that stopped running.
   */
  reconciliationDrift: 'worker_usage_reconciliation_drift',
  reconciliationBatches: 'worker_usage_reconciliation_batches',

  // ---------------------------------------------------------------------------
  // The generic outbox dispatcher.
  // ---------------------------------------------------------------------------
  /** Labelled `topic`. */
  outboxDelivered: 'worker_outbox_delivered',
  outboxFailed: 'worker_outbox_failed',
  /**
   * Undelivered rows, labelled `topic` and `status`. A gauge, published as zero
   * for a drained topic: the signal being watched is "nothing is consuming this
   * topic", and that is invisible in a series that only exists when rows do.
   */
  outboxBacklog: 'worker_outbox_backlog',
  outboxOldestAgeMs: 'worker_outbox_oldest_age_ms',

  /**
   * ADR-0027: a site's `first_event_at` filled for the first time — the
   * install-verified signal. A counter that ticks once per site ever, so its
   * rate is "trackers that started working", not traffic.
   */
  siteFirstEvent: 'worker_site_first_event',

  /** G-005: a site spending half its monthly limit in one UTC day. */
  rapidBurnNotified: 'worker_rapid_burn_notified',
  /** G-005: the third consecutive day a site hit its daily safety ceiling. */
  ceilingDaysAlert: 'worker_site_ceiling_days_alert',
  /**
   * G-005's notice actually reaching a mailbox: an `email.send` row written for
   * a burn crossing. Separate from `rapidBurnNotified`, which counts the
   * *detection* — the gap between the two is exactly the fan-out ADR-0021 left
   * unbuilt, and a divergence between them is how it would be noticed again.
   */
  rapidBurnEmailEnqueued: 'worker_rapid_burn_email_enqueued',

  // ---------------------------------------------------------------------------
  // M10 lifecycle (ADR-0030, decision 10).
  // ---------------------------------------------------------------------------
  /** Sites moved to `suspended` by an entitlement loss. */
  lifecycleBlockedSites: 'worker_lifecycle_blocked_sites',
  /** Sites moved back to `active` by an entitlement regain, within capacity. */
  lifecycleReactivatedSites: 'worker_lifecycle_reactivated_sites',
  /** Subscriptions the sweeper expired by clock — the webhook Stripe never sent. */
  lifecycleExpiredSubscriptions: 'worker_lifecycle_expired_subscriptions',
  /** `site_deletion` jobs the retention sweep enqueued. Counts the enqueue, not
   * the deletion: the job's own phases are what report progress. */
  lifecycleRetentionDeletionsEnqueued: 'worker_lifecycle_retention_deletions_enqueued',
  /** Import runs the sweeper failed because their upload never arrived within
   * `IMPORT_UPLOAD_TTL_DAYS` (ADR-0032, D7). A sustained non-zero rate is a
   * broken upload path, not abandoned intentions. */
  lifecycleImportUploadsExpired: 'worker_lifecycle_import_uploads_expired',

  /**
   * Terminal import runs whose staged ClickHouse rows and archive the sweeper
   * cleaned as a backstop (ADR-0032, D7).
   *
   * Expected to be near zero: the prepare job cleans its own failures and the
   * publish job cleans the grandparent it supersedes. A sustained non-zero rate
   * means those cleanups are not happening — a ClickHouse credential problem, or
   * jobs dying between the state change and the delete — and the symptom the
   * counter is here to catch is staged rows accumulating for runs nobody can see.
   */
  lifecycleImportRunsCleaned: 'worker_lifecycle_import_runs_cleaned',

  /**
   * The job runner. `worker_job_completed` is labelled `type` and `status`, so a
   * terminal failure is distinguishable from a success without a second series.
   */
  jobCompleted: 'worker_job_completed',
  /**
   * Unfinished jobs, labelled `type` and `status`. Gauges, zero-filled for every
   * registered type exactly as the outbox backlog is: a series that exists only
   * when there is work cannot be told apart from a runner that stopped running.
   */
  jobsBacklog: 'worker_jobs_backlog',
  jobsOldestAgeMs: 'worker_jobs_oldest_age_ms',

  /**
   * Deletion's own observability (ADR-0030, decision 10).
   *
   * `worker_deletion_phase{phase}` is incremented on every *entry* into a phase,
   * not on completion, so a job stuck polling a drain or a ClickHouse mutation
   * still reports movement — a phase counter that only advanced on success would
   * be indistinguishable between "waiting correctly" and "not running at all",
   * which is the exact question an operator asks about a deletion.
   *
   * `worker_deletion_target_failed{store}` counts a target that could not be
   * worked: a failed mutation, or a store the worker has no credential for. It
   * is labelled by store rather than by table so its cardinality is three, and
   * because the operator's next action differs per store, not per table.
   *
   * The drain has no counter of its own: `worker_fence_dropped{reason}` is
   * already the witness the ADR-0022 criterion is stated against.
   */
  deletionPhase: 'worker_deletion_phase',
  deletionTargetFailed: 'worker_deletion_target_failed',
  /**
   * An account deletion that found no such subscription at Stripe, labelled
   * `observed_at` (the cancel call or the verifying retrieve).
   *
   * Not a failure — the target still completes, because a subscription that does
   * not exist is not billing anybody — which is exactly why it needs a counter
   * of its own. Its ordinary cause is an attempt that cancelled and died before
   * recording the fact, so a rate near zero is expected and a sustained one says
   * our `subscriptions` table names ids Stripe does not have.
   */
  accountDeletionStripeMissing: 'worker_account_deletion_stripe_missing',

  // ---------------------------------------------------------------------------
  // M12 revenue ingest (ADR-0033, D4).
  // ---------------------------------------------------------------------------
  /**
   * List pages walked, labelled `resource` and `mode` (`backfill`/`reconcile`).
   *
   * The rate is what says a ninety-day walk is progressing rather than looping:
   * a resource stuck on one cursor still ticks this counter, which is why the
   * cursor's own advance is a *log* field and this is only the throughput.
   */
  revenueSyncPages: 'worker_revenue_sync_pages',
  /**
   * Observations the sync path decided on, labelled `decision`
   * (`apply` | `skip` | `refetch`) and `mode`.
   *
   * `refetch` is emitted *in addition to* the `apply`/`skip` that follows it —
   * a tie is a decision and then a second decision — so the three do not sum to
   * the observation count, on purpose: what `refetch` measures is how often two
   * states of one object shared a snapshot second, which is a provider-shape
   * signal rather than a throughput one.
   *
   * A sweep whose decisions are all `skip` is the healthy steady state; one that
   * is all `apply` on a quiet account means something is producing new versions
   * from identical states.
   */
  revenueObservations: 'worker_revenue_observations',
  /**
   * A sync attempt that ended in a categorized failure, labelled `reason`
   * (`unauthorized`/`unavailable`/`undecryptable`) and `mode`.
   *
   * The alert this exists for is the one this milestone is named after: a
   * sustained `unauthorized` rate is customers whose keys were revoked and whose
   * dashboards would otherwise read a confident zero.
   */
  revenueSyncFailed: 'worker_revenue_sync_failed',
  /**
   * Subscription lifecycle list walks (Perier gap 7) that ended in a failure,
   * labelled `resource` (`subscriptions`/`invoices`), `reason` and `mode`.
   *
   * Separate from `revenueSyncFailed` because a lifecycle failure does NOT
   * degrade the credential: a restricted key created before subscriptions were
   * read may lack the Subscriptions or Invoices permission, and that must not
   * take the money sync down with it. A sustained `unauthorized` here is a
   * customer whose key needs those two read permissions added.
   */
  revenueLifecycleSyncFailed: 'worker_revenue_lifecycle_sync_failed',
  /** Subscription heads and invoice hints written by the projection to
   * ClickHouse, labelled `table` (`subscription_lifecycle`/`subscription_invoices`). */
  revenueLifecycleProjectedRows: 'worker_revenue_lifecycle_projected_rows',
  /**
   * **Milliseconds** since the oldest due credential was last synced (the name
   * says `_ms` and the value is milliseconds).
   *
   * A gauge, published as zero when nothing is due — a lag series that exists
   * only when the loop is behind cannot be told apart from a loop that stopped
   * running.
   */
  revenueReconcileLagMs: 'worker_revenue_reconcile_lag_ms',
  /** Credentials the sweep flipped `degraded` → `active`, i.e. outages that
   * ended. Its counterpart is `revenueSyncFailed{reason}`. */
  revenueCredentialRecovered: 'worker_revenue_credential_recovered',
  /** ECB fetch outcomes, labelled `status` (`ok`/`unavailable`/`unparseable`).
   * Stale rates are CP3's `conversion_source` problem, so this is the signal
   * that says *why* they are stale. */
  revenueCurrencyFetch: 'worker_revenue_currency_fetch',
  /** Rate rows written on the last successful fetch. Zero for days is the ECB
   * document having changed shape under a parser that still "succeeds". */
  revenueCurrencyRates: 'worker_revenue_currency_rates',

  // ---------------------------------------------------------------------------
  // M12 revenue projection (ADR-0033, D5). CP3.
  // ---------------------------------------------------------------------------
  /**
   * **Milliseconds** since the oldest object head that has not been projected
   * into `analytics.revenue_events` was last changed.
   *
   * The gauge the whole loop is judged on, and it is deliberately the age of the
   * OLDEST pending change rather than the newest: the newest is always roughly
   * now, so a series built on it would read identically for a healthy loop and a
   * stalled one. Zero-filled when nothing is pending, for the reason every other
   * backlog gauge in this file is zero-filled.
   */
  revenueProjectionLagMs: 'worker_revenue_projection_lag_ms',
  /**
   * Fact rows handed to ClickHouse, a counter, **unlabelled**.
   *
   * Deliberately carries no `provider` or `site_id` label: it is a throughput
   * series, and one label per site would make its cardinality the customer
   * count. Its ratio against `revenueProjectionBatches` is the average batch
   * size, and a sustained zero here beside a non-zero
   * `revenueProjectionLagMs` is the signal that the loop is running and
   * refusing to write — which on a fresh deployment means the `oa_ingest`
   * grant.
   */
  revenueProjectedRows: 'worker_revenue_projected_rows',
  /** Batches inserted, labelled `site_id`. Low cardinality by construction —
   * only sites with revenue connected ever appear. */
  revenueProjectionBatches: 'worker_revenue_projection_batches',
  /**
   * Rows written with `conversion_source = 'unavailable'`, labelled `currency`
   * and `reason`.
   *
   * Not an error and not a failure — the row is stored with its original
   * currency and amount intact, which is the whole D2c promise. What it measures
   * is how much of a site's revenue the reporting-currency total is *not*
   * allowed to include, and CP5's read surface has to render exactly that
   * remainder. A sustained rate on one currency means the ECB does not list it.
   * A sudden rate across every currency means the rate table has gone stale, and
   * `revenueCurrencyFetch{status}` says why.
   */
  revenueConversionUnavailable: 'worker_revenue_conversion_unavailable',
  /**
   * A projection that failed, labelled `reason`:
   *
   * - `site` — one site's batch threw and was skipped for the tick. Two ordinary
   *   causes: the ClickHouse insert failed (on a fresh deployment, almost always
   *   the missing `oa_ingest` grant on `revenue_events`, which CP7's deploy adds
   *   through the entrypoint XML recreate), or a malformed stored snapshot threw
   *   while its row was being built. The log line's `rows` field separates them.
   * - `tick` — the loop itself threw, which is a bug or a Postgres outage.
   *
   * Deliberately NOT labelled by site: the alert worth having is "the projection
   * is failing", and a per-site series would make its cardinality the customer
   * count while answering a question the log line already answers.
   *
   * There is no counter for match hints. The api's webhook path is what writes
   * them, and the api cannot emit a `WORKER_` metric — the hint count is
   * recorded per delivery in `revenue_provider_events.result.hints`, which is
   * where an operator asking "is this site passing `client_reference_id`?" is
   * already looking. A dedicated api-side counter is worth adding the day the
   * question becomes a dashboard rather than an investigation.
   */
  revenueProjectionFailed: 'worker_revenue_projection_failed',
  /**
   * Deliveries the sweep settled `failed` after sitting at `received` past the
   * provider's retry horizon (CP2's recorded gap).
   *
   * **Visibility, not repair.** The reconcile sweep is the repair path — it
   * re-lists a trailing window regardless of the ledger — and the ledger stores
   * only a payload hash, so there is nothing left to reprocess anyway. What was
   * missing was knowing it happened. A sustained rate means tie-break re-fetches
   * are failing faster than the provider retries, which is actionable;
   * zero means the 5xx-and-let-them-redeliver path is working.
   */
  revenueStuckDeliveries: 'worker_revenue_stuck_deliveries',

  // ---------------------------------------------------------------------------
  // M12 matching and attribution (ADR-0033, D6). CP4.
  // ---------------------------------------------------------------------------
  /**
   * A site processed to a decided state, i.e. its watermark advanced.
   *
   * Incremented on **every** such pass, including one whose horizon held no
   * charges at all — a site that has gone quiet is still being processed, and a
   * counter that stopped for it could not be told apart from a loop that died.
   */
  revenueAttributionRuns: 'worker_revenue_attribution_runs',
  /**
   * A site whose attribution did not run, labelled `reason`: `leased` (another
   * worker holds it), `lifecycle` (the deletion fence refused it), or
   * `attribution_off` — the site's own `attributed_revenue` switch is off, so no
   * journey is computed from any of D6's three signals (ADR-0064 D4a).
   *
   * `attribution_off` is the one reason that still rolls up and still advances
   * the watermark: money totals are outside that switch, so the run is a run.
   * A sustained rate here is the answer to "why does this site show revenue but
   * no journeys", and its absence is the answer to "why does a site that turned
   * linking off still have them" — an old row, not a new one.
   */
  revenueAttributionSkipped: 'worker_revenue_attribution_skipped',
  /**
   * A run that threw and released without advancing, labelled `reason`
   * (`site` | `tick`).
   *
   * Per-site failure isolation is the CP3 lesson applied: discovery is
   * `ORDER BY site_id LIMIT n`, so an uncaught throw on one site would starve
   * every site sorting after it, permanently and silently. Not labelled by
   * site, for `revenueProjectionFailed`'s cardinality reason.
   */
  revenueAttributionFailed: 'worker_revenue_attribution_failed',
  /**
   * Attribution rows written — i.e. charges whose fingerprint MOVED, not charges
   * considered.
   *
   * A steady non-zero rate on a site with no new purchases means late signals
   * are still arriving and flipping earlier answers, which is the design working.
   * A rate equal to the charge count on every pass would mean the fingerprint is
   * not stable and a recompute is not a no-op, which is a bug.
   */
  revenueAttributionRows: 'worker_revenue_attribution_rows',
  /**
   * Charges considered, labelled `matched_via`
   * (`conversion_event` | `client_reference` | `customer_identity` | `none`).
   *
   * The match-rate breakdown, and the one number that tells a customer whether
   * their `oa.conversion()` call is wired correctly: a site with purchases and
   * 100% `none` has an integration problem, not an analytics problem. Emitted
   * for every charge in the horizon on every run, so it is a *gauge-like*
   * counter — read as a ratio between labels, never as a total.
   */
  revenueAttributionMatched: 'worker_revenue_attribution_matched',
  /**
   * Age of the oldest attribution watermark across sites, in ms, zero-filled.
   *
   * Zero when no site has revenue, for the reason every backlog gauge here is
   * zero-filled: a series that exists only while the job is behind cannot be
   * told apart from a job that stopped running.
   */
  revenueAttributionLagMs: 'worker_revenue_attribution_lag_ms',

  // ---------------------------------------------------------------------------
  // M12 revenue rollups (ADR-0033, D7; ClickHouse 0018). CP5.
  // ---------------------------------------------------------------------------
  /**
   * Rollup buckets whose stored value MOVED, labelled `unit` (`1h` | `1d`).
   *
   * The session rollup's counter, one milestone later, and read the same way: a
   * steady rate is late facts revising earlier buckets, which is the design
   * working. A rate equal to the bucket count of the horizon on every pass would
   * mean the recompute is not deterministic — the comparison that makes an
   * unchanged bucket a no-op is what the whole 15-minute staleness sweep rests
   * on, and losing it would grow a generation per bucket per quarter hour.
   */
  revenueRollupSwaps: 'worker_revenue_rollup_swaps',
  /**
   * A site whose full-site re-roll (a reporting-currency change) is still
   * pending, because the projection has not caught up yet. Labelled by nothing;
   * a sustained non-zero rate means the projection loop is stuck and the site is
   * serving amounts in a currency it no longer reports in.
   */
  revenueRollupRecomputePending: 'worker_revenue_rollup_recompute_pending',

  // ---------------------------------------------------------------------------
  // The M8 session finalizer (docs snapshot 02 §10, §15, 05 D-211).
  // ---------------------------------------------------------------------------
  /** A site processed to a decided state (watermark advanced). */
  sessionFinalizeRuns: 'worker_session_finalize_runs',
  /** A site skipped because another worker held its lease. */
  sessionFinalizeSkipped: 'worker_session_finalize_skipped',
  /** A run that threw and released without advancing. */
  sessionFinalizeFailed: 'worker_session_finalize_failed',
  /** New fact versions written (changed sessions), a counter. */
  sessionFactVersions: 'worker_session_fact_versions',
  /** Retraction tombstones written, a counter. */
  sessionFactRetractions: 'worker_session_fact_retractions',
  /**
   * Rollup buckets swapped to a higher generation, a counter, **labelled by
   * `unit`** exactly as `revenueRollupSwaps` is (ADR-0079 step 2).
   *
   * The label is what makes the fifteen-minute grain observable at all: an
   * unlabelled total stays healthy on hour and day traffic alone, so a
   * `session_rollups_15m` that never receives a row would look identical to one
   * that does.
   */
  sessionRollupSwaps: 'worker_session_rollup_swaps',
  /** Time spent in one site's recompute, a `_ms` counter beside `_runs`. */
  sessionFinalizeMs: 'worker_session_finalize_ms',

  // ---------------------------------------------------------------------------
  // ADR-0052 — the off-host ClickHouse backup, watched from here.
  // ---------------------------------------------------------------------------
  /**
   * Seconds since the newest object under `backups/daily/`. **The alert.**
   *
   * A gauge on age rather than a counter on failures, because the failure this
   * has to catch produces no event at all: a systemd timer that quietly stopped
   * emits nothing to count. The age climbs on its own and crosses G-003's
   * 24-hour RPO whether the backup job failed, never ran, or was uninstalled.
   *
   * It is derived from **the object in the bucket**, not from the script's exit
   * status, so it cannot be satisfied by a run that exits zero having uploaded
   * nothing — and it is the only durable record there is, since ClickHouse's
   * `system.backups` is in-memory and empty after a restart.
   *
   * Renaming this without changing `infra/grafana/alert-rules.yaml` in the same
   * commit silently disarms the alert.
   */
  clickhouseBackupAgeSeconds: 'clickhouse_backup_age_seconds',
  /** The same, for `backups/weekly/`. Informational: the weekly object is a
   * retention class, and its absence is already implied by the daily gauge. */
  clickhouseBackupWeeklyAgeSeconds: 'clickhouse_backup_weekly_age_seconds',
  /** Size of the newest daily archive. A backup that suddenly shrinks by an
   * order of magnitude is a backup of a database that lost its tables. */
  clickhouseBackupBytes: 'clickhouse_backup_bytes',
  /** The check itself failed (storage unreachable, credentials rejected).
   * Distinct from a stale backup: this says the watcher is blind, not that the
   * backup is old. */
  clickhouseBackupCheckFailed: 'clickhouse_backup_check_failed',
} as const
