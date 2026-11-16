import { cn } from "@/lib/utils";

/**
 * The overview chart's marker glyphs, shared by the marker layer, its legend
 * and the day tooltip so a sale looks the same everywhere it is mentioned.
 *
 * Two shapes as well as two colours, so the kinds tell apart without colour
 * vision: a sale is a diamond in the success green the app uses for money that
 * landed, a mention a round dot in ink. On the plot a white ring lifts both
 * off what is behind them.
 *
 * `tone="dark"` is the same two filled shapes for the dark tooltip. The light
 * ring and the ink fill read there as a hollow white ring (the dark fill
 * vanishes into the dark surface), so on dark the ink turns light, as ink
 * does on a dark surface, and the ring becomes a faint light outline.
 */

type GlyphProps = { muted?: boolean; tone?: "light" | "dark" };

export function SaleGlyph({ muted = false, tone = "light" }: GlyphProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block size-1.5 rotate-45 rounded-xs ring-1",
        tone === "dark" ? "ring-white/40" : "ring-white",
        muted ? "bg-success/30" : "bg-success"
      )}
    />
  );
}

export function MentionGlyph({ muted = false, tone = "light" }: GlyphProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block size-2 rounded-full ring-1",
        tone === "dark"
          ? cn("ring-white/30", muted ? "bg-white/35" : "bg-white/85")
          : cn("ring-white", muted ? "bg-foreground/25" : "bg-foreground/75")
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
