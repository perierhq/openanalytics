"use client";

import { Funnel } from "@nivo/funnel";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  File01Icon,
  PencilEdit02Icon,
  PlusSignIcon,
  Tap01Icon,
} from "hugeicons-react";
import { useParams } from "next/navigation";
import { AnimatePresence, motion, type Variants } from "motion/react";
import * as React from "react";
import { createPortal } from "react-dom";
import { FlowDialog } from "@/components/dashboard/flow-dialog";
import { Button } from "@/components/ui/button";
import {
  SkeletonBar,
  SkeletonReveal,
} from "@/components/ui/skeleton-reveal";
import { Spinner } from "@/components/ui/spinner";
import { SquircleSurface } from "@/components/ui/squircle-card";
import { rangeForInterval } from "@/components/dashboard/interval-context";
import {
  funnels,
  getAnalyticsCustomEvents,
  getAnalyticsFunnel,
  getAnalyticsPages,
  lastDaysUtc,
  LIVE_API,
  presentError,
  resolveSiteSlugCached,
  sites,
  type FunnelDefinition,
  type FunnelScope,
} from "@/lib/api";
import { formatMoney } from "@/lib/currencies";
import {
  editableStep,
  parseWhere,
  stepLabel,
  storedStep,
} from "@/lib/funnel-steps";
import { MOCK_CUSTOM_EVENTS, MOCK_PAGES, mockSiteBySlug } from "@/lib/mock";
import { useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";

/**
 * Funnels — saved definitions (`GET/POST/PATCH/DELETE .../funnels`) over the
 * existing compute call (`GET .../analytics/funnel`). The definitions store
 * nothing but parameters; opening one runs it over the last 30 days.
 *
 * Read is any member; create/edit/archive need `site:settings` (owner and
 * admin) — a viewer sees the list and the readings, never the editor.
 * DELETE is an archive and is idempotent; an archived definition is not
 * editable, so the editor's archive button simply closes over it.
 *
 * A step's key is a page path for pageview steps ("/pricing") and the event
 * name otherwise ("signup_completed") — the same vocabulary the compute
 * endpoint takes, validated against the same bounds (2–8 steps, window ≤ 30
 * days), so a definition that saves is a definition that runs. A page step
 * may carry `*` wildcards ("/discount/*") and an event step property
 * conditions ("plan=yearly"); those are stored as JSON step objects
 * (`lib/funnel-steps.ts`), everything else stays a plain key.
 *
 * For an owner the readings also carry buyers and revenue per step; for
 * anyone else the api leaves them out and nothing money-shaped renders.
 */

/* ------------------------------------------------------------------ */
/* Constants and mock data                                             */
/* ------------------------------------------------------------------ */

const WINDOW_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: 1_800_000, label: "30 minutes" },
  { ms: 3_600_000, label: "1 hour" },
  { ms: 21_600_000, label: "6 hours" },
  { ms: 86_400_000, label: "24 hours" },
  { ms: 259_200_000, label: "3 days" },
  { ms: 604_800_000, label: "7 days" },
  { ms: 2_592_000_000, label: "30 days" },
];

function windowLabel(ms: number): string {
  return (
    WINDOW_OPTIONS.find((option) => option.ms === ms)?.label ??
    `${Math.round(ms / 3_600_000)} hours`
  );
}

const MOCK_DEFS: FunnelDefinition[] = [
  {
    id: "fn_signup",
    name: "Signup funnel",
    steps: ["/", "/pricing", "signup_started", "account_created", "subscribed"],
    scope: "visitor",
    window_ms: 604_800_000,
    created_by_user_id: null,
    created_at: "2026-07-01T10:00:00.000Z",
    updated_at: "2026-07-20T10:00:00.000Z",
    archived_at: null,
  },
  {
    id: "fn_docs",
    name: "Docs activation",
    steps: ["/docs", "snippet_copied", "first_event"],
    scope: "visitor",
    window_ms: 86_400_000,
    created_by_user_id: null,
    created_at: "2026-07-03T10:00:00.000Z",
    updated_at: "2026-07-03T10:00:00.000Z",
    archived_at: null,
  },
  {
    id: "fn_checkout",
    name: "Checkout",
    steps: ["/product", "cart_add", "checkout_started", "paid"],
    scope: "session",
    window_ms: 3_600_000,
    created_by_user_id: null,
    created_at: "2026-07-10T10:00:00.000Z",
    updated_at: "2026-07-18T10:00:00.000Z",
    archived_at: null,
  },
];

/** Mock readings: a believable decay from a fixed entry count. */
function mockReadings(def: FunnelDefinition): PlotStep[] {
  let count = 8412;
  return def.steps.map((key, index) => {
    if (index > 0) count = Math.round(count * (0.34 + 0.1 * ((index * 7) % 3)));
    const buyers = Math.round(count * 0.04);
    return {
      label: stepLabel(key),
      value: count,
      revenue: { buyers, minor: buyers * 3999, currency: "EUR" },
    };
  });
}

/* Derived helpers ---------------------------------------------------- */

type PlotStep = {
  label: string;
  value: number;
  /** Owner-only: absent for anyone else, never zero. */
  revenue?: { buyers: number; minor: number; currency: string | null };
};

const fmt = (value: number) =>
  value >= 1000
    ? `${(value / 1000).toFixed(1)}K`
    : value.toLocaleString("en-US");

const overallOf = (steps: PlotStep[]) => {
  const first = steps[0]?.value ?? 0;
  const last = steps[steps.length - 1]?.value ?? 0;
  return first === 0 ? "0.0" : ((last / first) * 100).toFixed(1);
};

/** Everything the end user needs to read a step. */
function stepMeta(steps: PlotStep[], index: number) {
  const step = steps[index];
  const firstValue = steps[0]?.value ?? 0;
  const prev = index > 0 ? steps[index - 1] : null;
  return {
    ofFirst:
      firstValue === 0 ? "0.0" : ((step.value / firstValue) * 100).toFixed(1),
    fromPrev:
      prev === null
        ? null
        : prev.value === 0
          ? "0.0"
          : ((step.value / prev.value) * 100).toFixed(1),
    dropped: prev ? prev.value - step.value : 0,
  };
}

/** The hero gradient, sampled per step: everyone → the few who finish. */
const SWEEP = ["#22d3ee", "#3ba6f1", "#296FF0", "#7c4df0", "#c44df0"];
const sweepShades = (count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      SWEEP[Math.round((index / (count - 1 || 1)) * (SWEEP.length - 1))]
  );

/* Modal choreography ------------------------------------------------- */

const POP_SPRING = { type: "spring", stiffness: 400, damping: 26 } as const;

const MODAL_CONTAINER: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.15 } },
};
const MODAL_ITEM: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: "spring", stiffness: 380, damping: 28 },
  },
};

/* ------------------------------------------------------------------ */
/* Funnels board — list, detail modal, editor                          */
/* ------------------------------------------------------------------ */

export function FunnelsBoard() {
  const params = useParams<{ site: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";

  const site = useApi(
    () => resolveSiteSlugCached(slug).then((found) => sites.get(found.site_id)),
    () => mockSiteBySlug(slug),
    slug
  );
  const siteId = site.data?.site_id ?? "";
  const canManage = site.data !== null && site.data.role !== "viewer";

  const defs = useApi(
    () =>
      siteId === ""
        ? // The slug is still resolving — hold instead of firing a doomed
          // request; the key change re-runs this the moment the id lands.
          new Promise<FunnelDefinition[]>(() => {})
        : funnels.list(siteId).then((page) => page.items),
    () => MOCK_DEFS,
    siteId
  );
  // Mock-mode overlay so create/edit/archive stay visible without an api.
  const [localDefs, setLocalDefs] = React.useState<FunnelDefinition[] | null>(
    null
  );
  const rows = localDefs ?? defs.data ?? [];

  const [open, setOpen] = React.useState<FunnelDefinition | null>(null);
  const [editing, setEditing] = React.useState<FunnelDefinition | "new" | null>(
    null
  );

  if (site.phase === "error") {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-3 py-16 text-center">
        <p className="text-sm font-medium">{site.error.title}</p>
        <p className="text-sm text-muted-foreground">{site.error.body}</p>
      </div>
    );
  }

  return (
    <>
      <div className="mx-auto w-full max-w-2xl">
        {defs.phase === "error" ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <p className="text-sm font-medium">{defs.error.title}</p>
            <p className="text-sm text-muted-foreground">{defs.error.body}</p>
            {defs.error.retryable ? (
              <Button onClick={defs.reload} size="sm" variant="secondary">
                Try again
              </Button>
            ) : null}
          </div>
        ) : (
        <SkeletonReveal
          ready={defs.phase === "ready" && site.phase === "ready"}
          skeleton={
            // Pixel-matched to a funnel row: name line + meta line inside
            // the same px-2.5 py-2 box, then the New funnel button.
            <>
              {[0, 1, 2].map((index) => (
                <div className="flex flex-col gap-1 px-2.5 py-2" key={index}>
                  <SkeletonBar className="h-3.5 w-32" />
                  <SkeletonBar className="h-3 w-48 max-w-full" />
                </div>
              ))}
              <div className="mt-3 px-2.5">
                <SkeletonBar className="h-7 w-28 rounded-lg" />
              </div>
            </>
          }
        >
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-20 text-center">
            <p className="text-sm font-medium">No funnels yet</p>
            <p className="max-w-sm text-sm leading-6 text-muted-foreground">
              A funnel follows people through ordered steps (pages and events)
              and shows where they drop off.
            </p>
            {canManage ? (
              <Button
                className="mt-2"
                onClick={() => setEditing("new")}
                size="sm"
              >
                <PlusSignIcon className="size-4" />
                New funnel
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            {rows.map((def) => (
              <div key={def.id} className="group relative">
                <button
                  type="button"
                  onClick={() => setOpen(def)}
                  className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {def.name}
                    </span>
                    <span className="text-xs text-muted-foreground/70">
                      {def.steps.length} steps · {windowLabel(def.window_ms)}{" "}
                      window
                      {def.scope === "session" ? " · per session" : ""}
                    </span>
                  </span>
                  <ArrowRight01Icon
                    className={cn(
                      "size-4 text-muted-foreground/0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-muted-foreground/70",
                      canManage && "mr-7"
                    )}
                  />
                </button>
                {canManage ? (
                  <button
                    aria-label={`Edit ${def.name}`}
                    className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/0 outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring group-hover:text-muted-foreground"
                    onClick={() => setEditing(def)}
                    type="button"
                  >
                    <PencilEdit02Icon className="size-4" />
                  </button>
                ) : null}
              </div>
            ))}
            {canManage ? (
              <div className="mt-3 px-2.5">
                <Button
                  onClick={() => setEditing("new")}
                  size="xs"
                  variant="secondary"
                >
                  <PlusSignIcon className="size-3.5" />
                  New funnel
                </Button>
              </div>
            ) : null}
          </>
        )}
        </SkeletonReveal>
        )}
      </div>

      <AnimatePresence>
        {open && (
          <FunnelDetailModal
            key={open.id}
            def={open}
            siteId={siteId}
            onClose={() => setOpen(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {editing !== null && (
          <FunnelEditor
            key={editing === "new" ? "new" : editing.id}
            def={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={(next) => {
              setEditing(null);
              if (!LIVE_API) {
                setLocalDefs((current) => {
                  const base = current ?? rows;
                  return next.archived_at !== null
                    ? base.filter((entry) => entry.id !== next.id)
                    : base.some((entry) => entry.id === next.id)
                      ? base.map((entry) =>
                          entry.id === next.id ? next : entry
                        )
                      : [next, ...base];
                });
                return;
              }
              defs.reload();
            }}
            siteId={siteId}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Detail modal — runs the definition over the last 30 days            */
/* ------------------------------------------------------------------ */

function FunnelDetailModal({
  def,
  siteId,
  onClose,
}: {
  def: FunnelDefinition;
  siteId: string;
  onClose: () => void;
}) {
  const [hovered, setHovered] = React.useState<number | null>(null);
  const readings = useApi<PlotStep[]>(
    () =>
      getAnalyticsFunnel(siteId, rangeForInterval("30d"), {
        steps: [...def.steps],
        window_ms: def.window_ms,
        scope: def.scope,
      }).then((response) =>
        response.steps.map((step) => ({
          label: stepLabel(step.key),
          value: step.count,
          ...(step.buyers !== undefined
            ? {
                revenue: {
                  buyers: step.buyers,
                  minor: step.revenue_minor ?? 0,
                  currency: response.currency ?? null,
                },
              }
            : {}),
        }))
      ),
    () => mockReadings(def),
    `${siteId}:${def.id}`
  );

  // Measure the funnel box ourselves — nivo's ResponsiveWrapper mis-measured
  // the width when the modal animated in, freezing the chart too narrow. A
  // ResizeObserver always sees the final box.
  const [funnelSize, setFunnelSize] = React.useState<{
    width: number;
    height: number;
  } | null>(null);
  const funnelBoxRef = React.useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setFunnelSize({ width: box.width, height: box.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Escape closes the modal
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const steps = readings.data ?? [];
  const silent = steps.length === 0 || steps[0].value === 0;

  return (
    // z-[60]: above the floating tab bar (z-50)
    <div className="fixed inset-0 z-[60]">
      <motion.div
        key="funnel-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
        <motion.div
          key="funnel-panel"
          role="dialog"
          aria-modal="true"
          aria-label={def.name}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
          transition={POP_SPRING}
          className="pointer-events-auto relative max-h-[90vh] w-full max-w-[60rem] rounded-[36px] shadow-[0_24px_80px_rgba(0,0,0,0.3)] sm:rounded-[48px]"
        >
          <SquircleSurface className="relative max-h-[90vh] w-full overflow-hidden rounded-[36px] border border-border bg-card [--card-clip-radius:20px] sm:rounded-[48px] sm:[--card-clip-handle:3px] sm:[--card-clip-radius:26px]">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute right-4 top-4 z-20 flex size-8 cursor-pointer items-center justify-center rounded-full bg-black/4 text-muted-foreground outline-none transition-colors hover:bg-black/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Cancel01Icon className="size-4" />
            </button>

            <motion.div
              variants={MODAL_CONTAINER}
              initial="hidden"
              animate="show"
              className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {/* header */}
              <motion.div variants={MODAL_ITEM} className="px-10 pb-5 pt-10">
                <p className="text-lg font-medium tracking-tight">{def.name}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Last 30 days · {windowLabel(def.window_ms)} window ·{" "}
                  {readings.phase === "ready" && !silent ? (
                    <>
                      <span className="font-medium tabular-nums text-foreground/80">
                        {overallOf(steps)}%
                      </span>{" "}
                      make it all the way through
                    </>
                  ) : (
                    "conversion by step"
                  )}
                </p>
              </motion.div>

              {readings.phase === "loading" ? (
                <div className="flex h-[380px] items-center justify-center">
                  <Spinner className="size-5 text-muted-foreground" />
                </div>
              ) : readings.phase === "error" ? (
                <div className="flex h-[380px] flex-col items-center justify-center gap-2 px-10 text-center">
                  <p className="text-sm font-medium">{readings.error.title}</p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {readings.error.body}
                  </p>
                  {readings.error.retryable ? (
                    <Button
                      onClick={readings.reload}
                      size="sm"
                      variant="secondary"
                    >
                      Try again
                    </Button>
                  ) : null}
                </div>
              ) : silent ? (
                <div className="flex h-[380px] flex-col items-center justify-center gap-2 px-10 text-center">
                  <p className="text-sm font-medium">No matching traffic yet</p>
                  <p className="max-w-sm text-sm leading-6 text-muted-foreground">
                    Nothing entered this funnel in the last 30 days. Check the
                    first step&apos;s key: a page path like /pricing, or an
                    event name.
                  </p>
                </div>
              ) : (
                <>
                  {/* aligned step columns — each label + count sits right
                      above its funnel part */}
                  <motion.div
                    variants={MODAL_ITEM}
                    className="grid px-10"
                    style={{
                      gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`,
                    }}
                  >
                    {steps.map((step, index) => (
                      <div
                        key={index}
                        onMouseEnter={() => setHovered(index)}
                        onMouseLeave={() => setHovered(null)}
                        className={cn(
                          "pr-4 transition-opacity duration-150",
                          hovered !== null && hovered !== index && "opacity-40"
                        )}
                      >
                        <p className="flex items-center gap-1.5 truncate text-xs font-medium">
                          {step.label}{" "}
                          <span
                            aria-hidden="true"
                            className="size-1.5 shrink-0 rounded-full"
                            style={{
                              backgroundColor: sweepShades(steps.length)[index],
                            }}
                          />
                        </p>
                        <p className="pt-0.5 text-lg font-medium tabular-nums tracking-tight">
                          {step.value.toLocaleString("en-US")}
                        </p>
                      </div>
                    ))}
                  </motion.div>

                  {/* the sweep funnel — measured box, non-responsive Funnel */}
                  <div
                    ref={funnelBoxRef}
                    className="h-[380px] shrink-0 pb-6 pl-10 pr-10 pt-6"
                    onMouseMove={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      const inner = rect.width - 80; // px-10 both sides
                      const x = event.clientX - rect.left - 40;
                      const next =
                        x < 0 || x >= inner
                          ? null
                          : Math.floor((x / inner) * steps.length);
                      setHovered((prev) => (prev === next ? prev : next));
                    }}
                    onMouseLeave={() => setHovered(null)}
                  >
                    {funnelSize && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{
                          duration: 0.35,
                          ease: [0.32, 0.72, 0, 1],
                          delay: 0.15,
                        }}
                      >
                        <Funnel
                          width={funnelSize.width}
                          height={funnelSize.height}
                          data={steps.map((step, index) => ({
                            // By position: two steps may share a label.
                            id: String(index),
                            label: step.label,
                            value: step.value,
                          }))}
                          // top/bottom inset = border half-width, so the first
                          // (tallest) part's border isn't clipped at the edges
                          margin={{ top: 8, right: 0, bottom: 8, left: 0 }}
                          direction="horizontal"
                          interpolation="smooth"
                          spacing={0}
                          shapeBlending={0.8}
                          layers={[
                            "separators",
                            "parts",
                            "labels",
                            "annotations",
                          ]}
                          colors={(part) => {
                            const shades = sweepShades(steps.length);
                            const index = Number(part.id);
                            const dimmed = hovered !== null && hovered !== index;
                            // keep the hue, just lift it toward the card so
                            // non-hovered parts read quieter without going gray
                            return dimmed
                              ? `${shades[index]}59`
                              : shades[index];
                          }}
                          borderWidth={16}
                          borderColor={{ from: "color" }}
                          borderOpacity={0.3}
                          enableLabel={false}
                          isInteractive={false}
                          tooltip={() => null}
                          animate={false}
                        />
                      </motion.div>
                    )}
                  </div>

                  {/* full reading under each step */}
                  <motion.div
                    variants={MODAL_ITEM}
                    className="grid px-10 pb-10"
                    style={{
                      gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`,
                    }}
                  >
                    {steps.map((step, index) => {
                      const meta = stepMeta(steps, index);
                      return (
                        <div
                          key={index}
                          onMouseEnter={() => setHovered(index)}
                          onMouseLeave={() => setHovered(null)}
                          className={cn(
                            "pr-4 transition-opacity duration-150",
                            hovered !== null &&
                              hovered !== index &&
                              "opacity-40"
                          )}
                        >
                          <p className="text-lg font-medium tabular-nums tracking-tight">
                            {meta.ofFirst}%
                          </p>
                          {index > 0 && (
                            <>
                              <p className="pt-0.5 text-xs tabular-nums text-muted-foreground">
                                {meta.fromPrev}% from previous
                              </p>
                              <p className="text-xs tabular-nums text-muted-foreground">
                                {fmt(meta.dropped)} dropped
                              </p>
                            </>
                          )}
                          {step.revenue ? (
                            <p className="pt-1.5 text-xs tabular-nums text-muted-foreground">
                              {fmt(step.revenue.buyers)}{" "}
                              {step.revenue.buyers === 1 ? "buyer" : "buyers"}
                              {step.revenue.currency !== null &&
                              step.revenue.minor > 0
                                ? ` · ${formatMoney(step.revenue.minor, step.revenue.currency)}`
                                : ""}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </motion.div>
                </>
              )}
            </motion.div>
          </SquircleSurface>
        </motion.div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Editor — create, edit and archive a definition                      */
/* ------------------------------------------------------------------ */

const editorInputClass =
  "h-9 w-full rounded-xl border border-input bg-white px-3 text-sm outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]";

/* The step list's motion vocabulary: layout springs rows into place, and
   the height/opacity pair makes removal fold away instead of snapping —
   index-keyed rows could never exit, because deleting one just re-labelled
   the others. */
const ROW_SPRING = {
  type: "spring",
  stiffness: 520,
  damping: 38,
  mass: 0.42,
} as const;
const ROW_EASE = { duration: 0.24, ease: [0.22, 1, 0.36, 1] } as const;

/**
 * One editor row. The contract's step is a string: a plain key (the server
 * tells a page from an event by the leading slash) or a JSON step object for
 * a wildcard page or an event with conditions. The toggle changes which
 * suggestions appear and how input is normalized, and saving flattens each
 * row back to its string (`storedStep`).
 */
type EditorStep = {
  id: string;
  kind: "page" | "event";
  value: string;
  /** Property conditions as typed, `plan=yearly`; event rows only. */
  where: string;
};

function editorStep(
  kind: EditorStep["kind"],
  value: string,
  where = ""
): EditorStep {
  return { id: crypto.randomUUID(), kind, value, where };
}

/** A stored step, read back into a row the way the server reads it. */
function rowOf(raw: string): EditorStep {
  const step = editableStep(raw);
  return editorStep(step.kind, step.value, step.where);
}

/** A page step always carries its slash — typed or not. */
function normalizePage(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Contains-match over what the site actually recorded, capped at eight. */
function suggestionsFor(
  options: string[],
  value: string,
  stripSlash: boolean
): string[] {
  const source = stripSlash ? value.replace(/^\//, "") : value;
  const query = source.trim().toLowerCase();
  if (query === "") return [];
  return options
    .filter((option) => option.toLowerCase().includes(query))
    .slice(0, 8);
}

/** Where the suggestion list anchors — under the focused input. */
function anchorRect(element: HTMLInputElement) {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.bottom + 4, width: rect.width };
}

function FunnelEditor({
  def,
  siteId,
  onClose,
  onSaved,
}: {
  /** `null` creates a new definition. */
  def: FunnelDefinition | null;
  siteId: string;
  onClose: () => void;
  onSaved: (next: FunnelDefinition) => void;
}) {
  const [name, setName] = React.useState(def?.name ?? "");
  // Stable ids per row, not index keys — removal has an exit animation only
  // if the removed row keeps its identity while it leaves. Stored steps come
  // back with their kind read the way the server reads it: by the slash.
  const [steps, setSteps] = React.useState<EditorStep[]>(() =>
    def
      ? def.steps.map(rowOf)
      : [editorStep("page", "/"), editorStep("page", "")]
  );
  const [windowMs, setWindowMs] = React.useState(
    def?.window_ms ?? 86_400_000
  );
  const [scope, setScope] = React.useState<FunnelScope>(
    def?.scope ?? "visitor"
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [step, setStep] = React.useState<1 | 2>(1);
  const [dir, setDir] = React.useState(1);

  const goTo = (next: 1 | 2) => {
    setDir(next > step ? 1 : -1);
    setStep(next);
  };

  /**
   * What this site actually recorded over the last 30 days — the suggestion
   * lists. A nicety, not a gate: either read failing just means typing gets
   * no hints, so failures stay silent and free typing always works.
   */
  const [pagePaths, setPagePaths] = React.useState<string[]>(() =>
    LIVE_API ? [] : MOCK_PAGES.items.map((row) => row.page_path)
  );
  const [eventNames, setEventNames] = React.useState<string[]>(() =>
    LIVE_API ? [] : MOCK_CUSTOM_EVENTS.items.map((row) => row.event_name)
  );
  React.useEffect(() => {
    if (!LIVE_API) return;
    const controller = new AbortController();
    const range = lastDaysUtc(30);
    getAnalyticsPages(siteId, range, { signal: controller.signal }).then(
      (response) => setPagePaths(response.items.map((row) => row.page_path)),
      () => {
        /* no hints, still typable */
      }
    );
    getAnalyticsCustomEvents(siteId, range, {
      signal: controller.signal,
    }).then(
      (response) => setEventNames(response.items.map((row) => row.event_name)),
      () => {
        /* no hints, still typable */
      }
    );
    return () => controller.abort();
  }, [siteId]);

  // Which row's input owns the suggestion list, and where it anchors. The
  // blur clear is delayed a beat so a click on a suggestion lands before
  // the list disappears under it.
  const [activeStepId, setActiveStepId] = React.useState<string | null>(null);
  const [activeRect, setActiveRect] = React.useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const blurTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(blurTimer.current), []);

  const updateStep = (id: string, patch: Partial<EditorStep>) =>
    setSteps((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row))
    );

  // Flatten back to the contract's strings: a page carries its slash, an
  // event never starts with one (the server tells them apart exactly so),
  // and a wildcard or a condition makes the row a JSON step object.
  const cleanSteps = steps.map(storedStep).filter(Boolean);
  const whereProblem =
    steps
      .filter((row) => row.kind === "event")
      .map((row) => parseWhere(row.where))
      .find((parsed) => !parsed.ok) ?? null;
  const valid =
    name.trim().length > 0 && cleanSteps.length >= 2 && whereProblem === null;

  const activeStep = steps.find((row) => row.id === activeStepId) ?? null;
  const activeSuggestions =
    activeStep === null
      ? []
      : activeStep.kind === "page"
        ? suggestionsFor(pagePaths, activeStep.value, true)
        : suggestionsFor(eventNames, activeStep.value, false);

  const save = () => {
    if (!valid) {
      setError(
        whereProblem !== null && !whereProblem.ok
          ? `${whereProblem.reason}.`
          : "Give the funnel a name and at least two steps."
      );
      return;
    }
    setError(null);
    const body = {
      name: name.trim(),
      steps: cleanSteps,
      window_ms: windowMs,
      scope,
    };
    if (!LIVE_API) {
      onSaved({
        id: def?.id ?? crypto.randomUUID(),
        ...body,
        created_by_user_id: null,
        created_at: def?.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
        archived_at: null,
      });
      return;
    }
    setBusy(true);
    (def === null
      ? funnels.create(siteId, body)
      : funnels.update(siteId, def.id, body)
    ).then(
      (saved) => {
        setBusy(false);
        onSaved(saved);
      },
      (raised: unknown) => {
        setBusy(false);
        setError(presentError(raised).body);
      }
    );
  };

  const archive = () => {
    if (def === null) return;
    if (!LIVE_API) {
      onSaved({ ...def, archived_at: new Date().toISOString() });
      return;
    }
    setBusy(true);
    funnels.archive(siteId, def.id).then(
      () => {
        setBusy(false);
        onSaved({ ...def, archived_at: new Date().toISOString() });
      },
      (raised: unknown) => {
        setBusy(false);
        setError(presentError(raised).body);
      }
    );
  };

  const stepTitles = {
    1: def === null ? "New funnel" : "Edit funnel",
    2: "Window & counting",
  } as const;

  return (
    <FlowDialog
      ariaLabel={def === null ? "New funnel" : `Edit ${def.name}`}
      counter={`${step} / 2`}
      dir={dir}
      onClose={onClose}
      panelKey={step}
      title={stepTitles[step]}
      footer={
        step === 1 ? (
          <>
            {/* Archive lives on the step that shows what is being archived —
                and only when editing; a new funnel has nothing to archive. */}
            {def !== null ? (
              <Button
                disabled={busy}
                onClick={archive}
                size="xs"
                type="button"
                variant="ghost"
              >
                Archive
              </Button>
            ) : null}
            <Button variant="ghost" size="xs" onClick={onClose}>
              Cancel
            </Button>
            <Button size="xs" disabled={!valid} onClick={() => goTo(2)}>
              Continue
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="xs" onClick={() => goTo(1)}>
              Back
            </Button>
            <Button loading={busy} onClick={save} size="xs">
              {def === null ? "Create funnel" : "Save changes"}
            </Button>
          </>
        )
      }
    >
      {step === 1 ? (
        <div className="flex flex-col gap-3 p-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Name
            </span>
            <input
              autoFocus
              className={editorInputClass}
              onChange={(event) => setName(event.target.value)}
              placeholder="Signup funnel"
              value={name}
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Steps
            </span>
            <p className="text-xs leading-5 text-muted-foreground">
              In order, 2-8 of them. Each step is a page or a custom event;
              the small icon switches which, and typing suggests what the site
              has actually seen. A * in a page matches anything
              (/discount/*), and an event can require properties
              (plan=yearly).
            </p>
            {/* Grey plate, white rows — the house list anatomy. `layout` on
                the plate springs the survivors into place while a removed
                row folds its own height away. */}
            <motion.div
              className="flex flex-col gap-1 rounded-xl bg-[#f6f6f6] p-1"
              layout
              transition={ROW_SPRING}
            >
              <AnimatePresence initial={false} mode="popLayout">
                {steps.map((row, index) => (
                  <motion.div
                    key={row.id}
                    layout
                    initial={{ height: 0, opacity: 0, y: -4, scale: 0.985 }}
                    animate={{ height: "auto", opacity: 1, y: 0, scale: 1 }}
                    exit={{ height: 0, opacity: 0, y: -4, scale: 0.985 }}
                    transition={{
                      layout: ROW_SPRING,
                      height: ROW_EASE,
                      opacity: ROW_EASE,
                      y: ROW_EASE,
                      scale: ROW_EASE,
                    }}
                    className="flex items-center gap-1.5 overflow-hidden rounded-lg bg-white py-1 pl-1.5 pr-1"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#f6f6f6] text-xs tabular-nums text-muted-foreground/60">
                      {index + 1}
                    </span>
                    {/* The kind toggle — the pages card's own glyph for a
                        page, the Events tab's for an event, so the two marks
                        mean here what they mean everywhere else. Switching
                        resets the value: a path is never a valid event name
                        and vice versa. */}
                    <button
                      aria-label={
                        row.kind === "page"
                          ? "Page step: switch to event"
                          : "Event step: switch to page"
                      }
                      className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[#f6f6f6] text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => {
                        const nextKind =
                          row.kind === "page" ? "event" : "page";
                        updateStep(row.id, {
                          kind: nextKind,
                          value: nextKind === "page" ? "/" : "",
                          where: "",
                        });
                      }}
                      title={row.kind === "page" ? "Page step" : "Event step"}
                      type="button"
                    >
                      {row.kind === "page" ? (
                        <File01Icon className="size-3.5" />
                      ) : (
                        <Tap01Icon className="size-3.5" />
                      )}
                    </button>
                    <input
                      aria-label={`Step ${index + 1}`}
                      className="h-8 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
                      onBlur={() => {
                        blurTimer.current = setTimeout(() => {
                          setActiveStepId(null);
                          setActiveRect(null);
                        }, 120);
                      }}
                      onChange={(event) => {
                        updateStep(row.id, {
                          value:
                            row.kind === "page"
                              ? normalizePage(event.target.value)
                              : event.target.value,
                        });
                        setActiveRect(anchorRect(event.currentTarget));
                      }}
                      onFocus={(event) => {
                        setActiveStepId(row.id);
                        setActiveRect(anchorRect(event.currentTarget));
                      }}
                      placeholder={
                        row.kind === "page" ? "/pricing" : "signup_completed"
                      }
                      value={row.value}
                    />
                    {row.kind === "event" ? (
                      <input
                        aria-label={`Step ${index + 1} properties`}
                        className="h-8 w-32 min-w-0 shrink-0 rounded-md bg-[#f6f6f6] px-2 text-xs outline-none placeholder:text-muted-foreground/50 sm:w-40"
                        onChange={(event) =>
                          updateStep(row.id, { where: event.target.value })
                        }
                        placeholder="plan=yearly"
                        title="Optional: property=value, comma-separated, up to 3"
                        value={row.where}
                      />
                    ) : null}
                    {steps.length > 2 ? (
                      <button
                        aria-label={`Remove step ${index + 1}`}
                        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() =>
                          setSteps((current) =>
                            current.filter((entry) => entry.id !== row.id)
                          )
                        }
                        type="button"
                      >
                        <Cancel01Icon className="size-3.5" />
                      </button>
                    ) : null}
                  </motion.div>
                ))}
              </AnimatePresence>
              {steps.length < 8 ? (
                <motion.button
                  className="flex h-8 w-full cursor-pointer items-center justify-center gap-1 rounded-lg text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  layout
                  onClick={() =>
                    setSteps((current) => [...current, editorStep("page", "")])
                  }
                  transition={ROW_SPRING}
                  type="button"
                >
                  <PlusSignIcon className="size-3.5" />
                  Add step
                </motion.button>
              ) : null}
            </motion.div>
          </div>

          {whereProblem !== null && !whereProblem.ok ? (
            <p className="text-xs text-destructive-foreground">
              {whereProblem.reason}.
            </p>
          ) : null}

          {/* The suggestion list rides its own portal above the modal
              (z-[70] over z-[60]); mousedown is swallowed so the pick lands
              before the input's delayed blur folds the list away. */}
          {activeStep !== null &&
          activeRect !== null &&
          activeSuggestions.length > 0
            ? createPortal(
                <div
                  className="fixed z-[70] overflow-hidden rounded-xl border border-border bg-card shadow-[0_16px_40px_rgba(0,0,0,0.14)]"
                  style={{
                    left: activeRect.left,
                    top: activeRect.top,
                    width: activeRect.width,
                  }}
                >
                  <div className="max-h-56 overflow-y-auto overscroll-contain p-1">
                    {activeSuggestions.map((value) => (
                      <button
                        className="block w-full cursor-pointer truncate rounded-lg px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                        key={value}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          updateStep(activeStep.id, { value });
                          setActiveStepId(null);
                          setActiveRect(null);
                        }}
                        type="button"
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </div>,
                document.body
              )
            : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Window
              </span>
              {/* Native select on purpose: the house Select portals its
                  popup at z-50, under this modal's z-[60]. The chevron is
                  ours because `appearance-none` removed the platform's. */}
              <span className="relative">
                <select
                  className={cn(
                    editorInputClass,
                    "cursor-pointer appearance-none pr-8"
                  )}
                  onChange={(event) => setWindowMs(Number(event.target.value))}
                  value={windowMs}
                >
                  {WINDOW_OPTIONS.map((option) => (
                    <option key={option.ms} value={option.ms}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ArrowDown01Icon
                  aria-hidden="true"
                  className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70"
                />
              </span>
            </label>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Count by
              </span>
              {/* The house segmented (the onboarding plan step's toggle):
                  a soft grey plate with a white pill — no border, so it
                  does not stack a second frame beside the select's. */}
              <div className="flex h-9 items-center gap-0.5 rounded-xl bg-secondary/60 p-0.5">
                {(["visitor", "session"] as const).map((entry) => (
                  <button
                    className={cn(
                      "h-full flex-1 cursor-pointer rounded-[10px] text-xs font-medium transition-colors",
                      scope === entry
                        ? "bg-white text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                    key={entry}
                    onClick={() => setScope(entry)}
                    type="button"
                  >
                    {entry === "visitor" ? "Visitor" : "Session"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            All steps must happen within the window, counted per{" "}
            {scope === "visitor" ? "visitor" : "session"}.
          </p>
          {error ? (
            <p className="text-xs text-destructive-foreground">{error}</p>
          ) : null}
        </div>
      )}
    </FlowDialog>
  );
}
