/**
 * Things that happened at a moment, placed on a time-series chart's buckets.
 *
 * Generic on purpose: mentions and sales use it today, and chart notes or
 * commits can join by naming a new `kind`. Nothing here knows what an item is;
 * it only knows when it happened.
 *
 * Bucketing uses the chart's own bucket starts rather than re-deriving a
 * grain: the chart has already cut its buckets in the request's timezone and
 * grain (hour, local day, ISO week), so "the last bucket that starts at or
 * before this instant" is the same bucket the traffic for that instant is in.
 */

export type EventMarkerItem<K extends string = string, P = unknown> = {
  /** Unique within its kind; used as the React key. */
  id: string;
  kind: K;
  /** When it happened, epoch milliseconds. */
  at: number;
  payload: P;
};

export type EventMarkerBucket<K extends string = string, P = unknown> = {
  /** Index into the chart's buckets. */
  index: number;
  startMs: number;
  /** Every item in the bucket, newest first. */
  items: EventMarkerItem<K, P>[];
  /** The kinds present, in the caller's kind order (then first-seen). */
  kinds: K[];
  byKind: Partial<Record<K, EventMarkerItem<K, P>[]>>;
  counts: Partial<Record<K, number>>;
};

/** Last index whose start is ≤ `at`, or -1. `starts` must be ascending. */
export function bucketIndexOf(starts: readonly number[], at: number): number {
  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((starts[mid] ?? Infinity) <= at) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * Groups `items` into the buckets that start at `starts` (ascending), with
 * the last bucket ending at `endMs` (exclusive). Items before the first
 * bucket or at/after the end are dropped: the chart does not draw there.
 *
 * Only buckets with at least one item are returned, in bucket order.
 */
export function bucketMarkers<K extends string, P>(
  starts: readonly number[],
  endMs: number,
  items: readonly EventMarkerItem<K, P>[],
  kindOrder: readonly K[] = []
): EventMarkerBucket<K, P>[] {
  if (starts.length === 0) return [];
  const grouped = new Map<number, EventMarkerItem<K, P>[]>();
  for (const item of items) {
    if (!Number.isFinite(item.at) || item.at >= endMs) continue;
    const index = bucketIndexOf(starts, item.at);
    if (index < 0) continue;
    const list = grouped.get(index);
    if (list) list.push(item);
    else grouped.set(index, [item]);
  }

  const rank = (kind: K) => {
    const position = kindOrder.indexOf(kind);
    return position === -1 ? kindOrder.length : position;
  };

  return [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, list]) => {
      const sorted = [...list].sort((a, b) => b.at - a.at);
      const byKind: Partial<Record<K, EventMarkerItem<K, P>[]>> = {};
      const counts: Partial<Record<K, number>> = {};
      const seen: K[] = [];
      // First-seen order over the chronological list, so unranked kinds keep
      // a stable order instead of following whichever arrived last.
      for (const item of [...list].sort((a, b) => a.at - b.at)) {
        if (!byKind[item.kind]) {
          byKind[item.kind] = [];
          seen.push(item.kind);
        }
      }
      for (const item of sorted) {
        byKind[item.kind]?.push(item);
        counts[item.kind] = (counts[item.kind] ?? 0) + 1;
      }
      const kinds = seen
        .map((kind, order) => ({ kind, order }))
        .sort((a, b) => rank(a.kind) - rank(b.kind) || a.order - b.order)
        .map((entry) => entry.kind);
      return {
        index,
        startMs: starts[index] ?? 0,
        items: sorted,
        kinds,
        byKind,
        counts,
      };
    });
}

/** Above this many buckets markers stay glyphs, whatever the width. */
export const FACE_BUCKET_LIMIT = 45;
/** A face is 20px; under this column width neighbouring faces would collide. */
export const FACE_MIN_COLUMN = 24;

/**
 * Whether a kind that has faces may draw them instead of its glyph: at most
 * 45 buckets, each wide enough to hold a face. The width check keeps a phone
 * on a 30-day range (about 12px a bucket) on glyphs instead of a row of
 * overlapping faces.
 */
export function markerFaceMode(bucketCount: number, columnWidth: number): boolean {
  return bucketCount <= FACE_BUCKET_LIMIT && columnWidth >= FACE_MIN_COLUMN;
}
