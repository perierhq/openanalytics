-- X mentions: the authors' profile pictures, stored per site.
--
-- Rollout note: additive, forward-only -- one new table and no change to any
-- existing table, column, constraint or index. It applies to a live database
-- with no backfill; pictures appear as the poller next finds each author.
-- Migrations 0001-0048 are never edited (D-214).
--
-- Rollback (manual, only if the feature is abandoned -- there is no down
-- runner):
--   DROP TABLE mention_avatars;
--
-- Why it exists: the mentions list reads better with the author's face next to
-- each post, but the dashboard must not hotlink X images -- that would send
-- every viewer's address to X (see the comment on `mentions` in 0048). So the
-- worker downloads the small (48 px) picture once, at most weekly per author,
-- from `pbs.twimg.com` only, and the API serves it from this table under the
-- install's own domain.
--
-- Per site rather than shared across sites: every row goes with its site on
-- deletion, and one site's members can never learn which authors another
-- site's mentions found.

CREATE TABLE mention_avatars (
  site_id       uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  platform      text NOT NULL,
  author_handle text NOT NULL,
  -- Read from the bytes' magic numbers by the worker, never from a response
  -- header, and sent back as the response's Content-Type.
  content_type  text NOT NULL,
  bytes         bytea NOT NULL,
  -- Where the picture came from. A changed URL (the author picked a new
  -- picture) is downloaded again before the week is up.
  source_url    text NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),

  -- Named so the bootstrap test can assert them. The bounds mirror
  -- MENTION_PLATFORMS, MENTION_AVATAR_CONTENT_TYPES, MENTION_AVATAR_MAX_BYTES
  -- and MENTION_AVATAR_HOST in `packages/domain/src/mentions.ts`.
  CONSTRAINT mention_avatars_pkey PRIMARY KEY (site_id, platform, author_handle),
  CONSTRAINT mention_avatars_platform_check CHECK (platform IN ('x')),
  -- The handle is part of the API path that serves the picture.
  CONSTRAINT mention_avatars_handle_check CHECK (author_handle ~ '^[A-Za-z0-9_]{1,15}$'),
  -- Never `image/svg+xml` or anything else a browser could run as a document.
  CONSTRAINT mention_avatars_content_type_check
    CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT mention_avatars_bytes_size_check CHECK (octet_length(bytes) <= 32768),
  CONSTRAINT mention_avatars_source_url_check CHECK (source_url ~ '^https://pbs\.twimg\.com/')
);
