import { createHash } from 'node:crypto'
import type { Policy } from '@openanalytics/domain'
import type { Redis } from 'ioredis'
import {
  EVENT_STREAM_KEY,
  daysToSeconds,
  dedupKey,
  excludedRecordKey,
  siteQueueIndexKey,
  utcDayOf,
} from './keys.ts'
import type {
  EnqueueBatchResult,
  EnqueueInput,
  EnqueueResult,
  EventStreamQueue,
  ExcludedEnqueueInput,
} from './queue.ts'

/**
 * Collector side of docs snapshot 05, D-209 step 1 — and of the all-or-nothing
 * batch rule in 02 §7.3.
 *
 * One script, taking a whole client batch. Every write D-209 describes happens
 * inside one `EVAL`: Valkey runs a script to completion without interleaving
 * another client, so the dedup read and the `XADD` cannot be split by a
 * concurrent retry of the same event — which is the exact window a client-side
 * check-then-append leaves open, and the one that produces a double-billed event
 * under a tracker retry storm.
 *
 * The script reads *every* event's dedup record before it writes any of them,
 * because §7.3 makes batch acceptance atomic: an event ID reused with different
 * bytes rejects the whole request, and a conflict is only visible by reading the
 * record. Checking as it went would leave a request that answered `409` having
 * already enqueued everything before the conflicting event.
 *
 * It is all-or-nothing per event too. A stream entry with no dedup record would
 * be re-enqueued by the next retry; a dedup record with no stream entry would
 * swallow the event and still answer `202`.
 *
 * Milestone 1's single-event script (ADR-0004) is this script with one event.
 * Keeping two implementations of the durability guarantee would let them drift,
 * and the drift would be invisible until something was double-billed, so
 * `enqueue` delegates here and the M1 gate test re-proves the same properties
 * against it (ADR-0009).
 */

export const ENQUEUE_SCRIPT = `
local stream_key = KEYS[1]
local count = tonumber(ARGV[1])
local dedup_ttl_seconds = tonumber(ARGV[2])
local index_ttl_seconds = tonumber(ARGV[3])

-- Pass one: read every dedup record before writing anything. Docs snapshot 02
-- §7.3 — one same-ID/different-hash conflict rejects the whole request, and no
-- part of it may already be enqueued when that answer is returned.
--
-- An event the site excluded has a record of its own (payload hash and time,
-- no stream entry), read here beside the counted one so the two answer alike:
-- a retry is a duplicate and a changed body is a conflict whichever list the
-- first delivery landed on.
local existing = {}
for i = 1, count do
  local dedup_key = KEYS[3 * i - 1]
  local excluded_key = KEYS[3 * i + 1]
  local base = 3 + (i - 1) * 6
  local payload_hash = ARGV[base + 3]

  local record = redis.call('HMGET', dedup_key, 'payload_hash', 'stream_id', 'accepted_at')
  if not record[1] then
    local remembered = redis.call('HMGET', excluded_key, 'payload_hash', 'accepted_at')
    if remembered[1] then
      record = { remembered[1], '', remembered[2] }
    end
  end
  if record[1] then
    -- Same ID, different bytes: the caller reused an event ID for new data. The
    -- original acceptance is reported back, along with the batch position, so
    -- the collector can name what it collided with.
    if record[1] ~= payload_hash then
      return { 'idempotency_conflict', tostring(i), record[2], record[3] }
    end
    existing[i] = record
  end
end

-- Pass two: nothing below can fail the batch, so every write here lands.
local reply = { 'ok' }
for i = 1, count do
  local prior = existing[i]
  local base = 3 + (i - 1) * 6

  if prior then
    -- Same ID, same bytes: an honest retry. No second stream row, and the first
    -- acceptance time is returned so usage stays attributed to the original
    -- billing window (docs snapshot 05, D-015).
    reply[#reply + 1] = 'duplicate'
    reply[#reply + 1] = prior[2]
    reply[#reply + 1] = prior[3]
  elseif ARGV[base + 6] == '1' then
    -- Excluded by the site: remembered for the dedup window as a hash and a
    -- time, and nothing else. No stream entry, no index entry, no payload.
    local excluded_key = KEYS[3 * i + 1]
    local payload_hash = ARGV[base + 3]
    local accepted_at = ARGV[base + 5]

    redis.call('HSET', excluded_key, 'payload_hash', payload_hash, 'accepted_at', accepted_at)
    redis.call('EXPIRE', excluded_key, dedup_ttl_seconds)

    reply[#reply + 1] = 'excluded'
    reply[#reply + 1] = ''
    reply[#reply + 1] = accepted_at
  else
    local dedup_key = KEYS[3 * i - 1]
    local index_key = KEYS[3 * i]
    local site_id = ARGV[base + 1]
    local event_id = ARGV[base + 2]
    local payload_hash = ARGV[base + 3]
    local payload = ARGV[base + 4]
    local accepted_at = ARGV[base + 5]

    local stream_id = redis.call(
      'XADD', stream_key, '*',
      'site_id', site_id,
      'event_id', event_id,
      'payload_hash', payload_hash,
      'accepted_at', accepted_at,
      'payload', payload
    )

    redis.call(
      'HSET', dedup_key,
      'payload_hash', payload_hash,
      'stream_id', stream_id,
      'accepted_at', accepted_at
    )
    redis.call('EXPIRE', dedup_key, dedup_ttl_seconds)

    -- Deletion walks these day buckets instead of the whole stream, which is what
    -- keeps it bounded (docs snapshot 05, D-210).
    --
    -- Both ids, packed: the stream entry is only half of what a site leaves in
    -- Redis. The other half is its dedup record, and ingest_dedup:{site}:{event}
    -- cannot be derived from a stream id — so a bucket holding stream ids alone
    -- gave deletion no way to find them short of scanning the keyspace, which is
    -- exactly the unbounded operation this bucket exists to avoid. The separator
    -- appears in neither a stream id (<ms>-<seq>) nor a UUID, so the pair is
    -- unambiguous.
    --
    -- The TTL is refreshed on every append, not only when the bucket opens. The
    -- bucket has to outlive every payload and dedup record it indexes, and an
    -- entry written late in the day carries a fresh full-length TTL of its own —
    -- a bucket pinned to its creation time could expire while the last records it
    -- names are still there, and deletion would then miss them silently. A busy
    -- site keeping one bucket alive is the intended trade: the bucket is a day's
    -- worth of ids, and it is bounded by the same retention its contents are.
    redis.call('RPUSH', index_key, stream_id .. '|' .. event_id)
    redis.call('EXPIRE', index_key, index_ttl_seconds)

    reply[#reply + 1] = 'enqueued'
    reply[#reply + 1] = stream_id
    reply[#reply + 1] = accepted_at
  end
end

return reply
`

export const ENQUEUE_SCRIPT_SHA1 = createHash('sha1').update(ENQUEUE_SCRIPT).digest('hex')

/** TTLs are policy, never literals here (docs snapshot 05, D-209 and AGENTS.md). */
export type EnqueuePolicy = Pick<Policy, 'INGEST_DEDUP_TTL_DAYS' | 'SITE_QUEUE_INDEX_TTL_DAYS'>

export interface EnqueueScriptCall {
  /** `[stream, dedup₁, index₁, excluded₁, dedup₂, index₂, excluded₂, …]`. */
  readonly keys: readonly string[]
  readonly argv: readonly string[]
}

export class EmptyBatchError extends Error {
  constructor() {
    super('An enqueue batch must contain at least one event')
    this.name = 'EmptyBatchError'
  }
}

/**
 * Builds the `EVAL` invocation for a whole batch.
 *
 * Keys are declared rather than constructed inside Lua so the script stays
 * cluster-analysable and every key it touches is visible at the call site. The
 * stream comes first because there is exactly one of it; each event then
 * contributes its dedup key, its day bucket and its excluded-record key, in
 * threes, which is what lets the script address event `i` as `KEYS[3i-1]`,
 * `KEYS[3i]` and `KEYS[3i+1]`. Every event declares all three whichever list
 * it is on, because pass one reads both records for every event.
 */
export function buildEnqueueCall(
  inputs: readonly (EnqueueInput | ExcludedEnqueueInput)[],
  options: { readonly policy: EnqueuePolicy; readonly streamKey?: string },
): EnqueueScriptCall {
  if (inputs.length === 0) throw new EmptyBatchError()

  const keys: string[] = [options.streamKey ?? EVENT_STREAM_KEY]
  const argv: string[] = [
    String(inputs.length),
    String(daysToSeconds(options.policy.INGEST_DEDUP_TTL_DAYS)),
    String(daysToSeconds(options.policy.SITE_QUEUE_INDEX_TTL_DAYS)),
  ]

  for (const input of inputs) {
    keys.push(dedupKey(input.siteId, input.eventId))
    keys.push(siteQueueIndexKey(input.siteId, utcDayOf(input.acceptedAt)))
    keys.push(excludedRecordKey(input.siteId, input.eventId))
    const excluded = input.excluded === true
    argv.push(
      input.siteId,
      input.eventId,
      input.payloadHash,
      excluded ? '' : input.payload,
      input.acceptedAt,
      excluded ? '1' : '0',
    )
  }

  return { keys, argv }
}

export class EnqueueReplyError extends Error {
  constructor(reply: unknown) {
    super(`Unrecognised enqueue script reply: ${JSON.stringify(reply)}`)
    this.name = 'EnqueueReplyError'
  }
}

function toText(part: unknown): string | null {
  if (typeof part === 'string') return part
  if (part instanceof Buffer) return part.toString('utf8')
  return null
}

/**
 * Turns the script's reply into the typed batch result.
 *
 * Strict by design: an unrecognised reply means the deployed script is not the
 * one this build expects, and guessing an outcome there would silently answer
 * `202` for an event nobody stored (docs snapshot 01 §4.3).
 */
export function parseEnqueueReply(reply: unknown, expected: number): EnqueueBatchResult {
  if (!Array.isArray(reply) || reply.length === 0) throw new EnqueueReplyError(reply)

  const head = toText(reply[0])

  if (head === 'idempotency_conflict') {
    if (reply.length !== 4) throw new EnqueueReplyError(reply)
    const index = Number(toText(reply[1]))
    const streamId = toText(reply[2])
    const acceptedAt = toText(reply[3])
    if (!Number.isInteger(index) || streamId === null || acceptedAt === null) {
      throw new EnqueueReplyError(reply)
    }
    return {
      outcome: 'idempotency_conflict',
      // Lua indexes from one; every caller here counts from zero.
      index: index - 1,
      conflictingStreamId: streamId,
      firstAcceptedAt: acceptedAt,
    }
  }

  if (head !== 'ok' || reply.length !== 1 + expected * 3) throw new EnqueueReplyError(reply)

  const results: EnqueueResult[] = []
  for (let i = 0; i < expected; i += 1) {
    const outcome = toText(reply[1 + i * 3])
    const streamId = toText(reply[2 + i * 3])
    const acceptedAt = toText(reply[3 + i * 3])
    if (streamId === null || acceptedAt === null) throw new EnqueueReplyError(reply)

    if (outcome === 'enqueued') {
      results.push({ outcome, enqueued: true, streamId, firstAcceptedAt: acceptedAt })
    } else if (outcome === 'duplicate' || outcome === 'excluded') {
      results.push({ outcome, enqueued: false, streamId, firstAcceptedAt: acceptedAt })
    } else {
      throw new EnqueueReplyError(reply)
    }
  }

  return { outcome: 'accepted', results }
}

/**
 * `NOSCRIPT` is the one EVALSHA failure that is not an error: it means the
 * server restarted or flushed its script cache since this process last ran.
 */
export function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('NOSCRIPT')
}

export interface EventStreamQueueOptions {
  readonly client: Redis
  readonly policy: EnqueuePolicy
  readonly streamKey?: string
}

export function createEventStreamQueue(options: EventStreamQueueOptions): EventStreamQueue {
  const { client } = options

  const run = async (call: EnqueueScriptCall): Promise<unknown> => {
    const args = [...call.keys, ...call.argv]
    try {
      // EVALSHA first: the collector sends this on every batch, and shipping the
      // script body each time is pure egress on the metered public hop (D-206).
      return await client.evalsha(ENQUEUE_SCRIPT_SHA1, call.keys.length, ...args)
    } catch (error) {
      if (!isNoScriptError(error)) throw error
      return await client.eval(ENQUEUE_SCRIPT, call.keys.length, ...args)
    }
  }

  const enqueueBatch = async (
    inputs: readonly (EnqueueInput | ExcludedEnqueueInput)[],
  ): Promise<EnqueueBatchResult> => {
    const call = buildEnqueueCall(inputs, {
      policy: options.policy,
      ...(options.streamKey === undefined ? {} : { streamKey: options.streamKey }),
    })
    return parseEnqueueReply(await run(call), inputs.length)
  }

  return {
    enqueueBatch,

    async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
      const batch = await enqueueBatch([input])
      if (batch.outcome === 'idempotency_conflict') {
        return {
          outcome: 'idempotency_conflict',
          enqueued: false,
          conflictingStreamId: batch.conflictingStreamId,
          firstAcceptedAt: batch.firstAcceptedAt,
        }
      }
      const result = batch.results[0]
      if (result === undefined) throw new EnqueueReplyError(batch)
      return result
    },
  }
}
