import { randomUUID } from 'node:crypto'
import { loadMigrations } from '@openanalytics/migrations'
import { migratePostgres, schemaTableColumns } from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CLOUD_MIGRATIONS_DIR,
  PRODUCT_MIGRATIONS_DIR,
  applyPostgresStreams,
} from '../support/postgres-streams.ts'

/**
 * The "empty DB bootstrap test in the same PR" acceptance line.
 *
 * Runs the real PRODUCT stream (`packages/postgres/migrations`) against a
 * genuinely empty schema and proves four things:
 *   1. the product schema builds from empty ON ITS OWN, and its ledger records
 *      exactly the versions on disk (derived from the directory, so a new
 *      migration cannot be forgotten here);
 *   2. the cloud stream then applies cleanly on top (deploy order:
 *      product first, then cloud — its own asserts live in
 *      `cloud-schema.test.ts`);
 *   3. the Drizzle schema objects have not drifted from the SQL — every column
 *      each table declares actually exists in the migrated database (ADR-0006's
 *      mitigation for defining the schema in two places);
 *   4. re-running both streams applies nothing.
 *
 * Skipped without TEST_POSTGRES_URL so a contributor with no database can still
 * run the rest of the suite; CI always provides one.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

/** Derived from the directory, so a new migration cannot be forgotten here. */
const expectedVersions = async (): Promise<string[]> =>
  (await loadMigrations(PRODUCT_MIGRATIONS_DIR)).map((file) => file.version)

/** Constraints whose presence is part of the schema's intent, not incidental.
 * PRODUCT stream only — the cloud stream's constraints (billing assignments,
 * subscriptions, trial, usage windows) are asserted in `cloud-schema.test.ts`. */
const EXPECTED_CONSTRAINTS = [
  'site_members_site_user_key',
  'api_keys_private_no_raw_check',
  // ADR-0043 D8 (migration 0036): a key states who holds its secret, because
  // that is what decides whether it survives its holder's departure. Two values
  // and no third — an unrecognized one would be read as `user` by the code,
  // which revokes, and a column that can silently mean "revoke" is not one to
  // leave unconstrained.
  'api_keys_held_by_check',
  // ADR-0043 D9 (migration 0037): the three states Better Auth writes to a
  // device authorization. Constrained so a fourth arriving from a library
  // upgrade is a failed insert rather than a row the token exchange reads as
  // neither approved nor denied — and therefore as not-yet-approved, forever.
  'device_codes_status_check',
  // Usage is applied exactly once per batch (D-209). Regrained by 0022: the
  // exactly-once guard carries the site dimension, NULLS NOT DISTINCT so rows
  // with a NULL site_id or usage_window_id keep it too.
  'usage_batch_deltas_batch_user_window_site_key',
  // M5: the tracker-config bounds mirror the M4 contract, so a value outside
  // them fails at the database rather than reaching a browser.
  'site_ingest_settings_interaction_sampling_check',
  'site_ingest_settings_heartbeat_interval_seconds_check',
  // M6: one queue message belongs to exactly one manifest (D-209 step 3), row
  // order inside a batch is a set of distinct positions (02 §7.5), and a site is
  // registered at most once per batch in the write fence (D-210).
  'ingest_batches_batch_id_key',
  'ingest_batch_items_stream_message_key',
  'ingest_batch_items_batch_position_key',
  'ingest_batch_sites_batch_site_key',
  // M7: a public share slug matches the public-slug shape (§20).
  'site_public_dashboard_slug_format',
  // The site's own slug matches the same shape, added by 0035 (ADR-0019 known
  // gap 5). Listed immediately below its twin because the finding was the
  // asymmetry: the public mirror carried the CHECK from 0011 and the column it
  // mirrors did not.
  'sites_slug_format',
  // M8: the finalizer's per-site lease is all-or-nothing — a held lease names
  // its holder and a released one names neither (D-211).
  'session_finalizer_state_lease_check',
  // M10 surface completion: one inbound idempotency claim per (caller, scope,
  // key), which is what makes a retried create a replay rather than a second
  // create (02 §18).
  'idempotency_keys_user_scope_key',
  // ADR-0025: a queue age is a duration and never negative — a clock skew that
  // produced one would read back as "the queue is ahead of now" and pass the
  // freshness comparison as healthy.
  'worker_heartbeats_queue_age_check',
  // ADR-0026: the stored timezone is bounded and identifier-shaped at the
  // database, so a direct SQL write cannot plant a value the read path would
  // have to defend against. Whether the identifier exists in the IANA set is a
  // question only a tz-aware runtime can answer, and the API answers it on write.
  'users_timezone_format',
  // Stored funnels: the saved definition's bounds are the compute endpoint's
  // bounds. A definition outside them could be saved and would then fail every
  // time it was run, on a screen whose only action is to read.
  'funnels_name_length_check',
  'funnels_steps_check',
  'funnels_window_ms_check',
  // ADR-0030 D3 (migration 0020): a job's lease is all-or-nothing, and its
  // producer handle is unique. The half-lease is what a crash between two
  // UPDATEs would leave, and it reads as a job nobody can ever claim again.
  'jobs_lease_check',
  'jobs_idempotency_key_key',
  // ADR-0030 D4/D7 (migration 0021): the deletion target snapshot is a *set*
  // whose phase vocabulary is closed. Without the unique, a re-executed start
  // transaction doubles the snapshot and "every target completed" can pass on a
  // half-purged site; without the CHECK, an unrecognised phase reads as
  // "not completed" forever.
  'deletion_targets_request_store_target_key',
  'deletion_targets_phase_check',
  // ADR-0032 D3 (migration 0023): a run's state vocabulary is closed, and the
  // pointer on `sites` names a run that exists. The CHECK is what stops an
  // unrecognised state from reading as "not live" and letting a second import
  // start beside the first.
  'import_runs_state_check',
  'sites_published_import_run_id_fkey',
  // One upload row per run: `pinUploadEtag` writes *the* row of a run and
  // `readImportUpload` reads *the* row of a run, so a second row would let one
  // of them miss what the other wrote — and the ETag the worker verifies the
  // downloaded bytes against would be whichever row the read happened to find.
  'import_uploads_run_key',
  // The finalizer's control row belongs to a site that exists. Integrity only —
  // no cascade, because the sites row becomes a tombstone rather than being
  // hard-deleted, and the purge phase removes this row by name.
  'session_finalizer_state_site_id_fkey',
  // ADR-0033 D3 (migration 0026): the credential store's three intents.
  // The status vocabulary is closed, so an unrecognised value cannot read as
  // "not disabled" and let a second connection live beside the first. The
  // webhook token is globally unique, because it is what CP2's endpoint resolves
  // a credential from and two rows sharing one would make one site's revenue
  // reachable through another site's URL. And the erasure CHECK is the one that
  // matters most: a disabled row may hold no ciphertext, so "disconnect erases
  // the secret" is a database rule rather than an application habit.
  'revenue_credentials_status_check',
  'revenue_credentials_webhook_token_key',
  'revenue_credentials_disabled_erased_check',
  // ADR-0033 D2c: the site's reporting currency is ISO-4217-shaped at the
  // database, so a direct SQL write cannot plant a value the conversion layer
  // would have to defend against.
  'sites_reporting_currency_format',
  // ADR-0044 D4 (migration 0039): the site's reporting timezone is bounded and
  // identifier-shaped at the database, a literal mirror of `users_timezone_format`
  // above. It is what refuses an offset zone such as `+05:00` — which `Intl`
  // accepts as a time zone and this product does not — so a direct SQL write
  // cannot plant a value the public read would have to defend against. Its
  // `IS NULL OR …` arm is unreachable since migration 0046 made the column NOT
  // NULL (ADR-0079 D5); the constraint is left as written rather than rewritten
  // to delete an arm that can no longer be taken.
  'sites_reporting_timezone_format',
  // ADR-0033 D4 (migration 0027): the ingest layer's two idempotency rules and
  // the vocabularies they rest on.
  //
  // `revenue_provider_events_site_event_key` is the *delivery* rule, and its
  // site column is deliberate: one Stripe account connected to two OA sites
  // must process the same `evt_…` once per site, which an account-global
  // `(provider, event_id)` unique structurally cannot express.
  //
  // `revenue_objects_site_object_key` is the *state* rule — the row the
  // three-way decision locks — and `revenue_objects_version_check` guards the
  // counter CP3's `ReplacingMergeTree(version)` will order by: a version below
  // one would mean an apply path computed it wrong, and that is worth refusing
  // to store rather than discovering in a ClickHouse read.
  //
  // `revenue_sync_state_credential_resource_key` is what makes the cursor an
  // upsert target rather than an append: two workers racing one resource
  // converge on one row instead of leaving two half-walked cursors.
  'revenue_provider_events_site_event_key',
  'revenue_provider_events_source_check',
  'revenue_provider_events_status_check',
  'revenue_objects_site_object_key',
  'revenue_objects_kind_check',
  'revenue_objects_version_check',
  'revenue_sync_state_credential_resource_key',
  'revenue_sync_state_resource_check',
  // Global reference data, and the two constraints are the ones that stop a bad
  // rate becoming a wrong number. `currency_rates_positive` in particular: a
  // zero or negative rate would convert every amount in that currency to
  // nothing or to its negation — the "outage renders as a confident zero"
  // failure this milestone is named after, arriving through the FX door.
  'currency_rates_currency_format',
  'currency_rates_positive',
  // ADR-0033 D5 (migration 0028): the projection marker's own guard.
  //
  // `projected_version <= version` is the database refusing a marker that claims
  // more than was ever minted. A caller that computed a version wrongly would
  // otherwise retire a head from the projection queue forever, and the symptom
  // would be a charge that is correct in Postgres and simply absent from
  // ClickHouse — the quietest failure this pipeline has.
  'revenue_objects_projected_version_check',
  // ADR-0045 (migration 0040): a widget's configuration is the parameters an
  // anonymous read will be served from, so the bounds the API validates against
  // are also floors in the database — a widget that could not be rendered must
  // not be storable.
  //
  // `widgets_id_format` is the one that carries the credential property: the id
  // is the widget's whole authorization, minted as 96 random bits behind a `w`,
  // and the pattern is a literal mirror of the contract's `WidgetId`.
  //
  // `widgets_range_check` states one rule in two clauses on purpose — a range is
  // present exactly when the surface has a window, and its value comes from the
  // dashboard's nine interval keys. Split, it would admit a `realtime` row
  // carrying a valid-looking range, which is a state the public read would then
  // have to decide about.
  //
  // The flat cap of fifty widgets per site is deliberately **not** here: a CHECK
  // cannot count sibling rows, and ADR-0045 D9 keeps the cap in application code
  // so that raising it is not a migration.
  'widgets_id_format',
  'widgets_surface_check',
  'widgets_range_check',
  'widgets_row_limit_check',
  'widgets_title_length_check',
  'widgets_allowed_origins_check',
  // X mentions (migration 0048): at most five terms and a known poll error on
  // the settings; one row per post per site, a known platform, bounded text
  // and https-only links on the posts.
  'site_mention_settings_terms_count_check',
  'site_mention_settings_last_error_check',
  'mentions_platform_check',
  'mentions_text_length_check',
  'mentions_url_check',
  'mentions_author_url_check',
  'mentions_site_platform_post_key',
  // Mention author pictures (migration 0049): one per author per site, a known
  // platform, a handle fit for the API path, an image type that is never a
  // document, at most 32 KB, and a source on pbs.twimg.com only.
  'mention_avatars_pkey',
  'mention_avatars_platform_check',
  'mention_avatars_handle_check',
  'mention_avatars_content_type_check',
  'mention_avatars_bytes_size_check',
  'mention_avatars_source_url_check',
  // Chart notes (migration 0050): 1–280 characters, already trimmed, and no
  // control character but the newline.
  'chart_notes_text_length_check',
  'chart_notes_text_trimmed_check',
  'chart_notes_text_control_check',
]

const declaredTables = schemaTableColumns()

describeIfPostgres('postgres schema bootstrap', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m2boot_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let scopedConnectionString: string
  let client: Client

  beforeAll(async () => {
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }

    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    scopedConnectionString = url.toString()

    const { logger } = createCapturedLogger()
    // The PRODUCT stream alone first: this is the standing proof that the
    // product history builds from empty without the cloud stream.
    const result = await migratePostgres({
      connectionString: scopedConnectionString,
      directory: PRODUCT_MIGRATIONS_DIR,
      logger,
    })
    expect(result.applied).toEqual(await expectedVersions())

    // Then the cloud stream on top, deploy order — the entitlement
    // repositories the it-blocks below exercise still read cloud columns.
    await migratePostgres({
      connectionString: scopedConnectionString,
      directory: CLOUD_MIGRATIONS_DIR,
      ledgerTable: 'cloud_schema_migrations',
      logger,
    })

    client = new Client({ connectionString: scopedConnectionString })
    await client.connect()
  })

  afterAll(async () => {
    await client?.end()
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  it('records every migration in the ledger', async () => {
    const ledger = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    )
    expect(ledger.rows.map((row) => row.version)).toEqual(await expectedVersions())
  })

  it('creates every table the Drizzle schema declares, with matching columns', async () => {
    expect(declaredTables.length).toBeGreaterThan(0)

    for (const table of declaredTables) {
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2`,
        [schemaName, table.name],
      )
      const present = new Set(columns.rows.map((row) => row.column_name))

      expect(present.size, `table ${table.name} is missing from the database`).toBeGreaterThan(0)
      for (const column of table.columns) {
        expect(present, `${table.name}.${column}`).toContain(column)
      }
    }
  })

  it('requires a reporting timezone on every site, defaulting to UTC', async () => {
    // ADR-0079 D5 / migration 0046. Not merely a column shape: it is the
    // statement that every window this product cuts — the dashboard's, the share
    // board's, every widget's — has a calendar to be cut on. Nullable, a site's
    // two readers see two different weeks and each calls the other's a bug.
    //
    // Pinned here as well as in `sites-reporting-timezone-required.test.ts`,
    // which proves the *backfill*: this is the one assertion that fails if a
    // later migration quietly relaxes the column again.
    const column = await client.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'sites' AND column_name = 'reporting_timezone'`,
      [schemaName],
    )
    expect(column.rows[0]?.is_nullable).toBe('NO')
    expect(column.rows[0]?.column_default).toContain('UTC')
  })

  it('carries the constraints the schema intends', async () => {
    const constraints = await client.query<{ conname: string }>(
      `SELECT c.conname FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = $1`,
      [schemaName],
    )
    const present = new Set(constraints.rows.map((row) => row.conname))
    for (const name of EXPECTED_CONSTRAINTS) {
      expect(present, name).toContain(name)
    }
  })

  it('refuses a malformed site slug and admits the deletion tombstone', async () => {
    // Migration 0035 (ADR-0019 known gap 5). Presence in EXPECTED_CONSTRAINTS
    // above only proves a constraint by that name exists; what matters is which
    // values it turns away and which it must not.
    // A site needs an owner, and migration 0006's ownership trigger is
    // DEFERRABLE INITIALLY DEFERRED — it would refuse a site with no owner
    // member at commit. So each attempt runs inside a transaction that is always
    // rolled back: the CHECK is immediate and fires on the INSERT itself, which
    // is the only thing under test here, while the deferred trigger never gets a
    // commit to fire on.
    const owner = randomUUID()
    await client.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'O', $2, true)`,
      [owner, `${owner}@example.com`],
    )

    const insert = async (slug: string): Promise<void> => {
      await client.query('BEGIN')
      try {
        await client.query(
          `INSERT INTO sites (id, slug, name, owner_user_id)
           VALUES (gen_random_uuid(), $1, 'S', $2)`,
          [slug, owner],
        )
      } finally {
        await client.query('ROLLBACK')
      }
    }

    // The shapes the domain pattern rejects, each for its own reason: an
    // uppercase letter, a leading and a trailing hyphen, an illegal character,
    // an empty string, and 64 characters against the 63-character bound.
    for (const bad of ['Acme', '-acme', 'acme-', 'ac me', 'acme_1', '', 'a'.repeat(64)]) {
      await expect(insert(bad), `slug ${JSON.stringify(bad)} must be refused`).rejects.toThrow(
        /sites_slug_format/,
      )
    }

    // ADR-0030 D4 rewrites a deleted site's slug to this form. A constraint
    // that refused it would fail site deletion at its final write, which is the
    // one way this migration could break something that works today.
    await expect(
      insert(`deleted-${randomUUID()}`),
      'the deletion tombstone must remain writable',
    ).resolves.toBeUndefined()

    // And the ordinary case still passes, so the pattern is not simply refusing
    // everything.
    await expect(insert('acme-analytics-1')).resolves.toBeUndefined()
  })

  it('refuses a widget configuration the public read could not serve', async () => {
    // Migration 0040 (ADR-0045). Presence in EXPECTED_CONSTRAINTS above only
    // proves a constraint by that name exists; what matters is which values it
    // turns away — and here that is not a formality, because every one of these
    // rows would be served to anonymous readers on a page that is not ours.
    const owner = randomUUID()
    const siteId = randomUUID()
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'W', $2, true)`,
      [owner, `${owner}@example.com`],
    )
    // Site and owning member in one transaction: migration 0006's ownership
    // trigger is DEFERRABLE INITIALLY DEFERRED and would refuse a site with no
    // owner at commit.
    await client.query(
      `INSERT INTO sites (id, slug, name, owner_user_id) VALUES ($1, $2, 'W', $3)`,
      [siteId, `widget-host-${owner.slice(0, 8)}`, owner],
    )
    await client.query(
      `INSERT INTO site_members (id, site_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'owner')`,
      [siteId, owner],
    )
    await client.query('COMMIT')

    /** Each attempt runs in its own rolled-back transaction, so an accepted row
     * does not linger and change the next one's meaning. */
    const insertWidget = async (values: {
      id?: string
      surface?: string
      range?: string | null
      rowLimit?: number | null
      title?: string | null
      origins?: string[]
    }): Promise<void> => {
      await client.query('BEGIN')
      try {
        await client.query(
          `INSERT INTO widgets (id, site_id, surface, range, row_limit, title, allowed_origins)
           VALUES ($1, $2, $3, $4, $5, $6, $7::text[])`,
          [
            values.id ?? 'w3f9xk21qm70c4bd',
            siteId,
            values.surface ?? 'pages',
            values.range === undefined ? '7d' : values.range,
            values.rowLimit === undefined ? 10 : values.rowLimit,
            values.title === undefined ? 'Most read' : values.title,
            values.origins ?? ['https://shop.example.com'],
          ],
        )
      } finally {
        await client.query('ROLLBACK')
      }
    }

    // The id is the widget's whole credential (ADR-0045, D1), so the shape of it
    // is the first thing the database refuses: a prefix that is not `w` and a
    // token too short to be 96 random bits.
    await expect(insertWidget({ id: 's3f9xk21qm70c4bd' })).rejects.toThrow(/widgets_id_format/)
    await expect(insertWidget({ id: 'wshort' })).rejects.toThrow(/widgets_id_format/)
    await expect(insertWidget({ id: 'w3F9XK21QM70C4BD' })).rejects.toThrow(/widgets_id_format/)

    // A surface with no route to serve it.
    await expect(insertWidget({ surface: 'revenue', rowLimit: null })).rejects.toThrow(
      /widgets_surface_check/,
    )

    // The range rule, both directions: realtime has no window, and every other
    // surface must name one from the dashboard's nine keys.
    await expect(
      insertWidget({ surface: 'realtime', range: '7d', rowLimit: null }),
    ).rejects.toThrow(/widgets_range_check/)
    await expect(
      insertWidget({ surface: 'overview', range: null, rowLimit: null }),
    ).rejects.toThrow(/widgets_range_check/)
    await expect(
      insertWidget({ surface: 'overview', range: '14d', rowLimit: null }),
    ).rejects.toThrow(/widgets_range_check/)

    // A row cap on a surface with no rows is a setting nothing reads, and the
    // 1..50 bound is the one the read enforces.
    await expect(insertWidget({ surface: 'overview', rowLimit: 5 })).rejects.toThrow(
      /widgets_row_limit_check/,
    )
    await expect(insertWidget({ rowLimit: 0 })).rejects.toThrow(/widgets_row_limit_check/)
    await expect(insertWidget({ rowLimit: 51 })).rejects.toThrow(/widgets_row_limit_check/)

    await expect(insertWidget({ title: 'x'.repeat(81) })).rejects.toThrow(
      /widgets_title_length_check/,
    )
    await expect(
      insertWidget({ origins: Array.from({ length: 21 }, (_, i) => `https://a${i}.test`) }),
    ).rejects.toThrow(/widgets_allowed_origins_check/)

    // And the configurations that must remain writable, so the constraints are
    // not simply refusing everything.
    await expect(insertWidget({})).resolves.toBeUndefined()
    await expect(
      insertWidget({ surface: 'realtime', range: null, rowLimit: null, title: null }),
      'a realtime widget has neither a range nor a limit',
    ).resolves.toBeUndefined()
    await expect(
      insertWidget({ surface: 'pages', rowLimit: null }),
      'a breakdown widget may carry no stored limit; the API supplies the default',
    ).resolves.toBeUndefined()
    await expect(
      insertWidget({ title: '' }),
      'the contract gives `title` no minLength, so the database must not invent one',
    ).resolves.toBeUndefined()
    await expect(
      insertWidget({ origins: [] }),
      'an empty allowlist is "nowhere yet" and is a legal, deliberate state',
    ).resolves.toBeUndefined()
  })

  it('enforces public-slug uniqueness with a partial unique index', async () => {
    // The M7 share-slug guarantee lives in a standalone partial CREATE UNIQUE
    // INDEX (a table UNIQUE constraint cannot carry a WHERE clause), so it is
    // asserted in pg_indexes, not pg_constraint — the catalog it actually
    // populates.
    const indexes = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = $1 AND indexname = 'site_public_dashboard_slug_key'`,
      [schemaName],
    )
    const definition = indexes.rows[0]?.indexdef
    expect(definition, 'site_public_dashboard_slug_key must exist').toBeDefined()
    expect(definition).toContain('UNIQUE')
    expect(definition).toContain('WHERE (share_slug IS NOT NULL)')
  })

  it('enforces one live job per (type, subject) with a partial unique index', async () => {
    // The structural half of job idempotency (ADR-0030 D3). Like the share slug,
    // it is a partial CREATE UNIQUE INDEX rather than a table constraint, so it
    // lives in pg_indexes and not in the constraint assertion above.
    const indexes = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = $1 AND indexname = 'jobs_live_subject_key'`,
      [schemaName],
    )
    const definition = indexes.rows[0]?.indexdef
    expect(definition, 'jobs_live_subject_key must exist').toBeDefined()
    expect(definition).toContain('UNIQUE')
    expect(definition).toContain('type')
    expect(definition).toContain('subject_id')
    // The terminal statuses are excluded on purpose: history must not block a
    // later job for the same subject.
    expect(definition).toContain("'queued'")
    expect(definition).toContain("'running'")
    expect(definition).toContain("'failed_retryable'")
    expect(definition).not.toContain("'succeeded'")
  })

  it('enforces one live revenue credential per (site, provider)', async () => {
    // The partial unique is what makes disconnect keep its row: a plain UNIQUE
    // would force a reconnect to resurrect the disabled row, and its
    // `connected_at` would then predate the disconnection it went through.
    // Partial indexes live in pg_indexes rather than pg_constraint, so this is
    // asserted separately from the constraint list above.
    const indexes = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = $1 AND indexname = 'revenue_credentials_live_key'`,
      [schemaName],
    )
    const definition = indexes.rows[0]?.indexdef
    expect(definition, 'revenue_credentials_live_key must exist').toBeDefined()
    expect(definition).toContain('UNIQUE')
    expect(definition).toContain('site_id')
    expect(definition).toContain('provider')
    // Disabled rows are outside the predicate on purpose — history must not
    // block a later connection to the same provider.
    expect(definition).toContain("'disabled'")
  })

  it('bounds match hints to one row per checkout session per site', async () => {
    // What stops a provider retry storm from becoming unbounded rows. Created as
    // a unique INDEX, so it lives in pg_indexes rather than pg_constraint and is
    // asserted here rather than in the constraint list above.
    const indexes = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = $1 AND indexname = 'revenue_match_hints_session_key'`,
      [schemaName],
    )
    const definition = indexes.rows[0]?.indexdef
    expect(definition, 'revenue_match_hints_session_key must exist').toBeDefined()
    expect(definition).toContain('UNIQUE')
    expect(definition).toContain('site_id')
    expect(definition).toContain('checkout_session_id')
  })

  it('indexes only the heads the projection still owes', async () => {
    // Partial on `projected_version < version`, so on a steady-state
    // installation the loop's discovery scan reads an empty index rather than
    // the whole table.
    const indexes = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = $1 AND indexname = 'revenue_objects_unprojected_idx'`,
      [schemaName],
    )
    const definition = indexes.rows[0]?.indexdef
    expect(definition, 'revenue_objects_unprojected_idx must exist').toBeDefined()
    expect(definition).toContain('projected_version < version')
  })

  it('is idempotent on a second run', async () => {
    const { logger } = createCapturedLogger()
    const again = await applyPostgresStreams({
      connectionString: scopedConnectionString,
      logger,
    })
    expect(again.product.applied).toEqual([])
    // Undefined in a checkout with no cloud stream (the public export); a
    // present stream must be as idempotent as the product one.
    expect(again.cloud?.applied ?? []).toEqual([])
  })
})
