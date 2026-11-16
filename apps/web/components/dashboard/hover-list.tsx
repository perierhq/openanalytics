"use client";

import { motion } from "motion/react";
import * as React from "react";
import { cn } from "@/lib/utils";

/** Same near-instant glide as the header logo menu's hover highlight. */
const HOVER_TRANSITION = { duration: 0.04, ease: "easeOut" } as const;

type HoverListContextValue = {
  hovered: string | null;
  setHovered: (key: string | null) => void;
  layoutId: string;
};

const HoverListContext = React.createContext<HoverListContextValue | null>(null);

/**
 * List whose rows share a single hover highlight: a rounded, inset pill that
 * glides between rows (logo-menu style) instead of each row lighting up on
 * its own.
 */
export function HoverList({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = React.useState<string | null>(null);
  const layoutId = React.useId();
  return (
    <ul className={className} onMouseLeave={() => setHovered(null)}>
      <HoverListContext.Provider value={{ hovered, setHovered, layoutId }}>
        {children}
      </HoverListContext.Provider>
    </ul>
  );
}

/** Row inside a HoverList; renders the shared highlight when hovered. */
export function HoverRow({
  className,
  backdrop,
  children,
}: {
  className?: string;
  /**
   * Drawn behind the row's content and above the hover glide, as a direct
   * child of the `<li>` so a list's row rounding reaches it: the breakdown
   * rows' bar (`RowBar`).
   */
  backdrop?: React.ReactNode;
  children: React.ReactNode;
}) {
  const key = React.useId();
  const context = React.useContext(HoverListContext);
  if (!context) throw new Error("HoverRow must be used inside a HoverList");
  const { hovered, setHovered, layoutId } = context;

  return (
    <li
      onMouseEnter={() => setHovered(key)}
      className={cn("group relative cursor-default select-none", className)}
    >
      {hovered === key && (
        <motion.span
          layoutId={layoutId}
          transition={HOVER_TRANSITION}
          aria-hidden="true"
          className="absolute inset-x-0 inset-y-0 bg-white/90"
        />
      )}
      {backdrop}
      <div className="relative">{children}</div>
    </li>
  );
}
