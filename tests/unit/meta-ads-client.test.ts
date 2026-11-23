import { createMetaAdsClient, META_INSIGHTS_PAGE_LIMIT } from '@openanalytics/integrations'
import { describe, expect, it } from 'vitest'

/**
 * The Meta Graph client (migration 0052).
 *
 * - The token travels in `Authorization: Bearer`, never in a URL, and a
 *   `paging.next` link that carries `access_token` is followed without it.
 * - Pagination follows `paging.next` until it is absent.
 * - Above 75% of any rate-limit budget it stops before the next page.
 * - Every failure is a category, and no outcome ever carries the token.
 */

const TOKEN = 'EAAG' + 'SeCrEt'.repeat(12)

interface Call {
  readonly url: string
  readonly headers: Record<string, string>
}

function fakeFetch(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> } | Error>,
) {
  const calls: Call[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    calls.push({ url: String(input), headers })
    const next = responses.shift()
    if (next === undefined) throw new Error('no more responses')
    if (next instanceof Error) throw next
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    })
  }) as typeof fetch
  return { impl, calls }
}

const insightsRow = (campaign: string, day: string, spend: string) => ({
  campaign_id: campaign,
  campaign_name: `Campaign ${campaign}`,
  spend,
  account_currency: 'USD',
  date_start: day,
  date_stop: day,
})

const window = {
  adAccountId: 'act_123',
  token: TOKEN,
  since: '2026-11-20',
  until: '2026-11-22',
  fallbackCurrency: 'USD',
}

function noToken(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(TOKEN)
  expect(JSON.stringify(value)).not.toContain('SeCrEt')
}

describe('fetchInsights', () => {
  it('asks for daily campaign spend with the token in the header only', async () => {
    const { impl, calls } = fakeFetch([
      { body: { data: [insightsRow('1', '2026-11-20', '12.34')] } },
    ])
    const client = createMetaAdsClient({ version: '1.2.3' }, impl)
    const result = await client.fetchInsights(window)

    expect(result).toMatchObject({
      ok: true,
      rows: [
        {
          campaignId: '1',
          campaignName: 'Campaign 1',
          day: '2026-11-20',
          spendMinor: 1234,
          currency: 'USD',
        },
      ],
      pages: 1,
    })
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0]!.url)
    expect(url.origin).toBe('https://graph.facebook.com')
    expect(url.pathname).toBe('/v27.0/act_123/insights')
    expect(url.searchParams.get('level')).toBe('campaign')
    expect(url.searchParams.get('time_increment')).toBe('1')
    expect(url.searchParams.get('fields')).toBe(
      'campaign_id,campaign_name,spend,account_currency,date_start,date_stop',
    )
    expect(JSON.parse(url.searchParams.get('time_range') ?? '')).toEqual({
      since: '2026-11-20',
      until: '2026-11-22',
    })
    expect(url.searchParams.get('limit')).toBe(String(META_INSIGHTS_PAGE_LIMIT))
    expect(url.searchParams.has('access_token')).toBe(false)
    expect(calls[0]!.url).not.toContain(TOKEN)
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(calls[0]!.headers['user-agent']).toContain('OpenAnalytics')
  })

  it('follows paging.next, stripping an access_token Meta put in it', async () => {
    const { impl, calls } = fakeFetch([
      {
        body: {
          data: [insightsRow('1', '2026-11-20', '1')],
          paging: {
            next: `https://graph.facebook.com/v27.0/act_123/insights?after=AAA&access_token=${TOKEN}`,
          },
        },
      },
      {
        body: {
          data: [],
          paging: { next: 'https://graph.facebook.com/v27.0/act_123/insights?after=BBB' },
        },
      },
      { body: { data: [insightsRow('2', '2026-11-21', '2.5')], paging: { cursors: {} } } },
    ])
    const result = await createMetaAdsClient({}, impl).fetchInsights(window)
    expect(result).toMatchObject({ ok: true, pages: 3 })
    expect(result.rows.map((row) => row.campaignId)).toEqual(['1', '2'])
    expect(calls).toHaveLength(3)
    const second = new URL(calls[1]!.url)
    expect(second.searchParams.get('after')).toBe('AAA')
    expect(second.searchParams.has('access_token')).toBe(false)
    for (const call of calls) {
      expect(call.url).not.toContain(TOKEN)
      expect(call.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    }
  })

  it('stops before the next page when usage is above 75%, keeping what it read', async () => {
    const { impl, calls } = fakeFetch([
      {
        body: {
          data: [insightsRow('1', '2026-11-20', '1')],
          paging: { next: 'https://graph.facebook.com/v27.0/act_123/insights?after=AAA' },
        },
        headers: {
          'x-business-use-case-usage': JSON.stringify({
            '42': [
              {
                type: 'ads_insights',
                call_count: 76,
                total_cputime: 5,
                total_time: 5,
                estimated_time_to_regain_access: 12,
              },
            ],
          }),
        },
      },
    ])
    const result = await createMetaAdsClient({}, impl).fetchInsights(window)
    expect(calls).toHaveLength(1)
    expect(result).toMatchObject({
      ok: false,
      reason: 'rate_limited',
      usage: { percent: 76, regainMinutes: 12 },
    })
    expect(result.rows).toHaveLength(1)
  })

  it('finishes when the last page is the one above 75%, and reports the usage', async () => {
    const { impl } = fakeFetch([
      {
        body: { data: [insightsRow('1', '2026-11-20', '1')] },
        headers: {
          'x-app-usage': JSON.stringify({ call_count: 90, total_cputime: 1, total_time: 1 }),
        },
      },
    ])
    const result = await createMetaAdsClient({}, impl).fetchInsights(window)
    expect(result).toMatchObject({ ok: true, usage: { percent: 90 } })
  })

  it('names a refused token unauthorized, without the token or Meta message in the detail', async () => {
    const { impl } = fakeFetch([
      {
        status: 400,
        body: {
          error: {
            message: `Error validating access token: ${TOKEN} has expired`,
            type: 'OAuthException',
            code: 190,
            error_subcode: 463,
          },
        },
      },
    ])
    const result = await createMetaAdsClient({}, impl).fetchInsights(window)
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
    noToken(result)
    expect(JSON.stringify(result)).not.toContain('Error validating')
  })

  it('names a throttle rate_limited and an outage unavailable', async () => {
    const throttled = await createMetaAdsClient(
      {},
      fakeFetch([{ status: 400, body: { error: { code: 80000, error_subcode: 2446079 } } }]).impl,
    ).fetchInsights(window)
    expect(throttled).toMatchObject({ ok: false, reason: 'rate_limited' })

    const down = await createMetaAdsClient(
      {},
      fakeFetch([{ status: 502, body: 'Bad gateway' }]).impl,
    ).fetchInsights(window)
    expect(down).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('names a socket failure unavailable, and never repeats the thrown message', async () => {
    const result = await createMetaAdsClient(
      {},
      fakeFetch([new Error(`connect ECONNRESET https://graph.facebook.com/?access_token=${TOKEN}`)])
        .impl,
    ).fetchInsights(window)
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
    noToken(result)
  })

  it('names a body that is not an insights page invalid_response', async () => {
    const result = await createMetaAdsClient(
      {},
      fakeFetch([{ body: '<html>' }]).impl,
    ).fetchInsights(window)
    expect(result).toMatchObject({ ok: false, reason: 'invalid_response' })
    const wrongHost = await createMetaAdsClient(
      {},
      fakeFetch([{ body: { data: [], paging: { next: 'https://evil.example/steal' } } }]).impl,
    ).fetchInsights(window)
    expect(wrongHost).toMatchObject({ ok: false, reason: 'invalid_response' })
  })
})

describe('verifyAccount', () => {
  it('reads the name, currency and status of the ad account', async () => {
    const { impl, calls } = fakeFetch([
      { body: { id: 'act_123', name: 'Acme Ads', currency: 'eur', account_status: 1 } },
    ])
    const result = await createMetaAdsClient({}, impl).verifyAccount('act_123', TOKEN)
    expect(result).toEqual({ ok: true, name: 'Acme Ads', currency: 'EUR', accountStatus: 1 })
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/v27.0/act_123')
    expect(url.searchParams.get('fields')).toBe('name,currency,account_status')
    expect(calls[0]!.url).not.toContain(TOKEN)
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${TOKEN}`)
  })

  it('names an account the token cannot see unauthorized', async () => {
    const result = await createMetaAdsClient(
      {},
      fakeFetch([
        { status: 400, body: { error: { code: 100, error_subcode: 33, message: 'nope' } } },
      ]).impl,
    ).verifyAccount('act_123', TOKEN)
    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('names an answer without a currency invalid_response', async () => {
    const result = await createMetaAdsClient(
      {},
      fakeFetch([{ body: { id: 'act_123', name: 'x' } }]).impl,
    ).verifyAccount('act_123', TOKEN)
    expect(result).toMatchObject({ ok: false, reason: 'invalid_response' })
  })
})
