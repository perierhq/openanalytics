import { isValidTimezone } from '@openanalytics/contracts'
import { normalizeTrackerSettingsPatch } from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * The settings patch normalizer (ADR-0064 F4).
 *
 * This is where a settings write is refused or accepted, and it sits in the
 * domain rather than in the route for one reason: every bound it enforces has a
 * twin in the published `TrackerConfig` contract or in a column CHECK, so a
 * value that slipped past would come back to the caller as a driver error —
 * a 500 for what is a form mistake.
 */

const codes = (result: ReturnType<typeof normalizeTrackerSettingsPatch>): string[] =>
  result.ok ? [] : result.issues.map((issue) => `${issue.field}:${issue.code}`)

describe('tracker settings patch', () => {
  it('takes only the fields the caller sent', () => {
    // Absent is "leave it alone", never "reset to the default" — a patch that
    // mentions one flag must not silently restore the rest of the row.
    const result = normalizeTrackerSettingsPatch({ attributed_revenue: true }, isValidTimezone)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.patch).toEqual({ attributedRevenue: true })
  })

  it('refuses an empty patch rather than treating it as a no-op', () => {
    // It would still bump `config_version` and make every browser re-fetch its
    // configuration, for a request that asked for nothing.
    expect(codes(normalizeTrackerSettingsPatch({}, isValidTimezone))).toEqual([
      'body:required_one_of',
    ])
  })

  it('refuses a heartbeat interval the presence window cannot hold', () => {
    // ADR-0035 D8: three intervals must fit inside the five-minute window. The
    // value is refused rather than clamped because what a bad one produces is a
    // flickering board, which reads as a bug in everything except the setting.
    expect(
      codes(normalizeTrackerSettingsPatch({ heartbeat_interval_seconds: 300 }, isValidTimezone)),
    ).toEqual(['heartbeat_interval_seconds:out_of_range'])
    expect(
      codes(normalizeTrackerSettingsPatch({ heartbeat_interval_seconds: 4 }, isValidTimezone)),
    ).toEqual(['heartbeat_interval_seconds:out_of_range'])
    expect(
      codes(normalizeTrackerSettingsPatch({ heartbeat_interval_seconds: 15.5 }, isValidTimezone)),
    ).toEqual(['heartbeat_interval_seconds:out_of_range'])

    const ok = normalizeTrackerSettingsPatch({ heartbeat_interval_seconds: 30 }, isValidTimezone)
    expect(ok.ok && ok.patch.heartbeatIntervalSeconds).toBe(30)
  })

  it('bounds the sampling fraction at both ends', () => {
    expect(
      codes(normalizeTrackerSettingsPatch({ interaction_sampling: 1.5 }, isValidTimezone)),
    ).toEqual(['interaction_sampling:out_of_range'])
    expect(
      codes(normalizeTrackerSettingsPatch({ interaction_sampling: -0.1 }, isValidTimezone)),
    ).toEqual(['interaction_sampling:out_of_range'])
    const ok = normalizeTrackerSettingsPatch({ interaction_sampling: 0 }, isValidTimezone)
    expect(ok.ok && ok.patch.interactionSampling).toBe(0)
  })

  it('lowercases and de-duplicates the redaction keys', () => {
    // The resolver lowercases what it reads, so storing mixed case would make
    // the stored row and the served config disagree for no visible reason.
    const result = normalizeTrackerSettingsPatch(
      { redact_query_keys: ['Token', ' token ', 'EMAIL'] },
      isValidTimezone,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.patch.redactQueryKeys).toEqual(['token', 'email'])
  })

  it('refuses a redaction key longer than the contract allows', () => {
    expect(
      codes(
        normalizeTrackerSettingsPatch({ redact_query_keys: ['x'.repeat(65)] }, isValidTimezone),
      ),
    ).toEqual(['redact_query_keys:invalid'])
    expect(
      codes(
        normalizeTrackerSettingsPatch(
          { redact_query_keys: Array.from({ length: 201 }, (_, i) => `k${i}`) },
          isValidTimezone,
        ),
      ),
    ).toEqual(['redact_query_keys:too_many'])
  })

  it('patches feature flags one at a time and names an unknown one', () => {
    const result = normalizeTrackerSettingsPatch(
      { features: { interactions: false } },
      isValidTimezone,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.patch.features).toEqual({ interactions: false })

    // A typo'd flag is refused rather than dropped: silently ignoring it would
    // show a dashboard toggle that appears to save and changes nothing.
    expect(
      codes(normalizeTrackerSettingsPatch({ features: { heatmaps: true } }, isValidTimezone)),
    ).toEqual(['features.heatmaps:unknown'])
  })

  it('validates the timezone against the runtime, not a pattern', () => {
    expect(
      codes(normalizeTrackerSettingsPatch({ timezone: 'Mars/Olympus' }, isValidTimezone)),
    ).toEqual(['timezone:invalid'])
    // An offset zone is well-formed and still refused, the same as everywhere
    // else a zone is accepted.
    expect(codes(normalizeTrackerSettingsPatch({ timezone: '+04:00' }, isValidTimezone))).toEqual([
      'timezone:invalid',
    ])

    const ok = normalizeTrackerSettingsPatch({ timezone: 'Asia/Baku' }, isValidTimezone)
    expect(ok.ok && ok.patch.timezone).toBe('Asia/Baku')
  })

  it('reports every bad field at once, so one save shows every mistake', () => {
    const result = normalizeTrackerSettingsPatch(
      { timezone: 'Nowhere/Here', interaction_sampling: 2, attributed_revenue: 'yes' },
      isValidTimezone,
    )
    expect(codes(result)).toEqual([
      'timezone:invalid',
      'interaction_sampling:out_of_range',
      'attributed_revenue:not_a_boolean',
    ])
  })

  it('refuses a body that is not an object', () => {
    expect(codes(normalizeTrackerSettingsPatch(null, isValidTimezone))).toEqual([
      'body:not_an_object',
    ])
    expect(codes(normalizeTrackerSettingsPatch([], isValidTimezone))).toEqual([
      'body:not_an_object',
    ])
  })

  it('carries normalised exclusions, which replace the stored set as a whole', () => {
    const result = normalizeTrackerSettingsPatch(
      {
        exclusions: {
          ip_ranges: ['203.0.113.7'],
          paths: ['/admin/*'],
          countries: ['de'],
          hostnames: ['Staging.Example.com'],
        },
      },
      isValidTimezone,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.patch).toEqual({
      exclusions: {
        ipRanges: ['203.0.113.7/32'],
        paths: ['/admin/*'],
        countries: ['DE'],
        hostnames: ['staging.example.com'],
      },
    })
  })

  it('reports an exclusion problem against its own list', () => {
    const result = normalizeTrackerSettingsPatch(
      { exclusions: { ip_ranges: ['office'], paths: [], countries: [], hostnames: [] } },
      isValidTimezone,
    )
    expect(codes(result)).toEqual(['exclusions.ip_ranges.0:invalid'])
  })
})
