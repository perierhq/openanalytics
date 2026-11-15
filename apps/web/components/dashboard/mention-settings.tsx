"use client";

import * as React from "react";
import { ApiErrorPanel } from "@/components/dashboard/api-error";
import { SettingsPanel } from "@/components/dashboard/settings-panel";
import { SkeletonBar, SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { useApiResource } from "@/hooks/use-api-resource";
import {
  LIVE_API,
  mentionSettings,
  type SiteMentionSettings,
  type SiteSummary,
  type UpdateSiteMentionSettings,
} from "@/lib/api";
import { mockMentionSettings } from "@/lib/mock";
import { canEditMentions } from "@/lib/mentions";
import { useAction } from "@/lib/use-api";
import { MentionSettingsForm } from "@/components/dashboard/mention-settings-form";

/**
 * Settings → Integrations → Mentions: whether the site watches X for posts
 * that mention it, and the extra terms it searches for.
 *
 * The copy says exactly what leaves the install, because this is the one
 * integration that sends something of the site's outward on a schedule: the
 * domain and the terms, on every check, and nothing about visitors.
 *
 * Every change saves the moment it is made, like the revenue mode above it,
 * and is reflected only once the server confirms. A viewer sees the same
 * block with its controls disabled: `PATCH` is owner or admin, and finding
 * that out through a `403` on the first click is worse than a control that
 * was never live.
 */

/** The anchor the Mentions tab's empty state links to. */
export const MENTION_SETTINGS_ANCHOR = "mentions";

export function MentionsPanel({ site }: { site: SiteSummary }) {
  const canEdit = canEditMentions(site.role);

  const load = React.useCallback(async (): Promise<SiteMentionSettings> => {
    if (!LIVE_API) return mockMentionSettings(site.domains[0] ?? site.name);
    return mentionSettings.get(site.site_id);
  }, [site.site_id, site.domains, site.name]);
  const resource = useApiResource(load);

  /**
   * The Mentions tab links here as `?tab=integrations#mentions`. The browser
   * scrolls to a hash only on load, and this block mounts after the board has
   * picked its tab, so it brings itself into view once its content is there.
   */
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const ready = resource.status !== "loading";
  React.useEffect(() => {
    if (!ready) return;
    if (window.location.hash !== `#${MENTION_SETTINGS_ANCHOR}`) return;
    anchorRef.current?.scrollIntoView({ block: "start" });
  }, [ready]);

  /** The last confirmed write, standing in front of the read it replaced. */
  const [confirmed, setConfirmed] = React.useState<SiteMentionSettings | null>(
    null
  );
  const settings =
    confirmed ?? (resource.status === "ready" ? resource.data : null);

  const write = useAction(async (body: UpdateSiteMentionSettings) => {
    if (!settings) return;
    const next = LIVE_API
      ? await mentionSettings.update(site.site_id, body)
      : { ...settings, ...body };
    setConfirmed(next);
  });

  return (
    <div id={MENTION_SETTINGS_ANCHOR} className="scroll-mt-6" ref={anchorRef}>
      <SettingsPanel title="Mentions">
        <SkeletonReveal
          ready={resource.status !== "loading"}
          skeleton={
            <div className="flex flex-col gap-3 p-5">
              <SkeletonBar className="h-12 w-full rounded-lg" />
              <SkeletonBar className="h-20 w-full rounded-lg" />
              <SkeletonBar className="h-4 w-32 rounded-md" />
            </div>
          }
        >
          {resource.status === "error" ? (
            <ApiErrorPanel error={resource.error} onRetry={resource.retry} />
          ) : settings ? (
            <MentionSettingsForm
              busy={write.busy}
              canEdit={canEdit}
              error={write.error}
              onTermsChange={(terms) => write.run({ terms })}
              onToggle={(x_enabled) => write.run({ x_enabled })}
              settings={settings}
            />
          ) : null}
        </SkeletonReveal>
      </SettingsPanel>
    </div>
  );
}
