import {
  BUMP_EPOCH_SCRIPT,
  GEO_RESOLVED_KEY,
  GEO_RESOLVED_TTL_SECONDS,
  INCREMENT_WINDOWS_SCRIPT,
  InvalidKeyComponentError,
  REALTIME_EPOCH_TTL_MS,
  REALTIME_SITE_EPOCH_SUBJECT,
  QueueConnectionError,
  RATE_LIMIT_WINDOW_TTL_SECONDS,
  RECORD_TAG_SIGHTING_SCRIPT,
  TAG_SIGHTING_MAX_ORIGINS,
  TAG_SIGHTING_ORIGIN_ABSENT,
  TAG_SIGHTING_TTL_SECONDS,
  botCounterKey,
  buildConnectionOptions,
  createRealtimeCache,
  dailyBillableKey,
  dailyCeilingKey,
  minuteBucketOf,
  rateLimitIdentityKey,
  rateLimitIpKey,
  rateLimitSiteKey,
  realtimeEpochKey,
  tagSightingKey,
  usageCounterKey,
  visitorPresenceKey,
  type RealtimeCacheOptions,
} from '@openanalytics/redis'
import { describe, expect, it } from 'vitest'

/**
 * Realtime-cache key naming and the counter script (docs snapshot 05, D-205,
 * G-005, D-103).
 *
 * The failures these guard against are all silent. A window key without a TTL is
 * a counter that never resets, which throttles a site forever. A usage counter
 * keyed differently from the one the worker reconciles is a limit check reading
 * a number nobody writes. And a bot counter keyed by the matched user agent is
 * unbounded cardinality plus visitor data in a store with no redaction.
 */

describe('realtime cache key naming', () => {
  const at = new Date('2026-07-23T12:34:56.789Z')

  it('buckets rate limits by the minute', () => {
    expect(minuteBucketOf(at)).toBe('2026-07-23T12:34')
    expect(rateLimitIpKey('site-1', 'iphash', '2026-07-23T12:34')).toBe(
      'rl_ip:site-1:iphash:2026-07-23T12:34',
    )
    expect(rateLimitIdentityKey('site-1', 'anon', '2026-07-23T12:34')).toBe(
      'rl_id:site-1:anon:2026-07-23T12:34',
    )
    expect(rateLimitSiteKey('site-1', '2026-07-23T12:34')).toBe('rl_site:site-1:2026-07-23T12:34')
  })

  it('keeps a window key alive one minute past its window', () => {
    // Expiring exactly on the minute would let a caller reset their own counter
    // by timing requests at :59 — and a request arriving at the boundary still
    // has to read the bucket it is leaving.
    expect(RATE_LIMIT_WINDOW_TTL_SECONDS).toBe(120)
  })

  it('separates the daily ceiling from the daily billable count', () => {
    // G-005's ceiling counts every accepted event; the rapid-burn notice counts
    // billable ones against a monthly limit. One counter could not answer both.
    expect(dailyCeilingKey('site-1', '2026-07-23')).toBe('site_day_events:site-1:2026-07-23')
    expect(dailyBillableKey('site-1', '2026-07-23')).toBe('site_day_billable:site-1:2026-07-23')
  })

  it('keys the usage counter the way usage_windows is keyed', () => {
    // (user_id, starts_at) is the unique constraint in migration 0011. The
    // collector cannot mint the window's row id without writing to Postgres, so
    // the natural key is what lets the worker reconcile onto the same counter
    // the collector was reading.
    expect(usageCounterKey('user-1', new Date('2026-07-01T00:00:00.000Z'))).toBe(
      'usage_window:user-1:2026-07-01T00:00:00.000Z',
    )
  })

  it('names the bot counter by rule, never by user agent', () => {
    expect(botCounterKey('site-1', '2026-07-23', 'googlebot')).toBe(
      'sec_bot:site-1:2026-07-23:googlebot',
    )
    // A raw user agent could not be a key component even if someone tried.
    expect(() => botCounterKey('site-1', '2026-07-23', 'Mozilla/5.0 (compatible)')).toThrow(
      InvalidKeyComponentError,
    )
  })

  it('refuses an identifier that could address another site key', () => {
    expect(() => rateLimitSiteKey('site:1', '2026-07-23T12:34')).toThrow(InvalidKeyComponentError)
    expect(() => visitorPresenceKey('')).toThrow(InvalidKeyComponentError)
  })
})

describe('counter script', () => {
  it('sets a TTL when the key is created', () => {
    // Without this every counter is a total rather than a window, and a site
    // that once hit its daily ceiling never ingests again.
    expect(INCREMENT_WINDOWS_SCRIPT).toContain("redis.call('INCRBY', KEYS[i], increment)")
    expect(INCREMENT_WINDOWS_SCRIPT).toContain("redis.call('EXPIRE', KEYS[i], ttl_seconds)")
  })

  it('repairs a key that lost its expiry rather than leaving it immortal', () => {
    expect(INCREMENT_WINDOWS_SCRIPT).toContain("redis.call('TTL', KEYS[i]) < 0")
  })

  it('does not extend a window that is already running', () => {
    // The TTL is set on creation only. Refreshing it on every increment would
    // make a busy site's window slide forward forever and never reset.
    expect(INCREMENT_WINDOWS_SCRIPT).toContain('if value == increment or')
  })
})

describe('access epochs (D-213, ADR-0030 D5)', () => {
  it('reserves the subject `site` for the site-level epoch', () => {
    // The per-subject epoch cuts one member's streams. `site` is the one that
    // cuts every stream on a site, which is what a block and a deletion start
    // need. It cannot collide with a real subject: those are user UUIDs or the
    // literal `public`.
    expect(REALTIME_SITE_EPOCH_SUBJECT).toBe('site')
    expect(realtimeEpochKey('site-1', REALTIME_SITE_EPOCH_SUBJECT)).toBe('rt_epoch:site-1:site')
  })

  it('bumps and expires the epoch key in one script', () => {
    // The keys were immortal before this — one integer per (site, subject)
    // forever, including for members removed long ago. The PEXPIRE is inside the
    // script rather than a second round trip: a bump that created the key and
    // then failed to set its TTL would leave exactly the immortal key the TTL
    // exists to stop.
    expect(BUMP_EPOCH_SCRIPT).toContain("redis.call('INCR', KEYS[1])")
    expect(BUMP_EPOCH_SCRIPT).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[2])")
    // Expiry is fail-closed by construction: a missing epoch reads as
    // `auth_unreachable` at the gateway and the next mint re-seeds it.
    expect(REALTIME_EPOCH_TTL_MS).toBe(30 * 86_400_000)
  })

  it('publishes the new epoch with its subject, so a gateway can match it', () => {
    expect(BUMP_EPOCH_SCRIPT).toContain('"subject":"')
    expect(BUMP_EPOCH_SCRIPT).toContain('"epoch":')
  })
})

describe('realtime-cache connection (D-206)', () => {
  it('requires TLS and AUTH, like the queue hop', () => {
    // The state is losable; the credential protecting it is not. Both hops leave
    // Vercel for the public internet (D-208).
    expect(() =>
      buildConnectionOptions({ mode: 'realtime-cache', url: 'redis://cache.example.com:6379' }),
    ).toThrow(QueueConnectionError)

    expect(() =>
      buildConnectionOptions({ mode: 'realtime-cache', url: 'rediss://cache.example.com:6379' }),
    ).toThrow(QueueConnectionError)

    const options = buildConnectionOptions({
      mode: 'realtime-cache',
      url: 'rediss://default:secret@cache.example.com:6379',
    })
    expect(options.tls).toEqual({ servername: 'cache.example.com' })
  })
})

/**
 * Tag sightings (ADR-0081, D2).
 *
 * The failure modes are the same shape as the rest of this file's: silent. A
 * hash without a TTL is a permanent record of where a key was pasted; an
 * uncapped hash is a place anyone holding the write-only tracking key can write
 * to; and a read that fails on one malformed field hides the nineteen good ones
 * from the exact screen that exists to explain why nothing is arriving.
 */
describe('tag sightings', () => {
  const SITE = 'site-1'
  const AT = new Date('2026-09-14T10:00:00.000Z')

  /**
   * A Valkey stand-in recording the two calls this family makes.
   *
   * The script itself is asserted as text below, the way `INCREMENT_WINDOWS_SCRIPT`
   * and `BUMP_EPOCH_SCRIPT` are: re-implementing `HEXISTS`/`HLEN` in JavaScript
   * would prove that the re-implementation caps, which is not the claim. What a
   * double can prove is the other half — that the cap and the TTL reach the
   * server at all, in one round trip, as that script's own arguments.
   */
  function fakeClient(hash: Record<string, string> = {}) {
    const evals: { script: string; numKeys: number; args: string[] }[] = []
    const hgetalls: string[] = []
    const client = {
      eval: async (script: string, numKeys: number, ...args: string[]) => {
        evals.push({ script, numKeys, args })
        return 1
      },
      hgetall: async (key: string) => {
        hgetalls.push(key)
        return hash
      },
    }
    return {
      evals,
      hgetalls,
      cache: createRealtimeCache({
        client: client as unknown as RealtimeCacheOptions['client'],
        eventMaxLatenessHours: 48,
      }),
    }
  }

  it('writes the origin, the instant and the verdict under the site key', async () => {
    const fake = fakeClient()
    await fake.cache.recordTagSighting({
      siteId: SITE,
      origin: 'http://localhost:3000',
      allowed: false,
      at: AT,
    })

    const call = fake.evals[0]
    expect(call?.numKeys).toBe(1)
    expect(call?.args[0]).toBe(tagSightingKey(SITE))
    expect(call?.args[1]).toBe('http://localhost:3000')
    // The verdict is stored, not recomputed on read: the allowlist can change
    // between the sighting and the screen, and the dashboard must never disagree
    // with the collector about whether an origin counts.
    expect(JSON.parse(call?.args[2] ?? 'null')).toEqual({
      at: '2026-09-14T10:00:00.000Z',
      allowed: false,
    })
  })

  it('carries the cap and the TTL into the same round trip as the write', async () => {
    const fake = fakeClient()
    await fake.cache.recordTagSighting({
      siteId: SITE,
      origin: TAG_SIGHTING_ORIGIN_ABSENT,
      allowed: true,
      at: AT,
    })

    const call = fake.evals[0]
    expect(call?.script).toBe(RECORD_TAG_SIGHTING_SCRIPT)
    expect(call?.args[3]).toBe(String(TAG_SIGHTING_MAX_ORIGINS))
    expect(call?.args[4]).toBe(String(TAG_SIGHTING_TTL_SECONDS))
    // A day, and one key per site rather than per origin — which is what lets
    // this be a cache key with no purge behind it (ADR-0081, D6).
    expect(TAG_SIGHTING_TTL_SECONDS).toBe(86_400)
    expect(TAG_SIGHTING_MAX_ORIGINS).toBe(20)
  })

  it('caps new origins inside the script, and only new ones', () => {
    // `HLEN` and `HSET` in two round trips would make the cap decorative: twenty
    // concurrent fetches from twenty new origins would each read a length under
    // the cap and each write.
    expect(RECORD_TAG_SIGHTING_SCRIPT).toContain(
      "redis.call('HEXISTS', KEYS[1], field) == 0 and redis.call('HLEN', KEYS[1]) >= max_origins",
    )
    // An origin already recorded is always updated, so a site that reached the
    // cap keeps reporting fresh instants for the installs it knows about.
    expect(RECORD_TAG_SIGHTING_SCRIPT).toContain("redis.call('HSET', KEYS[1], field, value)")
  })

  it('refreshes the expiry on every write, and never on a refused one', () => {
    // The EXPIRE sits after the cap's early return: a stream of unknown origins
    // must not be able to keep a full hash alive forever without adding a fact
    // to it, and a write that does land must restart the 24 hours.
    const refusal = RECORD_TAG_SIGHTING_SCRIPT.indexOf('return 0')
    const expire = RECORD_TAG_SIGHTING_SCRIPT.indexOf("redis.call('EXPIRE', KEYS[1], ttl_seconds)")
    expect(refusal).toBeGreaterThan(0)
    expect(expire).toBeGreaterThan(refusal)
  })

  it('reads the site hash newest first', async () => {
    const fake = fakeClient({
      'https://staging.example.com': '{"at":"2026-09-14T09:00:00.000Z","allowed":false}',
      'https://shop.example.com': '{"at":"2026-09-14T11:30:00.000Z","allowed":true}',
      'http://localhost:3000': '{"at":"2026-09-14T10:00:00.000Z","allowed":false}',
    })

    const sightings = await fake.cache.readTagSightings({ siteId: SITE })

    expect(fake.hgetalls).toEqual([tagSightingKey(SITE)])
    // The screens render "the newest sighting", so the order is the answer
    // rather than a presentation detail — a hash has none of its own.
    expect(sightings.map((sighting) => sighting.origin)).toEqual([
      'https://shop.example.com',
      'http://localhost:3000',
      'https://staging.example.com',
    ])
    expect(sightings[0]).toEqual({
      origin: 'https://shop.example.com',
      at: '2026-09-14T11:30:00.000Z',
      allowed: true,
    })
  })

  it('skips a malformed entry rather than failing the whole read', async () => {
    const fake = fakeClient({
      'https://good.example.com': '{"at":"2026-09-14T10:00:00.000Z","allowed":true}',
      'https://not-json.example.com': 'not json at all',
      'https://no-instant.example.com': '{"allowed":true}',
      'https://unparseable-instant.example.com': '{"at":"whenever","allowed":true}',
      'https://no-verdict.example.com': '{"at":"2026-09-14T10:00:00.000Z"}',
      'https://not-an-object.example.com': '42',
    })

    // One unreadable value must not hide the ones that would have told the
    // developer what they need to know; and an entry with no orderable instant
    // can never be "the newest sighting", which is all the screens read.
    expect(await fake.cache.readTagSightings({ siteId: SITE })).toEqual([
      { origin: 'https://good.example.com', at: '2026-09-14T10:00:00.000Z', allowed: true },
    ])
  })

  it('reports an empty hash as an empty list, which is a measurement', async () => {
    // Never `null` from here: "the cache was read and nothing has loaded the
    // tag" is a fact this method is allowed to state. A failed read throws
    // instead, and the api decides what "not computed" looks like on its own
    // contract (ADR-0081, D3).
    const fake = fakeClient({})
    expect(await fake.cache.readTagSightings({ siteId: SITE })).toEqual([])
  })

  it('keys the hash by site alone, so an origin can never name a key', () => {
    expect(tagSightingKey('site-1')).toBe('tag_sighting:site-1')
    expect(() => tagSightingKey('site:1')).toThrow(InvalidKeyComponentError)
  })
})

describe('the geo-resolved signal (server-side exclusions)', () => {
  const AT = new Date('2026-11-16T10:00:00.000Z')

  function fakeClient(stored: string | null = null) {
    const sets: unknown[][] = []
    const gets: string[] = []
    const client = {
      set: async (...args: unknown[]) => {
        sets.push(args)
        return 'OK'
      },
      get: async (key: string) => {
        gets.push(key)
        return stored
      },
    }
    return {
      sets,
      gets,
      cache: createRealtimeCache({
        client: client as unknown as RealtimeCacheOptions['client'],
        eventMaxLatenessHours: 48,
      }),
    }
  }

  it('records when a country was last resolved, and nothing else', async () => {
    const fake = fakeClient()
    await fake.cache.markGeoResolved({ at: AT })
    // One deployment-wide key holding an instant: no site, no address and no
    // country, so it says "this install resolves countries" and nothing more.
    expect(fake.sets).toEqual([
      [GEO_RESOLVED_KEY, '2026-11-16T10:00:00.000Z', 'EX', GEO_RESOLVED_TTL_SECONDS],
    ])
    expect(GEO_RESOLVED_TTL_SECONDS).toBe(7 * 86_400)
  })

  it('reads the instant back, or null when no country was resolved recently', async () => {
    expect(await fakeClient('2026-11-16T10:00:00.000Z').cache.readGeoResolvedAt()).toBe(
      '2026-11-16T10:00:00.000Z',
    )
    expect(await fakeClient(null).cache.readGeoResolvedAt()).toBeNull()
  })
})
