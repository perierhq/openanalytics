import {
  Agreement01Icon,
  AiChat02Icon,
  ArrowRight02Icon,
  Link01Icon,
  Mail01Icon,
  Megaphone01Icon,
  Search01Icon,
  Target02Icon,
  UserGroupIcon,
} from "hugeicons-react";
import type * as React from "react";
import { Favicon } from "@/components/dashboard/site-favicon";
import type { SourceChannel } from "@/lib/api";
import type { FoldedRow } from "@/lib/source-rows";

const MARK_CLASS = "size-3.5 text-muted-foreground/70";

/** One mark per channel, from the dashboard's one icon set. Direct keeps the
 *  arrow it wears on the Referrers cut, AI the mark of the AI referrals card. */
const CHANNEL_MARKS: Record<
  SourceChannel,
  React.ComponentType<{ className?: string }>
> = {
  paid: Megaphone01Icon,
  email: Mail01Icon,
  affiliate: Agreement01Icon,
  ai: AiChat02Icon,
  organic_search: Search01Icon,
  social: UserGroupIcon,
  referral: Link01Icon,
  direct: ArrowRight02Icon,
};

/** Favicon for a real referrer, the channel's mark on the Channels cut, the
 *  arrow for Direct, a target for utm. */
export function sourceMark(row: FoldedRow): React.ReactNode {
  if (row.channel !== undefined) {
    const Mark = CHANNEL_MARKS[row.channel];
    return <Mark className={MARK_CLASS} />;
  }
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
    return <ArrowRight02Icon className={MARK_CLASS} />;
  }
  return <Target02Icon className={MARK_CLASS} />;
}
