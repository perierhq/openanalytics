"use client";

import {
  AiChat02Icon,
  ArrowLeft01Icon,
  ArrowRight02Icon,
  AtIcon,
  Cancel01Icon,
  InternetIcon,
  Location01Icon,
  Message01Icon,
  MoreHorizontalCircle02Icon,
  PipelineIcon,
  PuzzleIcon,
  SentIcon,
  Settings01Icon,
  Tap01Icon,
  UserStoryIcon
} from "hugeicons-react";
import { AnimatePresence, motion, useSpring } from "motion/react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import * as React from "react";
// Not in the old `hugeicons-react` set — it comes from the new
// `@hugeicons/core-free-icons` data package via our adapter, which wraps the
// raw icon data into a component.
import { ActivityCircleIcon } from "@/components/icons/hugeicons";
import { useAnalyticsFilters } from "@/components/dashboard/filter-context";
import { Favicon } from "@/components/dashboard/site-favicon";
import {
  readGlobeVisitor,
  readGlobeVisitorServer,
  setGlobeVisitor,
  subscribeGlobeVisitor,
} from "@/components/dashboard/globe-visitor-store";
import {
  BrowserIcon,
  DeviceGlyph,
  FlagIcon,
  MarkCircle,
  OSIcon,
} from "@/components/dashboard/tech-icons";
import { UserAvatar } from "@/components/ui/user-avatar";
import { useRealtime } from "@/hooks/use-realtime";
import { submitNotifyForm } from "@seam/slots";
import { assistant, errorCodeOf, LIVE_API, presentError } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import {
  DIMENSION_LABEL,
  filterValueLabel,
  type FilterClause,
} from "@/lib/analytics-filters";
import { resolveReferrer } from "@/lib/referrers";
import { cn } from "@/lib/utils";

/**
 * Where feedback goes with no mail door behind it: the public tracker.
 *
 * Confirmed against the published repository on 2026-08-11 (ADR-0061).
 * It is a constant rather than an env var on purpose — every copy of this
 * build reports to the same project, and a per-install override would only
 * scatter the reports.
 */
const ISSUES_URL = "https://github.com/OpenLabs-so/openanalytics/issues";

type IconComponent = React.ComponentType<{
  className?: string;
  strokeWidth?: number;
}>;

type Tab = {
  segment: string;
  label: string;
  icon: IconComponent;
};

const TABS: Tab[] = [
  { segment: "", label: "Overview", icon: ActivityCircleIcon },
  { segment: "/realtime", label: "Realtime", icon: UserStoryIcon },
  { segment: "/funnels", label: "Funnels", icon: PipelineIcon },
  // Revenue is hidden, not deleted (2026-08-09): the page's fate is
  // undecided, so nothing navigates to it — the overview card's "See all"
  // opens the paying-visitors modal instead. The route still answers for
  // anyone holding the URL; restoring the tab is uncommenting one line
  // (the icon was DollarCircleIcon, re-import it with the line):
  // { segment: "/revenue", label: "Revenue", icon: DollarCircleIcon },
  // Beside Funnels: both read the site's own traffic story, and mentions are
  // the outside half of it (who is talking about the site, and when).
  { segment: "/mentions", label: "Mentions", icon: AtIcon },
  { segment: "/globe", label: "Live Globe", icon: InternetIcon },
  { segment: "/settings", label: "Settings", icon: Settings01Icon },
];

/**
 * Quick actions behind the ⋯ button (real since 2026-08-09). The first two
 * are doors into the settings tabs that own the flows, wearing those tabs'
 * own icons; the third opens the feedback face in place. Rendered inline in
 * the menu face because two of them need the site's base path.
 */
const MENU_LINKS: { label: string; icon: IconComponent; tab: string }[] = [
  { label: "Integrations", icon: PuzzleIcon, tab: "integrations" },
  { label: "Custom Events", icon: Tap01Icon, tab: "events" },
];

/**
 * One pill in the menu face, worn by a link, a button and an anchor alike.
 * The three used to carry the same forty characters of class three times; the
 * responsive padding is the reason they finally became a constant.
 */
const MENU_ITEM_CLASS =
  "flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-full px-[9px] py-[7px] text-[13px] font-medium text-white/80 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/40 sm:px-3";

/** Tooltip anchors: the tabs, then the chat and more buttons. */
const TOOLTIP_LABELS = [...TABS.map((tab) => tab.label), "AI Chat", "More"];
const CHAT_INDEX = TABS.length;
const MORE_INDEX = TABS.length + 1;

const SPRING = { type: "spring", stiffness: 550, damping: 40 } as const;

/* --------------------------------------------------------------------- */
/* The filter tray                                                       */
/* --------------------------------------------------------------------- */

/**
 * One filter value's mark, in the bar's own dark spelling: the favicon for
 * a source (the direct arrow for Direct), the flag for a country, the pin
 * for a city, the device glyph for a device. The same vocabulary the cards'
 * rows wear, so the chip is recognisably the row that was clicked.
 */
function filterMark(clause: FilterClause, value: string): React.ReactNode {
  switch (clause.dimension) {
    case "referrer_domain":
      return value === "" ? (
        <ArrowRight02Icon className="size-3.5 text-white/70" />
      ) : (
        <Favicon
          className="size-3.5 rounded-full object-cover"
          domain={resolveReferrer(value).domain}
        />
      );
    case "country":
      return <FlagIcon className="size-3.5" code={value} />;
    case "city":
      return <Location01Icon className="size-3.5 text-white/70" />;
    case "device_type":
      return <DeviceGlyph className="size-3.5 text-white/70" deviceType={value} />;
  }
}

/** How the chip spells one value; the source name is the resolved one, so
 *  the chip says what the Sources row it came from said. */
function filterLabel(clause: FilterClause, value: string): string {
  if (clause.dimension === "referrer_domain" && value !== "") {
    return resolveReferrer(value).name;
  }
  return filterValueLabel(clause.dimension, value);
}

/**
 * One chip's marks, folded the way the card that produced them folds its
 * rows: by what they are called.
 *
 * A press on the Sources card's Google row filters by every host that row
 * holds, and `google.com`, `www.google.com` and `m.google.com` are three
 * session values under one name. A mark per *value* drew that as three
 * identical Google favicons, which reads as three presses nobody made. Distinct
 * marks are the ones with distinct names, and a chip with one name gets its
 * name printed beside the mark again, whatever number of hosts it took to
 * mean it.
 */
function filterMarks(
  clause: FilterClause
): { label: string; value: string; values: string[] }[] {
  const byLabel = new Map<string, string[]>();
  for (const value of clause.values) {
    const label = filterLabel(clause, value);
    const group = byLabel.get(label) ?? [];
    group.push(value);
    byLabel.set(label, group);
  }
  // `value` is the one the mark is drawn from; `values` is what removing
  // the chip takes away, every host the name stood for.
  return [...byLabel.entries()].map(([label, values]) => ({
    label,
    value: values[0],
    values,
  }));
}

/**
 * One chip: the mark(s), the name when it has one to print, and the remove.
 * `layout` and the keyed presence are what let a chip split off or fold in
 * without the neighbours jumping.
 */
function FilterChip({
  children,
  label,
  onRemove,
  ref,
  removeLabel,
  showLabel,
}: {
  /** The mark, or the marks, drawn in the bar's own dark spelling. */
  children: React.ReactNode;
  /** The full spelling: printed when `showLabel`, always in the title. */
  label: string;
  onRemove: () => void;
  /**
   * Handed straight to the root, and not optional in spirit: the tray's
   * `popLayout` presence measures a leaving chip through this ref to lift
   * it out of the flow. Without it the chip stayed in the row for its
   * whole exit, the row wrapped, and the bar dipped a line on every fold.
   */
  ref?: React.Ref<HTMLSpanElement>;
  removeLabel: string;
  showLabel: boolean;
}) {
  return (
    <motion.span
      ref={ref}
      animate={{ opacity: 1, scale: 1 }}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-white/10 pl-2 pr-1 text-xs text-white/90"
      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.1 } }}
      initial={{ opacity: 0, scale: 0.9 }}
      layout
      title={label}
      transition={SPRING}
    >
      <span aria-hidden="true" className="flex shrink-0 items-center gap-[3px]">
        {children}
      </span>
      {showLabel ? (
        <span className="max-w-32 truncate">{label}</span>
      ) : (
        <span className="sr-only">{label}</span>
      )}
      <button
        aria-label={removeLabel}
        className="flex size-4.5 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/50 outline-none transition-colors hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-white/40"
        onClick={onRemove}
        type="button"
      >
        <Cancel01Icon className="size-3" />
      </button>
    </motion.span>
  );
}

/**
 * The active filters, as a storey above the tab row. It follows the
 * transcript storey's contract exactly (the storey only fades, the bar's
 * measured springs do all the growing) and it draws only while the
 * overview is on screen,
 * because the overview is the one screen the filters describe. Removing
 * the last chip removes the storey, and the bar springs back to the row.
 *
 * Up to two names in a dimension are two chips, each with its own mark, its
 * own name and its own remove; from three on they fold into one chip of
 * marks whose remove clears the dimension, because "Google +2" hides exactly
 * what the chip exists to say, while three marks in a row ARE the list. The
 * fold used to start at two (2026-09-01), and the cost was the remove:
 * somebody with Google and GitHub who wanted only GitHub gone had to clear
 * both and click Google again. Separate chips are separate removes. The
 * folded chip's full spelling rides its hover title and a screen-reader
 * span.
 */
function FilterTray() {
  const { clauses, removeDimension, removeValues } = useAnalyticsFilters();
  return (
    <div>
      {/* `justify-center`, because the block stretches to the capsule's
          width whenever the tab row is the wider child, and left-packed
          chips read as a misprint against a centred row. `flex-wrap` under
          a viewport cap is the long-label answer: a chip never leaves the
          capsule, it takes a second line, and the bar's measured springs treat
          the taller storey like any other. The `px-3` keeps the outermost
          chips off the capsule's 24px corner curve. */}
      <div className="relative flex max-w-[calc(100vw-3rem)] flex-wrap items-center justify-center gap-1.5 px-3 pb-1.5 pt-2">
        {/* popLayout, because of the fold. Going from two chips to the
            folded one is two exits and one enter, and for the 100ms of the
            exit the row held all three: wide enough to wrap, so the bar's
            measured spring grew a line and shrank it again, a dip on every
            third value. Popped out of the flow, the leaving chips fade
            where they stood while the row is already the width it will
            end at. `relative` on the row is what the popped chips are
            positioned against. */}
        <AnimatePresence initial={false} mode="popLayout">
          {clauses.flatMap((clause) => {
            const marks = filterMarks(clause);
            if (marks.length > 2) {
              const spelled = marks.map((mark) => mark.label).join(", ");
              return [
                <FilterChip
                  key={clause.dimension}
                  label={spelled}
                  onRemove={() => removeDimension(clause.dimension)}
                  removeLabel={`Remove the ${DIMENSION_LABEL[clause.dimension]} filter`}
                  showLabel={false}
                >
                  {marks.map((mark) => (
                    <span className="flex items-center" key={mark.label}>
                      {filterMark(clause, mark.value)}
                    </span>
                  ))}
                </FilterChip>,
              ];
            }
            return marks.map((mark) => (
              <FilterChip
                key={`${clause.dimension}:${mark.label}`}
                label={mark.label}
                onRemove={() => removeValues(clause.dimension, mark.values)}
                removeLabel={`Remove ${mark.label} from the ${DIMENSION_LABEL[clause.dimension]} filter`}
                showLabel
              >
                {filterMark(clause, mark.value)}
              </FilterChip>
            ));
          })}
        </AnimatePresence>
      </div>
      <div className="mx-3 h-px bg-white/8" />
    </div>
  );
}

/**
 * The pill is a fixed window; the labels are a strip sliding behind it. The
 * new label enters from the direction the hover is travelling and the old one
 * leaves through the opposite edge — full width, full opacity, clipped by the
 * pill's mask rather than faded.
 *
 * Enter is measured in the label's own width (110% — the pill is exactly this
 * label wide, so it always starts clear). Exit is a fixed distance instead: a
 * percentage of the *old* label falls short when the pill is growing toward a
 * longer one, and the old label's tail stays visible inside the wider mask —
 * the "stray letter" on the way to Overview. The constant just has to beat the
 * widest pill.
 */
const LABEL_EXIT_PX = 130;

const labelVariants = {
  enter: (dir: number) => ({ x: `${dir * 110}%` }),
  center: { x: "0%" },
  exit: (dir: number) => ({ x: dir * -LABEL_EXIT_PX }),
};

/** Row swap inside the bar — the variant-02 slide. */
const rowVariants = {
  enter: (dir: number) => ({ opacity: 0, x: dir * 16 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir * -16, transition: { duration: 0.1 } }),
};

type Surface = "none" | "menu" | "chat" | "visitor" | "feedback";

/** 10-second clock buckets — the visitor face's "last seen" ages without
 *  reading the clock in render. */
const subscribeClock = (onChange: () => void) => {
  const timer = setInterval(onChange, 10_000);
  return () => clearInterval(timer);
};
const readClockBucket = () => Math.floor(Date.now() / 10_000);
const readClockBucketServer = () => 0;

function lastSeenLabel(secondsAgo: number): string {
  if (secondsAgo < 60) return `${Math.max(0, secondsAgo)}s ago`;
  if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)}m ago`;
  return `${Math.floor(secondsAgo / 3600)}h ago`;
}

type ChatMessage = { id: number; role: "user" | "ai"; text: string };

/**
 * Ten messages is the server's conversation cap (`ASSISTANT_MAX_MESSAGES`);
 * older turns are dropped client-side rather than bouncing the request.
 */
const ASSISTANT_HISTORY_LIMIT = 10;

/** Canned replies for mock mode — live mode streams from the assistant. */
const MOCK_REPLIES = [
  "/pricing lost 18% of its visitors against the prior week; the drop starts at 14:00 UTC.",
  "Most of today's traffic is organic: google.com brings 41% of visitors, newsletter 12%.",
  "Your realtime peak this week was 214 visitors, Tuesday 20:40.",
];

/**
 * Floating glass tab bar, scoped to the selected site — icons only, with two
 * extra powers: an AI chat and a ⋯ quick-actions menu.
 *
 * Labels live in a single tooltip pill above the bar (one persistent element
 * that glides between icons and morphs its width). The chat and the menu open
 * *inline*: the tab row slides out and the new face slides in, one pill with
 * three faces. Sending a chat message grows the pill a second storey — the
 * transcript morphs open above the input while the bar's feet stay planted.
 */
export function TabBar() {
  const pathname = usePathname();
  const params = useParams<{ site?: string }>();
  /**
   * The live-presence dot on the Realtime tab rides the same SSE snapshot
   * the realtime page uses. Its own subscription on purpose: the bar is
   * mounted on every dashboard screen, most of which hold no stream of
   * their own, and the gateway's shared snapshot cache makes a second
   * subscriber cheap.
   */
  const slug = params.site ? decodeURIComponent(params.site) : "";
  const { snapshot, status } = useRealtime(slug);
  // Gated on a *healthy* stream: the hook keeps the last snapshot through
  // reconnects, and a dot lit by that stale count would claim presence the
  // stream can no longer vouch for. No connection, no dot.
  const liveVisitors =
    status === "live" ? (snapshot?.active_visitors ?? 0) : 0;
  const [hovered, setHovered] = React.useState<number | null>(null);
  /** The last hovered index — keeps the hidden pill's label stable so it
   *  can fade out (and back in) without a null to render. */
  const [tip, setTip] = React.useState(0);
  /** Centre of the hovered item, in the bar's own coordinate space. */
  const [anchorX, setAnchorX] = React.useState(0);
  const [dir, setDir] = React.useState(1);
  const itemRefs = React.useRef<(HTMLElement | null)[]>([]);

  /**
   * Whether this deployment has a model provider at all.
   *
   * Asked before the chat control is drawn, on the usage read the api already
   * serves. A self-hosted install with no `OPENAI_API_KEY` was offered a button
   * whose only outcome was an error — the api answered honestly the whole time,
   * nothing asked it. Optimistic while the answer is in flight, so the control
   * does not flicker from enabled to disabled on every deployment that has one.
   */
  const [assistantReady, setAssistantReady] = React.useState(true);
  React.useEffect(() => {
    if (!LIVE_API) return;
    let cancelled = false;
    assistant
      .usage()
      .then((usage) => {
        if (!cancelled) setAssistantReady(usage.available);
      })
      .catch(() => {
        // A failed read is not an answer. Leave the control as it is and let
        // the ask itself report the real problem.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * What the hover pill says. Every anchor but one is a fixed name; the chat
   * control's changes with the deployment, because an operator hovering a
   * dimmed button is asking exactly one question and this is where to answer
   * it.
   */
  const tipLabel =
    tip === CHAT_INDEX && !assistantReady
      ? "Add an OpenAI key in Settings"
      : TOOLTIP_LABELS[tip];

  const [surface, setSurface] = React.useState<Surface>("none");
  const filters = useAnalyticsFilters();
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [draft, setDraft] = React.useState("");
  const [thinking, setThinking] = React.useState(false);
  const replyTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The in-flight assistant turn, aborted when the surface closes. */
  const askController = React.useRef<AbortController | null>(null);

  /** The feedback face's own state: the message, and where the send stands. */
  const [feedback, setFeedback] = React.useState("");
  const [feedbackPhase, setFeedbackPhase] = React.useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const feedbackTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const { data: session } = useSession();

  /**
   * The globe's picked visitor — an avatar click on the map hands the
   * visitor over through the store, and the bar morphs open to present
   * them: the same measured-spring choreography the chat and menu faces
   * use. Microtask hop keeps the surface write out of the effect body.
   */
  const globeVisitor = React.useSyncExternalStore(
    subscribeGlobeVisitor,
    readGlobeVisitor,
    readGlobeVisitorServer
  );
  React.useEffect(() => {
    if (globeVisitor === null) return;
    void Promise.resolve().then(() => setSurface("visitor"));
  }, [globeVisitor]);
  const clockBucket = React.useSyncExternalStore(
    subscribeClock,
    readClockBucket,
    readClockBucketServer
  );

  /**
   * The bar's size is measured, not `layout`-animated: `layout` drives size
   * through scale transforms, which squash the corner radii and make the
   * transcript look like a separate rounded thing "joining" the bar mid-
   * animation. Springing real width/height keeps every corner crisp, and any
   * content change — a face swap, a reply landing — funnels through the same
   * spring.
   */
  const [box, setBox] = React.useState<{ width: number; height: number } | null>(
    null
  );
  /**
   * The size springs themselves. `jump` seeds them silently on the first
   * measurement (the bar must not animate into existence); every later
   * `set` — the first face-open included — springs, unconditionally.
   */
  const widthSpring = useSpring(0, { stiffness: 550, damping: 40 });
  const heightSpring = useSpring(0, { stiffness: 550, damping: 40 });
  const hadBox = React.useRef(false);
  React.useEffect(() => {
    if (!box) return;
    if (!hadBox.current) {
      hadBox.current = true;
      widthSpring.jump(box.width);
      heightSpring.jump(box.height);
      return;
    }
    widthSpring.set(box.width);
    heightSpring.set(box.height);
  }, [box, widthSpring, heightSpring]);

  const measureRef = React.useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const apply = () => {
      const rect = node.getBoundingClientRect();
      setBox({ width: rect.width, height: rect.height });
    };
    // Synchronous first measure (ref callbacks run in the commit phase,
    // like useLayoutEffect): ResizeObserver's initial delivery lands a
    // frame later, and while `box` is still null the bar's FIRST face
    // change applies its size instantly (`initial={false}` semantics)
    // instead of springing — the "More/AI Chat opens without animation
    // right after a refresh, fine afterwards" bug.
    apply();
    // Change measurements settle for one frame before they drive the
    // spring: on the very first face swap, popLayout takes a frame to lift
    // the exiting row into absolute positioning, so the container briefly
    // holds BOTH rows — measuring in that frame springs the bar toward a
    // bloated target and then yanks it back, which reads as a sharp jump.
    let frame = 0;
    const applySettled = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    };
    const observer = new ResizeObserver(applySettled);
    observer.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  /** Keeps the newest bubble in view once the transcript starts scrolling. */
  const scrollRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, thinking]);

  React.useEffect(
    () => () => {
      clearTimeout(replyTimer.current);
      clearTimeout(feedbackTimer.current);
    },
    []
  );

  // Escape backs out of whichever face is open.
  React.useEffect(() => {
    if (surface === "none") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSurface("none");
        setGlobeVisitor(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [surface]);

  if (!params.site) return null;
  const base = `/dashboard/${params.site}`;

  const enter = (index: number) => {
    const node = itemRefs.current[index];
    if (!node) return;
    if (hovered !== null && hovered !== index) {
      setDir(index > hovered ? 1 : -1);
    }
    setAnchorX(node.offsetLeft + node.offsetWidth / 2);
    setHovered(index);
    setTip(index);
  };

  /**
   * mouseenter never fires for an element that appears UNDER a resting
   * cursor (a face closing back to the tab row, a page loading with the
   * pointer already on the bar) — the tooltip stayed away until the pointer
   * left and returned. The first real movement catches it instead; the
   * guard keeps this a no-op while the item is already hovered.
   */
  const move = (index: number) => {
    if (hovered !== index) enter(index);
  };

  const close = () => {
    setSurface("none");
    setGlobeVisitor(null);
    setThinking(false);
    clearTimeout(replyTimer.current);
    clearTimeout(feedbackTimer.current);
    // Closing the chat aborts the generation (ADR-0046 D10): the server
    // stops paying for tokens nobody will read.
    askController.current?.abort();
    askController.current = null;
    setMessages([]);
    setDraft("");
    setFeedback("");
    setFeedbackPhase("idle");
  };

  /**
   * One POST to `/v1/notify` (ADR-0041): the server owns the recipient and
   * the allowlist; this sends the message plus two silent context fields —
   * the signed-in email so a reply has an address, and the page it was
   * written from. The honeypot is simply not sent, which reads as empty.
   *
   * The route is a hosted one — it needs a configured recipient and a
   * transactional sender — so where it is absent the face is not offered at
   * all and the menu links to the issue tracker instead. A form that posts
   * into nothing is worse than no form.
   */
  const sendFeedback = () => {
    const message = feedback.trim();
    if (message === "" || feedbackPhase === "sending" || feedbackPhase === "sent")
      return;
    setFeedbackPhase("sending");
    const email = LIVE_API ? session?.user.email : undefined;
    const name = LIVE_API ? session?.user.name : undefined;
    // The debugging context, gathered at send time: everything here is what
    // the person's own browser already knows, attached so "it looks broken"
    // arrives with the machine it looked broken on.
    const context: Record<string, string> = {
      page: pathname,
      user_agent: navigator.userAgent.slice(0, 500),
      viewport: `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
    };
    const request = LIVE_API && submitNotifyForm
      ? submitNotifyForm("feedback", {
          message,
          ...(email ? { email } : {}),
          ...(name ? { name } : {}),
          ...context,
        })
      : new Promise<unknown>((resolve) => setTimeout(() => resolve(null), 500));
    request.then(
      () => {
        setFeedbackPhase("sent");
        // A beat to read the thank-you, then the bar folds back to the tabs.
        feedbackTimer.current = setTimeout(close, 1400);
      },
      () => setFeedbackPhase("error")
    );
  };

  const send = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0 || thinking) return;
    setDraft("");
    // Deterministic ids for the two messages this turn creates, so the
    // streaming updater can find its bubble without mutating anything the
    // updater closes over (updaters must stay pure — StrictMode runs them
    // twice).
    const userId = messages.length;
    const aiId = userId + 1;
    setMessages((current) => [...current, { id: userId, role: "user", text }]);
    setThinking(true);

    if (!LIVE_API) {
      replyTimer.current = setTimeout(() => {
        setThinking(false);
        setMessages((current) => [
          ...current,
          {
            id: current.length,
            role: "ai",
            text: MOCK_REPLIES[current.filter((m) => m.role === "user").length % MOCK_REPLIES.length] ?? MOCK_REPLIES[0],
          },
        ]);
      }, 1100);
      return;
    }

    // The real thing (ADR-0046): the whole visible transcript is the payload
    // — the server stores no conversation — trimmed to the cap, ending with
    // the new question. Deltas stream into one growing bubble; the thinking
    // dots stand only until the first delta lands.
    const controller = new AbortController();
    askController.current = controller;
    const turns = [...messages, { id: userId, role: "user" as const, text }]
      .slice(-ASSISTANT_HISTORY_LIMIT)
      .map((message) => ({
        role: message.role === "ai" ? ("assistant" as const) : ("user" as const),
        content: message.text,
      }));

    assistant
      .ask(turns, {
        signal: controller.signal,
        onDelta: (chunk) => {
          setThinking(false);
          setMessages((current) =>
            current.some((message) => message.id === aiId)
              ? current.map((message) =>
                  message.id === aiId
                    ? { ...message, text: message.text + chunk }
                    : message
                )
              : [...current, { id: aiId, role: "ai", text: chunk }]
          );
        },
      })
      .then(
        () => {
          setThinking(false);
          askController.current = null;
        },
        (raised: unknown) => {
          // An aborted turn is the person closing the chat, not a failure.
          if (controller.signal.aborted) return;
          setThinking(false);
          askController.current = null;
          const reply =
            errorCodeOf(raised) === "RATE_LIMITED"
              ? "You have used up today's questions. They come back as the 24-hour window rolls on."
              : presentError(raised).body;
          setMessages((current) =>
            current.some((message) => message.id === aiId)
              ? current
              : [...current, { id: aiId, role: "ai", text: reply }]
          );
        }
      );
  };

  const showTooltip = hovered !== null && surface === "none";

  return (
    <nav
      aria-label="Dashboard"
      className="pointer-events-none fixed inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-50 flex justify-center px-4"
    >
      <div className="pointer-events-auto relative">
        {/* the label tooltip — one persistent pill that glides and morphs.
            ALWAYS mounted: showing and hiding is pure opacity/scale, never a
            mount/unmount — an AnimatePresence exit racing a re-enter could
            occasionally lose a hover and leave no pill at all. The -50%
            centring lives inside the motion transform: a Tailwind translate
            class would be overwritten the moment motion writes its own
            transform for y/scale. */}
        <motion.div
          animate={
            showTooltip
              ? { left: anchorX, x: "-50%", opacity: 1, scale: 1, y: 0 }
              : { left: anchorX, x: "-50%", opacity: 0, scale: 0.9, y: 4 }
          }
          aria-hidden={!showTooltip}
          className="pointer-events-none absolute bottom-full mb-2"
          initial={false}
          role="tooltip"
          transition={showTooltip ? SPRING : { duration: 0.12 }}
        >
          <motion.div
            className="overflow-hidden rounded-[12px] bg-[#1c1c1f] shadow-[0_1px_1px_rgba(0,0,0,0.3),0_8px_24px_rgba(0,0,0,0.35)] ring-1 ring-white/10"
            layout
            style={{ borderRadius: 12 }}
            transition={SPRING}
          >
            <AnimatePresence custom={dir} initial={false} mode="popLayout">
              <motion.span
                animate="center"
                className="block whitespace-nowrap px-3 py-[7px] text-[13px] font-medium text-white"
                custom={dir}
                exit="exit"
                initial="enter"
                key={tipLabel}
                transition={SPRING}
                variants={labelVariants}
              >
                {tipLabel}
              </motion.span>
            </AnimatePresence>
          </motion.div>
        </motion.div>

        {/* the bar — one surface with three faces, and a second storey when
            the chat has something to say. `box-content`, because the animated
            width/height come from measuring the inner content — with
            border-box sizing the 1px border would eat into it and clip.
            Size is driven by spring MotionValues, not the `animate` prop:
            with `initial={false}` the prop applies its first-ever change
            instantly, which snapped the very first face-open after a load. */}
        <motion.div
          // `justify-end` pins the content to the bar's floor: the bar sits
          // anchored to the viewport bottom, so while the height springs the
          // main row would otherwise slide up from underneath on every bubble.
          // Bottom-pinned, only the top edge moves — the row never does.
          className="relative box-content flex flex-col justify-end overflow-hidden rounded-3xl border border-[#8f8f8f]/25 bg-[#26262a] backdrop-blur-xl"
          onMouseLeave={() => setHovered(null)}
          style={box ? { width: widthSpring, height: heightSpring } : undefined}
        >
          <span
            aria-hidden="true"
            className="glass-noise pointer-events-none absolute inset-0 rounded-3xl opacity-60 mix-blend-overlay"
          />

          <div className="w-fit" ref={measureRef}>
          {/* the filter tray storey, same contract as the transcript: the
              storey fades, the measured springs grow. Overview only: the
              filters describe that screen and no other, and only while no
              face has taken the bar over, because a tray above the feedback sheet
              would be two unrelated storeys pretending to be one panel. */}
          <AnimatePresence initial={false}>
            {surface === "none" &&
            filters.active &&
            (pathname === base || pathname.startsWith(`${base}?`)) ? (
              <motion.div
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}
                initial={{ opacity: 0 }}
                key="filter-tray"
                transition={{ duration: 0.18 }}
              >
                <FilterTray />
              </motion.div>
            ) : null}
          </AnimatePresence>
          {/* the transcript storey — the container's measured spring does the
              growing; the storey itself only fades so nothing double-drives */}
          <AnimatePresence initial={false}>
            {surface === "chat" && (messages.length > 0 || thinking) ? (
              <motion.div
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}
                initial={{ opacity: 0 }}
                key="transcript"
                transition={{ duration: 0.18 }}
              >
                <div
                  className="flex max-h-64 w-[356px] flex-col gap-2 overflow-y-auto p-3 pb-2"
                  ref={scrollRef}
                >
                  {messages.map((message) => (
                    <motion.p
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      className={cn(
                        "max-w-[85%] whitespace-pre-wrap text-[13px] leading-5",
                        message.role === "user"
                          ? "self-end rounded-2xl rounded-br-md bg-primary px-3 py-1.5 text-white"
                          : "self-start rounded-2xl rounded-bl-md bg-white/10 px-3 py-1.5 text-white/90"
                      )}
                      initial={{ opacity: 0, y: 8, scale: 0.96 }}
                      key={message.id}
                      transition={SPRING}
                    >
                      {message.text}
                    </motion.p>
                  ))}
                  {thinking ? (
                    <motion.span
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-center gap-1 self-start rounded-2xl rounded-bl-md bg-white/10 px-3 py-2.5"
                      initial={{ opacity: 0, y: 8 }}
                      key="thinking"
                    >
                      {[0, 1, 2].map((dot) => (
                        <motion.span
                          animate={{ opacity: [0.25, 1, 0.25] }}
                          className="size-1.5 rounded-full bg-white/70"
                          key={dot}
                          transition={{
                            duration: 1,
                            repeat: Infinity,
                            delay: dot * 0.18,
                          }}
                        />
                      ))}
                    </motion.span>
                  ) : null}
                </div>
                <div className="mx-3 h-px bg-white/8" />
              </motion.div>
            ) : null}

            {/* the feedback storey — opens at the chat's full stature (same
                width, same measured-spring growth), a writing surface rather
                than a transcript */}
            {surface === "feedback" ? (
              <motion.div
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}
                initial={{ opacity: 0 }}
                key="feedback-sheet"
                transition={{ duration: 0.18 }}
              >
                <div className="w-[356px] p-3 pb-2">
                  <textarea
                    autoFocus
                    className="h-52 w-full resize-none bg-transparent text-[13px] leading-5 text-white outline-none placeholder:text-white/35"
                    disabled={
                      feedbackPhase === "sending" || feedbackPhase === "sent"
                    }
                    onChange={(event) => setFeedback(event.target.value)}
                    placeholder="Is something wrong, or is a feature missing? Let us know. We usually fix problems fast."
                    value={feedback}
                  />
                </div>
                <div className="mx-3 h-px bg-white/8" />
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* the main row: tabs, menu or chat input. `justify-center`
              matters only when a storey above is wider than the row (the
              filter tray with several chips): the block stretches to the
              storey's width and the tabs must hold the middle of the
              capsule, not its left edge. When the row is the widest child
              the centring is a no-op. */}
          <div className="flex items-center justify-center gap-1 p-1">
            <AnimatePresence custom={surface === "none" ? -1 : 1} initial={false} mode="popLayout">
              {surface === "none" ? (
                <motion.div
                  animate="center"
                  className="flex items-center gap-1"
                  custom={-1}
                  exit="exit"
                  initial="enter"
                  key="tabs"
                  transition={SPRING}
                  variants={rowVariants}
                >
                  {TABS.map((tab, index) => {
                    const href = `${base}${tab.segment}`;
                    const active =
                      tab.segment === ""
                        ? pathname === base
                        : pathname.startsWith(href);
                    return (
                      <Link
                        key={href}
                        href={href}
                        ref={(node) => {
                          itemRefs.current[index] = node;
                        }}
                        aria-current={active ? "page" : undefined}
                        aria-label={
                          tab.segment === "/realtime" && liveVisitors > 0
                            ? `${tab.label}: ${liveVisitors} live`
                            : tab.label
                        }
                        onBlur={() => setHovered(null)}
                        onFocus={(event) => {
                          // Keyboard focus only. A click focuses the link too,
                          // and the browser re-fires `focus` on the last-focused
                          // element every time the window regains focus — which
                          // popped the tooltip open on returning from another
                          // screen. `:focus-visible` is false for
                          // pointer-originated focus, so only real keyboard
                          // navigation opens it.
                          if (event.currentTarget.matches(":focus-visible")) {
                            enter(index);
                          }
                        }}
                        onMouseEnter={() => enter(index)}
                        onMouseMove={() => move(index)}
                        className={cn(
                          "relative flex items-center rounded-full p-[9px] outline-none",
                          "transition-colors duration-300 ease-out active:scale-95",
                          "focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "bg-white/10 text-white shadow-sm"
                            : "text-white/40 hover:bg-white/10 hover:text-white/70"
                        )}
                      >
                        <tab.icon
                          strokeWidth={2}
                          className={cn(
                            "size-[19px] shrink-0 transition-transform duration-300",
                            // Optical compensation, not a size change: the
                            // figure glyph reads smaller than its geometric
                            // neighbours (and Funnels draws ~6% past the
                            // shared glyph box), so the person gets a nudge.
                            // A single computed scale — stacking two scale
                            // utilities would leave the winner to stylesheet
                            // order.
                            tab.segment === "/realtime"
                              ? active
                                ? "scale-[1.14]"
                                : "scale-[1.08]"
                              : active && "scale-105"
                          )}
                        />
                        {/* live-presence dot: absolutely positioned so the
                            bar's geometry never changes; the bar-coloured
                            ring lifts it off the icon */}
                        <AnimatePresence>
                          {tab.segment === "/realtime" && liveVisitors > 0 ? (
                            <motion.span
                              key="live-dot"
                              aria-hidden="true"
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={SPRING}
                              className="absolute right-[5px] top-[5px] size-[6px] rounded-full bg-primary"
                            />
                          ) : null}
                        </AnimatePresence>
                      </Link>
                    );
                  })}

                  <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-white/10" />

                  {/* Drawn either way, dimmed and inert without a provider.
                      Hiding it would leave a self-hosted operator with no idea
                      the product has an assistant; a live button with nothing
                      behind it is worse. The hover pill carries the reason, so
                      the answer is where the question is asked. */}
                  <button
                    aria-disabled={!assistantReady}
                    aria-label={
                      assistantReady
                        ? "AI Chat"
                        : "AI Chat — add an OpenAI key in Settings to enable it"
                    }
                    className={cn(
                      "relative flex items-center rounded-full p-[9px] outline-none transition-colors duration-300 ease-out focus-visible:ring-2 focus-visible:ring-ring",
                      assistantReady
                        ? "cursor-pointer text-primary hover:bg-primary/15 active:scale-95"
                        : "cursor-not-allowed text-primary/35",
                    )}
                    onClick={() => {
                      if (!assistantReady) return;
                      setHovered(null);
                      setSurface("chat");
                    }}
                    onMouseEnter={() => enter(CHAT_INDEX)}
                    onMouseMove={() => move(CHAT_INDEX)}
                    ref={(node) => {
                      itemRefs.current[CHAT_INDEX] = node;
                    }}
                    type="button"
                  >
                    <AiChat02Icon className="size-[19px] shrink-0" strokeWidth={2} />
                  </button>

                  <button
                    aria-label="More"
                    className="relative flex cursor-pointer items-center rounded-full p-[9px] text-white/40 outline-none transition-colors duration-300 ease-out hover:bg-white/10 hover:text-white/70 focus-visible:ring-2 focus-visible:ring-ring active:scale-95"
                    onClick={() => {
                      setHovered(null);
                      setSurface("menu");
                    }}
                    onMouseEnter={() => enter(MORE_INDEX)}
                    onMouseMove={() => move(MORE_INDEX)}
                    ref={(node) => {
                      itemRefs.current[MORE_INDEX] = node;
                    }}
                    type="button"
                  >
                    <MoreHorizontalCircle02Icon className="size-[19px] shrink-0" strokeWidth={2} />
                  </button>
                </motion.div>
              ) : null}

              {surface === "menu" ? (
                <motion.div
                  animate="center"
                  className="flex items-center gap-1"
                  custom={1}
                  exit="exit"
                  initial="enter"
                  key="menu"
                  transition={SPRING}
                  variants={rowVariants}
                >
                  <button
                    aria-label="Back"
                    className="flex cursor-pointer items-center rounded-full p-[9px] text-white/40 outline-none transition-colors hover:bg-white/10 hover:text-white/70 focus-visible:ring-2 focus-visible:ring-ring active:scale-95"
                    onClick={close}
                    type="button"
                  >
                    <ArrowLeft01Icon className="size-[19px]" strokeWidth={2} />
                  </button>
                  <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-white/10" />
                  {/* Icons alone on a phone. Three labelled pills plus the back
                      button measure about 466px, which is wider than the
                      viewport they open in — the bar is centred, so the row
                      hung off both edges and the last action could not be
                      reached. A hidden label leaves the accessibility tree, so
                      each one carries its own `aria-label`; the name is the
                      same string either way, only the drawing changes. */}
                  {MENU_LINKS.map((item) => (
                    <Link
                      aria-label={item.label}
                      className={MENU_ITEM_CLASS}
                      href={`${base}/settings?tab=${item.tab}`}
                      key={item.label}
                      onClick={close}
                    >
                      <item.icon className="size-4 text-white/50" strokeWidth={2} />
                      <span className="hidden sm:inline">{item.label}</span>
                    </Link>
                  ))}
                  {submitNotifyForm ? (
                    <button
                      aria-label="Send Feedback"
                      className={MENU_ITEM_CLASS}
                      onClick={() => setSurface("feedback")}
                      type="button"
                    >
                      <Message01Icon className="size-4 text-white/50" strokeWidth={2} />
                      <span className="hidden sm:inline">Send Feedback</span>
                    </button>
                  ) : (
                    <a
                      aria-label="Report an issue"
                      className={MENU_ITEM_CLASS}
                      href={ISSUES_URL}
                      onClick={close}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <Message01Icon className="size-4 text-white/50" strokeWidth={2} />
                      <span className="hidden sm:inline">Report an issue</span>
                    </a>
                  )}
                </motion.div>
              ) : null}

              {surface === "visitor" && globeVisitor ? (
                <motion.div
                  animate="center"
                  className="flex items-center gap-2 py-0.5 pl-0 pr-0.5"
                  custom={1}
                  exit="exit"
                  initial="enter"
                  key={`visitor-${globeVisitor.hash}`}
                  transition={SPRING}
                  variants={rowVariants}
                >
                  <button
                    aria-label="Back"
                    className="flex cursor-pointer items-center rounded-full p-[9px] text-white/40 outline-none transition-colors hover:bg-white/10 hover:text-white/70 focus-visible:ring-2 focus-visible:ring-ring active:scale-95"
                    onClick={close}
                    type="button"
                  >
                    <ArrowLeft01Icon className="size-[19px]" strokeWidth={2} />
                  </button>
                  <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-white/10" />

                  <UserAvatar seed={globeVisitor.hash} size={30} />
                  <span className="flex min-w-0 flex-col pr-1 leading-tight">
                    <span className="whitespace-nowrap text-[13px] font-medium text-white">
                      {globeVisitor.name}
                    </span>
                    <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-white/50">
                      {globeVisitor.online ? (
                        <>
                          <span
                            aria-hidden="true"
                            className="bp-pulse size-1.5 rounded-full bg-success"
                          />
                          Online now
                        </>
                      ) : (
                        `Last seen ${lastSeenLabel(
                          Math.round(
                            (clockBucket * 10_000 - globeVisitor.lastSeenMs) /
                              1000
                          )
                        )}`
                      )}
                    </span>
                  </span>

                  {/* the realtime modal's tech marks, in the bar's dark dialect */}
                  <span className="flex items-center gap-1">
                    <MarkCircle className="size-7 bg-white/10">
                      <FlagIcon code={globeVisitor.country} className="size-4" />
                    </MarkCircle>
                    {globeVisitor.browser !== null ? (
                      <MarkCircle className="size-7 bg-white/10">
                        <BrowserIcon
                          family={globeVisitor.browser}
                          className="size-4 text-white/70"
                        />
                      </MarkCircle>
                    ) : null}
                    {globeVisitor.os !== null ? (
                      <MarkCircle className="size-7 bg-white/10">
                        <OSIcon
                          family={globeVisitor.os}
                          className="size-4 text-white/70"
                        />
                      </MarkCircle>
                    ) : (
                      <MarkCircle className="size-7 bg-white/10">
                        <DeviceGlyph
                          deviceType={globeVisitor.deviceType}
                          className="size-4 text-white/70"
                        />
                      </MarkCircle>
                    )}
                  </span>

                  <Link
                    className="ml-1 flex items-center whitespace-nowrap rounded-full bg-primary px-3.5 py-[7px] text-[13px] font-medium text-white outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-white/40 active:scale-95"
                    href={`${base}/realtime`}
                    onClick={close}
                  >
                    View user
                  </Link>
                </motion.div>
              ) : null}

              {surface === "feedback" ? (
                <motion.div
                  animate="center"
                  className="flex w-[356px] items-center gap-1.5"
                  custom={1}
                  exit="exit"
                  initial="enter"
                  key="feedback"
                  transition={SPRING}
                  variants={rowVariants}
                >
                  <button
                    aria-label="Back"
                    className="flex cursor-pointer items-center rounded-full p-[9px] text-white/40 outline-none transition-colors hover:bg-white/10 hover:text-white/70 focus-visible:ring-2 focus-visible:ring-ring active:scale-95"
                    onClick={close}
                    type="button"
                  >
                    <ArrowLeft01Icon className="size-[19px]" strokeWidth={2} />
                  </button>
                  <Message01Icon
                    className="ml-1 size-4 shrink-0 text-primary"
                    strokeWidth={2}
                  />
                  <span
                    aria-live="polite"
                    className={cn(
                      "min-w-0 flex-1 truncate text-[13px]",
                      feedbackPhase === "error"
                        ? "text-red-400"
                        : feedbackPhase === "sent"
                          ? "text-white/80"
                          : "text-white/35"
                    )}
                  >
                    {feedbackPhase === "error"
                      ? "Could not send. Try again."
                      : feedbackPhase === "sent"
                        ? "Thanks. It landed with us."
                        : "Feedback"}
                  </span>
                  <button
                    className="flex items-center whitespace-nowrap rounded-full bg-primary px-3.5 py-[7px] text-[13px] font-medium text-white outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-white/40 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
                    disabled={
                      feedback.trim() === "" ||
                      feedbackPhase === "sending" ||
                      feedbackPhase === "sent"
                    }
                    onClick={sendFeedback}
                    type="button"
                  >
                    {feedbackPhase === "sending"
                      ? "Sending…"
                      : feedbackPhase === "sent"
                        ? "Sent"
                        : "Send feedback"}
                  </button>
                </motion.div>
              ) : null}

              {surface === "chat" ? (
                <motion.form
                  animate="center"
                  className="flex items-center gap-1.5"
                  custom={1}
                  exit="exit"
                  initial="enter"
                  key="chat"
                  onSubmit={send}
                  transition={SPRING}
                  variants={rowVariants}
                >
                  <button
                    aria-label="Close chat"
                    className="flex cursor-pointer items-center rounded-full p-[9px] text-white/40 outline-none transition-colors hover:bg-white/10 hover:text-white/70 focus-visible:ring-2 focus-visible:ring-ring active:scale-95"
                    onClick={close}
                    type="button"
                  >
                    <ArrowLeft01Icon className="size-[19px]" strokeWidth={2} />
                  </button>
                  <AiChat02Icon
                    className="ml-1 size-4 shrink-0 text-primary"
                    strokeWidth={2}
                  />
                  <input
                    autoFocus
                    className="w-56 bg-transparent text-[13px] text-white outline-none placeholder:text-white/35"
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Ask about your traffic…"
                    value={draft}
                  />
                  <button
                    aria-label="Send"
                    className="flex size-[34px] cursor-pointer items-center justify-center rounded-full bg-primary text-white outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring active:scale-90 disabled:opacity-40"
                    disabled={draft.trim().length === 0 || thinking}
                    type="submit"
                  >
                    <SentIcon className="size-4" strokeWidth={2} />
                  </button>
                </motion.form>
              ) : null}
            </AnimatePresence>
          </div>
          </div>
        </motion.div>
      </div>
    </nav>
  );
}
