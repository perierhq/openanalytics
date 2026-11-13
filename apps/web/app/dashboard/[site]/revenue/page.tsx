"use client";

import { useParams } from "next/navigation";
import * as React from "react";
import { IntervalProvider } from "@/components/dashboard/interval-context";
import { IntervalSelect } from "@/components/dashboard/interval-select";
import { RevenueBySource } from "@/components/dashboard/revenue-by-source";
import { RevenueOverview } from "@/components/dashboard/revenue-overview";
import { RevenueTransactions } from "@/components/dashboard/revenue-transactions";
import { SquircleSurface } from "@/components/ui/squircle-card";
import { useApiResource } from "@/hooks/use-api-resource";
import { LIVE_API, resolveSiteSlugCached, sites, type SiteSummary } from "@/lib/api";
import { mockSiteBySlug } from "@/lib/mock";

/**
 * Revenue — the transaction list and the journey behind any row (§25).
 *
 * It is its own route rather than a card on the overview because the list is
 * paginated and the journey is a dialog over it: both want the whole width,
 * and neither belongs in a 60-tall panel beside the traffic breakdowns.
 *
 * **Owner-only, gated on the role.** `revenue:read` refuses an admin with a
 * 403, so the page says so in words rather than letting four failed reads
 * paint an error screen — and the tab that leads here is hidden for them too.
 */
export default function RevenuePage() {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";

  const loadSite = React.useCallback(async (): Promise<SiteSummary> => {
    if (!LIVE_API) return mockSiteBySlug(slug);
    const { site_id } = await resolveSiteSlugCached(slug);
    return sites.get(site_id);
  }, [slug]);
  const site = useApiResource(loadSite);

  return (
    <IntervalProvider>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-xl font-medium tracking-tight">Revenue</h1>
          <div className="flex items-center gap-2">
            {/* No clock on this screen: the header wears the overview's, and
                only the overview's (Abbas, 2026-09-03). The pick made there
                is remembered per site, so this screen's windows follow it. */}
            <IntervalSelect />
          </div>
        </div>

        {site.status !== "ready" ? (
          <p className="px-1 py-8 text-center text-sm text-muted-foreground">
            Loading…
          </p>
        ) : site.data.role !== "owner" ? (
          <SquircleSurface className="border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
            <SquircleSurface className="rounded-[22px] border border-border bg-[#f6f6f6] px-4 py-2 [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]">
              <p className="px-1 py-8 text-center text-sm leading-6 text-muted-foreground">
                Only an owner can read this site&rsquo;s revenue. An admin can
                connect the provider in Settings, but the figures stay with the
                owner.
              </p>
            </SquircleSurface>
          </SquircleSurface>
        ) : (
          <>
            {/* The money, then every line behind it. */}
            <RevenueOverview siteId={site.data.site_id} />

            {/* Where the money came from, before the lines behind it. */}
            <RevenueBySource siteId={site.data.site_id} />

            <SquircleSurface
              className="flex flex-col border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
              render={<section />}
            >
              <p className="px-4 pb-1.5 pt-1 text-sm font-medium text-foreground/80">
                Transactions
              </p>
              <SquircleSurface className="overflow-hidden rounded-[22px] border border-border bg-[#f6f6f6] px-4 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]">
                <RevenueTransactions siteId={site.data.site_id} />
              </SquircleSurface>
            </SquircleSurface>
          </>
        )}
      </div>
    </IntervalProvider>
  );
}
