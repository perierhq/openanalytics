import { describe, expect, it } from "vitest";

import type { RevenueSegment, RevenueSegmentsResponse } from "@/lib/api";
import {
  confidenceLabel,
  countryLabel,
  deviceLabel,
  formatRate,
  insufficientDataCopy,
  leftOutBuyersCopy,
  SEGMENT_SORTS,
  segmentKey,
  segmentsNeedingHost,
  segmentsSpanTooLong,
  SEGMENTS_FETCH_LIMIT,
  SEGMENTS_SUBTITLE,
  segmentSourceLabel,
  sortSegments,
  SMOOTHING_NOTE,
  smoothingNote,
  truncatedCopy,
} from "./revenue-segments";

/** The response's `thresholds.confidence`, as the server sends it today. */
const EDGES = { low_visitors: 100, low_buyers: 3, high_visitors: 1_000, high_buyers: 10 };

const segment = (over: Partial<RevenueSegment>): RevenueSegment => ({
  source: "google.com",
  country: "DE",
  device: "desktop",
  visitors: 100,
  buyers: 2,
  orders: 2,
  revenue_minor: 10_000,
  unconverted_orders: 0,
  conversion_rate: 0.02,
  smoothed_conversion_rate: 0.02,
  average_order_value_minor: 5_000,
  value_per_visitor_minor: 100,
  smoothed_value_per_visitor_minor: 100,
  confidence: "medium",
  ...over,
});

describe("sortSegments", () => {
  const rows = [
    segment({ source: "a.example", smoothed_value_per_visitor_minor: 50, smoothed_conversion_rate: 0.04, revenue_minor: 300, visitors: 10 }),
    segment({ source: "b.example", smoothed_value_per_visitor_minor: 90, smoothed_conversion_rate: 0.01, revenue_minor: 100, visitors: 30 }),
    segment({ source: "c.example", smoothed_value_per_visitor_minor: 70, smoothed_conversion_rate: 0.02, revenue_minor: 200, visitors: 20 }),
  ];
  const order = (sort: Parameters<typeof sortSegments>[1]) =>
    sortSegments(rows, sort).map((row) => row.source);

  it("sorts by smoothed value per visitor, smoothed conversion, revenue or visitors, highest first", () => {
    expect(order("value")).toEqual(["b.example", "c.example", "a.example"]);
    expect(order("conversion")).toEqual(["a.example", "c.example", "b.example"]);
    expect(order("revenue")).toEqual(["a.example", "c.example", "b.example"]);
    expect(order("visitors")).toEqual(["b.example", "c.example", "a.example"]);
  });

  it("never reorders the array it was given", () => {
    sortSegments(rows, "visitors");
    expect(rows.map((row) => row.source)).toEqual(["a.example", "b.example", "c.example"]);
  });
});

describe("labels", () => {
  it("names the source the way the Sources card does, empty being Direct", () => {
    expect(segmentSourceLabel("")).toBe("Direct / none");
    expect(segmentSourceLabel("google.com")).toBe("Google");
    expect(segmentSourceLabel("example.org")).toBe("example.org");
  });

  it("names countries and devices, and says unknown for the empty value", () => {
    expect(countryLabel("DE")).toBe("Germany");
    expect(countryLabel("")).toBe("Unknown country");
    expect(deviceLabel("desktop")).toBe("Desktop");
    expect(deviceLabel("mobile")).toBe("Mobile");
    expect(deviceLabel("")).toBe("Unknown device");
  });

  it("keys a segment on all three parts", () => {
    expect(segmentKey(segment({}))).not.toBe(segmentKey(segment({ device: "mobile" })));
  });
});

describe("segmentsSpanTooLong", () => {
  const range = (from: string, to: string) => ({ from, to, timezone: "UTC" });

  it("allows exactly 92 days and refuses 93", () => {
    expect(segmentsSpanTooLong(range("2026-04-22T00:00:00.000Z", "2026-07-23T00:00:00.000Z"))).toBe(false);
    expect(segmentsSpanTooLong(range("2026-04-21T00:00:00.000Z", "2026-07-23T00:00:00.000Z"))).toBe(true);
  });

  it("measures the range rounded outward to quarter hours, as the api does", () => {
    // 92 days to the minute, but unaligned: the api reads 00:00 to 00:15,
    // 92 days and a quarter hour, and refuses it.
    expect(segmentsSpanTooLong(range("2026-04-22T00:07:00.000Z", "2026-07-23T00:07:00.000Z"))).toBe(true);
    // A minute under 92 days that rounds out to exactly 92: allowed.
    expect(segmentsSpanTooLong(range("2026-04-22T00:01:00.000Z", "2026-07-23T00:00:00.000Z"))).toBe(false);
  });
});

describe("formatRate", () => {
  it("keeps one decimal under 10%, none above", () => {
    expect(formatRate(0.025)).toBe("2.5%");
    expect(formatRate(0.25)).toBe("25%");
    expect(formatRate(null)).toBe("—");
  });
});

describe("copy", () => {
  it("explains smoothing in plain words, and says the revenue is new purchases only", () => {
    expect(SMOOTHING_NOTE).toBe(
      "Small segments are pulled toward your site's average so a handful of visits can't look like a sure thing. Value per visitor counts new revenue, from new subscriptions and one-off purchases."
    );
    expect(SEGMENTS_SUBTITLE).toContain("from new subscriptions and one-off purchases");
  });

  it("adds what the confidence dot means to the ⓘ, from the response's edges", () => {
    expect(smoothingNote(EDGES)).toBe(
      `${SMOOTHING_NOTE} The dot shows how much data is behind a row: low under 100 visitors or 3 buyers, high from 1,000 visitors and 10 buyers.`
    );
    // The numbers are the response's, not the copy's.
    expect(
      smoothingNote({ low_visitors: 50, low_buyers: 2, high_visitors: 5_000, high_buyers: 25 })
    ).toContain("low under 50 visitors or 2 buyers, high from 5,000 visitors and 25 buyers.");
    // No edges (nothing loaded yet, so no dots on screen): no dot sentence.
    expect(smoothingNote(undefined)).toBe(SMOOTHING_NOTE);
  });

  it("labels each confidence band in short, with the same edges", () => {
    expect(confidenceLabel("low", EDGES)).toBe("Low confidence: under 100 visitors or 3 buyers");
    expect(confidenceLabel("medium", EDGES)).toBe(
      "Medium confidence: at least 100 visitors and 3 buyers"
    );
    expect(confidenceLabel("high", EDGES)).toBe(
      "High confidence: at least 1,000 visitors and 10 buyers"
    );
  });

  it("calls the revenue column New revenue", () => {
    expect(SEGMENT_SORTS.map((column) => column.label)).toEqual([
      "Per visitor",
      "Conversion",
      "New revenue",
      "Visitors",
    ]);
  });

  it("names the buyers left out because their last visit was not in the range", () => {
    const site = (before: number, missing: number) =>
      ({
        buyers_last_visit_before_range: before,
        buyers_last_visit_missing: missing,
      }) as RevenueSegmentsResponse["site"];
    expect(leftOutBuyersCopy(site(0, 0))).toBeNull();
    expect(leftOutBuyersCopy(site(3, 0))).toBe(
      "3 buyers whose last visit was before this range aren't counted."
    );
    expect(leftOutBuyersCopy(site(1, 0))).toBe(
      "1 buyer whose last visit was before this range isn't counted."
    );
    expect(leftOutBuyersCopy(site(2, 1))).toBe(
      "2 buyers whose last visit was before this range and 1 whose last visit wasn't recorded aren't counted."
    );
    expect(leftOutBuyersCopy(site(0, 2))).toBe(
      "2 buyers whose last visit wasn't recorded aren't counted."
    );
  });

  it("reads the whole list, 500 segments, and says so when there were more", () => {
    expect(SEGMENTS_FETCH_LIMIT).toBe(500);
    expect(truncatedCopy(500)).toBe("Top 500 by value per visitor");
  });
});

describe("segmentsNeedingHost", () => {
  it("marks the rows whose source, country and device read the same", () => {
    const rows = [
      segment({ source: "google.com", country: "DE", device: "desktop" }),
      segment({ source: "google.de", country: "DE", device: "desktop" }),
      segment({ source: "google.com", country: "DE", device: "mobile" }),
      segment({ source: "example.org", country: "DE", device: "desktop" }),
    ];
    expect([...segmentsNeedingHost(rows)].sort()).toEqual(
      [segmentKey(rows[0]!), segmentKey(rows[1]!)].sort()
    );
  });

  it("marks nothing when every label is its own", () => {
    expect(segmentsNeedingHost([segment({}), segment({ country: "US" })]).size).toBe(0);
  });

  it("says what the insufficient-data state needs, with the counts", () => {
    const data = {
      site: { buyers: 4, visitors: 1_250 },
      thresholds: { min_buyers: 10, min_segment_visitors: 20 },
    } as Pick<RevenueSegmentsResponse, "site" | "thresholds"> as RevenueSegmentsResponse;
    expect(insufficientDataCopy(data)).toEqual({
      title: "Not enough sales to rank traffic yet",
      body: "This range has 4 attributed buyers from 1,250 visitors. Ranking needs at least 10. Pick a longer range, up to 92 days, or check back after more sales.",
    });
    const one = { ...data, site: { ...data.site, buyers: 1 } } as RevenueSegmentsResponse;
    expect(insufficientDataCopy(one).body).toContain("1 attributed buyer from");
  });
});
