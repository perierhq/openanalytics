import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Database, Executor } from '../client.ts'
import { writeAudit } from './audit.ts'
import {
  eventDefinitionVersions,
  eventDefinitions,
  type EventDefinitionPropertySchemaEntry,
  type EventDefinitionStatus,
  type StoredNoCodeRule,
} from '../schema/event-definitions.ts'
import { sites } from '../schema/sites.ts'

/**
 * Dashboard-defined custom events (migration 0038; ADR-0034, D3/D4).
 *
 * Every function takes `siteId` and puts it in the `WHERE`, for the reason the
 * funnels repository states: a caller authorized on one site must not reach
 * another site's definition by holding its id.
 *
 * Two invariants live here rather than in the API, because they are only
 * expressible inside a transaction:
 *
 * 1. **Version numbers are allocated, not chosen.** `max(version) + 1` under the
 *    `(definition_id, version)` unique constraint, so two concurrent saves
 *    cannot both become v3.
 * 2. **Publishing bumps `sites.config_version` in the same transaction as the
 *    pointer move.** The epoch is what the tracker-config ETag is built from
 *    (`apps/collector/src/tracker-config.ts`), so a publish that committed
 *    without it would be a rule set no browser could learn about until some
 *    unrelated settings change happened to bump the counter. ADR-0034 D4 accepts
 *    that this also flushes the site's analytics query cache: rule publishes are
 *    human-paced, and two counters that can disagree is what migration 0014
 *    rejected.
 */

export interface EventDefinitionVersionRecord {
  readonly id: string
  readonly definitionId: string
  readonly version: number
  readonly displayName: string
  readonly description: string | null
  readonly category: string | null
  readonly propertySchema: readonly EventDefinitionPropertySchemaEntry[]
  readonly displayTemplate: string | null
  readonly rules: readonly StoredNoCodeRule[]
  readonly sourceVersion: number | null
  readonly createdByUserId: string | null
  readonly createdAt: Date
}

export interface EventDefinitionRecord {
  readonly id: string
  readonly siteId: string
  readonly eventName: string
  readonly status: EventDefinitionStatus
  readonly publishedVersion: number | null
  readonly createdByUserId: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly archivedAt: Date | null
}

/** Explicit projections, so a column added later does not silently widen a response. */
const definitionColumns = {
  id: eventDefinitions.id,
  siteId: eventDefinitions.siteId,
  eventName: eventDefinitions.eventName,
  status: eventDefinitions.status,
  publishedVersion: eventDefinitions.publishedVersion,
  createdByUserId: eventDefinitions.createdByUserId,
  createdAt: eventDefinitions.createdAt,
  updatedAt: eventDefinitions.updatedAt,
  archivedAt: eventDefinitions.archivedAt,
}

const versionColumns = {
  id: eventDefinitionVersions.id,
  definitionId: eventDefinitionVersions.definitionId,
  version: eventDefinitionVersions.version,
  displayName: eventDefinitionVersions.displayName,
  description: eventDefinitionVersions.description,
  category: eventDefinitionVersions.category,
  propertySchema: eventDefinitionVersions.propertySchema,
  displayTemplate: eventDefinitionVersions.displayTemplate,
  rules: eventDefinitionVersions.rules,
  sourceVersion: eventDefinitionVersions.sourceVersion,
  createdByUserId: eventDefinitionVersions.createdByUserId,
  createdAt: eventDefinitionVersions.createdAt,
}

/** The content half of a version — everything a save restates in full. */
export interface EventDefinitionVersionContent {
  readonly displayName: string
  readonly description?: string | null
  readonly category?: string | null
  readonly propertySchema?: readonly EventDefinitionPropertySchemaEntry[]
  readonly displayTemplate?: string | null
  readonly rules?: readonly StoredNoCodeRule[]
}

/**
 * Inserts the next version of a definition.
 *
 * `max(version) + 1` read inside the caller's transaction. Two writers racing
 * both read the same maximum and both attempt the same number; the unique
 * constraint makes exactly one of them succeed, and the caller retries. That is
 * the determinism ADR-0034 D3 promises — it comes from the constraint, not from
 * the read.
 */
async function insertVersion(
  tx: Executor,
  input: {
    readonly definitionId: string
    readonly content: EventDefinitionVersionContent
    readonly sourceVersion?: number | null
    readonly createdByUserId?: string | undefined
  },
): Promise<EventDefinitionVersionRecord> {
  const [row] = await tx
    .insert(eventDefinitionVersions)
    .values({
      definitionId: input.definitionId,
      version: sql`(
        SELECT coalesce(max(v.version), 0) + 1
        FROM event_definition_versions v
        WHERE v.definition_id = ${input.definitionId}
      )`,
      displayName: input.content.displayName,
      description: input.content.description ?? null,
      category: input.content.category ?? null,
      propertySchema: [...(input.content.propertySchema ?? [])],
      displayTemplate: input.content.displayTemplate ?? null,
      rules: [...(input.content.rules ?? [])],
      sourceVersion: input.sourceVersion ?? null,
      ...(input.createdByUserId === undefined ? {} : { createdByUserId: input.createdByUserId }),
    })
    .returning(versionColumns)
  if (!row) throw new Error('event definition version insert returned no row')
  return row
}

/** Bumps the site's shared config epoch (ADR-0030 D6; ADR-0034 D4). */
async function bumpConfigVersion(tx: Executor, siteId: string): Promise<number> {
  const [row] = await tx
    .update(sites)
    .set({ configVersion: sql`${sites.configVersion} + 1`, updatedAt: new Date() })
    .where(eq(sites.id, siteId))
    .returning({ configVersion: sites.configVersion })
  if (!row) throw new Error('config version bump matched no site')
  return row.configVersion
}

export interface ListEventDefinitionsOptions {
  /** Include archived definitions. Default false — archived is the delete. */
  readonly includeArchived?: boolean
}

/** A site's definitions, newest first, with `id` as the tie-break so an
 * unchanged list does not reorder between two reads. */
export async function listEventDefinitions(
  db: Database,
  siteId: string,
  options: ListEventDefinitionsOptions = {},
): Promise<EventDefinitionRecord[]> {
  const scoped = options.includeArchived
    ? eq(eventDefinitions.siteId, siteId)
    : and(eq(eventDefinitions.siteId, siteId), isNull(eventDefinitions.archivedAt))

  return db
    .select(definitionColumns)
    .from(eventDefinitions)
    .where(scoped)
    .orderBy(desc(eventDefinitions.createdAt), desc(eventDefinitions.id))
}

/** One definition, site-scoped: an id from another site reads as absent rather
 * than as a permission error. */
export async function getEventDefinition(
  db: Database,
  input: { readonly id: string; readonly siteId: string },
): Promise<EventDefinitionRecord | null> {
  const [row] = await db
    .select(definitionColumns)
    .from(eventDefinitions)
    .where(and(eq(eventDefinitions.id, input.id), eq(eventDefinitions.siteId, input.siteId)))
    .limit(1)
  return row ?? null
}

/** A definition's versions, oldest first — the order a history reads in. */
export async function listEventDefinitionVersions(
  db: Database,
  input: { readonly definitionId: string; readonly siteId: string },
): Promise<EventDefinitionVersionRecord[]> {
  return db
    .select(versionColumns)
    .from(eventDefinitionVersions)
    .innerJoin(eventDefinitions, eq(eventDefinitions.id, eventDefinitionVersions.definitionId))
    .where(
      and(
        eq(eventDefinitionVersions.definitionId, input.definitionId),
        eq(eventDefinitions.siteId, input.siteId),
      ),
    )
    .orderBy(asc(eventDefinitionVersions.version))
}

export async function getEventDefinitionVersion(
  db: Database,
  input: { readonly definitionId: string; readonly siteId: string; readonly version: number },
): Promise<EventDefinitionVersionRecord | null> {
  const [row] = await db
    .select(versionColumns)
    .from(eventDefinitionVersions)
    .innerJoin(eventDefinitions, eq(eventDefinitions.id, eventDefinitionVersions.definitionId))
    .where(
      and(
        eq(eventDefinitionVersions.definitionId, input.definitionId),
        eq(eventDefinitions.siteId, input.siteId),
        eq(eventDefinitionVersions.version, input.version),
      ),
    )
    .limit(1)
  return row ?? null
}

export interface CreateEventDefinitionInput {
  readonly siteId: string
  readonly eventName: string
  readonly content: EventDefinitionVersionContent
  readonly createdByUserId?: string
}

/**
 * Creates a definition and its v1 in one transaction.
 *
 * The version is *not* published: creating a definition and turning it on are
 * two acts, and a definition that started live would put unreviewed rules into
 * every visitor's browser as a side effect of pressing Save. No
 * `config_version` bump for the same reason — nothing the collector serves has
 * changed yet.
 */
export async function createEventDefinition(
  db: Database,
  input: CreateEventDefinitionInput,
): Promise<{ definition: EventDefinitionRecord; version: EventDefinitionVersionRecord }> {
  return db.transaction(async (tx) => {
    const [definition] = await tx
      .insert(eventDefinitions)
      .values({
        siteId: input.siteId,
        eventName: input.eventName,
        ...(input.createdByUserId === undefined ? {} : { createdByUserId: input.createdByUserId }),
      })
      .returning(definitionColumns)
    if (!definition) throw new Error('event definition insert returned no row')

    const version = await insertVersion(tx, {
      definitionId: definition.id,
      content: input.content,
      ...(input.createdByUserId === undefined ? {} : { createdByUserId: input.createdByUserId }),
    })

    await writeAudit(tx, {
      action: 'event_definition.created',
      actorUserId: input.createdByUserId ?? null,
      actorType: input.createdByUserId ? 'user' : 'system',
      siteId: input.siteId,
      targetType: 'event_definition',
      targetId: definition.id,
      // The event name is site-owned configuration the operator typed, not
      // visitor data. Rule selectors are not recorded: they are not needed to
      // answer "who changed this, and when", and a selector can carry a class
      // name that happens to contain an account identifier.
      metadata: { eventName: input.eventName, ruleCount: version.rules.length },
    })

    return { definition, version }
  })
}

export interface SaveEventDefinitionVersionInput {
  readonly id: string
  readonly siteId: string
  readonly content: EventDefinitionVersionContent
  readonly actorUserId?: string
}

/**
 * Saves a new draft version. Returns null when no live definition with this id
 * exists on this site.
 *
 * An archived definition is not editable, matching `updateFunnel`: editing
 * something taken out of the list is a change nobody can see, and it would let
 * an archived definition be quietly repurposed under a name whose historical
 * events already mean something else.
 */
export async function saveEventDefinitionVersion(
  db: Database,
  input: SaveEventDefinitionVersionInput,
): Promise<EventDefinitionVersionRecord | null> {
  return db.transaction(async (tx) => {
    const [definition] = await tx
      .select({ id: eventDefinitions.id })
      .from(eventDefinitions)
      .where(
        and(
          eq(eventDefinitions.id, input.id),
          eq(eventDefinitions.siteId, input.siteId),
          isNull(eventDefinitions.archivedAt),
        ),
      )
      .limit(1)
    if (!definition) return null

    const version = await insertVersion(tx, {
      definitionId: definition.id,
      content: input.content,
      ...(input.actorUserId === undefined ? {} : { createdByUserId: input.actorUserId }),
    })

    await tx
      .update(eventDefinitions)
      .set({ updatedAt: new Date() })
      .where(eq(eventDefinitions.id, definition.id))

    await writeAudit(tx, {
      action: 'event_definition.version_saved',
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorUserId ? 'user' : 'system',
      siteId: input.siteId,
      targetType: 'event_definition',
      targetId: definition.id,
      metadata: { version: version.version, ruleCount: version.rules.length },
    })

    return version
  })
}

export type PublishOutcome =
  | { readonly ok: true; readonly publishedVersion: number; readonly configVersion: number }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'unknown_version' }
  | { readonly ok: false; readonly reason: 'conflict'; readonly publishedVersion: number | null }

export interface PublishEventDefinitionInput {
  readonly id: string
  readonly siteId: string
  readonly version: number
  /**
   * The version the caller believes is live. `null` claims nothing is published.
   *
   * Checked rather than trusted: two admins publishing different drafts at the
   * same moment otherwise produce a silent last-write-wins, and the loser has no
   * way to know their publish was overwritten (ADR-0034, D3).
   */
  readonly expectedPublishedVersion: number | null
  readonly actorUserId?: string
}

/**
 * Publishes a version, bumping the site's config epoch in the same transaction.
 *
 * The row is locked `FOR UPDATE` before the expectation is compared, so the
 * check and the write cannot straddle another transaction's commit — without
 * it, two publishes could both read the same `published_version`, both find
 * their expectation satisfied, and both write.
 */
export async function publishEventDefinition(
  db: Database,
  input: PublishEventDefinitionInput,
): Promise<PublishOutcome> {
  return db.transaction(async (tx) => {
    const [definition] = await tx
      .select({ id: eventDefinitions.id, publishedVersion: eventDefinitions.publishedVersion })
      .from(eventDefinitions)
      .where(
        and(
          eq(eventDefinitions.id, input.id),
          eq(eventDefinitions.siteId, input.siteId),
          isNull(eventDefinitions.archivedAt),
        ),
      )
      .for('update')
      .limit(1)
    if (!definition) return { ok: false, reason: 'not_found' }

    if (definition.publishedVersion !== input.expectedPublishedVersion) {
      return { ok: false, reason: 'conflict', publishedVersion: definition.publishedVersion }
    }

    const [version] = await tx
      .select({ version: eventDefinitionVersions.version })
      .from(eventDefinitionVersions)
      .where(
        and(
          eq(eventDefinitionVersions.definitionId, definition.id),
          eq(eventDefinitionVersions.version, input.version),
        ),
      )
      .limit(1)
    if (!version) return { ok: false, reason: 'unknown_version' }

    await tx
      .update(eventDefinitions)
      .set({ publishedVersion: input.version, updatedAt: new Date() })
      .where(eq(eventDefinitions.id, definition.id))

    const configVersion = await bumpConfigVersion(tx, input.siteId)

    await writeAudit(tx, {
      action: 'event_definition.published',
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorUserId ? 'user' : 'system',
      siteId: input.siteId,
      targetType: 'event_definition',
      targetId: definition.id,
      metadata: {
        version: input.version,
        previousVersion: definition.publishedVersion,
        configVersion,
      },
    })

    return { ok: true, publishedVersion: input.version, configVersion }
  })
}

export interface RollbackEventDefinitionInput {
  readonly id: string
  readonly siteId: string
  /** The historical version whose content is copied forward. */
  readonly toVersion: number
  readonly expectedPublishedVersion: number | null
  readonly actorUserId?: string
}

export type RollbackOutcome =
  | {
      readonly ok: true
      readonly version: EventDefinitionVersionRecord
      readonly configVersion: number
    }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'unknown_version' }
  | { readonly ok: false; readonly reason: 'conflict'; readonly publishedVersion: number | null }

/**
 * Rolls back by copying an older version's content into a **new** version and
 * publishing that (ADR-0034, D3).
 *
 * History is never mutated and never rewound. `source_version` records where the
 * content came from, so an operator reading the version list sees "v3 is v1
 * again" rather than a gap.
 */
export async function rollbackEventDefinition(
  db: Database,
  input: RollbackEventDefinitionInput,
): Promise<RollbackOutcome> {
  return db.transaction(async (tx) => {
    const [definition] = await tx
      .select({ id: eventDefinitions.id, publishedVersion: eventDefinitions.publishedVersion })
      .from(eventDefinitions)
      .where(
        and(
          eq(eventDefinitions.id, input.id),
          eq(eventDefinitions.siteId, input.siteId),
          isNull(eventDefinitions.archivedAt),
        ),
      )
      .for('update')
      .limit(1)
    if (!definition) return { ok: false, reason: 'not_found' }

    if (definition.publishedVersion !== input.expectedPublishedVersion) {
      return { ok: false, reason: 'conflict', publishedVersion: definition.publishedVersion }
    }

    const [source] = await tx
      .select(versionColumns)
      .from(eventDefinitionVersions)
      .where(
        and(
          eq(eventDefinitionVersions.definitionId, definition.id),
          eq(eventDefinitionVersions.version, input.toVersion),
        ),
      )
      .limit(1)
    if (!source) return { ok: false, reason: 'unknown_version' }

    const copy = await insertVersion(tx, {
      definitionId: definition.id,
      content: {
        displayName: source.displayName,
        description: source.description,
        category: source.category,
        propertySchema: source.propertySchema,
        displayTemplate: source.displayTemplate,
        rules: source.rules,
      },
      sourceVersion: source.version,
      ...(input.actorUserId === undefined ? {} : { createdByUserId: input.actorUserId }),
    })

    await tx
      .update(eventDefinitions)
      .set({ publishedVersion: copy.version, updatedAt: new Date() })
      .where(eq(eventDefinitions.id, definition.id))

    const configVersion = await bumpConfigVersion(tx, input.siteId)

    await writeAudit(tx, {
      action: 'event_definition.rolled_back',
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorUserId ? 'user' : 'system',
      siteId: input.siteId,
      targetType: 'event_definition',
      targetId: definition.id,
      metadata: {
        sourceVersion: source.version,
        version: copy.version,
        previousVersion: definition.publishedVersion,
        configVersion,
      },
    })

    return { ok: true, version: copy, configVersion }
  })
}

/**
 * Archives a definition and, if it was published, unpublishes it.
 *
 * Idempotent for the same reason `archiveFunnel` is: the caller's intent is a
 * state, not an event. The `config_version` bump happens only when a published
 * definition actually left the served set — archiving a never-published draft
 * changes nothing a browser can see, and bumping would flush the site's
 * analytics query cache for no reason (the judgement `routes.ts` makes for
 * `reporting_currency`).
 */
export async function archiveEventDefinition(
  db: Database,
  input: { readonly id: string; readonly siteId: string; readonly actorUserId?: string },
): Promise<{ archived: boolean; configVersion: number | null }> {
  return db.transaction(async (tx) => {
    const [definition] = await tx
      .select({ id: eventDefinitions.id, publishedVersion: eventDefinitions.publishedVersion })
      .from(eventDefinitions)
      .where(and(eq(eventDefinitions.id, input.id), eq(eventDefinitions.siteId, input.siteId)))
      .for('update')
      .limit(1)
    if (!definition) return { archived: false, configVersion: null }

    const wasPublished = definition.publishedVersion !== null

    await tx
      .update(eventDefinitions)
      .set({
        status: 'archived',
        // COALESCE keeps the instant the definition actually left the list,
        // rather than the last time someone clicked archive.
        archivedAt: sql`COALESCE(${eventDefinitions.archivedAt}, now())`,
        publishedVersion: null,
        updatedAt: new Date(),
      })
      .where(eq(eventDefinitions.id, definition.id))

    const configVersion = wasPublished ? await bumpConfigVersion(tx, input.siteId) : null

    await writeAudit(tx, {
      action: 'event_definition.archived',
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorUserId ? 'user' : 'system',
      siteId: input.siteId,
      targetType: 'event_definition',
      targetId: definition.id,
      metadata: { wasPublished, configVersion },
    })

    return { archived: true, configVersion }
  })
}

/** The human labels a read path attaches to a canonical event name. */
export interface EventDisplayRecord {
  readonly eventName: string
  readonly displayName: string
  readonly displayTemplate: string | null
}

/**
 * Display labels for a site's event names (ADR-0034, D7).
 *
 * Read by the custom-events surface so a chart can say "Pricing CTA clicked"
 * instead of `pricing_cta_clicked`. It reads the **published** version, because
 * that is the definition the events being counted were produced under.
 *
 * Archived definitions are included on purpose, and it is the one place in this
 * module that does that: a definition can be archived while the ClickHouse rows
 * it produced are still inside the range being charted, and dropping its label
 * would turn a named event back into a raw string exactly when someone is
 * looking at the history that made them archive it. Their `published_version`
 * is null after archiving, so the join falls back to the newest version.
 */
export async function listEventDisplayNames(
  db: Database,
  siteId: string,
): Promise<EventDisplayRecord[]> {
  const rows = await db
    .select({
      eventName: eventDefinitions.eventName,
      displayName: eventDefinitionVersions.displayName,
      displayTemplate: eventDefinitionVersions.displayTemplate,
      version: eventDefinitionVersions.version,
      publishedVersion: eventDefinitions.publishedVersion,
    })
    .from(eventDefinitions)
    .innerJoin(
      eventDefinitionVersions,
      eq(eventDefinitionVersions.definitionId, eventDefinitions.id),
    )
    .where(eq(eventDefinitions.siteId, siteId))
    .orderBy(asc(eventDefinitions.eventName), desc(eventDefinitionVersions.version))

  // One row per event name: the published version when there is one, otherwise
  // the newest. Resolved here rather than in SQL because the fallback is an
  // ordering preference, and a correlated subquery per name would be three
  // joins to express what one pass over a sorted list says plainly.
  const byName = new Map<string, EventDisplayRecord>()
  const published = new Set<string>()
  for (const row of rows) {
    if (published.has(row.eventName)) continue
    const isPublished = row.publishedVersion !== null && row.publishedVersion === row.version
    if (isPublished) {
      published.add(row.eventName)
      byName.set(row.eventName, {
        eventName: row.eventName,
        displayName: row.displayName,
        displayTemplate: row.displayTemplate,
      })
      continue
    }
    if (!byName.has(row.eventName)) {
      byName.set(row.eventName, {
        eventName: row.eventName,
        displayName: row.displayName,
        displayTemplate: row.displayTemplate,
      })
    }
  }
  return [...byName.values()]
}

/**
 * The property keys a breakdown of one event may show (DataFast gap 6).
 *
 * The keys the event's definition declares in `property_schema`, read from the
 * same version `listEventDisplayNames` reads: the published one, else the
 * newest, archived definitions included (their rows are still in the range).
 *
 * `null` means no allowlist applies: the event has no definition, or its
 * definition declares no property (a label-only definition for an event sent
 * from code). A definition that declares keys restricts the breakdown to them,
 * so a property the owner chose not to describe is not surfaced by a read
 * either.
 */
export async function getEventPropertyAllowlist(
  db: Database,
  input: { readonly siteId: string; readonly eventName: string },
): Promise<string[] | null> {
  const rows = await db
    .select({
      propertySchema: eventDefinitionVersions.propertySchema,
      version: eventDefinitionVersions.version,
      publishedVersion: eventDefinitions.publishedVersion,
    })
    .from(eventDefinitions)
    .innerJoin(
      eventDefinitionVersions,
      eq(eventDefinitionVersions.definitionId, eventDefinitions.id),
    )
    .where(
      and(
        eq(eventDefinitions.siteId, input.siteId),
        eq(eventDefinitions.eventName, input.eventName),
      ),
    )
    .orderBy(desc(eventDefinitionVersions.version))

  const chosen =
    rows.find((row) => row.publishedVersion !== null && row.publishedVersion === row.version) ??
    rows[0]
  if (chosen === undefined) return null
  const keys = chosen.propertySchema.map((entry) => entry.key)
  return keys.length === 0 ? null : keys
}

/** A published rule, joined to the definition that gives it its event name. */
export interface PublishedRuleRecord {
  readonly definitionId: string
  readonly eventName: string
  readonly version: number
  readonly rule: StoredNoCodeRule
}

/**
 * Every rule a site currently publishes, in a deterministic order.
 *
 * This is what the collector's ingest-config resolution reads and what the
 * tracker is ultimately served. Two properties matter and both come from the
 * `ORDER BY`: the tracker evaluates rules in a stable order across page loads,
 * and the ETag's payload does not change when Postgres happens to return rows
 * differently — an unstable order would make an unchanged rule set look like a
 * change to every cache in front of it.
 */
export async function listPublishedRules(
  db: Database,
  siteId: string,
): Promise<PublishedRuleRecord[]> {
  const rows = await db
    .select({
      definitionId: eventDefinitions.id,
      eventName: eventDefinitions.eventName,
      version: eventDefinitionVersions.version,
      rules: eventDefinitionVersions.rules,
    })
    .from(eventDefinitions)
    .innerJoin(
      eventDefinitionVersions,
      and(
        eq(eventDefinitionVersions.definitionId, eventDefinitions.id),
        eq(eventDefinitionVersions.version, eventDefinitions.publishedVersion),
      ),
    )
    .where(and(eq(eventDefinitions.siteId, siteId), isNull(eventDefinitions.archivedAt)))
    .orderBy(asc(eventDefinitions.eventName), asc(eventDefinitions.id))

  return rows.flatMap((row) =>
    row.rules.map((rule) => ({
      definitionId: row.definitionId,
      eventName: row.eventName,
      version: row.version,
      rule,
    })),
  )
}
