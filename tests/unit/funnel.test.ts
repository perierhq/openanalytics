import { describe, expect, it } from 'vitest'
import {
  computeFunnel,
  funnelConfigSchema,
  funnelPagePatternToLike,
  funnelPropertyText,
  funnelStepsSchema,
  parseFunnelStep,
  resolveFunnelUnits,
  type FunnelEvent,
} from '@openanalytics/domain'

/**
 * The pure funnel matcher (docs snapshot 02 §15; plan Milestone 8 item 7 and
 * acceptance criterion 4). This is the reference the ClickHouse `windowFunnel`
 * operation mirrors, and the place the deterministic `(occurred_at, event_id)`
 * tie-break is proven — the migration test asserts ClickHouse agrees on seeded
 * data.
 */

const ev = (
  unitKey: string,
  occurredMs: number,
  eventId: string,
  stepKey: string,
): FunnelEvent => ({ unitKey, occurredMs, eventId, stepKey })

describe('computeFunnel', () => {
  const steps = ['/pricing', 'signup_started', 'signup']

  it('counts units reaching each ordered step and derives conversion rates', () => {
    const events: FunnelEvent[] = [
      // unit A completes all three, in order.
      ev('A', 0, 'a1', '/pricing'),
      ev('A', 1_000, 'a2', 'signup_started'),
      ev('A', 2_000, 'a3', 'signup'),
      // unit B reaches step 2 only.
      ev('B', 0, 'b1', '/pricing'),
      ev('B', 1_000, 'b2', 'signup_started'),
      // unit C reaches step 1 only.
      ev('C', 0, 'c1', '/pricing'),
    ]
    const result = computeFunnel(events, { steps, windowMs: 60_000 })
    expect(result.map((r) => r.count)).toEqual([3, 2, 1])
    expect(result[0]!.conversionRate).toBe(1)
    expect(result[1]!.conversionRate).toBeCloseTo(2 / 3)
    expect(result[2]!.conversionRate).toBeCloseTo(1 / 3)
  })

  it('requires steps in order — a later step before an earlier one does not count', () => {
    const events: FunnelEvent[] = [
      ev('A', 0, 'a1', 'signup'), // step 3 arrives first
      ev('A', 1_000, 'a2', '/pricing'), // then step 1
    ]
    // Only step 1 is reached: the out-of-order step-3 event cannot complete.
    expect(computeFunnel(events, { steps, windowMs: 60_000 }).map((r) => r.count)).toEqual([
      1, 0, 0,
    ])
  })

  it('enforces the conversion window from the chain start', () => {
    const events: FunnelEvent[] = [
      ev('A', 0, 'a1', '/pricing'),
      ev('A', 5_000, 'a2', 'signup_started'), // within window
      ev('A', 200_000, 'a3', 'signup'), // beyond the 60s window from start
    ]
    expect(computeFunnel(events, { steps, windowMs: 60_000 }).map((r) => r.count)).toEqual([
      1, 1, 0,
    ])
  })

  it('is deterministic on an exact-millisecond tie, broken by event_id', () => {
    // Two events share a timestamp; the (occurred_at, event_id) order puts the
    // step-1 event first, so the chain completes. The result must not depend on
    // input order.
    const forward: FunnelEvent[] = [
      ev('A', 1000, 'e1', '/pricing'),
      ev('A', 1000, 'e2', 'signup_started'),
    ]
    const reversed = [...forward].reverse()
    const twoSteps = ['/pricing', 'signup_started']
    const a = computeFunnel(forward, { steps: twoSteps, windowMs: 60_000 })
    const b = computeFunnel(reversed, { steps: twoSteps, windowMs: 60_000 })
    expect(a).toEqual(b)
    expect(a.map((r) => r.count)).toEqual([1, 1])

    // If the tie-break put the later step's id first, the chain would not
    // complete — prove the order matters and is the ascending event-id one.
    const notLinked: FunnelEvent[] = [
      ev('A', 1000, 'z-late', 'signup_started'),
      ev('A', 1000, 'z-later', '/pricing'),
    ]
    expect(
      computeFunnel(notLinked, { steps: twoSteps, windowMs: 60_000 }).map((r) => r.count),
    ).toEqual([1, 0])
  })

  it('separates units — one visitor completing does not lift another', () => {
    const events: FunnelEvent[] = [
      ev('A', 0, 'a1', '/pricing'),
      ev('B', 1_000, 'b1', 'signup_started'), // B never did step 1
    ]
    expect(computeFunnel(events, { steps, windowMs: 60_000 }).map((r) => r.count)).toEqual([
      1, 0, 0,
    ])
  })

  it('returns zero counts and zero rates for an empty event set', () => {
    const result = computeFunnel([], { steps, windowMs: 60_000 })
    expect(result.map((r) => r.count)).toEqual([0, 0, 0])
    expect(result.map((r) => r.conversionRate)).toEqual([0, 0, 0])
  })
})

describe('funnelConfigSchema', () => {
  it('requires 2..8 steps and a bounded window', () => {
    expect(funnelConfigSchema.safeParse({ steps: ['/a'], windowMs: 1000 }).success).toBe(false)
    expect(
      funnelConfigSchema.safeParse({ steps: Array(9).fill('/a'), windowMs: 1000 }).success,
    ).toBe(false)
    expect(funnelConfigSchema.safeParse({ steps: ['/a', '/b'], windowMs: 0 }).success).toBe(false)
    const ok = funnelConfigSchema.safeParse({ steps: ['/a', '/b'], windowMs: 1_800_000 })
    expect(ok.success).toBe(true)
    expect(ok.success && ok.data.scope).toBe('visitor')
  })
})

describe('funnel step kinds', () => {
  const page = (unitKey: string, ms: number, id: string, path: string): FunnelEvent => ({
    unitKey,
    occurredMs: ms,
    eventId: id,
    stepKey: path,
    isPageView: true,
  })
  const event = (
    unitKey: string,
    ms: number,
    id: string,
    name: string,
    properties: Record<string, unknown> = {},
  ): FunnelEvent => ({ unitKey, occurredMs: ms, eventId: id, stepKey: name, properties })

  it('keeps a legacy key an exact match on path or name', () => {
    expect(parseFunnelStep('/pricing')).toEqual({
      ok: true,
      step: { kind: 'key', key: '/pricing' },
    })
    expect(parseFunnelStep('/de/search/*')).toEqual({
      ok: true,
      step: { kind: 'key', key: '/de/search/*' },
    })
  })

  it('parses page and event step objects and refuses malformed ones', () => {
    expect(parseFunnelStep('{"page":"/de/search/*"}')).toEqual({
      ok: true,
      step: { kind: 'page', pattern: '/de/search/*' },
    })
    expect(parseFunnelStep('{"event":"plan_selected","where":{"plan":"yearly"}}')).toEqual({
      ok: true,
      step: { kind: 'event', name: 'plan_selected', where: [{ key: 'plan', value: 'yearly' }] },
    })
    expect(parseFunnelStep('{"page":"no-slash"}').ok).toBe(false)
    expect(parseFunnelStep('{"page":"/a","event":"b"}').ok).toBe(false)
    expect(parseFunnelStep('{"event":"x","where":{"oa_metric":"1"}}').ok).toBe(false)
    expect(parseFunnelStep('{"event":"x","where":{"a":"1","b":"2","c":"3","d":"4"}}').ok).toBe(
      false,
    )
    expect(parseFunnelStep('{not json').ok).toBe(false)
    expect(funnelStepsSchema.safeParse(['/a', '{"page":"/b"}']).success).toBe(true)
    expect(funnelStepsSchema.safeParse(['/a', '{"page":1}']).success).toBe(false)
  })

  it('matches a wildcard page step on pageviews only', () => {
    const steps = ['{"page":"/de/search/*"}', 'checkout']
    const events = [
      page('A', 0, 'a1', '/de/search/berlin-munich'),
      event('A', 1_000, 'a2', 'checkout'),
      // B's matching path is a custom event name, not a pageview.
      event('B', 0, 'b1', '/de/search/x'),
      event('B', 1_000, 'b2', 'checkout'),
      page('C', 0, 'c1', '/en/search/x'),
    ]
    expect(computeFunnel(events, { steps, windowMs: 60_000 }).map((r) => r.count)).toEqual([1, 1])
  })

  it('treats LIKE metacharacters in a page pattern literally', () => {
    expect(funnelPagePatternToLike('/a_b%c/*')).toBe('/a\\_b\\%c/%')
    const steps = ['{"page":"/a_b"}', 'x']
    const events = [page('A', 0, 'a1', '/aXb'), event('A', 1, 'a2', 'x')]
    expect(computeFunnel(events, { steps, windowMs: 60_000 }).map((r) => r.count)).toEqual([0, 0])
  })

  it('applies property conditions, comparing numbers and booleans as JSON text', () => {
    const steps = ['/pricing', '{"event":"plan_selected","where":{"plan":"yearly","n":"2"}}']
    const events = [
      page('A', 0, 'a1', '/pricing'),
      event('A', 1_000, 'a2', 'plan_selected', { plan: 'yearly', n: 2 }),
      page('B', 0, 'b1', '/pricing'),
      event('B', 1_000, 'b2', 'plan_selected', { plan: 'monthly', n: 2 }),
    ]
    expect(computeFunnel(events, { steps, windowMs: 60_000 }).map((r) => r.count)).toEqual([2, 1])
    expect(funnelPropertyText(true)).toBe('true')
    expect(funnelPropertyText(null)).toBeNull()
  })

  it('folds anonymous ids into the identify hash they were paired with', () => {
    const unitOf = resolveFunnelUnits([
      { anonymousId: 'mon', userId: 'u1', occurredMs: 10 },
      { anonymousId: 'wed', userId: 'u1', occurredMs: 20 },
      { anonymousId: 'x', userId: '', occurredMs: 30 },
    ])
    expect([unitOf('mon'), unitOf('wed'), unitOf('x'), unitOf('anon')]).toEqual([
      'u1',
      'u1',
      'x',
      'anon',
    ])
    const steps = ['/pricing', 'purchase']
    const day = 86_400_000
    const events = [
      page(unitOf('mon'), 0, 'a1', '/pricing'),
      event(unitOf('wed'), 2 * day, 'a2', 'purchase'),
    ]
    expect(computeFunnel(events, { steps, windowMs: 7 * day }).map((r) => r.count)).toEqual([1, 1])
  })
})
