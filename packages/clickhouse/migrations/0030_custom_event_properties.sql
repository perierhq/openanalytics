-- Custom-event property breakdowns (DataFast gap 6, Perier fork).
--
-- Rollout note: additive -- two new tables and two new materialized views, and
-- nothing existing is altered, dropped or recreated. The views read straight
-- from events_raw like every other rollup (0006 argues the direct-from-raw
-- rule, 0025 the fifteen-minute atom), so no existing view is touched.
--
-- Down / rollback: DROP VIEW custom_event_properties_15m_mv, DROP VIEW
-- custom_event_properties_1d_mv, then DROP TABLE of both targets. Nothing else
-- reads them, and the deletion registry names them, so a rollback also removes
-- the two names from DELETION_CLICKHOUSE_TARGETS in the same release (a target
-- naming a dropped table fails every deletion, see 0029).
--
-- History: a view aggregates only what is inserted after it exists. The
-- bounded backfill (`cli.js backfill-event-properties`) fills the last 92
-- days from events_raw, (site, bucket) pairs that hold no row only, so it can
-- run beside a live worker and a second run writes nothing. Its seam is the
-- pair the view started writing part way through: one quarter hour per site in
-- the 15m table, and the migration day per site in the 1d table.
--
-- One row per (event name, property key, property value). The key is the raw
-- JSON key, the value its text: a JSON string as itself, a number or boolean as
-- its JSON text (`12`, `true`) -- the same text a funnel step condition
-- compares (operations.ts funnelPropertyValue). Null, arrays and objects have
-- no value to break down by and are skipped (the sanitizer drops the last two
-- at ingest anyway).
--
-- Excluded keys, case-insensitively:
--   oa_*      reserved for server-owned payloads (web vitals, autocapture text
--             and selectors). They are not the customer's properties and the
--             sanitizer drops any a caller sends.
--   order_id  the linking hint (ADR-0064 D4a). One value per order, so it
--             would be a row per purchase, which is both useless as a
--             breakdown and a per-order trail in an aggregate table.
--
-- Values are cut to 100 characters (UTF-8 aware). The sanitizer already caps a
-- value at 256, and a breakdown row longer than a label is noise that only
-- widens the key space. The cardinality cap itself is applied at read time
-- (top N per key plus an `other` row, accepted for gap 6): an insert-time cap
-- would need per-bucket state a view cannot keep.
--
-- No event_type column: a breakdown answers "which plan", and the name is what
-- a definition and a funnel step key on. A custom event and a conversion that
-- share a name share their rows.
--
-- Note on style: no comment in a migration file may contain a semicolon. The
-- runner splits statements on the semicolon before it strips comments.

CREATE TABLE IF NOT EXISTS custom_event_properties_15m
(
  site_id        UUID,
  bucket_start   DateTime('UTC'),
  event_name     String,
  property_key   String,
  property_value String,
  events         SimpleAggregateFunction(sum, UInt64),
  visitors       AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, event_name, property_key, property_value)
-- Mandatory on every dependent target, not only on the raw table (ADR-0005).
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS custom_event_properties_15m_mv TO custom_event_properties_15m AS
SELECT
  site_id,
  toStartOfFifteenMinutes(toDateTime(occurred_at, 'UTC'))       AS bucket_start,
  name                                                          AS event_name,
  kv.1                                                          AS property_key,
  substringUTF8(if(JSONType(properties, kv.1) = 'String',
                   JSONExtractString(properties, kv.1), kv.2), 1, 100) AS property_value,
  count()                                                       AS events,
  uniqState(if(user_id != '', user_id, anonymous_id))           AS visitors
FROM events_raw
ARRAY JOIN JSONExtractKeysAndValuesRaw(properties) AS kv
WHERE name != ''
  AND NOT startsWith(lower(kv.1), 'oa_')
  AND lower(kv.1) != 'order_id'
  AND JSONType(properties, kv.1) IN ('String', 'Int64', 'UInt64', 'Double', 'Bool')
GROUP BY site_id, bucket_start, event_name, property_key, property_value;

CREATE TABLE IF NOT EXISTS custom_event_properties_1d
(
  site_id        UUID,
  bucket_start   DateTime('UTC'),
  event_name     String,
  property_key   String,
  property_value String,
  events         SimpleAggregateFunction(sum, UInt64),
  visitors       AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, event_name, property_key, property_value)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS custom_event_properties_1d_mv TO custom_event_properties_1d AS
SELECT
  site_id,
  toStartOfDay(toDateTime(occurred_at, 'UTC'))                  AS bucket_start,
  name                                                          AS event_name,
  kv.1                                                          AS property_key,
  substringUTF8(if(JSONType(properties, kv.1) = 'String',
                   JSONExtractString(properties, kv.1), kv.2), 1, 100) AS property_value,
  count()                                                       AS events,
  uniqState(if(user_id != '', user_id, anonymous_id))           AS visitors
FROM events_raw
ARRAY JOIN JSONExtractKeysAndValuesRaw(properties) AS kv
WHERE name != ''
  AND NOT startsWith(lower(kv.1), 'oa_')
  AND lower(kv.1) != 'order_id'
  AND JSONType(properties, kv.1) IN ('String', 'Int64', 'UInt64', 'Double', 'Bool')
GROUP BY site_id, bucket_start, event_name, property_key, property_value
