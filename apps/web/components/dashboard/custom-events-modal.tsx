"use client";

import { ArrowDown01Icon, ArrowRight02Icon } from "hugeicons-react";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { useParams } from "next/navigation";
import * as React from "react";
import { CopyButton } from "@/components/ui/copy-button";
import {
  SeeAllModal,
  SeeAllSkeleton,
  useIntervalLabel,
} from "@/components/dashboard/see-all-modal";
import { RowBar } from "@/components/dashboard/row-bar";
import type { CustomEventRow } from "@/lib/api";
import { trafficBars, type BarSegment } from "@/lib/row-bars";
import { cn } from "@/lib/utils";

/**
 * Custom events, wide — the overview card's "See all", in the shared
 * vertical shell.
 *
 * Events are born in the customer's code and the dashboard *reads*. So this
 * modal does two jobs and no third: it teaches the two ways to create one,
 * and it shows every event the site sent with as much data as the read
 * carries.
 *
 * **The attribute is taught first, and that ordering is the whole point.**
 * `data-oa-event` (ADR-0037, shipped 2026-08-03; properties and middle-click
 * ADR-0038, 2026-08-04) marks an element in the markup and needs no
 * JavaScript, no build step and nothing configured on this side — which is
 * the answer to the question that killed the M13 rule builder: a non-technical
 * person could not write a selector, but they can put a word on a button.
 * `oa.track()` stays for events that are not a click.
 *
 * The M13 definitions surface (rule builder, versions, publish) used to live
 * here and was retired after field-testing. `display_name` still renders when
 * a definition exists, because the analytics read joins it server-side.
 */

/** Marking an element — the no-code path, so it goes first. */
const ATTRIBUTE_SNIPPET = '<button data-oa-event="signup">Sign up</button>';
/** For everything that is not a click. */
const TRACK_SNIPPET = "oa.track('signup', { plan: 'pro' })";

const LAST_SEEN_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** One teaching line: caption, code, copy. */
function SnippetRow({ caption, snippet }: { caption: string; snippet: string }) {
  return (
    <div className="flex items-center gap-1 rounded-xl bg-[#f6f6f6] py-1.5 pl-4 pr-1.5">
      <span className="shrink-0 text-[11px] font-medium text-muted-foreground/70">
        {caption}
      </span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs">
        {snippet}
      </code>
      <CopyButton label={`Copy ${caption} snippet`} text={snippet} />
    </div>
  );
}

export function CustomEventsModal({
  events,
  onClose,
}: {
  /** The card's range-scoped read; null while it is still on its way. */
  events: CustomEventRow[] | null;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const bar = trafficBars(events === null ? [] : events.map((row) => row.events));
  const intervalLabel = useIntervalLabel();
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";

  return (
    <SeeAllModal
      title="Custom events"
      subtitle={`Everything your site tracked · ${intervalLabel}`}
      header={
        // The two ways to create an event, with the copy gesture attached —
        // the whole teaching surface; anything longer belongs in the docs.
        <div className="flex flex-col gap-1.5">
          <SnippetRow caption="No code" snippet={ATTRIBUTE_SNIPPET} />
          <SnippetRow caption="In code" snippet={TRACK_SNIPPET} />
          {/* Always present, not only when the list is empty. The two lines
              above are the whole quick answer; someone who is here because
              they want to measure something *new* needs the long one, and a
              modal that only offers the way out when there is nothing in it
              is offering it at the one moment it is least wanted. */}
          <Link
            className="group inline-flex items-center gap-1 self-start px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            href={`/dashboard/${encodeURIComponent(slug)}/settings?tab=events`}
          >
            Track something new
            <ArrowRight02Icon
              aria-hidden="true"
              className="!size-3.5 transition-transform group-hover:translate-x-0.5"
            />
          </Link>
        </div>
      }
      onClose={onClose}
    >
      {events === null ? (
        <SeeAllSkeleton />
      ) : events.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-14 text-center">
          <p className="text-sm font-medium">No custom events yet</p>
          <p className="max-w-sm text-sm leading-6 text-muted-foreground">
            Put <code className="font-mono">data-oa-event</code> on any button
            or link you care about, or call <code className="font-mono">oa.track()</code>{" "}
            for anything that is not a click. New event names show up here on
            their own; there is nothing to configure on this side.
          </p>
        </div>
      ) : (
        <div>
          {/* column captions — once, not per row */}
          <div className="flex items-center justify-between gap-4 px-3 pb-1.5">
            <span className="text-xs font-medium text-muted-foreground/70">
              Event
            </span>
            <span className="flex items-baseline gap-2 pr-9">
              <span className="w-14 text-right text-xs font-medium text-muted-foreground/70">
                Events
              </span>
              <span className="w-14 text-right text-xs font-medium text-muted-foreground/70">
                Visitors
              </span>
            </span>
          </div>
          {events.map((row) => (
            <EventRow
              bar={bar(row.events)}
              key={`${row.event_name}-${row.event_type}`}
              row={row}
              expanded={expanded === row.event_name}
              onToggle={() =>
                setExpanded((current) =>
                  current === row.event_name ? null : row.event_name
                )
              }
            />
          ))}
        </div>
      )}
    </SeeAllModal>
  );
}

/**
 * When the newest event in the range fired, and on which path.
 *
 * `null` is a shipped answer, not a gap (frontend_tasks §30d): the range
 * predates the read, the row came from an import, or the event has not fired
 * in the range. It gets words — "No sample yet" — because an expanded row
 * that shows nothing where its neighbours show a timestamp reads as broken,
 * and this is the one place the contract explicitly asks the absence to be
 * said rather than implied.
 */
function LastSeen({ at, path }: { at: string | null; path: string | null }) {
  const fired = at === null ? null : new Date(at);
  if (fired === null || Number.isNaN(fired.getTime())) {
    return <p className="text-xs text-muted-foreground/70">No sample yet</p>;
  }
  return (
    <p className="text-xs text-muted-foreground">
      Last seen{" "}
      <span className="font-medium text-foreground">
        {LAST_SEEN_FMT.format(fired)}
      </span>
      {path !== null ? (
        <>
          {" on "}
          <span className="font-mono text-foreground">{path}</span>
        </>
      ) : null}
    </p>
  );
}

/**
 * The sample event's property bag, as chips.
 *
 * Values are scalars by contract, but `unknown` is what the generated type
 * says, so each is stringified rather than trusted into JSX — a value that
 * arrived as an object would otherwise render as `[object Object]` or throw.
 */
function SampleProperties({ properties }: { properties: unknown }) {
  if (properties === null || typeof properties !== "object") return null;
  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([key, value]) => (
        <span
          className="inline-flex items-center gap-1 rounded-md bg-black/5 px-1.5 py-0.5 font-mono text-[11px]"
          key={key}
        >
          <span className="text-muted-foreground">{key}</span>
          <span className="text-foreground">{String(value)}</span>
        </span>
      ))}
    </div>
  );
}

function EventRow({
  row,
  bar,
  expanded,
  onToggle,
}: {
  row: CustomEventRow;
  /** The bar behind the row's header, as in every breakdown list. */
  bar: BarSegment[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn("rounded-[14px] transition-colors", expanded && "bg-white")}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          "group relative flex w-full cursor-pointer items-center justify-between gap-4 rounded-[14px] px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          !expanded && "hover:bg-white/70"
        )}
      >
        <RowBar className="rounded-[14px]" segments={bar} />
        <span className="relative min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">
              {row.display_name ?? row.event_name}
            </span>
            {row.event_type === "conversion" ? (
              <Badge className="shrink-0" size="sm" variant="success">
                conversion
              </Badge>
            ) : null}
          </span>
          {/* The raw tracked name, when a definition renamed it — otherwise
              the title already says it. */}
          {row.display_name !== null ? (
            <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground/70">
              {row.event_name}
            </span>
          ) : null}
        </span>
        <span className="relative flex items-center gap-2">
          <span className="flex items-baseline gap-2">
            <span
              className="w-14 text-right text-sm tabular-nums text-foreground/80"
              title="Events"
            >
              {row.events.toLocaleString("en-US")}
            </span>
            <span
              className="w-14 text-right text-sm tabular-nums text-foreground/70"
              title="Unique visitors"
            >
              {row.visitors.toLocaleString("en-US")}
            </span>
          </span>
          <span className="flex w-7 justify-center">
            <ArrowDown01Icon
              aria-hidden="true"
              className={cn(
                "size-4 text-muted-foreground/50 transition-transform duration-200",
                expanded && "rotate-180"
              )}
            />
          </span>
        </span>
      </button>

      {expanded ? (
        <div className="flex flex-col gap-2 px-3 pb-3 pt-0.5">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <span className="text-muted-foreground">
              Events{" "}
              <span className="font-medium tabular-nums text-foreground">
                {row.events.toLocaleString("en-US")}
              </span>
            </span>
            <span className="text-muted-foreground">
              Visitors{" "}
              <span className="font-medium tabular-nums text-foreground">
                {row.visitors.toLocaleString("en-US")}
              </span>
            </span>
            {/* Billable differs from total only when test-mode traffic is in
                the range — worth a number exactly then. */}
            {row.billable_events !== row.events ? (
              <span className="text-muted-foreground">
                Billable{" "}
                <span className="font-medium tabular-nums text-foreground">
                  {row.billable_events.toLocaleString("en-US")}
                </span>
              </span>
            ) : null}
          </div>
          {row.display_template !== null ? (
            <p className="truncate font-mono text-xs text-muted-foreground/70">
              {row.display_template}
            </p>
          ) : null}

          {/* The newest event in the range — when it fired, where, and what it
              carried. All three come from one `argMax` over the same instant,
              so they describe the same event rather than three different ones.
              Absent together; the absence renders as "No sample yet". */}
          {/* `?? null` because the three are *optional as well as* nullable
              (contracts 267cfc5): a client compiled against the older row
              keeps compiling, so `undefined` is a shape we have to read. */}
          <LastSeen
            at={row.last_seen_at ?? null}
            path={row.sample_page_path ?? null}
          />

          {/* That event's own properties, as stored — already through the
              collector's redaction pass, one bag per event name, never a
              per-visitor stream. An event that fired with no properties
              answers `{}`, which is a different fact from `null` but shows the
              same way here: there is nothing to draw either way. */}
          <SampleProperties properties={row.sample_properties} />
        </div>
      ) : null}
    </div>
  );
}
