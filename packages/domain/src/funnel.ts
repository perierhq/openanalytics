import { propertyKeySchema } from '@openanalytics/contracts'
import { z } from 'zod'

/**
 * The canonical funnel definition and its pure reference matcher (docs snapshot
 * 02 §15 "dynamic funnels are computed over the session/event facts"; 04
 * Milestone 8 item 7 and acceptance criterion 4).
 *
 * Like `sessionize`, this is the reference implementation: a pure, deterministic
 * function of an event set, and the ClickHouse `windowFunnel` operation in the
 * gateway is written to mirror it. The pure function is what the deterministic
 * tie-break is proven against (acceptance criterion 4 is a unit test), and the
 * migration test asserts the ClickHouse operation agrees with it on seeded data.
 *
 * ## Semantics
 *
 * A funnel is an ordered list of **steps**, each a string key an event matches.
 * Events are grouped into **units** (the aggregation scope), each unit's events
 * are ordered by `(occurred_at, event_id)` — the same total order the sessionizer
 * uses, so an exact-millisecond tie is broken deterministically by `event_id` —
 * and a unit's **level** is the longest ordered prefix of steps it completes such
 * that the whole chain, from the first step to the last, fits inside `windowMs`.
 * This is exactly ClickHouse `windowFunnel(window)(t, cond1, …, condN)` in its
 * default mode: steps must occur in order, and the window is measured from the
 * chain's first matched event.
 *
 * The funnel result is, per step `k` (1-based), the number of units that reached
 * at least level `k`; step 1 is the funnel entry and conversion to step `k` is
 * `count_k / count_1`. Counts are non-increasing down the funnel, which is a
 * structural property the matcher guarantees (a unit at level `k` is at every
 * lower level too).
 *
 * ## Scope (unit) — same-session vs same-visitor
 *
 * The D-102 anonymous id is the visitor (ADR-0036 D3: unit-counting reads key
 * on the anonymous id; the funnel population — page_view/custom_event/
 * conversion — never carries a `user_id` itself). Two scopes are offered, both
 * computable from `events_raw`:
 *
 *   - **`visitor`** — the unit is the anonymous id, or the identify hash it was
 *     paired with (below). The whole funnel is one person's journey across
 *     visits, bounded only by `windowMs`.
 *   - **`session`** — the unit is `(anonymous id, client session hint)`. The
 *     hint (`events_raw.session_id`, the site-scoped HMAC of the tracker's
 *     `client_session_id`) approximates a browser session; pairing it with the
 *     identity stops two visitors who reused a hint value from being merged.
 *
 * **Visitor scope folds the identify hash in where one exists.** The anonymous id
 * rotates at UTC midnight, so a funnel keyed on it alone splits every multi-day
 * journey into one unit per day. An `identify` event pairs the day's anonymous id
 * with the stable `identify()` HMAC (`events_raw.user_id`, set on identify rows
 * only), and the operation maps every anonymous id that has such a pairing to
 * that hash: a signed-in person's days become one unit, an anonymous visitor's
 * unit is unchanged. It is the same resolved identity
 * `revenue_attributions.visitor_id` carries, which is what lets a step's units be
 * joined to the buyers among them. The pure matcher takes the unit key as given,
 * so the mapping is the caller's (`resolveFunnelUnits` below is its reference).
 *
 * ## Step kinds
 *
 * A step is a string, stored and sent exactly as before, in one of two forms:
 *
 *   - **a key** (every funnel saved before step kinds existed): matched against
 *     the page path of a pageview and the name of any other event, exactly.
 *   - **a JSON step object**, recognised by its leading `{` — no key can start
 *     with one, because a page path starts with `/` and an event name with a
 *     letter or digit (`eventNameSchema`):
 *       `{"page":"/de/search/*"}` — a pageview whose path matches, `*` matching
 *       any run of characters (slashes included);
 *       `{"event":"plan_selected","where":{"plan":"yearly"}}` — a custom event
 *       or conversion with that name whose properties equal every listed value.
 *       A number or boolean property is compared as its JSON text (`12`,
 *       `true`), the same text the property breakdown reports.
 *
 * Keeping the step a string is the compatibility argument: the stored column,
 * the contract's `FunnelStepKeys`, the repeated `steps=` query parameter and the
 * response's `key` all keep their shape, so an old client reads a new funnel's
 * steps as opaque keys rather than failing to parse them.
 *
 * The `session` scope is the client-hint session, **not** the canonical 30-minute
 * sessionizer session: `session_facts_versions` stores per-session aggregates, not
 * the ordered event sequence a step funnel needs, so a canonical-session funnel
 * would need a different fact shape. The hint plus the `windowMs` bound is a sound
 * bounded approximation; a canonical-session funnel is a documented follow-up
 * (ADR-0012). The `windowMs` default matches the session inactivity for `session`
 * scope and is caller-set for `visitor` scope.
 */

/** The most steps a single funnel may declare; the gateway operation is fixed-width. */
export const MAX_FUNNEL_STEPS = 8
/** The fewest steps a funnel needs to be a funnel. */
export const MIN_FUNNEL_STEPS = 2

/** How events are grouped into funnel units. */
export const FUNNEL_SCOPES = ['visitor', 'session'] as const
export type FunnelScope = (typeof FUNNEL_SCOPES)[number]

/** Longest conversion window a funnel may span, in ms (30 days). Bounds the read. */
export const MAX_FUNNEL_WINDOW_MS = 30 * 86_400_000

/**
 * Longest `[from, to)` a funnel may scan synchronously, in ms (92 days). A funnel
 * reads `events_raw` rather than a rollup, so its range is capped tighter than the
 * rollup reads; §15 allows an async job for a larger range, which is a documented
 * follow-up (ADR-0012). The gateway operation and the API resolver both enforce
 * this so a caller gets a typed refusal, not a slow scan.
 */
export const MAX_FUNNEL_RANGE_MS = 92 * 86_400_000

/** Longest a single step key may be. A page path or a custom event name. */
export const FUNNEL_STEP_KEY_MAX_LENGTH = 512

/**
 * The ordered step keys, bounded.
 *
 * Extracted so the ad-hoc compute schema below and the stored-definition schemas
 * further down cannot drift apart: a definition that passes validation on save
 * must be one the compute endpoint will accept when it is run, and two copies of
 * these bounds is exactly how that stops being true.
 */
export const funnelStepsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(FUNNEL_STEP_KEY_MAX_LENGTH)
      .superRefine((raw, ctx) => {
        const parsed = parseFunnelStep(raw)
        if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.reason })
      }),
  )
  .min(MIN_FUNNEL_STEPS)
  .max(MAX_FUNNEL_STEPS)

/** Most property conditions one event step may carry; the gateway's slots are fixed. */
export const MAX_FUNNEL_STEP_CONDITIONS = 3

/** One `key = value` condition on an event step's properties. */
export interface FunnelStepCondition {
  readonly key: string
  readonly value: string
}

/**
 * A parsed step. `key` is the legacy form, matched exactly against a pageview's
 * path or another event's name; `page` carries the path pattern with its `*`
 * wildcards; `event` carries a name and its property conditions.
 */
export type FunnelStepSpec =
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'page'; readonly pattern: string }
  | {
      readonly kind: 'event'
      readonly name: string
      readonly where: readonly FunnelStepCondition[]
    }

const funnelStepObjectSchema = z.union([
  z.strictObject({
    page: z.string().min(1).max(FUNNEL_STEP_KEY_MAX_LENGTH).startsWith('/'),
  }),
  z.strictObject({
    event: z.string().min(1).max(64),
    where: z
      .record(propertyKeySchema, z.string().max(256))
      .refine((value) => Object.keys(value).length <= MAX_FUNNEL_STEP_CONDITIONS, {
        message: `at most ${MAX_FUNNEL_STEP_CONDITIONS} property conditions per step`,
      })
      .optional(),
  }),
])

/**
 * Parses one stored or requested step string. Total: a malformed JSON step is a
 * typed refusal, never a throw, so the schema above can report it as an issue.
 */
export function parseFunnelStep(
  raw: string,
): { ok: true; step: FunnelStepSpec } | { ok: false; reason: string } {
  if (!raw.startsWith('{')) return { ok: true, step: { kind: 'key', key: raw } }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'a step starting with { must be a JSON step object' }
  }
  const parsed = funnelStepObjectSchema.safeParse(json)
  if (!parsed.success) {
    return {
      ok: false,
      reason: `invalid step object: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    }
  }
  const value = parsed.data
  if ('page' in value) return { ok: true, step: { kind: 'page', pattern: value.page } }
  return {
    ok: true,
    step: {
      kind: 'event',
      name: value.event,
      where: Object.entries(value.where ?? {}).map(([key, v]) => ({ key, value: v })),
    },
  }
}

/**
 * A page pattern as a ClickHouse `LIKE` pattern: `\`, `%` and `_` escaped, `*`
 * turned into `%`. A pattern without `*` is therefore an exact match.
 */
export function funnelPagePatternToLike(pattern: string): string {
  return pattern.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '%')
}

function pagePatternMatches(pattern: string, path: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 's').test(path)
}

/**
 * A property value as a step condition compares it: a string as itself, a
 * number or boolean as its JSON text. Mirrors the gateway's expression.
 */
export function funnelPropertyText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  return null
}

export const funnelConfigSchema = z
  .object({
    scope: z.enum(FUNNEL_SCOPES).default('visitor'),
    steps: funnelStepsSchema,
    windowMs: z.coerce.number().int().min(1).max(MAX_FUNNEL_WINDOW_MS),
  })
  .strict()

export type FunnelConfig = z.infer<typeof funnelConfigSchema>

/**
 * Longest accepted funnel display name, in characters, after trimming. The same
 * bound a site name carries (`SITE_NAME_MAX_LENGTH`): both are display names
 * typed into the same dashboard, and a different limit on each would be an
 * arbitrary distinction a user would discover only by hitting it.
 */
export const FUNNEL_NAME_MAX_LENGTH = 200

const funnelNameSchema = z.string().trim().min(1).max(FUNNEL_NAME_MAX_LENGTH)

const funnelWindowMsSchema = z.number().int().min(1).max(MAX_FUNNEL_WINDOW_MS)

/**
 * The request bodies for stored funnel definitions.
 *
 * Written in the wire's snake_case rather than the domain's camelCase, because
 * they parse an HTTP body directly — `funnelConfigSchema` remaps by hand in the
 * compute endpoint precisely because it is fed query parameters instead. `apps/api`
 * carries no zod dependency of its own (docs snapshot: the contract's schemas are
 * the API's validators), so these live here with the bounds they enforce.
 *
 * Saving a definition does not compute it. These schemas therefore say nothing
 * about `from`/`to`: a stored funnel carries no range, and the 92-day synchronous
 * scan cap (`MAX_FUNNEL_RANGE_MS`) is still decided per computation by the
 * analytics endpoint.
 */
export const createFunnelRequestSchema = z.strictObject({
  name: funnelNameSchema,
  steps: funnelStepsSchema,
  scope: z.enum(FUNNEL_SCOPES).default('visitor'),
  window_ms: funnelWindowMsSchema,
})

export type CreateFunnelRequest = z.infer<typeof createFunnelRequestSchema>

/**
 * A partial update. At least one field must be present: an empty patch is
 * refused rather than treated as a no-op, the same judgement
 * `PATCH /v1/sites/{site_id}` makes — a save that changed nothing is far more
 * likely a client bug than an intention.
 */
export const updateFunnelRequestSchema = z
  .strictObject({
    name: funnelNameSchema.optional(),
    steps: funnelStepsSchema.optional(),
    scope: z.enum(FUNNEL_SCOPES).optional(),
    window_ms: funnelWindowMsSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one of name, steps, scope or window_ms is required',
  })

export type UpdateFunnelRequest = z.infer<typeof updateFunnelRequestSchema>

/** A single event the funnel matcher consumes. `stepKey` is the matched key. */
export interface FunnelEvent {
  /** The aggregation unit this event belongs to (visitor or session identity). */
  readonly unitKey: string
  readonly occurredMs: number
  readonly eventId: string
  /** The event's funnel key: page_path for a pageview, event name otherwise. */
  readonly stepKey: string
  /** Whether the event is a pageview; only `page` steps need it. Default: not. */
  readonly isPageView?: boolean
  /** The event's properties; only `event` steps with conditions read them. */
  readonly properties?: Readonly<Record<string, unknown>>
}

/** Whether an event matches one parsed step — the reference for the SQL slot. */
export function funnelStepMatches(step: FunnelStepSpec, event: FunnelEvent): boolean {
  switch (step.kind) {
    case 'key':
      return event.stepKey === step.key
    case 'page':
      return event.isPageView === true && pagePatternMatches(step.pattern, event.stepKey)
    case 'event':
      return (
        event.isPageView !== true &&
        event.stepKey === step.name &&
        step.where.every(
          (condition) => funnelPropertyText(event.properties?.[condition.key]) === condition.value,
        )
      )
  }
}

/**
 * The visitor-scope unit of each anonymous id: the identify hash it was paired
 * with, the latest pairing winning, or the anonymous id itself. The reference
 * for the gateway's identity map.
 */
export function resolveFunnelUnits(
  identifies: readonly { anonymousId: string; userId: string; occurredMs: number }[],
): (anonymousId: string) => string {
  const latest = new Map<string, { userId: string; occurredMs: number }>()
  for (const pairing of identifies) {
    if (pairing.userId === '') continue
    const seen = latest.get(pairing.anonymousId)
    if (seen === undefined || pairing.occurredMs >= seen.occurredMs) {
      latest.set(pairing.anonymousId, pairing)
    }
  }
  return (anonymousId) => latest.get(anonymousId)?.userId ?? anonymousId
}

/** One row of a funnel result. */
export interface FunnelStepResult {
  /** 1-based step index. */
  readonly step: number
  readonly key: string
  /** Units that reached at least this step. */
  readonly count: number
  /** count / step-1 count, in `[0, 1]`; 1 for step 1 (0 if the funnel is empty). */
  readonly conversionRate: number
}

/**
 * Computes a unit's funnel level under default `windowFunnel` semantics.
 *
 * `eventTs[i]` holds the chain-start timestamp of the best chain that has reached
 * stage `i`; advancing to stage `i` requires the current event to match step `i`
 * and to fall within `windowMs` of that chain start. The inner loop runs stages
 * high-to-low so a single event never advances two stages at once — the same
 * guard ClickHouse's implementation uses.
 */
function unitLevel(
  sortedEvents: readonly FunnelEvent[],
  steps: readonly FunnelStepSpec[],
  windowMs: number,
): number {
  const eventTs: number[] = new Array(steps.length).fill(Number.NaN)
  for (const event of sortedEvents) {
    for (let stage = steps.length - 1; stage >= 0; stage -= 1) {
      if (!funnelStepMatches(steps[stage]!, event)) continue
      if (stage === 0) {
        eventTs[0] = event.occurredMs
      } else if (
        !Number.isNaN(eventTs[stage - 1]!) &&
        event.occurredMs - eventTs[stage - 1]! <= windowMs
      ) {
        eventTs[stage] = eventTs[stage - 1]!
      }
    }
  }
  let level = 0
  for (let i = 0; i < steps.length; i += 1) {
    if (!Number.isNaN(eventTs[i]!)) level = i + 1
  }
  return level
}

/** Deterministic total order: occurred time, then event id (§10 tie-break). */
function compareFunnelEvents(a: FunnelEvent, b: FunnelEvent): number {
  if (a.occurredMs !== b.occurredMs) return a.occurredMs - b.occurredMs
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0
}

/**
 * The pure funnel matcher. Groups events into units, orders each unit
 * deterministically, computes each unit's level, and returns per-step unit
 * counts and conversion rates.
 *
 * Pure and total: it never throws and never reads a clock. The same event set, in
 * any arrival order, yields identical results.
 */
export function computeFunnel(
  events: readonly FunnelEvent[],
  config: Pick<FunnelConfig, 'steps' | 'windowMs'>,
): FunnelStepResult[] {
  const byUnit = new Map<string, FunnelEvent[]>()
  for (const event of events) {
    const unit = byUnit.get(event.unitKey)
    if (unit === undefined) byUnit.set(event.unitKey, [event])
    else unit.push(event)
  }

  // An unparseable step matches nothing rather than throwing: the function is
  // total, and the schema is where a bad step is refused.
  const specs = config.steps.map((raw) => {
    const parsed = parseFunnelStep(raw)
    return parsed.ok ? parsed.step : ({ kind: 'event', name: '', where: [] } as const)
  })
  const counts = new Array(config.steps.length).fill(0)
  for (const unitEvents of byUnit.values()) {
    const sorted = [...unitEvents].sort(compareFunnelEvents)
    const level = unitLevel(sorted, specs, config.windowMs)
    for (let i = 0; i < level; i += 1) counts[i] += 1
  }

  const entry = counts[0] ?? 0
  return config.steps.map((key, index) => ({
    step: index + 1,
    key,
    count: counts[index] as number,
    conversionRate: entry > 0 ? (counts[index] as number) / entry : 0,
  }))
}
