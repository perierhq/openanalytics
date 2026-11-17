"use client";

import { useParams } from "next/navigation";
import * as React from "react";
import { useAnalyticsFilters } from "@/components/dashboard/filter-context";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { useOverviewView } from "@/components/dashboard/overview-view";
import { useApiResource, type ApiResource } from "@/hooks/use-api-resource";
import {
  getAnalyticsSessions,
  LIVE_API,
  resolveSiteSlugCached,
  type AnalyticsSessionsResponse,
} from "@/lib/api";
import {
  MOCK_OVERVIEW_SESSIONS,
  MOCK_OVERVIEW_SESSIONS_PREVIOUS,
} from "@/lib/mock";
import {
  sessionsPreviousRange,
  type PublishedComparison,
} from "@/lib/overview-compare";

/**
 * The overview's sessions reads, shared by the stat tiles and the chart: the
 * tiles print bounce rate and average visit, and the chart draws either one
 * over time when its tile is pressed. One read each, folded twice, the way
 * `SourcesProvider` serves its two cards.
 *
 * `previous` is the previous period's read. The sessions endpoint takes no
 * `compare`, so it is asked for the previous window directly, and that window
 * is the server's own: the overview read publishes the `comparison_range` it
 * compared against (`publishComparison`), and this read waits for it. For a
 * period still in progress the server cuts that window at the same elapsed
 * point, and a window computed here could not know where (`as_of` is the
 * server's). Only while comparing, and never under a filter, which the
 * sessions read cannot take (the session tiles print a dash there).
 *
 * The share board renders the chart without this provider; the chart reads
 * `null` there and has no session metric to draw.
 */
export type OverviewSessions = {
  current: ApiResource<AnalyticsSessionsResponse>;
  /** Ready with `null` when not comparing. */
  previous: ApiResource<AnalyticsSessionsResponse | null>;
  /** Whether `previous` is being read at all. */
  comparing: boolean;
  /** The overview read's answer: which window it compared against. */
  publishComparison: (published: PublishedComparison) => void;
};

const OverviewSessionsContext = React.createContext<OverviewSessions | null>(null);

export function OverviewSessionsProvider({ children }: { children: React.ReactNode }) {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const { range, rangePending } = useAnalyticsInterval();
  const { active: filtersActive } = useAnalyticsFilters();
  const { compare } = useOverviewView();
  const comparing = compare && !filtersActive;
  const [published, setPublished] = React.useState<PublishedComparison | null>(null);
  const publishComparison = React.useCallback((next: PublishedComparison) => {
    setPublished((current) =>
      current &&
      current.forRange.from === next.forRange.from &&
      current.forRange.to === next.forRange.to &&
      current.forRange.timezone === next.forRange.timezone &&
      current.window?.from === next.window?.from &&
      current.window?.to === next.window?.to
        ? current
        : next
    );
  }, []);
  const previousWindow = sessionsPreviousRange(range, published);
  // A primitive key, so a re-published equal window refires nothing.
  const previousKey =
    previousWindow === undefined
      ? "pending"
      : previousWindow === null
        ? "none"
        : `${previousWindow.from}|${previousWindow.to}|${previousWindow.timezone}`;

  const loadCurrent = React.useCallback(
    async (signal: AbortSignal): Promise<AnalyticsSessionsResponse> => {
      if (!LIVE_API) return MOCK_OVERVIEW_SESSIONS;
      // All-time's anchor is still on its way — hold, don't double-fetch.
      if (rangePending) {
        return new Promise<AnalyticsSessionsResponse>(() => {});
      }
      const { site_id } = await resolveSiteSlugCached(slug);
      return getAnalyticsSessions(site_id, range, { signal });
    },
    [slug, range, rangePending]
  );
  const current = useApiResource(loadCurrent);

  const loadPrevious = React.useCallback(
    async (signal: AbortSignal): Promise<AnalyticsSessionsResponse | null> => {
      if (!comparing) return null;
      if (!LIVE_API) return MOCK_OVERVIEW_SESSIONS_PREVIOUS;
      // The overview has not said which window it compared yet: hold.
      if (rangePending || previousKey === "pending") {
        return new Promise<AnalyticsSessionsResponse | null>(() => {});
      }
      if (previousKey === "none") return null;
      const [from = "", to = "", timezone = ""] = previousKey.split("|");
      const { site_id } = await resolveSiteSlugCached(slug);
      return getAnalyticsSessions(site_id, { from, to, timezone }, { signal });
    },
    [slug, rangePending, comparing, previousKey]
  );
  const previous = useApiResource(loadPrevious);

  const value = React.useMemo(
    () => ({ current, previous, comparing, publishComparison }),
    [current, previous, comparing, publishComparison]
  );
  return (
    <OverviewSessionsContext.Provider value={value}>
      {children}
    </OverviewSessionsContext.Provider>
  );
}

/** The shared reads, or `null` on a screen without the provider. */
export function useOverviewSessions(): OverviewSessions | null {
  return React.useContext(OverviewSessionsContext);
}
