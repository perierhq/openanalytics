/**
 * The sessions read's series, on the overview chart's buckets.
 *
 * The sessions endpoint takes no `resolution`: it picks its own grain by
 * span (`resolveSession`), and only ever answers `hour` or `day`. The
 * chart asks the timeseries for its grain explicitly, so the two disagree
 * on most views: a 7- or 30-day chart draws days over an hourly sessions
 * series, and a 6- or 12-month chart draws ISO weeks over a daily one.
 *
 * Session counts are additive across buckets and the rates are derived from
 * them (the contract's `SessionMetricValues`), so a finer series folds into
 * the chart's buckets exactly: sum sessions, bounced sessions and total
 * duration, then divide. Averaging the rates would weigh a quiet hour like
 * a busy one.
 *
 * Type-only imports from `./api`: the web tests run before the contracts
 * package is built.
 */

import type { AnalyticsSessionsResponse, Resolution } from "./api";
import { bucketIndexOf } from "./event-markers";

export type SessionPointLike = Pick<
  AnalyticsSessionsResponse["series"][number],
  "bucket" | "sessions" | "bounced_sessions" | "avg_session_duration_ms"
>;

/** One chart bucket's session numbers; rates are `null` with no sessions. */
export type SessionBucket = {
  sessions: number;
  bounceRate: number | null;
  avgDurationMs: number | null;
};

/**
 * The series folded into the buckets that start at `starts` (ascending),
 * the last one ending at `endMs` (exclusive): each point lands in the last
 * bucket starting at or before it. Points outside the window are dropped,
 * as the markers are. One entry per bucket, in bucket order.
 *
 * A bucket with no sessions has no bounce rate and no average visit: the
 * API answers 0 there, and a line dropping to "0% bounce" over a quiet
 * night would be a claim nobody measured.
 */
export function bucketSessions(
  starts: readonly number[],
  endMs: number,
  points: readonly SessionPointLike[]
): SessionBucket[] {
  const sums = starts.map(() => ({ sessions: 0, bounced: 0, durationMs: 0 }));
  for (const point of points) {
    const at = Date.parse(point.bucket);
    if (Number.isNaN(at) || at >= endMs) continue;
    const index = bucketIndexOf(starts, at);
    const sum = sums[index];
    if (!sum) continue;
    sum.sessions += point.sessions;
    sum.bounced += point.bounced_sessions;
    sum.durationMs += point.avg_session_duration_ms * point.sessions;
  }
  return sums.map((sum) =>
    sum.sessions > 0
      ? {
          sessions: sum.sessions,
          bounceRate: sum.bounced / sum.sessions,
          avgDurationMs: sum.durationMs / sum.sessions,
        }
      : { sessions: 0, bounceRate: null, avgDurationMs: null }
  );
}

const GRAIN_RANK: Record<Resolution, number> = { minute: 0, hour: 1, day: 2, week: 3 };

/**
 * Whether a series served at `served` can be drawn on a chart at `chart`:
 * only when it is as fine or finer. A coarser one would pour a whole day
 * into one hour. The API's span rules make that impossible today (any
 * span short enough for an hourly chart gets hourly sessions); this is the
 * guard that keeps it impossible if either rule moves.
 */
export function sessionGrainFits(served: Resolution, chart: Resolution): boolean {
  return GRAIN_RANK[served] <= GRAIN_RANK[chart];
}
