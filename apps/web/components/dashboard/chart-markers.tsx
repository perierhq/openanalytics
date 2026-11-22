"use client";

import Link from "next/link";
import * as React from "react";
import {
  EventMarkers,
  type EventMarkerContentControls,
} from "@/components/charts/event-markers";
import {
  MentionGlyph,
  NoteGlyph,
  RevenueGlyph,
  SaleGlyph,
} from "@/components/dashboard/chart-marker-glyphs";
import { NoteForm, NotesSection, type NoteActions } from "@/components/dashboard/chart-notes";
import { PlusIcon } from "@/components/icons/hugeicons";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import {
  OVERVIEW_MARKER_KINDS,
  plural,
  type OverviewMarkerItem,
  type OverviewMarkerKind,
  type OverviewMarkerPayload,
} from "@/components/dashboard/chart-marker-kinds";
import { MentionAvatar } from "@/components/dashboard/mention-avatar";
import { UserAvatar } from "@/components/ui/user-avatar";
import { useSiteSummary } from "@/components/dashboard/site-summary-context";
import { useApiResource } from "@/hooks/use-api-resource";
import {
  LIVE_API,
  mentions,
  notes as notesApi,
  presentError,
  revenue,
  type AnalyticsRange,
  type ChartNote,
  type RevenueConnectionState,
  type RevenueTransaction,
} from "@/lib/api";
import {
  loadChartMarkers,
  loadChartNotes,
  parseHiddenLayers,
  saleAmount,
  saleTotals,
  sharedRevenueState,
  type ChartMarkerData,
  type ChartMarkerDeps,
  type ChartNoteDeps,
  type OverviewChartLayer,
} from "@/lib/chart-markers";
import { canWriteNotes, createMockNoteStore, defaultNoteTime } from "@/lib/chart-notes";
import { formatMoney } from "@/lib/currencies";
import type { EventMarkerBucket } from "@/lib/event-markers";
import { mentionExcerpt } from "@/lib/mentions";
import { MOCK_MEMBERS, MOCK_MENTIONS, MOCK_NOTES, MOCK_SALES } from "@/lib/mock";
import { cn } from "@/lib/utils";

/**
 * The overview chart's markers: sales, posts that mention the site and the
 * team's own notes, as points on the timeline, with a legend that hides any
 * kind and, for owners and admins, adds a note.
 *
 * The reads and their rules live in `lib/chart-markers.ts`; this file is the
 * drawing: each kind's glyph and words, the popover a bucket opens, and the
 * remembered show/hide choice.
 */

// The kinds (words, glyphs, the mention face) live in `chart-marker-kinds.tsx`;
// the glyphs in `chart-marker-glyphs.tsx`, shared with the day tooltip.
export type { OverviewMarkerKind };

export type { OverviewChartLayer };

const LEGEND: Array<{
  kind: OverviewChartLayer;
  label: string;
  Glyph: (props: { muted?: boolean }) => React.ReactElement;
}> = [
  { kind: "sale", label: "Sales", Glyph: SaleGlyph },
  { kind: "mention", label: "Mentions", Glyph: MentionGlyph },
  { kind: "note", label: "Notes", Glyph: NoteGlyph },
  { kind: "revenue", label: "Revenue", Glyph: RevenueGlyph },
];

/* ------------------------------------------------------------------ */
/* The remembered choice                                               */
/* ------------------------------------------------------------------ */

/**
 * The hidden layers, as a JSON array. `"revenue"` and then `"note"` joined the
 * marker kinds in the same `v1` array: an existing choice keeps working as it
 * was, and a build that predates either drops the entry it does not know.
 */
const HIDDEN_KEY = "oa:chart-markers:v1";
const listeners = new Set<() => void>();
/** Fallback for a browser that refuses storage. */
let memory: string | null = null;

function readHidden(): string {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function writeHidden(hidden: OverviewChartLayer[]): void {
  try {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden));
  } catch {
    // Blocked storage: the choice still holds until the page reloads.
    memory = JSON.stringify(hidden);
  }
  for (const listener of listeners) listener();
}

const subscribeHidden = (listener: () => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === HIDDEN_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
};

/** Which layers the reader has hidden, remembered per browser like the interval. */
export function useHiddenChartLayers(): [
  OverviewChartLayer[],
  (kind: OverviewChartLayer) => void,
] {
  const raw = React.useSyncExternalStore(
    subscribeHidden,
    () => memory ?? readHidden(),
    () => "[]"
  );
  const hidden = React.useMemo(() => parseHiddenLayers(raw), [raw]);
  const toggle = React.useCallback(
    (kind: OverviewChartLayer) => {
      writeHidden(
        hidden.includes(kind)
          ? hidden.filter((entry) => entry !== kind)
          : [...hidden, kind]
      );
    },
    [hidden]
  );
  return [hidden, toggle];
}

/* ------------------------------------------------------------------ */
/* The reads                                                           */
/* ------------------------------------------------------------------ */

/**
 * The connection read both revenue layers gate on: the sale markers here and
 * the revenue bars in `chart-revenue.tsx`, one read per site between them.
 */
export const liveRevenueState = sharedRevenueState((siteId, options) =>
  revenue.state(siteId, options)
);

const LIVE_DEPS: ChartMarkerDeps = {
  listMentions: (siteId, range, options) => mentions.list(siteId, range, options),
  revenueState: liveRevenueState,
  revenueTransactions: (siteId, range, options) =>
    revenue.transactions(siteId, range, options),
};

/**
 * Mock mode plays the same rules over fixtures: the provider counts as
 * connected (the revenue card's mock story), and the role gate in the loader
 * still keeps sales from an admin or a viewer.
 */
const MOCK_DEPS: ChartMarkerDeps = {
  listMentions: async () => ({ items: MOCK_MENTIONS }),
  revenueState: async () => ({ status: "active" }) as RevenueConnectionState,
  revenueTransactions: async () => ({ items: MOCK_SALES }),
};

const NONE: ChartMarkerData = { mentions: [], sales: [] };

/**
 * Mock mode's notes: the fixtures, and the writes applied to them in memory,
 * so adding, editing and deleting can be tried end to end without a server.
 * The author of a new note is the mock owner.
 */
const mockNoteStore = createMockNoteStore(MOCK_NOTES, MOCK_MEMBERS[0].name);

const LIVE_NOTE_DEPS: ChartNoteDeps = {
  listNotes: (siteId, range, options) => notesApi.list(siteId, range, options),
};
const MOCK_NOTE_DEPS: ChartNoteDeps = {
  listNotes: async () => mockNoteStore.list(),
};

const NO_NOTES: ChartNote[] = [];

/** A failed note write, in the words the rest of the dashboard uses. */
function describeNoteError(raised: unknown): string {
  const presented = presentError(raised);
  return presented.kind === "unknown" ? "The note wasn't saved. Try again." : presented.body;
}

function toItems(data: ChartMarkerData, notes: readonly ChartNote[]): OverviewMarkerItem[] {
  return [
    ...notes.map(
      (note): OverviewMarkerItem => ({
        id: note.id,
        kind: "note",
        at: Date.parse(note.at),
        payload: { kind: "note", note },
      })
    ),
    ...data.sales.map(
      (sale): OverviewMarkerItem => ({
        id: sale.object_id,
        kind: "sale",
        at: Date.parse(sale.occurred_at),
        payload: { kind: "sale", sale },
      })
    ),
    ...data.mentions.map(
      (mention): OverviewMarkerItem => ({
        id: mention.id,
        kind: "mention",
        at: Date.parse(mention.posted_at),
        payload: { kind: "mention", mention },
      })
    ),
  ];
}

export type OverviewMarkers = {
  items: OverviewMarkerItem[];
  /** The note writes, bound to the site; null for a viewer or while held. */
  noteActions: NoteActions | null;
};

/**
 * The markers for the chart's range. Waits for the site summary (the role
 * decides whether revenue is asked for at all, and whether notes can be
 * written), and reads nothing while `hold` is set: "all time" still finding
 * its start, or a caller (the public share board) that must not show markers
 * at all.
 *
 * A note write is reflected once the server answers with the note, by
 * applying that answer to the notes already read: no second read, and
 * nothing shown before it is stored.
 */
export function useOverviewMarkers(range: AnalyticsRange, hold: boolean): OverviewMarkers {
  const summary = useSiteSummary();
  const site = summary.site;

  const load = React.useCallback(
    async (signal: AbortSignal): Promise<ChartMarkerData> => {
      if (!site || hold) return new Promise<ChartMarkerData>(() => {});
      return loadChartMarkers(
        { siteId: site.site_id, role: site.role, range, signal },
        LIVE_API ? LIVE_DEPS : MOCK_DEPS
      );
    },
    [site, range, hold]
  );
  const resource = useApiResource(load);
  const data = resource.status === "ready" ? resource.data : NONE;

  const loadNotes = React.useCallback(
    async (signal: AbortSignal): Promise<ChartNote[]> => {
      if (!site || hold) return new Promise<ChartNote[]>(() => {});
      return loadChartNotes(
        { siteId: site.site_id, range, signal },
        LIVE_API ? LIVE_NOTE_DEPS : MOCK_NOTE_DEPS
      );
    },
    [site, range, hold]
  );
  const notesResource = useApiResource(loadNotes);
  const readNotes = notesResource.status === "ready" ? notesResource.data : NO_NOTES;

  // The writes confirmed since the last read, applied on top of it. Keyed on
  // the read they apply to, so a new range starts from its own read.
  const [confirmed, setConfirmed] = React.useState<{
    base: ChartNote[];
    notes: ChartNote[];
  } | null>(null);
  const notes = confirmed && confirmed.base === readNotes ? confirmed.notes : readNotes;
  const apply = React.useCallback(
    (change: (current: ChartNote[]) => ChartNote[]) =>
      setConfirmed((previous) => {
        const current =
          previous && previous.base === readNotes ? previous.notes : readNotes;
        return { base: readNotes, notes: change(current) };
      }),
    [readNotes]
  );

  const siteId = site?.site_id;
  const canWrite = site ? canWriteNotes(site.role) : false;
  const noteActions = React.useMemo<NoteActions | null>(() => {
    if (!siteId || !canWrite || hold) return null;
    return {
      timeZone: range.timezone,
      create: async (body) => {
        const note = LIVE_API
          ? await notesApi.create(siteId, body)
          : await mockNoteStore.create(body);
        apply((current) => [...current, note]);
      },
      update: async (id, body) => {
        if (body.at === undefined && body.text === undefined) return;
        const note = LIVE_API
          ? await notesApi.update(siteId, id, body)
          : await mockNoteStore.update(id, body);
        apply((current) => current.map((entry) => (entry.id === id ? note : entry)));
      },
      remove: async (id) => {
        if (LIVE_API) await notesApi.remove(siteId, id);
        else await mockNoteStore.remove(id);
        apply((current) => current.filter((entry) => entry.id !== id));
      },
      describeError: describeNoteError,
    };
  }, [siteId, canWrite, hold, range.timezone, apply]);

  const items = React.useMemo(() => toItems(data, notes), [data, notes]);
  return { items, noteActions };
}

/* ------------------------------------------------------------------ */
/* The layer, the legend and the popover                               */
/* ------------------------------------------------------------------ */

export function OverviewMarkersLegend({
  items,
  revenue = false,
  noteActions = null,
  className,
}: {
  items: readonly OverviewMarkerItem[];
  /** The chart has revenue bars to hide. */
  revenue?: boolean;
  /** Owners and admins get "Add note" at the end of the row. */
  noteActions?: NoteActions | null;
  className?: string;
}) {
  const [hidden, toggle] = useHiddenChartLayers();
  const present = LEGEND.filter((entry) =>
    entry.kind === "revenue"
      ? revenue
      : items.some((item) => item.kind === entry.kind)
  );
  if (present.length === 0 && noteActions === null) return null;
  return (
    <div
      aria-label="Chart layers"
      className={cn("flex select-none items-center gap-1", className)}
      role="group"
    >
      {present.map(({ kind, label, Glyph }) => {
        const shown = !hidden.includes(kind);
        return (
          <button
            aria-pressed={shown}
            className={cn(
              "flex h-6 cursor-pointer items-center gap-1.5 rounded-full border px-2 text-xs outline-none transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]",
              shown
                ? "border-border bg-background text-foreground/80"
                : "border-transparent bg-transparent text-muted-foreground [@media(hover:hover)]:hover:bg-black/5"
            )}
            key={kind}
            onClick={() => toggle(kind)}
            title={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            type="button"
          >
            <span className="flex size-2.5 items-center justify-center">
              <Glyph muted={!shown} />
            </span>
            {label}
          </button>
        );
      })}
      {noteActions ? <AddNoteButton actions={noteActions} /> : null}
    </div>
  );
}

/**
 * "Add note" at the end of the legend row: a small popover with the note
 * form, starting at now on the chart's clock. Opened by a click and closed by
 * Cancel, Escape, a click outside or a confirmed save.
 */
function AddNoteButton({ actions }: { actions: NoteActions }) {
  const [open, setOpen] = React.useState(false);
  // Read when the form opens, not on every render: the field starts at the
  // minute the person asked, and stays put while they type.
  const [openedAtMs, setOpenedAtMs] = React.useState(0);
  return (
    <Popover
      onOpenChange={(next) => {
        if (next) setOpenedAtMs(defaultNoteTime(Date.now()));
        setOpen(next);
      }}
      open={open}
    >
      {/* On a phone the four layer chips fill the row, so the button keeps
          its plus and its name moves to the label. */}
      <PopoverTrigger
        aria-label="Add note"
        className={cn(
          "flex h-6 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-transparent px-2 text-xs text-muted-foreground outline-none transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] max-sm:px-1.5",
          "data-popup-open:bg-black/5 data-popup-open:text-foreground [@media(hover:hover)]:hover:bg-black/5 [@media(hover:hover)]:hover:text-foreground"
        )}
        title="Add note"
      >
        <PlusIcon className="size-3.5" />
        <span className="max-sm:hidden">Add note</span>
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-72 max-w-[calc(100vw-2rem)]" side="bottom">
        {open ? (
          <NoteForm
            initialAtMs={openedAtMs}
            onCancel={() => setOpen(false)}
            onSubmit={async ({ atMs, text }) => {
              try {
                await actions.create({ at: new Date(atMs).toISOString(), text });
              } catch (raised) {
                throw new Error(actions.describeError(raised));
              }
              setOpen(false);
            }}
            submitLabel="Add note"
            timeZone={actions.timeZone}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/** The marker layer for `<AreaChart>`; drop it in beside the series. */
export function OverviewMarkers({
  items,
  endMs,
  slug,
  bucketLabel,
  timeLabel,
  noteActions = null,
}: {
  items: readonly OverviewMarkerItem[];
  endMs: number;
  slug: string;
  /** Owners and admins edit, delete and add notes in a marker's popover. */
  noteActions?: NoteActions | null;
  /** "Sun, Jul 12" — the chart tooltip's own title for the bucket. */
  bucketLabel: (date: Date) => string;
  /** "14:15" — a single item's time, in the chart's zone. */
  timeLabel: (date: Date) => string;
}) {
  const [hidden] = useHiddenChartLayers();
  const visible = React.useMemo(
    () => items.filter((item) => !hidden.includes(item.kind)),
    [items, hidden]
  );
  const base = `/dashboard/${encodeURIComponent(slug)}`;
  return (
    <EventMarkers
      bucketLabel={bucketLabel}
      endMs={endMs}
      items={visible}
      kinds={OVERVIEW_MARKER_KINDS}
      renderContent={(bucket, controls) => (
        <BucketPopover
          base={base}
          bucket={bucket}
          bucketLabel={bucketLabel}
          controls={controls}
          noteActions={noteActions}
          timeLabel={timeLabel}
        />
      )}
    />
  );
}
OverviewMarkers.__isPostOverlay = true;

const PREVIEW = 3;

const PURCHASE_LABEL: Partial<Record<NonNullable<RevenueTransaction["purchase_kind"]>, string>> = {
  renewal: "Renewal",
  plan_change: "Plan change",
};

function BucketPopover({
  bucket,
  base,
  bucketLabel,
  timeLabel,
  controls,
  noteActions,
}: {
  bucket: EventMarkerBucket<OverviewMarkerKind, OverviewMarkerPayload>;
  base: string;
  bucketLabel: (date: Date) => string;
  timeLabel: (date: Date) => string;
  controls: EventMarkerContentControls;
  noteActions: NoteActions | null;
}) {
  const sales = (bucket.byKind.sale ?? []).flatMap((item) =>
    item.payload.kind === "sale" ? [item.payload.sale] : []
  );
  const posts = (bucket.byKind.mention ?? []).flatMap((item) =>
    item.payload.kind === "mention" ? [item.payload.mention] : []
  );
  const bucketNotes = (bucket.byKind.note ?? []).flatMap((item) =>
    item.payload.kind === "note" ? [item.payload.note] : []
  );

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-xs font-medium text-muted-foreground">
        {bucketLabel(new Date(bucket.startMs))}
      </p>

      {sales.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <p className="flex items-center gap-2 font-medium">
            <SaleGlyph />
            <span>
              {plural(sales.length, "sale", "sales")}
              <span className="font-normal text-muted-foreground">
                {" · "}
                <span className="tabular-nums">
                  {saleTotals(sales)
                    .map((total) => formatMoney(total.amount_minor, total.currency))
                    .join(" + ")}
                </span>{" "}
                net
              </span>
            </span>
          </p>
          <ul className="flex flex-col gap-1.5 pl-4">
            {sales.slice(0, PREVIEW).map((sale) => {
              const amount = saleAmount(sale);
              const kind = sale.purchase_kind ? PURCHASE_LABEL[sale.purchase_kind] : undefined;
              return (
                <li className="flex items-center gap-2 text-xs leading-5" key={sale.object_id}>
                  {/* The buyer's face, the same one the realtime views draw;
                      a sale that matched no visitor keeps the diamond. */}
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    {sale.visitor ? <UserAvatar seed={sale.visitor} size={20} /> : <SaleGlyph />}
                  </span>
                  <span className="font-medium tabular-nums">
                    {formatMoney(amount.amount_minor, amount.currency)}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {timeLabel(new Date(sale.occurred_at))}
                  </span>
                  {kind ? <span className="text-muted-foreground">{kind}</span> : null}
                </li>
              );
            })}
          </ul>
          <PopoverLink href={`${base}/revenue`}>
            {sales.length > PREVIEW ? `View all ${sales.length}` : "View revenue"}
          </PopoverLink>
        </section>
      ) : null}

      {posts.length > 0 ? (
        <section
          className={cn(
            "flex flex-col gap-1.5",
            sales.length > 0 && "border-t border-border pt-3"
          )}
        >
          <p className="flex items-center gap-2 font-medium">
            <MentionGlyph />
            {plural(posts.length, "mention", "mentions")}
          </p>
          <ul className="flex flex-col gap-1.5 pl-4">
            {posts.slice(0, PREVIEW).map((post) => (
              <li className="flex items-start gap-2 text-xs leading-5" key={post.id}>
                <MentionAvatar author={post.author} size={20} />
                <span className="min-w-0">
                  <span className="font-medium">@{post.author.handle}</span>{" "}
                  <span className="text-muted-foreground">{mentionExcerpt(post.text)}</span>
                </span>
              </li>
            ))}
          </ul>
          <PopoverLink href={`${base}/mentions`}>View all</PopoverLink>
        </section>
      ) : null}

      {bucketNotes.length > 0 || noteActions ? (
        <div
          className={cn(
            (sales.length > 0 || posts.length > 0) && "border-t border-border pt-3"
          )}
        >
          <NotesSection
            actions={noteActions}
            bucketStartMs={bucket.startMs}
            notes={bucketNotes}
            onEngagedChange={controls.setEngaged}
            timeLabel={timeLabel}
          />
        </div>
      ) : null}
    </div>
  );
}

function PopoverLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      className="self-start rounded-sm pl-4 text-xs font-medium text-foreground/80 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      href={href}
    >
      {children}
    </Link>
  );
}
