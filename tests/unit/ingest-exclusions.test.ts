import {
  EMPTY_INGEST_EXCLUSIONS,
  INGEST_EXCLUSION_LIMITS,
  compileIngestExclusions,
  exclusionHostnameMatches,
  normalizeExclusionCountry,
  normalizeExclusionHostname,
  normalizeExclusionIpRange,
  normalizeExclusionPath,
  normalizeIngestExclusions,
  type IngestExclusions,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * Server-side exclusions: the pure half.
 *
 * Normalisation decides what may be stored; the compiled matcher decides what
 * the collector drops. Both live in the domain so the API, which validates, and
 * the collector, which matches, cannot disagree about what `10.0.0.0/8` or
 * `/admin/*` means.
 */

const exclusions = (overrides: Partial<IngestExclusions> = {}): IngestExclusions => ({
  ...EMPTY_INGEST_EXCLUSIONS,
  ...overrides,
})

describe('normalizeExclusionIpRange', () => {
  it('turns a single IPv4 address into a /32', () => {
    expect(normalizeExclusionIpRange('203.0.113.7')).toBe('203.0.113.7/32')
    expect(normalizeExclusionIpRange('  203.0.113.7  ')).toBe('203.0.113.7/32')
  })

  it('keeps an IPv4 CIDR and clears the host bits', () => {
    expect(normalizeExclusionIpRange('10.0.0.0/8')).toBe('10.0.0.0/8')
    expect(normalizeExclusionIpRange('192.168.1.77/24')).toBe('192.168.1.0/24')
    expect(normalizeExclusionIpRange('0.0.0.0/0')).toBe('0.0.0.0/0')
  })

  it('turns a single IPv6 address into a /128 in its canonical spelling', () => {
    expect(normalizeExclusionIpRange('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1/128')
    expect(normalizeExclusionIpRange('::1')).toBe('::1/128')
  })

  it('keeps an IPv6 CIDR and clears the host bits', () => {
    expect(normalizeExclusionIpRange('2001:db8:abcd:12::1/48')).toBe('2001:db8:abcd::/48')
    expect(normalizeExclusionIpRange('2001:db8::/32')).toBe('2001:db8::/32')
  })

  it('stores an IPv4-mapped IPv6 address as the IPv4 address it is', () => {
    expect(normalizeExclusionIpRange('::ffff:198.51.100.4')).toBe('198.51.100.4/32')
    expect(normalizeExclusionIpRange('::ffff:198.51.100.0/120')).toBe('198.51.100.0/24')
  })

  it('refuses what is not an address or a range', () => {
    for (const bad of [
      '',
      'office',
      '10.0.0',
      '10.0.0.256',
      '10.0.0.1/33',
      '10.0.0.1/-1',
      '10.0.0.1/',
      '01.2.3.4',
      '2001:db8::1/129',
      '2001:db8:::1',
      '1:2:3:4:5:6:7:8:9',
      '10.0.0.0/8/8',
    ]) {
      expect(normalizeExclusionIpRange(bad), bad).toBeNull()
    }
  })
})

describe('normalizeExclusionPath', () => {
  it('keeps a path that starts with a slash', () => {
    expect(normalizeExclusionPath('/admin/*')).toBe('/admin/*')
    expect(normalizeExclusionPath(' /preview ')).toBe('/preview')
  })

  it('refuses a path without a leading slash, with a query or fragment, or too long', () => {
    expect(normalizeExclusionPath('admin')).toBeNull()
    expect(normalizeExclusionPath('/a?b=1')).toBeNull()
    expect(normalizeExclusionPath('/a#b')).toBeNull()
    expect(normalizeExclusionPath('/a b')).toBeNull()
    expect(
      normalizeExclusionPath(`/${'a'.repeat(INGEST_EXCLUSION_LIMITS.pathMaxLength)}`),
    ).toBeNull()
    expect(
      normalizeExclusionPath(`/${'a'.repeat(INGEST_EXCLUSION_LIMITS.pathMaxLength - 1)}`),
    ).not.toBeNull()
  })
})

describe('normalizeExclusionHostname', () => {
  it('lowercases a host and keeps a leading wildcard label', () => {
    expect(normalizeExclusionHostname('Staging.Example.com')).toBe('staging.example.com')
    expect(normalizeExclusionHostname('*.preview.example.com')).toBe('*.preview.example.com')
    expect(normalizeExclusionHostname('localhost')).toBe('localhost')
    expect(normalizeExclusionHostname('example.com.')).toBe('example.com')
  })

  it('refuses a scheme, a port, a path or a wildcard anywhere but the front', () => {
    for (const bad of [
      'https://example.com',
      'example.com:8080',
      'example.com/path',
      'staging.*.example.com',
      '*example.com',
      '*.',
      '',
      '-bad.example.com',
    ]) {
      expect(normalizeExclusionHostname(bad), bad).toBeNull()
    }
  })
})

describe('normalizeExclusionCountry', () => {
  it('uppercases a two-letter code', () => {
    expect(normalizeExclusionCountry('de')).toBe('DE')
    expect(normalizeExclusionCountry('US')).toBe('US')
  })

  it('refuses anything that is not two letters', () => {
    expect(normalizeExclusionCountry('DEU')).toBeNull()
    expect(normalizeExclusionCountry('Germany')).toBeNull()
    expect(normalizeExclusionCountry('1A')).toBeNull()
  })
})

describe('normalizeIngestExclusions', () => {
  it('normalises and de-duplicates every list', () => {
    const result = normalizeIngestExclusions({
      ip_ranges: ['10.0.0.1/8', '10.0.0.0/8', '2001:DB8::1'],
      paths: ['/admin/*', '/admin/*'],
      countries: ['de', 'DE'],
      hostnames: ['Staging.Example.com', 'staging.example.com'],
    })
    expect(result).toEqual({
      ok: true,
      exclusions: {
        ipRanges: ['10.0.0.0/8', '2001:db8::1/128'],
        paths: ['/admin/*'],
        countries: ['DE'],
        hostnames: ['staging.example.com'],
      },
    })
  })

  it('names the field and the entry that failed', () => {
    const result = normalizeIngestExclusions({
      ip_ranges: ['10.0.0.1', 'office'],
      paths: ['admin'],
      countries: ['Germany'],
      hostnames: ['https://x.com'],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toEqual([
      { field: 'exclusions.ip_ranges.1', code: 'invalid' },
      { field: 'exclusions.paths.0', code: 'invalid' },
      { field: 'exclusions.countries.0', code: 'invalid' },
      { field: 'exclusions.hostnames.0', code: 'invalid' },
    ])
  })

  it('refuses a list over its limit', () => {
    const result = normalizeIngestExclusions({
      ip_ranges: Array.from({ length: 51 }, (_, index) => `10.0.0.${index}`),
      paths: [],
      countries: [],
      hostnames: Array.from({ length: 21 }, (_, index) => `h${index}.example.com`),
    })
    expect(result).toEqual({
      ok: false,
      issues: [
        { field: 'exclusions.ip_ranges', code: 'too_many' },
        { field: 'exclusions.hostnames', code: 'too_many' },
      ],
    })
  })

  it('requires all four lists, because a write replaces the whole set', () => {
    expect(normalizeIngestExclusions({ ip_ranges: [] })).toEqual({
      ok: false,
      issues: [
        { field: 'exclusions.paths', code: 'required' },
        { field: 'exclusions.countries', code: 'required' },
        { field: 'exclusions.hostnames', code: 'required' },
      ],
    })
    expect(normalizeIngestExclusions([])).toEqual({
      ok: false,
      issues: [{ field: 'exclusions', code: 'not_an_object' }],
    })
    expect(
      normalizeIngestExclusions({
        ip_ranges: [],
        paths: [],
        countries: [],
        hostnames: [],
        cities: [],
      }),
    ).toEqual({ ok: false, issues: [{ field: 'exclusions.cities', code: 'unknown' }] })
  })
})

describe('the compiled IP matcher', () => {
  it('matches an IPv4 address inside a range and nothing outside it', () => {
    const compiled = compileIngestExclusions(exclusions({ ipRanges: ['203.0.113.0/24'] }))
    expect(compiled.matchesIp('203.0.113.7')).toBe(true)
    expect(compiled.matchesIp('203.0.113.255')).toBe(true)
    expect(compiled.matchesIp('203.0.114.1')).toBe(false)
  })

  it('matches a single address exactly', () => {
    const compiled = compileIngestExclusions(exclusions({ ipRanges: ['198.51.100.4/32'] }))
    expect(compiled.matchesIp('198.51.100.4')).toBe(true)
    expect(compiled.matchesIp('198.51.100.5')).toBe(false)
  })

  it('matches IPv6 ranges', () => {
    const compiled = compileIngestExclusions(exclusions({ ipRanges: ['2001:db8:abcd::/48'] }))
    expect(compiled.matchesIp('2001:db8:abcd:12::1')).toBe(true)
    expect(compiled.matchesIp('2001:DB8:ABCD:FFFF::')).toBe(true)
    expect(compiled.matchesIp('2001:db8:abce::1')).toBe(false)
    // An IPv4 address is never inside an IPv6 range that is not the mapped one.
    expect(compiled.matchesIp('10.0.0.1')).toBe(false)
  })

  it('treats an IPv4-mapped IPv6 client address as the IPv4 address', () => {
    const compiled = compileIngestExclusions(exclusions({ ipRanges: ['10.0.0.0/8'] }))
    expect(compiled.matchesIp('::ffff:10.1.2.3')).toBe(true)
    expect(compiled.matchesIp('::FFFF:0a01:0203')).toBe(true)
    expect(compiled.matchesIp('::ffff:11.1.2.3')).toBe(false)
  })

  it('reads the address forms proxies write, and never matches what it cannot read', () => {
    const compiled = compileIngestExclusions(
      exclusions({ ipRanges: ['10.0.0.0/8', '2001:db8::/32'] }),
    )
    expect(compiled.matchesIp('10.0.0.1:5123')).toBe(true)
    expect(compiled.matchesIp('[2001:db8::1]:443')).toBe(true)
    expect(compiled.matchesIp('fe80::1%eth0')).toBe(false)
    expect(compiled.matchesIp('garbage')).toBe(false)
    expect(compiled.matchesIp(null)).toBe(false)
  })
})

describe('the compiled path matcher', () => {
  it('is anchored at both ends', () => {
    const compiled = compileIngestExclusions(exclusions({ paths: ['/admin'] }))
    expect(compiled.matchesPath('/admin')).toBe(true)
    expect(compiled.matchesPath('/admin/users')).toBe(false)
    expect(compiled.matchesPath('/x/admin')).toBe(false)
  })

  it('lets * match any characters including slashes, and nothing', () => {
    const compiled = compileIngestExclusions(exclusions({ paths: ['/admin/*'] }))
    expect(compiled.matchesPath('/admin/')).toBe(true)
    expect(compiled.matchesPath('/admin/users/42/edit')).toBe(true)
    expect(compiled.matchesPath('/admin')).toBe(false)
    expect(compiled.matchesPath('/administrator')).toBe(false)

    const middle = compileIngestExclusions(exclusions({ paths: ['/shop/*/preview'] }))
    expect(middle.matchesPath('/shop/a/b/preview')).toBe(true)
    expect(middle.matchesPath('/shop/a/preview/x')).toBe(false)
  })

  it('takes every other character literally', () => {
    const compiled = compileIngestExclusions(exclusions({ paths: ['/a.b+c(d)[e]$^|\\'] }))
    expect(compiled.matchesPath('/a.b+c(d)[e]$^|\\')).toBe(true)
    expect(compiled.matchesPath('/axb+c(d)[e]$^|\\')).toBe(false)
    expect(compiled.matchesPath('/a.bbc(d)[e]$^|\\')).toBe(false)
  })

  it('matches a percent-encoded path against the path as it was typed', () => {
    const compiled = compileIngestExclusions(exclusions({ paths: ['/über/*'] }))
    expect(compiled.matchesPath('/%C3%BCber/x')).toBe(true)
  })

  it('stays fast on a pattern built to backtrack', () => {
    const pattern = `/${'*a'.repeat(40)}`
    const compiled = compileIngestExclusions(exclusions({ paths: [pattern] }))
    const started = performance.now()
    expect(compiled.matchesPath(`/${'a'.repeat(39)}${'b'.repeat(2000)}`)).toBe(false)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('the compiled hostname matcher', () => {
  it('matches an exact host, case-insensitively', () => {
    const compiled = compileIngestExclusions(exclusions({ hostnames: ['staging.example.com'] }))
    expect(compiled.matchesHostname('staging.example.com')).toBe(true)
    expect(compiled.matchesHostname('STAGING.example.com')).toBe(true)
    expect(compiled.matchesHostname('example.com')).toBe(false)
    expect(compiled.matchesHostname('a.staging.example.com')).toBe(false)
  })

  it('matches subdomains under *. and not the apex unless it is listed', () => {
    expect(exclusionHostnameMatches('*.example.com', 'a.example.com')).toBe(true)
    expect(exclusionHostnameMatches('*.example.com', 'a.b.example.com')).toBe(true)
    expect(exclusionHostnameMatches('*.example.com', 'example.com')).toBe(false)
    expect(exclusionHostnameMatches('*.example.com', 'badexample.com')).toBe(false)

    const both = compileIngestExclusions(
      exclusions({ hostnames: ['*.example.com', 'example.com'] }),
    )
    expect(both.matchesHostname('example.com')).toBe(true)
  })
})

describe('the compiled country matcher', () => {
  it('matches a listed country and nothing when the country is unknown', () => {
    const compiled = compileIngestExclusions(exclusions({ countries: ['DE'] }))
    expect(compiled.matchesCountry('DE')).toBe(true)
    expect(compiled.matchesCountry('de')).toBe(true)
    expect(compiled.matchesCountry('US')).toBe(false)
    expect(compiled.matchesCountry(null)).toBe(false)
  })
})

describe('compileIngestExclusions', () => {
  it('says when there is nothing to match, so the collector can skip the work', () => {
    expect(compileIngestExclusions(EMPTY_INGEST_EXCLUSIONS).empty).toBe(true)
    expect(compileIngestExclusions(exclusions({ countries: ['DE'] })).empty).toBe(false)
  })

  it('names the first reason a request matches, in a fixed order', () => {
    const compiled = compileIngestExclusions(
      exclusions({
        ipRanges: ['10.0.0.0/8'],
        countries: ['DE'],
        hostnames: ['staging.example.com'],
        paths: ['/admin/*'],
      }),
    )
    expect(
      compiled.reasonFor({
        ip: '10.0.0.1',
        country: 'DE',
        url: 'https://staging.example.com/admin/x',
        fallbackHostname: null,
      }),
    ).toBe('ip')
    expect(
      compiled.reasonFor({
        ip: '8.8.8.8',
        country: 'DE',
        url: 'https://staging.example.com/admin/x',
        fallbackHostname: null,
      }),
    ).toBe('country')
    expect(
      compiled.reasonFor({
        ip: '8.8.8.8',
        country: 'US',
        url: 'https://staging.example.com/admin/x',
        fallbackHostname: null,
      }),
    ).toBe('hostname')
    expect(
      compiled.reasonFor({
        ip: '8.8.8.8',
        country: 'US',
        url: 'https://www.example.com/admin/x',
        fallbackHostname: null,
      }),
    ).toBe('path')
    expect(
      compiled.reasonFor({
        ip: '8.8.8.8',
        country: 'US',
        url: 'https://www.example.com/pricing',
        fallbackHostname: null,
      }),
    ).toBeNull()
  })

  it('uses the fallback hostname only when the event has no page', () => {
    const compiled = compileIngestExclusions(exclusions({ hostnames: ['staging.example.com'] }))
    expect(
      compiled.reasonFor({
        ip: null,
        country: null,
        url: null,
        fallbackHostname: 'staging.example.com',
      }),
    ).toBe('hostname')
    expect(
      compiled.reasonFor({
        ip: null,
        country: null,
        url: 'https://www.example.com/',
        fallbackHostname: 'staging.example.com',
      }),
    ).toBeNull()
  })
})

describe('internationalised hostnames', () => {
  // A browser reports `bücher.de` as `xn--bcher-kva.de` — that is what
  // `new URL(page).hostname` gives the matcher — so a rule stored in Unicode
  // would never match. The rule is stored in the same ASCII form.
  it('stores a Unicode host in the ASCII form a page URL carries', () => {
    expect(normalizeExclusionHostname('bücher.de')).toBe('xn--bcher-kva.de')
    expect(normalizeExclusionHostname('BÜCHER.de')).toBe('xn--bcher-kva.de')
    expect(normalizeExclusionHostname('*.bücher.de')).toBe('*.xn--bcher-kva.de')
    expect(normalizeExclusionHostname('xn--bcher-kva.de')).toBe('xn--bcher-kva.de')
  })

  it('still refuses what is not a bare host once converted', () => {
    for (const bad of ['bücher.de/pfad', 'nutzer@bücher.de', 'bücher.de:443', '*.*.bücher.de']) {
      expect(normalizeExclusionHostname(bad), bad).toBeNull()
    }
  })

  it('matches the pages a browser reports for the host and its subdomains', () => {
    const apex = normalizeExclusionHostname('bücher.de') ?? ''
    const sub = normalizeExclusionHostname('*.bücher.de') ?? ''
    const subject = (url: string) => ({ ip: null, country: null, url, fallbackHostname: null })

    expect(
      compileIngestExclusions(exclusions({ hostnames: [apex] })).reasonFor(
        subject('https://bücher.de/regal'),
      ),
    ).toBe('hostname')
    const wildcard = compileIngestExclusions(exclusions({ hostnames: [sub] }))
    expect(wildcard.reasonFor(subject('https://shop.bücher.de/'))).toBe('hostname')
    expect(wildcard.reasonFor(subject('https://bücher.de/'))).toBeNull()
  })
})

describe('IPv6 ranges and IPv4 clients', () => {
  // An IPv4 client — including one a proxy reports as `::ffff:a.b.c.d` — is
  // matched as IPv4, so an IPv6 rule never matches it. A range wide enough to
  // cover `::ffff:0:0/96` would read as "everything" and match no IPv4 client
  // at all, so it is refused with a reason rather than stored.
  it('refuses an IPv6 range that covers the IPv4-mapped block', () => {
    for (const wide of ['::/0', '::/64', '::/80', '::ffff:0:0/95']) {
      expect(normalizeExclusionIpRange(wide), wide).toBeNull()
    }
    expect(normalizeExclusionIpRange('2001:db8::/32')).toBe('2001:db8::/32')
    expect(normalizeExclusionIpRange('::/96')).toBe('::/96')
  })

  it('names the reason in the validation issue', () => {
    const result = normalizeIngestExclusions({
      ip_ranges: ['::/0'],
      paths: [],
      countries: [],
      hostnames: [],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toEqual([{ field: 'exclusions.ip_ranges.0', code: 'covers_ipv4_mapped' }])
  })

  it('never matches an IPv4 client with an IPv6 rule', () => {
    const compiled = compileIngestExclusions(exclusions({ ipRanges: ['::/96'] }))
    expect(compiled.matchesIp('198.51.100.4')).toBe(false)
    expect(compiled.matchesIp('::ffff:198.51.100.4')).toBe(false)
  })
})

describe('countries are ISO 3166-1 codes', () => {
  it('refuses a two-letter code that names no country', () => {
    for (const bad of ['XX', 'T1', 'ZZ', 'AA', 'QO', 'EU', 'UK']) {
      expect(normalizeExclusionCountry(bad), bad).toBeNull()
    }
  })

  it('keeps every assigned code, and Kosovo, which GeoIP databases report as XK', () => {
    for (const good of ['DE', 'us', 'BV', 'HM', 'AQ', 'XK']) {
      expect(normalizeExclusionCountry(good), good).toBe(good.toUpperCase())
    }
  })
})

describe('path wildcards', () => {
  it('allows at most ten * in one rule', () => {
    expect(normalizeExclusionPath(`/${'*/'.repeat(10)}`)).toBe(`/${'*/'.repeat(10)}`)
    expect(normalizeExclusionPath(`/${'*/'.repeat(11)}`)).toBeNull()

    const result = normalizeIngestExclusions({
      ip_ranges: [],
      paths: [`/${'*'.repeat(11)}`],
      countries: [],
      hostnames: [],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toEqual([{ field: 'exclusions.paths.0', code: 'too_many_wildcards' }])
  })
})
