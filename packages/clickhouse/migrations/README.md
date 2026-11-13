# ClickHouse migrations

Files are named `NNNN_snake_case_name.sql` and applied in version order by the
dedicated migration credential. No DDL ever runs from a request handler
(docs snapshot 02 §15).

Table names are written **unqualified**. The runner applies statements with the
configured database as the session default, which is what lets the same files
build the production `analytics` database and a throwaway one in CI.

Rules:

- **Statements must be idempotent.** ClickHouse has no multi-statement
  transaction, so the ledger marks a migration `pending` before the DDL and
  `applied` after. A crash in between leaves a visible unfinished row, and the
  re-run must be safe — use `IF NOT EXISTS`.
- **No semicolon inside a comment.** The runner splits statements on the
  semicolon before it strips comment lines, so one in a comment cuts a statement
  in half. Found the hard way while applying 0001 (ADR-0010).
- **Every MergeTree-family table sets `non_replicated_deduplication_window`**,
  including every materialized-view target. On a non-replicated MergeTree,
  insert deduplication is off by default and the stable batch token is accepted
  and ignored; setting it only on the raw table deduplicates the raw rows while
  the view fires again on every retry (ADR-0005 measured a silent 3x).
  `tests/migration/clickhouse-analytics.test.ts` fails a migration that forgets
  it, because this is the kind of mistake that is invisible when wrong.
- **Forward-only**, same as Postgres (docs snapshot 05, D-214).
- **A materialized view change is a multi-step migration.** Creating the new
  target, backfilling it and swapping to it are separate, explicit steps. A
  source-table change does not retroactively fix an MV target
  (docs snapshot 02 §15).
- **Deletion is not inherited.** Dropping rows from the raw table does not clean
  the rollup, session, import, attribution or revenue targets. Each is deleted
  and verified separately by the deletion workflow (docs snapshot 05, D-210).

## Milestone 6

| Version | Subject                                                                |
| ------- | ---------------------------------------------------------------------- |
| 0001    | `events_raw` — the canonical raw analytics fact (docs snapshot 02 §15) |
| 0002    | `performance_events` + its materialized view over `events_raw`         |
| 0003    | `metrics_1m` + its materialized view — the first additive fact rollup  |
| 0004    | Repoint `performance_events_mv` at the server-owned `oa_` payload keys |

## Milestone 7 — the additive rollup family

Checkpoint A (plan Milestone 7 items 1–3). Every rollup view reads **directly
from `events_raw`**, never from another rollup: ADR-0005 measured the
single-level dependent-view dedup behaviour, and reading straight from the raw
table keeps the whole family inside that proven model rather than a two-level
cascade whose second-level token derivation is unmeasured (0006 argues this in
full). Unique visitors are kept as a mergeable `uniqState` everywhere — bucket
uniques are never summed (plan item 2). The identity is
`if(user_id != '', user_id, anonymous_id)` (docs snapshot 02 §10; 0005).

| Version | Subject                                                                  |
| ------- | ------------------------------------------------------------------------ |
| 0005    | `metrics_1m` unique-visitor `uniqState` column by `ALTER` + view repoint |
| 0006    | `metrics_1h` / `metrics_1d` + views — the overview/timeseries rollups    |
| 0007    | `pages_1h` / `pages_1d` + views                                          |
| 0008    | `sources_1h` / `sources_1d` + views                                      |
| 0009    | `geography_1h` / `geography_1d` + views                                  |
| 0010    | `devices_1h` / `devices_1d` + views                                      |
| 0011    | `custom_events_1h` / `custom_events_1d` + views                          |
| 0012    | `performance_1h` / `performance_1d` + views (t-digest percentile states) |

Revenue rollups are **not** incremental views at all and are deliberately not
created in M7 (docs snapshot 05, D-211/D-212). They come from the revenue
normalize → fact → attribution → rollup sequence.

## Milestone 8 — session facts and rollups (Checkpoint A)

Session and bounce are **not** an incremental materialized view either (D-211): a
late second pageview must be able to undo a recorded bounce, which an insert-once
view cannot do. There is no `CREATE MATERIALIZED VIEW` in either file below.
`session_facts_versions` is written by the finalizer as versioned rows (latest
version per session is the truth, selected with `argMax`/`LIMIT 1 BY` — never
`FINAL` for correctness). The rollups are recompute/swap targets keyed by a
`generation` column the reader filters on, chosen over `REPLACE PARTITION` because
the swap must be per-(site, bucket) without an unbounded partition count. Every
table stays read-correct before any merge (ADR-0005); the engine's replacement
only reclaims space from superseded versions/generations.

| Version | Subject                                                                     |
| ------- | --------------------------------------------------------------------------- |
| 0013    | `session_facts_versions` — versioned canonical session facts, no MV         |
| 0014    | `session_rollups_1h` / `session_rollups_1d` — finalizer swap targets, no MV |

## Milestone 11 — imported aggregates

Imported provider data never enters `events_raw` or the additive rollup family
(ADR-0032, D2). It is staged into its own eight day-grain tables keyed by
`(site_id, import_run_id, date)`, and a run becomes visible by a Postgres pointer
swap rather than by a write — which is what makes a publish, a rollback and a
per-run cleanup all cheap and reversible.

| Version | Subject                                                                                 |
| ------- | --------------------------------------------------------------------------------------- |
| 0015    | the eight `imported_*_1d` staging targets — written by the worker on `oa_ingest`, no MV |

## Milestone 12 — revenue

D-212 fixes the order and the migration ledger is what proves it: the normalized
fact comes first, attribution second, the rollups last. **The rollups cannot
predate the fact**, because the runner applies files in version order and refuses
to skip — so a database holding `revenue_1h` necessarily holds `revenue_events`.
That is plan 04 M12's fourth acceptance criterion, and
`tests/unit/revenue-migration-order.test.ts` asserts it against the files on disk
so a future checkpoint cannot land a rollup under a lower number.

Revenue rollups are **not** incremental materialized views (D-211/D7): revenue is
refundable and versioned, so an insert-only view is structurally wrong. They are
generation-swapped recompute targets built by reading the fact through the
`argMax(col, version)` rule — never `FINAL`, never a pre-filter on a column a
version can change.

| Version | Subject                                                                     |
| ------- | --------------------------------------------------------------------------- |
| 0016    | `revenue_events` — the canonical fact, `ReplacingMergeTree(version)`, no MV |
| 0017    | `revenue_attributions` + session-fact `utm_content`/`utm_term` (CP4)        |
| 0018    | `revenue_1h` / `revenue_1d` — attribution-job swap targets (CP5)            |
| 0019    | `revenue_events.fee_currency` — fees become readable (M12 follow-up)        |

0017 is two halves of one decision and they ship together: the touchpoints an
attribution names **are** session-fact rows (D6 refuses a second
`attribution_touchpoints` table), so widening the fact and creating the table
that points at it must not be separable. The two `ALTER TABLE ... ADD COLUMN IF
NOT EXISTS` do not re-version a single stored session on their own — ClickHouse
fills an added column with its type default in older parts, and `''` is exactly
the value `sessionize` already produces for an absent utm, so a stored fact
compares unequal to its recompute only when the session genuinely carried one.

## ADR-0079 — the atom grain is fifteen minutes

Every non-UTC day is composed at read time from an hour rollup with
`toStartOfDay(bucket_start, tz)`, which is why a zone whose offset is not a
whole number of hours (+05:30, +05:45, +08:45, +12:45) could not be served:
the atom was an hour. Every IANA offset in force since 1972 is a multiple of
fifteen minutes, so 0025 adds a fifteen-minute twin of each additive family —
same DDL, same view `WHERE`, `toStartOfFifteenMinutes` for the bucket — beside
the hour tables. Nothing reads them yet (ADR-0079 D2: beside first, instead
later), and the hour tables are not dropped here.

| Version | Subject                                                                    |
| ------- | -------------------------------------------------------------------------- |
| 0025    | the eight `*_15m` rollups + views, direct from `events_raw` — creates only |

### Backfilling the 15m family

A materialized view aggregates only what is inserted after it exists, so on a
populated database 0025 leaves the eight tables empty for everything already
stored. The backfill is the separate, explicit step this file's rules require,
and its order is fixed (ADR-0079 D3):

1. **stop the worker** — the queue is in Valkey, nothing is lost;
2. apply 0025 (`node packages/clickhouse/dist/cli.js`, twice — the second run
   applies nothing);
3. `node packages/clickhouse/dist/cli.js backfill-15m` — same credential, same
   env. It refuses (exit 2, nothing written) if any 15m table already holds a
   row or if `events_raw` moves between two readings ten seconds apart, and
   exits 3 if a filled pair disagrees with `events_raw` (the hour twins until
   v0.8.0). `--dry-run` runs both guards and prints the partition plan;
   `--accept-site <uuid>` excludes a site whose raw rows were purged by hand
   from the equality gate (it is still listed);
4. **start the worker** on the image that carries 0025.

There is no `--force`. A deliberate second backfill is a hand `TRUNCATE` of the
eight tables with the worker stopped, and then step 3 again.

### 0026 — the two swap rollups

| Version | Subject                                                     |
| ------- | ----------------------------------------------------------- |
| 0026    | `session_rollups_15m` + `revenue_15m` — two tables, no view |

The other eight families are materialized views, so 0025 plus one backfill was
the whole story. These two are written by the worker — the session finalizer
and the revenue attribution job — with the same recompute-compare-swap
discipline as their hour twins, which makes two things deploy steps rather than
SQL.

**The grant, and the recreate.** `oa_ingest` needs `INSERT` **and** `SELECT` on
both new tables. `SELECT` is load-bearing: the swap reads the current
generation of every affected bucket before it writes, and without it every pass
would rewrite a rolling month of identical rows at a new generation. The grant
lives only in the ClickHouse entrypoint's `users.d` XML, which is rendered at
container start, so it appears only after a container **recreate**
(`up -d --force-recreate --no-deps`). A `docker compose restart` re-runs the
entrypoint with the container's original environment and the new lines never
land. Verify with `SHOW GRANTS FOR oa_ingest` before migrating.

**History, in two different shapes.** Order for the whole step:

1. **stop the worker**;
2. update the entrypoint on the ClickHouse host and **recreate** the container
   (reads fail for roughly half a minute — expected), then confirm the four new
   grant lines;
3. apply 0026 (twice — the second run applies nothing);
4. `node packages/clickhouse/dist/cli.js backfill-15m --sessions` for the
   session half. Same credential and env as the 0025 backfill. It refuses
   (exit 2, nothing written) if `session_rollups_15m` already holds a row, and
   exits 3 if a filled quarter disagrees with a fresh recompute from
   `session_facts_versions` (until v0.8.0: if an hour rollup did not equal the
   sum of its four quarters). `--dry-run` prints the per-site plan. It writes `generation = 0`,
   which the finalizer's `max + 1` overwrites the first time it touches a
   bucket (as run on the hosted deployment on 2026-09-03 it wrote generation 1
   behind a stopped-worker guard; the gap-fill rework below moved it to 0 and
   dropped the guard);
5. **start the worker** on the image that carries 0026;
6. the revenue half has no backfill. Pull each revenue site's re-roll cursor
   (`revenue_attribution_state.rollup_recompute_from`) back to its oldest
   `revenue_events.occurred_at` with
   `node apps/worker/dist/revenue/seed-15m-reroll.js`, and the attribution job
   walks it forward a month per pass until the cursor clears. That is the
   existing mechanism a currency change already uses — no ad-hoc SQL.

There is no `--force` here either. A deliberate re-run of the session backfill
is a hand `TRUNCATE session_rollups_15m` with the worker stopped, then step 4.

### 0027 — the hour views are retired

| Version | Subject                                                                   |
| ------- | ------------------------------------------------------------------------- |
| 0027    | drops the eight `*_1h_mv` materialized views — the tables themselves stay |

Step 3 moved every read to the fifteen-minute family, so the hour views spent
ten days writing eight tables nobody read. This drops them, and with them about
a third of ingest's insert work (step 1 measured the rise when the 15m family
was added beside the hour one). `_1d` is untouched — the day family is read
directly for every UTC day and week.

**The `*_1h` tables are kept deliberately**, as frozen history:

- the 15m backfill proves itself against them (below), so an install that
  dropped them would have no equality gate left for its own upgrade;
- the deletion workflow's targets do not change (docs snapshot 05, D-210) — a
  site erased tomorrow must still be erased from rows written yesterday.

Both reasons lapsed in v0.8.0 and 0029 drops the tables — see below.

The two swap rollups are not in this file because they are not DDL: the session
finalizer and the revenue attribution job stop writing `session_rollups_1h` and
`revenue_1h` in the same release, and the compiler proves it — `'1h'` leaves
`SessionRollupUnit` and `RevenueRollupUnit`, so a write to either table no
longer type-checks.

**Order on a self-host upgrade: 0027 does not have to wait for the backfill.**
The question is natural — 0027 removes the writers of the tables the backfill
compares against — and the answer is that it does not matter, in either order:

1. the backfill reads `events_raw`, never a rollup, so nothing it writes comes
   from a view;
2. its equality gate read the hour tables, which this migration does not
   touch — they held every row their views ever wrote (since v0.8.0 the gate
   reads `events_raw` instead, which settles the question for good);
3. the worker is stopped for the whole backfill (D3), so the hour tables were
   already frozen at the moment the run started, with or without 0027.

The runner applies files in version order regardless, so on a normal upgrade
0027 lands with 0025 and 0026 before the backfill is invoked at all.

### `backfill-15m --if-needed` — a gap fill

The plain `backfill-15m` is the hand-run step above and keeps its refusals: every
target must be empty and `events_raw` must be still. `--if-needed` is the
automated one — the self-hosted migrate container runs it on every start — and
it refuses nothing. It fills **gaps**: a `(site_id, quarter hour)` that
`events_raw` has events for and the target holds no row for at all. A pair that
holds a row is never written, whoever wrote it.

| Starting state                                                  | What happens                                  |
| --------------------------------------------------------------- | --------------------------------------------- |
| all targets empty (worker stopped for the upgrade)              | all of history is filled                      |
| views already writing (worker kept running through the upgrade) | history below each site's first row is filled |
| some targets empty because the install has no such events       | each family is filled on its own              |
| no gap anywhere                                                 | nothing written, `noop: true`, exit 0         |

Why this replaced the old "all empty / all populated / refuse the mix" rule
(v0.7.0 prework): the mix is the NORMAL state of an install without custom
events (`custom_events_15m` stays empty), so the old rule exited 2 and
`depends_on: service_completed_successfully` kept the whole stack — collector
included — down; and "all populated" was also the state of an upgrade whose
worker kept running, so the old rule skipped all of history silently.

What a gap fill cannot recover is the **seam**: a pair the view had already
started writing when history was filled keeps only what the view saw. That is at
most one quarter hour per site, only on an upgrade whose worker was not
stopped, and a late event (its `occurred_at` before the view existed) seams its
own pair and nothing more. The run measures it rather than hiding it: `witness`
in the report compares `metrics_15m` with `events_raw` pair by pair (`gap*`,
`seam*`, and `over*` — which must be 0; a non-zero `over` means a double count or
raw rows purged by hand).

The live quarter hour is filled only when `events_raw` is still across two
readings `--settle-seconds` apart (taken only when that quarter hour has a gap),
so the fill and a running view never meet in one pair.

The equality gate compares every family with `events_raw`, pair by pair below
the live quarter hour, and exits 3 on a disagreement. It allows exactly one
difference: a pair the site already held before the run may hold fewer events
than raw — the seam above. A pair short below the site's first pre-existing row,
a pair over raw, a raw pair with no row, a row with no raw pair: all exit 3. A
failing family is read once more after a short pause first, so an insert caught
between its raw part and its view's part never fails a run.

Until v0.8.0 the gate compared with the hour twins instead, and that was wrong
in one ordinary case: 0027 froze the hour tables, so an event the worker drained
from its queue after 0027 (a late event, with an `occurred_at` in the filled
history) landed in the 15m row and in `events_raw`, and not in the reference.
The run then exited 3 — "history fill failed" — over data that was right. Raw is
the table every view reads, so it cannot fall behind a view.

The self-hosted migrate container treats every history-fill exit as non-fatal
(logged, retried on the next start), because a report is never worth keeping
the collector down for. Since the gate reads raw, a non-zero exit there is a real
disagreement and worth reading.

`--sessions --if-needed` is the same gap fill for `session_rollups_15m`, written
at **generation 0** — below anything the finalizer mints — so a bucket the
finalizer writes, before or after the fill, always wins. That is what lets it
run beside a live worker; the old stopped-worker guard is gone with it. The
plain `--sessions` also writes generation 0 now.

The revenue half is `apps/worker/dist/revenue/seed-15m-reroll.js --if-needed`: it
seeds the re-roll cursor only for sites whose `revenue_1d` has a live bucket on a
day `revenue_15m` does not reach, so it settles to nothing by itself once the
walk has passed a site, and never restarts a finished re-roll.

### 0028 — the history-fill ledger

| Version | Subject                                                          |
| ------- | ---------------------------------------------------------------- |
| 0028    | `backfill_ledger` — evidence of the three history fills, no view |

One row per fill (`rollups_15m`, `session_rollups_15m`, `revenue_15m_reroll`),
`ReplacingMergeTree(completed_at)`, `detail` = the run's own report as JSON. A
fill records itself when it wrote something, or on the first run that found
nothing. **Nothing reads it to decide** — every fill computes its gap from the
tables — so a lost ledger changes no fill. It exists for the operator. (It was
once meant to hold back the v0.8 drop of the hour tables on a database whose 15m
history was never filled. That turned out unnecessary: the fill reads
`events_raw` and its gate does too, so neither needs an hour table — see 0029.)

The migration writes no row itself: on a self-hosted install a row must mean "a
fill ran here". A database whose fills ran before 0028 existed (the hosted one)
records them by hand: `node packages/clickhouse/dist/cli.js ledger record <name>
'<detail-json>'`; `ledger` alone prints the table.

### 0029 — the hour tables go (v0.8.0)

| Version | Subject                                                                       |
| ------- | ----------------------------------------------------------------------------- |
| 0029    | drops the ten `*_1h` tables — eight view targets + two swap targets; no `_1d` |

0027 kept the tables for two reasons, and v0.8.0 retires both: the 15m backfill's
equality gate reads `events_raw` now, and the deletion registry stops naming
the ten tables in the same release (`packages/domain/src/deletion.ts`, 44 → 34
ClickHouse targets). A target naming a dropped table would fail every
deletion, which is why the two cannot ship apart. `_1d` stays: every UTC day and
week reads it directly.

The migration deletes rows, so it is not undone by running an older image: an
older image would find none of these tables. Going back means restoring the
pre-upgrade backup (`./rollback.sh` on a self-hosted install), or — to get the
hour grain back on purpose — a new migration that re-creates 0006–0012, 0014,
0018 and 0021 and a replay from `events_raw` and the session and revenue facts,
all of which are kept.

**An install that skips 0.7 (0.6 → 0.8) needs nothing by hand.** The runner
applies 0025 through 0029 in one run, so the hour tables are dropped **before**
the 15m history is filled — the migrate container runs the fills after the
migrations. That order is safe only because of the gate change above: the fill
reads `events_raw`, and its proof reads `events_raw`, so no step of it looks at
an hour table. (Under the v0.7 gate it would have had no reference left and
compared nothing.) The one thing the hour tables held that raw does not is rows
whose raw events were purged by hand after they were rolled up — the hosted
deployment's 2026-08-25 cleanup, the reason `--accept-site` exists; the `_1d`
twins keep those days.

### 0030 — custom-event property breakdowns (Perier fork, DataFast gap 6)

| Version | Subject                                                                           |
| ------- | --------------------------------------------------------------------------------- |
| 0030    | `custom_event_properties_15m` / `_1d` + views, keyed (event, property key, value) |

Additive: two targets and two views reading straight from `events_raw`, nothing
existing touched. `oa_*` keys and `order_id` are never stored, values are cut to
100 characters, and the cardinality cap (top N values per key plus an `other`
row, at most 32 keys) is applied at read time by
`analytics.custom_event_properties_{hour,day}`. Both tables are deletion targets.

History is a separate, explicit step:
`node packages/clickhouse/dist/cli.js backfill-event-properties [--dry-run] [--days N]`
fills the last 92 days (at most), `(site, bucket)` pairs with no row only, one
UTC day per statement, never the live bucket. It is safe beside a running worker
and a second run writes nothing; it records itself in `backfill_ledger` as
`custom_event_properties`. It is not wired into the migrate container's start,
so it costs nothing until an operator runs it.

Rollback: drop the two views, then the two tables, and take the two names out
of `DELETION_CLICKHOUSE_TARGETS` in the same release.
