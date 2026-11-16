import type { EventMarkerKind } from "@/components/charts/event-markers";
import { MentionGlyph, SaleGlyph } from "@/components/dashboard/chart-marker-glyphs";
import { MentionAvatar } from "@/components/dashboard/mention-avatar";
import type { Mention, RevenueTransaction } from "@/lib/api";
import type { EventMarkerItem } from "@/lib/event-markers";
import { mentionFace } from "@/lib/marker-faces";

/**
 * The overview chart's two marker kinds: their words, their glyphs and, for
 * mentions, their face. Shared by the marker layer (`chart-markers.tsx`) and
 * its tests.
 *
 * **Sales have no face.** The dashboard draws a visitor's face from their
 * visitor seed (`UserAvatar`), and a revenue transaction carries none; a face
 * made up from the transaction id would not be the same buyer's face anywhere
 * else, so a sale stays a diamond at every density.
 */

export type OverviewMarkerKind = "sale" | "mention";

export type OverviewMarkerPayload =
  | { kind: "sale"; sale: RevenueTransaction }
  | { kind: "mention"; mention: Mention };

export type OverviewMarkerItem = EventMarkerItem<OverviewMarkerKind, OverviewMarkerPayload>;

export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * A bucket's mentions as one face: the most followed author's picture (or
 * initials), in a neutral ring, with "+N" for the other mentions. The ring is
 * the kind's mark without colour: a sale's is green and comes with a diamond.
 */
function MentionMarkerFace({ mentions }: { mentions: readonly Mention[] }) {
  const face = mentionFace(mentions);
  if (!face) return <MentionGlyph />;
  return (
    <span className="relative flex">
      <MentionAvatar
        author={face.author}
        // A 1px neutral line on the face, a white halo off the plot, and an
        // opaque disc so a revenue bar behind the initials doesn't tint them.
        className="bg-[color-mix(in_srgb,var(--ink)_6%,white)] shadow-[0_0_0_2.5px_white] ring-1 ring-black/20"
        size={20}
      />
      {face.more > 0 ? (
        <span className="absolute -right-2 -bottom-1 h-3.5 min-w-3.5 rounded-full bg-white px-0.75 text-center text-[9px] font-medium leading-3.5 tabular-nums text-foreground/80 ring-1 ring-black/15">
          +{face.more}
        </span>
      ) : null}
    </span>
  );
}

/** Stacking order, bottom first: sales sit nearest the axis. */
export const OVERVIEW_MARKER_KINDS: Record<
  OverviewMarkerKind,
  EventMarkerKind<OverviewMarkerPayload>
> = {
  sale: {
    describe: (count) => plural(count, "sale", "sales"),
    glyph: <SaleGlyph />,
  },
  mention: {
    describe: (count) => plural(count, "mention", "mentions"),
    glyph: <MentionGlyph />,
    face: (items) => (
      <MentionMarkerFace
        mentions={items.flatMap((item) =>
          item.payload.kind === "mention" ? [item.payload.mention] : []
        )}
      />
    ),
  },
};
