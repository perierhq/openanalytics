import { cn } from "@/lib/utils";

/**
 * The overview chart's marker glyphs, shared by the marker layer, its legend
 * and the day tooltip so a sale looks the same everywhere it is mentioned.
 *
 * Two shapes as well as two colours, so the kinds tell apart without colour
 * vision: a sale is a diamond in the success green the app uses for money that
 * landed, a mention a round dot in ink. The white ring lifts both off what is
 * behind them, the plot or the dark tooltip alike: one look everywhere, so the
 * tooltip's dot is recognisably the marker it summarises.
 */

type GlyphProps = { muted?: boolean };

export function SaleGlyph({ muted = false }: GlyphProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block size-1.5 rotate-45 rounded-xs ring-1 ring-white",
        muted ? "bg-success/30" : "bg-success"
      )}
    />
  );
}

export function MentionGlyph({ muted = false }: GlyphProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block size-2 rounded-full ring-1 ring-white",
        muted ? "bg-foreground/25" : "bg-foreground/75"
      )}
    />
  );
}

/** The revenue layer's legend mark: a short bar in the bars' own fill. */
export function RevenueGlyph({ muted = false }: { muted?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block h-2.5 w-1.5 rounded-[1.5px]",
        muted ? "bg-success/15" : "bg-success/40"
      )}
    />
  );
}
