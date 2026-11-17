"use client";

import { useParams } from "next/navigation";
import * as React from "react";
import { useSiteAnalytics } from "@/components/dashboard/analytics-card";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { useOverviewView } from "@/components/dashboard/overview-view";
import type { ApiResource } from "@/hooks/use-api-resource";
import { useRetainedResource } from "@/hooks/use-retained-resource";
import {
  revenue,
  type AnalyticsRange,
  type RevenueSummaryResponse,
} from "@/lib/api";
import { MOCK_REVENUE_SUMMARY } from "@/lib/mock";

/**
 * One revenue summary read for the overview, shared by the Revenue stat tile
 * and the Revenue panel in the grid. They used to read it separately, and
 * while comparing the tile asked with `compare=true` and the panel without:
 * two requests for one range on every change. Cards fetch independently and
 * nothing dedupes a GET in flight, so the overview reads it here once, with
 * `compare=true` while it compares (the panel ignores `comparison`), the way
 * `SourcesProvider` serves its two cards.
 *
 * Toggling Compare re-reads the same range; the figures in hand stay up while
 * that read is in flight (`refreshing`), rather than both cards dropping to
 * skeletons for numbers the screen already has.
 */
export type OverviewRevenueSummary = {
  resource: ApiResource<RevenueSummaryResponse>;
  /** The figures shown are the previous read's; the next is in flight. */
  refreshing: boolean;
};

const OverviewRevenueSummaryContext =
  React.createContext<OverviewRevenueSummary | null>(null);

/** The summary with the previous period beside it. Module-level, so
 * `useSiteAnalytics` sees a stable function. */
const summaryCompared = (
  siteId: string,
  range: AnalyticsRange,
  options?: { signal?: AbortSignal }
): Promise<RevenueSummaryResponse> =>
  revenue.summary(siteId, range, { signal: options?.signal, compare: true });

export function OverviewRevenueSummaryProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const { range } = useAnalyticsInterval();
  const { compare } = useOverviewView();
  const summary = useSiteAnalytics(
    compare ? summaryCompared : revenue.summary,
    MOCK_REVENUE_SUMMARY
  );
  // The figures are the same with or without the comparison: only the
  // site and the range change them.
  const { resource, refreshing } = useRetainedResource(
    summary,
    `${slug}|${range.from}|${range.to}|${range.timezone}`
  );
  const value = React.useMemo(
    () => ({ resource, refreshing }),
    [resource, refreshing]
  );
  return (
    <OverviewRevenueSummaryContext.Provider value={value}>
      {children}
    </OverviewRevenueSummaryContext.Provider>
  );
}

export function useOverviewRevenueSummary(): OverviewRevenueSummary {
  const value = React.useContext(OverviewRevenueSummaryContext);
  if (value === null) {
    throw new Error(
      "useOverviewRevenueSummary needs an <OverviewRevenueSummaryProvider> above it"
    );
  }
  return value;
}
