import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { createdAt, idColumn, primaryId, updatedAt } from './_shared.ts'
import { users } from './auth.ts'
import { sites } from './sites.ts'

/**
 * Chart notes (mirror of migration 0050).
 *
 * A short note pinned to a moment (`at`) on a site's overview chart. The author
 * is kept as a nullable reference that goes to NULL with the account, so a note
 * outlives the person who wrote it and then names nobody. The CHECKs mirror
 * `normalizeChartNoteText` in `packages/domain/src/chart-notes.ts`.
 */
export const chartNotes = pgTable(
  'chart_notes',
  {
    id: primaryId(),
    siteId: idColumn('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull(),
    text: text('text').notNull(),
    createdByUserId: idColumn('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('chart_notes_site_at_idx').on(t.siteId, t.at.desc()),
    check('chart_notes_text_length_check', sql`char_length(${t.text}) BETWEEN 1 AND 280`),
    check('chart_notes_text_trimmed_check', sql`${t.text} = btrim(${t.text}, E' \\n')`),
    check(
      'chart_notes_text_control_check',
      sql`${t.text} !~ '[\\x01-\\x09\\x0B-\\x1F\\x7F-\\x9F]'`,
    ),
  ],
)
