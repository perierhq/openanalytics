import {
  createIngestConfigStore,
  createTrackerConfigStore,
  toTrackerConfig,
  type CachedIngestConfig,
} from '../../apps/collector/src/index.ts'
import {
  DEFAULT_TRACKER_SETTINGS,
  EMPTY_INGEST_EXCLUSIONS,
  compileIngestExclusions,
  loadPolicy,
  type IngestExclusions,
  type SiteIngestConfig,
  type SiteState,
} from '@openanalytics/domain'
import { trackerConfigSchema } from '@openanalytics/contracts'
import type { Database } from '@openanalytics/postgres'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The collector's short-TTL, versioned ingest-config cache (docs snapshot 02
 * §7.2; plan 04 Milestone 5 item 11).
 *
 * §7.2 permits this cache in one sentence and constrains it in the next: a
 * short, versioned site-config cache may be used while Postgres is unreachable,
 * but "an expired or revoked key is never accepted fail-open". The
 * tests below are that pair — the cache exists to spare a round trip, and it may
 * never be the reason a dead key still works.
 */

const POLICY = loadPolicy({})

const siteConfig = (overrides: Partial<SiteIngestConfig> = {}): SiteIngestConfig => ({
  siteId: 'site-1',
  status: 'active',
  ingestGeneration: 1,
  configVersion: 4,
  billingUserId: 'user-1',
  billingAssignmentVersion: 2,
  keyExpiresAt: null,
  allowedDomains: ['shop.example.com'],
  ...overrides,
})

const resolved = (overrides: Partial<SiteIngestConfig> = {}): CachedIngestConfig => ({
  config: siteConfig(overrides),
  settings: DEFAULT_TRACKER_SETTINGS,
  slug: 'shop',
  noCodeRules: [],
  exclusions: compileIngestExclusions(EMPTY_INGEST_EXCLUSIONS),
})

/** What `resolveIngestConfig` itself answers: the exclusions as stored. */
const fromPostgres = (
  overrides: Partial<SiteIngestConfig> = {},
  exclusions: IngestExclusions = EMPTY_INGEST_EXCLUSIONS,
) => ({
  config: siteConfig(overrides),
  settings: DEFAULT_TRACKER_SETTINGS,
  slug: 'shop',
  noCodeRules: [],
  exclusions,
})

/**
 * The store's only dependency is `resolveIngestConfig`, which it calls with the
 * database handle. Mocking the module keeps this a unit test — what is under
 * test is the caching policy, not the SQL, which has its own migration suite.
 */
const resolveIngestConfig = vi.hoisted(() => vi.fn())
vi.mock('@openanalytics/postgres', () => ({ resolveIngestConfig }))

const db = {} as Database

describe('ingest config store', () => {
  let clock: number

  beforeEach(() => {
    clock = 1_000_000
    resolveIngestConfig.mockReset()
  })

  const store = (maxEntries?: number) =>
    createIngestConfigStore({
      db,
      policy: POLICY,
      now: () => clock,
      ...(maxEntries === undefined ? {} : { maxEntries }),
    })

  it('compiles exclusions once per config version, not once per read', async () => {
    const office = { ...EMPTY_INGEST_EXCLUSIONS, ipRanges: ['203.0.113.0/24'] }
    resolveIngestConfig.mockResolvedValue(fromPostgres({ configVersion: 4 }, office))
    const cache = store()

    const first = await cache.resolve('oa_pk_live')
    expect(first?.exclusions.matchesIp('203.0.113.9')).toBe(true)

    // The TTL lapses and the row is re-read, but the version has not moved:
    // the compiled matcher is the same object, not a recompilation.
    clock += POLICY.INGEST_CONFIG_CACHE_TTL_SECONDS * 1000 + 1
    const second = await cache.resolve('oa_pk_live')
    expect(resolveIngestConfig).toHaveBeenCalledTimes(2)
    expect(second?.exclusions).toBe(first?.exclusions)

    // A settings write moves the version, and the new lists take effect.
    resolveIngestConfig.mockResolvedValue(
      fromPostgres({ configVersion: 5 }, { ...EMPTY_INGEST_EXCLUSIONS, paths: ['/admin/*'] }),
    )
    clock += POLICY.INGEST_CONFIG_CACHE_TTL_SECONDS * 1000 + 1
    const third = await cache.resolve('oa_pk_live')
    expect(third?.exclusions).not.toBe(first?.exclusions)
    expect(third?.exclusions.matchesIp('203.0.113.9')).toBe(false)
    expect(third?.exclusions.matchesPath('/admin/x')).toBe(true)
  })

  it('never puts exclusions in the configuration a browser is served', async () => {
    // An office address range is the site's business, not something to publish
    // to every visitor through the public tracker config.
    resolveIngestConfig.mockResolvedValue(
      fromPostgres(
        {},
        {
          ipRanges: ['203.0.113.0/24'],
          paths: ['/secret-admin/*'],
          countries: ['DE'],
          hostnames: ['hidden-staging.example.com'],
        },
      ),
    )
    const found = await store().resolve('oa_pk_live')
    const served = JSON.stringify(toTrackerConfig(found as CachedIngestConfig))
    for (const secret of ['203.0.113', 'secret-admin', 'hidden-staging', 'exclu']) {
      expect(served).not.toContain(secret)
    }
  })

  it('resolves through to Postgres on a miss', async () => {
    resolveIngestConfig.mockResolvedValue(fromPostgres())

    const found = await store().resolve('oa_pk_live')

    expect(found?.config.siteId).toBe('site-1')
    expect(resolveIngestConfig).toHaveBeenCalledTimes(1)
  })

  it('serves a second request from the cache', async () => {
    // The reason the cache exists: the collector reaches Postgres over the
    // public internet, so a per-event round trip would dominate the latency of
    // accepting an event.
    resolveIngestConfig.mockResolvedValue(fromPostgres())
    const cache = store()

    await cache.resolve('oa_pk_live')
    await cache.resolve('oa_pk_live')

    expect(resolveIngestConfig).toHaveBeenCalledTimes(1)
  })

  it('re-reads once the TTL has passed', async () => {
    resolveIngestConfig.mockResolvedValue(fromPostgres())
    const cache = store()

    await cache.resolve('oa_pk_live')
    clock += POLICY.INGEST_CONFIG_CACHE_TTL_SECONDS * 1000 + 1
    await cache.resolve('oa_pk_live')

    expect(resolveIngestConfig).toHaveBeenCalledTimes(2)
  })

  it('remembers a miss, so a flood of invalid keys is not a flood of queries', async () => {
    // Without negative caching, spraying random keys at the endpoint is the
    // cheapest possible denial of service against the collector's database.
    resolveIngestConfig.mockResolvedValue(null)
    const cache = store()

    expect(await cache.resolve('oa_pk_nope')).toBeNull()
    expect(await cache.resolve('oa_pk_nope')).toBeNull()

    expect(resolveIngestConfig).toHaveBeenCalledTimes(1)
  })

  it('forgets a miss sooner than a hit', async () => {
    // A key created a moment ago, or a deploy racing a rotation, is a transient
    // miss. Holding it for the full TTL would keep a live site dark.
    resolveIngestConfig.mockResolvedValue(null)
    const cache = store()

    await cache.resolve('oa_pk_new')
    clock += (POLICY.INGEST_CONFIG_CACHE_TTL_SECONDS * 1000) / 2
    await cache.resolve('oa_pk_new')

    expect(resolveIngestConfig).toHaveBeenCalledTimes(2)
  })

  it('never lets a cached entry outlive the key it was resolved from', async () => {
    // The entry is still inside its TTL, but the key it carries has expired.
    // The expiry travels with the config for exactly this case, and
    // `decideIngestAdmission` is what refuses on it (02 §7.2).
    const keyExpiresAt = new Date(clock + 5_000)
    resolveIngestConfig.mockResolvedValue(fromPostgres({ keyExpiresAt }))
    const cache = store()

    await cache.resolve('oa_pk_expiring')
    clock += 10_000
    const cached = await cache.resolve('oa_pk_expiring')

    expect(resolveIngestConfig).toHaveBeenCalledTimes(1)
    expect(cached?.config.keyExpiresAt).toEqual(keyExpiresAt)
  })

  it('drops an entry on demand', async () => {
    resolveIngestConfig.mockResolvedValue(fromPostgres())
    const cache = store()

    await cache.resolve('oa_pk_live')
    cache.invalidate('oa_pk_live')
    await cache.resolve('oa_pk_live')

    expect(resolveIngestConfig).toHaveBeenCalledTimes(2)
  })

  it('bounds its size, evicting the least recently used key', async () => {
    resolveIngestConfig.mockImplementation((_db: unknown, key: string) =>
      Promise.resolve(fromPostgres({ siteId: `site-${key}` })),
    )
    const cache = store(2)

    await cache.resolve('a')
    await cache.resolve('b')
    // Touching 'a' makes 'b' the least recently used, so 'c' evicts 'b'.
    await cache.resolve('a')
    await cache.resolve('c')

    resolveIngestConfig.mockClear()
    await cache.resolve('a')
    expect(resolveIngestConfig, 'a was touched and should still be cached').not.toHaveBeenCalled()
    await cache.resolve('b')
    expect(
      resolveIngestConfig,
      'b was the least recently used and should be gone',
    ).toHaveBeenCalled()
  })
})

describe('tracker config projection', () => {
  beforeEach(() => {
    resolveIngestConfig.mockReset()
  })

  it('produces a response the published contract accepts', () => {
    const config = toTrackerConfig(resolved())

    expect(() => trackerConfigSchema.parse(config)).not.toThrow()
    expect(config.config_version).toBe(4)
    expect(config.allowed_domains).toEqual(['shop.example.com'])
    // The dashboard rule builder is M13. An empty list is the honest answer;
    // omitting the field would fail the contract's strict schema.
    expect(config.no_code_rules).toEqual([])
  })

  it('carries no credential of any kind', () => {
    // ADR-0008: the config response is configuration, never data, and is never
    // read authorization. The tracking key must not come back out of it.
    const serialized = JSON.stringify(toTrackerConfig(resolved()))
    expect(serialized).not.toContain('oa_pk')
    expect(serialized).not.toContain('site-1')
  })

  it('answers nothing for an unknown key', async () => {
    resolveIngestConfig.mockResolvedValue(null)
    const store = createTrackerConfigStore(createIngestConfigStore({ db, policy: POLICY }))

    expect(await store.find('oa_pk_nope')).toBeNull()
  })

  it.each(['deleting', 'deleted'] as const)('answers nothing for a %s site', async (status) => {
    // D-210: the same key that no longer ingests must not still hand out
    // configuration, or the tracker keeps collecting into a fence it cannot
    // cross.
    resolveIngestConfig.mockResolvedValue(fromPostgres({ status: status as SiteState }))
    const store = createTrackerConfigStore(createIngestConfigStore({ db, policy: POLICY }))

    expect(await store.find('oa_pk_live')).toBeNull()
  })

  // This block replaced "serves a billing-blocked site, because configuration
  // is not entitlement". That test's premise — the tracker still needs its
  // settings while it retries — was false twice over: the tracker never
  // retries a 402, and a 200 config is exactly what kept a lapsed site's
  // tracker knocking at full pageview rate for its whole suspension (ADR-0074
  // amendment). Configuration now stops when admission stops.
  // The facts arrive the way they do in production: through `decorate`, which
  // is what attaches `cloud` to the cached entry on a miss.
  const decorated = () =>
    createIngestConfigStore({
      db,
      policy: POLICY,
      decorate: (entry) => Promise.resolve({ ...entry, cloud: {} as never }),
    })

  it('keeps serving a suspended site while its grace window still admits events', async () => {
    resolveIngestConfig.mockResolvedValue(fromPostgres({ status: 'suspended' }))
    const store = createTrackerConfigStore(decorated(), {
      admitSuspended: () => ({ admitted: true }),
    })

    const record = await store.find('oa_pk_live')
    expect(record?.siteId).toBe('site-1')
  })

  it('answers nothing for a suspended site whose grace is spent — the 404 that stands the tracker down', async () => {
    resolveIngestConfig.mockResolvedValue(fromPostgres({ status: 'suspended' }))
    const store = createTrackerConfigStore(decorated(), {
      admitSuspended: () => ({ admitted: false }),
    })

    expect(await store.find('oa_pk_live')).toBeNull()
  })

  it('stamps the paused light when the extension says the window is spent (ADR-0074 am. 2)', async () => {
    resolveIngestConfig.mockResolvedValue(fromPostgres())
    const store = createTrackerConfigStore(decorated(), {
      collectionPaused: () => Promise.resolve(true),
    })

    const record = await store.find('oa_pk_live')
    expect(record?.config.collection_paused).toBe(true)
  })

  it('serves a byte-identical configuration while collecting — the field is absent, not false', async () => {
    resolveIngestConfig.mockResolvedValue(fromPostgres())
    const store = createTrackerConfigStore(decorated(), {
      collectionPaused: () => Promise.resolve(false),
    })

    const record = await store.find('oa_pk_live')
    expect(record?.config).not.toHaveProperty('collection_paused')
  })

  it('a failing usage read serves as collecting — G-005, fail open', async () => {
    resolveIngestConfig.mockResolvedValue(fromPostgres())
    const store = createTrackerConfigStore(decorated(), {
      collectionPaused: () => Promise.reject(new Error('counter down')),
    })

    const record = await store.find('oa_pk_live')
    expect(record?.config).not.toHaveProperty('collection_paused')
  })

  it('answers nothing for a suspended site with no hosted extension, matching the event path', async () => {
    // Self-hosted: suspended events answer SITE_NOT_FOUND, so configuration
    // answering 200 would be the two-endpoints-disagreeing state again.
    resolveIngestConfig.mockResolvedValue(fromPostgres({ status: 'suspended' }))
    const store = createTrackerConfigStore(createIngestConfigStore({ db, policy: POLICY }))

    expect(await store.find('oa_pk_live')).toBeNull()
  })
})
