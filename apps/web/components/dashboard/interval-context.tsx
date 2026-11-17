"use client";

import { useParams } from "next/navigation";
import * as React from "react";
import {
  LIVE_API,
  resolveSiteSlugCached,
  sites,
  type AnalyticsRange,
} from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { useSiteSummary } from "@/components/dashboard/site-summary-context";
import {
  isUsableTimezone,
  resolveTimezone,
  resolveViewingTimezone,
  sessionTimezone,
} from "@/lib/timezone";
import { zonedDayStart } from "@/lib/zoned-day";

/**
 * The overview screen's shared time range. One provider per screen; every
 * analytics panel reads the same `range`, so picking an interval refetches
 * them all together instead of each panel keeping its own idea of "now".
 *
 * Calendar boundaries are cut in the *viewing* timezone and the same zone is
 * sent as the `timezone` parameter. Since ADR-0079 D5 that zone is the
 * **site's** (`sites.reporting_timezone`) by default rather than each reader's
 * own: two people looking at one site should see the same day boundary unless
 * one of them asked for a different one. `resolveViewingTimezone` is the whole
 * rule and the header pill is how somebody asks — the pick moves this view for
 * this visit and never writes the site's column.
 *
 * "All time" anchors on `min(created_at, first_event_at)`: `first_event_at`
 * can precede `created_at` by up to 24 hours (a client-stamped event the
 * collector accepted late), and anchoring on `created_at` alone could exclude
 * the very first event.
 */

export const INTERVALS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "24h", label: "Last 24 hours" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "6mo", label: "Last 6 months" },
  { key: "12mo", label: "Last 12 months" },
  { key: "all", label: "All time" },
] as const;

export type IntervalKey = (typeof INTERVALS)[number]["key"];

export const DEFAULT_INTERVAL: IntervalKey = "7d";

/**
 * The picker remembers its last selection across reloads: a refresh must not
 * reset a deliberately chosen interval. The memory has a shelf life — coming
 * back after a long absence starts at Today, because yesterday afternoon's
 * "Last 90 days" says nothing about what this morning's visit is for. The
 * timestamp is re-stamped while the screen is in use, so "stale" measures
 * absence, not how long a working session lasted.
 */
const INTERVAL_STALE_AFTER_MS = 8 * 3_600_000;
/** What a fresh visit (nothing remembered, or remembered too long ago) shows. */
const RETURNING_INTERVAL: IntervalKey = "today";

/**
 * Where a picked interval is remembered.
 *
 * `account` is the dashboard's own long-lived entry: it survives a browser
 * restart, because a person's working window is a preference.
 *
 * `visit` is for surfaces that render in someone else's browser — the public
 * share board. It has to survive a refresh (an interval that resets itself is
 * just broken) but must not touch the `account` entry in either direction:
 * reading a stranger's share link was rewriting the viewer's own dashboard
 * picker, and the viewer's preference was leaking onto the shared page. A
 * per-tab entry under its own key is exactly that much memory and no more.
 */
export type IntervalMemory = "account" | "visit";

const MEMORY_STORE: Record<
  IntervalMemory,
  { key: string; area: () => Storage }
> = {
  account: {
    key: "oa:analytics-interval:v1",
    area: () => window.localStorage,
  },
  visit: {
    key: "oa:share-interval:v1",
    area: () => window.sessionStorage,
  },
};

const isIntervalKey = (value: unknown): value is IntervalKey =>
  INTERVALS.some((interval) => interval.key === value);

/** Fresh remembered selection, or `null` (missing, corrupt, or stale). */
function readStoredInterval(memory: IntervalMemory): IntervalKey | null {
  try {
    const store = MEMORY_STORE[memory];
    const raw = store.area().getItem(store.key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { key?: unknown; atMs?: unknown };
    if (!isIntervalKey(parsed.key)) return null;
    if (typeof parsed.atMs !== "number") return null;
    if (Date.now() - parsed.atMs > INTERVAL_STALE_AFTER_MS) return null;
    return parsed.key;
  } catch {
    return null;
  }
}

function storeInterval(key: IntervalKey, memory: IntervalMemory): void {
  try {
    const store = MEMORY_STORE[memory];
    store.area().setItem(store.key, JSON.stringify({ key, atMs: Date.now() }));
  } catch {
    // Blocked storage: selection still holds for this tab via state.
  }
}

const emptySubscribe = () => () => {};

/**
 * Where a reader's own zone pick is remembered: this tab, this site, this
 * visit — the interval's `visit` memory in every respect except that it is
 * never the account's.
 *
 * Per site, because a zone chosen while reading one site is not a statement
 * about the next one; per tab, because it is a way of looking rather than a
 * preference. Nothing here writes `sites.reporting_timezone`: the pill moves
 * the view, and Settings → General moves the site.
 */
const zoneMemoryKey = (slug: string) => `oa-dash-tz:${slug}`;

function readStoredZone(slug: string): string | null {
  if (slug === "") return null;
  try {
    return window.sessionStorage.getItem(zoneMemoryKey(slug));
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------- */
/* Calendar math in an arbitrary IANA zone (`@/lib/zoned-day`)            */
/* --------------------------------------------------------------------- */

/**
 * Half-open `[from, to)` for an interval, cut at the resolved zone's calendar
 * boundaries and sent with that zone. The backend snaps endpoints to the
 * served grain and echoes the effective range.
 *
 * `allFromMs` anchors the "all" interval; while it is still unknown the view
 * falls back to the trailing 12 months and refines the moment the site read
 * answers.
 */
export function rangeForInterval(
  key: IntervalKey,
  timezone?: string,
  allFromMs?: number | null,
  now: Date = new Date()
): AnalyticsRange {
  // The resolver upstream already refuses a zone `Intl` cannot use, but this
  // is the function that would do the throwing — every caller's endpoints are
  // cut here, including the ones that pass a zone straight in — so this is
  // where being unable to throw has to be true. UTC over a crashed screen.
  const asked = timezone ?? resolveTimezone(null);
  const tz = isUsableTimezone(asked) ? asked : "UTC";
  const day = (shift: Parameters<typeof zonedDayStart>[2]) =>
    zonedDayStart(now, tz, shift);
  const tomorrow = day({ days: 1 });

  const bounds: Record<IntervalKey, [Date, Date]> = {
    today: [day({}), tomorrow],
    yesterday: [day({ days: -1 }), day({})],
    "24h": [new Date(now.getTime() - 86_400_000), now],
    "7d": [day({ days: -6 }), tomorrow],
    "30d": [day({ days: -29 }), tomorrow],
    "90d": [day({ days: -89 }), tomorrow],
    "6mo": [day({ months: -6, days: 1 }), tomorrow],
    "12mo": [day({ years: -1, days: 1 }), tomorrow],
    all: [
      allFromMs === null || allFromMs === undefined
        ? day({ years: -1, days: 1 })
        : zonedDayStart(new Date(allFromMs), tz),
      tomorrow,
    ],
  };

  const [from, to] = bounds[key];
  return { from: from.toISOString(), to: to.toISOString(), timezone: tz };
}

type IntervalContextValue = {
  interval: IntervalKey;
  setInterval: (key: IntervalKey) => void;
  range: AnalyticsRange;
  /**
   * True while "All time" is chosen but the site's birthday is still being
   * fetched — the range in hand is the 12-month fallback and about to be
   * replaced. Panels hold their first skeleton through it instead of
   * fetching a range that is one anchor away from wrong: firing on the
   * fallback played every load twice on an all-time refresh.
   */
  rangePending: boolean;
  /**
   * True while the site's own clock is still unknown: its summary is in
   * flight and `timezone` is the next step of the chain standing in.
   *
   * Already folded into `rangePending`, which is what panels wait on. It is
   * published separately for the header pill (`HeaderTimezonePill`), which
   * should not name a zone the screen is a moment away from leaving: the
   * panels behind it are holding for that same answer, so a name there would
   * be the only thing on screen claiming to have it.
   */
  zonePending: boolean;
  /**
   * The intervals this screen offers. The picker reads it rather than the
   * module constant, so a surface can withhold one it cannot honestly serve —
   * the public board withholds "All time", whose anchor needs a site the
   * viewer cannot see.
   */
  intervals: readonly (typeof INTERVALS)[number][];
  /**
   * The zone every window on this screen is cut in — the same string `range`
   * carries, offered separately so the header pill can wear it without
   * unpicking a range.
   */
  timezone: string;
  /**
   * Moves this view to another zone for this visit (ADR-0079 D5). It changes
   * nothing stored about the site or the account.
   *
   * A no-op on a surface that supplies its own `timezone` — there the screen
   * owns the clock and drives its own picker, and a second setter here would
   * only be a way for the two to disagree.
   */
  setTimezone: (zone: string) => void;
};

const IntervalContext = React.createContext<IntervalContextValue | null>(null);

/** Mock mode's stable "site birth" — matches the mock series' opening day. */
const MOCK_ALL_FROM_MS = Date.parse("2026-06-20T00:00:00Z");

export function IntervalProvider({
  children,
  memory = "account",
  intervals = INTERVALS,
  allAnchorMs,
  timezone: timezoneProp,
}: {
  children: React.ReactNode;
  /** Which store remembers the pick — see `IntervalMemory`. */
  memory?: IntervalMemory;
  /** Which intervals this screen offers; see `intervals` on the context. */
  intervals?: readonly (typeof INTERVALS)[number][];
  /**
   * The "All time" anchor, supplied by a screen that already holds it —
   * the share board reads it off the public identity route (ADR-0044),
   * where this provider's own slug-based site fetch has no session to run
   * with. `undefined` means "not supplied; fetch it here as usual", `null`
   * means "supplied, and there is no anchor" (the 12-month fallback is
   * final). A screen that offers "all" only after its anchor read settles
   * never leaves panels waiting on this value.
   */
  allAnchorMs?: number | null;
  /**
   * The clock ranges are cut in, supplied by a screen that resolves its own —
   * the public share board, which has a viewer's pick and a site identity but
   * no session to read a preference from (ADR-0044). Omitted, this provider
   * resolves the chain itself and owns the pick.
   */
  timezone?: string;
}) {
  /**
   * Read through `useSyncExternalStore` so the server render (no storage)
   * and hydration agree on `null`, then the client's remembered value takes
   * over in the post-hydration pass — no mismatch, no flash of a wrong
   * range in the address of a hydration error.
   */
  const readStored = React.useCallback(
    () => readStoredInterval(memory),
    [memory]
  );
  const stored = React.useSyncExternalStore(
    emptySubscribe,
    readStored,
    () => null
  );
  const [chosen, setChosen] = React.useState<IntervalKey | null>(null);
  const interval = chosen ?? stored ?? RETURNING_INTERVAL;

  const params = useParams<{ site?: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";

  const { data: session } = useSession();
  /**
   * The site's own clock, read off the summary the lifecycle gate already
   * fetches for every `/dashboard/[site]` screen — no second request, and one
   * answer for every panel under it.
   */
  const siteSummary = useSiteSummary();
  /**
   * Read through `useSyncExternalStore` for the interval memory's own reason:
   * the server render has no storage, so it and hydration agree on `null` and
   * the remembered pick takes over in the post-hydration pass.
   */
  const readZone = React.useCallback(() => readStoredZone(slug), [slug]);
  const rememberedZone = React.useSyncExternalStore(
    emptySubscribe,
    readZone,
    () => null
  );
  const [chosenZone, setChosenZone] = React.useState<string | null>(null);
  const setTimezone = React.useCallback(
    (zone: string) => {
      // A supplied clock is the screen's, not ours: it drives its own picker.
      if (timezoneProp !== undefined) return;
      setChosenZone(zone);
      if (slug === "") return;
      try {
        window.sessionStorage.setItem(zoneMemoryKey(slug), zone);
      } catch {
        /* per-tab memory only — the pick still applies for this visit */
      }
    },
    [slug, timezoneProp]
  );

  const timezone =
    timezoneProp ??
    resolveViewingTimezone({
      chosen: chosenZone,
      remembered: rememberedZone,
      site: siteSummary.site?.reporting_timezone ?? null,
      preference: sessionTimezone(session?.user),
    });

  /**
   * The site's zone is not knowable on the first frame, and a range cut in the
   * reader's clock and then re-cut in the site's would play every panel's load
   * twice. So the screens hold, the way they already hold for the "All time"
   * anchor — one mechanism, `rangePending`, for both unknowns.
   */
  const zonePending =
    timezoneProp === undefined && siteSummary.phase === "loading";

  /**
   * The "All time" anchor: `min(created_at, first_event_at)`, fetched from
   * the site read the first time the interval is chosen. Keyed by slug so a
   * site switch cannot serve another site's birthday.
   */
  const [allAnchor, setAllAnchor] = React.useState<{
    slug: string;
    /** Null is *resolved without an anchor* — the fallback range is final. */
    fromMs: number | null;
  } | null>(null);
  React.useEffect(() => {
    // A supplied anchor makes the fetch moot — and on a slug-less surface
    // (the share board) there is no site read to make anyway.
    if (allAnchorMs !== undefined) return;
    if (interval !== "all" || slug === "") return;
    if (allAnchor !== null && allAnchor.slug === slug) return;
    let cancelled = false;
    const fetchAnchor = async () => {
      if (!LIVE_API) {
        if (!cancelled) setAllAnchor({ slug, fromMs: MOCK_ALL_FROM_MS });
        return;
      }
      try {
        const { site_id } = await resolveSiteSlugCached(slug);
        const site = await sites.get(site_id);
        const created = Date.parse(site.created_at);
        const first =
          site.first_event_at === null
            ? Number.NaN
            : Date.parse(site.first_event_at);
        const fromMs = Number.isNaN(first)
          ? created
          : Math.min(created, first);
        if (!cancelled) {
          // NaN settles as anchorless too — an unparseable birthday must
          // resolve the wait, not strand every panel in its skeleton.
          setAllAnchor({
            slug,
            fromMs: Number.isNaN(fromMs) ? null : fromMs,
          });
        }
      } catch {
        // Resolved without an anchor: the 12-month fallback keeps the view
        // honest, and panels stop holding for a refinement that isn't coming.
        if (!cancelled) setAllAnchor({ slug, fromMs: null });
      }
    };
    void fetchAnchor();
    return () => {
      cancelled = true;
    };
  }, [interval, slug, allAnchor, allAnchorMs]);

  const setInterval = React.useCallback(
    (key: IntervalKey) => {
      setChosen(key);
      storeInterval(key, memory);
    },
    [memory]
  );

  // Re-stamp the remembered selection while the screen is in use — absence
  // is what should age it out, not a long afternoon of work.
  React.useEffect(() => {
    // Nothing picked and nothing remembered: there is no selection to stamp,
    // and writing the fallback here is what broke the memory. On the first
    // client pass `stored` is still the server snapshot (`null`), so an
    // unconditional write put "today" into storage *before* the real value
    // could be read back — every reload reset the picker to Today.
    if (chosen === null && stored === null) return;
    storeInterval(interval, memory);
  }, [interval, memory, chosen, stored]);

  // One range per (interval, zone, anchor) — recomputing per render would
  // move the endpoints between renders and refire every panel's request.
  const allFromMs =
    allAnchorMs !== undefined
      ? allAnchorMs
      : allAnchor !== null && allAnchor.slug === slug
        ? allAnchor.fromMs
        : null;
  const range = React.useMemo(
    () => rangeForInterval(interval, timezone, allFromMs),
    [interval, timezone, allFromMs]
  );
  // A supplied anchor is never pending, and slug-less surfaces without one
  // (the public share board before ADR-0044) have nothing to wait for.
  const rangePending =
    zonePending ||
    (interval === "all" &&
      allAnchorMs === undefined &&
      slug !== "" &&
      (allAnchor === null || allAnchor.slug !== slug));

  const value = React.useMemo(
    () => ({
      interval,
      setInterval,
      range,
      rangePending,
      zonePending,
      intervals,
      timezone,
      setTimezone,
    }),
    [
      interval,
      setInterval,
      range,
      rangePending,
      zonePending,
      intervals,
      timezone,
      setTimezone,
    ]
  );

  return (
    <IntervalContext.Provider value={value}>
      {children}
    </IntervalContext.Provider>
  );
}

/**
 * The screen's shared interval. Falls back to a static default range when no
 * provider is mounted, so a panel reused on a screen without a picker still
 * has an honest, fixed window instead of crashing.
 */
export function useAnalyticsInterval(): IntervalContextValue {
  const context = React.useContext(IntervalContext);
  const fallback = React.useMemo<IntervalContextValue>(() => {
    const range = rangeForInterval(DEFAULT_INTERVAL);
    return {
      interval: DEFAULT_INTERVAL,
      setInterval: () => {},
      range,
      // A static default window is never waiting on an anchor, and with no
      // provider there is no site summary to wait on either.
      rangePending: false,
      zonePending: false,
      intervals: INTERVALS,
      timezone: range.timezone,
      // No provider, no range to move: a setter here would report success and
      // change nothing.
      setTimezone: () => {},
    };
  }, []);
  return context ?? fallback;
}
