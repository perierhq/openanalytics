#!/usr/bin/env node
/**
 * Generates the self-host environment template from the schemas that actually
 * validate it.
 *
 * ## Why generated
 *
 * The template this replaces was handwritten, and a handwritten one drifts in
 * two directions at once. It had fallen behind — `AUTH_TRUSTED_ORIGINS`,
 * `AUTH_PASSWORD_SIGNIN`, `GEOIP_DB_PATH`, `QUERY_SIGNING_KEY_ID`,
 * `QUERY_GATEWAY_AUDIENCE`, `ASSISTANT_MODEL`, `PORT`, `PRODUCT_NAME` and the
 * whole `NEXT_PUBLIC_*` block were absent, so an operator following it produced
 * a deployment that could not do several things the product does — and it had
 * drifted *ahead*, asserting that the migration runner creates the three
 * ClickHouse users, which nothing in this repository does.
 *
 * Neither failure is the author's: a document that has to be kept in sync by
 * memory will not be. So the inventory comes from `describeEnvSurface()`, which
 * reads the same zod schemas the services boot against, and this script refuses
 * to run if any variable is unaccounted for. What stays curated is the part a
 * schema cannot know — which section a variable belongs in and what a plausible
 * value looks like — and the completeness check is what keeps that curation
 * honest.
 *
 * ## Usage
 *
 *   pnpm run build          # reads the built domain package
 *   pnpm run env:example    # writes .env.example at the repository root
 *   pnpm run env:example:check   # fails if the committed file is stale (CI)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * The repository root, which is where this file has always *landed* — it was
 * written into the export skeleton and overlaid at the root on the way out.
 * With the export gone (ADR-0062) that indirection has no second half: the
 * skeleton directory does not exist here, so `pnpm run verify` failed on a
 * fresh clone at the one step CONTRIBUTING tells a contributor to run.
 */
const OUTPUT = join(ROOT, '.env.example')
const WEB_DIR = join(ROOT, 'apps', 'web')

const { describeEnvSurface, POLICY_SCOPE } = await import('../packages/domain/dist/index.js').catch(
  (err) => {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      process.stderr.write('generate-env-example: run `pnpm run build` first\n')
      process.exit(1)
    }
    throw err
  },
)

/**
 * Variables read straight from `process.env` by the two migration CLIs rather
 * than through a service schema. They are not in `describeEnvSurface()` because
 * no service boots with them — and they are the ones an operator needs *first*,
 * so leaving them out would be the same defect from the other side.
 */
const TOOLING_VARIABLES = [
  {
    name: 'POSTGRES_MIGRATION_URL',
    value: '',
    hint: 'Optional. `pnpm run migrate:postgres` falls back to DATABASE_URL; set this only when migrations run as a different, DDL-capable role.',
  },
  {
    name: 'CLICKHOUSE_MIGRATION_USER',
    value: 'oa_migration',
    hint: 'DDL on analytics.* — used by `pnpm run migrate:clickhouse` and by nothing else. On every service FORBIDDEN list.',
  },
  { name: 'CLICKHOUSE_MIGRATION_PASSWORD', value: '', hint: undefined },
  {
    name: 'CLICKHOUSE_DATABASE',
    value: 'analytics',
    hint: 'The ClickHouse migration CLI reads CLICKHOUSE_DATABASE; the services read CLICKHOUSE_DB. Set both to the same value.',
  },
]

/**
 * The dev-only `NEXT_PUBLIC_*` names whose purpose a scan cannot recover.
 * Anything found in `apps/web` and missing here is still emitted, without a
 * hint — the scan is the source of truth, this is only annotation.
 */
const WEB_HINTS = {
  NEXT_PUBLIC_API_URL: 'The api service, as the browser reaches it.',
  NEXT_PUBLIC_REALTIME_URL: 'The realtime gateway, as the browser reaches it.',
  NEXT_PUBLIC_COLLECTOR_URL:
    'The collector, as the browser reaches it. Also the host that serves oa.js.',
  NEXT_PUBLIC_MOCK_API:
    'Development only: renders the dashboard against fixtures instead of a live api.',
  NEXT_PUBLIC_LIVE_API: 'Development only: forces the live api even when the mock flag is on.',
  NEXT_PUBLIC_OA_TRACKING_KEY:
    'Optional self-measurement: the tracking_write key of the site this install ' +
    'serves, so the marketing pages report to your own dashboard. Unset, no ' +
    'tracker is injected. All three OA_ variables are needed together.',
  NEXT_PUBLIC_OA_COLLECTOR_URL:
    'The collector the injected tracker posts to, and the host it loads oa.js from.',
  NEXT_PUBLIC_OA_TRACKED_HOSTS:
    'Comma-separated hostnames to measure. Only the marketing hosts belong here ' +
    '— listing the dashboard host counts signed-in sessions as landing traffic.',
  NEXT_PUBLIC_SITE_URL:
    'The origin this dashboard is served from. Canonical URLs, sitemap.xml and ' +
    'the OG card hang off it; unset, the app publishes no absolute URLs and no ' +
    'structured data rather than claiming an address it does not have.',
  NEXT_PUBLIC_SITE_NAME: 'The product name shown in page titles and metadata.',
  NEXT_PUBLIC_SITE_DESCRIPTION: 'The one-line description in the metadata and the OG card.',
  NEXT_PUBLIC_SITE_EMAIL:
    'Where a human reaches whoever runs this install. Unset, the surfaces that ' +
    'would print it (the error screens, the troubleshooting page) say nothing ' +
    'rather than offering an address nobody reads.',
}

/** Illustrative values. Absent, a variable is emitted empty (secrets) or with
 * its schema default (everything else). */
const VALUES = {
  NEXT_PUBLIC_SITE_URL: 'https://analytics.example',
  NEXT_PUBLIC_SITE_NAME: 'Open Analytics',
  DATABASE_URL: 'postgres://openanalytics:change-me@127.0.0.1:5432/openanalytics',
  EVENT_STREAM_REDIS_URL: 'redis://127.0.0.1:6379',
  REALTIME_CACHE_REDIS_URL: 'redis://127.0.0.1:6380',
  CLICKHOUSE_URL: 'http://127.0.0.1:8123',
  CLICKHOUSE_INGEST_USER: 'oa_ingest',
  CLICKHOUSE_READ_USER: 'oa_read',
  CLICKHOUSE_MAINTENANCE_USER: 'oa_maintenance',
  ENVIRONMENT: 'production',
  NODE_ENV: 'production',
  APP_BASE_URL: 'https://app.analytics.example',
  AUTH_BASE_URL: 'https://api.analytics.example',
  COLLECTOR_BASE_URL: 'https://c.analytics.example',
  AUTH_TRUSTED_ORIGINS: 'https://app.analytics.example',
  QUERY_GATEWAY_URL: 'http://127.0.0.1:8090',
  EMAIL_FROM: 'Analytics <hello@analytics.example>',
  SMTP_HOST: 'smtp.analytics.example',
  SMTP_PORT: '587',
  SMTP_USER: 'analytics@analytics.example',
  OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
  OBJECT_STORAGE_REGION: 'local',
  OBJECT_STORAGE_BUCKET: 'openanalytics',
  GEOIP_DB_PATH: '/srv/geoip/GeoLite2-City.mmdb',
  NEXT_PUBLIC_API_URL: 'https://api.analytics.example',
  NEXT_PUBLIC_REALTIME_URL: 'https://rt.analytics.example',
  NEXT_PUBLIC_COLLECTOR_URL: 'https://c.analytics.example',
  NEXT_PUBLIC_OA_COLLECTOR_URL: 'https://c.analytics.example',
  NEXT_PUBLIC_OA_TRACKED_HOSTS: 'analytics.example,www.analytics.example',
}

/** Per-variable notes the schema cannot express. */
const HINTS = {
  AUTH_SECRET:
    'Generate with `openssl rand -hex 32`. The api and `pnpm run create-admin` must use the SAME value.',
  ANONYMOUS_IDENTITY_SECRET:
    'Keys the anonymous visitor id. Rotating it makes every returning visitor look new for a day.',
  AUTH_TRUSTED_ORIGINS:
    'Comma-separated. The browser origins allowed to hold a session; the CORS and CSRF boundary.',
  AUTH_PASSWORD_SIGNIN:
    'Password sign-in. Off here, on by default in `infra/selfhost`: it is the door a self-hosted install has that needs neither an OAuth app nor a mail server, and the first-run screen at /login creates the account it signs in with. Not a bootstrap flag to switch back afterwards.',
  AUTH_EMAIL_VERIFICATION:
    'Leave required. The first account is written verified — there is no mail to verify it with, which is why it exists — so the usual install never needs this. `optional` is the escape hatch for an install whose transport broke later.',
  RESEND_API_KEY:
    'Hosted email. Leave empty and set the SMTP block instead for a self-hosted install.',
  SMTP_HOST:
    'Set this and the magic link can be delivered — the whole of what a fresh install needs to let anyone in.',
  SMTP_SECURE:
    "`true` for implicit TLS on port 465; leave empty for 587, which upgrades with STARTTLS. Only the literals 'true' and 'false' are accepted.",
  MENTIONS_X_API_URL:
    'An fxtwitter-compatible search service. Point it at your own fxtwitter to keep the searches off the public instance.',
  MENTIONS_ENABLED:
    "`false` stops the mentions poller for every site. Only the literals 'true' and 'false' are accepted.",
  SMTP_PASS: 'Worker only — the api refuses to start if it is given this.',
  SMTP_FROM:
    'Overrides EMAIL_FROM for SMTP, for relays that refuse a From other than the authenticated mailbox.',
  DATABASE_URL:
    'Needed in practice by everything above the analytics read path, even though each service boots without it.',
  CLICKHOUSE_INGEST_USER: 'INSERT on analytics.* only (worker).',
  CLICKHOUSE_READ_USER: 'SELECT on analytics.* only (query gateway).',
  CLICKHOUSE_MAINTENANCE_USER:
    'ALTER DELETE + SELECT, for account deletion (worker). Separate from the ingest user on purpose.',
  QUERY_SIGNING_PRIVATE_KEY:
    'Ed25519 pair with QUERY_SIGNING_PUBLIC_KEY. Generate: `openssl genpkey -algorithm ed25519`. Multi-line PEM cannot live in an env FILE — inject it through compose `environment:` or a secret manager.',
  REALTIME_TOKEN_SIGNING_KEY:
    'Signs realtime tokens; REALTIME_TOKEN_VERIFY_KEY is its verifying half on the realtime service.',
  GEOIP_DB_PATH:
    'A City-schema .mmdb (GeoLite2 or DB-IP). Unset means every event carries null geo — a degradation, never a failure.',
  OA_CREDENTIAL_KEYRING:
    'JSON: {"active":"k1","keys":{"k1":"<base64 32 bytes>"}}. Encrypts customers\' own provider credentials.',
  OPENAI_API_KEY:
    'The assistant. Unset, the assistant routes still answer and report that no provider is configured.',
  CREDENTIAL_SOURCE_SECRET:
    'HMACs the address a read credential connects from. Unset, no credential event is journalled at all.',
  METRICS_REMOTE_WRITE_URL:
    'Prometheus remote-write. Unset, every service keeps its structured-log metrics floor.',
  PORT: 'Per service. Each one reads its own PORT, so this belongs in the per-service env file, not a shared one.',
}

/**
 * The document's shape. Every variable in the schemas must appear in exactly one
 * section; the check below is what makes that true rather than aspirational.
 *
 * It documents the *product's* schemas, which is why there is no Stripe section
 * and no operator-chat one: those variables are declared by the surfaces that read
 * them (`packages/domain/src/cloud/env.ts`) and this generator does not import
 * that tree. A deployment that mounts them keeps its own values in its own env
 * file; nothing here would help an operator who is not us.
 */
const SECTIONS = [
  {
    title: 'Postgres — the control plane',
    blurb: [
      'Users, sites, tracking keys, jobs and the outbox. Every service but',
      'the query gateway and the realtime gateway reads it.',
    ],
    keys: ['DATABASE_URL'],
  },
  {
    title: 'ClickHouse — events and rollups',
    blurb: [
      'Least-privilege users, and deliberately no superuser at runtime:',
      'oa_ingest only INSERTs, oa_read only SELECTs, oa_maintenance runs the',
      'ALTER DELETEs account deletion needs, and the only account with DDL is',
      'oa_migration, further down under Migration tooling.',
      '',
      'They must already exist on the ClickHouse server before the migrations',
      'run. Neither this template nor the migration runner creates them.',
    ],
    keys: [
      'CLICKHOUSE_URL',
      'CLICKHOUSE_DB',
      'CLICKHOUSE_INGEST_USER',
      'CLICKHOUSE_INGEST_PASSWORD',
      'CLICKHOUSE_READ_USER',
      'CLICKHOUSE_READ_PASSWORD',
      'CLICKHOUSE_MAINTENANCE_USER',
      'CLICKHOUSE_MAINTENANCE_PASSWORD',
    ],
  },
  {
    title: 'Valkey / Redis — two instances, different guarantees',
    blurb: [
      'The event stream can hold the only copy of an event (noeviction + AOF);',
      'the realtime cache holds losable state. If the collector reaches the',
      'queue across the public internet, use rediss:// with AUTH — the',
      'connection factory requires TLS+AUTH for that hop.',
    ],
    keys: ['EVENT_STREAM_REDIS_URL', 'REALTIME_CACHE_REDIS_URL'],
  },
  {
    title: 'Deployment shape',
    blurb: ['Where each piece lives, and what the product calls itself.'],
    keys: [
      'ENVIRONMENT',
      'NODE_ENV',
      'LOG_LEVEL',
      'PORT',
      'PRODUCT_NAME',
      'APP_BASE_URL',
      'AUTH_BASE_URL',
      'COLLECTOR_BASE_URL',
      'QUERY_GATEWAY_URL',
      'SERVICE_VERSION',
      'GIT_COMMIT',
    ],
  },
  {
    title: 'Identity and session secrets',
    blurb: ['Generate each one fresh: `openssl rand -hex 32`. None is derived from another.'],
    keys: [
      'AUTH_SECRET',
      'AUTH_TRUSTED_ORIGINS',
      'AUTH_COOKIE_SAMESITE',
      'AUTH_PASSWORD_SIGNIN',
      'AUTH_EMAIL_VERIFICATION',
      'ANONYMOUS_IDENTITY_SECRET',
      'ANONYMOUS_IDENTITY_KEY_VERSION',
      'CREDENTIAL_SOURCE_SECRET',
      'CREDENTIAL_SOURCE_KEY_VERSION',
    ],
  },
  {
    title: 'Email — how anyone signs in at all',
    blurb: [
      'The front door is a magic link, so a deployment with no transport here',
      'has no way for anyone to log in. Set the SMTP block for a self-hosted',
      'install; RESEND_API_KEY is the hosted alternative and wins if both are',
      'set. None of this is required to get in — the first-run screen at /login',
      'creates an account with a password — and none of it has to be a file:',
      'the dashboard stores a relay too, and a stored one wins over everything',
      'here.',
    ],
    keys: [
      'EMAIL_FROM',
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_SECURE',
      'SMTP_USER',
      'SMTP_PASS',
      'SMTP_FROM',
      'RESEND_API_KEY',
    ],
  },
  {
    title: 'Configuring the deployment from the dashboard',
    blurb: [
      'The mail relay and the model provider can be typed into Account →',
      'Deployment instead of into these files, stored encrypted under',
      'OA_CREDENTIAL_KEYRING and taking effect with no restart. Only the',
      'account that claimed the deployment — the oldest one — may use the',
      'screen. Set `disabled` on a multi-tenant deployment, where the',
      'environment IS the configuration; the api and the worker must agree.',
    ],
    keys: ['DEPLOYMENT_SETTINGS'],
  },
  {
    title: 'OAuth sign-in (optional)',
    blurb: ['A provider is offered only when both halves are present.'],
    keys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
  },
  {
    title: 'Ed25519 signing pairs — api to gateway, api to realtime, api to collector',
    blurb: [
      'Three pairs. The PRIVATE half goes only to the api; the PUBLIC half only',
      'to the service that verifies. Each private key is on the verifying',
      "service's FORBIDDEN list, so a copy-paste that hands a verifier its own",
      'signing key is a startup failure rather than a silent forgery surface.',
    ],
    keys: [
      'QUERY_SIGNING_PRIVATE_KEY',
      'QUERY_SIGNING_PUBLIC_KEY',
      'QUERY_SIGNING_KEY_ID',
      'QUERY_GATEWAY_AUDIENCE',
      'QUERY_SIGNATURE_LIFETIME_MS',
      'QUERY_SIGNATURE_MAX_LIFETIME_MS',
      'QUERY_GATEWAY_TIMEOUT_MS',
      'REALTIME_TOKEN_SIGNING_KEY',
      'REALTIME_TOKEN_VERIFY_KEY',
    ],
  },
  {
    title: 'Query gateway limits',
    blurb: ['Cost and concurrency guards on the analytics read path.'],
    keys: [
      'QUERY_MAX_BODY_BYTES',
      'QUERY_TIMEOUT_MS',
      'QUERY_MAX_CONCURRENCY',
      'QUERY_RATE_LIMIT_PER_MINUTE',
      'QUERY_CH_MAX_EXECUTION_SECONDS',
      'QUERY_CH_MAX_RESULT_ROWS',
      'QUERY_CACHE_TTL_MS',
      'QUERY_CACHE_MAX_ENTRIES',
      'QUERY_CACHE_FINALIZED_TTL_MS',
    ],
  },
  {
    title: 'Site cards on GET /v1/sites',
    blurb: [
      'The all-time figures and sparkline the sites grid renders (ADR-0080).',
      'All three have working defaults. The timeout is deliberately far below',
      'QUERY_GATEWAY_TIMEOUT_MS: the site list is the dashboard shell load and',
      'these figures only decorate it, so past the deadline the list still',
      'answers with null figures rather than making the shell wait.',
    ],
    keys: ['SITES_CARD_CACHE_TTL_MS', 'SITES_CARD_GATEWAY_TIMEOUT_MS', 'SITES_CARD_MAX_SITES'],
  },
  {
    title: 'Geo (optional)',
    blurb: ['A licensed deploy artifact, refreshed on the host and never committed.'],
    keys: ['GEOIP_DB_PATH'],
  },
  {
    title: 'Object storage (optional) — import, export, backups',
    blurb: [
      'Any S3-compatible endpoint. All five, or the surface is not mounted:',
      'a signature needs every one of them.',
    ],
    keys: [
      'OBJECT_STORAGE_ENDPOINT',
      'OBJECT_STORAGE_REGION',
      'OBJECT_STORAGE_BUCKET',
      'OBJECT_STORAGE_ACCESS_KEY_ID',
      'OBJECT_STORAGE_SECRET_ACCESS_KEY',
    ],
  },
  {
    title: 'Revenue provider credentials (optional)',
    blurb: [
      "Encrypts customers' own payment-provider keys. Held by the api and the",
      'worker and by nobody else.',
    ],
    keys: ['OA_CREDENTIAL_KEYRING'],
  },
  {
    title: 'Embedded widgets (optional)',
    blurb: [
      'Where an embedded widget’s footer mark points. Unset, the footer renders',
      'the same line as plain text with no link at all — there is no default,',
      'because the mark names a product and this build does not know yours.',
    ],
    keys: ['WIDGET_WATERMARK_URL'],
  },
  {
    title: 'X mentions (optional)',
    blurb: [
      'The worker searches X for sites whose owner turned mention watching on.',
      'It sends each such site’s domain and search terms to MENTIONS_X_API_URL',
      'and nothing about any visitor. MENTIONS_ENABLED=false stops it for every',
      'site; MENTIONS_POLL_MINUTES (policy, below) sets how often a site is polled.',
    ],
    keys: ['MENTIONS_X_API_URL', 'MENTIONS_ENABLED'],
  },
  {
    title: 'AI assistant (optional)',
    blurb: ['Unset, the assistant routes still answer and say the provider is not configured.'],
    keys: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ASSISTANT_MODEL'],
  },
  {
    title: 'Metrics (optional)',
    blurb: [
      'Prometheus remote-write. Without it every service keeps its structured-log',
      'metrics floor, which is a degradation and not a failure.',
    ],
    keys: [
      'METRICS_REMOTE_WRITE_URL',
      'METRICS_REMOTE_WRITE_USER',
      'METRICS_REMOTE_WRITE_TOKEN',
      'METRICS_FLUSH_INTERVAL_SECONDS',
    ],
  },
]

const SERVICE_ORDER = ['api', 'collector', 'worker', 'query-gateway', 'realtime']

function scopeLabel(description) {
  const services = SERVICE_ORDER.filter((service) => description.scopes.includes(service))
  if (description.scopes.includes(POLICY_SCOPE) && services.length === 0) return 'all services'
  if (services.length === SERVICE_ORDER.length) return 'all services'
  return services.join(', ')
}

function stateLabel(description) {
  if (description.required) return 'required'
  if (description.defaultValue !== undefined) return `optional, default ${description.defaultValue}`
  return 'optional'
}

function valueFor(description) {
  if (VALUES[description.name] !== undefined) return VALUES[description.name]
  if (description.defaultValue !== undefined) return description.defaultValue
  return ''
}

/** Wraps a hint to keep the file readable at 88 columns like the rest of the repo. */
function commentLines(text, prefix = '#   ') {
  const words = text.split(/\s+/u)
  const lines = []
  let line = ''
  for (const word of words) {
    if (line.length > 0 && line.length + 1 + word.length > 84 - prefix.length) {
      lines.push(prefix + line)
      line = word
    } else {
      line = line.length > 0 ? `${line} ${word}` : word
    }
  }
  if (line.length > 0) lines.push(prefix + line)
  return lines
}

function renderVariable(description) {
  const out = [`# ${scopeLabel(description)} · ${stateLabel(description)}`]
  if (description.forbiddenFor.length > 0) {
    out.push(...commentLines(`Never give this to: ${description.forbiddenFor.join(', ')}.`, '# '))
  }
  if (HINTS[description.name]) out.push(...commentLines(HINTS[description.name], '# '))
  out.push(`${description.name}='${valueFor(description)}'`)
  return out
}

function collectWebVariables() {
  const found = new Set()
  const skip = new Set(['node_modules', '.next', 'dist', 'coverage'])
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(?:ts|tsx|mjs|js|jsx)$/u.test(entry)) continue
      for (const match of readFileSync(full, 'utf8').matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/gu)) {
        found.add(match[0])
      }
    }
  }
  walk(WEB_DIR)
  return [...found].sort()
}

function build() {
  const surface = describeEnvSurface()
  const byName = new Map(surface.map((description) => [description.name, description]))

  // Completeness, both directions. A variable the schemas know about and no
  // section places would silently vanish from the template — which is the exact
  // failure this generator exists to end — and a section key with no schema
  // behind it is a variable the file would teach an operator to set for nothing.
  const placed = new Set()
  const unknown = []
  for (const section of SECTIONS) {
    for (const key of section.keys) {
      if (!byName.has(key)) unknown.push(key)
      if (placed.has(key)) unknown.push(`${key} (placed twice)`)
      placed.add(key)
    }
  }
  const policyNames = surface
    .filter((description) => description.scopes.includes(POLICY_SCOPE))
    .map((description) => description.name)
  for (const name of policyNames) placed.add(name)

  const missing = surface.map((d) => d.name).filter((name) => !placed.has(name))
  if (missing.length > 0 || unknown.length > 0) {
    process.stderr.write(
      'generate-env-example: the section table is out of date.\n' +
        (missing.length > 0 ? `  not placed in any section: ${missing.join(', ')}\n` : '') +
        (unknown.length > 0
          ? `  named by a section but unknown to the schemas: ${unknown.join(', ')}\n`
          : '') +
        '  Fix SECTIONS in scripts/generate-env-example.mjs.\n',
    )
    process.exit(1)
  }

  const lines = [
    '# OpenAnalytics environment template.',
    '#',
    '# GENERATED FILE — do not edit by hand.',
    '#   pnpm run env:example        regenerates it',
    '#   pnpm run env:example:check  fails if it has gone stale',
    '#',
    '# Its inventory comes from packages/domain/src/env.ts, which is what every',
    '# service validates against at startup, so nothing here can be missing and',
    '# nothing here can describe a variable the code does not read.',
    '#',
    '# THIS FILE IS A REFERENCE, NOT A STARTING POINT. To actually configure a',
    '# deployment use `infra/selfhost/`: `generate-secrets.sh` writes one env file',
    '# per service from `env/*.env.example`, already split the way the next',
    '# paragraph requires and with every secret generated. Read this one to find',
    '# out what a variable is for and what stops working without it.',
    '#',
    '# If you do write values here, quote every one — several may contain `&` or',
    '# `?` that a plain `set -a; . ./.env` would treat as shell syntax and',
    '# silently truncate — and DELETE the lines you are not setting rather than',
    '# leaving them empty. `FOO=` is the empty string, not an absent variable, and',
    '# the schema rejects it: a service handed this file verbatim does not start.',
    '#',
    '# "optional" below means optional *to boot*. A missing required variable stops',
    '# the process; a missing optional one leaves the surface it powers unmounted,',
    '# which is why nearly everything here is optional and why a half-configured',
    '# deployment fails at startup rather than at a customer request. What stops',
    '# working without each one is in the section headings.',
    '#',
    '# THIS IS NOT ONE FILE PER DEPLOYMENT. Each service refuses to start when it',
    '# is handed a secret it has no business holding — that boundary is the reason',
    '# a leaked collector cannot reach ClickHouse — so the `Never give this to:`',
    '# lines below are startup failures, not advice. Split this into one env file',
    '# per service accordingly.',
    '',
  ]

  for (const section of SECTIONS) {
    lines.push(`# ${'='.repeat(74)}`)
    lines.push(`# ${section.title}`)
    lines.push(`# ${'='.repeat(74)}`)
    for (const blurb of section.blurb) lines.push(blurb === '' ? '#' : `# ${blurb}`)
    lines.push('')
    for (const key of section.keys) {
      lines.push(...renderVariable(byName.get(key)))
      lines.push('')
    }
  }

  lines.push(`# ${'='.repeat(74)}`)
  lines.push('# Migration tooling')
  lines.push(`# ${'='.repeat(74)}`)
  lines.push('# Read directly by the two migration CLIs, not by any service.')
  lines.push('')
  for (const tool of TOOLING_VARIABLES) {
    if (tool.hint) lines.push(...commentLines(tool.hint, '# '))
    lines.push(`${tool.name}='${tool.value}'`)
    lines.push('')
  }

  const webVariables = collectWebVariables()
  lines.push(`# ${'='.repeat(74)}`)
  lines.push('# Frontend (apps/web)')
  lines.push(`# ${'='.repeat(74)}`)
  lines.push('# BUILD-TIME, not run-time: Next.js inlines every NEXT_PUBLIC_* value into')
  lines.push('# the bundle, so these must be present when `next build` runs and changing')
  lines.push('# them later requires a rebuild, not a restart. They are public by')
  lines.push('# definition — never put a secret behind this prefix.')
  lines.push('')
  for (const name of webVariables) {
    if (WEB_HINTS[name]) lines.push(...commentLines(WEB_HINTS[name], '# '))
    lines.push(`${name}='${VALUES[name] ?? ''}'`)
    lines.push('')
  }

  lines.push(`# ${'='.repeat(74)}`)
  lines.push('# Tuning — every one of these has a working default')
  lines.push(`# ${'='.repeat(74)}`)
  lines.push('# Validated by the cross-service policy schema, which also enforces the')
  lines.push('# invariants *between* them: a dedup window shorter than the accepted event')
  lines.push('# lateness, for instance, is refused at startup rather than silently')
  lines.push('# double-billing a retry. Left commented out on purpose — the defaults are')
  lines.push('# the decisions, and the values below are those defaults, shown so an')
  lines.push('# operator can see what is in force without reading the source.')
  lines.push('')
  for (const name of policyNames.slice().sort()) {
    const description = byName.get(name)
    if (HINTS[name]) lines.push(...commentLines(HINTS[name], '# '))
    lines.push(`# ${name}='${description.defaultValue ?? ''}'`)
  }
  lines.push('')

  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n')}`
}

const content = build()

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(OUTPUT, 'utf8')
  } catch {
    process.stderr.write(
      `generate-env-example: ${OUTPUT} does not exist — run \`pnpm run env:example\`\n`,
    )
    process.exit(1)
  }
  if (current !== content) {
    process.stderr.write(
      `generate-env-example: ${OUTPUT} is stale.\n` +
        '  An environment variable changed and the template did not. Run `pnpm run env:example`.\n',
    )
    process.exit(1)
  }
  process.stdout.write('generate-env-example: template is current\n')
} else {
  writeFileSync(OUTPUT, content, 'utf8')
  process.stdout.write(`generate-env-example: wrote ${OUTPUT}\n`)
}
