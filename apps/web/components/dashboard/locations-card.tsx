"use client";

import { ArrowDown01Icon, Location01Icon } from "hugeicons-react";
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
import { usePublishPosterCountries } from "@/components/dashboard/poster-publishers";
import { HoverList } from "@/components/dashboard/hover-list";
import {
  SeeAllModal,
  SeeAllSkeleton,
  useIntervalLabel,
} from "@/components/dashboard/see-all-modal";
import { FlagIcon } from "@/components/dashboard/tech-icons";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  SquircleCard,
  SquircleCardScroll,
} from "@/components/ui/squircle-card";
import {
  getAnalyticsGeography,
  type AnalyticsMeta,
  type GeographyRow,
} from "@/lib/api";
import { MOCK_GEOGRAPHY } from "@/lib/mock";
import { trafficBars } from "@/lib/row-bars";

/**
 * Locations, from `GET /v1/sites/{site_id}/analytics/geography`. The contract
 * row is country × city; the header picks the cut — countries by default,
 * cities behind it. Folding sums per-row visitor counts, so a visitor seen
 * in two cities of one country counts twice in that country — a small,
 * deliberate over-count.
 */

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

type LocationView = "countries" | "cities";

const VIEWS: { id: LocationView; label: string; empty: string }[] = [
  {
    id: "countries",
    label: "Countries",
    empty: "No visits in this range yet.",
  },
  {
    id: "cities",
    label: "Cities",
    empty: "No city detail in this range yet.",
  },
];

type FoldedPlace = {
  key: string;
  label: string;
  /** The flag the row wears — the city's country, or the country itself. */
  country: string;
  visitors: number;
};

function foldCountries(items: GeographyRow[]): FoldedPlace[] {
  const byCountry = new Map<string, number>();
  for (const row of items) {
    byCountry.set(
      row.country,
      (byCountry.get(row.country) ?? 0) + row.visitors
    );
  }
  return [...byCountry.entries()]
    .map(([code, visitors]) => ({
      key: code,
      label: "",
      country: code,
      visitors,
    }))
    .sort((a, b) => b.visitors - a.visitors);
}

/** City rows keep their country for the flag; nameless cities fold away —
 *  they are already counted in the country cut. */
function foldCities(items: GeographyRow[]): FoldedPlace[] {
  const byCity = new Map<string, FoldedPlace>();
  for (const row of items) {
    const city = row.city.trim();
    if (city === "" || city === "unknown") continue;
    const key = `${row.country}|${city}`;
    const bucket = byCity.get(key) ?? {
      key,
      label: city,
      country: row.country,
      visitors: 0,
    };
    bucket.visitors += row.visitors;
    byCity.set(key, bucket);
  }
  return [...byCity.values()].sort((a, b) => b.visitors - a.visitors);
}

/** Region names, one shared instance — the card and its modal both ask. */
const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
function countryName(code: string): string {
  if (code === "unknown" || code === "") return "Unknown";
  try {
    return REGION_NAMES.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export function LocationsCard() {
  const { enabled, active, filtersParam, addFilter, hasValue } =
    useAnalyticsFilters();
  const resource = useSiteAnalytics(getAnalyticsGeography, MOCK_GEOGRAPHY, {
    filters: filtersParam,
  });
  const [view, setView] = React.useState<LocationView>("countries");

  // The country fold for the share poster, whichever cut the header shows.
  const posterRows = React.useMemo(
    () =>
      resource.status === "ready"
        ? foldCountries(resource.data.items).map((place) => ({
            code: place.country,
            visitors: place.visitors,
          }))
        : null,
    [resource]
  );
  usePublishPosterCountries(
    posterRows,
    resource.status === "ready" && resource.data.meta.truncated
  );
  const [open, setOpen] = React.useState(false);
  const current = VIEWS.find((entry) => entry.id === view) ?? VIEWS[0];

  return (
    <>
    <SquircleCard
      onSeeAll={() => setOpen(true)}
      icon={<Location01Icon aria-hidden="true" />}
      title={
        <DropdownMenu
          align="start"
          className="w-40"
          trigger={
            <button
              className="flex cursor-pointer items-center gap-1 rounded-lg py-0.5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
            >
              {/* the house label swap — the title glides when the cut changes */}
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
          {VIEWS.map((entry) => (
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
          const places =
            view === "countries"
              ? foldCountries(data.items)
              : foldCities(data.items);
          const share = breakdownShare(
            places.map((place) => place.visitors),
            data.meta.truncated
          );
          const bar = trafficBars(places.map((place) => place.visitors));
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
                {places.length === 0 ? (
                  <p className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                    {current.empty}
                  </p>
                ) : (
                  <SquircleCardScroll>
                    {/* Imported geography carries no city — the provider ships
                        a GeoNames id nothing here resolves — so imported
                        countries land on the "city unknown" row and this cut
                        is live-only over an imported range. */}
                    {view === "cities" ? (
                      <ImportedGapNote
                        className="px-5 pb-1 pt-2"
                        kind="city"
                        meta={data.meta}
                      />
                    ) : null}
                    <HoverList>
                      {places.map((place) => (
                        <BreakdownRow
                          icon={
                            <FlagIcon
                              code={place.country}
                              className="size-4"
                            />
                          }
                          key={place.key}
                          name={
                            view === "countries"
                              ? countryName(place.country)
                              : place.label
                          }
                          // The filter takes what the session entry stores:
                          // the ISO code for a country, the raw city string
                          // for a city, never the display name.
                          onSelect={
                            enabled &&
                            // Nothing to add when this place is already in the
                            // clause, so the row stops offering the press.
                            !hasValue(
                              view === "countries" ? "country" : "city",
                              view === "countries" ? place.country : place.label
                            )
                              ? () =>
                                  addFilter(
                                    view === "countries" ? "country" : "city",
                                    view === "countries"
                                      ? place.country
                                      : place.label
                                  )
                              : undefined
                          }
                          bar={bar(place.visitors)}
                          pct={share(place.visitors)}
                          value={place.visitors.toLocaleString("en-US")}
                        />
                      ))}
                    </HoverList>
                  </SquircleCardScroll>
                )}
              </motion.div>
            </AnimatePresence>
          );
        }}
      </AnalyticsCardBody>
    </SquircleCard>

    <AnimatePresence>
      {open && (
        <LocationsModal
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

/** The whole ranking of the cut the card is on, in the vertical shell. */
function LocationsModal({
  items,
  meta,
  view,
  onClose,
}: {
  items: GeographyRow[] | null;
  meta: AnalyticsMeta | null;
  view: LocationView;
  onClose: () => void;
}) {
  const intervalLabel = useIntervalLabel();
  const current = VIEWS.find((entry) => entry.id === view) ?? VIEWS[0];
  const places =
    items === null
      ? null
      : view === "countries"
        ? foldCountries(items)
        : foldCities(items);
  const share = breakdownShare(
    places === null ? [] : places.map((place) => place.visitors),
    meta?.truncated ?? false
  );
  const bar = trafficBars(places === null ? [] : places.map((place) => place.visitors));

  return (
    <SeeAllModal
      title={current.label}
      subtitle={`Where your visitors are · ${intervalLabel}`}
      onClose={onClose}
    >
      {places === null ? (
        <SeeAllSkeleton />
      ) : places.length === 0 ? (
        <p className="px-6 py-14 text-center text-sm text-muted-foreground">
          {current.empty}
        </p>
      ) : (
        <>
          {/* the same live-only caveat the card carries for the city cut */}
          {view === "cities" && meta !== null ? (
            <ImportedGapNote
              className="px-4 pb-1 pt-1"
              kind="city"
              meta={meta}
            />
          ) : null}
          {/* the shared white glide, rounded for the grey band */}
          <HoverList className="[&>li>span]:rounded-[10px]">
            {places.map((place) => (
              <BreakdownRow
                icon={<FlagIcon code={place.country} className="size-4" />}
                key={place.key}
                name={
                  view === "countries"
                    ? countryName(place.country)
                    : place.label
                }
                bar={bar(place.visitors)}
                pct={share(place.visitors)}
                value={place.visitors.toLocaleString("en-US")}
              />
            ))}
          </HoverList>
        </>
      )}
    </SeeAllModal>
  );
}
