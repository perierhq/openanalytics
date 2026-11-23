"use client";

import * as React from "react";
import { ApiErrorPanel } from "@/components/dashboard/api-error";
import { MetaAdsSettingsForm, type MetaConnectInput } from "@/components/dashboard/meta-ads-settings-form";
import { SettingsPanel } from "@/components/dashboard/settings-panel";
import { SkeletonBar, SkeletonReveal } from "@/components/ui/skeleton-reveal";
import { useApiResource } from "@/hooks/use-api-resource";
import {
  ApiError,
  LIVE_API,
  metaAds,
  type MetaAdsConnectionState,
  type SiteSummary,
} from "@/lib/api";
import { canManageMetaAds } from "@/lib/meta-ads";
import { mockMetaAdsConnection } from "@/lib/mock";
import { useAction } from "@/lib/use-api";

/**
 * Settings → Integrations → Meta Ads: connect the site's Meta ad account so
 * the overview can show spend and ROAS per campaign (migration 0052).
 *
 * **Owner-only, gated on the role rather than on a probe.** The connection is
 * `revenue:read` like every revenue read, so an admin's or a viewer's read
 * would be a `403`; they get a sentence instead of a request that is bound to
 * fail.
 *
 * Every write is reflected only once the server confirms, and the panel then
 * re-reads, so fields the server owns (`next_sync_at`, a cleared error) are
 * never guessed.
 */
export function MetaAdsPanel({ site }: { site: SiteSummary }) {
  const canManage = canManageMetaAds(site.role);
  const [version, setVersion] = React.useState(0);

  const load = React.useCallback(async (): Promise<MetaAdsConnectionState> => {
    void version;
    if (!canManage) return { status: "not_connected" };
    if (!LIVE_API) return mockMetaAdsConnection();
    return metaAds.state(site.site_id);
  }, [canManage, site.site_id, version]);
  const resource = useApiResource(load);

  /** A mock-mode write stands in front of the fixture until the next read. */
  const [local, setLocal] = React.useState<MetaAdsConnectionState | null>(null);
  const state = local ?? (resource.status === "ready" ? resource.data : null);
  /** `PUT` is registered only with a credential keyring: a 404 says so. */
  const [unsupported, setUnsupported] = React.useState(false);

  const connect = useAction(async (input: MetaConnectInput) => {
    setUnsupported(false);
    if (!LIVE_API) {
      setLocal({
        status: "active",
        ad_account_id: input.adAccountId,
        ad_account_name: "Getopen Ads",
        ad_account_active: true,
        currency: "USD",
        token_last4: input.token.slice(-4),
        connected_at: new Date().toISOString(),
        last_attempted_at: null,
        last_synced_at: null,
        next_sync_at: new Date().toISOString(),
        last_error: null,
      });
      return;
    }
    try {
      await metaAds.connect(site.site_id, {
        ad_account_id: input.adAccountId,
        access_token: input.token,
      });
    } catch (raised) {
      if (raised instanceof ApiError && raised.status === 404) {
        setUnsupported(true);
        return;
      }
      throw raised;
    }
    setVersion((n) => n + 1);
  });

  const disconnect = useAction(async () => {
    if (!LIVE_API) {
      setLocal({ status: "not_connected" });
      return;
    }
    try {
      await metaAds.disconnect(site.site_id);
    } catch (raised) {
      // Already gone is the state this button exists to reach.
      if (!(raised instanceof ApiError && raised.status === 404)) throw raised;
    }
    setVersion((n) => n + 1);
  });

  return (
    <SettingsPanel title="Meta Ads">
      <SkeletonReveal
        ready={resource.status !== "loading" || local !== null}
        skeleton={
          <div className="flex flex-col gap-3 p-5">
            <SkeletonBar className="h-10 w-full rounded-lg" />
            <SkeletonBar className="h-24 w-full rounded-lg" />
            <SkeletonBar className="h-4 w-40 rounded-md" />
          </div>
        }
      >
        {resource.status === "error" && local === null ? (
          <ApiErrorPanel error={resource.error} onRetry={resource.retry} />
        ) : state ? (
          <MetaAdsSettingsForm
            busy={connect.busy || disconnect.busy}
            canManage={canManage}
            error={connect.error ?? disconnect.error}
            onConnect={(input) => connect.run(input)}
            onDisconnect={() => disconnect.run()}
            state={state}
            unsupported={unsupported}
          />
        ) : null}
      </SkeletonReveal>
    </SettingsPanel>
  );
}
