"use client";

import * as React from "react";
import type { ApiResource } from "@/hooks/use-api-resource";
import { retainedView, type RetainedAnswer } from "@/lib/retained-resource";

/**
 * `resource`, with its last answer kept up while the next read for the same
 * `key` is in flight (`retainedView`). `refreshing` says the figures shown
 * are that last answer.
 */
export function useRetainedResource<T>(
  resource: ApiResource<T>,
  key: string
): { resource: ApiResource<T>; refreshing: boolean } {
  const [last, setLast] = React.useState<RetainedAnswer<T> | null>(null);
  // Adjusting state while rendering, React's own pattern for state derived
  // from a changing input: the answer is remembered the render it arrives.
  if (
    resource.status === "ready" &&
    (last === null || last.key !== key || last.data !== resource.data)
  ) {
    setLast({ key, data: resource.data });
  }
  return retainedView(resource, key, last);
}
