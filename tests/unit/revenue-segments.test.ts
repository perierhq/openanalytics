import { describe, expect, it } from 'vitest'
import {
  REVENUE_SEGMENT_MIN_VISITORS,
  REVENUE_SEGMENT_PRIOR_K,
  REVENUE_SEGMENTS_MAX_SPAN_DAYS,
  REVENUE_SEGMENTS_MIN_BUYERS,
  isRevenueSegmentShown,
  rankRevenueSegments,
  revenueSegmentConfidence,
  revenueSegmentsStatus,
  revenueSiteRates,
  scoreRevenueSegment,
  smoothTowardPrior,
  withholdBesideLoneHidden,
  type RevenueSegmentCounts,
} from '@openanalytics/domain'

/**
 * Revenue by segment: the smoothing, the confidence bands, the hidden
 * threshold and the minimum-data rule, as pure functions.
 *
 * The point of the smoothing is the sentence on the card: a segment with a
 * handful of visits is pulled toward the site's average, so three visits and
 * one sale can never read as a 33% converter.
 */

function segment(over: Partial<RevenueSegmentCounts>): RevenueSegmentCounts {
  return {
    source: 'google.com',
    country: 'DE',
    device: 'desktop',
    visitors: 0,
    buyers: 0,
    orders: 0,
    revenueMinor: 0,
    unconvertedOrders: 0,
    ...over,
  }
}

describe('the constants are the documented ones', () => {
  it('k = 200, 20 visitors to show a segment, 10 buyers for any answer', () => {
    expect(REVENUE_SEGMENT_PRIOR_K).toBe(200)
    expect(REVENUE_SEGMENT_MIN_VISITORS).toBe(20)
    expect(REVENUE_SEGMENTS_MIN_BUYERS).toBe(10)
  })

  it('reads at most 92 days, a cap of its own', () => {
    expect(REVENUE_SEGMENTS_MAX_SPAN_DAYS).toBe(92)
  })
})

describe('smoothTowardPrior', () => {
  it('returns the prior exactly for a segment with no visitors', () => {
    expect(smoothTowardPrior(0, 0, 0.02)).toBe(0.02)
    expect(smoothTowardPrior(0, 0, 150)).toBe(150)
  })

  it('pulls a tiny segment almost all the way to the prior', () => {
    // 1 buyer in 3 visitors is 33% raw; with k = 200 toward 2% it is
    // (1 + 4) / 203, about 2.5%.
    const smoothed = smoothTowardPrior(1, 3, 0.02)
    expect(smoothed).toBeCloseTo(5 / 203, 12)
    expect(smoothed).toBeLessThan(0.03)
  })

  it('leaves a huge segment at its own rate', () => {
    // 5,000 buyers in 100,000 visitors: 5% raw, and the prior moves it by
    // less than a hundredth of a point.
    const smoothed = smoothTowardPrior(5_000, 100_000, 0.02)
    expect(smoothed).toBeCloseTo((5_000 + 200 * 0.02) / 100_200, 12)
    expect(Math.abs(smoothed - 0.05)).toBeLessThan(0.0001)
  })

  it('weighs the prior as k visitors, and k is a parameter', () => {
    // With k equal to the segment's visitors the answer is the midpoint.
    expect(smoothTowardPrior(10, 100, 0.2, 100)).toBeCloseTo(0.15, 12)
    // k = 0 is the raw rate.
    expect(smoothTowardPrior(10, 100, 0.2, 0)).toBeCloseTo(0.1, 12)
    // The default is 200.
    expect(smoothTowardPrior(10, 100, 0.2)).toBeCloseTo((10 + 40) / 300, 12)
  })

  it('smooths value per visitor the same way, in minor units', () => {
    // 2 orders worth 20,000 over 40 visitors is 500 per visitor raw; toward a
    // site-wide 50 it is (20,000 + 200 × 50) / 240 = 125.
    expect(smoothTowardPrior(20_000, 40, 50)).toBeCloseTo(125, 12)
  })
})

describe('revenueSegmentConfidence', () => {
  it('is low under 100 visitors or under 3 buyers', () => {
    expect(revenueSegmentConfidence(99, 50)).toBe('low')
    expect(revenueSegmentConfidence(5_000, 2)).toBe('low')
    expect(revenueSegmentConfidence(20, 0)).toBe('low')
  })

  it('is high at 1,000 visitors and 10 buyers, both', () => {
    expect(revenueSegmentConfidence(1_000, 10)).toBe('high')
    expect(revenueSegmentConfidence(50_000, 400)).toBe('high')
  })

  it('is medium in between', () => {
    expect(revenueSegmentConfidence(100, 3)).toBe('medium')
    expect(revenueSegmentConfidence(999, 50)).toBe('medium')
    expect(revenueSegmentConfidence(5_000, 9)).toBe('medium')
  })
})

describe('the hidden threshold', () => {
  it('shows a segment from 20 visitors, never below', () => {
    expect(isRevenueSegmentShown(19)).toBe(false)
    expect(isRevenueSegmentShown(0)).toBe(false)
    expect(isRevenueSegmentShown(20)).toBe(true)
  })

  it('leaves sub-threshold segments out of the ranking, buyers or not', () => {
    const site = { visitors: 1_000, buyers: 20, orders: 20, revenueMinor: 100_000 }
    const ranked = rankRevenueSegments(
      [
        segment({
          source: 'tiny.example',
          visitors: 19,
          buyers: 5,
          orders: 5,
          revenueMinor: 90_000,
        }),
        segment({ source: 'shown.example', visitors: 20, buyers: 0 }),
      ],
      site,
    )
    expect(ranked.map((row) => row.source)).toEqual(['shown.example'])
  })
})

describe('insufficient data', () => {
  it('needs 10 attributed buyers in the range', () => {
    expect(revenueSegmentsStatus({ visitors: 10_000, buyers: 9 })).toBe('insufficient_data')
    expect(revenueSegmentsStatus({ visitors: 10_000, buyers: 10 })).toBe('ok')
  })

  it('needs visitors too: buyers whose visits all fell before the range have no rate', () => {
    expect(revenueSegmentsStatus({ visitors: 0, buyers: 40 })).toBe('insufficient_data')
  })
})

describe('revenueSiteRates', () => {
  it('is buyers and revenue over visitors, null with no visitors', () => {
    expect(revenueSiteRates({ visitors: 2_000, buyers: 40, revenueMinor: 100_000 })).toEqual({
      conversionRate: 0.02,
      valuePerVisitorMinor: 50,
    })
    expect(revenueSiteRates({ visitors: 0, buyers: 0, revenueMinor: 0 })).toEqual({
      conversionRate: null,
      valuePerVisitorMinor: null,
    })
  })
})

describe('scoreRevenueSegment', () => {
  const prior = { conversionRate: 0.02, valuePerVisitorMinor: 50 }

  it('reports raw and smoothed side by side, with AOV and confidence', () => {
    const score = scoreRevenueSegment(
      segment({ visitors: 40, buyers: 2, orders: 2, revenueMinor: 20_000 }),
      prior,
    )
    expect(score.conversionRate).toBe(0.05)
    expect(score.smoothedConversionRate).toBeCloseTo((2 + 4) / 240, 12)
    expect(score.averageOrderValueMinor).toBe(10_000)
    expect(score.valuePerVisitorMinor).toBe(500)
    expect(score.smoothedValuePerVisitorMinor).toBeCloseTo(125, 12)
    expect(score.confidence).toBe('low')
  })

  it('divides AOV by the converted orders only: unconverted ones are not in the revenue', () => {
    // 5 orders, 1 with no exchange rate: the 3,800 is the revenue of the other
    // 4, so the average order is 950, not 760.
    const score = scoreRevenueSegment(
      segment({ visitors: 40, buyers: 5, orders: 5, revenueMinor: 3_800, unconvertedOrders: 1 }),
      prior,
    )
    expect(score.averageOrderValueMinor).toBe(950)
  })

  it('has no AOV when every order is unconverted', () => {
    const score = scoreRevenueSegment(
      segment({ visitors: 40, buyers: 2, orders: 2, revenueMinor: 0, unconvertedOrders: 2 }),
      prior,
    )
    expect(score.averageOrderValueMinor).toBeNull()
  })

  it('has no raw rates and no AOV where there is nothing to divide by', () => {
    const score = scoreRevenueSegment(segment({ visitors: 0 }), prior)
    expect(score.conversionRate).toBeNull()
    expect(score.valuePerVisitorMinor).toBeNull()
    expect(score.averageOrderValueMinor).toBeNull()
    expect(score.smoothedConversionRate).toBe(0.02)
    expect(score.smoothedValuePerVisitorMinor).toBe(50)
  })
})

describe('rankRevenueSegments', () => {
  it('sorts by smoothed value per visitor, so a lucky small segment does not top a proven one', () => {
    const site = { visitors: 10_000, buyers: 200, orders: 200, revenueMinor: 500_000 }
    // Site-wide: 2% and 50 per visitor.
    const ranked = rankRevenueSegments(
      [
        // Raw 1,000 per visitor, but 25 visitors: smoothed (25,000 + 10,000) / 225 ≈ 156.
        segment({
          source: 'lucky.example',
          visitors: 25,
          buyers: 1,
          orders: 1,
          revenueMinor: 25_000,
        }),
        // Raw 200 per visitor over 5,000 visitors: smoothed ≈ 193.
        segment({
          source: 'proven.example',
          visitors: 5_000,
          buyers: 150,
          orders: 160,
          revenueMinor: 1_000_000,
        }),
        // Nothing sold: pulled up from 0 toward 50, still last.
        segment({ source: 'none.example', visitors: 300, buyers: 0 }),
      ],
      site,
    )
    expect(ranked.map((row) => row.source)).toEqual([
      'proven.example',
      'lucky.example',
      'none.example',
    ])
    expect(ranked[0]?.confidence).toBe('high')
    expect(ranked[1]?.valuePerVisitorMinor).toBe(1_000)
    expect(ranked[1]?.smoothedValuePerVisitorMinor).toBeCloseTo(35_000 / 225, 12)
    expect(ranked[2]?.smoothedValuePerVisitorMinor).toBeCloseTo(10_000 / 500, 12)
  })

  it('breaks ties by visitors, then by the segment key, so the order is stable', () => {
    const site = { visitors: 1_000, buyers: 10, orders: 10, revenueMinor: 0 }
    const ranked = rankRevenueSegments(
      [
        segment({ source: 'b.example', visitors: 50 }),
        segment({ source: 'a.example', visitors: 50 }),
        segment({ source: 'c.example', visitors: 80 }),
      ],
      site,
    )
    // No revenue anywhere: every smoothed value is 0, so the bigger segment
    // leads and equal ones read alphabetically.
    expect(ranked.map((row) => row.source)).toEqual(['c.example', 'a.example', 'b.example'])
  })
})

describe('a lone hidden segment never stands alone', () => {
  // With one segment hidden, the site totals minus the shown segments would
  // be that segment's own counts. So the smallest shown one is withheld with
  // it, and there are always at least two unknowns in the subtraction.
  const ranked = [
    segment({ source: 'big.example', visitors: 900 }),
    segment({ source: 'small.example', visitors: 25 }),
    segment({ source: 'mid.example', visitors: 300 }),
  ]

  it('withholds the smallest shown segment when exactly one is hidden', () => {
    const out = withholdBesideLoneHidden(ranked, 1)
    expect(out.segments.map((row) => row.source)).toEqual(['big.example', 'mid.example'])
    expect(out.hidden).toBe(2)
  })

  it('leaves the list alone with none hidden, or with two or more', () => {
    for (const hidden of [0, 2, 7]) {
      const out = withholdBesideLoneHidden(ranked, hidden)
      expect(out.segments).toEqual(ranked)
      expect(out.hidden).toBe(hidden)
    }
  })

  it('withholds the lower-ranked of two equally small segments, and keeps the order', () => {
    const tied = [
      segment({ source: 'a.example', visitors: 40 }),
      segment({ source: 'b.example', visitors: 500 }),
      segment({ source: 'c.example', visitors: 40 }),
    ]
    expect(withholdBesideLoneHidden(tied, 1).segments.map((row) => row.source)).toEqual([
      'a.example',
      'b.example',
    ])
  })

  it('has nothing to withhold when nothing is shown', () => {
    expect(withholdBesideLoneHidden([], 1)).toEqual({ segments: [], hidden: 1 })
  })
})
