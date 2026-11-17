import type { TrackerConfig } from '@openanalytics/contracts'
import type { CloudIngestFacts } from './cloud-extension.ts'
import {
  compileIngestExclusions,
  type CompiledIngestExclusions,
  type Policy,
  type SiteIngestConfig,
  type SiteTrackerSettings,
} from '@openanalytics/domain'
import {
  type Database,
  type ResolvedNoCodeRule,
  resolveIngestConfig,
} from '@openanalytics/postgres'
import type { TrackerConfigRecord, TrackerConfigStore } from './tracker-config.ts'

/**
 * The real tracking-key → ingest-config lookup, with the short-TTL versioned
 * cache docs snapshot 02 §7.2 permits.
 *
 * ADR-0008 left this a port because resolving a tracking key is Milestone 5's
 * work. This is that work: one Postgres read behind a cache that exists for one
 * reason — the collector runs on Vercel and reaches Postgres over the public
 * internet, so a per-event round trip would dominate the latency of accepting an
 * event.
 *
 * The cache is bounded in three directions, and the third is the one the design
 * actually rests on:
 *
 * 1. **Time.** `INGEST_CONFIG_CACHE_TTL_SECONDS` — short, because a key revoked
 *    in the dashboard has to stop working promptly.
 * 2. **Size.** An LRU, so a key-probing flood cannot grow the cache without
 *    bound in a process that may live for hours.
 * 3. **Expiry.** A cached entry carries the key's own `keyExpiresAt`, and
 *    `decideIngestAdmission` refuses on it. §7.2 allows a short-TTL cache while
 *    Postgres is unavailable but is explicit that an expired or revoked key must
 *    never fail open into one, so the cache may serve a stale *config* and must
 *    never serve a dead *key*.
 *
 * A negative result is cached too, and deliberately for a shorter time: without
 * it, a flood of invalid keys becomes a flood of Postgres queries, which is the
 * cheapest possible denial of service against the collector.
 */

export interface CachedIngestConfig {
  readonly config: SiteIngestConfig
  readonly settings: SiteTrackerSettings
  readonly slug: string
  /**
   * The site's published no-code rules (ADR-0034).
   *
   * Cached with the rest of the config and subject to the same TTL, which is
   * the honest consequence of ADR-0022: a rule published in the dashboard can
   * be up to `INGEST_CONFIG_CACHE_TTL_SECONDS` late reaching this process. That
   * is invisible next to the ~10 minutes ADR-0034 D4 already states for the
   * browser, and it is why an unresolvable `rule_id` is billed as ordinary
   * `client_sdk` traffic rather than rejected.
   */
  readonly noCodeRules: readonly ResolvedNoCodeRule[]
  /**
   * The site's server-side exclusions, compiled for matching.
   *
   * Compiled once per `config_version` and reused across TTL refreshes of the
   * same version, so neither an event nor a cache refill pays for parsing
   * CIDR ranges and path patterns. Never projected into `toTrackerConfig`.
   */
  readonly exclusions: CompiledIngestExclusions
  /**
   * What a registered surface resolved beside this config (`decorateConfig`).
   *
   * Cached in the same entry and under the same TTL as everything else, which is
   * the point: the hosted quota gate needs a plan tier and a quota anchor on
   * every batch, and resolving them per event would put a second Postgres
   * round-trip in front of accepting one. Absent in every self-hosted build.
   */
  readonly cloud?: CloudIngestFacts
}

interface CacheEntry {
  readonly value: CachedIngestConfig | null
  readonly expiresAtMs: number
}

/**
 * Divisor for the negative-result TTL. A missing key is far more likely to be a
 * transient state — a key created a moment ago, a deploy racing a rotation —
 * than a positive result is to be wrong, so a miss is remembered for a shorter
 * time than a hit.
 */
const NEGATIVE_TTL_DIVISOR = 6

export interface IngestConfigStoreOptions {
  readonly db: Database
  readonly policy: Pick<Policy, 'INGEST_CONFIG_CACHE_TTL_SECONDS'>
  /** Entries retained. Bounds memory against a key-probing flood. */
  readonly maxEntries?: number
  readonly now?: () => number
  /**
   * Called on a cache *miss*, with the config just read, to resolve whatever an
   * optional surface needs beside it. Its result is what gets cached, so a throw
   * here fails the resolution rather than caching a config without its facts —
   * the conservative direction for a gate that decides whether to bill.
   */
  readonly decorate?: (resolved: CachedIngestConfig) => Promise<CachedIngestConfig>
}

export interface IngestConfigStore {
  /** `null` when no live tracking key matches. Unknown, revoked and expired keys
   * are indistinguishable, so probing reveals nothing. */
  resolve(trackingKey: string): Promise<CachedIngestConfig | null>
  /** Drops a key's cached entry. Used when a resolution is proven stale. */
  invalidate(trackingKey: string): void
}

const DEFAULT_MAX_ENTRIES = 5_000

export function createIngestConfigStore(options: IngestConfigStoreOptions): IngestConfigStore {
  const ttlMs = options.policy.INGEST_CONFIG_CACHE_TTL_SECONDS * 1000
  const negativeTtlMs = Math.max(1_000, Math.floor(ttlMs / NEGATIVE_TTL_DIVISOR))
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const now = options.now ?? Date.now

  // Insertion-ordered Map as the LRU: a hit re-inserts, so the oldest key is
  // always the first one the iterator yields.
  const cache = new Map<string, CacheEntry>()

  // Compiled exclusions by site, stamped with the config version they were
  // compiled from. A TTL refill of an unchanged site reuses the matcher; a
  // settings write moves the version and the next refill recompiles. Bounded
  // like the cache above, by site rather than by key.
  const compiled = new Map<string, { version: number; exclusions: CompiledIngestExclusions }>()
  const compiledFor = (
    siteId: string,
    version: number,
    source: Parameters<typeof compileIngestExclusions>[0],
  ): CompiledIngestExclusions => {
    const prior = compiled.get(siteId)
    if (prior !== undefined && prior.version === version) return prior.exclusions
    const exclusions = compileIngestExclusions(source)
    compiled.delete(siteId)
    compiled.set(siteId, { version, exclusions })
    while (compiled.size > maxEntries) {
      const oldest = compiled.keys().next()
      if (oldest.done === true) break
      compiled.delete(oldest.value)
    }
    return exclusions
  }

  const remember = (key: string, value: CachedIngestConfig | null): void => {
    cache.delete(key)
    cache.set(key, {
      value,
      expiresAtMs: now() + (value === null ? negativeTtlMs : ttlMs),
    })
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next()
      if (oldest.done === true) break
      cache.delete(oldest.value)
    }
  }

  return {
    async resolve(trackingKey: string): Promise<CachedIngestConfig | null> {
      const cached = cache.get(trackingKey)
      if (cached !== undefined) {
        if (cached.expiresAtMs > now()) {
          // Refresh recency: a busy site's key should not be evicted by a burst
          // of one-off probes.
          cache.delete(trackingKey)
          cache.set(trackingKey, cached)
          return cached.value
        }
        cache.delete(trackingKey)
      }

      const resolved = await resolveIngestConfig(options.db, trackingKey)
      let value: CachedIngestConfig | null = null
      if (resolved !== null) {
        value = {
          config: resolved.config,
          settings: resolved.settings,
          slug: resolved.slug,
          noCodeRules: resolved.noCodeRules,
          exclusions: compiledFor(
            resolved.config.siteId,
            resolved.config.configVersion,
            resolved.exclusions,
          ),
        }
        if (options.decorate) value = await options.decorate(value)
      }

      remember(trackingKey, value)
      return value
    },

    invalidate(trackingKey: string): void {
      cache.delete(trackingKey)
    },
  }
}

/**
 * Project a resolved site onto the public `TrackerConfig` response.
 *
 * `config_version` comes from the site row, so a dashboard change moves the
 * ETag, the browser's HTTP-cached copy and the tracker's local copy together
 * (ADR-0008, ADR-0034 D4).
 *
 * `no_code_rules` carries the site's published rules (ADR-0034). It was an
 * empty array from M4 until M13, which is what migration 0014 promised.
 */
export function toTrackerConfig(resolved: CachedIngestConfig): TrackerConfig {
  const rules = resolved.noCodeRules
  return {
    config_version: resolved.config.configVersion,
    site_timezone: resolved.settings.timezone,
    allowed_domains: [...resolved.config.allowedDomains],
    redact_query_keys: [...resolved.settings.redactQueryKeys],
    interaction_sampling: resolved.settings.interactionSampling,
    heartbeat_interval_seconds: resolved.settings.heartbeatIntervalSeconds,
    features: { ...resolved.settings.features },
    attributed_revenue: resolved.settings.attributedRevenue,
    no_code_rules: rules.map((rule) => ({
      rule_id: rule.rule_id,
      name: rule.name,
      version: rule.version,
      trigger: rule.trigger,
      ...(rule.selector === undefined ? {} : { selector: rule.selector }),
      ...(rule.url_pattern === undefined ? {} : { url_pattern: rule.url_pattern }),
      ...(rule.properties === undefined
        ? {}
        : {
            properties: rule.properties.map((property) => ({
              key: property.key,
              source: property.source as 'text',
              ...(property.argument === undefined ? {} : { argument: property.argument }),
            })),
          }),
    })),
  }
}

/**
 * The M4 `TrackerConfigStore` port, backed by the same cache the ingest path
 * uses.
 *
 * Sharing the cache is the point: the config endpoint and the event endpoint ask
 * the same question about the same key, and two caches would let a revoked key
 * keep working on one of them after it stopped working on the other.
 */
export interface TrackerConfigStoreOptions {
  /**
   * The hosted `admitSuspended` verdict (the cloud extension's own), consulted
   * before configuration is served to a suspended site. Absent — a self-hosted
   * build — a suspended site gets no configuration, which matches what its
   * events get (`SITE_NOT_FOUND`).
   */
  readonly admitSuspended?: (input: {
    readonly config: SiteIngestConfig
    readonly facts: CloudIngestFacts
    readonly now: Date
  }) => { readonly admitted: boolean }
  /**
   * Whether the site's plan window is spent (ADR-0074, amendment 2). `true`
   * stamps `collection_paused` into the served configuration — the light the
   * tracker reads instead of finding out one refused batch at a time.
   */
  readonly collectionPaused?: (input: {
    readonly config: SiteIngestConfig
    readonly facts: CloudIngestFacts
    readonly now: Date
  }) => Promise<boolean>
  readonly now?: () => number
}

export function createTrackerConfigStore(
  store: IngestConfigStore,
  options: TrackerConfigStoreOptions = {},
): TrackerConfigStore {
  const now = options.now ?? Date.now

  const liveResolved = async (trackingKey: string): Promise<CachedIngestConfig | null> => {
    const resolved = await store.resolve(trackingKey)
    if (resolved === null) return null

    // A site being deleted answers as if it did not exist, matching what the
    // ingest path does with the same key (D-210). Serving configuration for a
    // site whose data is being erased would have the tracker keep collecting
    // into a fence it can no longer cross.
    if (resolved.config.status === 'deleting' || resolved.config.status === 'deleted') {
      return null
    }

    // A suspended site serves configuration only while its events are still
    // admitted — the hosted grace window (D-012/D-013), decided by the same
    // extension verdict the event path uses. Past the grace this answers 404,
    // and that 404 is load-bearing: it is what arms the tracker's stand-down
    // (ADR-0074 amendment). Before this check, a lapsed-trial site's config
    // stayed 200 while its events answered 402 forever, so the tracker of a
    // large lapsed site kept knocking at full pageview rate for the whole
    // suspended period — the parasitic-load failure mode ADR-0074 closed for
    // deleted and key-expired sites, still open through this door. Resumption
    // needs no push: reactivation bumps `config_version`, and the stand-down
    // marker re-probes within its own TTL.
    if (resolved.config.status === 'suspended') {
      const facts = resolved.cloud
      if (options.admitSuspended === undefined || facts === undefined) return null
      const verdict = options.admitSuspended({
        config: resolved.config,
        facts,
        now: new Date(now()),
      })
      if (!verdict.admitted) return null
    }
    return resolved
  }

  return {
    async find(trackingKey: string): Promise<TrackerConfigRecord | null> {
      const resolved = await liveResolved(trackingKey)
      if (resolved === null) return null

      // Stamped only when true, so an active site's body and ETag are
      // byte-identical to what they were before the field existed. The catch
      // is the same fail-open as the gate's own counter read: a config the
      // usage store cannot answer serves as collecting.
      let paused = false
      if (options.collectionPaused !== undefined && resolved.cloud !== undefined) {
        paused = await options
          .collectionPaused({
            config: resolved.config,
            facts: resolved.cloud,
            now: new Date(now()),
          })
          .catch(() => false)
      }

      return {
        siteId: resolved.config.siteId,
        config: { ...toTrackerConfig(resolved), ...(paused ? { collection_paused: true } : {}) },
      }
    },
  }
}
