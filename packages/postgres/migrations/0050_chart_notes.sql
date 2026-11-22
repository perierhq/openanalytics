-- Chart notes: short notes pinned to a moment on a site's overview chart.
--
-- Rollout note: additive, forward-only -- one new table and no change to any
-- existing table, column, constraint or index. It applies to a live database
-- with no backfill, and nothing behaves differently until someone writes a
-- note. Migrations 0001-0049 are never edited (D-214).
--
-- Rollback (manual, only if the feature is abandoned -- there is no down
-- runner):
--   DROP TABLE chart_notes;
--
-- Why it exists: a launch or a pricing change explains a bump in traffic, and
-- the people who made it want it on the chart next to the bump. Owners, admins
-- and their agents write notes; every member of the site reads them.

CREATE TABLE chart_notes (
  id                 uuid PRIMARY KEY,
  site_id            uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  -- The moment the note is pinned to.
  at                 timestamptz NOT NULL,
  -- Trimmed and checked by `normalizeChartNoteText`
  -- (`packages/domain/src/chart-notes.ts`); the CHECKs below are its floor.
  text               text NOT NULL,
  -- The author. SET NULL rather than CASCADE: a note outlives the account that
  -- wrote it, and the API then names no author at all.
  created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Named so the bootstrap test can assert them. The bounds mirror
  -- CHART_NOTE_TEXT_MAX_LENGTH; `char_length` counts characters, not bytes.
  CONSTRAINT chart_notes_text_length_check CHECK (char_length(text) BETWEEN 1 AND 280),
  CONSTRAINT chart_notes_text_trimmed_check CHECK (text = btrim(text, E' \n')),
  -- Every control character except the newline: C0, DEL and C1.
  CONSTRAINT chart_notes_text_control_check
    CHECK (text !~ '[\x01-\x09\x0B-\x1F\x7F-\x9F]')
);

-- The list: a site's notes in a range of `at`, newest first.
CREATE INDEX chart_notes_site_at_idx ON chart_notes (site_id, at DESC);
