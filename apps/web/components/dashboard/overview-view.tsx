"use client";

import * as React from "react";
import {
  CHART_DRAWS_DEFAULT,
  parseOverviewView,
  toggleChartMetric,
  writeOverviewView,
  type ChartDrawState,
  type ChartMetric,
  type OverviewView,
} from "@/lib/overview-compare";
import { cn } from "@/lib/utils";

/**
 * The overview's view: whether it compares with the previous period, and
 * which metric the chart draws. One provider for the overview page; the
 * header's Compare toggle, the stat tiles and the chart all read it.
 *
 * **The URL is the durable copy**, the way it is for the filters
 * (`FilterProvider`): `?compare=1&metric=pageviews` survives a reload and
 * goes along with a pasted link. Same mechanics too: the initial value is
 * read once off `location.search`, edits go through `history.replaceState`
 * (nothing about the route changes), and every other parameter is left as
 * it was.
 *
 * Screens without the provider (the public share board) get the inert
 * fallback: no comparison, the default chart, tiles that are not buttons.
 * The share board deliberately does not compare (its reads refuse
 * `compare`).
 */

type OverviewViewValue = OverviewView & {
  /** Whether this screen has a view to change: tiles become buttons. */
  enabled: boolean;
  setCompare: (compare: boolean) => void;
  /**
   * A tile press: puts its metric on the chart, or, when the chart already
   * draws it, returns the chart to its default.
   */
  pressMetric: (metric: ChartMetric) => void;
  /**
   * What the chart actually draws and could draw, as the chart publishes it
   * (`ChartDrawState`). The tiles derive both "is a button" and "is pressed"
   * from this rather than from `metric`: a link can ask for a metric the
   * chart cannot draw here, and the chart then draws the default.
   */
  chart: ChartDrawState;
  setChart: (chart: ChartDrawState) => void;
};

const INERT: OverviewViewValue = {
  compare: false,
  metric: null,
  enabled: false,
  setCompare: () => {},
  pressMetric: () => {},
  chart: CHART_DRAWS_DEFAULT,
  setChart: () => {},
};

const OverviewViewContext = React.createContext<OverviewViewValue>(INERT);

export function useOverviewView(): OverviewViewValue {
  return React.useContext(OverviewViewContext);
}

const subscribeNever = () => () => {};

/** Writes the view into the address bar, every other parameter kept. */
function writeViewToUrl(view: OverviewView) {
  const url = new URL(window.location.href);
  url.search = writeOverviewView(url.search, view);
  window.history.replaceState(window.history.state, "", url);
}

export function OverviewViewProvider({ children }: { children: React.ReactNode }) {
  // Read once and cached, for `FilterProvider`'s reason: our own
  // `replaceState` writes would otherwise change the snapshot mid-life.
  const initialRef = React.useRef<string | null>(null);
  const initialSearch = React.useSyncExternalStore(
    subscribeNever,
    () => {
      if (initialRef.current === null) initialRef.current = window.location.search;
      return initialRef.current;
    },
    () => null
  );
  const fromUrl = React.useMemo(
    () => parseOverviewView(initialSearch ?? ""),
    [initialSearch]
  );

  // `null` = untouched this visit: the URL's value applies.
  const [edited, setEdited] = React.useState<OverviewView | null>(null);
  const view = edited ?? fromUrl;
  const [chart, setChartState] = React.useState<ChartDrawState>(CHART_DRAWS_DEFAULT);

  // Event handlers, not state updaters: the URL write is a side effect, and
  // an updater runs again under Strict Mode. The handler sees this render's
  // view, which is the one the person clicked on.
  const update = React.useCallback((next: OverviewView) => {
    setEdited(next);
    writeViewToUrl(next);
  }, []);

  const setCompare = React.useCallback(
    (compare: boolean) => update({ ...view, compare }),
    [update, view]
  );
  const pressMetric = React.useCallback(
    (metric: ChartMetric) =>
      update({ ...view, metric: toggleChartMetric(chart.drawn, metric) }),
    [update, view, chart.drawn]
  );
  // Published on every chart render; equal values keep the context still.
  const setChart = React.useCallback((next: ChartDrawState) => {
    setChartState((current) =>
      current.drawn === next.drawn &&
      current.revenueChartable === next.revenueChartable &&
      current.sessionsChartable === next.sessionsChartable
        ? current
        : next
    );
  }, []);

  const value = React.useMemo<OverviewViewValue>(
    () => ({
      compare: view.compare,
      metric: view.metric,
      enabled: true,
      setCompare,
      pressMetric,
      chart,
      setChart,
    }),
    [view.compare, view.metric, setCompare, pressMetric, chart, setChart]
  );

  return (
    <OverviewViewContext.Provider value={value}>{children}</OverviewViewContext.Provider>
  );
}

/**
 * The header's Compare toggle, beside the interval picker and in its pill
 * shape. Pressed, it is ink, like every selected chip on the dashboard.
 */
export function CompareToggle() {
  const { compare, setCompare } = useOverviewView();
  return (
    <button
      aria-pressed={compare}
      className={cn(
        "flex h-8 cursor-pointer select-none items-center rounded-full border px-3 text-sm shadow-xs outline-none transition-[background-color,color,border-color,scale] duration-150 focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97]",
        compare
          ? "border-foreground bg-foreground text-background hover:bg-foreground/90"
          : "border-border bg-card hover:bg-accent/40"
      )}
      onClick={() => setCompare(!compare)}
      type="button"
    >
      Compare
    </button>
  );
}
