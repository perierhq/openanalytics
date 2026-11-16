"use client";

import { Target01Icon } from "hugeicons-react";
import { Badge } from "@/components/ui/badge";
import { AnimatePresence } from "motion/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import * as React from "react";
import {
  AnalyticsCardBody,
  useSiteAnalytics,
} from "@/components/dashboard/analytics-card";
import { CustomEventsModal } from "@/components/dashboard/custom-events-modal";
import { HoverList, HoverRow } from "@/components/dashboard/hover-list";
import { RowBar } from "@/components/dashboard/row-bar";
import {
  SquircleCard,
  SquircleCardScroll,
} from "@/components/ui/squircle-card";
import { getAnalyticsCustomEvents } from "@/lib/api";
import { MOCK_CUSTOM_EVENTS } from "@/lib/mock";
import { trafficBars } from "@/lib/row-bars";

/**
 * Custom events, from `GET /v1/sites/{site_id}/analytics/custom-events`.
 * One row per event name; conversions get a quiet marker so they read apart
 * from plain custom events without a second list.
 *
 * Brings its own SquircleCard: "See all" opens the wide custom-events modal
 * (teach the tracking line, show every event's data) rather than leading to
 * a page, so the header needs a click handler, not a href.
 */
export function CustomEventsCard() {
  const resource = useSiteAnalytics(
    getAnalyticsCustomEvents,
    MOCK_CUSTOM_EVENTS
  );
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const eventsTab = `/dashboard/${encodeURIComponent(slug)}/settings?tab=events`;
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <SquircleCard
        title="Custom events"
        icon={<Target01Icon aria-hidden="true" />}
        onSeeAll={() => setOpen(true)}
      >
        <AnalyticsCardBody
          emptyBody={
            // An empty card that only states the emptiness leaves the reader
            // where they were. The way out is one tab away, so it says so.
            <>
              Nothing here yet.{" "}
              <Link
                className="hover:text-black/80 underline underline-offset-4"
                href={eventsTab}
              >
                Start tracking now
              </Link>
              .
            </>
          }
          isEmpty={(data) => data.items.length === 0}
          resource={resource}
        >
          {(data) => {
            // The bar follows the number the row leads with: events.
            const bar = trafficBars(data.items.map((row) => row.events));
            return (
            <SquircleCardScroll>
              <HoverList>
                {data.items.map((row) => (
                  <HoverRow
                    backdrop={<RowBar segments={bar(row.events)} />}
                    key={`${row.event_name}-${row.event_type}`}
                  >
                    <div className="flex items-center justify-between gap-4 px-5 py-1.5">
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        {/* The definition's label when one exists; the raw
                            tracked name is a title away rather than a second
                            line the five-row panel has no room for. */}
                        <span
                          className="truncate text-sm"
                          title={
                            row.display_name === null
                              ? undefined
                              : row.event_name
                          }
                        >
                          {row.display_name ?? row.event_name}
                        </span>
                        {row.event_type === "conversion" ? (
                          <Badge
                            className="shrink-0"
                            size="sm"
                            variant="success"
                          >
                            conversion
                          </Badge>
                        ) : null}
                      </span>
                      <span className="flex items-baseline gap-2">
                        <span
                          className="text-sm tabular-nums text-foreground/80"
                          title="Events"
                        >
                          {row.events.toLocaleString("en-US")}
                        </span>
                        <span
                          className="w-14 text-right text-xs tabular-nums text-foreground/70"
                          title="Unique visitors"
                        >
                          {row.visitors.toLocaleString("en-US")}
                        </span>
                      </span>
                    </div>
                  </HoverRow>
                ))}
              </HoverList>
            </SquircleCardScroll>
            );
          }}
        </AnalyticsCardBody>
      </SquircleCard>

      <AnimatePresence>
        {open && (
          <CustomEventsModal
            events={resource.status === "ready" ? resource.data.items : null}
            onClose={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
