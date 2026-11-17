"use client";

import * as React from "react";

/**
 * Measures the widest `<text>` inside the returned ref's group and reports it
 * (`onWidth`) before paint, so the chart can give a right-hand axis exactly
 * the room its labels take. `signature` changes when the labels do.
 */
export function useAxisWidth(
  signature: string,
  onWidth: ((px: number) => void) | undefined
): React.RefObject<SVGGElement | null> {
  const ref = React.useRef<SVGGElement | null>(null);
  React.useLayoutEffect(() => {
    const group = ref.current;
    if (!group || !onWidth) return;
    let widest = 0;
    for (const text of group.querySelectorAll("text")) {
      widest = Math.max(widest, text.getComputedTextLength());
    }
    if (widest > 0) onWidth(Math.ceil(widest));
  }, [signature, onWidth]);
  return ref;
}
