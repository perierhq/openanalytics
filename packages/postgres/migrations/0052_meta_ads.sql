-- Meta Ads: a per-site connection to one Meta ad account, and the daily spend
-- per campaign the worker reads from it.
--
-- Rollout note: additive, forward-only -- two new tables and no change to any
-- existing table, column, constraint or index. It applies to a live database
-- with no backfill, and nothing behaves differently until an owner connects an
-- ad account. Migrations 0001-0051 are never edited (D-214).
--
-- Rollback (manual, only if the feature is abandoned -- there is no down
-- runner):
--   DROP TABLE meta_ads_daily_spend, meta_ads_connections;
--
-- Why it exists: an owner who pays for Meta ads wants to see, per campaign,
-- what the campaign cost beside the revenue it brought in. The worker reads
-- daily spend per campaign from the Marketing API with the owner's System User
-- token; the API joins it to last-touch revenue by `utm_campaign`. What leaves
-- the install is the ad account id and the token, sent by the worker (and once
-- by the API, to check the token on connect) to graph.facebook.com.

CREATE TABLE meta_ads_connections (
  site_id           uuid PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
  -- `act_` plus digits, as the Marketing API addresses an ad account.
  ad_account_id     text NOT NULL,
  -- What the connect probe read back, so the settings card can name the
  -- account and the spend can be labelled before the first sync.
  ad_account_name   text NOT NULL DEFAULT '',
  currency          text NOT NULL,
  -- Meta's `account_status` as the connect probe read it (1 is active; 2 is
  -- disabled, 101 closed and so on). NULL when Meta did not report one. A
  -- connect is allowed whatever it says; the settings card says so.
  account_status    integer,
  -- The token, encrypted with the credential keyring exactly as a revenue
  -- provider key is (`OA_CREDENTIAL_KEYRING`), and bound by its AAD to this
  -- site and this ad account. Never stored or returned in the clear.
  encrypted_token   text NOT NULL,
  -- The key version that wrote the ciphertext, so a rotation sweep can find
  -- every row still on an old key with a SELECT.
  key_version       text NOT NULL,
  -- The last four characters, for the settings card; empty for a short token.
  token_last4       text NOT NULL DEFAULT '',
  -- `active` is synced on schedule; `needs_reconnect` means Meta refused the
  -- token and polling has stopped until the owner connects again. A token this
  -- install cannot decrypt stays `active` with `credential_undecryptable`: the
  -- fix is the operator's keyring, and the worker retries after a restart.
  status            text NOT NULL DEFAULT 'active',
  connected_at      timestamptz NOT NULL DEFAULT now(),
  -- When the worker may sync this site next: six hours after a success,
  -- sooner after a transient failure, later after a rate limit.
  next_sync_at      timestamptz NOT NULL DEFAULT now(),
  last_attempted_at timestamptz,
  -- The last sync that read its whole window. NULL until the first one, which
  -- is what makes the first sync read ninety days instead of three.
  last_synced_at    timestamptz,
  -- How far back the first sync's ninety-day backfill has read: every day
  -- from this one to the recent window is stored. NULL before the backfill's
  -- first chunk. Moved in the same transaction as the chunk's spend, so a
  -- first sync cut short by a rate limit resumes here instead of starting over.
  backfill_cursor   date,
  last_error        text,

  -- Named so the bootstrap test can assert them. The vocabularies mirror
  -- META_ADS_STATUSES and META_ADS_ERRORS in `packages/domain/src/meta-ads.ts`.
  CONSTRAINT meta_ads_connections_ad_account_id_check
    CHECK (ad_account_id ~ '^act_[0-9]{1,20}$'),
  CONSTRAINT meta_ads_connections_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT meta_ads_connections_name_length_check CHECK (char_length(ad_account_name) <= 200),
  CONSTRAINT meta_ads_connections_status_check
    CHECK (status IN ('active', 'needs_reconnect')),
  CONSTRAINT meta_ads_connections_last_error_check
    CHECK (last_error IS NULL
      OR last_error IN ('unauthorized', 'credential_undecryptable', 'rate_limited',
        'unavailable', 'invalid_response'))
);

-- The worker's pick-up query: active connections that are due, soonest first,
-- in exactly its ORDER BY (`next_sync_at ASC, site_id ASC`).
CREATE INDEX meta_ads_connections_due_idx
  ON meta_ads_connections (next_sync_at, site_id)
  WHERE status = 'active';

-- The keyring rotation sweep's scan, as on `revenue_credentials`.
CREATE INDEX meta_ads_connections_key_version_idx ON meta_ads_connections (key_version);

CREATE TABLE meta_ads_daily_spend (
  site_id       uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  -- Meta's campaign id: digits, kept as text because it is an identifier.
  campaign_id   text NOT NULL,
  -- The campaign's name on that day; empty when Meta sent none.
  campaign_name text NOT NULL,
  -- A day in the ad account's own timezone, as Meta reports `date_start`.
  day           date NOT NULL,
  -- Integer minor units of `currency`, parsed exactly from Meta's decimal
  -- string. Never a float.
  spend_minor   bigint NOT NULL,
  currency      text NOT NULL,
  -- When this row was last read; Meta restates recent days, so the last three
  -- are re-read on every sync and overwritten.
  fetched_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT meta_ads_daily_spend_pkey PRIMARY KEY (site_id, campaign_id, day),
  CONSTRAINT meta_ads_daily_spend_campaign_id_check CHECK (campaign_id ~ '^[0-9]{1,32}$'),
  CONSTRAINT meta_ads_daily_spend_name_length_check CHECK (char_length(campaign_name) <= 400),
  CONSTRAINT meta_ads_daily_spend_spend_check CHECK (spend_minor >= 0),
  CONSTRAINT meta_ads_daily_spend_currency_check CHECK (currency ~ '^[A-Z]{3}$')
);

-- The campaigns read: one site's days in a range.
CREATE INDEX meta_ads_daily_spend_site_day_idx ON meta_ads_daily_spend (site_id, day);
