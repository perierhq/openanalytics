import { createHash } from 'node:crypto'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import {
  DEFAULT_TRACKER_SETTINGS,
  EMPTY_INGEST_EXCLUSIONS,
  InvalidHeartbeatIntervalError,
  type IngestExclusions,
  isValidHeartbeatIntervalSeconds,
  type SiteIngestConfig,
  type SiteTrackerSettings,
} from '@openanalytics/domain'
import type { Database } from '../client.ts'
import { apiKeys } from '../schema/api-keys.ts'
import { siteDomains, sites } from '../schema/sites.ts'
import { siteIngestSettings } from '../schema/ingest.ts'

/**
 * Tracking key → versioned site ingest config (plan 04 Milestone 5 item 2, docs
 * snapshot 02 §7.1 item 3).
 *
 * This is the read the collector performs before it validates anything expensive
 * and before it enqueues anything at all. Three properties shape it:
 *
 * - **It is a read, and only a read.** The collector never updates the usage hot
 *   row, never writes an outbox entry, never calls a provider. Even
 *   `api_keys.last_used_at` is deliberately left alone: a write on the ingest
 *   path would put a Postgres round-trip and a hot row in front of every event.
 * - **Only a `tracking_write` key resolves.** The public key is an ingest
 *   identifier and nothing else (docs snapshot 01 §3.2), so a private read key
 *   presented here finds nothing rather than something with fewer privileges.
 * - **One query.** The collector runs on Vercel with Postgres over the public
 *   internet; a config resolution that cost four round-trips would dominate the
 *   latency of accepting an event.
 *
 * A revoked or expired key resolves to `null` here, and the resolved config also
 * carries the key's expiry so a *cached* entry cannot outlive it — docs snapshot
 * 02 §7.2 allows a short-TTL config cache during a Postgres outage but forbids
 * an expired or revoked key from failing open into one.
 */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * One published no-code rule, flattened with the definition that names it
 * (ADR-0034). This is the shape the tracker is served and the shape the
 * collector resolves a claimed `rule_id` against.
 */
export interface ResolvedNoCodeRule {
  readonly rule_id: string
  readonly name: string
  readonly version: number
  readonly trigger: 'click' | 'submit' | 'url_pattern'
  readonly selector?: string
  readonly url_pattern?: string
  readonly properties?: readonly { key: string; source: string; argument?: string }[]
}

export interface ResolvedIngestConfig {
  readonly config: SiteIngestConfig
  readonly settings: SiteTrackerSettings
  /** Site slug, for logs and diagnostics. Never used for authorization. */
  readonly slug: string
  /**
   * The site's currently published rules (ADR-0034).
   *
   * Resolved in the same single query as everything else, deliberately: this
   * module's third stated property is "one query", and the collector needs
   * these on the *event* path too — establishing `no_code_rule` origin means
   * looking a claimed `rule_id` up in the published set, and doing that with a
   * second round-trip would put a Postgres read in front of every batch.
   */
  readonly noCodeRules: readonly ResolvedNoCodeRule[]
  /**
   * The site's server-side exclusions (migration 0051), in the same single
   * query. Never part of the tracker config: the collector matches them, no
   * browser sees them.
   */
  readonly exclusions: IngestExclusions
}

/** The four exclusion columns of a (possibly absent) settings row. */
interface ExclusionColumns {
  readonly excludeIpRanges: string[] | null
  readonly excludePaths: string[] | null
  readonly excludeCountries: string[] | null
  readonly excludeHostnames: string[] | null
}

const exclusionColumns = {
  excludeIpRanges: siteIngestSettings.excludeIpRanges,
  excludePaths: siteIngestSettings.excludePaths,
  excludeCountries: siteIngestSettings.excludeCountries,
  excludeHostnames: siteIngestSettings.excludeHostnames,
}

/** A site with no settings row excludes nothing, the same as an empty row. */
function exclusionsFrom(row: ExclusionColumns): IngestExclusions {
  return {
    ipRanges: row.excludeIpRanges ?? EMPTY_INGEST_EXCLUSIONS.ipRanges,
    paths: row.excludePaths ?? EMPTY_INGEST_EXCLUSIONS.paths,
    countries: row.excludeCountries ?? EMPTY_INGEST_EXCLUSIONS.countries,
    hostnames: row.excludeHostnames ?? EMPTY_INGEST_EXCLUSIONS.hostnames,
  }
}

/**
 * Resolve a public tracking key to everything the collector needs.
 *
 * Returns `null` when no live `tracking_write` key matches — an unknown,
 * revoked or expired key are deliberately indistinguishable to the caller, so
 * probing the endpoint reveals nothing about which keys once existed.
 */
export async function resolveIngestConfig(
  db: Database,
  trackingKey: string,
): Promise<ResolvedIngestConfig | null> {
  const keyHash = sha256Hex(trackingKey)

  const [row] = await db
    .select({
      siteId: sites.id,
      slug: sites.slug,
      status: sites.status,
      ingestGeneration: sites.ingestGeneration,
      configVersion: sites.configVersion,
      billingUserId: sites.ownerUserId,
      keyExpiresAt: apiKeys.expiresAt,
      timezone: siteIngestSettings.timezone,
      redactQueryKeys: siteIngestSettings.redactQueryKeys,
      interactionSampling: siteIngestSettings.interactionSampling,
      heartbeatIntervalSeconds: siteIngestSettings.heartbeatIntervalSeconds,
      featureWebVitals: siteIngestSettings.featureWebVitals,
      featureEngagement: siteIngestSettings.featureEngagement,
      featureInteractions: siteIngestSettings.featureInteractions,
      featureHeartbeat: siteIngestSettings.featureHeartbeat,
      attributedRevenue: siteIngestSettings.attributedRevenue,
      ...exclusionColumns,
      allowedDomains: sql<string[]>`coalesce(
        (SELECT array_agg(lower(domain)) FROM site_domains WHERE site_id = ${sites.id}),
        '{}'
      )`,
      // The published rule set, flattened and stamped with each rule's event
      // name and definition version (ADR-0034). Ordered inside the aggregate so
      // an unchanged rule set serialises identically on every read: the ETag is
      // built from `config_version`, but the *body* changing under a stable tag
      // would be worse than a cache miss, and an unordered `jsonb_agg` is free
      // to reorder between two executions of the same query.
      noCodeRules: sql<ResolvedNoCodeRule[]>`coalesce((
        SELECT jsonb_agg(
                 r || jsonb_build_object('name', d.event_name, 'version', v.version)
                 ORDER BY d.event_name, d.id, r->>'rule_id'
               )
          FROM event_definitions d
          JOIN event_definition_versions v
            ON v.definition_id = d.id AND v.version = d.published_version
          CROSS JOIN LATERAL jsonb_array_elements(v.rules) AS r
         WHERE d.site_id = ${sites.id} AND d.archived_at IS NULL
      ), '[]'::jsonb)`,
    })
    .from(apiKeys)
    .innerJoin(sites, eq(sites.id, apiKeys.siteId))
    .leftJoin(siteIngestSettings, eq(siteIngestSettings.siteId, sites.id))
    .where(
      and(
        eq(apiKeys.keyHash, keyHash),
        eq(apiKeys.type, 'tracking_write'),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), sql`${apiKeys.expiresAt} > now()`),
      ),
    )

  if (!row) return null

  return {
    slug: row.slug,
    config: {
      siteId: row.siteId,
      status: row.status,
      ingestGeneration: row.ingestGeneration,
      configVersion: row.configVersion,
      billingUserId: row.billingUserId,
      // Zero until a surface that versions the assignment says otherwise; the
      // decorator that resolves one replaces this before the event is stamped.
      billingAssignmentVersion: 0,
      keyExpiresAt: row.keyExpiresAt,
      allowedDomains: row.allowedDomains ?? [],
    },
    noCodeRules: row.noCodeRules ?? [],
    exclusions: exclusionsFrom(row),
    settings: {
      timezone: row.timezone ?? DEFAULT_TRACKER_SETTINGS.timezone,
      redactQueryKeys: row.redactQueryKeys ?? DEFAULT_TRACKER_SETTINGS.redactQueryKeys,
      interactionSampling: row.interactionSampling ?? DEFAULT_TRACKER_SETTINGS.interactionSampling,
      heartbeatIntervalSeconds:
        row.heartbeatIntervalSeconds ?? DEFAULT_TRACKER_SETTINGS.heartbeatIntervalSeconds,
      features: {
        web_vitals: row.featureWebVitals ?? DEFAULT_TRACKER_SETTINGS.features.web_vitals,
        engagement: row.featureEngagement ?? DEFAULT_TRACKER_SETTINGS.features.engagement,
        interactions: row.featureInteractions ?? DEFAULT_TRACKER_SETTINGS.features.interactions,
        heartbeat: row.featureHeartbeat ?? DEFAULT_TRACKER_SETTINGS.features.heartbeat,
      },
      attributedRevenue: row.attributedRevenue ?? DEFAULT_TRACKER_SETTINGS.attributedRevenue,
    },
  }
}

/**
 * A site's stored tracker settings, for the management surface (ADR-0064 F4).
 *
 * Separate from `resolveIngestConfig` on purpose: that one is the ingest path's
 * single query, keyed by a public tracking key and shaped by what the collector
 * needs on every batch. This is a dashboard read keyed by site id, and it also
 * carries `config_version`, which the settings surface needs so a caller can see
 * that its write is the one browsers will now fetch.
 *
 * `null` when no such site exists. A site with no settings ROW is not null: it
 * is served the defaults, which is the state most sites are in.
 */
export async function readSiteIngestSettings(
  db: Database,
  siteId: string,
): Promise<{
  settings: SiteTrackerSettings
  exclusions: IngestExclusions
  configVersion: number
} | null> {
  const [row] = await db
    .select({
      configVersion: sites.configVersion,
      timezone: siteIngestSettings.timezone,
      redactQueryKeys: siteIngestSettings.redactQueryKeys,
      interactionSampling: siteIngestSettings.interactionSampling,
      heartbeatIntervalSeconds: siteIngestSettings.heartbeatIntervalSeconds,
      featureWebVitals: siteIngestSettings.featureWebVitals,
      featureEngagement: siteIngestSettings.featureEngagement,
      featureInteractions: siteIngestSettings.featureInteractions,
      featureHeartbeat: siteIngestSettings.featureHeartbeat,
      attributedRevenue: siteIngestSettings.attributedRevenue,
      ...exclusionColumns,
    })
    .from(sites)
    .leftJoin(siteIngestSettings, eq(siteIngestSettings.siteId, sites.id))
    .where(eq(sites.id, siteId))

  if (!row) return null

  return {
    configVersion: row.configVersion,
    exclusions: exclusionsFrom(row),
    settings: {
      timezone: row.timezone ?? DEFAULT_TRACKER_SETTINGS.timezone,
      redactQueryKeys: row.redactQueryKeys ?? DEFAULT_TRACKER_SETTINGS.redactQueryKeys,
      interactionSampling: row.interactionSampling ?? DEFAULT_TRACKER_SETTINGS.interactionSampling,
      heartbeatIntervalSeconds:
        row.heartbeatIntervalSeconds ?? DEFAULT_TRACKER_SETTINGS.heartbeatIntervalSeconds,
      features: {
        web_vitals: row.featureWebVitals ?? DEFAULT_TRACKER_SETTINGS.features.web_vitals,
        engagement: row.featureEngagement ?? DEFAULT_TRACKER_SETTINGS.features.engagement,
        interactions: row.featureInteractions ?? DEFAULT_TRACKER_SETTINGS.features.interactions,
        heartbeat: row.featureHeartbeat ?? DEFAULT_TRACKER_SETTINGS.features.heartbeat,
      },
      attributedRevenue: row.attributedRevenue ?? DEFAULT_TRACKER_SETTINGS.attributedRevenue,
    },
  }
}

export interface UpsertSiteIngestSettingsInput {
  readonly siteId: string
  readonly timezone?: string
  readonly redactQueryKeys?: readonly string[]
  readonly interactionSampling?: number
  readonly heartbeatIntervalSeconds?: number
  readonly features?: Partial<SiteTrackerSettings['features']>
  readonly attributedRevenue?: boolean
  /** Present means "replace all four lists"; already normalised by the domain. */
  readonly exclusions?: IngestExclusions
}

/**
 * Write a site's tracker settings and bump `sites.config_version` in the same
 * transaction.
 *
 * The bump is not optional and is not the caller's to remember: the version is
 * what invalidates the CDN's copy of the config, the tracker's local copy and
 * the collector's ingest-config cache, all at once (ADR-0008). A settings write
 * that skipped it would leave every browser running the old configuration until
 * some unrelated change happened to move the version.
 */
export async function upsertSiteIngestSettings(
  db: Database,
  input: UpsertSiteIngestSettingsInput,
): Promise<{ configVersion: number }> {
  // Checked before the transaction opens (ADR-0035, D8). The column's own CHECK
  // (migration 0039) would catch it too, but a constraint violation surfaces as
  // a driver error with no explanation of *why* the presence window forbids the
  // value — and the thing it prevents is a board that flickers, which reads as a
  // bug in everything except the setting that caused it.
  if (
    input.heartbeatIntervalSeconds !== undefined &&
    !isValidHeartbeatIntervalSeconds(input.heartbeatIntervalSeconds)
  ) {
    throw new InvalidHeartbeatIntervalError(input.heartbeatIntervalSeconds)
  }

  const values = {
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    ...(input.redactQueryKeys === undefined ? {} : { redactQueryKeys: [...input.redactQueryKeys] }),
    ...(input.interactionSampling === undefined
      ? {}
      : { interactionSampling: input.interactionSampling }),
    ...(input.heartbeatIntervalSeconds === undefined
      ? {}
      : { heartbeatIntervalSeconds: input.heartbeatIntervalSeconds }),
    ...(input.features?.web_vitals === undefined
      ? {}
      : { featureWebVitals: input.features.web_vitals }),
    ...(input.features?.engagement === undefined
      ? {}
      : { featureEngagement: input.features.engagement }),
    ...(input.features?.interactions === undefined
      ? {}
      : { featureInteractions: input.features.interactions }),
    ...(input.features?.heartbeat === undefined
      ? {}
      : { featureHeartbeat: input.features.heartbeat }),
    ...(input.attributedRevenue === undefined
      ? {}
      : { attributedRevenue: input.attributedRevenue }),
    ...(input.exclusions === undefined
      ? {}
      : {
          excludeIpRanges: [...input.exclusions.ipRanges],
          excludePaths: [...input.exclusions.paths],
          excludeCountries: [...input.exclusions.countries],
          excludeHostnames: [...input.exclusions.hostnames],
        }),
  }

  return db.transaction(async (tx) => {
    await tx
      .insert(siteIngestSettings)
      .values({ siteId: input.siteId, ...values })
      .onConflictDoUpdate({
        target: siteIngestSettings.siteId,
        set: { ...values, updatedAt: new Date() },
      })

    const [site] = await tx
      .update(sites)
      .set({ configVersion: sql`${sites.configVersion} + 1`, updatedAt: new Date() })
      .where(eq(sites.id, input.siteId))
      .returning({ configVersion: sites.configVersion })
    if (!site) throw new Error('site not found while bumping config_version')

    return { configVersion: site.configVersion }
  })
}

/** A site's configured origin allowlist, lowercased. */
export async function listSiteDomains(db: Database, siteId: string): Promise<string[]> {
  const rows = await db
    .select({ domain: siteDomains.domain })
    .from(siteDomains)
    .where(eq(siteDomains.siteId, siteId))
  return rows.map((row) => row.domain.toLowerCase())
}
