import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { RevenueSegment, RevenueSegmentsResponse } from "@/lib/api";
import {
  ConfidenceDot,
  SegmentList,
  SegmentRow,
  SegmentsHiddenNote,
  SegmentsSmallPrint,
  SegmentTip,
  SegmentsInsufficient,
  SegmentsTable,
  SmoothingInfo,
} from "./revenue-segments-view";

const segment = (over: Partial<RevenueSegment>): RevenueSegment => ({
  source: "google.com",
  country: "DE",
  device: "desktop",
  visitors: 1_200,
  buyers: 30,
  orders: 33,
  revenue_minor: 90_000,
  unconverted_orders: 0,
  conversion_rate: 0.025,
  smoothed_conversion_rate: 34 / 1_400,
  average_order_value_minor: 90_000 / 33,
  value_per_visitor_minor: 75,
  smoothed_value_per_visitor_minor: 100_000 / 1_400,
  confidence: "high",
  ...over,
});

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

describe("a segment row", () => {
  it("shows the source, the flag, the device, smoothed value per visitor and conversion, and a confidence dot", () => {
    const out = html(createElement(SegmentRow, { segment: segment({}), currency: "USD" }));
    expect(out).toContain("Google");
    expect(out).toContain("/flags/de.svg");
    expect(out).toContain("Germany");
    expect(out).toContain("Desktop");
    // 100,000 / 1,400 = 71.4 minor units: $0.71 per visitor.
    expect(out).toContain("$0.71");
    expect(out).toContain("2.4%");
    expect(out).toContain("High confidence");
    // The raw figures are not the headline: the row does not print 75 per visitor.
    expect(out).not.toContain("$0.75");
  });

  it("calls the empty referrer Direct and the empty country and device unknown", () => {
    const out = html(
      createElement(SegmentRow, {
        segment: segment({ source: "", country: "", device: "", confidence: "low" }),
        currency: "USD",
      })
    );
    expect(out).toContain("Direct / none");
    expect(out).toContain("Unknown country");
    expect(out).toContain("Unknown device");
    expect(out).toContain("Low confidence");
  });
});

describe("the confidence dot", () => {
  it("names its band for a screen reader", () => {
    for (const band of ["low", "medium", "high"] as const) {
      const out = html(createElement(ConfidenceDot, { confidence: band }));
      expect(out).toMatch(new RegExp(`${band} confidence`, "i"));
    }
  });
});

describe("the full table", () => {
  const rows = [
    segment({ source: "google.com", visitors: 1_200, revenue_minor: 90_000 }),
    segment({
      source: "news.ycombinator.com",
      country: "US",
      device: "mobile",
      visitors: 40,
      revenue_minor: 20_000,
      smoothed_value_per_visitor_minor: 125,
      smoothed_conversion_rate: 0.025,
      confidence: "low",
    }),
  ];

  it("lists every segment in the chosen order, with the four sortable columns", () => {
    const out = html(
      createElement(SegmentsTable, {
        segments: rows,
        currency: "USD",
        sort: "visitors",
        onSort: () => {},
      })
    );
    for (const column of ["Per visitor", "Conversion", "New revenue", "Visitors"]) {
      expect(out).toContain(column);
    }
    expect(out).toContain('aria-sort="descending"');
    expect(out.indexOf("Google")).toBeLessThan(out.indexOf("Hacker News"));
    expect(out).toContain("$900.00");
    expect(out).toContain("1,200");
  });

  it("re-orders by value per visitor", () => {
    const out = html(
      createElement(SegmentsTable, {
        segments: rows,
        currency: "USD",
        sort: "value",
        onSort: () => {},
      })
    );
    expect(out.indexOf("Hacker News")).toBeLessThan(out.indexOf("Google"));
  });
});

describe("rows that read the same", () => {
  // google.com and google.de are both "Google"; from Germany on a desktop
  // they would be two identical rows without their hosts.
  const twins = [
    segment({ source: "google.com" }),
    segment({ source: "google.de", visitors: 300 }),
    segment({ source: "example.org", country: "US" }),
  ];

  it("shows the raw host as a second line in the table", () => {
    const out = html(
      createElement(SegmentsTable, {
        segments: twins,
        currency: "USD",
        sort: "value",
        onSort: () => {},
      })
    );
    expect(out).toContain(">google.com</span>");
    expect(out).toContain(">google.de</span>");
    // A label of its own needs no host under it.
    expect(out.match(/data-segment-host/g) ?? []).toHaveLength(2);
  });

  it("shows the raw host on the card too", () => {
    const out = html(createElement(SegmentList, { segments: twins, currency: "USD" }));
    expect(out.match(/data-segment-host/g) ?? []).toHaveLength(2);
    expect(out).toContain(">google.de</span>");
  });

  it("shows no host when every row reads differently", () => {
    const out = html(
      createElement(SegmentList, { segments: [twins[0]!, twins[2]!], currency: "USD" })
    );
    expect(out).not.toContain("data-segment-host");
  });
});

describe("the row tooltip", () => {
  it("says how many orders had no exchange rate", () => {
    const out = html(
      createElement(SegmentTip, { segment: segment({ unconverted_orders: 2 }), currency: "USD" })
    );
    expect(out).toContain("2 orders with no exchange rate not counted.");
    expect(out).not.toContain("other currencies");
    expect(out).toContain("New revenue");
  });
});

describe("the small print under the table", () => {
  const data = (over: {
    truncated?: boolean;
    hidden?: number;
    before?: number;
    missing?: number;
    rows?: number;
  }) =>
    ({
      meta: { truncated: over.truncated ?? false },
      status: "ok",
      site: {
        buyers_last_visit_before_range: over.before ?? 0,
        buyers_last_visit_missing: over.missing ?? 0,
      },
      segments: Array.from({ length: over.rows ?? 2 }, (_, i) =>
        segment({ source: `s${i}.example` })
      ),
      hidden_segments: over.hidden ?? 0,
      thresholds: { min_buyers: 10, min_segment_visitors: 20 },
    }) as unknown as RevenueSegmentsResponse;

  it("says the list is the top 500 when the read was cut", () => {
    const out = html(createElement(SegmentsSmallPrint, { data: data({ truncated: true, rows: 500 }) }));
    expect(out).toContain("Top 500 by value per visitor");
    expect(html(createElement(SegmentsSmallPrint, { data: data({}) }))).not.toContain("Top ");
  });

  it("counts the buyers whose last visit was before the range", () => {
    const out = html(createElement(SegmentsSmallPrint, { data: data({ before: 3 }) }));
    expect(out).toContain("3 buyers whose last visit was before this range aren&#x27;t counted.");
  });

  it("keeps the hidden-segment count, and is empty with nothing to say", () => {
    expect(html(createElement(SegmentsSmallPrint, { data: data({ hidden: 4 }) }))).toContain(
      "4 segments with fewer than 20 visitors are not shown."
    );
    expect(html(createElement(SegmentsSmallPrint, { data: data({}) }))).toBe("");
  });
});

describe("the insufficient-data state", () => {
  it("prints the counts and what is needed", () => {
    const data = {
      status: "insufficient_data",
      site: {
        visitors: 1_250,
        buyers: 4,
        orders: 4,
        revenue_minor: 12_000,
        unconverted_orders: 0,
        conversion_rate: 0.0032,
        value_per_visitor_minor: 9.6,
      },
      thresholds: { min_buyers: 10, min_segment_visitors: 20 },
    } as unknown as RevenueSegmentsResponse;
    const out = html(createElement(SegmentsInsufficient, { data }));
    expect(out).toContain("Not enough sales to rank traffic yet");
    expect(out).toContain("4 attributed buyers from 1,250 visitors");
    expect(out).toContain("at least 10");
  });
});

describe("the notes", () => {
  it("says how many small segments were left out, and nothing when none were", () => {
    expect(html(createElement(SegmentsHiddenNote, { hidden: 12, minVisitors: 20 }))).toContain(
      "12 segments with fewer than 20 visitors are not shown."
    );
    expect(html(createElement(SegmentsHiddenNote, { hidden: 1, minVisitors: 20 }))).toContain(
      "1 segment with fewer than 20 visitors is not shown."
    );
    expect(html(createElement(SegmentsHiddenNote, { hidden: 0, minVisitors: 20 }))).toBe("");
  });

  it("explains smoothing behind the ⓘ, and where the revenue comes from", () => {
    const out = html(createElement(SmoothingInfo));
    expect(out).toContain(
      "Small segments are pulled toward your site&#x27;s average so a handful of visits can&#x27;t look like a sure thing."
    );
    expect(out).toContain("from new subscriptions and one-off purchases");
  });
});
