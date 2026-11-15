import { z } from 'zod'
import { BOT_RULESET_VERSION } from './bot-ruleset.ts'

/**
 * Typed policy configuration.
 *
 * Docs snapshot 02 §5: policy values are not repeated as bare numbers across the
 * codebase. They live here with their defaults, and the cross-field invariants
 * are validated at startup — a dedup window shorter than the accepted event
 * lateness silently breaks at-least-once deduplication, and that failure is
 * invisible until duplicates are already billed.
 *
 * The abuse ceilings and collector rate limits (docs snapshot 05, G-005, closed
 * 22 July 2026) live here too, for the reason G-005 states outright: "every
 * value is in typed config (no number scattered through the code)". A limit
 * repeated as a literal at its enforcement point is a limit that drifts from
 * the decision that set it, and nothing fails when it does.
 */

export const policySchema = z
  .object({
    /** Docs snapshot 05, D-016. */
    EVENT_MAX_LATENESS_HOURS: z.coerce.number().int().min(1).default(24),
    EVENT_MAX_FUTURE_SKEW_SECONDS: z.coerce.number().int().min(0).default(300),

    /** Docs snapshot 05, D-209. */
    INGEST_DEDUP_TTL_DAYS: z.coerce.number().int().min(1).default(7),
    ACKED_QUEUE_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
    SITE_QUEUE_INDEX_TTL_DAYS: z.coerce.number().int().min(1).default(8),

    /**
     * How long a *completed* `idempotency_keys` row stays replayable
     * (ADR-0019 known gap 4, closed by the amendment dated 2026-08-06).
     *
     * 24 hours is the horizon an `Idempotency-Key` client is built against. The
     * header is a convention integrators inherit from Stripe, whose published
     * retention is 24 hours, so that is the number a third-party retry policy
     * assumes — and a retry that outlives a day is a new intent, not a retry.
     * Our own client's horizon is strictly shorter: the key lives in a `useRef`
     * for one dialog mount (`apps/web/.../add-site-dialog.tsx`), so a page
     * reload mints a fresh one and nothing first-party ever replays across days.
     */
    IDEMPOTENCY_KEY_RETENTION_HOURS: z.coerce.number().int().min(1).default(24),

    /**
     * How long an *in-flight* claim (`completed_at IS NULL`) is honoured before
     * the sweeper treats it as orphaned.
     *
     * A separate and much shorter horizon, because the two states fail
     * differently. A claim is written before the handler runs and removed by
     * that same handler; if the process dies in between — which a
     * compose-recreate deploy does to every request in flight — nothing else
     * ever deletes the row, and every future request presenting that key is
     * refused `IDEMPOTENCY_CONFLICT` with `reason: 'in_progress'` **forever**.
     * The retention horizon above is the wrong cure for that: it would hold a
     * key hostage for a day to protect a handler that has been dead since the
     * deploy.
     *
     * Why an hour, and not less: the sweeper runs on the retention trimmer's
     * hourly interval, so a claim orphaned just after a sweep waits an hour
     * whatever this value says. One hour is therefore the shortest number that
     * means anything here — the machinery's own resolution sets the floor, and
     * a smaller value would be a promise the schedule cannot keep.
     *
     * Sweeping a claim is not free: if the handler committed and died before
     * recording its response, the retry runs again. That risk is bounded and
     * was weighed per scope — `sites.create` collides on the slug unique index
     * and answers "taken", the two deletes converge by design, and the import
     * and export scopes duplicate a run rather than corrupt one. None is
     * unrecoverable; a permanently unusable key is.
     */
    IDEMPOTENCY_CLAIM_MAX_AGE_HOURS: z.coerce.number().int().min(1).default(1),

    /** Docs snapshot 02 §10. */
    SESSION_INACTIVITY_MINUTES: z.coerce.number().int().min(1).default(30),

    /**
     * A session lasts at most this many hours, measured from its first event
     * (closed product decision 2026-07-25, ADR-0018). The bound that keeps the
     * finalizer watermark advancing: ADR-0012 left one documented gap — a
     * never-ending activity stream (a kiosk screen, a script that passes the bot
     * filter) makes a session that never closes, which stalls the watermark and
     * grows the recompute window without bound (see ADR-0012's open item). Matomo
     * and Universal Analytics force a visit break at midnight for the same reason;
     * our sessionizer deliberately bridges midnight (ADR-0012), so the equivalent
     * bound is this explicit cap. It never affects a real sub-24h session — the
     * midnight bridge is unchanged for sessions under the cap.
     */
    SESSION_MAX_LENGTH_HOURS: z.coerce.number().int().min(1).max(48).default(24),

    /** Docs snapshot 05, D-213: hard ceilings, not just defaults. */
    REALTIME_TOKEN_TTL_SECONDS: z.coerce.number().int().min(1).max(60).default(60),
    REALTIME_EPOCH_CHECK_SECONDS: z.coerce.number().int().min(1).max(15).default(15),

    /**
     * How long a computed realtime snapshot may be cached before it is
     * recomputed. Capped at 2 seconds, not merely defaulted: docs snapshot 02
     * §17 states the bound outright ("a snapshot may be cached 1–2 seconds"), and
     * a longer cache would make the "realtime" view lag its own definition (02
     * §1 item 12: refresh within 1–3 seconds). A model bound, not a G-005 gate.
     */
    REALTIME_SNAPSHOT_CACHE_SECONDS: z.coerce.number().int().min(1).max(2).default(2),
    /**
     * How often a hub with at least one connected client recomputes its
     * snapshot, whether or not anything published (ADR-0035, D5).
     *
     * Before this the hub recomputed *only* on a `rt_updates` touch, so on a
     * site with no traffic `active_visitors` froze at its last value
     * indefinitely. That was survivable while presence expired after 60 s — a
     * frozen count was obviously stale within a minute — and stopped being
     * survivable when the window became five minutes, because a frozen count and
     * a real one are then the same number for five times as long.
     *
     * Policy rather than a module constant, by the same rule that keeps
     * `VISITOR_PRESENCE_WINDOW_MS` a constant: only the realtime gateway reads
     * this, and two gateways disagreeing about how hard they work costs nothing.
     * The presence window is a store format two services must encode
     * identically, and that is a different kind of value.
     *
     * Ten seconds is one bounded ZCOUNT + ZREVRANGE + pipelined HGETALL per
     * *watched* site — a site with a dashboard open on it — and a busy site
     * already recomputes five times more often than that on traffic alone. So
     * the timer is strictly the quiet case's cost. The floor invariant below
     * refuses anything faster than the cache window.
     */
    REALTIME_SNAPSHOT_REFRESH_SECONDS: z.coerce.number().int().min(1).max(60).default(10),
    /**
     * Upper bound on visitors a single snapshot aggregates (plan 04, M9 item 6:
     * the snapshot is computed once per site and bounded). Past it the gateway
     * reports `truncated` rather than scanning an unbounded active set — a busy
     * site's snapshot stays cheap and its cost predictable. A model bound, not a
     * G-005 gate value.
     */
    REALTIME_SNAPSHOT_MAX_VISITORS: z.coerce.number().int().min(100).max(20_000).default(5_000),

    // ---------------------------------------------------------------------
    // Docs snapshot 05, G-005 — abuse/safety ceilings and collector limits.
    // Every default below is the value G-005 closed on; none is chosen here.
    // ---------------------------------------------------------------------

    /**
     * Per-site daily safety ceiling, in events. Above it the collector answers
     * `429 + Retry-After` and the counter resets at UTC midnight — throttling,
     * never an automatic block, and never a dropped event: the tracker retries.
     */
    SITE_DAILY_EVENT_CEILING: z.coerce.number().int().min(1).default(6_000_000),
    /** Consecutive ceiling-hitting days that raise an internal alert. The
     * decision after that is the operator's, not the system's. */
    SITE_CEILING_ALERT_CONSECUTIVE_DAYS: z.coerce.number().int().min(1).default(3),
    /** Share of a monthly limit spent in one UTC day that means "burning fast". */
    RAPID_BURN_DAILY_FRACTION: z.coerce.number().gt(0).max(1).default(0.5),

    /** Fixed-window per-minute rates (G-005; ADR-0013 settled the "sustained
     * 60 + burst 120" wording as this single fixed-window ceiling). */
    RATE_LIMIT_IP_SITE_BURST: z.coerce.number().int().min(1).default(120),
    RATE_LIMIT_IDENTITY_PER_MINUTE: z.coerce.number().int().min(1).default(100),
    /** Infrastructure guard for a whole site. A 429 here is latency, not loss. */
    RATE_LIMIT_SITE_PER_MINUTE: z.coerce.number().int().min(1).default(60_000),

    /**
     * How long the collector may fail open while the limiter store is
     * unreachable. G-005 caps this at five minutes; past it the in-process
     * fallback limiter takes over so the system is never wholly undefended.
     * Schema-capped rather than merely defaulted — a deployment cannot widen it.
     */
    LIMITER_FAIL_OPEN_MAX_SECONDS: z.coerce.number().int().min(0).max(300).default(300),
    /** The in-process fallback's per-IP rate once fail-open has expired. */
    LIMITER_FALLBACK_IP_PER_MINUTE: z.coerce.number().int().min(1).default(120),
    /**
     * Entries the fallback's coarse LRU keeps. G-005 specifies the limiter
     * ("kobud LRU") but not its size; this bounds the memory a collector
     * instance may spend on it during an outage (ADR-0009).
     */
    LIMITER_FALLBACK_LRU_ENTRIES: z.coerce.number().int().min(1).default(10_000),

    /**
     * Version of the bot ruleset in force (G-005). It travels with the security
     * counters, so a change in what counts as a bot is visible as a version
     * change rather than as an unexplained shift in traffic. G-005 puts ruleset
     * changes behind an ordinary PR that bumps the version, so this is here to
     * be *readable* as config, not settable: the invariant below pins it to the
     * version this build actually ships.
     */
    BOT_RULESET_VERSION: z.coerce.number().int().min(1).default(BOT_RULESET_VERSION),

    /** Docs snapshot 05, D-103: unpaid events accepted past the window limit. */
    QUOTA_BUFFER_EVENTS: z.coerce.number().int().min(0).default(5_000),

    // ---------------------------------------------------------------------
    // Milestone 5 engineering values. Not G-005 items — that gate enumerates
    // ceilings and rate limits, all of which are above. Reasoning in ADR-0009.
    // ---------------------------------------------------------------------

    /** The "short retry hint" of docs snapshot 02 §7.2, in seconds. */
    QUEUE_FAILURE_RETRY_AFTER_SECONDS: z.coerce.number().int().min(1).max(300).default(2),
    /**
     * The "short-TTL, versioned site-config cache" of 02 §7.2. Short
     * because a revoked key must stop working quickly; the cache is also keyed
     * by `config_version`/`ingest_generation`, so a bump invalidates it without
     * waiting for the TTL.
     */
    INGEST_CONFIG_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(30),

    // ---------------------------------------------------------------------
    // Milestone 6 — the batch worker. Docs snapshot 02 §7.5 states the flush
    // triggers and gives the row and byte limits as examples ("for example 1,000
    // rows", "1–5 MB"); the exact values, the retry schedule and the lease are
    // engineering choices recorded in ADR-0010. None of them is a G-002/G-003
    // gate value: those are the ClickHouse topology and the numeric operation
    // targets, and neither enumerates a batcher.
    // ---------------------------------------------------------------------

    /**
     * Longest a batch waits after its first event (02 §7.5). The upper end of
     * the 0.5–1.5 s application-side flush SLO, and the only age-based trigger:
     * the lower end is a measurement target, not a floor a full batch waits for.
     */
    WORKER_BATCH_MAX_FLUSH_MS: z.coerce.number().int().min(50).max(10_000).default(1_500),
    /** The SLO's lower end, carried so the freshness measurement names it. */
    WORKER_BATCH_MIN_FLUSH_MS: z.coerce.number().int().min(0).max(10_000).default(500),
    WORKER_BATCH_MAX_ROWS: z.coerce.number().int().min(1).default(1_000),
    /** Decoded payload bytes. 4 MiB sits inside §7.5's 1–5 MB band. */
    WORKER_BATCH_MAX_BYTES: z.coerce.number().int().min(1_024).max(16_777_216).default(4_194_304),

    /** Attempts before a batch is dead-lettered (02 §7.4, plan M6 item 10). */
    WORKER_BATCH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(32).default(8),
    WORKER_RETRY_BASE_MS: z.coerce.number().int().min(10).default(500),
    WORKER_RETRY_MAX_MS: z.coerce.number().int().min(10).default(30_000),

    /**
     * How long a claimed batch's lease lasts, and how idle a pending message
     * must be before another worker may claim it (02 §7.5: "the pending-claim
     * idle timeout is longer than the normal maximum batch processing time").
     */
    WORKER_LEASE_TTL_MS: z.coerce.number().int().min(1_000).default(60_000),
    WORKER_CLAIM_MIN_IDLE_MS: z.coerce.number().int().min(1_000).default(120_000),

    // ---------------------------------------------------------------------
    // Milestone 10 — the lifecycle sweeper and the job runner (ADR-0030,
    // decisions 2 and 3).
    // ---------------------------------------------------------------------

    /**
     * How often the lifecycle sweeper looks for time-expired entitlements and
     * blocked sites past their retention deadline (ADR-0030 D2: "~5 min").
     *
     * The floor is 10 s rather than the interval itself so a test can drive the
     * loop without waiting out a production cadence; it is not a value a
     * deployment has any reason to lower, because both sweeps answer questions
     * whose answers change on the scale of days.
     */
    LIFECYCLE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(10_000).default(300_000),
    /** Rows one sweep page takes, per duty. Bounded so a large blocked
     * population is worked through over several ticks rather than in one
     * transaction-heavy pass. */
    LIFECYCLE_SWEEP_PAGE_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),

    /**
     * Consecutive *failing* attempts a job may make before the runner gives up
     * and marks it `failed_terminal`.
     *
     * Precisely: the `jobs.attempts` counter is incremented at claim time, so it
     * counts claims rather than errors — but a claim the executor ends by asking
     * to be retried resets it to zero (`failJobRetryable(resetAttempts)`), on the
     * grounds that a scheduling decision is not a failed attempt. What is left
     * being counted is a run of claims that ended in a throw with no progress
     * between them, and that run is what this bounds. A job can therefore wait
     * indefinitely while it keeps *deciding* to wait, and still cannot spin
     * forever on a persistent error.
     *
     * Deliberately two orders of magnitude above `WORKER_BATCH_MAX_ATTEMPTS`.
     * A batch that cannot be inserted is dead-lettered for a human; a *deletion*
     * that cannot finish must keep trying, because the alternative is a site the
     * customer asked to be erased sitting half-erased with no retry left. At the
     * capped backoff (`WORKER_RETRY_MAX_MS`, 30 s) 100 consecutive failures is
     * roughly 50 minutes of retrying — long enough to outlast a ClickHouse
     * restart, and still finite so a genuinely impossible job stops burning a
     * claim slot. Terminal failure for a real reason is expressed by the executor
     * returning one, not by exhausting this.
     */
    JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10_000).default(100),

    /**
     * Slack added to `INGEST_CONFIG_CACHE_TTL_SECONDS` before the deletion job's
     * `fence_drain` phase accepts that the collector has provably stopped
     * admitting events for the site (ADR-0030, decision 4).
     *
     * The TTL alone is not enough, and the reason is a request-shaped one. A
     * collector request resolves the site's ingest config *early* and runs the
     * enqueue script *last*, so a request that read a still-cached config one
     * microsecond before the TTL expired can still append to the queue index a
     * whole request-duration later. Waiting only `TTL` would mean purging Redis
     * while that append was in flight, and the purge would report a completeness
     * it had not achieved.
     *
     * The margin therefore covers exactly two things, and nothing else:
     *
     * 1. the longest realistic collector request, measured from the moment it
     *    resolved its ingest config to the moment its enqueue script runs; and
     * 2. the residual clock skew in the one cross-clock comparison the drain
     *    makes. `deletion_requests.requested_at` is stamped by Postgres
     *    (`DEFAULT now()`, written by the deletion-start transaction itself) and
     *    the worker compares it against its own `Date.now()`, so the two hosts'
     *    clocks are the only skew left — the api host's clock does not enter it.
     *
     * 30 s is generous for both: the collector's own request budget is far below
     * it, and NTP-disciplined hosts differ by milliseconds. It is a wait before a
     * destructive step, so being generous costs one extra polling round and being
     * stingy costs correctness.
     */
    DELETION_ACCEPTANCE_MARGIN_MS: z.coerce.number().int().min(0).max(600_000).default(30_000),

    /**
     * The `non_replicated_deduplication_window` the ClickHouse migrations set on
     * every MergeTree target (ADR-0005). Mirrored here — not read from the
     * server — so the invariant below can be checked at startup: the setting is
     * per table with no default, and a window narrower than the retry horizon is
     * invisible until a retry silently doubles the data.
     */
    CLICKHOUSE_DEDUP_WINDOW_BLOCKS: z.coerce.number().int().min(1).default(1_000),

    // ---------------------------------------------------------------------
    // Milestone 11 — import limits (ADR-0032, D6). Every one of these is a
    // budget the streaming parser enforces *during* inflation, so a hostile
    // archive fails with a category instead of an OOM. They live here because
    // the same numbers are checked in two different places — the api's door
    // (`size_bytes` on the create request, which is what the signed URL binds)
    // and the worker's parser — and a limit restated at its enforcement point
    // is a limit that drifts from the decision that set it.
    // ---------------------------------------------------------------------

    /** Largest archive the upload door admits. The signed PUT binds this, so
     * the door never admits bytes the parser is bound to reject. */
    IMPORT_MAX_ARCHIVE_BYTES: z.coerce.number().int().min(1).default(268_435_456),
    /** Largest single entry, uncompressed. The zip-bomb bound: a 256 MiB
     * archive can inflate far past itself, and this is what stops one entry
     * from doing so unnoticed. */
    IMPORT_MAX_ENTRY_BYTES: z.coerce.number().int().min(1).default(1_073_741_824),
    /** Largest total inflated size across every entry. */
    IMPORT_MAX_TOTAL_UNCOMPRESSED_BYTES: z.coerce.number().int().min(1).default(2_147_483_648),
    /** Entries the archive may contain. Plausible ships ten CSVs; the headroom
     * covers a provider with more reports without admitting an archive of
     * thousands of tiny files. */
    IMPORT_MAX_ENTRIES: z.coerce.number().int().min(1).default(32),
    /** Longest CSV row accepted. A row budget is what keeps the streaming
     * parser's memory bounded when an entry has no line breaks at all. */
    IMPORT_MAX_ROW_BYTES: z.coerce.number().int().min(1).default(65_536),
    /**
     * How many bytes of parsed rows go into one staged ClickHouse insert.
     *
     * Not a limit but a *batch size*, and it is here for the same reason the
     * limits are: it decides the name of every insert deduplication token
     * (`{run}:{report}:{chunk_no}`, D7), so it must be a value somebody chose
     * rather than a literal in the staging loop. The run records the value it
     * started with and every retry reuses it — a deploy that retunes this
     * default must not make the same token name a different set of rows.
     *
     * 8 MiB: large enough that a whole Plausible export is a handful of inserts,
     * small enough that a reclaimed lease loses at most one chunk of work and
     * that the rows of one chunk sit comfortably in the worker's heap beside
     * batch ingest.
     */
    IMPORT_STAGING_CHUNK_BYTES: z.coerce.number().int().min(1).default(8_388_608),
    /**
     * How long a run may sit in `uploading`/`uploaded` before the lifecycle
     * sweeper fails it and deletes the object.
     *
     * The same number the bucket's `imports/` expiry rule uses (D1), and the
     * ordering between the two matters: the sweeper is the mechanism of record
     * and the lifecycle rule is the backstop for objects our own bookkeeping
     * lost track of.
     */
    IMPORT_UPLOAD_TTL_DAYS: z.coerce.number().int().min(1).default(7),

    // ---------------------------------------------------------------------
    // Milestone 11 — export (ADR-0032, D8). Two values, and neither is a limit
    // on what a customer may ask for: an export exports everything. One bounds
    // what a single *object* may be — which is what keeps a site with years of
    // history from being an OOM in the worker, since the reader streams and the
    // chunk buffer is the only thing that accumulates — and the other is how
    // long the result stays downloadable.
    // ---------------------------------------------------------------------

    /**
     * Largest uncompressed NDJSON that goes into one exported object.
     *
     * A calendar month is the chunk unit, and a busy site's month can be far
     * larger than a worker's heap. When a month passes this, it is split into
     * `-p2`, `-p3` parts, so the bound on memory is this number rather than the
     * site's largest month. 64 MiB uncompressed is a handful of megabytes
     * gzipped — small enough to buffer beside batch ingest, large enough that a
     * year of an ordinary site is twelve objects rather than hundreds.
     *
     * **The real peak is roughly this plus the gzip output**, not this: the
     * uncompressed line buffer is still live while `gzip` produces the compressed
     * body, and both are held until the `put` returns. At the default that is
     * ~64 MiB plus a few MiB of NDJSON-compresses-well output, which is the
     * number to size a worker against — the cap alone would understate it.
     *
     * It is a policy value rather than a literal because it decides the *key
     * names* of a split month, and a deploy that retuned it mid-export would
     * make a resumed run look for objects the first attempt never wrote. The
     * resume path handles that safely (an unrecorded key is simply re-uploaded,
     * and a surplus part from the previous split is retracted), but the number
     * still belongs where somebody chose it.
     */
    EXPORT_MAX_CHUNK_BYTES: z.coerce.number().int().min(1).default(67_108_864),
    /**
     * How long an export's objects are downloadable.
     *
     * The same number the bucket's `exports/` expiry rule uses (D1), and the
     * ordering between the two matters in the opposite direction from the import
     * TTL: here the **lifecycle rule is the mechanism** — it is what actually
     * deletes the bytes — and this value is what makes the api stop offering a
     * download for objects the rule has already reaped.
     *
     * **Capped at 7, and the ceiling is not arbitrary**: it is the live bucket
     * rule `oa-exports-expire`, `Days: 7` on the `exports/` prefix, set from code
     * in CP1 and read back intact in ADR-0032's D1 live proof. A deployment that
     * raised this to 30 would not keep anything for 30 days — the rule would
     * still delete the objects on day 7 — it would only make the api mint signed
     * URLs for objects that no longer exist, and answer them with a storage 404
     * instead of the honest `410 EXPORT_EXPIRED`. Raising the retention means
     * changing the lifecycle rule first; the schema refuses to let the two drift
     * in the direction that lies to a customer.
     */
    EXPORT_OBJECT_TTL_DAYS: z.coerce.number().int().min(1).max(7).default(7),

    // --- Revenue ingest (ADR-0033, D2e/D4) ----------------------------------
    //
    // Every value below is decided by the ADR rather than invented here, which
    // is what makes them defaults instead of the fabricated gate values
    // AGENTS.md forbids. They live in policy rather than as literals for the
    // reason the import budgets do: a test has to be able to drive the same code
    // with a two-day window and a two-object page, and proving that a
    // ninety-day walk resumes correctly should not require a ninety-day walk.

    /**
     * How far back the initial backfill reaches (D2e).
     *
     * Ninety days covers the 30-day attribution window three times over and
     * gives a freshly connected dashboard immediate substance. Deeper backfill
     * is a recorded follow-up and is cheap to add — the cursor machinery does
     * not care about depth, only about runtime — which is precisely why the
     * depth is a number somebody set rather than a constant somebody typed.
     */
    REVENUE_BACKFILL_DAYS: z.coerce.number().int().min(1).max(3_650).default(90),

    /**
     * Objects per list request (D4). Stripe's own maximum for a list `limit`.
     *
     * Capped at 100 by the schema because that *is* the provider's ceiling: a
     * deployment setting 500 would not get larger pages, it would get whatever
     * the provider silently clamps to, and the cursor arithmetic would be
     * reasoning about a page size that never existed.
     */
    REVENUE_SYNC_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(100),

    /**
     * The reconcile sweep's trailing overlap window (D4).
     *
     * Forty-eight hours is the webhook safety net: a delivery Stripe dropped, or
     * one we answered 5xx to until it gave up, is caught by the next sweep. The
     * overlap is free because both paths land in the same ledger and the same
     * object head — re-listing an object we already hold produces an identical
     * payload hash and the three-way rule skips it.
     */
    REVENUE_RECONCILE_WINDOW_HOURS: z.coerce.number().int().min(1).max(720).default(48),

    /**
     * How stale a credential's `last_synced_at` must be before the sweep picks
     * it up (D4). The finalizer's discovery idiom, with the ADR's number.
     */
    REVENUE_RECONCILE_STALE_MINUTES: z.coerce.number().int().min(1).max(1_440).default(15),

    /** Credentials one reconcile tick may touch. Bounds the work per tick on an
     * installation with many connected sites; the next tick takes the rest. */
    REVENUE_RECONCILE_BATCH: z.coerce.number().int().min(1).max(200).default(10),

    /**
     * How often the ECB rate loop runs (D2c).
     *
     * The ECB publishes once per banking day at about 16:00 CET. Six hours means
     * the table is never more than six hours behind a publication without
     * hammering a public service that changes once a day — and because the
     * upsert is keyed on the ECB's own `rate_date`, the extra ticks over a
     * weekend cost one request and write nothing new.
     */
    REVENUE_CURRENCY_REFRESH_HOURS: z.coerce.number().int().min(1).max(168).default(6),

    /**
     * How long a site waits between two X mention polls (migration 0048).
     *
     * An hour by default: mentions are not realtime data, and the search
     * service is a shared public one with no published rate limit, so the
     * poller stays polite. Fifteen minutes is the floor for the same reason;
     * a day is the ceiling because a slower poll misses posts that fall off
     * the first result pages.
     */
    MENTIONS_POLL_MINUTES: z.coerce.number().int().min(15).max(1440).default(60),
  })
  .superRefine((policy, ctx) => {
    const latenessDays = policy.EVENT_MAX_LATENESS_HOURS / 24

    // A tracker may retry an event for up to the full lateness window. If the
    // dedup record expires first, that retry is accepted as a brand-new event
    // and is both stored and billed twice.
    if (policy.INGEST_DEDUP_TTL_DAYS <= latenessDays) {
      ctx.addIssue({
        code: 'custom',
        path: ['INGEST_DEDUP_TTL_DAYS'],
        message:
          `INGEST_DEDUP_TTL_DAYS (${policy.INGEST_DEDUP_TTL_DAYS}d) must exceed ` +
          `EVENT_MAX_LATENESS_HOURS (${policy.EVENT_MAX_LATENESS_HOURS}h)`,
      })
    }

    // Deletion finds retained stream entries through the site queue index. If
    // the index expires before the payloads do, deletion cannot prove it removed
    // everything it was supposed to remove.
    if (policy.SITE_QUEUE_INDEX_TTL_DAYS <= policy.ACKED_QUEUE_RETENTION_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['SITE_QUEUE_INDEX_TTL_DAYS'],
        message:
          `SITE_QUEUE_INDEX_TTL_DAYS (${policy.SITE_QUEUE_INDEX_TTL_DAYS}d) must exceed ` +
          `ACKED_QUEUE_RETENTION_DAYS (${policy.ACKED_QUEUE_RETENTION_DAYS}d)`,
      })
    }

    // The same rule for the other half of what the index names. The bucket now
    // carries each entry's event id so deletion can reach `ingest_dedup:{site}:
    // {event}`, which is not derivable from a stream id — and an index that
    // expires before those records do would leave a site's dedup keys behind
    // with nothing left pointing at them.
    if (policy.SITE_QUEUE_INDEX_TTL_DAYS <= policy.INGEST_DEDUP_TTL_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['SITE_QUEUE_INDEX_TTL_DAYS'],
        message:
          `SITE_QUEUE_INDEX_TTL_DAYS (${policy.SITE_QUEUE_INDEX_TTL_DAYS}d) must exceed ` +
          `INGEST_DEDUP_TTL_DAYS (${policy.INGEST_DEDUP_TTL_DAYS}d)`,
      })
    }

    // The orphan horizon is the *shorter* of the two idempotency windows by
    // construction: a claim older than the retention horizon is already swept
    // by the retention half, so an equal-or-longer value would make the
    // in-flight disjunct unreachable — a rule that reads as if it protects
    // against a permanently held key while doing nothing at all.
    if (policy.IDEMPOTENCY_CLAIM_MAX_AGE_HOURS >= policy.IDEMPOTENCY_KEY_RETENTION_HOURS) {
      ctx.addIssue({
        code: 'custom',
        path: ['IDEMPOTENCY_CLAIM_MAX_AGE_HOURS'],
        message:
          `IDEMPOTENCY_CLAIM_MAX_AGE_HOURS (${policy.IDEMPOTENCY_CLAIM_MAX_AGE_HOURS}h) must be ` +
          `below IDEMPOTENCY_KEY_RETENTION_HOURS (${policy.IDEMPOTENCY_KEY_RETENTION_HOURS}h)`,
      })
    }

    // The session cap must exceed the inactivity window (ADR-0018). A cap shorter
    // than the meaningful-inactivity gap would fire before an inactivity split
    // ever could, silently ending every session at the cap instead of at a real
    // gap — the cap is a safety bound on a runaway stream, not the primary
    // splitter, so it must sit strictly above the ordinary 30-minute rule.
    if (policy.SESSION_MAX_LENGTH_HOURS * 60 <= policy.SESSION_INACTIVITY_MINUTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_MAX_LENGTH_HOURS'],
        message:
          `SESSION_MAX_LENGTH_HOURS (${policy.SESSION_MAX_LENGTH_HOURS}h = ` +
          `${policy.SESSION_MAX_LENGTH_HOURS * 60}min) must exceed ` +
          `SESSION_INACTIVITY_MINUTES (${policy.SESSION_INACTIVITY_MINUTES}min)`,
      })
    }

    // The ingest-grace / retention-countdown invariant left with the two
    // variables it relates (`packages/domain/src/cloud/env.ts`): both describe a
    // site whose *bill* stopped, and a deployment that sells nothing never
    // suspends one.

    // The safety ceiling is a throttle on abuse, not a limit on use, so the
    // only invariant this schema can state about it is that it is a ceiling at
    // all. It used to be checked against the largest plan's monthly limit —
    // G-005's reasoning for 6,000,000 was that Pro's legitimate "all 5M in a
    // single day" had to fit underneath it — and that check moved out with the
    // catalog it read: a deployment that sells nothing has no largest plan, and
    // an operator who raises the ceiling is the only party who knows what their
    // own traffic looks like.
    if (policy.SITE_DAILY_EVENT_CEILING < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['SITE_DAILY_EVENT_CEILING'],
        message: 'SITE_DAILY_EVENT_CEILING must be at least 1',
      })
    }

    // The bot ruleset version is stamped onto every security counter. A
    // deployment able to claim v2 while running v1's signatures would make that
    // record a lie, and the record is the only evidence of what was filtered.
    if (policy.BOT_RULESET_VERSION !== BOT_RULESET_VERSION) {
      ctx.addIssue({
        code: 'custom',
        path: ['BOT_RULESET_VERSION'],
        message:
          `BOT_RULESET_VERSION is ${policy.BOT_RULESET_VERSION} but this build ships ` +
          `ruleset v${BOT_RULESET_VERSION}; the ruleset changes by pull request (G-005), ` +
          `not by environment variable`,
      })
    }

    // The 0.5-1.5 s band of docs snapshot 02 §7.5 has to be a band. Inverted, a
    // batch would be required to flush before the earliest time it is allowed
    // to, and the SLO the freshness measurement reports against would be
    // unsatisfiable by construction.
    if (policy.WORKER_BATCH_MIN_FLUSH_MS > policy.WORKER_BATCH_MAX_FLUSH_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['WORKER_BATCH_MIN_FLUSH_MS'],
        message:
          `WORKER_BATCH_MIN_FLUSH_MS (${policy.WORKER_BATCH_MIN_FLUSH_MS}ms) must not exceed ` +
          `WORKER_BATCH_MAX_FLUSH_MS (${policy.WORKER_BATCH_MAX_FLUSH_MS}ms)`,
      })
    }

    // A reclaimer that can steal a batch a healthy worker is still holding
    // produces two workers on one manifest. Idempotency downstream survives it,
    // but the lease exists so it does not happen routinely, and a claim timeout
    // at or below the lease guarantees it does (02 §7.5).
    if (policy.WORKER_CLAIM_MIN_IDLE_MS <= policy.WORKER_LEASE_TTL_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['WORKER_CLAIM_MIN_IDLE_MS'],
        message:
          `WORKER_CLAIM_MIN_IDLE_MS (${policy.WORKER_CLAIM_MIN_IDLE_MS}ms) must exceed ` +
          `WORKER_LEASE_TTL_MS (${policy.WORKER_LEASE_TTL_MS}ms)`,
      })
    }

    // Docs snapshot 02 §7.5: "the ClickHouse deduplication window is configured
    // larger than the queue/manual retry horizon". The window counts blocks
    // per table, not seconds, so the retry horizon is converted at the worker's
    // fastest sustainable flush cadence. A retry landing outside the window is
    // not deduplicated — it is a second copy of the data, and the only symptom
    // is a number that is quietly too large.
    let horizonMs = 0
    for (let attempt = 1; attempt < policy.WORKER_BATCH_MAX_ATTEMPTS; attempt += 1) {
      horizonMs += Math.min(
        policy.WORKER_RETRY_BASE_MS * 2 ** (attempt - 1),
        policy.WORKER_RETRY_MAX_MS,
      )
    }
    const horizonBlocks = Math.ceil(horizonMs / policy.WORKER_BATCH_MAX_FLUSH_MS)
    if (horizonBlocks >= policy.CLICKHOUSE_DEDUP_WINDOW_BLOCKS) {
      ctx.addIssue({
        code: 'custom',
        path: ['CLICKHOUSE_DEDUP_WINDOW_BLOCKS'],
        message:
          `CLICKHOUSE_DEDUP_WINDOW_BLOCKS (${policy.CLICKHOUSE_DEDUP_WINDOW_BLOCKS}) must exceed ` +
          `the retry horizon of ${horizonBlocks} blocks (${horizonMs}ms across ` +
          `${policy.WORKER_BATCH_MAX_ATTEMPTS} attempts at one flush per ` +
          `${policy.WORKER_BATCH_MAX_FLUSH_MS}ms); a retry outside the window is not ` +
          `deduplicated, it is a duplicate`,
      })
    }

    // The three import size budgets have to be a chain: the archive is what
    // arrives, an entry is what one file inside it inflates to, and the total is
    // every entry together. Inverted anywhere, the tighter bound upstream makes
    // the looser one downstream unreachable — a total below the per-entry cap,
    // for instance, means the entry cap can never be the rule that fires, so a
    // deployment that raised it would believe it had loosened something it had
    // not (ADR-0032, D6).
    if (policy.IMPORT_MAX_ARCHIVE_BYTES > policy.IMPORT_MAX_ENTRY_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['IMPORT_MAX_ENTRY_BYTES'],
        message:
          `IMPORT_MAX_ENTRY_BYTES (${policy.IMPORT_MAX_ENTRY_BYTES}) must be at least ` +
          `IMPORT_MAX_ARCHIVE_BYTES (${policy.IMPORT_MAX_ARCHIVE_BYTES})`,
      })
    }
    if (policy.IMPORT_MAX_ENTRY_BYTES > policy.IMPORT_MAX_TOTAL_UNCOMPRESSED_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['IMPORT_MAX_TOTAL_UNCOMPRESSED_BYTES'],
        message:
          `IMPORT_MAX_TOTAL_UNCOMPRESSED_BYTES (${policy.IMPORT_MAX_TOTAL_UNCOMPRESSED_BYTES}) ` +
          `must be at least IMPORT_MAX_ENTRY_BYTES (${policy.IMPORT_MAX_ENTRY_BYTES})`,
      })
    }

    // The hub's timer may not ask for work the snapshot cache is entitled to
    // refuse (ADR-0035, D5). A refresh cadence faster than the cache window
    // would wake the hub only to find the cached snapshot still fresh, so the
    // extra ticks buy nothing and the configured cadence would stop describing
    // what the stream actually does.
    if (policy.REALTIME_SNAPSHOT_REFRESH_SECONDS < policy.REALTIME_SNAPSHOT_CACHE_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['REALTIME_SNAPSHOT_REFRESH_SECONDS'],
        message:
          `REALTIME_SNAPSHOT_REFRESH_SECONDS (${policy.REALTIME_SNAPSHOT_REFRESH_SECONDS}s) must be ` +
          `at least REALTIME_SNAPSHOT_CACHE_SECONDS (${policy.REALTIME_SNAPSHOT_CACHE_SECONDS}s)`,
      })
    }

    // The site total is an infrastructure guard, not a per-visitor rule. Set
    // below one IP's burst, a single ordinary visitor would trip it and every
    // other visitor on the site would be throttled for a reason none of them
    // caused.
    if (policy.RATE_LIMIT_SITE_PER_MINUTE < policy.RATE_LIMIT_IP_SITE_BURST) {
      ctx.addIssue({
        code: 'custom',
        path: ['RATE_LIMIT_SITE_PER_MINUTE'],
        message:
          `RATE_LIMIT_SITE_PER_MINUTE (${policy.RATE_LIMIT_SITE_PER_MINUTE}) must be at least ` +
          `RATE_LIMIT_IP_SITE_BURST (${policy.RATE_LIMIT_IP_SITE_BURST})`,
      })
    }
  })

export type Policy = z.infer<typeof policySchema>

export function loadPolicy(source: Record<string, string | undefined> = process.env): Policy {
  const result = policySchema.safeParse(source)
  if (!result.success) {
    throw new PolicyValidationError(result.error)
  }
  return result.data
}

export class PolicyValidationError extends Error {
  readonly issues: readonly { path: string; message: string }[]

  constructor(error: z.ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }))
    super(
      `Invalid policy configuration:\n${issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    )
    this.name = 'PolicyValidationError'
    this.issues = issues
  }
}
