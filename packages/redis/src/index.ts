/**
 * Redis/Valkey adapters.
 *
 * Docs snapshot 02 §5 keeps two Redis roles strictly apart, and the separation
 * is a durability boundary rather than a naming convention:
 *
 * - `event-stream` holds the durable ingest queue, consumer-group state, dedup
 *   keys and the DLQ. Separate instance, separate credential, eviction disabled.
 *   An evicted key here is a lost event.
 * - `realtime-cache` holds active-visitor state, Pub/Sub, rate-limit counters,
 *   locks and short query caches. Everything here is reconstructible; losing it
 *   degrades realtime but must never corrupt historical analytics.
 *
 * Both live behind these interfaces so the Milestone 1 proof can swap the
 * provider (docs snapshot 05, D-205) without the collector contract changing.
 * The transport is ioredis, which speaks RESP and therefore drives self-hosted
 * Valkey unchanged.
 */

export {
  ENQUEUE_OUTCOMES,
  isEnqueueConflict,
  type EnqueueAccepted,
  type EnqueueBatchResult,
  type EnqueueConflict,
  type EnqueueInput,
  type EnqueueOutcome,
  type ExcludedEnqueueInput,
  type EnqueueResult,
  type EventStreamConsumer,
  type EventStreamQueue,
  type FetchByIdResult,
  type PendingSummary,
  type QueueMaintenance,
  type ReclaimResult,
  type StreamMessage,
} from './queue.ts'

export {
  BUMP_EPOCH_SCRIPT,
  INCREMENT_WINDOWS_SCRIPT,
  PRESENCE_FEED_MAX,
  PRESENCE_PAGE_HISTORY_MAX,
  PRESENCE_PRESENT_MAX,
  PRESENCE_TOP_N,
  REALTIME_EPOCH_TTL_MS,
  REALTIME_FEED_WINDOW_MS,
  REALTIME_SITE_EPOCH_SUBJECT,
  GEO_RESOLVED_KEY,
  GEO_RESOLVED_TTL_SECONDS,
  RECORD_TAG_SIGHTING_SCRIPT,
  TAG_SIGHTING_MAX_ORIGINS,
  TAG_SIGHTING_ORIGIN_ABSENT,
  TAG_SIGHTING_TTL_SECONDS,
  TOUCH_VISITOR_SCRIPT,
  VISITOR_PRESENCE_WINDOW_MS,
  aggregatePresenceSnapshot,
  createRealtimeCache,
  parseTagSightings,
  utcDayOffset,
  type ChargedRateLimits,
  type EpochRef,
  type PresenceBrowser,
  type PresenceCity,
  type PresenceCount,
  type PresenceCountry,
  type PresenceDevice,
  type PresenceFeedEntry,
  type PresenceOperatingSystem,
  type PresenceSnapshot,
  type PresenceSnapshotInput,
  type PresenceTouchInput,
  type PresenceVisitor,
  type RateLimitChargeInput,
  type RealtimeCache,
  type RealtimeCacheOptions,
  type RecordBillableInput,
  type RecordTagSightingInput,
  type TagSighting,
  type UsageReadInput,
  type UsageReads,
} from './realtime.ts'

export {
  BOT_COUNTER_PREFIX,
  DAILY_BILLABLE_PREFIX,
  DAILY_CEILING_PREFIX,
  DAY_IN_SECONDS,
  DEDUP_KEY_PREFIX,
  EXCLUDED_RECORD_KEY_PREFIX,
  EVENT_STREAM_DLQ_KEY,
  EVENT_STREAM_GROUP,
  EVENT_STREAM_KEY,
  InvalidKeyComponentError,
  RATE_LIMIT_IDENTITY_PREFIX,
  RATE_LIMIT_IP_PREFIX,
  RATE_LIMIT_SITE_PREFIX,
  RATE_LIMIT_WINDOW_TTL_SECONDS,
  REALTIME_CONTROL_CHANNEL_PREFIX,
  REALTIME_EPOCH_PREFIX,
  REALTIME_FEED_PREFIX,
  REALTIME_UPDATES_CHANNEL_PREFIX,
  SITE_QUEUE_INDEX_PREFIX,
  SITE_QUEUE_INDEX_SEPARATOR,
  TAG_SIGHTING_PREFIX,
  USAGE_COUNTER_PREFIX,
  VISITOR_META_PREFIX,
  VISITOR_PAGES_PREFIX,
  VISITOR_PRESENCE_PREFIX,
  botCounterKey,
  dailyBillableKey,
  dailyCeilingKey,
  daysToSeconds,
  decodeSiteQueueIndexEntry,
  dedupKey,
  encodeSiteQueueIndexEntry,
  excludedRecordKey,
  MalformedSiteQueueIndexEntryError,
  minuteBucketOf,
  rateLimitIdentityKey,
  rateLimitIpKey,
  rateLimitSiteKey,
  realtimeControlChannel,
  realtimeEpochKey,
  realtimeFeedKey,
  realtimeUpdatesChannel,
  siteQueueIndexKey,
  tagSightingKey,
  usageCounterKey,
  utcDayOf,
  visitorMetaKey,
  visitorPagesKey,
  visitorPresenceKey,
  type SiteQueueIndexEntry,
} from './keys.ts'

export {
  QueueConnectionError,
  VALKEY_CONNECTION_MODES,
  buildConnectionOptions,
  createQueueClient,
  createRealtimeCacheClient,
  type ValkeyConnectionMode,
  type ValkeyConnectionOptions,
} from './client.ts'

export {
  ENQUEUE_SCRIPT,
  ENQUEUE_SCRIPT_SHA1,
  EmptyBatchError,
  EnqueueReplyError,
  buildEnqueueCall,
  createEventStreamQueue,
  isNoScriptError,
  parseEnqueueReply,
  type EnqueuePolicy,
  type EnqueueScriptCall,
  type EventStreamQueueOptions,
} from './enqueue.ts'

export {
  StreamMessageParseError,
  createEventStreamConsumer,
  isBusyGroupError,
  parseAutoClaimReply,
  parsePendingSummary,
  parseReadGroupReply,
  parseStreamEntries,
  type EventStreamConsumerOptions,
} from './consumer.ts'

export {
  createQueueMaintenance,
  infoFieldValue,
  lastDeliveredIdFor,
  minIdFor,
  safeTrimMinId,
  streamIdTimestampMs,
  type QueueMaintenanceOptions,
} from './maintenance.ts'
