import { ArrowRight02Icon, Target02Icon } from "hugeicons-react";
import type * as React from "react";
import { Favicon } from "@/components/dashboard/site-favicon";
import type { FoldedRow } from "@/lib/source-rows";

/** Favicon for a real referrer, the arrow for Direct, a target for utm. */
export function sourceMark(row: FoldedRow): React.ReactNode {
  if (row.domain !== null) {
    return (
      <Favicon
        key={row.domain}
        domain={row.domain}
        className="size-4 rounded-full border border-border/60 object-cover"
      />
    );
  }
  if (row.direct) {
    return <ArrowRight02Icon className="size-3.5 text-muted-foreground/70" />;
  }
  return <Target02Icon className="size-3.5 text-muted-foreground/70" />;
}
