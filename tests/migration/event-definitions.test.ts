import { SITE_DELETION_TARGETS } from '@openanalytics/domain'
import {
  archiveEventDefinition,
  createApiKey,
  createDatabase,
  createEventDefinition,
  createPool,
  createSiteWithOwner,
  getEventDefinition,
  getEventPropertyAllowlist,
  listDeletionTargets,
  listEventDefinitionVersions,
  listEventDefinitions,
  listPublishedRules,
  newId,
  publishEventDefinition,
  purgeSitePostgres,
  resolveIngestConfig,
  rollbackEventDefinition,
  saveEventDefinitionVersion,
  startSiteDeletion,
  type Database,
  type EventDefinitionVersionContent,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The event builder's storage against a real Postgres (ADR-0034, D3/D4/D9;
 * migration 0038). Milestone 13 CP1.
 *
 * These are *database* facts the application cannot compensate for, which is
 * why they are here rather than in the unit suite:
 *
 * 1. **A version number is allocated, not chosen.** `max(version) + 1` under a
 *    unique constraint, so two concurrent saves cannot both become v3 — the
 *    determinism D3 promises comes from the constraint, not from the read.
 * 2. **History is immutable, and rollback moves forward.** Rolling back to v1
 *    produces a *new* version whose content equals v1's, because the
 *    tracker-config ETag epoch only ever increases.
 * 3. **Publishing bumps `sites.config_version` in the same commit.** A publish
 *    that committed without it would be a rule set no browser could learn about.
 * 4. **Publication is optimistically concurrent**, so two admins publishing
 *    different drafts get a defined winner and a conflict rather than a silent
 *    last-write-wins.
 * 5. **Both tables are purged with the site**, and the count moved 57 -> 59. A
 *    vocabulary name with no purge statement behind it verifies silently at
 *    `deleted: 0`, so the per-table effect is asserted, not only the count.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

const RULE_A = '0192f7a0-0000-7000-8000-00000000000a'
const RULE_B = '0192f7a0-0000-7000-8000-00000000000b'

function content(overrides: Partial<EventDefinitionVersionContent> = {}) {
  return {
    displayName: 'Pricing CTA clicked',
    propertySchema: [{ key: 'button_label', type: 'string' as const }],
    displayTemplate: 'Clicked “{{button_label}}”',
    rules: [
      {
        rule_id: RULE_A,
        trigger: 'click' as const,
        selector: 'section.pricing > button.cta',
        properties: [{ key: 'button_label', source: 'text' }],
      },
    ],
    ...overrides,
  }
}

describeIfPostgres('event definitions', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m13def_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let ownerId: string

  const makeSite = async (): Promise<string> => {
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: ownerId,
    })
    return siteId
  }

  const configVersion = async (siteId: string): Promise<number> => {
    const { rows } = await pool.query<{ config_version: number }>(
      'SELECT config_version FROM sites WHERE id = $1',
      [siteId],
    )
    return rows[0]?.config_version as number
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }

    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    const scoped = url.toString()

    const { logger } = createCapturedLogger()
    await applyPostgresStreams({ connectionString: scoped, logger })

    pool = createPool(scoped)
    db = createDatabase(pool)

    ownerId = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [ownerId, `${ownerId}@example.com`],
    )
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  describe('the schema itself', () => {
    it('refuses a second definition with the same name on one site, archived or not', async () => {
      const siteId = await makeSite()
      await createEventDefinition(db, { siteId, eventName: 'dupe_name', content: content() })
      const definitions = await listEventDefinitions(db, siteId)
      await archiveEventDefinition(db, { id: definitions[0]?.id as string, siteId })

      // Archiving does not free the name: the ClickHouse rows it produced still
      // group under it, so a second definition would make the count ambiguous.
      // Asserted through raw SQL rather than the repository, because Drizzle
      // wraps the driver error and the constraint *name* is what this is about.
      await expect(
        pool.query(
          `INSERT INTO event_definitions (id, site_id, event_name) VALUES ($1, $2, 'dupe_name')`,
          [newId(), siteId],
        ),
      ).rejects.toThrow(/event_definitions_site_event_name_key/iu)
      await expect(
        createEventDefinition(db, { siteId, eventName: 'dupe_name', content: content() }),
      ).rejects.toThrow()
    })

    it('allows the same name on two different sites', async () => {
      const a = await makeSite()
      const b = await makeSite()
      await createEventDefinition(db, { siteId: a, eventName: 'shared', content: content() })
      await expect(
        createEventDefinition(db, { siteId: b, eventName: 'shared', content: content() }),
      ).resolves.toBeTruthy()
    })

    it('refuses a rule set past the per-version ceiling, in the database', async () => {
      const siteId = await makeSite()
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'too_many',
        content: content(),
      })
      const rules = Array.from({ length: 51 }, (_, i) => ({
        rule_id: `0192f7a0-0000-7000-8000-${String(i).padStart(12, '0')}`,
        trigger: 'click' as const,
        selector: 'button',
      }))
      await expect(
        pool.query(
          `INSERT INTO event_definition_versions (id, definition_id, version, display_name, rules)
           VALUES ($1, $2, 99, 'X', $3::jsonb)`,
          [newId(), definition.id, JSON.stringify(rules)],
        ),
      ).rejects.toThrow(/event_definition_versions_rules_check/iu)
    })

    it('refuses a non-array rules value without erroring on jsonb_array_length', async () => {
      const siteId = await makeSite()
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'not_array',
        content: content(),
      })
      await expect(
        pool.query(
          `INSERT INTO event_definition_versions (id, definition_id, version, display_name, rules)
           VALUES ($1, $2, 98, 'X', '{"a":1}'::jsonb)`,
          [newId(), definition.id],
        ),
      ).rejects.toThrow(/event_definition_versions_rules_check/iu)
    })

    it('refuses a published_version that names no version row', async () => {
      const siteId = await makeSite()
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'bad_pointer',
        content: content(),
      })
      await expect(
        pool.query('UPDATE event_definitions SET published_version = 42 WHERE id = $1', [
          definition.id,
        ]),
      ).rejects.toThrow(/event_definitions_published_version_fk/iu)
    })

    it('leaves an unpublished definition unconstrained, which MATCH SIMPLE is what gives us', async () => {
      const siteId = await makeSite()
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'null_pointer',
        content: content(),
      })
      const stored = await getEventDefinition(db, { id: definition.id, siteId })
      expect(stored?.publishedVersion).toBeNull()
    })
  })

  describe('versions', () => {
    it('allocates v1 on create and never publishes it', async () => {
      const siteId = await makeSite()
      const { definition, version } = await createEventDefinition(db, {
        siteId,
        eventName: 'first',
        content: content(),
      })
      expect(version.version).toBe(1)
      // Creating a definition and turning it on are two acts.
      expect(definition.publishedVersion).toBeNull()
      expect(await configVersion(siteId)).toBe(1)
    })

    it('allocates the next number per definition, not globally', async () => {
      const siteId = await makeSite()
      const first = await createEventDefinition(db, {
        siteId,
        eventName: 'a_def',
        content: content(),
      })
      const second = await createEventDefinition(db, {
        siteId,
        eventName: 'b_def',
        content: content(),
      })
      const nextA = await saveEventDefinitionVersion(db, {
        id: first.definition.id,
        siteId,
        content: content({ displayName: 'A2' }),
      })
      expect(nextA?.version).toBe(2)
      // The second definition is untouched by the first's history.
      const nextB = await saveEventDefinitionVersion(db, {
        id: second.definition.id,
        siteId,
        content: content({ displayName: 'B2' }),
      })
      expect(nextB?.version).toBe(2)
    })

    it('cannot mint two v2s for one definition, even under a race', async () => {
      const siteId = await makeSite()
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'raced',
        content: content(),
      })

      const results = await Promise.allSettled([
        saveEventDefinitionVersion(db, { id: definition.id, siteId, content: content() }),
        saveEventDefinitionVersion(db, { id: definition.id, siteId, content: content() }),
        saveEventDefinitionVersion(db, { id: definition.id, siteId, content: content() }),
      ])

      const versions = await listEventDefinitionVersions(db, {
        definitionId: definition.id,
        siteId,
      })
      // Whatever the race did, the history is a contiguous list with no
      // duplicate number: the losers failed on the unique constraint.
      expect(versions.map((v) => v.version)).toEqual(
        Array.from({ length: versions.length }, (_, i) => i + 1),
      )
      expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    })

    it('refuses to add a version to an archived definition', async () => {
      const siteId = await makeSite()
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'archived_edit',
        content: content(),
      })
      await archiveEventDefinition(db, { id: definition.id, siteId })
      expect(
        await saveEventDefinitionVersion(db, { id: definition.id, siteId, content: content() }),
      ).toBeNull()
    })

    it('scopes every read by site, so another site id reads as absent', async () => {
      const siteId = await makeSite()
      const other = await makeSite()
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'scoped',
        content: content(),
      })
      expect(await getEventDefinition(db, { id: definition.id, siteId: other })).toBeNull()
      expect(
        await listEventDefinitionVersions(db, { definitionId: definition.id, siteId: other }),
      ).toEqual([])
      expect(
        await saveEventDefinitionVersion(db, {
          id: definition.id,
          siteId: other,
          content: content(),
        }),
      ).toBeNull()
    })
  })

  describe('publish', () => {
    it('moves the pointer and bumps the site config epoch in one commit', async () => {
      const siteId = await makeSite()
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'published',
        content: content(),
      })
      const before = await configVersion(siteId)

      const outcome = await publishEventDefinition(db, {
        id: definition.id,
        siteId,
        version: 1,
        expectedPublishedVersion: null,
      })

      expect(outcome).toMatchObject({ ok: true, publishedVersion: 1 })
      expect(await configVersion(siteId)).toBe(before + 1)
    })

    it('refuses a version that does not exist', async () => {
      const siteId = await makeSite()
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'ghost_version',
        content: content(),
      })
      expect(
        await publishEventDefinition(db, {
          id: definition.id,
          siteId,
          version: 9,
          expectedPublishedVersion: null,
        }),
      ).toEqual({ ok: false, reason: 'unknown_version' })
    })

    it('conflicts rather than overwriting when the caller expected a different live version', async () => {
      const siteId = await makeSite()
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'concurrent',
        content: content(),
      })
      await saveEventDefinitionVersion(db, { id: definition.id, siteId, content: content() })
      await publishEventDefinition(db, {
        id: definition.id,
        siteId,
        version: 1,
        expectedPublishedVersion: null,
      })

      // The second admin still believes nothing is published.
      const outcome = await publishEventDefinition(db, {
        id: definition.id,
        siteId,
        version: 2,
        expectedPublishedVersion: null,
      })
      expect(outcome).toEqual({ ok: false, reason: 'conflict', publishedVersion: 1 })

      const stored = await getEventDefinition(db, { id: definition.id, siteId })
      expect(stored?.publishedVersion).toBe(1)
    })
  })

  describe('rollback', () => {
    it('publishes a copy forward rather than rewinding, and keeps history intact', async () => {
      const siteId = await makeSite()
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'rolled_back',
        content: content({ displayName: 'V1' }),
      })
      await publishEventDefinition(db, {
        id: definition.id,
        siteId,
        version: 1,
        expectedPublishedVersion: null,
      })
      await saveEventDefinitionVersion(db, {
        id: definition.id,
        siteId,
        content: content({
          displayName: 'V2',
          rules: [{ rule_id: RULE_B, trigger: 'click', selector: 'a' }],
        }),
      })
      await publishEventDefinition(db, {
        id: definition.id,
        siteId,
        version: 2,
        expectedPublishedVersion: 1,
      })
      const beforeRollback = await configVersion(siteId)

      const outcome = await rollbackEventDefinition(db, {
        id: definition.id,
        siteId,
        toVersion: 1,
        expectedPublishedVersion: 2,
      })

      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return

      // A NEW version, not v1 again.
      expect(outcome.version.version).toBe(3)
      expect(outcome.version.sourceVersion).toBe(1)
      expect(outcome.version.displayName).toBe('V1')
      expect(outcome.version.rules[0]?.rule_id).toBe(RULE_A)
      expect(await configVersion(siteId)).toBe(beforeRollback + 1)

      // History is untouched: v1 and v2 still say what they always said.
      const versions = await listEventDefinitionVersions(db, {
        definitionId: definition.id,
        siteId,
      })
      expect(versions.map((v) => [v.version, v.displayName])).toEqual([
        [1, 'V1'],
        [2, 'V2'],
        [3, 'V1'],
      ])

      // And the served rule set is exactly v1's again.
      const published = await listPublishedRules(db, siteId)
      expect(published.map((p) => p.rule.rule_id)).toEqual([RULE_A])
      expect(published[0]?.version).toBe(3)
    })

    it('conflicts on a stale expectation like publish does', async () => {
      const siteId = await makeSite()
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'stale_rollback',
        content: content(),
      })
      await publishEventDefinition(db, {
        id: definition.id,
        siteId,
        version: 1,
        expectedPublishedVersion: null,
      })
      expect(
        await rollbackEventDefinition(db, {
          id: definition.id,
          siteId,
          toVersion: 1,
          expectedPublishedVersion: null,
        }),
      ).toEqual({ ok: false, reason: 'conflict', publishedVersion: 1 })
    })
  })

  describe('the published rule set', () => {
    it('serves only live, published definitions, in a stable order', async () => {
      const siteId = await makeSite()
      const zeta = await createEventDefinition(db, {
        siteId,
        eventName: 'zeta_event',
        content: content(),
      })
      const alpha = await createEventDefinition(db, {
        siteId,
        eventName: 'alpha_event',
        content: content({ rules: [{ rule_id: RULE_B, trigger: 'submit', selector: 'form' }] }),
      })
      // Drafted but never published — invisible to the collector.
      await createEventDefinition(db, {
        siteId,
        eventName: 'draft_event',
        content: content(),
      })

      await publishEventDefinition(db, {
        id: zeta.definition.id,
        siteId,
        version: 1,
        expectedPublishedVersion: null,
      })
      await publishEventDefinition(db, {
        id: alpha.definition.id,
        siteId,
        version: 1,
        expectedPublishedVersion: null,
      })

      const published = await listPublishedRules(db, siteId)
      // Ordered by event name, so an unchanged rule set serialises identically
      // on every read — an unstable order would look like a change to every
      // cache in front of the config endpoint.
      expect(published.map((p) => p.eventName)).toEqual(['alpha_event', 'zeta_event'])
      expect(published.map((p) => p.rule.rule_id)).toEqual([RULE_B, RULE_A])
    })

    it('drops out of the served set when the definition is archived, and bumps the epoch', async () => {
      const siteId = await makeSite()
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'archived_published',
        content: content(),
      })
      await publishEventDefinition(db, {
        id: definition.id,
        siteId,
        version: 1,
        expectedPublishedVersion: null,
      })
      const before = await configVersion(siteId)

      const archived = await archiveEventDefinition(db, { id: definition.id, siteId })
      expect(archived.archived).toBe(true)
      expect(await listPublishedRules(db, siteId)).toEqual([])
      expect(await configVersion(siteId)).toBe(before + 1)
    })

    it('does not bump the epoch when the archived definition was never published', async () => {
      const siteId = await makeSite()
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'archived_draft',
        content: content(),
      })
      const before = await configVersion(siteId)

      const archived = await archiveEventDefinition(db, { id: definition.id, siteId })
      expect(archived).toEqual({ archived: true, configVersion: null })
      // Nothing a browser can see changed, so flushing the site's analytics
      // query cache would be a cost with no cause.
      expect(await configVersion(siteId)).toBe(before)
    })
  })

  describe('publication reaches the ingest path', () => {
    it('serves a published rule through resolveIngestConfig, stamped and ordered', async () => {
      const siteId = await makeSite()
      const { rawToken } = await createApiKey(db, {
        siteId,
        type: 'tracking_write',
        name: 'tracker',
      })

      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'ingest_visible',
        content: content(),
      })

      // Before publish the tracker sees nothing: a draft is in nobody's browser.
      const beforePublish = await resolveIngestConfig(db, rawToken)
      expect(beforePublish?.noCodeRules).toEqual([])

      await publishEventDefinition(db, {
        id: definition.id,
        siteId,
        version: 1,
        expectedPublishedVersion: null,
      })

      const resolved = await resolveIngestConfig(db, rawToken)
      expect(resolved?.noCodeRules).toHaveLength(1)
      const rule = resolved?.noCodeRules[0]
      // The event name and definition version are stamped onto each rule by the
      // query, because the tracker is served a flat list and the collector
      // resolves a claimed rule_id against exactly this shape.
      expect(rule).toMatchObject({
        rule_id: RULE_A,
        name: 'ingest_visible',
        version: 1,
        trigger: 'click',
        selector: 'section.pricing > button.cta',
      })
      expect(rule?.properties).toEqual([{ key: 'button_label', source: 'text' }])
    })

    it('stops serving it the moment it is archived', async () => {
      const siteId = await makeSite()
      const { rawToken } = await createApiKey(db, {
        siteId,
        type: 'tracking_write',
        name: 'tracker',
      })
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'archived_from_ingest',
        content: content(),
      })
      await publishEventDefinition(db, {
        id: definition.id,
        siteId,
        version: 1,
        expectedPublishedVersion: null,
      })
      expect((await resolveIngestConfig(db, rawToken))?.noCodeRules).toHaveLength(1)

      await archiveEventDefinition(db, { id: definition.id, siteId })
      expect((await resolveIngestConfig(db, rawToken))?.noCodeRules).toEqual([])
    })
  })

  describe('the property allowlist a breakdown reads (DataFast gap 6)', () => {
    it('is the published version’s declared keys, else the newest, else none', async () => {
      const siteId = await makeSite()
      expect(await getEventPropertyAllowlist(db, { siteId, eventName: 'nobody' })).toBeNull()

      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'plan_selected',
        content: content({ propertySchema: [{ key: 'plan', type: 'string' }] }),
      })
      // Unpublished: the newest version decides.
      expect(await getEventPropertyAllowlist(db, { siteId, eventName: 'plan_selected' })).toEqual([
        'plan',
      ])

      await publishEventDefinition(db, {
        id: definition.id,
        siteId,
        version: 1,
        expectedPublishedVersion: null,
      })
      await saveEventDefinitionVersion(db, {
        id: definition.id,
        siteId,
        content: content({
          propertySchema: [
            { key: 'plan', type: 'string' },
            { key: 'trigger', type: 'string' },
          ],
        }),
      })
      // A newer draft does not widen what the published version declares.
      expect(await getEventPropertyAllowlist(db, { siteId, eventName: 'plan_selected' })).toEqual([
        'plan',
      ])

      // A label-only definition declares nothing and restricts nothing.
      await createEventDefinition(db, {
        siteId,
        eventName: 'label_only',
        content: content({ propertySchema: [], displayTemplate: null, rules: [] }),
      })
      expect(await getEventPropertyAllowlist(db, { siteId, eventName: 'label_only' })).toBeNull()

      // Site-scoped: another site's definition is absent.
      const other = await makeSite()
      expect(
        await getEventPropertyAllowlist(db, { siteId: other, eventName: 'plan_selected' }),
      ).toBeNull()
    })
  })

  describe('deletion', () => {
    it('purges both tables and books them in the target snapshot', async () => {
      const siteId = await makeSite()
      const { definition } = await createEventDefinition(db, {
        siteId,
        eventName: 'purged',
        content: content(),
      })
      await saveEventDefinitionVersion(db, { id: definition.id, siteId, content: content() })
      await publishEventDefinition(db, {
        id: definition.id,
        siteId,
        version: 2,
        expectedPublishedVersion: null,
      })

      const started = await startSiteDeletion(db, { siteId, requestedByUserId: ownerId })

      const targets = await listDeletionTargets(db, {
        deletionRequestId: started.deletionRequestId,
      })
      // 64, not 65: `billing_transfer_offers` is a target the hosted surface registers (`CLOUD_DELETION_EXTENSION`), so this is the set a build without it erases.
      expect(targets).toHaveLength(64)
      expect(targets).toHaveLength(SITE_DELETION_TARGETS.length)
      const names = new Set(targets.map((t) => `${t.store}:${t.target}`))
      expect(names.has('postgres:event_definitions')).toBe(true)
      expect(names.has('postgres:event_definition_versions')).toBe(true)

      // The published pointer is dropped before the versions go, or the
      // composite FK would refuse the delete.
      const { deleted } = await purgeSitePostgres(db, { siteId })
      expect(deleted['event_definition_versions']).toBe(2)
      expect(deleted['event_definitions']).toBe(1)

      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM event_definitions WHERE site_id = $1',
        [siteId],
      )
      expect(rows[0]?.n).toBe(0)
    })
  })
})
