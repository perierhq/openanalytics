"use client";

import * as React from "react";
import { ApiErrorPanel } from "@/components/dashboard/api-error";
import {
  ExclusionsForm,
  ExclusionsViewerNotice,
} from "@/components/dashboard/exclusions-form";
import { SettingsPanel } from "@/components/dashboard/settings-panel";
import { SkeletonBar, SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { useApiResource } from "@/hooks/use-api-resource";
import {
  ingestSettings,
  LIVE_API,
  type SiteIngestSettings,
  type SiteSummary,
} from "@/lib/api";
import { canEditExclusions, type ExclusionLists } from "@/lib/exclusions";
import { mockIngestSettings } from "@/lib/mock";
import { useAction } from "@/lib/use-api";

/**
 * Settings → General → Exclusions: addresses, pages, countries and hosts
 * whose visits the site does not count. The collector drops them before
 * anything is stored; this block is where the lists are kept.
 *
 * It sits under Project settings because it is the same kind of decision as
 * the origin allowlist there — which traffic this site's numbers are made
 * of — even though it is stored with the ingest settings rather than the site.
 *
 * Every add and remove saves the moment it is made, like the mention terms,
 * and is reflected only once the server confirms. The server replaces all
 * four lists on each write, so each save sends the whole set.
 */
export function ExclusionsPanel({
  site,
  revealed,
}: {
  site: SiteSummary;
  /** The tab's shared reveal gate, so this card does not land on its own. */
  revealed: boolean;
}) {
  const canEdit = canEditExclusions(site.role);

  return (
    <SettingsPanel title="Exclusions">
      {canEdit ? (
        <ExclusionsEditor revealed={revealed} siteId={site.site_id} />
      ) : (
        <SkeletonReveal ready={revealed} skeleton={<ExclusionsSkeleton />}>
          <ExclusionsViewerNotice />
        </SkeletonReveal>
      )}
    </SettingsPanel>
  );
}

function ExclusionsEditor({
  siteId,
  revealed,
}: {
  siteId: string;
  revealed: boolean;
}) {
  const load = React.useCallback(async (): Promise<SiteIngestSettings> => {
    if (!LIVE_API) return mockIngestSettings();
    return ingestSettings.get(siteId);
  }, [siteId]);
  const resource = useApiResource(load);

  /** The last confirmed write, standing in front of the read it replaced. */
  const [confirmed, setConfirmed] = React.useState<SiteIngestSettings | null>(
    null
  );
  const settings =
    confirmed ?? (resource.status === "ready" ? resource.data : null);

  const write = useAction(async (exclusions: ExclusionLists) => {
    if (!settings) return;
    const next = LIVE_API
      ? await ingestSettings.update(siteId, { exclusions })
      : { ...settings, exclusions };
    setConfirmed(next);
  });

  return (
    <SkeletonReveal
      ready={revealed && resource.status !== "loading"}
      skeleton={<ExclusionsSkeleton />}
    >
      {resource.status === "error" ? (
        <ApiErrorPanel error={resource.error} onRetry={resource.retry} />
      ) : settings ? (
        <ExclusionsForm
          busy={write.busy}
          canEdit
          countryActive={settings.exclusions_country_active}
          error={write.error}
          exclusions={settings.exclusions}
          onChange={(next) => write.run(next)}
        />
      ) : null}
    </SkeletonReveal>
  );
}

function ExclusionsSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-5">
      <SkeletonBar className="h-20 w-full rounded-lg" />
      <SkeletonBar className="h-20 w-full rounded-lg" />
      <SkeletonBar className="h-20 w-full rounded-lg" />
      <SkeletonBar className="h-20 w-full rounded-lg" />
    </div>
  );
}
