"use client";

import { useParams } from "next/navigation";
import * as React from "react";
import { ApiErrorPanel } from "@/components/dashboard/api-error";
import { FilteredRangePanel } from "@/components/dashboard/filter-context";
import {
  dataStateOf,
  DataStatePanel,
  FreshnessChip,
  ProvenanceChips,
} from "@/components/dashboard/data-state";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { useSquircleCardHeaderChip } from "@/components/ui/squircle-card";
import { useApiResource, type ApiResource } from "@/hooks/use-api-resource";
import {
  LIVE_API,
  resolveSiteSlugCached,
  type AnalyticsMeta,
  type PublicAnalyticsMeta,
  type AnalyticsRange,
  type PagesSort,
} from "@/lib/api";
import type { RequestOptions } from "@openanalytics/contracts";

/**
 * The shared plumbing for the overview mini cards: one analytics read per
 * card over the screen's shared interval, and one body component that owns
 * the four states every card has to design for — loading, failed, empty (in
 * its three freshness flavours), and rows.
 */

/**
 * One analytics read for the `[site]` in the URL. `fetcher` and `mock` must
 * be module constants — a fresh closure per render would refire the request
 * forever (same contract as `useApiResource`'s `load`).
 */
export function useSiteAnalytics<T>(
  fetcher: (
    siteId: string,
    range: AnalyticsRange,
    options?: RequestOptions & { filters?: string; sort?: PagesSort }
  ) => Promise<T>,
  mock: T,
  /**
   * Per-read query state beyond the range. `filters` is the ADR-0075 chip
   * row's serialized value and belongs only on the six reads that accept it
   * (overview, timeseries, pages, sources, geography, devices); a card
   * whose endpoint refuses filters simply never passes it, which is what
   * keeps the chip row from 400-ing custom events and performance. `sort`
   * is the pages ranking (a column header is a request change, ADR-0075 §3).
   * `enabled: false` holds the read (it stays loading and fires nothing) for
   * a card that only needs it once a cut that uses it is picked.
   */
  query?: { filters?: string; sort?: PagesSort; enabled?: boolean }
): ApiResource<T> {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const { range, rangePending } = useAnalyticsInterval();
  // Primitives out of the object, so a caller building `query` fresh each
  // render cannot refire the request with unchanged values.
  const filters = query?.filters;
  const sort = query?.sort;
  const enabled = query?.enabled ?? true;

  const load = React.useCallback(
    async (signal: AbortSignal): Promise<T> => {
      if (!enabled) return new Promise<T>(() => {});
      if (!LIVE_API) return mock;
      // "All time" before its anchor: the range in hand is a placeholder
      // about to be replaced. Hold the first skeleton instead of fetching
      // it — firing here played every card's reveal twice on refresh.
      if (rangePending) return new Promise<T>(() => {});
      const { site_id } = await resolveSiteSlugCached(slug);
      return fetcher(site_id, range, {
        signal,
        ...(filters !== undefined ? { filters } : {}),
        ...(sort !== undefined ? { sort } : {}),
      });
    },
    [fetcher, mock, slug, range, rangePending, filters, sort, enabled]
  );

  return useApiResource(load);
}

/** Five pulse rows, the shape of the list that is about to appear. */
function CardRowsSkeleton() {
  return (
    <ul aria-hidden="true">
      {[0, 1, 2, 3, 4].map((index) => (
        <li
          key={index}
          className="flex items-center justify-between gap-4 px-5 py-1.5"
        >
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <span className="size-2 shrink-0 rounded-full bg-muted-foreground/15" />
            <span
              className="my-1 h-3 animate-pulse rounded bg-muted-foreground/15"
              style={{ width: `${72 - index * 9}%` }}
            />
          </span>
          <span className="my-1 h-3 w-8 animate-pulse rounded bg-muted-foreground/15" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Renders a card body from an `ApiResource`. The cardinal rule lives here
 * once: an empty list is only called empty when freshness says `ok`/`no_data`
 * — a lagging or unverifiable pipeline says that instead, and a failed read
 * never masquerades as zero traffic.
 */
// Public metas carry no `freshness` (D-213); everything this body reads —
// `accuracy`, `data_sources`, and the optional freshness through
// `dataStateOf` — exists on both shapes.
export function AnalyticsCardBody<
  T extends { meta: AnalyticsMeta | PublicAnalyticsMeta },
>({
  resource,
  isEmpty,
  emptyBody,
  children,
}: {
  resource: ApiResource<T>;
  isEmpty: (data: T) => boolean;
  /** Card-specific wording for the true-empty case. */
  emptyBody: React.ReactNode;
  children: (data: T) => React.ReactNode;
}) {
  const setHeaderChip = useSquircleCardHeaderChip();

  const data = resource.status === "ready" ? resource.data : null;
  const empty = data !== null && isEmpty(data);
  const state = data === null ? null : dataStateOf(data.meta, empty);

  // The freshness chip rides beside the card's TITLE ("Browsers · Catching
  // up"), through the shell's header slot — a caveat about the whole card
  // belongs on the card's name, not floating over its first data row. Only
  // while rows are actually shown: the empty flavours explain freshness in
  // the panel itself, and a second marker above it would say it twice.
  // Registered from an effect keyed on the two primitives, so a render whose
  // chip is unchanged never re-registers.
  const chipKind =
    data !== null &&
    !empty &&
    state !== null &&
    (state.kind === "stale" || state.kind === "degraded")
      ? state.kind
      : null;
  const chipWatermark = state?.kind === "stale" ? state.watermark : null;
  React.useEffect(() => {
    if (setHeaderChip === null || chipKind === null) return;
    setHeaderChip(
      <FreshnessChip
        state={
          chipKind === "stale"
            ? { kind: "stale", watermark: chipWatermark }
            : { kind: "degraded" }
        }
      />
    );
    return () => setHeaderChip(null);
  }, [setHeaderChip, chipKind, chipWatermark]);

  if (resource.status === "error") {
    // The one refusal with a designed recovery: a filtered read over more
    // than 92 days. Retry would refuse identically, so instead of the
    // generic panel the card offers the two honest exits (ADR-0075 §2).
    if (resource.error.kind === "filtered_range") {
      return (
        <FilteredRangePanel className="gap-1 px-4 py-2 [&_p]:text-xs [&_p]:leading-5" />
      );
    }
    return (
      <ApiErrorPanel
        className="h-full gap-1 px-4 py-2 [&_p]:text-xs [&_p]:leading-5"
        error={resource.error}
        onRetry={resource.retry}
      />
    );
  }

  const ready = resource.status === "ready";
  let body: React.ReactNode = null;
  if (data !== null && state !== null) {
    body = empty ? (
      // `state` here is empty/stale/degraded, never ok — isEmpty forces it.
      <DataStatePanel
        emptyBody={emptyBody}
        state={state.kind === "ok" ? { kind: "empty" } : state}
      />
    ) : (
      <>
        {/* Provenance only — freshness moved up beside the title. Provenance
            is read per response — the same card is `['live']` on one range
            and `['live','imported']` on the next — so it cannot be hoisted
            to the screen. */}
        {data.meta.accuracy !== "exact" ||
        data.meta.data_sources.includes("imported") ? (
          <div className="flex flex-wrap justify-end gap-1.5 px-3 pb-1">
            <ProvenanceChips meta={data.meta} />
          </div>
        ) : null}
        {children(data)}
      </>
    );
  }

  return (
    <SkeletonReveal
      className="h-full [&>div]:h-full"
      ready={ready}
      skeleton={<CardRowsSkeleton />}
    >
      {body}
    </SkeletonReveal>
  );
}

/**
 * The share each row of a breakdown holds, for the `pct` a `BreakdownRow`
 * prints.
 *
 * **The denominator is the sum of the rows, never the largest of them.** Scaling
 * to the largest row makes the first row read `100%` on every card in the
 * dashboard, which says "all of your traffic came from here" about a row that
 * might hold a third of it. That is the bar's scale (`barScale`), and the bar
 * is drawn as one: `pct` is printed as a number, and a printed number has to be
 * true on its own.
 *
 * **`undefined` when the gateway capped the row set.** Then the sum is a sum of
 * what came back rather than of what exists, and every share computed from it is
 * inflated by the rows that did not. No percentage is better than a confident
 * wrong one, so the column simply does not appear.
 *
 * One limit that remains even when the number is shown, and is why these add up
 * to *about* 100 rather than exactly: a visitor is counted distinctly within a
 * row, not across rows, so somebody who arrived from two countries in the range
 * is in both. The alternative is a denominator that disagrees with the column
 * above it, which is worse.
 */
export function breakdownShare(
  visitors: readonly number[],
  truncated: boolean
): (value: number) => number | undefined {
  if (truncated) return () => undefined;
  const total = visitors.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return () => undefined;
  return (value: number) => Math.round((value / total) * 100);
}

export { BreakdownRow } from "@/components/dashboard/breakdown-row";
