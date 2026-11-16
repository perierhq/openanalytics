"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ArrowDown01Icon, ArrowRight01Icon } from "hugeicons-react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import * as React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/**
 * Apple-style squircle silhouette, ported from the atlas project. The shape
 * comes from a CSS `shape()` clip-path (with `corner-shape: squircle` where
 * supported) — continuous-curvature corners instead of circular arcs.
 *
 * Chromium-only, by declaration: engines without `corner-shape` (Safari,
 * Firefox) are switched to a plain circular radius by an `@supports not`
 * block in `globals.css`, which also removes this clip-path. Without that
 * switch the oversized border-radius here renders as a raw 26/50px blob and
 * fights the clip's tighter geometry, which is exactly the double-contour
 * Safari bug it exists to prevent. Tune corners on that fallback through
 * `--card-clip-radius`, never by editing the classes below.
 */
const cardClipPath =
  "shape(from var(--card-clip-radius) 0px, line to calc(100% - var(--card-clip-radius)) 0px, curve to 100% var(--card-clip-radius) with calc(100% - var(--card-clip-handle)) 0px / 100% var(--card-clip-handle), line to 100% calc(100% - var(--card-clip-radius)), curve to calc(100% - var(--card-clip-radius)) 100% with 100% calc(100% - var(--card-clip-handle)) / calc(100% - var(--card-clip-handle)) 100%, line to var(--card-clip-radius) 100%, curve to 0px calc(100% - var(--card-clip-radius)) with var(--card-clip-handle) 100% / 0px calc(100% - var(--card-clip-handle)), line to 0px var(--card-clip-radius), curve to var(--card-clip-radius) 0px with 0px var(--card-clip-handle) / var(--card-clip-handle) 0px, close)";

type CardStyle = React.CSSProperties & {
  "--card-clip-handle"?: string;
  "--card-clip-path"?: string;
  "--card-clip-radius"?: string;
};

/** Bare squircle-clipped box — the primitive both card layers are built on. */
export function SquircleSurface({
  className,
  render,
  style,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn(
      "relative flex min-w-0 flex-col rounded-[26px] bg-card not-dark:bg-clip-padding text-card-foreground [--card-clip-handle:2.25px] [--card-clip-radius:14px] [clip-path:var(--card-clip-path)] [corner-shape:squircle] before:pointer-events-none before:absolute before:inset-0 before:[clip-path:var(--card-clip-path)] sm:rounded-[50px] sm:[--card-clip-handle:3px] sm:[--card-clip-radius:20px]",
      className,
    ),
    style: {
      "--card-clip-path": cardClipPath,
      ...style,
    } as CardStyle,
    "data-slot": "squircle-surface",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
}

/**
 * The header's chip slot. A card body knows things about its data the shell
 * cannot — chiefly whether the numbers are behind — and the place to say so
 * is beside the title ("Browsers · Catching up"), not somewhere over the
 * rows. The body cannot render into the header from below, so the shell
 * offers a setter: register a node and the header shows it, aligned on the
 * title's own centreline; clear it (or unmount) and the header is clean.
 */
const HeaderChipContext = React.createContext<
  ((chip: React.ReactNode) => void) | null
>(null);

/** `null` outside a `SquircleCard` — callers must tolerate having no slot. */
export function useSquircleCardHeaderChip():
  | ((chip: React.ReactNode) => void)
  | null {
  return React.useContext(HeaderChipContext);
}

type SquircleCardProps = {
  /** Header label shown in the frame's top strip */
  title: React.ReactNode;
  /** Optional header icon, e.g. `<Globe02Icon aria-hidden="true" />` — sized
   *  and tinted automatically */
  icon?: React.ReactNode;
  /** Rides beside the title, outside the heading, for a qualifier that keeps
   *  its own sizing: a share figure, the stat cards' ⓘ tip. The heading's svg
   *  rules would otherwise resize a tip's icon. */
  titleAside?: React.ReactNode;
  /** A small control on the header's right, before "See all": the Sources
   *  card's sort toggle. */
  actions?: React.ReactNode;
  /** Content of the inset panel (typically a list); it stretches to the
   *  frame's bottom edge */
  children: React.ReactNode;
  /** Where the header's "See all" button leads */
  seeAllHref?: string;
  /** In-place "See all" — renders a button instead of a link. Wins over
   *  `seeAllHref`; for cards whose full view is a modal, not a page. */
  onSeeAll?: () => void;
  /** No "See all" at all — the public share board's read-only cards. */
  hideSeeAll?: boolean;
  /** Extra classes for the outer frame */
  className?: string;
  /** Extra classes for the inset panel */
  contentClassName?: string;
};

/**
 * The standard mini-card: white squircle frame with an icon+title strip on
 * top and a recessed squircle panel pinned to the bottom edge, waiting for
 * its data rows.
 *
 * ```tsx
 * <SquircleCard title="Top sources" icon={<Globe02Icon aria-hidden="true" />}>
 *   <ul>…</ul>
 * </SquircleCard>
 * ```
 */
export function SquircleCard({
  title,
  icon,
  titleAside,
  actions,
  children,
  seeAllHref = "#",
  onSeeAll,
  hideSeeAll = false,
  className,
  contentClassName,
}: SquircleCardProps): React.ReactElement {
  const [headerChip, setHeaderChip] = React.useState<React.ReactNode>(null);
  const seeAllClassName =
    "group/seeall flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 hover:bg-accent/60 hover:text-foreground";
  const seeAllBody = (
    <>
      See all
      <ArrowRight01Icon
        aria-hidden="true"
        className="size-3.5 transition-transform duration-200 group-hover/seeall:translate-x-0.5"
      />
    </>
  );
  const seeAll = hideSeeAll ? null : onSeeAll ? (
    <button
      type="button"
      onClick={onSeeAll}
      className={cn(seeAllClassName, "cursor-pointer")}
    >
      {seeAllBody}
    </button>
  ) : (
    <Link href={seeAllHref} className={seeAllClassName}>
      {seeAllBody}
    </Link>
  );
  return (
    <SquircleSurface
      render={<section />}
      className={cn(
        "flex flex-col border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 pb-2 pl-3.5 pr-2 pt-1.5">
        {/* Title and chip share one centreline on purpose: the chip is part
            of the title's statement ("Browsers, catching up"), so it may not
            ride higher or lower than the words it qualifies. It sits outside
            the h2 so the heading's svg sizing never reaches the badge's own
            icon disc. */}
        <div className="ml-1 flex min-w-0 items-center gap-2">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground/80 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
            {icon}
            {title}
          </h2>
          {titleAside}
          {headerChip}
        </div>
        {actions == null ? (
          seeAll
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            {actions}
            {seeAll}
          </div>
        )}
      </div>
      <SquircleSurface
        className={cn(
          // Fixed five-row height (5 × 32px rows + py-2): cards never grow
          // with their data; anything longer scrolls inside. Override via
          // contentClassName.
          // `grow` beside the fixed height, and specifically NOT `flex-1`:
          // grow keeps `h-44` as the flex basis, so a card sizing itself is
          // exactly as tall as it always was and long lists still scroll,
          // while inside a grid row stretched by a taller neighbour (the
          // locations card's dropdown title is a few pixels taller than a
          // plain one) the panel takes up the slack instead of stopping
          // short and leaving a strip of card under the recess. `flex-1`
          // zeroes the basis, which hands the panel its content height and
          // un-caps every long list.
          // overflow-hidden clips the row hover highlight to the rounded
          // corners on the first/last rows
          "h-44 grow overflow-hidden rounded-[22px] border border-border py-2 bg-[#f6f6f6] shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]",
          contentClassName,
        )}
      >
        <HeaderChipContext.Provider value={setHeaderChip}>
          {children}
        </HeaderChipContext.Provider>
      </SquircleSurface>
    </SquircleSurface>
  );
}

/**
 * Scroll wrapper for card lists. When the data fits the panel it renders as
 * a plain list — no scrollbar, no indicator. When it overflows, a small
 * animated chevron chip sits at the card's bottom-right: it bobs downward
 * while there is more below, and flips to point up once you hit the end.
 */
export function SquircleCardScroll({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [state, setState] = React.useState<"none" | "more" | "end">("none");

  const measure = React.useCallback(() => {
    const viewport = wrapRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!viewport) return;
    if (viewport.scrollHeight - viewport.clientHeight <= 4) {
      setState("none");
      return;
    }
    const atEnd =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 4;
    setState(atEnd ? "end" : "more");
  }, []);

  React.useEffect(() => {
    measure();
    const viewport = wrapRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!viewport) return;
    // re-measure when the panel or its content resizes
    const ro = new ResizeObserver(measure);
    ro.observe(viewport);
    return () => ro.disconnect();
  }, [measure]);

  return (
    // scroll doesn't bubble, so listen in the capture phase from the wrapper
    <div ref={wrapRef} className="relative h-full" onScrollCapture={measure}>
      <ScrollArea
        scrollFade
        className={cn("**:data-[slot=scroll-area-scrollbar]:hidden", className)}
      >
        {children}
      </ScrollArea>
      <AnimatePresence>
        {/* only while there is more below — at the end it fades away so it
            never covers the last row's numbers (the mid-list overlap is
            already masked by the bottom scroll fade) */}
        {state === "more" && (
          <motion.span
            aria-hidden="true"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="pointer-events-none absolute bottom-2 right-3 z-10 flex size-6 items-center justify-center rounded-full border border-border bg-white/90 shadow-sm"
          >
            <motion.span
              animate={{ y: [0, 2.5, 0] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
              className="flex"
            >
              <ArrowDown01Icon className="size-3.5 text-muted-foreground" />
            </motion.span>
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
