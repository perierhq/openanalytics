"use client";

import { ArrowDown01Icon, SmartPhone01Icon } from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import {
  AnalyticsCardBody,
  breakdownShare,
  BreakdownRow,
  useSiteAnalytics,
} from "@/components/dashboard/analytics-card";
import { ImportedGapNote } from "@/components/dashboard/data-state";
import { useAnalyticsFilters } from "@/components/dashboard/filter-context";
import { HoverList } from "@/components/dashboard/hover-list";
import {
  SeeAllModal,
  SeeAllSkeleton,
  useIntervalLabel,
} from "@/components/dashboard/see-all-modal";
import {
  BrowserIcon,
  DeviceGlyph,
  OSIcon,
} from "@/components/dashboard/tech-icons";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  SquircleCard,
  SquircleCardScroll,
} from "@/components/ui/squircle-card";
import {
  getAnalyticsDevices,
  type AnalyticsMeta,
  type DeviceRow,
} from "@/lib/api";
import { MOCK_DEVICES } from "@/lib/mock";
import { trafficBars } from "@/lib/row-bars";

/**
 * Device types, browsers and operating systems: three cuts of one
 * `GET /v1/sites/{site_id}/analytics/devices` read. The contract row is the
 * device_type × browser × os combination, so every cut is a folding of the
 * same response, and one card with a picker in its header holds all three.
 * Devices had a card of its own until 2026-09-10; it moved in here so the
 * overview could give that slot to AI referrals, and it is the cut the card
 * opens on (Abbas, 2026-09-11): the one with a filter door, and the one the
 * card keeps when the others leave it.
 *
 * Folding sums per-combination visitor counts, so a visitor seen on two
 * browsers counts once per browser: a small, deliberate over-count.
 */

export function fold(
  items: DeviceRow[],
  keyOf: (row: DeviceRow) => string
): Array<{ label: string; visitors: number }> {
  const byLabel = new Map<string, number>();
  for (const row of items) {
    const label = keyOf(row);
    byLabel.set(label, (byLabel.get(label) ?? 0) + row.visitors);
  }
  return [...byLabel.entries()]
    .map(([label, visitors]) => ({ label, visitors }))
    .sort((a, b) => b.visitors - a.visitors);
}

export const DEVICE_LABEL: Record<string, string> = {
  desktop: "Desktop",
  mobile: "Mobile",
  tablet: "Tablet",
  unknown: "Other",
};

/** The rollup stores lowercase tokens ("chrome", "samsung internet"). */
export function titleCase(value: string): string {
  return value
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Families whose house spelling beats naive title-casing. */
const FAMILY_LABEL: Record<string, string> = { ios: "iOS", macos: "macOS" };
export function familyLabel(value: string): string {
  if (value === "unknown") return "Other";
  return FAMILY_LABEL[value] ?? titleCase(value);
}

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

type TechView = "browsers" | "os" | "devices";

const TECH_VIEWS: { id: TechView; label: string; subtitle: string }[] = [
  { id: "devices", label: "Devices", subtitle: "What your visitors browse on" },
  {
    id: "browsers",
    label: "Browsers",
    subtitle: "What your visitors browse with",
  },
  { id: "os", label: "OS", subtitle: "What your visitors browse with" },
];

/**
 * The cut's rows, folded on the raw stored token rather than the label, so a
 * row still knows which mark it wears and which filter value it carries;
 * "unknown" and "" collapse to one bucket first.
 */
function foldView(
  items: DeviceRow[],
  view: TechView
): Array<{ label: string; visitors: number }> {
  if (view === "devices") return fold(items, (row) => row.device_type);
  return fold(items, (row) => {
    const value = view === "browsers" ? row.browser : row.os;
    return value === "unknown" || value === "" ? "unknown" : value;
  });
}

function rowMark(view: TechView, label: string): React.ReactNode {
  if (view === "devices") {
    return <DeviceGlyph deviceType={label} className="size-4" />;
  }
  if (view === "browsers") {
    return <BrowserIcon family={label} className="size-4" />;
  }
  return <OSIcon family={label} className="size-4" />;
}

function rowName(view: TechView, label: string): string {
  return view === "devices" ? (DEVICE_LABEL[label] ?? label) : familyLabel(label);
}

export function TechCard() {
  const { enabled, active, filtersParam, addFilter, hasValue } =
    useAnalyticsFilters();
  const resource = useSiteAnalytics(getAnalyticsDevices, MOCK_DEVICES, {
    filters: filtersParam,
  });
  const [view, setView] = React.useState<TechView>("devices");
  const [open, setOpen] = React.useState(false);
  const current = TECH_VIEWS.find((entry) => entry.id === view) ?? TECH_VIEWS[0];

  return (
    <>
      <SquircleCard
        icon={<SmartPhone01Icon aria-hidden="true" />}
        onSeeAll={() => setOpen(true)}
        title={
          <DropdownMenu
            align="start"
            className="w-36"
            trigger={
              <button
                className="flex cursor-pointer items-center gap-1 rounded-lg py-0.5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
              >
                {/* the house label swap: the title glides on cut change */}
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.span
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: -9, opacity: 0, transition: { duration: 0.1 } }}
                    initial={{ y: 9, opacity: 0 }}
                    key={current.id}
                    transition={SPRING}
                  >
                    {current.label}
                  </motion.span>
                </AnimatePresence>
                <ArrowDown01Icon
                  aria-hidden="true"
                  className="!size-3.5 text-muted-foreground/70"
                />
              </button>
            }
          >
            {TECH_VIEWS.map((entry) => (
              <DropdownMenuItem key={entry.id} onClick={() => setView(entry.id)}>
                {entry.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenu>
        }
      >
        <AnalyticsCardBody
          emptyBody={
            active
              ? "No visits match these filters."
              : "No visits in this range yet."
          }
          isEmpty={(data) => data.items.length === 0}
          resource={resource}
        >
          {(data) => {
            const rows = foldView(data.items, view);
            const share = breakdownShare(
              rows.map((row) => row.visitors),
              data.meta.truncated
            );
            const bar = trafficBars(rows.map((row) => row.visitors));
            return (
              <AnimatePresence initial={false} mode="wait">
                <motion.div
                  animate={{ opacity: 1, y: 0 }}
                  className="h-full"
                  exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}
                  initial={{ opacity: 0, y: 8 }}
                  key={view}
                  transition={SPRING}
                >
                  <SquircleCardScroll>
                    {/* Only the imported *device type* rows merge into this
                        report. A live row is a joint (device, browser, os)
                        tuple, and blending one-dimension imported rows into it
                        would invent tuples, so imported browsers and
                        operating systems are read separately and are absent
                        from those two cuts. The devices cut has nothing
                        missing and carries no note. */}
                    {view !== "devices" ? (
                      <ImportedGapNote
                        className="px-5 pb-1 pt-2"
                        kind="devices"
                        meta={data.meta}
                      />
                    ) : null}
                    <HoverList>
                      {rows.map((row) => (
                        <BreakdownRow
                          icon={rowMark(view, row.label)}
                          key={row.label}
                          name={rowName(view, row.label)}
                          // Device type is the one filter dimension on this
                          // card; browser and OS have none in v1, so those
                          // rows stay plain. The value is the raw stored
                          // token ("mobile"), which is what the session entry
                          // carries and the filter matches.
                          onSelect={
                            view === "devices" &&
                            enabled &&
                            !hasValue("device_type", row.label)
                              ? () => addFilter("device_type", row.label)
                              : undefined
                          }
                          bar={bar(row.visitors)}
                          pct={share(row.visitors)}
                          value={row.visitors.toLocaleString("en-US")}
                        />
                      ))}
                    </HoverList>
                  </SquircleCardScroll>
                </motion.div>
              </AnimatePresence>
            );
          }}
        </AnalyticsCardBody>
      </SquircleCard>

      <AnimatePresence>
        {open && (
          <TechModal
            items={resource.status === "ready" ? resource.data.items : null}
            meta={resource.status === "ready" ? resource.data.meta : null}
            view={view}
            onClose={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/** The whole ranking of whichever cut the card is on, in the vertical shell. */
function TechModal({
  items,
  meta,
  view,
  onClose,
}: {
  items: DeviceRow[] | null;
  /** Read for `truncated` alone: a share of a capped row set is inflated. */
  meta: AnalyticsMeta | null;
  view: TechView;
  onClose: () => void;
}) {
  const intervalLabel = useIntervalLabel();
  const current = TECH_VIEWS.find((entry) => entry.id === view) ?? TECH_VIEWS[0];
  const rows = items === null ? null : foldView(items, view);
  const share = breakdownShare(
    rows === null ? [] : rows.map((row) => row.visitors),
    meta?.truncated ?? false
  );
  const bar = trafficBars(rows === null ? [] : rows.map((row) => row.visitors));

  return (
    <SeeAllModal
      title={current.label}
      subtitle={`${current.subtitle} · ${intervalLabel}`}
      onClose={onClose}
    >
      {rows === null ? (
        <SeeAllSkeleton />
      ) : (
        <>
          {view !== "devices" && meta !== null ? (
            <ImportedGapNote
              className="px-4 pb-1 pt-1"
              kind="devices"
              meta={meta}
            />
          ) : null}
          {/* the shared white glide, rounded for the grey band */}
          <HoverList className="[&>li>span]:rounded-[10px]">
            {rows.map((row) => (
              <BreakdownRow
                icon={rowMark(view, row.label)}
                key={row.label}
                name={rowName(view, row.label)}
                bar={bar(row.visitors)}
                pct={share(row.visitors)}
                value={row.visitors.toLocaleString("en-US")}
              />
            ))}
          </HoverList>
        </>
      )}
    </SeeAllModal>
  );
}
