import { createHmac } from 'node:crypto'
import type { Context } from 'hono'

/**
 * Where the request's network identity is read, and the only place a raw IP
 * exists (docs snapshot 02 §7.1 item 8; 05 D-102).
 *
 * The raw address is taken from the platform's headers, used to derive a geo
 * hint and a rate-limit bucket, and then discarded. It is never returned from
 * this module, never logged and never put on an event: `deriveVisitorContext`
 * takes it as an argument and gives back a structure with no field that could
 * hold one (ADR-0008), and `ClientIdentity` below has the same property.
 *
 * The IP is trusted only from headers the fronting proxy controls, never from
 * a client-settable one alone. `x-forwarded-for` is appended to by every hop,
 * so its *last* entry is the one the proxy observed; reading the first entry
 * would let a caller spoof their own rate-limit bucket by prepending an address.
 *
 * Since ADR-0015 the collector sits behind a reverse proxy of the deployment's
 * own, which asserts `X-Real-IP` from the connection and STRIPS every other
 * header in this list — on a platform nobody controls for us, a client could
 * simply send `fly-client-ip` and pick its own identity bucket. The list stays
 * so a future move back behind Vercel/Fly/Cloudflare is an env change, not a
 * code change; it is safe only while the fronting proxy removes what it does
 * not itself set.
 */

/**
 * Headers a fronting platform/proxy sets from the connection itself.
 */
const PLATFORM_IP_HEADERS = [
  // Set by our Caddy today (ADR-0015); by Vercel on its platform.
  'x-real-ip',
  // Fly.io — the build-phase host for the private-network services (D-217).
  'fly-client-ip',
  'cf-connecting-ip',
  'true-client-ip',
] as const

const PLATFORM_COUNTRY_HEADERS = ['x-vercel-ip-country', 'fly-client-country', 'cf-ipcountry']
const PLATFORM_CITY_HEADERS = ['x-vercel-ip-city', 'cf-ipcity']

function forwardedForAddress(header: string | undefined): string | null {
  if (!header) return null
  const parts = header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  // The rightmost entry is the address the closest trusted proxy observed.
  // Taking the leftmost would take whatever the client chose to write.
  return parts.at(-1) ?? null
}

/**
 * Everything derived from the request's network identity, with nowhere to put an
 * address.
 *
 * `ipHash` is a rate-limit bucket, not an identifier: it is an HMAC under the
 * same rotating secret as the anonymous identity, so it cannot be reversed into
 * an address and cannot be correlated with a bucket from another day.
 */
export interface ClientIdentity {
  readonly ipHash: string
  readonly country: string | null
  /**
   * Where `country` came from: a platform header (`x-vercel-ip-country`,
   * `fly-client-country`, `cf-ipcountry`) or this collector's own GeoIP
   * database. A header is believed only because the fronting proxy is expected
   * to strip what it does not set itself; nothing here can tell whether one
   * did, so only `database` is evidence this install resolves countries.
   */
  readonly countrySource: 'platform' | 'database' | null
  readonly city: string | null
  /** True when no address could be read; geo and bucketing degrade, not fail. */
  readonly degraded: boolean
}

export interface ClientIdentityOptions {
  readonly secret: string
  readonly keyVersion: number
  /** UTC date, so a bucket rotates daily like the identity it sits beside. */
  readonly utcDate: string
}

export function normalizeCountry(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().toUpperCase()
  // Two letters or nothing: `XX` and `T1` are placeholders some platforms send
  // for an unknown or Tor-exit address, and storing them as a country would put
  // a fake nation in every customer's dashboard.
  if (!/^[A-Z]{2}$/.test(trimmed) || trimmed === 'XX' || trimmed === 'T1') return null
  return trimmed
}

/**
 * Reads the client address, derives what the collector is allowed to keep, and
 * drops the address.
 *
 * Returns `degraded: true` when no address is available rather than throwing:
 * docs snapshot 02 §7.2 accepts an event with minimal valid context and raises a
 * degradation metric — losing an event because a geo lookup failed would be the
 * legacy behaviour inverted.
 */
export function readClientIdentity(
  c: Context,
  options: ClientIdentityOptions,
  geo?: (address: string) => { country: string | null; city: string | null } | null,
): ClientIdentity {
  let address: string | null = null
  for (const header of PLATFORM_IP_HEADERS) {
    const value = c.req.header(header)?.trim()
    if (value) {
      address = value
      break
    }
  }
  address ??= forwardedForAddress(c.req.header('x-forwarded-for'))

  let country =
    PLATFORM_COUNTRY_HEADERS.map((header) => normalizeCountry(c.req.header(header))).find(
      (value) => value !== null,
    ) ?? null
  let countrySource: ClientIdentity['countrySource'] = country === null ? null : 'platform'

  let city =
    PLATFORM_CITY_HEADERS.map((header) => c.req.header(header)?.trim())
      .find((value) => value !== undefined && value !== '')
      ?.slice(0, 64) ?? null

  // Platform headers win when a platform provides them; the local database
  // fills what is left (ADR-0015: on our own host nobody injects geo, so this
  // is the only source). The address is consumed here and discarded with the
  // rest of this function's locals.
  if (address !== null && geo !== undefined && (country === null || city === null)) {
    const hint = geo(address)
    if (hint !== null) {
      if (country === null && hint.country !== null) {
        country = hint.country
        countrySource = 'database'
      }
      city ??= hint.city
    }
  }

  if (address === null) {
    // A bucket every anonymous caller shares. Coarse on purpose: it still bounds
    // the damage one unidentifiable source can do, and it is not a visitor id.
    return {
      ipHash: hashAddress('unknown', options),
      country,
      countrySource,
      city,
      degraded: true,
    }
  }

  return { ipHash: hashAddress(address, options), country, countrySource, city, degraded: false }
}

/**
 * The rate-limit bucket for an address.
 *
 * Hex-encoded and truncated: the full digest is 64 characters in every Valkey
 * key that mentions it, and 32 bits of collision headroom is far more than a
 * per-site, per-minute counter needs. Keyed by the UTC date so a bucket cannot
 * be correlated across days.
 */
export function hashAddress(address: string, options: ClientIdentityOptions): string {
  return createHmac('sha256', options.secret)
    .update(`ratelimit\n${options.keyVersion}\n${options.utcDate}\n${address.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 32)
}

/**
 * The raw address, for the one caller that legitimately needs it: the D-102
 * identity derivation, which consumes it and returns a structure without it.
 *
 * Separate from `readClientIdentity` so that every call site handling a raw
 * address is greppable, and named so that a reviewer sees what it is.
 */
export function readRawClientAddress(c: Context): string | null {
  for (const header of PLATFORM_IP_HEADERS) {
    const value = c.req.header(header)?.trim()
    if (value) return value
  }
  return forwardedForAddress(c.req.header('x-forwarded-for'))
}
