import type { EventMarkerKind } from "@/components/charts/event-markers";
import { MentionGlyph, NoteGlyph, SaleGlyph } from "@/components/dashboard/chart-marker-glyphs";
import { MentionAvatar } from "@/components/dashboard/mention-avatar";
import { UserAvatar } from "@/components/ui/user-avatar";
import type { ChartNote, Mention, RevenueTransaction } from "@/lib/api";
import { MARKER_BADGE, type EventMarkerItem } from "@/lib/event-markers";
import { mentionFace, type SaleFace, saleFace } from "@/lib/marker-faces";

/**
 * The overview chart's three marker kinds: their words, their glyphs and their
 * faces. Shared by the marker layer (`chart-markers.tsx`) and its tests.
 *
 * **A note never wears a face.** It is the team's own words, not a person
 * arriving from outside, so it keeps its flag in faces mode too. Its flag has
 * a pole of its own, so a bucket with only a note sits just above the line
 * without a stem (`stemless`).
 *
 * **A sale wears its buyer's face** when it matched a visitor: `UserAvatar`
 * seeded with the transaction's `visitor`, the same seed the realtime views
 * use, so it is the same face (see `lib/marker-faces.ts`). A sale that matched
 * nobody has no face, and its bucket keeps the diamond.
 *
 * A face's "+N" sits on its right edge, centred on that face, so when a
 * bucket stacks a buyer and an author the two badges never touch.
 */

export type OverviewMarkerKind = "sale" | "mention" | "note";

export type OverviewMarkerPayload =
  | { kind: "sale"; sale: RevenueTransaction }
  | { kind: "mention"; mention: Mention }
  | { kind: "note"; note: ChartNote };

export type OverviewMarkerItem = EventMarkerItem<OverviewMarkerKind, OverviewMarkerPayload>;

export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * A face's "+N": on its right edge, centred on the face, `MARKER_BADGE` tall,
 * so the stack (`markerStack`) can keep two faces' badges apart.
 */
function FaceBadge({ more }: { more: number }) {
  if (more <= 0) return null;
  return (
    <span
      className="absolute top-1/2 -right-2 -translate-y-1/2 rounded-full bg-white px-0.75 text-center text-[9px] font-medium tabular-nums text-foreground/80 ring-1 ring-black/15"
      style={{ height: MARKER_BADGE, minWidth: MARKER_BADGE, lineHeight: `${MARKER_BADGE}px` }}
    >
      +{more}
    </span>
  );
}

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
      <FaceBadge more={face.more} />
    </span>
  );
}

/**
 * A bucket's sales as their newest buyer's face, in the sale green with a
 * small diamond so the kind reads without colour, and "+N" for the other
 * sales. Only drawn when a sale matched a visitor (`saleFace` is not null);
 * otherwise the layer draws the glyph.
 */
function SaleMarkerFace({ face }: { face: SaleFace }) {
  return (
    <span className="relative flex">
      {/* The green line on the face and the same white halo a mention has. */}
      <span className="flex rounded-full shadow-[0_0_0_3px_white] ring-[1.5px] ring-success">
        <UserAvatar seed={face.visitor} size={20} />
      </span>
      <span className="absolute -bottom-0.5 -left-0.5 flex">
        <SaleGlyph />
      </span>
      <FaceBadge more={face.more} />
    </span>
  );
}

/** Stacking order, bottom first: sales sit nearest the axis, notes on top. */
export const OVERVIEW_MARKER_KINDS: Record<
  OverviewMarkerKind,
  EventMarkerKind<OverviewMarkerPayload>
> = {
  sale: {
    describe: (count) => plural(count, "sale", "sales"),
    glyph: <SaleGlyph />,
    face: (items) => {
      const face = saleFace(
        items.flatMap((item) => (item.payload.kind === "sale" ? [item.payload.sale] : []))
      );
      return face ? <SaleMarkerFace face={face} /> : null;
    },
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
  note: {
    describe: (count) => plural(count, "note", "notes"),
    glyph: <NoteGlyph />,
    stemless: true,
  },
};
