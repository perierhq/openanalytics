"use client";

import { AiChat02Icon } from "hugeicons-react";
import { AnimatePresence } from "motion/react";
import * as React from "react";
import {
  AnalyticsCardBody,
  breakdownShare,
  BreakdownRow,
} from "@/components/dashboard/analytics-card";
import { useAnalyticsFilters } from "@/components/dashboard/filter-context";
import { HoverList } from "@/components/dashboard/hover-list";
import { InfoTip } from "@/components/dashboard/stat-card";
import {
  SeeAllModal,
  SeeAllSkeleton,
  useIntervalLabel,
} from "@/components/dashboard/see-all-modal";
import { useSourcesResource } from "@/components/dashboard/sources-resource";
import { sourceMark } from "@/components/dashboard/source-mark";
import {
  SquircleCard,
  SquircleCardScroll,
} from "@/components/ui/squircle-card";
import type { AnalyticsMeta, SourceRow } from "@/lib/api";
import { foldAiReferrals } from "@/lib/source-rows";
import { trafficBars } from "@/lib/row-bars";

/**
 * The visits AI assistants sent, cut out of the same sources read the
 * Sources card folds (feature_candidates.md §1, built 2026-09-10). Those
 * rows were always in the Referrers list, wearing a favicon among every
 * other domain; this card gives the question its own place and its own
 * total.
 *
 * **Referrals, never citations.** A citation is the site being named inside
 * an answer, and it happens whether or not anybody clicks; a referral is
 * the click. Most readers of an assistant's answer never click, so a small
 * number here says nothing about how often the site is cited. The card is
 * named for what it can count.
 *
 * **How a tuple qualifies.** A sources row is the tuple referrer domain by
 * utm source, medium and campaign, and the server labels each with its
 * channel (`packages/domain/src/channel.ts`); this card is the `ai` rows,
 * the same set the Sources card's Channels cut counts as AI. A tuple is `ai`
 * when its referrer is an assistant, or, when it has no referrer at all, when
 * the utm tag it carries names one, and no rule above AI (a paid, email or
 * affiliate tag) claimed it first: ChatGPT appends `utm_source=chatgpt.com` to every link it hands
 * out, Claude appends `utm_source=Claude AI` with `utm_medium=claude.ai`,
 * and a click from their apps arrives with the tag and an empty referrer, so
 * it would otherwise sit under Direct. That is why the Referrers list can
 * show one ChatGPT visit on a day the UTM sources list shows two. Each tuple
 * is counted once, under whichever of the two named it; a tuple whose
 * referrer is some other site keeps that referrer even if its tag says
 * ChatGPT, because the click happened there.
 *
 * **What it cannot see, and says.** Clicks out of Google AI Overviews arrive
 * as `google.com` and cannot be separated from search; Copilot mostly hides
 * under `bing.com`; crawlers never run the tracker at all. The ⓘ beside the
 * title carries the first of these, the one a reader would otherwise count
 * against themselves.
 *
 * **The panel is rows and nothing else**, like every other card (Abbas,
 * 2026-09-10). The share of all visitors rides beside the title, and the
 * total joins it only in the See all modal's header.
 */

/** The assistant rows, ranked by visitors (`lib/source-rows.ts`). */
export { foldAiReferrals };

/** The caveat beside the title, on the dashboard and on the public board. */
export const AI_REFERRALS_CAVEAT =
  "Visits that arrived from an assistant: by referrer, or by the utm tag it added when there was no referrer at all, each visit once. Clicks out of Google AI Overviews arrive as google.com and are not separable, and being cited without a click leaves no trace here.";

/**
 * What the assistants sent, against everyone: the visitors on the assistant
 * rows and their share of the sum of every sources row, Direct included, so
 * the share is the same approximation as the row shares in the panel. The
 * share is withheld when the gateway capped the row set, for the reason
 * `breakdownShare` gives; the total is a sum of what came back and is always
 * printed as such.
 */
export function aiTotals(
  items: SourceRow[],
  truncated: boolean
): { visitors: number; pct: number | null } {
  const visitors = foldAiReferrals(items).reduce(
    (sum, row) => sum + row.visitors,
    0
  );
  const all = items.reduce((sum, row) => sum + row.visitors, 0);
  const pct = truncated || all <= 0 ? null : Math.round((visitors / all) * 100);
  return { visitors, pct };
}

export function AiReferralsCard() {
  const { enabled, active, addFilter, hasValue } = useAnalyticsFilters();
  const resource = useSourcesResource();
  const [open, setOpen] = React.useState(false);
  // The share rides beside the title once the read is in; until then, and
  // when the share cannot be computed, the title carries only its tip.
  const pct =
    resource.status === "ready"
      ? aiTotals(resource.data.items, resource.data.meta.truncated).pct
      : null;

  return (
    <>
      <SquircleCard
        icon={<AiChat02Icon aria-hidden="true" />}
        onSeeAll={() => setOpen(true)}
        // The share sits inside the title on the title's own baseline: two
        // sizes centred against each other land a pixel apart, and the
        // figure is part of the title's statement. The tip stays outside the
        // heading (titleAside), where the heading's svg rules cannot reach
        // its icon, and wide enough for its two sentences.
        title={
          <span className="flex min-w-0 items-baseline gap-2">
            AI referrals
            {pct !== null ? (
              <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {pct}% of all visitors
              </span>
            ) : null}
          </span>
        }
        titleAside={<InfoTip text={AI_REFERRALS_CAVEAT} width="w-72" />}
      >
        <AnalyticsCardBody
          emptyBody={
            active
              ? "No visits match these filters."
              : "No visits from AI assistants in this range yet."
          }
          isEmpty={(data) => foldAiReferrals(data.items).length === 0}
          resource={resource}
        >
          {(data) => {
            const rows = foldAiReferrals(data.items);
            const share = breakdownShare(
              rows.map((row) => row.visitors),
              data.meta.truncated
            );
            const bar = trafficBars(rows.map((row) => row.visitors));
            return (
              <SquircleCardScroll>
                <HoverList>
                  {rows.map((row) => (
                    <BreakdownRow
                      icon={sourceMark(row)}
                      key={row.label}
                      name={row.label}
                      // The same door the Sources card offers, on the same
                      // dimension: every host the row folded. A row that
                      // qualified by its tag alone has no host to filter by
                      // and stays a plain row.
                      onSelect={
                        enabled &&
                        row.raw.length > 0 &&
                        !row.raw.every((domain) =>
                          hasValue("referrer_domain", domain)
                        )
                          ? () => {
                              for (const domain of row.raw) {
                                addFilter("referrer_domain", domain);
                              }
                            }
                          : undefined
                      }
                      bar={bar(row.visitors)}
                      pct={share(row.visitors)}
                      value={row.visitors.toLocaleString("en-US")}
                    />
                  ))}
                </HoverList>
              </SquircleCardScroll>
            );
          }}
        </AnalyticsCardBody>
      </SquircleCard>

      <AnimatePresence>
        {open && (
          <AiReferralsModal
            items={resource.status === "ready" ? resource.data.items : null}
            meta={resource.status === "ready" ? resource.data.meta : null}
            onClose={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

/** Every assistant, in the vertical shell. */
function AiReferralsModal({
  items,
  meta,
  onClose,
}: {
  items: SourceRow[] | null;
  /** Read for `truncated` alone: a share of a capped row set is inflated. */
  meta: AnalyticsMeta | null;
  onClose: () => void;
}) {
  const intervalLabel = useIntervalLabel();
  const rows = items === null ? null : foldAiReferrals(items);
  const share = breakdownShare(
    rows === null ? [] : rows.map((row) => row.visitors),
    meta?.truncated ?? false
  );
  const bar = trafficBars(rows === null ? [] : rows.map((row) => row.visitors));
  // The total and the share live in the header here, the one place the
  // card shows a figure that is not a row: "1,204 visitors · 4% of all
  // visitors · Last 30 days", or without the share when it is withheld.
  const totals =
    items === null ? null : aiTotals(items, meta?.truncated ?? false);
  const subtitle =
    totals === null
      ? `Visits the assistants sent · ${intervalLabel}`
      : [
          `${totals.visitors.toLocaleString("en-US")} visitors`,
          totals.pct !== null ? `${totals.pct}% of all visitors` : null,
          intervalLabel,
        ]
          .filter((part) => part !== null)
          .join(" · ");

  return (
    <SeeAllModal title="AI referrals" subtitle={subtitle} onClose={onClose}>
      {rows === null ? (
        <SeeAllSkeleton />
      ) : rows.length === 0 ? (
        <p className="px-6 py-14 text-center text-sm text-muted-foreground">
          No visits from AI assistants in this range yet.
        </p>
      ) : (
        // the shared white glide, rounded for the grey band
        <HoverList className="[&>li>span]:rounded-[10px]">
          {rows.map((row) => (
            <BreakdownRow
              icon={sourceMark(row)}
              key={row.label}
              name={row.label}
              bar={bar(row.visitors)}
              pct={share(row.visitors)}
              value={row.visitors.toLocaleString("en-US")}
            />
          ))}
        </HoverList>
      )}
    </SeeAllModal>
  );
}
