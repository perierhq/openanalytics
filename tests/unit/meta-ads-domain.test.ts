import {
  META_ADS_ERRORS,
  META_ADS_FIRST_SYNC_DAYS,
  META_ADS_RESYNC_DAYS,
  META_GRAPH_API_VERSION,
  classifyMetaGraphError,
  convertCampaignSpend,
  joinCampaignRevenue,
  metaAdsCredentialAad,
  metaBackfillChunk,
  metaSyncWindow,
  metaUsage,
  normalizeMetaAdAccountId,
  normalizeMetaAccessToken,
  normalizeUtmCampaign,
  parseMetaInsightsPage,
  parseMetaSpendMinor,
  spendDayRange,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * The pure half of Meta Ads (migration 0052): reading an insights page,
 * turning Meta's decimal spend strings into minor units, reading the
 * rate-limit headers, classifying Graph errors, the sync windows, and joining
 * campaigns to last-touch revenue by `utm_campaign`.
 */

describe('normalizeMetaAdAccountId', () => {
  it('accepts act_ plus digits, and bare digits, as act_ plus digits', () => {
    expect(normalizeMetaAdAccountId('act_1234567890')).toBe('act_1234567890')
    expect(normalizeMetaAdAccountId('  act_42 ')).toBe('act_42')
    expect(normalizeMetaAdAccountId('1234567890')).toBe('act_1234567890')
  })

  it('refuses anything else', () => {
    for (const bad of [
      '',
      'act_',
      'act_12a',
      'acct_12',
      'act_1/../2',
      12,
      null,
      'act_' + '9'.repeat(30),
    ]) {
      expect(normalizeMetaAdAccountId(bad), String(bad)).toBeNull()
    }
  })
})

describe('normalizeMetaAccessToken', () => {
  it('trims a plausible token and refuses blanks, spaces and oversize values', () => {
    expect(normalizeMetaAccessToken('  EAAB' + 'x'.repeat(60) + '  ')).toBe('EAAB' + 'x'.repeat(60))
    expect(normalizeMetaAccessToken('')).toBeNull()
    expect(normalizeMetaAccessToken('short')).toBeNull()
    expect(normalizeMetaAccessToken('EAAB xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toBeNull()
    expect(normalizeMetaAccessToken('E'.repeat(5000))).toBeNull()
    expect(normalizeMetaAccessToken(42)).toBeNull()
  })
})

describe('metaAdsCredentialAad', () => {
  it('binds the ciphertext to the site and the ad account', () => {
    expect(metaAdsCredentialAad({ siteId: 's-1', adAccountId: 'act_9' })).toBe(
      'meta_ads_connection:s-1:act_9',
    )
  })
})

describe('parseMetaSpendMinor', () => {
  it('reads decimal strings exactly, by the currency exponent', () => {
    expect(parseMetaSpendMinor('12.34', 'USD')).toBe(1234)
    expect(parseMetaSpendMinor('12.3', 'EUR')).toBe(1230)
    expect(parseMetaSpendMinor('12', 'EUR')).toBe(1200)
    expect(parseMetaSpendMinor('0', 'EUR')).toBe(0)
    expect(parseMetaSpendMinor('1234', 'JPY')).toBe(1234)
    expect(parseMetaSpendMinor('5339.5', 'USD')).toBe(533950)
    // 0.1 + 0.2 is the float trap; this path never touches a float.
    expect(parseMetaSpendMinor('0.30', 'USD')).toBe(30)
  })

  it('rounds a third decimal half to even', () => {
    expect(parseMetaSpendMinor('1.005', 'USD')).toBe(100)
    expect(parseMetaSpendMinor('1.015', 'USD')).toBe(102)
    expect(parseMetaSpendMinor('1.016', 'USD')).toBe(102)
  })

  it('reads a three-decimal currency to the thousandth, rounding a fourth half to even', () => {
    expect(parseMetaSpendMinor('1.234', 'KWD')).toBe(1234)
    expect(parseMetaSpendMinor('12.3', 'KWD')).toBe(12300)
    // '1.2345' is a tie: half to even keeps 1234, as the currency conversion
    // would; anything past the tie rounds up.
    expect(parseMetaSpendMinor('1.2345', 'KWD')).toBe(1234)
    expect(parseMetaSpendMinor('1.2355', 'KWD')).toBe(1236)
    expect(parseMetaSpendMinor('1.23451', 'KWD')).toBe(1235)
    expect(parseMetaSpendMinor('1.2346', 'KWD')).toBe(1235)
  })

  it('refuses what is not a non-negative decimal', () => {
    for (const bad of ['', 'abc', '-1.00', '1e3', '1,00', null, undefined, {}]) {
      expect(parseMetaSpendMinor(bad, 'USD'), String(bad)).toBeNull()
    }
  })

  it('accepts a finite non-negative number as a fallback', () => {
    expect(parseMetaSpendMinor(12.34, 'USD')).toBe(1234)
    expect(parseMetaSpendMinor(Number.NaN, 'USD')).toBeNull()
  })
})

const row = (overrides: Record<string, unknown> = {}) => ({
  campaign_id: '120200000000001',
  campaign_name: 'Black Friday',
  spend: '12.34',
  account_currency: 'USD',
  date_start: '2026-11-20',
  date_stop: '2026-11-20',
  ...overrides,
})

describe('parseMetaInsightsPage', () => {
  it('reads rows and the next page link', () => {
    const parsed = parseMetaInsightsPage(
      {
        data: [
          row(),
          row({ campaign_id: '120200000000002', campaign_name: 'Retargeting', spend: '0.5' }),
        ],
        paging: {
          cursors: { before: 'a', after: 'b' },
          next: 'https://graph.facebook.com/v27.0/act_1/insights?after=b',
        },
      },
      { fallbackCurrency: 'USD' },
    )
    expect(parsed).toEqual({
      ok: true,
      next: 'https://graph.facebook.com/v27.0/act_1/insights?after=b',
      skipped: 0,
      rows: [
        {
          campaignId: '120200000000001',
          campaignName: 'Black Friday',
          day: '2026-11-20',
          spendMinor: 1234,
          currency: 'USD',
        },
        {
          campaignId: '120200000000002',
          campaignName: 'Retargeting',
          day: '2026-11-20',
          spendMinor: 50,
          currency: 'USD',
        },
      ],
    })
  })

  it('has no next page when paging.next is absent, even on a short page', () => {
    const parsed = parseMetaInsightsPage(
      { data: [row()], paging: { cursors: {} } },
      { fallbackCurrency: 'USD' },
    )
    expect(parsed.ok && parsed.next).toBe(null)
    const bare = parseMetaInsightsPage({ data: [] }, { fallbackCurrency: 'USD' })
    expect(bare).toEqual({ ok: true, rows: [], next: null, skipped: 0 })
  })

  it('keeps an empty page that still has a next link', () => {
    const parsed = parseMetaInsightsPage(
      { data: [], paging: { next: 'https://graph.facebook.com/v27.0/act_1/insights?after=c' } },
      { fallbackCurrency: 'USD' },
    )
    expect(parsed).toEqual({
      ok: true,
      rows: [],
      skipped: 0,
      next: 'https://graph.facebook.com/v27.0/act_1/insights?after=c',
    })
  })

  it('falls back on a missing name and currency, and skips rows it cannot place', () => {
    const parsed = parseMetaInsightsPage(
      {
        data: [
          row({ campaign_name: undefined, account_currency: undefined, spend: '3' }),
          row({ campaign_id: undefined }),
          row({ campaign_id: 'not-digits' }),
          row({ date_start: 'yesterday' }),
          row({ spend: undefined }),
          row({ spend: '-4.00' }),
          'not an object',
        ],
      },
      { fallbackCurrency: 'EUR' },
    )
    expect(parsed).toEqual({
      ok: true,
      next: null,
      skipped: 6,
      rows: [
        {
          campaignId: '120200000000001',
          campaignName: '',
          day: '2026-11-20',
          spendMinor: 300,
          currency: 'EUR',
        },
      ],
    })
  })

  it('reads spend by the row currency', () => {
    const parsed = parseMetaInsightsPage(
      { data: [row({ account_currency: 'jpy', spend: '1500' })] },
      { fallbackCurrency: 'USD' },
    )
    expect(parsed.ok && parsed.rows[0]).toMatchObject({ currency: 'JPY', spendMinor: 1500 })
  })

  it('refuses a body that is not an insights page', () => {
    for (const bad of [null, [], 'x', { data: 'x' }, {}, { error: { code: 190 } }]) {
      expect(parseMetaInsightsPage(bad, { fallbackCurrency: 'USD' }).ok, JSON.stringify(bad)).toBe(
        false,
      )
    }
  })

  it('refuses a next link that is not on graph.facebook.com over https', () => {
    for (const next of ['http://graph.facebook.com/x', 'https://evil.example/x', 'not a url']) {
      const parsed = parseMetaInsightsPage(
        { data: [], paging: { next } },
        { fallbackCurrency: 'USD' },
      )
      expect(parsed.ok, next).toBe(false)
    }
  })

  it('refuses a next link with a port, credentials, or a path outside the pinned version', () => {
    const path = `/${META_GRAPH_API_VERSION}/act_1/insights?after=abc`
    for (const next of [
      `https://graph.facebook.com:8443${path}`,
      `https://user:pass@graph.facebook.com${path}`,
      `https://user@graph.facebook.com${path}`,
      'https://graph.facebook.com/v1.0/act_1/insights?after=abc',
      'https://graph.facebook.com/act_1/insights?after=abc',
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}`,
      `https://graph.facebook.com/x/${META_GRAPH_API_VERSION}/act_1/insights`,
    ]) {
      const parsed = parseMetaInsightsPage(
        { data: [], paging: { next } },
        { fallbackCurrency: 'USD' },
      )
      expect(parsed.ok, next).toBe(false)
    }
  })
})

const headers = (entries: Record<string, string>) => ({
  get: (name: string) => entries[name.toLowerCase()] ?? null,
})

describe('a next link on the pinned version', () => {
  it('is followed, port 443 spelled out included', () => {
    for (const next of [
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/act_1/insights?after=abc`,
      `https://graph.facebook.com:443/${META_GRAPH_API_VERSION}/act_1/insights?after=abc`,
    ]) {
      const parsed = parseMetaInsightsPage(
        { data: [], paging: { next } },
        { fallbackCurrency: 'USD' },
      )
      expect(parsed.ok && parsed.next, next).toBe(next)
    }
  })
})

describe('metaUsage', () => {
  it('reads the ad account budget from x-ad-account-usage, its reset in seconds as minutes', () => {
    expect(
      metaUsage(
        headers({
          'x-app-usage': JSON.stringify({ call_count: 10 }),
          'x-ad-account-usage': JSON.stringify({
            acc_id_util_pct: 88.5,
            reset_time_duration: 100,
            ads_api_access_tier: 'standard_access',
          }),
        }),
      ),
    ).toEqual({ percent: 88.5, regainMinutes: 2 })
    expect(
      metaUsage(headers({ 'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 9.67 }) })),
    ).toEqual({ percent: 9.67, regainMinutes: 0 })
  })

  it('is the highest percentage across x-app-usage and every business use case', () => {
    expect(
      metaUsage(
        headers({
          'x-app-usage': JSON.stringify({ call_count: 28, total_time: 25, total_cputime: 25 }),
          'x-business-use-case-usage': JSON.stringify({
            '66782684': [
              {
                type: 'ads_insights',
                call_count: 12,
                total_cputime: 81,
                total_time: 20,
                estimated_time_to_regain_access: 0,
              },
            ],
            '10153848260347724': [
              {
                type: 'ads_management',
                call_count: 3,
                total_cputime: 2,
                total_time: 2,
                estimated_time_to_regain_access: 19,
              },
            ],
          }),
        }),
      ),
    ).toEqual({ percent: 81, regainMinutes: 19 })
  })

  it('reads no headers, and malformed ones, as no usage known', () => {
    expect(metaUsage(headers({}))).toEqual({ percent: null, regainMinutes: 0 })
    expect(
      metaUsage(headers({ 'x-app-usage': 'not json', 'x-business-use-case-usage': '[1]' })),
    ).toEqual({
      percent: null,
      regainMinutes: 0,
    })
  })
})

describe('classifyMetaGraphError', () => {
  const graph = (code: number, subcode?: number) => ({
    error: {
      message: 'x',
      type: 'OAuthException',
      code,
      ...(subcode ? { error_subcode: subcode } : {}),
    },
  })

  it('names a bad or unpermitted token unauthorized', () => {
    for (const code of [190, 102, 10, 200, 294]) {
      expect(classifyMetaGraphError(400, graph(code)), String(code)).toBe('unauthorized')
    }
    expect(classifyMetaGraphError(400, graph(100, 33))).toBe('unauthorized')
    expect(classifyMetaGraphError(401, null)).toBe('unauthorized')
  })

  it('names every throttle rate_limited', () => {
    for (const code of [4, 17, 32, 341, 613, 80000, 80004, 80014]) {
      expect(classifyMetaGraphError(400, graph(code)), String(code)).toBe('rate_limited')
    }
    expect(classifyMetaGraphError(429, null)).toBe('rate_limited')
  })

  it('names outages unavailable', () => {
    expect(classifyMetaGraphError(500, null)).toBe('unavailable')
    expect(classifyMetaGraphError(503, 'gateway')).toBe('unavailable')
    expect(classifyMetaGraphError(400, graph(1))).toBe('unavailable')
    expect(classifyMetaGraphError(400, graph(2))).toBe('unavailable')
  })

  it('names anything else invalid_response', () => {
    expect(classifyMetaGraphError(400, graph(100))).toBe('invalid_response')
    expect(classifyMetaGraphError(400, 'html')).toBe('invalid_response')
  })
})

describe('metaSyncWindow', () => {
  it('reads the last three days on a routine sync, today included', () => {
    expect(META_ADS_RESYNC_DAYS).toBe(3)
    expect(metaSyncWindow({ today: '2026-11-22', firstSync: false })).toEqual({
      since: '2026-11-20',
      until: '2026-11-22',
    })
  })

  it('reads ninety days on the first sync', () => {
    expect(META_ADS_FIRST_SYNC_DAYS).toBe(90)
    expect(metaSyncWindow({ today: '2026-11-22', firstSync: true })).toEqual({
      since: '2026-08-25',
      until: '2026-11-22',
    })
  })
})

describe('metaBackfillChunk', () => {
  it('walks a first sync from ninety days back to the day before the recent window, thirty days at a time', () => {
    const today = '2026-11-22'
    expect(metaBackfillChunk({ today, cursor: null })).toEqual({
      since: '2026-08-25',
      until: '2026-09-23',
    })
    expect(metaBackfillChunk({ today, cursor: '2026-09-23' })).toEqual({
      since: '2026-09-24',
      until: '2026-10-23',
    })
    expect(metaBackfillChunk({ today, cursor: '2026-10-23' })).toEqual({
      since: '2026-10-24',
      until: '2026-11-19',
    })
    expect(metaBackfillChunk({ today, cursor: '2026-11-19' })).toBeNull()
  })

  it('resumes a cursor left days ago without a gap, and never reads before the window', () => {
    // Stopped on the 1st, resumed on the 22nd: the days in between are read.
    expect(metaBackfillChunk({ today: '2026-11-22', cursor: '2026-10-30' })).toEqual({
      since: '2026-10-31',
      until: '2026-11-19',
    })
    // A cursor older than the window starts at the window.
    expect(metaBackfillChunk({ today: '2026-11-22', cursor: '2026-01-01' })).toEqual({
      since: '2026-08-25',
      until: '2026-09-23',
    })
  })
})

describe('META_ADS_ERRORS', () => {
  it('names a token this install cannot decrypt apart from one Meta refused', () => {
    expect(META_ADS_ERRORS).toContain('credential_undecryptable')
    expect(META_ADS_ERRORS).toContain('unauthorized')
  })
})

describe('spendDayRange', () => {
  it('turns a half-open instant range into inclusive local days', () => {
    expect(
      spendDayRange({
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-08T00:00:00.000Z',
        timezone: 'UTC',
      }),
    ).toEqual({ fromDay: '2026-11-01', toDay: '2026-11-07' })
    expect(
      spendDayRange({
        from: '2026-10-31T23:00:00.000Z',
        to: '2026-11-07T23:00:00.000Z',
        timezone: 'Europe/Warsaw',
      }),
    ).toEqual({ fromDay: '2026-11-01', toDay: '2026-11-07' })
  })
})

describe('normalizeUtmCampaign', () => {
  it('trims and folds case', () => {
    expect(normalizeUtmCampaign('  Black Friday ')).toBe('black friday')
    expect(normalizeUtmCampaign('')).toBe('')
  })
})

describe('convertCampaignSpend', () => {
  const rate = (currency: string, day: string) => {
    if (currency === 'EUR') return { ratePerEur: '1', rateDate: day }
    if (currency === 'USD') return { ratePerEur: '1.25', rateDate: day }
    if (currency === 'PLN') return day === '2026-11-02' ? null : { ratePerEur: '4', rateDate: day }
    return null
  }

  it('sums per campaign and converts each day at its own rate', () => {
    const result = convertCampaignSpend(
      [
        {
          campaignId: '1',
          campaignName: 'A',
          day: '2026-11-01',
          spendMinor: 1250,
          currency: 'USD',
        },
        {
          campaignId: '1',
          campaignName: 'A',
          day: '2026-11-02',
          spendMinor: 2500,
          currency: 'USD',
        },
        { campaignId: '2', campaignName: 'B', day: '2026-11-01', spendMinor: 125, currency: 'USD' },
      ],
      'EUR',
      rate,
    )
    expect(result).toEqual([
      {
        campaignId: '1',
        campaignName: 'A',
        spendMinor: 3750,
        currency: 'USD',
        convertedMinor: 3000,
      },
      { campaignId: '2', campaignName: 'B', spendMinor: 125, currency: 'USD', convertedMinor: 100 },
    ])
  })

  it('does no arithmetic when the currencies match', () => {
    const result = convertCampaignSpend(
      [{ campaignId: '1', campaignName: 'A', day: '2026-11-01', spendMinor: 999, currency: 'EUR' }],
      'eur',
      () => null,
    )
    expect(result[0]?.convertedMinor).toBe(999)
  })

  it('leaves a campaign unconverted when any of its days has no rate', () => {
    const result = convertCampaignSpend(
      [
        { campaignId: '1', campaignName: 'A', day: '2026-11-01', spendMinor: 400, currency: 'PLN' },
        { campaignId: '1', campaignName: 'A', day: '2026-11-02', spendMinor: 400, currency: 'PLN' },
      ],
      'EUR',
      rate,
    )
    expect(result).toEqual([
      {
        campaignId: '1',
        campaignName: 'A',
        spendMinor: 800,
        currency: 'PLN',
        convertedMinor: null,
      },
    ])
  })

  it('takes the newest non-empty name a campaign had in the range', () => {
    const result = convertCampaignSpend(
      [
        { campaignId: '1', campaignName: 'Old', day: '2026-11-01', spendMinor: 1, currency: 'EUR' },
        { campaignId: '1', campaignName: 'New', day: '2026-11-03', spendMinor: 1, currency: 'EUR' },
        { campaignId: '1', campaignName: '', day: '2026-11-04', spendMinor: 1, currency: 'EUR' },
      ],
      'EUR',
      rate,
    )
    expect(result[0]?.campaignName).toBe('New')
  })
})

describe('joinCampaignRevenue', () => {
  const campaigns = [
    {
      campaignId: '111',
      campaignName: 'Black Friday',
      spendMinor: 10_000,
      currency: 'EUR',
      convertedMinor: 10_000,
    },
    {
      campaignId: '222',
      campaignName: 'Retargeting',
      spendMinor: 5_000,
      currency: 'EUR',
      convertedMinor: 5_000,
    },
    {
      campaignId: '333',
      campaignName: 'Brand',
      spendMinor: 2_000,
      currency: 'EUR',
      convertedMinor: 2_000,
    },
    {
      campaignId: '444',
      campaignName: 'Paused',
      spendMinor: 0,
      currency: 'EUR',
      convertedMinor: 0,
    },
  ]

  it('matches utm_campaign to the campaign name, case-insensitively and trimmed', () => {
    const joined = joinCampaignRevenue(campaigns, [
      { value: '  black FRIDAY ', revenueMinor: 30_000, orders: 3 },
    ])
    const bf = joined.campaigns.find((c) => c.campaignId === '111')
    expect(bf).toMatchObject({ revenueMinor: 30_000, orders: 3, matchedBy: 'name', roas: 3 })
  })

  it('matches utm_campaign to the campaign id', () => {
    const joined = joinCampaignRevenue(campaigns, [
      { value: '222', revenueMinor: 2_500, orders: 1 },
    ])
    expect(joined.campaigns.find((c) => c.campaignId === '222')).toMatchObject({
      revenueMinor: 2_500,
      orders: 1,
      matchedBy: 'id',
      roas: 0.5,
    })
  })

  it('adds the name rows and the id rows of one campaign together', () => {
    const joined = joinCampaignRevenue(campaigns, [
      { value: '111', revenueMinor: 1_000, orders: 1 },
      { value: 'Black Friday', revenueMinor: 2_000, orders: 2 },
    ])
    expect(joined.campaigns.find((c) => c.campaignId === '111')).toMatchObject({
      revenueMinor: 3_000,
      orders: 3,
      matchedBy: 'id_and_name',
    })
  })

  it('never counts the unattributed row or an unknown value', () => {
    const joined = joinCampaignRevenue(campaigns, [
      { value: null, revenueMinor: 99_999, orders: 9 },
      { value: '', revenueMinor: 99_999, orders: 9 },
      { value: 'newsletter', revenueMinor: 99_999, orders: 9 },
    ])
    expect(joined.totals.revenueMinor).toBe(0)
    expect(joined.campaigns.every((c) => c.matchedBy === null)).toBe(true)
  })

  it('gives a name shared by two campaigns to the one that spent more, once', () => {
    const twins = [
      {
        campaignId: '1',
        campaignName: 'Spring',
        spendMinor: 100,
        currency: 'EUR',
        convertedMinor: 100,
      },
      {
        campaignId: '2',
        campaignName: 'spring',
        spendMinor: 900,
        currency: 'EUR',
        convertedMinor: 900,
      },
    ]
    const joined = joinCampaignRevenue(twins, [{ value: 'Spring', revenueMinor: 1_800, orders: 2 }])
    expect(joined.campaigns.find((c) => c.campaignId === '2')?.revenueMinor).toBe(1_800)
    expect(joined.campaigns.find((c) => c.campaignId === '1')?.revenueMinor).toBe(0)
    expect(joined.totals.revenueMinor).toBe(1_800)
  })

  it('has no ROAS for a campaign that spent nothing, or whose spend could not be converted', () => {
    const joined = joinCampaignRevenue(
      [
        ...campaigns,
        {
          campaignId: '555',
          campaignName: 'Abroad',
          spendMinor: 400,
          currency: 'XYZ',
          convertedMinor: null,
        },
      ],
      [
        { value: 'Paused', revenueMinor: 500, orders: 1 },
        { value: 'Abroad', revenueMinor: 500, orders: 1 },
      ],
    )
    expect(joined.campaigns.find((c) => c.campaignId === '444')).toMatchObject({
      roas: null,
      roasUnavailable: 'no_spend',
    })
    expect(joined.campaigns.find((c) => c.campaignId === '555')).toMatchObject({
      roas: null,
      roasUnavailable: 'no_rate',
    })
    // One unconvertible campaign makes the converted total unknowable, not smaller.
    expect(joined.totals.spendConvertedMinor).toBeNull()
    expect(joined.totals.roas).toBeNull()
    expect(joined.totals.roasUnavailable).toBe('no_rate')
  })

  it('totals spend, revenue and orders, and reports spend that matched no utm_campaign', () => {
    const joined = joinCampaignRevenue(campaigns, [
      { value: 'black friday', revenueMinor: 30_000, orders: 3 },
    ])
    expect(joined.totals).toEqual({
      spendMinor: 17_000,
      spendConvertedMinor: 17_000,
      revenueMinor: 30_000,
      orders: 3,
      roas: 30_000 / 17_000,
      roasUnavailable: null,
    })
    // 222 and 333 spent and matched nothing; 444 spent nothing, so it is not unmatched spend.
    expect(joined.unmatched).toEqual({
      campaigns: 2,
      spendMinor: 7_000,
      spendConvertedMinor: 7_000,
    })
  })

  it('has no total ROAS when nothing was spent', () => {
    const joined = joinCampaignRevenue([], [])
    expect(joined.totals).toEqual({
      spendMinor: 0,
      spendConvertedMinor: 0,
      revenueMinor: 0,
      orders: 0,
      roas: null,
      roasUnavailable: 'no_spend',
    })
  })
})
