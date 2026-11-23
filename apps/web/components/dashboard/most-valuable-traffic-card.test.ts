// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiResource } from "@/hooks/use-api-resource";
import type { RevenueSegmentsResponse, RevenueSummaryResponse } from "@/lib/api";

/**
 * When "Most valuable traffic" exists on the overview. It decides on the
 * overview's one revenue summary read, and only an owner whose provider is
 * connected (or connected and failing to sync) gets the card and its segments
 * read. An admin or a viewer has no `revenue:read`, so their summary is a 403:
 * no card, and the segments read is never sent. Neither is it for an owner
 * with no provider.
 *
 * `@/lib/api` is mocked whole, so this test takes no runtime value from it
 * and runs without the contracts build.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const world = vi.hoisted(() => ({
  summary: { status: "loading" } as unknown,
  segmentsCalls: 0,
}));

vi.mock("@/lib/api", () => ({
  LIVE_API: true,
  resolveSiteSlugCached: async () => ({ site_id: "site-1" }),
  revenue: {
    segments: async () => {
      world.segmentsCalls += 1;
      return SEGMENTS;
    },
  },
  isUnauthenticated: () => false,
  presentError: () => ({ title: "Error", body: "", retryable: false }),
}));

vi.mock("@/lib/mock", () => ({
  MOCK_REVENUE_SEGMENTS: {},
  MOCK_REVENUE_SEGMENTS_INSUFFICIENT: {},
}));

// Stable, as Next's are: `useApiResource` keys its read on the router.
const NAVIGATION = vi.hoisted(() => ({
  params: { site: "demo" },
  router: { replace: () => {}, push: () => {} },
}));

vi.mock("next/navigation", () => ({
  useParams: () => NAVIGATION.params,
  useRouter: () => NAVIGATION.router,
}));

vi.mock("@/components/dashboard/overview-revenue-summary", () => ({
  useOverviewRevenueSummary: () => ({ resource: world.summary, refreshing: false }),
}));

// One range object, as the real context holds it: the segments read is keyed
// on it, and a new object every render would re-send it every render.
const INTERVAL = vi.hoisted(() => ({
  range: {
    from: "2026-06-23T00:00:00.000Z",
    to: "2026-07-23T00:00:00.000Z",
    timezone: "UTC",
  },
  rangePending: false,
}));

vi.mock("@/components/dashboard/interval-context", () => ({
  useAnalyticsInterval: () => INTERVAL,
}));

const SEGMENTS = {
  meta: { truncated: false },
  status: "ok",
  currency: "USD",
  site: {
    visitors: 2_000,
    buyers: 40,
    orders: 44,
    revenue_minor: 100_000,
    unconverted_orders: 0,
    buyers_last_visit_before_range: 0,
    buyers_last_visit_missing: 0,
    conversion_rate: 0.02,
    value_per_visitor_minor: 50,
  },
  segments: [],
  hidden_segments: 0,
  thresholds: {
    min_buyers: 10,
    min_segment_visitors: 20,
    confidence: { low_visitors: 100, low_buyers: 3, high_visitors: 1_000, high_buyers: 10 },
  },
  prior: { k: 200 },
} as unknown as RevenueSegmentsResponse;

const { MostValuableTrafficCard } = await import("./revenue-segments");

const summaryWith = (
  connection_status: "connected" | "degraded" | "disconnected" | "not_connected"
): ApiResource<RevenueSummaryResponse> => ({
  status: "ready",
  data: { meta: { revenue: { connection_status } } } as unknown as RevenueSummaryResponse,
});

/** What a non-owner's summary read answers: 403, no `revenue:read`. */
const forbidden: ApiResource<RevenueSummaryResponse> = {
  status: "error",
  error: { title: "Forbidden", body: "Revenue is available to a site owner only" } as never,
  retry: () => {},
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  world.segmentsCalls = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(summary: ApiResource<RevenueSummaryResponse>): Promise<void> {
  world.summary = summary;
  await act(async () => {
    root.render(createElement(MostValuableTrafficCard));
  });
  // Let a segments read, had one been sent, settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Most valuable traffic: when the card exists", () => {
  it("shows for an owner with revenue connected, and reads the segments", async () => {
    await render(summaryWith("connected"));
    expect(container.textContent).toContain("Most valuable traffic");
    expect(world.segmentsCalls).toBe(1);
  });

  it("shows for an owner whose provider is failing to sync: the figures still stand", async () => {
    await render(summaryWith("degraded"));
    expect(container.textContent).toContain("Most valuable traffic");
    expect(world.segmentsCalls).toBe(1);
  });

  it("hides for an admin or a viewer, whose summary is a 403, and never reads the segments", async () => {
    await render(forbidden);
    expect(container.textContent).toBe("");
    expect(world.segmentsCalls).toBe(0);
  });

  it("hides for an owner with no provider connected, and never reads the segments", async () => {
    await render(summaryWith("not_connected"));
    expect(container.textContent).toBe("");
    expect(world.segmentsCalls).toBe(0);
  });

  it("draws nothing and reads nothing while the summary is still in flight", async () => {
    await render({ status: "loading" });
    expect(container.textContent).toBe("");
    expect(world.segmentsCalls).toBe(0);
  });
});
