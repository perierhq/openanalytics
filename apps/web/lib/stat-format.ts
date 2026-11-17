/**
 * The stat tiles' words and number formats, in one place for both screens
 * that print them: the dashboard overview and the public share board. A
 * definition that lives twice drifts; this module is why it cannot.
 *
 * No runtime imports from `./api`: the web tests run before the contracts
 * package is built.
 */

/** The ⓘ beside each tile: one plain line, no second sentence. */
export const STAT_DEFINITIONS = {
  visitors: "Unique people who viewed at least one page in this range.",
  pageviews: "Every page load, counted each time a page is opened.",
  bounce_rate: "The share of visits that left after viewing a single page.",
  avg_visit: "How long a visit lasts on average, from first page to last activity.",
  revenue:
    "What your payment provider paid out: charges minus refunds, disputes and fees.",
} as const;

/** The share board's names for the two session definitions it prints. */
export const BOUNCE_INFO = STAT_DEFINITIONS.bounce_rate;
export const AVG_VISIT_INFO = STAT_DEFINITIONS.avg_visit;

/** "1m 42s" — an average duration in words a human reads at a glance. */
export function durationLabel(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "36%" — a rate in [0, 1] as a whole percent. */
export function percentLabel(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
