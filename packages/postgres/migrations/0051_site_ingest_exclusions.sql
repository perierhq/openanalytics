-- Per-site server-side exclusions: IP ranges, page paths, countries and
-- hostnames whose traffic the site does not count.
--
-- Rollout note: additive — four columns on the existing optional settings row,
-- each with an empty-array default, plus one cardinality CHECK per column. No
-- backfill, no change to any other table, column, constraint or index, and
-- nothing behaves differently until a dashboard change writes a list. The
-- CHECKs validate against existing rows on apply, which all hold the empty
-- default (forward-only; applied migrations are never edited — D-214).
--
-- Why here. This table is the row behind `GET/PATCH
-- /v1/sites/{site_id}/ingest-settings` and the one `resolveIngestConfig` already
-- joins on every ingest-config cache miss, so the collector gets the lists in
-- the same single query that authorises a batch (no second round-trip), and a
-- write bumps `sites.config_version` through `upsertSiteIngestSettings` like
-- every other setting here. Unlike every other column here, these are never
-- projected into `GET /v1/tracker/config`: an office's address range is the
-- site's business, not something to publish to every visitor's browser.
--
-- Why arrays rather than one jsonb document. Each list is a set of strings
-- with one bound, which is what `text[]` and `cardinality()` say directly; the
-- existing `redact_query_keys` is the same shape. The values are normalised by
-- `normalizeIngestExclusions` in `@openanalytics/domain` before they are
-- written (CIDR with host bits cleared, lowercase hosts, uppercase country
-- codes), and the bounds below mirror that function and the published
-- `IngestExclusions` contract, so a value outside them fails here rather than
-- reaching the collector as a list nobody could have entered.

ALTER TABLE site_ingest_settings
  ADD COLUMN exclude_ip_ranges text[] NOT NULL DEFAULT '{}',
  ADD COLUMN exclude_paths     text[] NOT NULL DEFAULT '{}',
  ADD COLUMN exclude_countries text[] NOT NULL DEFAULT '{}',
  ADD COLUMN exclude_hostnames text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT site_ingest_settings_exclude_ip_ranges_check
    CHECK (cardinality(exclude_ip_ranges) <= 50),
  ADD CONSTRAINT site_ingest_settings_exclude_paths_check
    CHECK (cardinality(exclude_paths) <= 50),
  ADD CONSTRAINT site_ingest_settings_exclude_countries_check
    CHECK (cardinality(exclude_countries) <= 250),
  ADD CONSTRAINT site_ingest_settings_exclude_hostnames_check
    CHECK (cardinality(exclude_hostnames) <= 20);
