"use client";

import { useParams } from "next/navigation";
import { IntervalProvider } from "@/components/dashboard/interval-context";
import { IntervalSelect } from "@/components/dashboard/interval-select";
import { MentionsList } from "@/components/dashboard/mentions-list";
import { useSiteSummary } from "@/components/dashboard/site-summary-context";
import { SquircleSurface } from "@/components/ui/squircle-card";

/**
 * Mentions: the public posts on X that mention this site, in the screen's
 * range. Its own route for the same reason Revenue has one: the list is
 * paginated and wants the full width.
 *
 * Every member can read it. The site comes from the lifecycle gate's summary,
 * which every screen under the segment already has, so this page fetches no
 * identity of its own.
 */
export default function MentionsPage() {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const summary = useSiteSummary();

  return (
    <IntervalProvider>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-medium tracking-tight">Mentions</h1>
          <IntervalSelect />
        </div>

        <SquircleSurface
          className="flex flex-col border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
          render={<section aria-label="Posts on X" />}
        >
          <p className="px-4 pb-1.5 pt-1 text-sm font-medium text-foreground/80">
            Posts on X
          </p>
          <SquircleSurface className="overflow-hidden rounded-[22px] border border-border bg-[#f6f6f6] px-4 py-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:12px] sm:rounded-[44px] sm:px-6 sm:[--card-clip-radius:17px]">
            {summary.site ? (
              <MentionsList site={summary.site} slug={slug} />
            ) : (
              <p className="px-1 py-8 text-center text-sm text-muted-foreground">
                Loading…
              </p>
            )}
          </SquircleSurface>
        </SquircleSurface>
      </div>
    </IntervalProvider>
  );
}
