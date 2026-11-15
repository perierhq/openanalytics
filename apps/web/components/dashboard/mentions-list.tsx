"use client";

import Link from "next/link";
import * as React from "react";
import { ApiErrorPanel } from "@/components/dashboard/api-error";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { MENTION_SETTINGS_ANCHOR } from "@/components/dashboard/mention-settings";
import { MentionRow } from "@/components/dashboard/mention-row";
import { Button } from "@/components/ui/button";
import { SkeletonBar } from "@/components/ui/skeleton-reveal";
import { useApiResource } from "@/hooks/use-api-resource";
import {
  ApiError,
  LIVE_API,
  mentionSettings,
  mentions,
  presentError,
  type Mention,
  type SiteMentionSettings,
  type SiteSummary,
} from "@/lib/api";
import { MOCK_MENTIONS, mockMentionSettings } from "@/lib/mock";
import { canEditMentions } from "@/lib/mentions";

/**
 * The posts that mention the site in the screen's range, newest first.
 *
 * Paged the way the revenue transactions are: the cursor is opaque and passed
 * back as received, and a cursor the server refuses restarts the list once,
 * visibly, instead of looping.
 *
 * The empty state depends on the settings: with watching off there is nothing
 * to wait for, and the screen says how to turn it on (or who can). Posts found
 * while it was on are kept after it is turned off, so a list can be full with
 * watching off, and the screen says that too.
 */

type Page = {
  items: Mention[];
  cursor: string | null;
  hasMore: boolean;
};

export function MentionsList({ site, slug }: { site: SiteSummary; slug: string }) {
  const { range, rangePending } = useAnalyticsInterval();
  const canEdit = canEditMentions(site.role);

  const loadSettings = React.useCallback(async (): Promise<SiteMentionSettings> => {
    if (!LIVE_API) return mockMentionSettings(site.domains[0] ?? site.name);
    return mentionSettings.get(site.site_id);
  }, [site.site_id, site.domains, site.name]);
  const settings = useApiResource(loadSettings);

  const [page, setPage] = React.useState<Page>({
    cursor: null,
    hasMore: false,
    items: [],
  });
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [error, setError] = React.useState<ReturnType<typeof presentError> | null>(
    null
  );
  const [busy, setBusy] = React.useState(false);
  /** Bumped to start over after a refused cursor; see the revenue list. */
  const [generation, setGeneration] = React.useState(0);

  const load = React.useCallback(
    async (cursor: string | null) => {
      setBusy(true);
      try {
        const response = LIVE_API
          ? await mentions.list(site.site_id, range, cursor ? { cursor } : {})
          : { items: MOCK_MENTIONS, next_cursor: null, has_more: false };
        setPage((current) => ({
          cursor: response.next_cursor,
          hasMore: response.has_more,
          items: cursor ? [...current.items, ...response.items] : response.items,
        }));
        setStatus("ready");
        setError(null);
      } catch (raised) {
        const badCursor =
          raised instanceof ApiError &&
          raised.code === "VALIDATION_FAILED" &&
          cursor !== null;
        if (badCursor) {
          setBusy(false);
          setGeneration((current) => current + 1);
          return;
        }
        setError(presentError(raised));
        setStatus("error");
      }
      setBusy(false);
    },
    [site.site_id, range]
  );

  React.useEffect(() => {
    if (rangePending) return;
    // Deferred a tick: the reset is several setState calls, and an effect
    // body may not make them synchronously.
    const timer = setTimeout(() => {
      setStatus("loading");
      setPage({ cursor: null, hasMore: false, items: [] });
      void load(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [load, generation, rangePending]);

  if (status === "error" && error) {
    return <ApiErrorPanel error={error} onRetry={() => void load(null)} />;
  }

  const watching = settings.status === "ready" ? settings.data.x_enabled : null;
  const domain =
    settings.status === "ready" ? settings.data.domain : (site.domains[0] ?? site.name);
  const settingsHref = `/dashboard/${encodeURIComponent(slug)}/settings?tab=integrations#${MENTION_SETTINGS_ANCHOR}`;

  if (status === "loading" || (page.items.length === 0 && settings.status === "loading")) {
    return <MentionsSkeleton />;
  }

  if (page.items.length === 0) {
    if (watching === false) {
      return (
        <div className="flex flex-col items-center gap-3 px-1 py-8 text-center">
          <p className="max-w-md text-sm leading-6 text-muted-foreground">
            {canEdit
              ? `Watching X for mentions is off. Turn it on and posts that mention ${domain} show up here.`
              : `Watching X for mentions is off. An owner or admin can turn it on in Settings.`}
          </p>
          {canEdit ? (
            <Button render={<Link href={settingsHref} />} size="sm" variant="secondary">
              Open mention settings
            </Button>
          ) : null}
        </div>
      );
    }
    return (
      <p className="px-1 py-8 text-center text-sm text-muted-foreground">
        No mentions found in this period. New posts are checked about every hour.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {watching === false ? (
        <p className="pt-2 text-xs leading-5 text-muted-foreground">
          Watching is off, so no new posts are being found.{" "}
          {canEdit ? (
            <Link
              className="rounded-sm underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              href={settingsHref}
            >
              Turn it on
            </Link>
          ) : (
            "An owner or admin can turn it on."
          )}
        </p>
      ) : null}

      <ul className="flex flex-col divide-y divide-border">
        {page.items.map((mention) => (
          <MentionRow domain={domain} key={mention.id} mention={mention} />
        ))}
      </ul>

      {page.hasMore ? (
        <Button
          className="mb-2 self-center"
          disabled={busy}
          onClick={() => void load(page.cursor)}
          size="sm"
          variant="secondary"
        >
          {busy ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}

/** Three rows at the real row's size, so the list does not jump when it lands. */
function MentionsSkeleton() {
  return (
    <ul aria-busy="true" aria-label="Loading mentions" className="flex flex-col divide-y divide-border">
      {[0, 1, 2].map((row) => (
        <li className="flex gap-3 py-3" key={row}>
          <SkeletonBar className="size-9 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
            <SkeletonBar className="h-3.5 w-48 rounded-md" />
            <SkeletonBar className="h-3.5 w-full rounded-md" />
            <SkeletonBar className="h-3.5 w-2/3 rounded-md" />
          </div>
        </li>
      ))}
    </ul>
  );
}
