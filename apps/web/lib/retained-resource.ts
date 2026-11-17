/**
 * Stale-while-loading for a read whose figures do not change when it is
 * re-asked: the last answer stays up while the next one is in flight, as
 * long as both are for the same figures (`key`).
 *
 * Toggling Compare is the case: the overview re-reads the same range with the
 * previous period beside it, and the current numbers in hand are still the
 * current numbers. Blanking them to skeletons for that read would show the
 * screen forgetting something it knows. A different range or filter is a
 * different key, and loads as usual.
 *
 * Type-only import: the web tests run before the contracts package is built.
 */

import type { ApiResource } from "@/hooks/use-api-resource";

export type RetainedAnswer<T> = { key: string; data: T };

export function retainedView<T>(
  resource: ApiResource<T>,
  key: string,
  last: RetainedAnswer<T> | null
): { resource: ApiResource<T>; refreshing: boolean } {
  if (resource.status === "loading" && last !== null && last.key === key) {
    return { resource: { status: "ready", data: last.data }, refreshing: true };
  }
  return { resource, refreshing: false };
}
