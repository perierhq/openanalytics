/**
 * Schema barrel.
 *
 * Re-exports only table objects (never the `_shared` column builders), because
 * this is what the Drizzle client is handed as its `schema` for relational
 * queries. Each table also carries the Drizzle mirror of a raw-SQL migration in
 * `packages/postgres/migrations`; the SQL is the DDL source of truth (ADR-0006),
 * and the bootstrap test asserts the two do not drift.
 *
 * PRODUCT tables only. The cloud stream's tables (billing assignments,
 * subscriptions, trial, usage windows, webhook_events) mirror under
 * `packages/postgres/src/cloud/schema` with their own barrel.
 */

export * from './auth.ts'
export * from './sites.ts'
export * from './usage.ts'
export * from './api-keys.ts'
export * from './audit.ts'
export * from './outbox.ts'
export * from './lifecycle.ts'
export * from './ingest.ts'
export * from './ingest-batches.ts'
export * from './session-finalizer.ts'
export * from './worker-heartbeats.ts'
export * from './public-dashboard.ts'
export * from './idempotency.ts'
export * from './funnels.ts'
export * from './imports.ts'
export * from './exports.ts'
export * from './revenue.ts'
export * from './event-definitions.ts'
export * from './oauth.ts'
export * from './read-cost.ts'
export * from './widgets.ts'
export * from './assistant-usage.ts'
export * from './credential-sources.ts'
export * from './deployment-settings.ts'
export * from './mentions.ts'
export * from './chart-notes.ts'
