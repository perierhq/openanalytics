import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { policySchema } from './policy.ts'

/**
 * Typed environment validation with a per-service secret boundary.
 *
 * Docs snapshot 02 §5 and 04 Milestone 0 item 5: each service validates its own
 * environment at startup and is *not* given secrets it has no business holding.
 *
 * Two directions are enforced, and the second one is the point:
 *
 * 1. Required variables must be present and well-formed, or the process exits.
 *    Legacy relied on scattered non-null assertions and fallbacks (docs snapshot
 *    01 §15), which turns a misconfiguration into a runtime 500 much later.
 * 2. A variable a service must never hold is a hard startup failure, not a
 *    silently ignored value. If the collector is handed a ClickHouse credential,
 *    that is a deployment mistake worth failing on — the whole network design
 *    depends on the collector not being able to reach ClickHouse.
 */

export const SERVICE_ENV_NAMES = [
  'api',
  'collector',
  'worker',
  'query-gateway',
  'realtime',
] as const

export type ServiceEnvName = (typeof SERVICE_ENV_NAMES)[number]

const url = z.string().url()
const secret = z.string().min(16, 'secret must be at least 16 characters')

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ENVIRONMENT: z.string().min(1).default('local'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SERVICE_VERSION: z.string().min(1).default('0.0.0'),
  GIT_COMMIT: z.string().min(1).default('unknown'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

  // The G-006 metrics sink. Named for the protocol rather than the vendor:
  // remote-write is a Prometheus wire format, and G-006's choice of Grafana
  // Cloud is a URL, not a coupling. Optional everywhere — a service without
  // them keeps the structured-log metrics floor.
  METRICS_REMOTE_WRITE_URL: url.optional(),
  METRICS_REMOTE_WRITE_USER: z.string().min(1).optional(),
  METRICS_REMOTE_WRITE_TOKEN: z.string().min(8).optional(),
  METRICS_FLUSH_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(300).default(15),
})

/**
 * Per-service schemas.
 *
 * Milestone 0 keeps every credential optional so the skeleton starts on a clean
 * machine with no infrastructure. Each milestone that starts using a dependency
 * promotes its variables to required in the same PR that adds the code path.
 */
const serviceSchemas = {
  api: baseSchema.extend({
    DATABASE_URL: url.optional(),
    AUTH_SECRET: secret.optional(),
    /**
     * The source fingerprint for G-010's credential events (ADR-0051, D4).
     *
     * A **new** secret on the `TRIAL_IDENTITY_SECRET` precedent, never derived
     * from `AUTH_SECRET`: it keys a hash of the addresses customers' keys and
     * CLIs connect from, and rotating one of those things must not rotate the
     * other. Held only by the api, which is the one service that authenticates a
     * read credential; the four FORBIDDEN lists below (collector, worker,
     * query-gateway, realtime) keep it there.
     *
     * Optional-until-used, and the degradation is total and stated: without it
     * the source fingerprint cannot be computed, so **no credential event is
     * journalled at all** — first use is decided by the same statement that
     * detects a new source (D5). Reads are untouched, and the api warns once at
     * startup rather than refusing to boot over one signal.
     *
     * The key version travels on every stored row so a rotation re-baselines
     * rather than corrupting: hashes are compared only within one version, so
     * the first use after a rotation looks new for every credential, once.
     */
    CREDENTIAL_SOURCE_SECRET: secret.optional(),
    CREDENTIAL_SOURCE_KEY_VERSION: z.coerce.number().int().min(1).default(1),
    // The signing half of D-208. The API mints a short-lived Ed25519 service
    // signature per analytics read and posts it to the query gateway; the gateway
    // holds only the public verify key (QUERY_SIGNING_PRIVATE_KEY is on the
    // gateway's FORBIDDEN_KEYS list). The analytics read surface mounts only when
    // the URL and private key are both present (the optional-until-used rule).
    QUERY_GATEWAY_URL: url.optional(),
    QUERY_SIGNING_PRIVATE_KEY: secret.optional(),
    // The key ID the signature advertises and the audience it names. The audience
    // defaults to `query-gateway:<ENVIRONMENT>`, matching the gateway's own
    // default, so a staging-minted signature cannot be replayed at production.
    QUERY_SIGNING_KEY_ID: z.string().min(1).optional(),
    QUERY_GATEWAY_AUDIENCE: z.string().min(1).optional(),
    // Signature validity the API requests. D-208 requires a short-lived
    // credential; the gateway clamps this to SIGNATURE_LIFETIME_CEILING_MS
    // regardless of what is set here.
    QUERY_SIGNATURE_LIFETIME_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
    // Deadline the API applies to the whole gateway round-trip. Sits above the
    // gateway's own QUERY_TIMEOUT_MS so the gateway's typed timeout normally
    // surfaces first and the API's is the backstop against a hung socket.
    QUERY_GATEWAY_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(20_000),
    /**
     * The sites-grid card figures (ADR-0080). Three numbers, all with working
     * defaults, so a deployment that sets none still gets the feature.
     *
     * `SITES_CARD_GATEWAY_TIMEOUT_MS` is deliberately far below
     * `QUERY_GATEWAY_TIMEOUT_MS` above: `GET /v1/sites` is the dashboard shell's
     * own load and these figures decorate it, so the shell must never wait on
     * them the way a chart the viewer asked for is allowed to (D6). Past the
     * deadline the list still answers — with `null` figures, which the contract
     * defines as "not computed" rather than zero.
     *
     * `SITES_CARD_CACHE_TTL_MS` is the per-account cache (D5); `0` disables it.
     * `SITES_CARD_MAX_SITES` is the fan-out ceiling: an account with more sites
     * than this gets figures for the first N and `null` for the rest, which is
     * an interpretable partial answer rather than a refused list. Prod's largest
     * account held 4 sites when this shipped.
     */
    SITES_CARD_CACHE_TTL_MS: z.coerce.number().int().min(0).max(3_600_000).default(300_000),
    SITES_CARD_GATEWAY_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3_000),
    SITES_CARD_MAX_SITES: z.coerce.number().int().min(1).max(100).default(100),
    REALTIME_TOKEN_SIGNING_KEY: secret.optional(),
    REALTIME_CACHE_REDIS_URL: url.optional(),
    // Social login runs in the API (Better Auth). Providers are env-gated: a
    // provider is only offered when both its id and secret are present, so a
    // build with no OAuth app configured simply has no Google/GitHub button
    // (plan Milestone 2 item 2). Creating the OAuth apps is an operator step.
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: secret.optional(),
    GITHUB_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_CLIENT_SECRET: secret.optional(),
    // Display brand and auth surface config (docs snapshot 05, D-005: brand comes
    // from typed config, never scattered string literals). AUTH_TRUSTED_ORIGINS
    // is a comma-separated allowlist for the cookie CORS/CSRF boundary.
    PRODUCT_NAME: z.string().min(1).default('Open Analytics'),
    AUTH_BASE_URL: url.optional(),
    AUTH_TRUSTED_ORIGINS: z.string().optional(),
    // SameSite override for every Better Auth cookie. Omitted, the cookies stay
    // `Lax` (`packages/auth/src/better-auth.ts`), which is the production
    // posture: a Lax cookie never rides a cross-site request, so a page outside
    // `getopen.so` cannot exercise a session — that is a CSRF boundary, not a
    // preference. Setting `none` dissolves that boundary to let a cross-site
    // origin (a dev machine's `http://localhost:3000`) hold a session against a
    // deployed api. It exists for exactly that pre-launch testing window, is
    // set only in the host-side `api.env`, and the restore step — delete the
    // variable, restart — is recorded in `docs/dev/localhost-live-testing.md`.
    // Not a secret, so not a FORBIDDEN_KEYS entry (see APP_BASE_URL above).
    AUTH_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).optional(),
    // Whether the email+password endpoints are mounted. The front door is OAuth
    // and magic link; password is a test-harness affordance, so production —
    // which does not set this — mounts no password routes (ADR-0059). Not a
    // secret, same reasoning as AUTH_COOKIE_SAMESITE.
    AUTH_PASSWORD_SIGNIN: z.enum(['enabled', 'disabled']).default('disabled'),
    /**
     * Whether a password session requires a verified address first.
     *
     * `required` is the default, so this deployment is unchanged: an unverified
     * password sign-in is refused exactly as it was when the flag was a
     * hard-coded `true` in `packages/auth`.
     *
     * It is a variable at all because of one self-hosted case: the operator that
     * `pnpm run create-admin` bootstraps has no mail transport yet — configuring
     * one is usually the first thing they log in to do. `create-admin` writes
     * `email_verified = true` for exactly that reason, so the common path does
     * not need this. `optional` is the escape hatch for an install whose mail is
     * still broken, and it is stated in the example env as such rather than
     * being a thing an operator has to discover by reading the auth package.
     *
     * Not a secret, so nothing on FORBIDDEN_KEYS — the same reasoning as
     * AUTH_PASSWORD_SIGNIN above.
     */
    AUTH_EMAIL_VERIFICATION: z.enum(['required', 'optional']).default('required'),
    /**
     * Whether the operator may configure this deployment from the dashboard
     * (migration 0043).
     *
     * The self-host dry run found that everything a new install needs from a
     * third party — a mail relay, a model provider — is reachable only by
     * editing a file on the host and restarting a container, which is a wall in
     * front of the first thing anybody does after signing in. `enabled` mounts a
     * screen that writes those settings to `deployment_settings` instead, with
     * the secret encrypted under `OA_CREDENTIAL_KEYRING`; the worker and the
     * assistant prefer a stored value over the environment.
     *
     * **A multi-tenant deployment sets `disabled`.** There, the environment is
     * the configuration — it is deployed, reviewed and rotated as such — and the
     * screen would let one customer's account change how every other customer's
     * mail is sent. The default is `enabled` because the audience for a default
     * is the self-hoster: a fresh install is the case this exists for, and a
     * hosted fleet is configured deliberately anyway.
     *
     * Not a secret, so nothing on FORBIDDEN_KEYS — the same reasoning as
     * AUTH_PASSWORD_SIGNIN above. The worker reads the same variable (its schema
     * below): the api writes the row and the worker delivers with it, so both
     * halves have to agree about whether the table is in play.
     */
    DEPLOYMENT_SETTINGS: z.enum(['enabled', 'disabled']).default('enabled'),
    // The FRONTEND's public origin, e.g. `https://app.getopen.so`. Distinct from
    // AUTH_BASE_URL, which is Better Auth's own base and in production is the
    // *api* host: every link meant for a human — the invitation acceptance page,
    // the Stripe return URLs — belongs on the frontend, and building them from
    // AUTH_BASE_URL sent people to a page the api does not serve. Optional so a
    // deployment that has not set it keeps the previous behaviour (AUTH_BASE_URL,
    // then the localhost default). It is a public URL, not a credential, so it
    // adds nothing to FORBIDDEN_KEYS below — that table names the secrets and
    // store connection strings a service must not be able to reach with.
    APP_BASE_URL: url.optional(),
    /**
     * Where an embedded widget's footer watermark points (ADR-0045, CP3).
     *
     * A hardcoded marketing URL inside `http/embed.ts` until the open-core
     * split, and the one place an embedded document named the deployment serving
     * it. Optional with no default and no derivation: the mark names a *product*,
     * and the api's own origin is not that page. Unset, the footer renders the
     * same line as plain text with no link at all, which is the only honest
     * answer for an install that has no such page.
     *
     * Public configuration rather than a credential, so it adds nothing to
     * FORBIDDEN_KEYS — the same reasoning as APP_BASE_URL above.
     */
    WIDGET_WATERMARK_URL: url.optional(),
    /**
     * The COLLECTOR's public origin, e.g. `https://c.getopen.so` (ADR-0042 D8).
     *
     * The api needs it for one thing: `GET /v1/read/site` hands an unattended
     * integration the install block — the tracking key, the `oa.js` URL and the
     * `data-collector` base — so a WordPress plugin can inject the tracker
     * without an administrator copying a snippet out of the dashboard. Both URLs
     * are derived from this one value, exactly as the dashboard's own snippet
     * builder derives them (`apps/web/lib/api.ts`).
     *
     * Optional, and its absence is reported rather than guessed: the two URL
     * members of the install block come back `null`, and the caller falls back to
     * its own configured host. A hardcoded `c.getopen.so` would have been the
     * alternative, and it is wrong for every self-hosted deployment.
     *
     * A public URL, not a credential — nothing for FORBIDDEN_KEYS, same as
     * APP_BASE_URL above.
     */
    COLLECTOR_BASE_URL: url.optional(),
    /**
     * Object storage (ADR-0032, D1 — the api mints signed URLs; the worker moves
     * the bytes). All five, because a signature needs the endpoint, the region,
     * the bucket and the key pair — a partial block cannot sign anything, so
     * there is no useful subset to hold.
     *
     * Optional-until-used like every other credential here: absent them the
     * import surface is simply not mounted (`app.ts`), rather than the api
     * refusing to boot over a feature a deployment has not enabled.
     */
    OBJECT_STORAGE_ENDPOINT: url.optional(),
    OBJECT_STORAGE_REGION: z.string().min(1).optional(),
    OBJECT_STORAGE_BUCKET: z.string().min(1).optional(),
    OBJECT_STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
    OBJECT_STORAGE_SECRET_ACCESS_KEY: secret.optional(),
    /**
     * The versioned credential keyring (ADR-0033, D3):
     * `{"active":"k1","keys":{"k1":"<base64 32 bytes>"}}`.
     *
     * A **new** secret, never derived from `AUTH_SECRET` or any other key
     * (snapshot 02 §25) — it protects customer-owned provider credentials, and a
     * derivation would make rotating one of them rotate the other. Held by the
     * api (which encrypts on connect) and the worker (which decrypts to sync)
     * and by nobody else; the three services on the FORBIDDEN lists below can
     * never be handed it by a deployment mistake.
     *
     * Optional-until-used like every other credential here, and fail-closed with
     * it: without a parsable keyring the revenue connection routes are simply
     * not mounted (the billing precedent — no secret, no surface, one warn log),
     * rather than mounted and answering failures. The provider catalog still
     * mounts, being a static list that touches neither the keyring nor a
     * provider.
     */
    OA_CREDENTIAL_KEYRING: secret.optional(),
    /**
     * The assistant's provider (ADR-0046, D6). The api is the only service that
     * talks to a model, and this is the first third-party credential we hold
     * whose leak is a **bill** rather than a data exposure — every previous one
     * either moved money under our control (Stripe) or was held by the worker
     * instead (Resend). `FORBIDDEN_KEYS` below narrows who can hold it; nothing
     * bounds what it costs if it leaks, and the launch review knows that.
     *
     * `min(1)` rather than `secret`: the key's length is the provider's to
     * decide, exactly as `STRIPE_SECRET_KEY`'s is.
     *
     * Optional-until-used like every other credential here. Unset, the
     * assistant routes still mount and report that the provider is not
     * configured (D2) rather than the api refusing to boot over one feature.
     *
     * `ASSISTANT_MODEL` and `OPENAI_BASE_URL` are declared beside it because
     * they are api-only configuration, and deliberately **without defaults**:
     * the defaults and the six bounds in D7 live in
     * `packages/domain/src/assistant.ts`, on the `read-cost.ts` precedent, so
     * there is exactly one home for each number.
     */
    OPENAI_API_KEY: z.string().min(1).optional(),
    ASSISTANT_MODEL: z.string().min(1).optional(),
    OPENAI_BASE_URL: url.optional(),
  }),

  collector: baseSchema.extend({
    // Site ingest config lookup. Read-only, and cached with a short versioned TTL.
    DATABASE_URL: url.optional(),
    // Durable queue (docs snapshot 05, D-205/D-206). The collector runs on
    // Vercel, which cannot route into the provider's private network, so it
    // reaches the self-hosted queue Valkey over a public endpoint — `rediss://`
    // with AUTH, enforced by `buildConnectionOptions` and proven against the
    // deployed instance in ADR-0004. This replaced a REST URL/token pair that
    // predated D-205 closing on self-hosted Valkey rather than a REST provider.
    EVENT_STREAM_REDIS_URL: url.optional(),
    // Realtime presence, rate-limit counters and the D-103 near-realtime usage
    // counter. A separate instance from the queue: everything here is losable,
    // and D-205 keeps the two behind different eviction policies for that
    // reason.
    REALTIME_CACHE_REDIS_URL: url.optional(),
    // The D-102 anonymous-identity HMAC. Held only here: the collector is the
    // one service that ever sees a raw IP, and the derivation happens before the
    // address is discarded, so no other service has a reason to hold the key
    // that would let it re-derive one. The version travels with each identity so
    // a rotation can still recognise the previous day's material.
    ANONYMOUS_IDENTITY_SECRET: secret.optional(),
    ANONYMOUS_IDENTITY_KEY_VERSION: z.coerce.number().int().min(1).default(1),
    /**
     * Path to a local City-schema `.mmdb` file (GeoLite2 or DB-IP). On our own
     * host no platform injects geo headers, so this is the only geo source
     * (ADR-0015 addendum). Unset means every event carries null geo — a
     * degradation, never a failure. The file is a licensed deploy artifact,
     * refreshed monthly on the host and never committed.
     */
    GEOIP_DB_PATH: z.string().min(1).optional(),
  }),

  worker: baseSchema.extend({
    DATABASE_URL: url.optional(),
    // The worker's half of the dashboard-configurable settings (migration 0043;
    // the api's schema above carries the full argument). `enabled` makes the
    // email drain prefer the stored transport over `SMTP_*`/`RESEND_API_KEY`;
    // `disabled` makes it read the environment and nothing else.
    //
    // **Both services must agree, and nothing here reconciles them** — they are
    // two variables in two containers, sharing only a default. The asymmetry is
    // worth stating because only one direction is obvious: api enabled with the
    // worker disabled writes a relay that is never delivered through, which
    // fails visibly at the test send. The other direction is quiet — api
    // disabled with the worker enabled removes the *screen* while leaving the
    // *row*, and the worker goes on preferring it over the environment, because
    // turning the feature off has never been the same act as clearing what it
    // stored. SELF-HOSTING.md says to clear the settings before disabling.
    DEPLOYMENT_SETTINGS: z.enum(['enabled', 'disabled']).default('enabled'),
    // Native Redis/TLS consumer group; REST cannot do a blocking XREADGROUP.
    EVENT_STREAM_REDIS_URL: url.optional(),
    // The D-103 near-realtime usage counter, which the worker reconciles against
    // the authoritative Postgres ledger (ADR-0009). Optional: the counter is
    // reconstructible state on the losable instance (D-205), and its absence
    // degrades the reconciliation rather than stopping ingest.
    REALTIME_CACHE_REDIS_URL: url.optional(),
    CLICKHOUSE_URL: url.optional(),
    // Same default as the query gateway's, so the two halves of the analytics
    // schema cannot be pointed at different databases by omission.
    CLICKHOUSE_DB: z.string().min(1).default('analytics'),
    CLICKHOUSE_INGEST_USER: z.string().min(1).optional(),
    CLICKHOUSE_INGEST_PASSWORD: secret.optional(),
    // The `oa_maintenance` credential (ADR-0030, decision 4): `ALTER DELETE` +
    // `SELECT` on `analytics.*` and `SELECT` on `system.mutations`, and nothing
    // else. It is a *separate* user from `oa_ingest` on purpose — insert-only
    // must stay insert-only, and the alternative considered and rejected was
    // handing the worker the migration credential, which can also DROP tables
    // from inside a long-running service.
    //
    // Optional, like every other ClickHouse variable here: the worker must boot
    // on a host where the credential has not been provisioned yet (the CH
    // container recreate is a separate deploy step). The deletion executor's
    // `clickhouse_purge` phase returns a retry and logs when it is absent, so a
    // queued deletion waits rather than the whole worker refusing to start.
    CLICKHOUSE_MAINTENANCE_USER: z.string().min(1).optional(),
    CLICKHOUSE_MAINTENANCE_PASSWORD: secret.optional(),
    // Object storage (ADR-0032, D1). The bucket and region joined the endpoint
    // and key pair in M11: the adapter needs all five to address anything, and
    // the import/export executors treat an incomplete block as "not configured"
    // and wait rather than starting work they cannot finish.
    OBJECT_STORAGE_ENDPOINT: url.optional(),
    OBJECT_STORAGE_REGION: z.string().min(1).optional(),
    OBJECT_STORAGE_BUCKET: z.string().min(1).optional(),
    OBJECT_STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
    OBJECT_STORAGE_SECRET_ACCESS_KEY: secret.optional(),
    // Email delivery is a worker job: Better Auth in the API only writes the
    // send to the outbox, and the worker delivers it (docs snapshot 02 §5,
    // G-007). The API never holds this key — see FORBIDDEN_KEYS below.
    RESEND_API_KEY: secret.optional(),
    // Allows the "Name <addr@domain>" form Resend accepts, so not `.email()`.
    EMAIL_FROM: z.string().min(3).optional(),
    /**
     * The self-hostable email transport.
     *
     * Resend is our deployment's provider and cannot be a self-hosted one — it
     * needs an account, a verified domain and a key. Without SMTP the only door
     * into a fresh install, the magic link, has nowhere to be delivered, so
     * nobody can sign in at all. The block is additive and changes nothing here:
     * our worker sets `RESEND_API_KEY` and no `SMTP_HOST`, and Resend wins the
     * tie regardless (`selectEmailTransport`).
     *
     * `SMTP_HOST` alone activates it; the rest have defensible defaults —
     * port 587, TLS negotiated with STARTTLS, no credential, and the
     * deployment's `EMAIL_FROM` as the sender.
     */
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    /**
     * Implicit TLS from the first byte — set it for port 465, leave it for 587,
     * where nodemailer still upgrades through STARTTLS.
     *
     * An enum of the two literals rather than `z.coerce.boolean()`, which is a
     * trap: `Boolean('false')` is `true`, so the one spelling an operator is
     * most likely to reach for would turn the setting on. Transformed here so
     * the rest of the code sees a boolean and nothing re-parses the string.
     */
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    SMTP_USER: z.string().min(1).optional(),
    // Not `secret`: a relay's password length is the relay's to decide, exactly
    // as STRIPE_SECRET_KEY's is. Both halves or neither — the transport
    // authenticates only when it has a complete credential.
    SMTP_PASS: z.string().min(1).optional(),
    // Overrides EMAIL_FROM for SMTP only. Relays routinely refuse a `From` that
    // is not the authenticated mailbox, and that address belongs to the relay
    // rather than to the product's branding, which is what EMAIL_FROM is.
    SMTP_FROM: z.string().min(3).optional(),
    /**
     * The versioned credential keyring (ADR-0033, D3). The worker's half of the
     * pair: the api encrypts a customer's provider secret on connect and this
     * service decrypts it to run the sync and to verify webhook signatures.
     *
     * Optional like every other credential here, and fail-closed with it — the
     * revenue sync loop does not start without a parsable ring, so a worker on a
     * host where the secret has not been provisioned yet boots and runs
     * everything else.
     */
    OA_CREDENTIAL_KEYRING: secret.optional(),
    /**
     * The D-102 identity HMAC — **read-only, for revenue hashing** (ADR-0033,
     * D6 amendment, M12 CP3).
     *
     * This was on the worker's FORBIDDEN list from M4 until CP3, and lifting it
     * is a deliberate narrowing rather than an abandonment — the same shape
     * `STRIPE_SECRET_KEY` took in M10, and worth stating precisely.
     *
     * **What the rule protects.** The key can re-derive an anonymous id from a
     * raw IP, so it belongs only where raw IPs are, and the collector is the one
     * service that ever sees one (D-102). That property is untouched: the worker
     * has never seen an IP, has no column that holds one, and `events_raw` has
     * no IP column for it to join against — `tests/migration/clickhouse-analytics`
     * asserts the schema has none. Holding the key here buys nobody the ability
     * to re-derive anything, because the other half of the derivation does not
     * exist on this side of the network.
     *
     * **Why it is needed.** D5's fact carries `external_user_hash`, which must be
     * the `identify()` derivation *byte for byte* or it joins against
     * `events_raw.user_id` and matches nothing. That derivation has to run over
     * provider-side identifiers (a Checkout `client_reference_id`), which only
     * the worker ever holds — the api receives them on the webhook and stores
     * them raw precisely because it must not gain this key, and the collector
     * never sees a provider payload at all.
     *
     * **What stays true.** The collector remains the only *writer* of event
     * identity. The worker uses the key read-only, to hash values that arrived
     * from a payment provider, and writes the result into revenue facts. Nothing
     * here can mint or alter an `events_raw` row.
     *
     * Optional like every other credential in this schema: the projection loop
     * does not start without it and logs one warning, rather than the worker
     * refusing to boot over a feature a deployment has not enabled.
     */
    ANONYMOUS_IDENTITY_SECRET: secret.optional(),
    ANONYMOUS_IDENTITY_KEY_VERSION: z.coerce.number().int().min(1).default(1),
    // The display brand, same default and same reason as the api's (D-005: brand
    // comes from typed config, never a scattered literal). The worker needs it
    // because M10 gave it a mail it composes itself — the G-005 rapid-burn notice
    // is rendered where the usage totals are, not in the api (ADR-0030, D1).
    PRODUCT_NAME: z.string().min(1).default('Open Analytics'),
    /**
     * The X search service the mentions poller calls (migration 0048). An
     * fxtwitter-compatible `/2/search` endpoint; point it at a self-hosted
     * fxtwitter to keep the searches off the public instance. What is sent is
     * each opted-in site's domain and search terms, never anything about a
     * visitor.
     */
    MENTIONS_X_API_URL: z.string().url().default('https://api.fxtwitter.com'),
    /**
     * The operator's kill switch for the mentions poller. Sites still opt in
     * one by one; `false` stops the loop for every site on this install. The
     * two-literal enum for the reason SMTP_SECURE gives: `Boolean('false')` is
     * `true`.
     */
    MENTIONS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
  }),

  'query-gateway': baseSchema.extend({
    // Shared nonce store. Replay defence is per-process without it, which is
    // wrong for any deployment running more than one gateway instance.
    REALTIME_CACHE_REDIS_URL: url.optional(),
    // Verify-only half of the D-208 signed service auth. The private half is on
    // this service's FORBIDDEN_KEYS list below.
    QUERY_SIGNING_PUBLIC_KEY: z.string().min(16).optional(),
    // Pins which key ID may sign. Rotation publishes the successor's ID here
    // after the caller has switched (D-208: the credential is rotatable).
    QUERY_SIGNING_KEY_ID: z.string().min(1).optional(),
    // Audience the signature must name. Defaults to `query-gateway:<ENVIRONMENT>`
    // so a staging-minted signature cannot be replayed at production.
    QUERY_GATEWAY_AUDIENCE: z.string().min(1).optional(),
    // Signature validity ceiling. D-208 requires a short-lived credential; the
    // verifier clamps this to SIGNATURE_LIFETIME_CEILING_MS regardless.
    QUERY_SIGNATURE_MAX_LIFETIME_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(60_000),

    // Docs snapshot 04, Milestone 1 item 2 — request-size, timeout and
    // concurrency limits. Rate limiting is intentionally absent: its values are
    // open gate G-005 in docs snapshot 05, and a gate value must not appear as
    // an invented default. QUERY_RATE_LIMIT_PER_MINUTE stays unset until an ADR
    // closes it.
    QUERY_MAX_BODY_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(65_536),
    // Below the 30s `max_execution_time` on the oa_read profile
    // (infra/fly/clickhouse), so the gateway gives up before ClickHouse does and
    // the caller gets a typed timeout rather than a connection reset.
    QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(29_000).default(15_000),
    QUERY_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(1_024).default(16),
    QUERY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).optional(),

    // ClickHouse-side cost guards applied to every rollup read (plan Milestone 7
    // item 4). Engineering values, not gate items. max_execution_time sits below
    // the oa_read profile's 30s cap and above the gateway's own 15s timeout, so
    // the gateway's clean typed timeout normally fires first and this is the
    // backstop. max_result_rows is far under the profile's 1,000,000 cap and
    // comfortably above the largest operation's maxRows.
    QUERY_CH_MAX_EXECUTION_SECONDS: z.coerce.number().int().min(1).max(30).default(20),
    QUERY_CH_MAX_RESULT_ROWS: z.coerce.number().int().min(1).max(1_000_000).default(200_000),

    // Bounded query-result cache (plan Milestone 7 item 7). Short TTL because
    // "today" buckets are still filling; a longer TTL for finalized ranges is a
    // Checkpoint C refinement once responses carry a finalized watermark.
    QUERY_CACHE_TTL_MS: z.coerce.number().int().min(0).max(300_000).default(30_000),
    QUERY_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(100_000).default(500),
    // The long TTL band for a read the API has proven is over a finalized session
    // range (Milestone 8, docs snapshot 02 §15): its answer no longer changes, so
    // it may be cached far longer than a still-filling recent bucket. This is the
    // ADR-0011 refinement, unblocked now that session responses carry a finalized
    // watermark. The bounded LRU still evicts, so a generous ceiling is safe.
    QUERY_CACHE_FINALIZED_TTL_MS: z.coerce.number().int().min(0).max(86_400_000).default(3_600_000),

    CLICKHOUSE_URL: url.optional(),
    CLICKHOUSE_DB: z.string().min(1).default('analytics'),
    CLICKHOUSE_READ_USER: z.string().min(1).optional(),
    CLICKHOUSE_READ_PASSWORD: secret.optional(),
  }),

  realtime: baseSchema.extend({
    REALTIME_CACHE_REDIS_URL: url.optional(),
    REALTIME_TOKEN_VERIFY_KEY: z.string().min(16).optional(),
  }),
} as const

/**
 * Variables each service must never be given.
 *
 * These are the boundaries the architecture actually rests on, so a violation is
 * a deployment bug worth refusing to start for — not a warning.
 */
const FORBIDDEN_KEYS: Readonly<Record<ServiceEnvName, readonly string[]>> = {
  api: [
    // Docs snapshot 05, D-208: the API reaches analytics only through the signed
    // gateway. A direct ClickHouse credential here would quietly re-enable the
    // exact topology the design forbids.
    'CLICKHOUSE_URL',
    'CLICKHOUSE_INGEST_PASSWORD',
    'CLICKHOUSE_READ_PASSWORD',
    'CLICKHOUSE_MIGRATION_PASSWORD',
    // The `oa_maintenance` credential can ALTER DELETE every analytics table
    // (ADR-0030, D4). The api starts deletion by writing Postgres rows; the
    // worker is the only process that may execute one.
    'CLICKHOUSE_MAINTENANCE_PASSWORD',
    'EVENT_STREAM_REDIS_URL',
    // The API enqueues verification/invite email to the outbox; the worker
    // delivers it. The API therefore never holds the email provider credential
    // (docs snapshot 02 §5).
    'RESEND_API_KEY',
    // The SMTP relay password is the self-hosted spelling of the same
    // credential, and lands on the same side of the same boundary: the worker
    // delivers mail, so the worker is the only service that may hold it.
    'SMTP_PASS',
    // The D-102 anonymous-identity HMAC lives only on the collector (§6).
    'ANONYMOUS_IDENTITY_SECRET',
  ],
  collector: [
    'CLICKHOUSE_URL',
    'CLICKHOUSE_INGEST_PASSWORD',
    'CLICKHOUSE_READ_PASSWORD',
    'CLICKHOUSE_MIGRATION_PASSWORD',
    'CLICKHOUSE_MAINTENANCE_PASSWORD',
    'AUTH_SECRET',
    'QUERY_SIGNING_PRIVATE_KEY',
    'RESEND_API_KEY',
    // The SMTP relay password is the self-hosted spelling of the same
    // credential, and lands on the same side of the same boundary: the worker
    // delivers mail, so the worker is the only service that may hold it.
    'SMTP_PASS',
    'GOOGLE_CLIENT_SECRET',
    'GITHUB_CLIENT_SECRET',
    // NOTE: ANONYMOUS_IDENTITY_SECRET is deliberately NOT in this list — the
    // collector is the one service that must hold it (its own schema above).
    // It sat here from M4 until the first real deployment (2026-07-24), when
    // startup EX_CONFIG'd: the copy-paste belonged to every OTHER service's
    // list, not the collector's own.
    // Trial identity HMAC secret lives only on the api service (§6).
    // The credential-source HMAC (ADR-0051, D4) keys a fingerprint of the
    // addresses customers' keys and CLIs connect from. Only the api
    // authenticates a read credential, so only the api needs it.
    'CREDENTIAL_SOURCE_SECRET',
    // Object storage holds customer import archives and export artefacts
    // (ADR-0032, D1). Only the worker (which moves the bytes) and the api
    // (which mints signed URLs) hold the key pair; the collector's whole job is
    // to validate and enqueue, and a bucket credential on the public intake
    // service is a credential reachable from the internet-facing surface.
    'OBJECT_STORAGE_ACCESS_KEY_ID',
    'OBJECT_STORAGE_SECRET_ACCESS_KEY',
    // The credential keyring decrypts customers' own payment-provider keys
    // (ADR-0033, D3). The collector validates and enqueues; it connects to no
    // provider and reads no credential row, and a key that unlocks every
    // customer's Stripe secret has no business on the internet-facing intake
    // service. Same reasoning as STRIPE_SECRET_KEY two lines up.
    'OA_CREDENTIAL_KEYRING',
    // The assistant talks to a model from the api and from nowhere else
    // (ADR-0046, D6). The collector validates and enqueues; a spend-capable
    // provider key on the internet-facing intake service is the same mistake as
    // the two entries above, one milestone later.
    'OPENAI_API_KEY',
  ],
  worker: [
    // The worker writes analytics and delivers email; it never mints browser
    // sessions or runs the OAuth login flow.
    'AUTH_SECRET',
    'QUERY_SIGNING_PRIVATE_KEY',
    'CLICKHOUSE_MIGRATION_PASSWORD',
    // STRIPE_SECRET_KEY was on this list until M10 and is deliberately not any
    // more: account deletion has to cancel a subscription and verify the
    // cancellation against Stripe (ADR-0030, D8). STRIPE_WEBHOOK_SECRET stays,
    // and that is what preserves the boundary the removed entry protected — the
    // worker cannot authenticate a Stripe event, so it cannot become a second
    // writer of entitlement state. It reacts to billing through the outbox and
    // the webhook ledger exactly as before; the one thing it can now do is end a
    // subscription whose owner is being erased.
    'GOOGLE_CLIENT_SECRET',
    'GITHUB_CLIENT_SECRET',
    // ANONYMOUS_IDENTITY_SECRET was on this list from M4 until M12 CP3 and is
    // deliberately not any more (ADR-0033, D6 amendment). The rule it enforced —
    // a key that can re-derive an anonymous id from an address must not sit
    // anywhere that also holds addresses — still holds in full, because the
    // worker holds no addresses: it never sees a raw IP, and the analytics
    // schema has no IP column for it to derive against. What the worker needs
    // the key for is the *other* derivation, `externalUserIdHash`, applied to
    // provider-side identifiers so `external_user_hash` on the revenue fact
    // joins against `events_raw.user_id` byte for byte. The collector remains
    // the only writer of event identity; this is a read-only use.
    // See the worker schema above for the full argument.
    //
    // Trial identity HMAC secret lives only on the api service (§6).
    // The credential-source HMAC (ADR-0051, D4) keys a fingerprint of the
    // addresses customers' keys and CLIs connect from. Only the api
    // authenticates a read credential, so only the api needs it.
    'CREDENTIAL_SOURCE_SECRET',
    // The worker delivers email, syncs revenue and executes deletions; it never
    // answers a question (ADR-0046, D2 — the assistant lives inside the process
    // that already serves the reads it consumes).
    'OPENAI_API_KEY',
  ],
  'query-gateway': [
    // Verify-only. Holding the private key would let the gateway forge the very
    // requests it exists to authenticate.
    'QUERY_SIGNING_PRIVATE_KEY',
    'AUTH_SECRET',
    'DATABASE_URL',
    'CLICKHOUSE_INGEST_PASSWORD',
    'CLICKHOUSE_MIGRATION_PASSWORD',
    // Deletion structurally cannot go through the gateway's SELECT allowlist,
    // and the credential that could bypass it does not belong here (ADR-0030 D4).
    'CLICKHOUSE_MAINTENANCE_PASSWORD',
    'RESEND_API_KEY',
    // The SMTP relay password is the self-hosted spelling of the same
    // credential, and lands on the same side of the same boundary: the worker
    // delivers mail, so the worker is the only service that may hold it.
    'SMTP_PASS',
    'GOOGLE_CLIENT_SECRET',
    'GITHUB_CLIENT_SECRET',
    // The D-102 anonymous-identity HMAC lives only on the collector: it is the
    // one service that sees a raw IP, and a key that can re-derive an anonymous
    // id from an address does not belong anywhere that also holds addresses.
    'ANONYMOUS_IDENTITY_SECRET',
    // Trial identity HMAC secret lives only on the api service (§6).
    // The credential-source HMAC (ADR-0051, D4) keys a fingerprint of the
    // addresses customers' keys and CLIs connect from. Only the api
    // authenticates a read credential, so only the api needs it.
    'CREDENTIAL_SOURCE_SECRET',
    // The gateway answers allowlisted SELECTs and nothing else; import and
    // export bytes never pass through it (ADR-0032, D1).
    'OBJECT_STORAGE_ACCESS_KEY_ID',
    'OBJECT_STORAGE_SECRET_ACCESS_KEY',
    // The gateway answers allowlisted SELECTs against ClickHouse and talks to no
    // provider. Revenue credentials are decrypted by the worker's sync path and
    // by nothing else (ADR-0033, D3).
    'OA_CREDENTIAL_KEYRING',
    // The gateway answers allowlisted SELECTs against ClickHouse and talks to
    // no model. A tool call reaches it as an ordinary read (ADR-0046, D4), so
    // it has no reason to hold the key the api pays with.
    'OPENAI_API_KEY',
  ],
  realtime: [
    'DATABASE_URL',
    'CLICKHOUSE_URL',
    'CLICKHOUSE_READ_PASSWORD',
    'CLICKHOUSE_INGEST_PASSWORD',
    'CLICKHOUSE_MAINTENANCE_PASSWORD',
    'AUTH_SECRET',
    'REALTIME_TOKEN_SIGNING_KEY',
    'RESEND_API_KEY',
    // The SMTP relay password is the self-hosted spelling of the same
    // credential, and lands on the same side of the same boundary: the worker
    // delivers mail, so the worker is the only service that may hold it.
    'SMTP_PASS',
    'GOOGLE_CLIENT_SECRET',
    'GITHUB_CLIENT_SECRET',
    // The D-102 anonymous-identity HMAC lives only on the collector: it is the
    // one service that sees a raw IP, and a key that can re-derive an anonymous
    // id from an address does not belong anywhere that also holds addresses.
    'ANONYMOUS_IDENTITY_SECRET',
    // Trial identity HMAC secret lives only on the api service (§6).
    // The credential-source HMAC (ADR-0051, D4) keys a fingerprint of the
    // addresses customers' keys and CLIs connect from. Only the api
    // authenticates a read credential, so only the api needs it.
    'CREDENTIAL_SOURCE_SECRET',
    // The realtime gateway holds presence state and nothing durable; it has no
    // reason to reach the bucket (ADR-0032, D1).
    'OBJECT_STORAGE_ACCESS_KEY_ID',
    'OBJECT_STORAGE_SECRET_ACCESS_KEY',
    // Presence state is all this service holds. It stores no credential, calls
    // no provider, and would gain nothing from the key that decrypts every
    // customer's provider secret (ADR-0033, D3).
    'OA_CREDENTIAL_KEYRING',
    // Presence state again: this service streams who is online and calls no
    // provider at all (ADR-0046, D6).
    'OPENAI_API_KEY',
  ],
}

export type ServiceEnv<S extends ServiceEnvName> = z.infer<(typeof serviceSchemas)[S]> &
  z.infer<typeof policySchema>

export class EnvValidationError extends Error {
  readonly service: ServiceEnvName
  readonly issues: readonly { path: string; message: string }[]

  constructor(service: ServiceEnvName, issues: readonly { path: string; message: string }[]) {
    super(
      `Invalid environment for service "${service}":\n${issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    )
    this.name = 'EnvValidationError'
    this.service = service
    this.issues = issues
  }
}

/**
 * Extra variables and extra boundaries contributed by an optional surface.
 *
 * The registration shape `registerErrorCodes` established, applied to
 * configuration: a surface that is not part of every deployment declares its own
 * variables in its own module and registers them at import time, so
 * `loadServiceEnv` still validates them at boot and still refuses to start a
 * service that was handed a credential it has no business holding — without the
 * product schemas naming a provider they may never talk to.
 *
 * The typed *result* stays the product's: `ServiceEnv<S>` is what every service
 * reads, and a surface that declares variables parses them itself, where the
 * code that uses them lives.
 */
export interface EnvExtension {
  readonly name: string
  /** Additional variables, per service, validated alongside the service schema. */
  readonly schemas?: Partial<Record<ServiceEnvName, z.ZodObject<z.ZodRawShape>>>
  /** Additional least-privilege boundaries, per service. */
  readonly forbiddenKeys?: Partial<Record<ServiceEnvName, readonly string[]>>
}

const envExtensions: EnvExtension[] = []

export function registerEnvExtension(extension: EnvExtension): void {
  if (envExtensions.some((registered) => registered.name === extension.name)) return
  envExtensions.push(extension)
}

export function forbiddenKeysFor(service: ServiceEnvName): readonly string[] {
  return [
    ...FORBIDDEN_KEYS[service],
    ...envExtensions.flatMap((extension) => extension.forbiddenKeys?.[service] ?? []),
  ]
}

/** The cross-service policy block, which every service validates in addition to
 * its own schema. Not a service, so it gets its own scope name. */
export const POLICY_SCOPE = 'policy'

export interface EnvVariableDescription {
  readonly name: string
  /** Every schema that declares it — one or more services, and/or the policy block. */
  readonly scopes: readonly (ServiceEnvName | typeof POLICY_SCOPE)[]
  /** True when at least one declaring schema refuses to start without it. */
  readonly required: boolean
  /** The schema's own default, stringified; absent when it has none. */
  readonly defaultValue: string | undefined
  readonly forbiddenFor: readonly ServiceEnvName[]
}

/**
 * The full inventory of variables this codebase reads through a schema.
 *
 * It exists so `scripts/generate-env-example.mjs` can be *complete by
 * construction*. The handwritten `.env.example` it replaces was not: it had
 * drifted into omitting variables that had existed for milestones and into
 * asserting behaviour the code does not have, and nothing failed when it did.
 * A generator reading the schemas cannot omit a variable, and its `--check` mode
 * turns "somebody added an env var and forgot the example" into a failing build.
 *
 * Required and default are *probed* rather than read off zod internals: each
 * field is asked to parse `undefined` and the answer is the definition — a
 * failure means required, a value means that value is the default, `undefined`
 * means optional with none. That survives a zod upgrade in a way `_def`
 * archaeology does not.
 */
export function describeEnvSurface(): readonly EnvVariableDescription[] {
  const found = new Map<
    string,
    {
      scopes: (ServiceEnvName | typeof POLICY_SCOPE)[]
      required: boolean
      defaultValue: string | undefined
    }
  >()

  const record = (
    scope: ServiceEnvName | typeof POLICY_SCOPE,
    name: string,
    field: z.ZodType,
  ): void => {
    const probe = field.safeParse(undefined)
    const entry = found.get(name) ?? { scopes: [], required: false, defaultValue: undefined }
    entry.scopes.push(scope)
    // Required for *any* service is required in an example file: the file is one
    // document serving every service, so the stricter reading is the useful one.
    entry.required ||= !probe.success
    if (probe.success && probe.data !== undefined) {
      entry.defaultValue ??= String(probe.data)
    }
    found.set(name, entry)
  }

  for (const service of SERVICE_ENV_NAMES) {
    for (const [name, field] of Object.entries(serviceSchemas[service].shape)) {
      record(service, name, field as z.ZodType)
    }
  }
  for (const [name, field] of Object.entries(policySchema.shape)) {
    record(POLICY_SCOPE, name, field as z.ZodType)
  }

  return [...found.entries()]
    .map(([name, entry]) => ({
      name,
      scopes: entry.scopes,
      required: entry.required,
      defaultValue: entry.defaultValue,
      forbiddenFor: SERVICE_ENV_NAMES.filter((service) => forbiddenKeysFor(service).includes(name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The suffix that marks a variable as carrying a path instead of a value. */
const FILE_SUFFIX = '_FILE'

/**
 * Every variable name any schema in this process knows about.
 *
 * Deliberately the *union across all services*, not the calling service's own
 * schema. `QUERY_SIGNING_PRIVATE_KEY` belongs to the api's schema, so a
 * per-service set would leave `QUERY_SIGNING_PRIVATE_KEY_FILE` unresolved on
 * the gateway — and an unresolved name is a name the forbidden-key check never
 * sees. The boundary is only enforceable if every service resolves every name.
 *
 * Forbidden keys are folded in for the same reason: a name a service must never
 * hold has to be resolvable *there* in order to be refused there.
 */
function knownVariableNames(): ReadonlySet<string> {
  const names = new Set<string>()
  for (const service of SERVICE_ENV_NAMES) {
    for (const name of Object.keys(serviceSchemas[service].shape)) names.add(name)
    for (const name of forbiddenKeysFor(service)) names.add(name)
  }
  for (const name of Object.keys(policySchema.shape)) names.add(name)
  for (const extension of envExtensions) {
    for (const schema of Object.values(extension.schemas ?? {})) {
      if (!schema) continue
      for (const name of Object.keys(schema.shape)) names.add(name)
    }
  }
  return names
}

/**
 * Reads `X` from the file named by `X_FILE`, returning a copy of the source.
 *
 * The one-click self-host platforms (Coolify, Openship and the template
 * catalogues shaped like them) can generate a random *string* into an
 * environment variable and nothing else: no catalogue has a generator that
 * produces a keypair whose halves must match across two services. A one-shot
 * step in the stack can write the pairs to a volume, but only if the services
 * can be pointed at files. That is the whole reason this exists.
 *
 * Three rules, all of them loud. A path is an assertion that the value matters,
 * so an unreadable or empty file is a refusal to start — unlike an absent
 * variable, which several services deliberately treat as "this feature is off"
 * (the optional-until-used rule). Silently starting with the feature disabled is
 * the failure mode this whole mechanism exists to avoid: a stack that comes up
 * green while analytics reads are unmounted.
 *
 * A `*_FILE` variable whose base name no schema declares is left alone rather
 * than rejected: `SSL_CERT_FILE` is a standard OpenSSL variable that may be set
 * on any host, and refusing to boot over somebody else's convention would be a
 * self-inflicted outage.
 */
function resolveFileBackedVariables(
  source: Record<string, string | undefined>,
  issues: { path: string; message: string }[],
): Record<string, string | undefined> {
  const resolved = { ...source }
  const known = knownVariableNames()

  for (const [key, path] of Object.entries(source)) {
    if (!key.endsWith(FILE_SUFFIX)) continue
    if (path === undefined || path === '') continue
    const name = key.slice(0, -FILE_SUFFIX.length)
    if (!known.has(name)) continue

    if (source[name] !== undefined && source[name] !== '') {
      issues.push({
        path: key,
        message: `cannot be combined with ${name}: set the value or the file path, not both`,
      })
      continue
    }

    let contents: string
    try {
      contents = readFileSync(path, 'utf8')
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error
          ? String((error as { code?: unknown }).code)
          : 'unknown error'
      issues.push({ path: key, message: `cannot read "${path}" (${code})` })
      continue
    }

    // Trailing newline is what every generator writes and no consumer wants:
    // `openssl pkey -out` ends the PEM with one. Never the contents in an
    // issue message — the path is diagnostic, the value is the secret.
    const value = contents.trim()
    if (value === '') {
      issues.push({ path: key, message: `file "${path}" is empty` })
      continue
    }
    resolved[name] = value
  }

  return resolved
}

/**
 * `resolveFileBackedVariables` for callers outside `loadServiceEnv`.
 *
 * A registered surface parses its *own* variables where the code that uses them
 * lives — `loadServiceEnv` validates them at boot but does not return them, so
 * the surface reads `process.env` a second time later. That second read has to
 * resolve paths too. Without it a deployment supplying one of a surface's
 * variables as a path would pass boot validation and then find nothing there
 * when the surface parsed for itself: green at startup, broken at the first
 * request that needed the value. Found by testing the extension branch rather
 * than assuming it behaved like the product's own.
 *
 * Throws rather than collecting, because by the time a surface parses, boot has
 * already reported every readable problem; anything failing here is a file that
 * changed underneath a running process.
 */
export function resolveEnvFileReferences(
  source: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const issues: { path: string; message: string }[] = []
  const resolved = resolveFileBackedVariables(source, issues)
  if (issues.length > 0) {
    throw new Error(
      `Invalid file-backed environment:\n${issues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    )
  }
  return resolved
}

/**
 * Validates the environment for one service.
 *
 * Throws `EnvValidationError` listing every problem at once. Reporting one
 * variable per restart makes bringing up a new environment needlessly slow.
 */
export function loadServiceEnv<S extends ServiceEnvName>(
  service: S,
  source: Record<string, string | undefined> = process.env,
): ServiceEnv<S> {
  const issues: { path: string; message: string }[] = []

  // FIRST, before the boundary check below reads it. The check matches variable
  // NAMES, so a value still sitting behind `X_FILE` is a value the boundary
  // cannot see: point a gateway at the api's private key file and it would come
  // up green, holding the key that mints the envelopes it exists to verify.
  // Resolving here means a file-supplied secret is refused exactly where the
  // same secret supplied inline is refused. Proven by breaking it first:
  // with this call below the loop, the gateway started without complaint.
  const resolved = resolveFileBackedVariables(source, issues)

  for (const key of forbiddenKeysFor(service)) {
    if (resolved[key] !== undefined && resolved[key] !== '') {
      issues.push({
        path: key,
        message: `must not be provided to the "${service}" service (least-privilege secret boundary)`,
      })
    }
  }

  const parsed = serviceSchemas[service].safeParse(resolved)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ path: issue.path.join('.') || '(root)', message: issue.message })
    }
  }

  // Registered surfaces validate at boot too, so a malformed provider secret is
  // a refusal to start rather than a failure on the first request that needs it.
  for (const extension of envExtensions) {
    const schema = extension.schemas?.[service]
    if (!schema) continue
    const result = schema.safeParse(resolved)
    if (result.success) continue
    for (const issue of result.error.issues) {
      issues.push({ path: issue.path.join('.') || '(root)', message: issue.message })
    }
  }

  const policy = policySchema.safeParse(resolved)
  if (!policy.success) {
    for (const issue of policy.error.issues) {
      issues.push({ path: issue.path.join('.') || '(root)', message: issue.message })
    }
  }

  if (issues.length > 0) {
    throw new EnvValidationError(service, issues)
  }

  return { ...parsed.data, ...policy.data } as ServiceEnv<S>
}
