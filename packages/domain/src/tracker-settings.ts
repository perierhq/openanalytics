import {
  MAX_HEARTBEAT_INTERVAL_SECONDS,
  MIN_HEARTBEAT_INTERVAL_SECONDS,
  PRESENCE_WINDOW_HEARTBEAT_RATIO,
} from '@openanalytics/contracts'
import { normalizeIngestExclusions, type IngestExclusions } from './ingest-exclusions.ts'

/**
 * Defaults for a site's tracker configuration (docs snapshot 02 §11).
 *
 * `site_ingest_settings` (migration 0014) is an optional row: a site acquires
 * one when a dashboard change writes it, and until then the collector serves
 * these. That is what made the migration a pure expand with no backfill — but it
 * also means these values are what most sites actually run on, so they live here
 * rather than as literals in the repository that happens to read the row.
 *
 * The tracker carries its own copy of these defaults for the first page load,
 * before any config request has completed (`apps/tracker/src/core.ts`). The two
 * must agree, or a visitor's first pageview would be tracked under different
 * rules from their second; `tests/tracker/config.test.ts` and the contract tests
 * hold that line.
 */

/**
 * Whether a heartbeat interval is one a site may be configured with
 * (ADR-0035, D8).
 *
 * The rule is the presence window, not a taste: three intervals must fit inside
 * it, so a visitor survives two consecutive lost heartbeats. Enforced at write
 * time as well as by the column's `CHECK` (migration 0039) and the published
 * contract, because a value outside it does not fail loudly — it produces a
 * board that flickers, which reads as a bug in everything except the setting
 * that caused it.
 */
export function isValidHeartbeatIntervalSeconds(seconds: number): boolean {
  return (
    Number.isInteger(seconds) &&
    seconds >= MIN_HEARTBEAT_INTERVAL_SECONDS &&
    seconds <= MAX_HEARTBEAT_INTERVAL_SECONDS
  )
}

/**
 * Thrown by a settings write given a value the presence window forbids.
 *
 * **An HTTP writer must map this to `400 VALIDATION_FAILED`**, and since
 * 2026-08-13 there is one: `PATCH /v1/sites/{site_id}/ingest-settings`
 * (ADR-0064 F4). It refuses the value *before* the repository is called, through
 * `normalizeTrackerSettingsPatch` below, so this error stays the last line of
 * defence rather than the first — an uncaught throw out of a route handler is a
 * 500, and a customer typing 200 into a form deserves to be told the bound.
 */
export class InvalidHeartbeatIntervalError extends Error {
  readonly seconds: number

  constructor(seconds: number) {
    super(
      `heartbeat_interval_seconds must be an integer in ` +
        `[${MIN_HEARTBEAT_INTERVAL_SECONDS}, ${MAX_HEARTBEAT_INTERVAL_SECONDS}] — the presence ` +
        `window must hold ${PRESENCE_WINDOW_HEARTBEAT_RATIO} intervals so a visitor survives two ` +
        `consecutive lost heartbeats (ADR-0035); got ${seconds}`,
    )
    this.name = 'InvalidHeartbeatIntervalError'
    this.seconds = seconds
  }
}

export interface TrackerFeatureFlags {
  readonly web_vitals: boolean
  readonly engagement: boolean
  readonly interactions: boolean
  readonly heartbeat: boolean
}

export interface SiteTrackerSettings {
  readonly timezone: string
  readonly redactQueryKeys: readonly string[]
  readonly interactionSampling: number
  readonly heartbeatIntervalSeconds: number
  readonly features: TrackerFeatureFlags
  /**
   * Whether this site's browsers may send the revenue-linking hint (ADR-0064
   * D4a, migration 0043).
   *
   * Deliberately not inside `features`: those are measurement signals and
   * default on, this is a linking signal and defaults off. It is also not the
   * same question as consent — the visitor's consent decides whether a hint
   * *may* be sent, and this decides whether the site wants one at all. The
   * choice is enforced at the signal, in the browser: with the flag off the
   * tracker sends no hint even from a visitor who granted consent, so a site
   * that has not opted in cannot be attributing revenue by accident.
   */
  readonly attributedRevenue: boolean
}

/**
 * `UTC` for the timezone, because a wrong guess is worse than a neutral one: a
 * dashboard grouped in a timezone the customer did not choose looks like missing
 * traffic at the day boundary. It affects grouping only — the anonymous
 * identity's rotation day is always the UTC calendar date (D-102).
 *
 * Sampling reports every click. ADR-0008 rejected default sampling as an
 * invented product decision: it silently distorts a heatmap, and the tracker's
 * throttle plus its per-pageview ceiling already bound the volume.
 *
 * The heartbeat interval matches the tracker's own `HEARTBEAT_INTERVAL_SECONDS`.
 *
 * `attributedRevenue` is the one value here that is off by default, and the
 * reason is the one ADR-0064 turns on: everything else is measurement, and this
 * is the flag that lets a browser send a hint tying a visitor to an order.
 */
export const DEFAULT_TRACKER_SETTINGS: SiteTrackerSettings = {
  timezone: 'UTC',
  redactQueryKeys: [],
  interactionSampling: 1,
  heartbeatIntervalSeconds: 15,
  features: {
    web_vitals: true,
    engagement: true,
    interactions: true,
    heartbeat: true,
  },
  attributedRevenue: false,
}

/** The patch a settings write may carry. Every field is optional and absent
 * means "leave it alone" — never "reset it to the default". */
export interface TrackerSettingsPatch {
  readonly timezone?: string
  readonly redactQueryKeys?: readonly string[]
  readonly interactionSampling?: number
  readonly heartbeatIntervalSeconds?: number
  readonly features?: Partial<TrackerFeatureFlags>
  readonly attributedRevenue?: boolean
  /**
   * Server-side exclusions. Never part of what a browser is served — they are
   * read by the collector alone — but written through the same settings
   * surface, so a change moves `config_version` and reaches the collector's
   * ingest-config cache the way every other setting does. Present means
   * "replace the whole set".
   */
  readonly exclusions?: IngestExclusions
}

/** One rejected field, in the shape the HTTP layer reports validation issues. */
export interface TrackerSettingsIssue {
  readonly field: string
  readonly code: string
}

export type TrackerSettingsPatchResult =
  | { readonly ok: true; readonly patch: TrackerSettingsPatch }
  | { readonly ok: false; readonly issues: readonly TrackerSettingsIssue[] }

/** Bounds mirrored from the published `TrackerConfig` contract, so a value the
 * browser would refuse cannot be stored in the first place. */
const REDACT_KEYS_MAX_COUNT = 200
const REDACT_KEY_MAX_LENGTH = 64
const FEATURE_NAMES = ['web_vitals', 'engagement', 'interactions', 'heartbeat'] as const

/**
 * Normalize an untrusted settings patch (ADR-0064 F4).
 *
 * Pure, and deliberately outside the route: what makes a settings value legal is
 * a property of the product, not of one HTTP handler, and every bound here has a
 * twin in the `TrackerConfig` contract or in a column CHECK. A value that got
 * past this function and was then refused by Postgres would reach the caller as
 * a 500 — a driver error for what is a form mistake.
 *
 * Absent is not the same as null: this returns only the keys the caller actually
 * sent, so a patch that mentions one flag cannot silently reset the rest.
 *
 * `isValidTimezone` is NOT applied here — the caller supplies it, because the
 * runtime's tz database is the authority and `@openanalytics/domain` must not
 * import the contracts package for one predicate.
 */
export function normalizeTrackerSettingsPatch(
  input: unknown,
  isValidTimezone: (value: string) => boolean,
): TrackerSettingsPatchResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: [{ field: 'body', code: 'not_an_object' }] }
  }

  const body = input as Record<string, unknown>
  const issues: TrackerSettingsIssue[] = []
  const patch: {
    timezone?: string
    redactQueryKeys?: string[]
    interactionSampling?: number
    heartbeatIntervalSeconds?: number
    features?: Partial<TrackerFeatureFlags>
    attributedRevenue?: boolean
    exclusions?: IngestExclusions
  } = {}

  if (Object.hasOwn(body, 'timezone')) {
    const value = body['timezone']
    if (typeof value !== 'string' || !isValidTimezone(value)) {
      issues.push({ field: 'timezone', code: 'invalid' })
    } else {
      patch.timezone = value
    }
  }

  if (Object.hasOwn(body, 'redact_query_keys')) {
    const value = body['redact_query_keys']
    if (!Array.isArray(value)) {
      issues.push({ field: 'redact_query_keys', code: 'not_an_array' })
    } else if (value.length > REDACT_KEYS_MAX_COUNT) {
      issues.push({ field: 'redact_query_keys', code: 'too_many' })
    } else {
      // Lowercased and de-duplicated here rather than at read time: the resolver
      // lowercases what it reads, so storing mixed case would make the stored
      // row and the served config disagree for no reason anybody could see.
      const keys: string[] = []
      let bad = false
      for (const entry of value) {
        if (
          typeof entry !== 'string' ||
          entry.length === 0 ||
          entry.length > REDACT_KEY_MAX_LENGTH
        ) {
          bad = true
          break
        }
        const normalized = entry.trim().toLowerCase()
        if (normalized !== '' && !keys.includes(normalized)) keys.push(normalized)
      }
      if (bad) issues.push({ field: 'redact_query_keys', code: 'invalid' })
      else patch.redactQueryKeys = keys
    }
  }

  if (Object.hasOwn(body, 'interaction_sampling')) {
    const value = body['interaction_sampling']
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      issues.push({ field: 'interaction_sampling', code: 'out_of_range' })
    } else {
      patch.interactionSampling = value
    }
  }

  if (Object.hasOwn(body, 'heartbeat_interval_seconds')) {
    const value = body['heartbeat_interval_seconds']
    if (typeof value !== 'number' || !isValidHeartbeatIntervalSeconds(value)) {
      // The presence window is what bounds this (ADR-0035 D8), and the reason it
      // is refused rather than clamped is that the thing a bad value produces is
      // a flickering realtime board, which reads as a bug in everything except
      // the setting that caused it.
      issues.push({ field: 'heartbeat_interval_seconds', code: 'out_of_range' })
    } else {
      patch.heartbeatIntervalSeconds = value
    }
  }

  if (Object.hasOwn(body, 'features')) {
    const value = body['features']
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ field: 'features', code: 'not_an_object' })
    } else {
      const features: { -readonly [K in keyof TrackerFeatureFlags]?: boolean } = {}
      const record = value as Record<string, unknown>
      for (const name of Object.keys(record)) {
        if (!(FEATURE_NAMES as readonly string[]).includes(name)) {
          issues.push({ field: `features.${name}`, code: 'unknown' })
          continue
        }
        const flag = record[name]
        if (typeof flag !== 'boolean') {
          issues.push({ field: `features.${name}`, code: 'not_a_boolean' })
          continue
        }
        features[name as keyof TrackerFeatureFlags] = flag
      }
      if (Object.keys(features).length > 0) patch.features = features
    }
  }

  if (Object.hasOwn(body, 'attributed_revenue')) {
    const value = body['attributed_revenue']
    if (typeof value !== 'boolean') {
      issues.push({ field: 'attributed_revenue', code: 'not_a_boolean' })
    } else {
      patch.attributedRevenue = value
    }
  }

  if (Object.hasOwn(body, 'exclusions')) {
    const result = normalizeIngestExclusions(body['exclusions'])
    if (result.ok) patch.exclusions = result.exclusions
    else issues.push(...result.issues)
  }

  if (issues.length > 0) return { ok: false, issues }
  if (Object.keys(patch).length === 0) {
    // An empty patch is refused rather than treated as a no-op, matching the
    // site settings PATCH: a save that changed nothing is far more likely a
    // client bug than an intention, and it would still bump `config_version`
    // and re-fetch every browser's configuration for nothing.
    return { ok: false, issues: [{ field: 'body', code: 'required_one_of' }] }
  }
  return { ok: true, patch }
}
