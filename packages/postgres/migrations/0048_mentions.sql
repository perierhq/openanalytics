-- X mentions: per-site watch settings and the posts the poller found.
--
-- Rollout note: additive, forward-only -- two new tables and no change to any
-- existing table, column, constraint or index. It applies to a live database
-- with no backfill, and nothing behaves differently until an owner or admin
-- turns watching on for a site. Migrations 0001-0047 are never edited (D-214).
--
-- Rollback (manual, only if the feature is abandoned -- there is no down
-- runner):
--   DROP TABLE mentions, site_mention_settings;
--
-- Why it exists: site owners want to see public posts that mention their site
-- next to their traffic. A worker searches X through a configurable
-- fxtwitter-compatible service (`MENTIONS_X_API_URL`) for the site's domain and
-- a few extra terms, and stores the posts here, deduplicated per site. Only the
-- domain and the terms leave the install; nothing about any visitor does.
--
-- The names are platform-generic (`mentions`, `platform`) so another platform
-- is a new CHECK value and a new parser, not a new table.

CREATE TABLE site_mention_settings (
  site_id            uuid PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
  -- Off by default: turning it on sends the site's domain and terms to a third
  -- party on every poll, and that is the owner's decision to make.
  x_enabled          boolean NOT NULL DEFAULT false,
  -- Extra search terms besides the domain, already trimmed and deduplicated by
  -- `normalizeMentionSettingsPatch`. The domain itself is never stored here.
  terms              text[] NOT NULL DEFAULT '{}',
  -- The most recent poll, so the settings screen can say when a search last
  -- ran and why it failed. NULL until the first poll finishes.
  last_polled_at     timestamptz,
  last_error         text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,

  -- Named so the bootstrap test can assert them. The bounds mirror
  -- MENTION_TERMS_MAX and MENTION_POLL_ERRORS in `packages/domain/src/mentions.ts`.
  CONSTRAINT site_mention_settings_terms_count_check CHECK (cardinality(terms) <= 5),
  CONSTRAINT site_mention_settings_last_error_check
    CHECK (last_error IS NULL OR last_error IN ('unavailable', 'invalid_response'))
);

-- The poller's pick-up query: enabled sites, least recently polled first, in
-- exactly its ORDER BY (`last_polled_at ASC NULLS FIRST, site_id ASC`).
CREATE INDEX site_mention_settings_due_idx
  ON site_mention_settings (last_polled_at NULLS FIRST, site_id)
  WHERE x_enabled;

CREATE TABLE mentions (
  id               uuid PRIMARY KEY,
  site_id          uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  platform         text NOT NULL,
  -- The platform's own post id. Text, not bigint: it is an opaque identifier
  -- and another platform's ids will not be numbers.
  post_id          text NOT NULL,
  -- Built by the parser as https://x.com/{handle}/status/{post_id}, never
  -- copied from the search response.
  url              text NOT NULL,
  -- Shortened links already expanded by the search service.
  text             text NOT NULL,
  -- No avatar URL on purpose: the dashboard must not hotlink X images, which
  -- would send every viewer's address to X. No language and no raw facets
  -- either -- nothing reads them.
  author_handle    text NOT NULL,
  author_name      text NOT NULL,
  author_url       text NOT NULL,
  author_followers bigint,
  -- Counts as of `refreshed_at`. NULL when the service did not report one.
  -- `integer` columns are clamped to the int4 ceiling in code; `views` and
  -- `author_followers` are bigint because they can exceed it.
  likes            integer,
  reposts          integer,
  replies          integer,
  quotes           integer,
  views            bigint,
  posted_at        timestamptz NOT NULL,
  -- The term (the domain or one of the extra terms) that first found the post.
  -- Kept when a later poll finds the same post through another term.
  matched_term     text NOT NULL,
  -- True when the post links to one of the site's domains or a subdomain.
  links_to_site    boolean NOT NULL,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  refreshed_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT mentions_platform_check CHECK (platform IN ('x')),
  CONSTRAINT mentions_text_length_check CHECK (char_length(text) <= 1000),
  -- The dashboard renders both as links. The parser builds them itself from a
  -- validated handle and id; these keep a `javascript:` or relative URL out
  -- even if some other writer forgets to.
  CONSTRAINT mentions_url_check CHECK (url ~ '^https://'),
  CONSTRAINT mentions_author_url_check CHECK (author_url ~ '^https://'),
  -- One row per post per site: the upsert target.
  CONSTRAINT mentions_site_platform_post_key UNIQUE (site_id, platform, post_id)
);

-- The list endpoint's keyset: `(posted_at, id)` descending within a site.
CREATE INDEX mentions_site_posted_idx ON mentions (site_id, posted_at DESC, id DESC);
