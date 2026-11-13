import {
  ApiError,
  isErrorCode,
  isRetryableErrorCode,
  OpenAnalyticsClient,
  type components,
  type ErrorCode,
  type operations,
  type RequestOptions,
} from "@openanalytics/contracts";

/**
 * The only backend surface `apps/web` is allowed to touch is the generated
 * contracts package (D-218, CI-enforced). Everything below is a thin, typed
 * shell over it — no response shapes are re-declared here.
 */

/**
 * The three service origins this browser talks to, and the one place they are
 * named.
 *
 * Deployment configuration with **no default**, deliberately. They used to
 * fall back to our own hosts, which is fine right up until somebody else runs
 * this build: their dashboard would then read our api, their tracker would
 * post events to our collector, and nothing on screen would say so. An empty
 * value makes every call relative, which fails on the first request instead of
 * succeeding against the wrong deployment.
 *
 * `NEXT_PUBLIC_*` is inlined at build time — set them for the build, not for
 * the container.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
export const REALTIME_BASE_URL = process.env.NEXT_PUBLIC_REALTIME_URL ?? "";
/** The collector host — serves the tracker bundle and takes events (ADR-0020). */
export const COLLECTOR_BASE_URL = process.env.NEXT_PUBLIC_COLLECTOR_URL ?? "";

/**
 * One switch between the mock data every screen was built on and the live api.
 *
 * **Live is the default, and mock is what you opt into.** It used to be the
 * other way around (`NEXT_PUBLIC_LIVE_API=1` turned live on), and on
 * 2026-07-26 that variable went missing from a production build: the deployed
 * app quietly became a demo — fake numbers, and `SessionGate` standing aside so
 * `/dashboard` opened for anyone, with nothing on the page saying so.
 *
 * A forgotten variable has to fail towards the safe side. Forgetting this one
 * now costs a designer their local fixtures; forgetting the old one exposed an
 * unguarded dashboard to the internet.
 *
 * Set `NEXT_PUBLIC_MOCK_API=1` in `.env.local` to work against the fixtures
 * with no api behind them.
 */
export const LIVE_API = process.env.NEXT_PUBLIC_MOCK_API !== "1";

/** Auth cookies are host-only on the api host, so every call includes them. */
export const api = new OpenAnalyticsClient({
  baseUrl: API_BASE_URL,
  credentials: "include",
});

/* Schema aliases — the screens import these, never the raw generic path. */

export type Schemas = components["schemas"];
export type SiteSummary = Schemas["SiteSummary"];
/**
 * A row of `GET /v1/sites`: the summary plus the card figures (ADR-0080).
 *
 * `all_time`/`sparkline` are `null` when the figures could not be computed for
 * that response — never the same thing as zero, which is a real measurement.
 */
export type SiteListItem = Schemas["SiteListItem"];
export type SiteCardTotals = Schemas["SiteCardTotals"];
export type SiteCardRevenue = Schemas["SiteCardRevenue"];
export type SiteRole = Schemas["SiteRole"];
export type SiteStatus = Schemas["SiteStatus"];
export type SiteMember = Schemas["SiteMember"];
export type SiteInvite = Schemas["SiteInvite"];
export type CreatedSite = Schemas["CreatedSite"];
export type ApiKeySummary = Schemas["ApiKeySummary"];
export type ApiKeyType = Schemas["ApiKeyType"];
export type ApiKeyScope = Schemas["ApiKeyScope"];
export type CreatedApiKey = Schemas["CreatedApiKey"];
export type PublicDashboardSettings = Schemas["PublicDashboardSettings"];
export type SiteIngestSettings = Schemas["SiteIngestSettings"];
export type UpdateSiteIngestSettings =
  Schemas["UpdateSiteIngestSettingsRequest"];
export type AnalyticsMeta = Schemas["AnalyticsMeta"];
export type AnalyticsFreshness = Schemas["AnalyticsFreshness"];
export type FreshnessState = Schemas["FreshnessState"];
export type AnalyticsOverviewResponse = Schemas["AnalyticsOverviewResponse"];
export type PublicGeographyResponse = Schemas["PublicGeographyResponse"];
export type AcceptedInvite = Schemas["AcceptedInvite"];
export type SiteResolution = Schemas["SiteResolution"];
export type OverviewTotals = Schemas["OverviewTotals"];
export type AnalyticsTimeseriesResponse = Schemas["AnalyticsTimeseriesResponse"];
export type TimeseriesPoint = Schemas["TimeseriesPoint"];
export type AnalyticsPagesResponse = Schemas["AnalyticsPagesResponse"];
export type PageRow = Schemas["PageRow"];
export type AnalyticsSourcesResponse = Schemas["AnalyticsSourcesResponse"];
export type SourceRow = Schemas["SourceRow"];
export type AnalyticsGeographyResponse = Schemas["AnalyticsGeographyResponse"];
export type GeographyRow = Schemas["GeographyRow"];
export type AnalyticsDevicesResponse = Schemas["AnalyticsDevicesResponse"];
export type DeviceRow = Schemas["DeviceRow"];
/** `AnalyticsSessionsResponse` minus `layering` — the public share shape. */
export type PublicSessionsResponse = Schemas["PublicSessionsResponse"];
/** `AnalyticsOverviewResponse` with narrow totals and no `comparison` —
 * the public route never asked for a comparison period, so that field was
 * structurally `null` on every response it sent. */
export type PublicOverviewResponse = Schemas["PublicOverviewResponse"];
/**
 * Every public read's meta (D-213, ADR-0039 D10): the private meta **minus
 * `freshness`** — its watermark told any visitor to the minute when the site
 * last had traffic, which is the owner's fact, not the public's. A separate
 * schema rather than a filtered one, so the public shape is structurally
 * incapable of carrying the field. Screens must treat missing freshness as
 * "nothing to caveat", never as an error.
 */
export type PublicAnalyticsMeta = Schemas["PublicAnalyticsMeta"];
/**
 * The public site-identity read (ADR-0044). Two rendering facts always
 * (`reporting_timezone`, `first_event_at`); `display_name` and
 * `favicon_domain` exist on the object **only when the owner opted
 * `share_identity` in** — absent, never `null`, so an anonymous share cannot
 * be rendered as a site with an empty name.
 */
export type PublicSiteIdentity = Schemas["PublicSiteIdentity"];
export type PublicTimeseriesResponse = Schemas["PublicTimeseriesResponse"];
export type PublicPagesResponse = Schemas["PublicPagesResponse"];
export type PublicSourcesResponse = Schemas["PublicSourcesResponse"];
export type PublicDevicesResponse = Schemas["PublicDevicesResponse"];
export type AnalyticsCustomEventsResponse = Schemas["AnalyticsCustomEventsResponse"];
export type CustomEventRow = Schemas["CustomEventRow"];
export type AnalyticsPerformanceResponse = Schemas["AnalyticsPerformanceResponse"];
export type PerformanceRow = Schemas["PerformanceRow"];
export type RealtimeTokenResponse = Schemas["RealtimeTokenResponse"];
export type AnalyticsRecentVisitorsResponse =
  Schemas["AnalyticsRecentVisitorsResponse"];
export type RecentVisitor = Schemas["RecentVisitor"];
export type AnalyticsVisitorResponse = Schemas["AnalyticsVisitorResponse"];
export type VisitorSession = Schemas["VisitorSession"];
/**
 * The owner-only revenue marker on visitor rows and the trail (ADR-0036 CP7).
 * Optional *by absence*: for a non-owner it never arrives — not `0`, because
 * `0` is a claim about the business — and for an owner a missing marker means
 * "no attributed revenue in this window". Render on presence; never probe.
 */
export type VisitorRevenue = Schemas["VisitorRevenue"];
export type Resolution = Schemas["Resolution"];
export type UserPreferences = Schemas["UserPreferences"];
export type ConnectedApp = Schemas["ConnectedApp"];
export type ConnectedAppList = Schemas["ConnectedAppList"];
export type FunnelDefinition = Schemas["FunnelDefinition"];
export type FunnelScope = FunnelDefinition["scope"];

/* Widgets (M15, ADR-0045). */
export type Widget = Schemas["Widget"];
export type WidgetSurface = Schemas["WidgetSurface"];
export type WidgetRange = Schemas["WidgetRange"];

/* Custom event definitions (M13, ADR-0034). */
export type EventDefinition = Schemas["EventDefinition"];
export type EventDefinitionVersion = Schemas["EventDefinitionVersion"];
export type EventDefinitionContent = Schemas["EventDefinitionContent"];
export type EventPropertyEntry = Schemas["EventDefinitionPropertySchemaEntry"];
export type EventPropertyType = EventPropertyEntry["type"];
export type NoCodeRule = Schemas["NoCodeRule"];
export type NoCodeRuleProperty = Schemas["NoCodeRuleProperty"];
export type NoCodeRuleTrigger = NoCodeRule["trigger"];
export type NoCodePropertySource = NoCodeRuleProperty["source"];
export type AnalyticsFunnelResponse = Schemas["AnalyticsFunnelResponse"];
export type FunnelStep = Schemas["FunnelStep"];
export type InviteResent = Schemas["InviteResent"];
export type InviteStatus = SiteInvite["status"];
export type AuthProvider = Schemas["AuthProvider"];
export type AnalyticsSessionsResponse = Schemas["AnalyticsSessionsResponse"];
export type SiteDeletionAccepted = Schemas["SiteDeletionAccepted"];
export type AccountDeletionAccepted = Schemas["AccountDeletionAccepted"];
export type AccountDeletionBlockingSite =
  Schemas["AccountDeletionBlockingSite"];
export type ImportProvider = Schemas["ImportProvider"];
export type ImportRun = Schemas["ImportRun"];
export type ImportRunPhase = Schemas["ImportRunPhase"];
export type ImportRunStatus = Schemas["ImportRunStatus"];
export type ImportRunSummary = Schemas["ImportRunSummary"];
export type ImportUploadTarget = Schemas["ImportUploadTarget"];
export type CreateImportResponse = Schemas["CreateImportResponse"];
export type ExportRun = Schemas["ExportRun"];
export type ExportPhase = ExportRun["phase"];
export type ExportManifestSummary = Schemas["ExportManifestSummary"];
export type ExportDownload = Schemas["ExportDownload"];
export type ExportDownloadFile = Schemas["ExportDownloadFile"];
export type DataSource = AnalyticsMeta["data_sources"][number];
export type AnalyticsAccuracy = AnalyticsMeta["accuracy"];

/* Revenue (M12, ADR-0033). */
export type ReportingCurrency = Schemas["ReportingCurrency"];
export type RevenueProvider = Schemas["RevenueProvider"];
export type RevenueConnection = Schemas["RevenueConnection"];
export type RevenueNotConnected = Schemas["RevenueNotConnected"];
/** What `GET .../revenue/connection` answers: a connection, or the absence. */
export type RevenueConnectionState = RevenueConnection | RevenueNotConnected;
export type RevenueConnectionStatus = Schemas["RevenueConnectionStatus"];
/**
 * The connection facts that ride on an analytics response, not a revenue one.
 *
 * It is what decides the Revenue card's empty state, and it arrives on reads
 * the dashboard already makes — so "is a provider connected" costs no request
 * of its own (frontend_tasks §23).
 */
export type RevenueConnectionMeta = Schemas["RevenueConnectionMeta"];
export type RevenueTotals = Schemas["RevenueTotals"];
export type RevenueUnconvertedCurrency = Schemas["RevenueUnconvertedCurrency"];
export type RevenueSummaryResponse = Schemas["RevenueSummaryResponse"];
export type RevenueTimeseriesPoint = Schemas["RevenueTimeseriesPoint"];
export type RevenueTimeseriesResponse = Schemas["RevenueTimeseriesResponse"];
export type RevenueTransaction = Schemas["RevenueTransaction"];
/** Subscription lifecycle (Perier fork, gap 7). Owner-only, like the money. */
export type SubscriptionTotals = Schemas["SubscriptionTotals"];
export type SubscriptionSummaryResponse = Schemas["SubscriptionSummaryResponse"];
export type SubscriptionTimeseriesPoint = Schemas["SubscriptionTimeseriesPoint"];
export type SubscriptionTimeseriesResponse =
  Schemas["SubscriptionTimeseriesResponse"];
export type RevenueTransactionsResponse = Schemas["RevenueTransactionsResponse"];
export type RevenueMatchedVia = Schemas["RevenueMatchedVia"];
export type RevenueMatchConfidence = Schemas["RevenueMatchConfidence"];
export type RevenueIdentityScope = Schemas["RevenueIdentityScope"];
export type RevenueJourneyResponse = Schemas["RevenueJourneyResponse"];
export type RevenueJourneyEntry = Schemas["RevenueJourneyEntry"];
export type RevenueJourneyDisplay = Schemas["RevenueJourneyDisplay"];
export type RevenueTouch = Schemas["RevenueTouch"];
/** Revenue charts take hour or day only — not the traffic chart's picker. */
export type RevenueResolution = "hour" | "day";

/** The list endpoint wraps its rows; the shape comes from the operation. */
export type SiteListResponse =
  operations["listSites"]["responses"][200]["content"]["application/json"];

/**
 * The install snippet, verbatim from docs/frontend/tracker_snippet.md.
 * `async` is deliberate — the tracker records the first pageview immediately
 * and folds the site's config in afterwards, so the config round-trip never
 * costs a fast bounce. `data-key` is the site's `tracking_write` public token:
 * write-only, public by design.
 */
export function trackerSnippet(publicToken: string): string {
  return `<script\n  async\n  src="${COLLECTOR_BASE_URL}/oa.js"\n  data-key="${publicToken}"\n  data-collector="${COLLECTOR_BASE_URL}"\n></script>`;
}

/* Requests ---------------------------------------------------------------- */

/**
 * The generated client only speaks GET; mutations go through this. Same
 * envelope discipline: a non-2xx with the canonical `ErrorEnvelope` becomes an
 * `ApiError` carrying the code, anything else is infrastructure failure.
 */
export async function send<T>(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {}
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    credentials: "include",
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });

  const text = await response.text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    const envelope = parsed as {
      error?: { code?: string; message?: string; details?: unknown };
    } | null;
    const code = envelope?.error?.code;
    if (code && isErrorCode(code)) {
      throw new ApiError(code, envelope?.error?.message ?? code, {
        status: response.status,
        details: (envelope?.error?.details ?? {}) as Record<string, unknown>,
      });
    }
    throw new ApiError(
      "SERVICE_UNAVAILABLE",
      `unexpected ${response.status} response`,
      { status: response.status, expose: false }
    );
  }

  return parsed as T;
}

/* Endpoints — one function per operation the screens use. ------------------ */

export const sites = {
  list: () => api.get<{ items: SiteListItem[] }>("/v1/sites"),
  resolve: (slug: string) =>
    api.get<SiteResolution>(
      `/v1/sites/resolve?slug=${encodeURIComponent(slug)}`
    ),
  get: (siteId: string) => api.get<SiteSummary>(`/v1/sites/${siteId}`),
  /**
   * `Idempotency-Key` makes a timed-out create safe to retry: mint one key per
   * attempt and reuse it for every retry of that attempt.
   */
  create: (body: { slug: string; name: string }, idempotencyKey: string) =>
    send<CreatedSite>("POST", "/v1/sites", { body, idempotencyKey }),
  /**
   * `reporting_currency` joins `name` and `domains` here (M12, §26): it is a
   * `site:settings` write, so owner *and* admin — an admin who may already
   * replace the origin allowlist is trusted with the label the numbers are
   * denominated in, while reading those numbers stays owner-only.
   *
   * `reporting_timezone` (ADR-0044, ADR-0079 D5) rides the same PATCH under the
   * same scope, and an IANA name is the only thing it takes: the server refuses
   * offsets like `+05:00` with a `400`, because an offset is a timezone
   * evaluated at one instant, and it refuses `null` too — every site has a
   * clock, and a reader who wants their own picks it from the header pill.
   */
  update: (
    siteId: string,
    body: {
      name?: string;
      domains?: string[];
      reporting_currency?: string;
      reporting_timezone?: string;
    }
  ) => send<SiteSummary>("PATCH", `/v1/sites/${siteId}`, { body }),
  /**
   * Starts fenced deletion (M10, ADR-0030). `confirm` must equal the site's
   * *current* name — the server compares against what it reads at that moment,
   * so a refusal means "refetch", not "you typed it wrong". A `202` on an
   * already-`deleting` site returns the same `deletion_request_id`, so a
   * double-click converges. Nothing can stop a started deletion.
   */
  remove: (siteId: string, confirm: string, idempotencyKey: string) =>
    send<SiteDeletionAccepted>("DELETE", `/v1/sites/${siteId}`, {
      body: { confirm },
      idempotencyKey,
    }),
};

/**
 * `DELETE /v1/me` — `confirm` is the account's own email. The response that
 * matters is the `409 ACCOUNT_DELETION_BLOCKED`, whose
 * `details.blocking_sites` is the screen (frontend_tasks §18); there is no
 * preflight, the refusal is the preflight. After a `202` the session stays
 * technically valid for a few seconds until the job removes it — callers
 * clear local state and route themselves.
 */
export const account = {
  remove: (confirm: string, idempotencyKey: string) =>
    send<AccountDeletionAccepted>("DELETE", "/v1/me", {
      body: { confirm },
      idempotencyKey,
    }),
};

/** The blockers list off an `ACCOUNT_DELETION_BLOCKED` refusal, else empty. */
export function accountDeletionBlockers(
  error: unknown
): AccountDeletionBlockingSite[] {
  if (!(error instanceof ApiError)) return [];
  if (error.code !== "ACCOUNT_DELETION_BLOCKED") return [];
  const sites_ = (error.details as { blocking_sites?: unknown } | undefined)
    ?.blocking_sites;
  return Array.isArray(sites_)
    ? (sites_ as AccountDeletionBlockingSite[])
    : [];
}

/**
 * Revenue (M12, ADR-0033) — two doors, deliberately different.
 *
 * **Connecting is `credentials:manage`: owner and admin.** **Reading is
 * `revenue:read`: owner only.** So an admin may wire Stripe up and may not
 * read a number out of it, and the Revenue card is gated on
 * `SiteSummary.role === 'owner'` rather than on a probe — rendering it and
 * letting the 403 decide would flash an error on every admin's dashboard.
 *
 * **The catalog is the feature probe, not the connection route.** `connect`
 * and `rotate` are registered only where the deployment holds a credential
 * keyring, so they answer `404` where it has none, while `state`, `disconnect`
 * and `providers` keep working. A `404` from those two means "this deployment
 * cannot connect a provider" — never a bad site id.
 *
 * Money is integer minor units plus a currency, everywhere. Nothing is
 * pre-divided and nothing is a float.
 */
export const revenue = {
  /** Every provider this build knows, including `available: false` rows. */
  providers: () =>
    api.get<{ items: RevenueProvider[] }>("/v1/revenue/providers"),

  state: (siteId: string, options?: RequestOptions) =>
    api.get<RevenueConnectionState>(
      `/v1/sites/${encodeURIComponent(siteId)}/revenue/connection`,
      options
    ),

  /**
   * Step one of two. The signing secret is deliberately absent from this body:
   * it does not exist until the customer has created an endpoint at the
   * `webhook_url` this call mints. The `201` carries that URL and
   * `webhook_secret_set: false`.
   *
   * Between the steps the connection is **active and already ingesting** — the
   * backfill and reconcile sweeps run on the API key alone. It is not a broken
   * state; it is a working one missing its low-latency path.
   *
   * Takes a live round trip to the provider, so it is slow by nature.
   */
  connect: (siteId: string, body: { provider: string; api_key: string }) =>
    send<RevenueConnection>(
      "POST",
      `/v1/sites/${encodeURIComponent(siteId)}/revenue/connection`,
      { body }
    ),

  /**
   * Two independent halves, sendable together or alone. `api_key` re-probes
   * and swaps the key — the webhook URL and secret are untouched, so nothing
   * changes in Stripe — and a success clears `degraded`. `webhook_secret` is
   * step two of connecting, and the one-field fix when a customer rotates the
   * endpoint's secret: no re-probe, no new URL.
   *
   * An empty body is a `400` naming both fields `required_one_of`, so the save
   * button stays disabled until something has actually changed.
   */
  rotate: (
    siteId: string,
    body: { api_key?: string; webhook_secret?: string }
  ) =>
    send<RevenueConnection>(
      "PATCH",
      `/v1/sites/${encodeURIComponent(siteId)}/revenue/connection`,
      { body }
    ),

  /**
   * Erases both secrets and leaves the recorded revenue in place. Reconnecting
   * mints a **new** webhook URL that has to be created in Stripe again, which
   * is one of the three sentences the confirm copy owes the customer.
   *
   * Outside the billing gate on purpose: reading the money is what a `402`
   * closes, cutting a provider link is not.
   */
  disconnect: (siteId: string) =>
    send<null>(
      "DELETE",
      `/v1/sites/${encodeURIComponent(siteId)}/revenue/connection`
    ),

  summary: (
    siteId: string,
    range: AnalyticsRange,
    options?: RequestOptions & {
      compare?: boolean;
      resolution?: RevenueResolution;
    }
  ) => {
    const { compare, resolution, ...rest } = options ?? {};
    return analyticsRevenueGet<RevenueSummaryResponse>(
      siteId,
      "summary",
      range,
      rest,
      {
        ...(compare ? { compare: "true" } : {}),
        ...(resolution ? { resolution } : {}),
      }
    );
  },

  /**
   * Hour and day only. `minute`/`week` are `400 VALIDATION_FAILED` and a
   * sub-hour timezone is `400 RESOLUTION_NOT_AVAILABLE`, so this is not the
   * traffic chart's grain picker and must not share its control.
   */
  timeseries: (
    siteId: string,
    range: AnalyticsRange,
    options?: RequestOptions & { resolution?: RevenueResolution }
  ) => {
    const { resolution, ...rest } = options ?? {};
    return analyticsRevenueGet<RevenueTimeseriesResponse>(
      siteId,
      "timeseries",
      range,
      rest,
      resolution ? { resolution } : undefined
    );
  },

  /**
   * MRR, active and trialing subscriptions at both ends of the range, what
   * moved in between, and the range's charges split new / renewal /
   * plan_change / one_off (Perier fork, gap 7). Owner-only.
   */
  subscriptionSummary: (
    siteId: string,
    range: AnalyticsRange,
    options?: RequestOptions
  ) =>
    analyticsRevenueGet<SubscriptionSummaryResponse>(
      siteId,
      "subscriptions/summary",
      range,
      options
    ),

  /** MRR per site-local day, every day present; levels are end-of-day. */
  subscriptionTimeseries: (
    siteId: string,
    range: AnalyticsRange,
    options?: RequestOptions
  ) =>
    analyticsRevenueGet<SubscriptionTimeseriesResponse>(
      siteId,
      "subscriptions/timeseries",
      range,
      options
    ),

  /**
   * The app's first cursor-paginated list. The cursor is **opaque**: pass it
   * back verbatim, never parse one and never build one. A malformed cursor is
   * `400 VALIDATION_FAILED` with `details.issues[].path = 'cursor'` rather
   * than a silent restart at page one — on that code, drop the cursor and
   * restart deliberately, because a silent restart is how a paging client
   * loops forever.
   */
  transactions: (
    siteId: string,
    range: AnalyticsRange,
    options?: RequestOptions & { cursor?: string; limit?: number }
  ) => {
    const { cursor, limit, ...rest } = options ?? {};
    return analyticsRevenueGet<RevenueTransactionsResponse>(
      siteId,
      "transactions",
      range,
      rest,
      {
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit: String(limit) } : {}),
      }
    );
  },

  /**
   * The range is load-bearing, not decoration: it bounds which partitions are
   * read, so this takes the same `from`/`to` the list was showing and a charge
   * from outside it answers `404`.
   *
   * An *unmatched* transaction is a `200`, with `matched_via: 'none'`, null
   * touch blocks and `touchpoint_count: 0`. "We could not tie this payment to
   * a visit" is a real screen; the `404` means no such transaction here.
   */
  journey: (
    siteId: string,
    objectId: string,
    range: AnalyticsRange,
    options?: RequestOptions
  ) =>
    api.get<RevenueJourneyResponse>(
      `/v1/sites/${encodeURIComponent(siteId)}/revenue/transactions/${encodeURIComponent(objectId)}/journey?${new URLSearchParams(
        { from: range.from, to: range.to, timezone: range.timezone }
      )}`,
      options
    ),
};

/** `analyticsGet`'s shape for the `/revenue/` prefix rather than `/analytics/`. */
function analyticsRevenueGet<T>(
  siteId: string,
  report: string,
  range: AnalyticsRange,
  options?: RequestOptions,
  extra?: Record<string, string>
): Promise<T> {
  const query = new URLSearchParams({
    from: range.from,
    to: range.to,
    timezone: range.timezone,
    ...extra,
  });
  return api.get<T>(
    `/v1/sites/${encodeURIComponent(siteId)}/revenue/${report}?${query}`,
    options
  );
}

export const team = {
  members: (siteId: string) =>
    api.get<{ items: SiteMember[] }>(`/v1/sites/${siteId}/members`),
  changeRole: (siteId: string, userId: string, role: SiteRole) =>
    send<SiteMember>("PATCH", `/v1/sites/${siteId}/members/${userId}`, {
      body: { role },
    }),
  remove: (siteId: string, userId: string) =>
    send<null>("DELETE", `/v1/sites/${siteId}/members/${userId}`),
  invites: (siteId: string) =>
    api.get<{ items: SiteInvite[] }>(`/v1/sites/${siteId}/invites`),
  invite: (siteId: string, body: { email: string; role: SiteRole }) =>
    send<{ invite_id: string }>("POST", `/v1/sites/${siteId}/invites`, {
      body,
    }),
  revokeInvite: (siteId: string, inviteId: string) =>
    send<null>("DELETE", `/v1/sites/${siteId}/invites/${inviteId}`),
  /**
   * Mints a new token, revives an expired invitation and sends a fresh
   * email. The previous link dies the moment this succeeds — one
   * invitation, one live token — and the confirmation copy must say so.
   */
  resendInvite: (siteId: string, inviteId: string) =>
    send<InviteResent>(
      "POST",
      `/v1/sites/${siteId}/invites/${inviteId}/resend`
    ),
  acceptInvite: (token: string) =>
    send<AcceptedInvite>("POST", "/v1/invites/accept", { body: { token } }),
};

/**
 * The signed-in user's own preferences. `timezone: null` means never chosen —
 * not UTC; fall back to the browser zone. The same value is flattened onto
 * the Better Auth session as `user.timezone`, so screens read it from the
 * session on load and only call these for the settings screen and the
 * read-back after a write.
 */
export const preferences = {
  get: () => api.get<UserPreferences>("/v1/me/preferences"),
  /** The field must be present: an IANA name stores, `null` clears. */
  update: (timezone: string | null) =>
    send<UserPreferences>("PATCH", "/v1/me/preferences", {
      body: { timezone },
    }),
};

/**
 * The OAuth clients the signed-in user has connected — the CLI's device
 * logins and MCP connectors alike (ADR-0048 D4). Self only, listed from live
 * grants rather than consents, because the CLI's device flow writes a token
 * and no consent row. Revoking deletes the client's tokens *and* its standing
 * consents in one transaction, so the client cannot silently re-issue a token
 * on its next authorize; `404` means there was no such connection to sever.
 */
export const connectedApps = {
  list: () => api.get<ConnectedAppList>("/v1/me/connected-apps"),
  revoke: (clientId: string) =>
    send<null>(
      "DELETE",
      `/v1/me/connected-apps/${encodeURIComponent(clientId)}`
    ),
};

/* Assistant ---------------------------------------------------------------- */

export type AssistantUsage = Schemas["AssistantUsage"];

/** One turn of the conversation the client keeps (the server stores none). */
export type AssistantTurn = {
  role: "user" | "assistant";
  content: string;
};

export interface AssistantTrace {
  id: string;
  tool: string;
  arguments?: Record<string, unknown>;
  meta?: unknown;
}

export interface AssistantDone {
  input_tokens: number;
  output_tokens: number;
  /** Questions left in the rolling window — quota, not billing (F-306). */
  remaining: number;
}

/** Throw the envelope a non-2xx answer carries, in `send()`'s own terms. */
function throwFromEnvelope(text: string, status: number): never {
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    /* not an envelope — fall through to the generic error */
  }
  const envelope = parsed as {
    error?: { code?: string; message?: string; details?: unknown };
  } | null;
  const code = envelope?.error?.code;
  if (code && isErrorCode(code)) {
    throw new ApiError(code, envelope?.error?.message ?? code, {
      status,
      details: (envelope?.error?.details ?? {}) as Record<string, unknown>,
    });
  }
  throw new ApiError("SERVICE_UNAVAILABLE", `unexpected ${status} response`, {
    status,
    expose: false,
  });
}

/**
 * The AI analytics assistant (ADR-0046) — `POST /v1/assistant/questions`,
 * answered as a named-event SSE stream. A POST cannot ride `EventSource`, so
 * this parses the stream off `fetch` by hand: blocks split on blank lines,
 * `event:`/`data:` fields, JSON payloads.
 *
 * Four events: `trace` (one per tool call — in-conversation provenance),
 * `delta` (answer text as generated), `done` (token counts and the questions
 * remaining), `error` (an ErrorEnvelope in-band, surfaced here as the same
 * `ApiError` every other call throws). A stream that ends without `done` or
 * `error` was cut mid-answer and is reported as unavailable rather than
 * silently presented as complete.
 */
export const assistant = {
  ask: async (
    messages: AssistantTurn[],
    handlers: {
      signal: AbortSignal;
      onDelta: (text: string) => void;
      onTrace?: (trace: AssistantTrace) => void;
    }
  ): Promise<AssistantDone> => {
    const response = await fetch(`${API_BASE_URL}/v1/assistant/questions`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ messages }),
      signal: handlers.signal,
    });

    if (!response.ok) {
      throwFromEnvelope(await response.text().catch(() => ""), response.status);
    }
    if (response.body === null) {
      throw new ApiError("SERVICE_UNAVAILABLE", "the answer stream is empty", {
        status: 502,
        expose: false,
      });
    }

    let done: AssistantDone | null = null;

    const handleBlock = (block: string) => {
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data === "") return;
      const payload = JSON.parse(data) as unknown;
      if (event === "delta") {
        const text = (payload as { text?: string }).text;
        if (typeof text === "string" && text.length > 0) handlers.onDelta(text);
      } else if (event === "trace") {
        handlers.onTrace?.(payload as AssistantTrace);
      } else if (event === "done") {
        done = payload as AssistantDone;
      } else if (event === "error") {
        // In-band failure: same envelope, same ApiError as any other call.
        throwFromEnvelope(data, 200);
      }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done: finished } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), {
        stream: !finished,
      });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) handleBlock(block);
      if (finished) break;
    }
    if (buffer.trim() !== "") handleBlock(buffer);

    if (done === null) {
      throw new ApiError(
        "SERVICE_UNAVAILABLE",
        "the answer stream ended before it finished",
        { status: 502, expose: false }
      );
    }
    return done;
  },
  /**
   * The caller's spend over the rolling window — and, in `available`, whether
   * this deployment has a model provider at all.
   *
   * The dashboard asks this before it draws the chat control. A self-hosted
   * install with no `OPENAI_API_KEY` used to be offered a button whose only
   * outcome was an error; the api was already answering honestly, nothing was
   * asking it.
   */
  usage: () => api.get<AssistantUsage>("/v1/assistant/usage"),
};

/**
 * Saved funnel definitions — storage only, no counts. Running one is the
 * existing `getAnalyticsFunnel` call with the stored parameters. DELETE is
 * an archive and is idempotent; an archived definition is not editable.
 */
export const funnels = {
  list: (siteId: string, includeArchived = false) =>
    api.get<{ items: FunnelDefinition[] }>(
      `/v1/sites/${siteId}/funnels${includeArchived ? "?include_archived=true" : ""}`
    ),
  create: (
    siteId: string,
    body: {
      name: string;
      steps: string[];
      window_ms: number;
      scope?: FunnelScope;
    }
  ) => send<FunnelDefinition>("POST", `/v1/sites/${siteId}/funnels`, { body }),
  update: (
    siteId: string,
    funnelId: string,
    body: {
      name?: string;
      steps?: string[];
      window_ms?: number;
      scope?: FunnelScope;
    }
  ) =>
    send<FunnelDefinition>(
      "PATCH",
      `/v1/sites/${siteId}/funnels/${funnelId}`,
      { body }
    ),
  archive: (siteId: string, funnelId: string) =>
    send<null>("DELETE", `/v1/sites/${siteId}/funnels/${funnelId}`),
};

/**
 * Widget definitions (M15, ADR-0045) — configuration only, no numbers. What a
 * widget publishes is read anonymously at `GET /v1/widget/{id}`, which the
 * dashboard never calls: reading it from here would spend the widget's public
 * rate budget.
 *
 * Reads are membership-only (viewer included); every mutation is
 * `site:settings`. The create's constraints are the public read's own:
 * `range` is required except on `realtime` (which refuses it), `limit` is
 * accepted only on the four breakdown surfaces. `surface` is immutable after
 * create and deliberately absent from the update body. `allowed_origins` is a
 * full replace whenever it is sent; the PATCH is otherwise partial, and an
 * empty body is refused rather than treated as a no-op.
 *
 * `remove` is NOT idempotent: a second DELETE answers `404`, because this is
 * the revocation of a public credential. Never retry it blindly — re-read the
 * list instead.
 */
export const widgets = {
  list: (siteId: string) =>
    api.get<{ items: Widget[] }>(`/v1/sites/${siteId}/widgets`),
  create: (
    siteId: string,
    body: {
      surface: WidgetSurface;
      title?: string | null;
      range?: WidgetRange;
      limit?: number;
      allowed_origins: string[];
    }
  ) => send<Widget>("POST", `/v1/sites/${siteId}/widgets`, { body }),
  update: (
    siteId: string,
    widgetId: string,
    body: {
      title?: string | null;
      range?: WidgetRange;
      limit?: number;
      allowed_origins?: string[];
      enabled?: boolean;
    }
  ) =>
    send<Widget>("PATCH", `/v1/sites/${siteId}/widgets/${widgetId}`, { body }),
  remove: (siteId: string, widgetId: string) =>
    send<null>("DELETE", `/v1/sites/${siteId}/widgets/${widgetId}`),
};

/**
 * The no-code event builder (M13, ADR-0034). Four semantics every caller has
 * to hold, because each one looks like a bug when forgotten (§27):
 *
 * - **Saving is not publishing.** `create` makes the definition *and* its v1
 *   and publishes neither; `createVersion` adds a draft. `published_version:
 *   null` is a real state — drafted, never live.
 * - **Publish and rollback are optimistically concurrent.** Both take the
 *   `published_version` the caller last read (`null` for "nothing is live").
 *   A mismatch is `409 EVENT_DEFINITION_VERSION_CONFLICT` with the live
 *   version in `details.published_version`, and nothing was written — re-read
 *   and let the human decide, never retry automatically.
 * - **Rollback moves forward**: it copies the historical version into a NEW
 *   one and publishes that. `source_version` is provenance for the copy.
 * - **A publish reaches an already-loaded browser in up to ~10 minutes**
 *   (HTTP cache + tracker config cache). There is no completion signal.
 *
 * Reads are membership-only (viewer included); every mutation needs
 * `site:settings`.
 */
export const eventDefinitions = {
  list: (siteId: string, includeArchived = false) =>
    api.get<{ items: EventDefinition[] }>(
      `/v1/sites/${siteId}/event-definitions${includeArchived ? "?include_archived=true" : ""}`
    ),
  create: (siteId: string, body: { event_name: string } & EventDefinitionContent) =>
    send<EventDefinition & { version: EventDefinitionVersion }>(
      "POST",
      `/v1/sites/${siteId}/event-definitions`,
      { body }
    ),
  /** DELETE is an archive: history stays readable, nothing is served. */
  archive: (siteId: string, definitionId: string) =>
    send<null>(
      "DELETE",
      `/v1/sites/${siteId}/event-definitions/${definitionId}`
    ),
  listVersions: (siteId: string, definitionId: string) =>
    api.get<{ items: EventDefinitionVersion[] }>(
      `/v1/sites/${siteId}/event-definitions/${definitionId}/versions`
    ),
  /** A full-content save, frozen as the next immutable version — a draft. */
  createVersion: (
    siteId: string,
    definitionId: string,
    body: EventDefinitionContent
  ) =>
    send<EventDefinitionVersion>(
      "POST",
      `/v1/sites/${siteId}/event-definitions/${definitionId}/versions`,
      { body }
    ),
  publish: (
    siteId: string,
    definitionId: string,
    body: { version: number; expected_published_version: number | null }
  ) =>
    send<{ published_version: number; config_version: number }>(
      "POST",
      `/v1/sites/${siteId}/event-definitions/${definitionId}/publish`,
      { body }
    ),
  rollback: (
    siteId: string,
    definitionId: string,
    body: { version: number; expected_published_version: number | null }
  ) =>
    send<{
      published_version: number;
      source_version: number | null;
      config_version: number;
      version: EventDefinitionVersion;
    }>(
      "POST",
      `/v1/sites/${siteId}/event-definitions/${definitionId}/rollback`,
      { body }
    ),
};

/**
 * Import (M11, ADR-0032): create → PUT → complete → poll → review → publish.
 *
 * Two things about this group are load-bearing:
 *
 * - **`providers` is the feature probe, not a site route.** The site-scoped
 *   routes are mounted only where object storage is configured and answer
 *   `404` where it is not, so a `404` from `create` means "this deployment
 *   cannot import", never a bad site id. The catalog is mounted
 *   unconditionally and is session-authenticated rather than site-scoped.
 * - **The bytes never pass through the api.** `create` mints a signed
 *   single-PUT target; the browser uploads straight to storage and `complete`
 *   is what tells the api the object is there.
 */
export const imports = {
  providers: () => api.get<{ items: ImportProvider[] }>("/v1/imports/providers"),
  list: (siteId: string) =>
    api.get<{ items: ImportRun[] }>(`/v1/sites/${siteId}/imports`),
  /**
   * The one read that mints a fresh `upload` block — and only while the run is
   * still `uploading`. That is the recovery for an expired signature: re-read,
   * then PUT again, rather than discarding bytes already transferred.
   */
  get: (siteId: string, runId: string) =>
    api.get<ImportRun>(`/v1/sites/${siteId}/imports/${runId}`),
  /**
   * `size_bytes` must be `File.size` exactly — it is bound into the signature,
   * so a rounded value produces an upload storage refuses rather than a slow
   * one.
   */
  create: (
    siteId: string,
    body: { provider: string; size_bytes: number },
    idempotencyKey: string
  ) =>
    send<CreateImportResponse>("POST", `/v1/sites/${siteId}/imports`, {
      body: { ...body, content_type: "application/zip" },
      idempotencyKey,
    }),
  /**
   * A signed PUT gives the api no callback, so this is what says the bytes
   * landed. Repeating it on a run that already reached `uploaded` re-queues
   * preparation and answers the same `202`, which is why a retry after a lost
   * response needs no idempotency key.
   */
  complete: (siteId: string, runId: string) =>
    send<ImportRun>("POST", `/v1/sites/${siteId}/imports/${runId}/complete`),
  /**
   * Omitting `cutover_date` accepts `summary.proposed_cutover_date` and the
   * server clamps it silently; an explicit value past the day after
   * `first_event_at` is refused rather than rewritten.
   */
  publish: (
    siteId: string,
    runId: string,
    cutoverDate: string | null,
    idempotencyKey: string
  ) =>
    send<ImportRun>("POST", `/v1/sites/${siteId}/imports/${runId}/publish`, {
      ...(cutoverDate ? { body: { cutover_date: cutoverDate } } : {}),
      idempotencyKey,
    }),
  /** Immediate, no job: the superseded rows were never deleted. */
  rollback: (siteId: string, runId: string) =>
    send<ImportRun>("POST", `/v1/sites/${siteId}/imports/${runId}/rollback`),
  /** Allowed from `uploading`, `uploaded` and `ready_for_review` only. */
  discard: (siteId: string, runId: string) =>
    send<null>("DELETE", `/v1/sites/${siteId}/imports/${runId}`),
};

/**
 * The archive, straight to storage. `XMLHttpRequest` rather than `fetch`
 * because it is the only one that reports upload progress in every browser we
 * support — and progress is the whole of what the customer sees here, since
 * the api learns nothing until `complete`.
 *
 * Every `required_headers` entry is replayed verbatim: they are part of the
 * signature, so a changed, added or dropped header fails to verify.
 */
export function uploadImportArchive(
  target: ImportUploadTarget,
  file: File,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(target.method, target.url, true);
    for (const [name, value] of Object.entries(target.required_headers)) {
      request.setRequestHeader(name, value);
    }
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && options.onProgress) {
        options.onProgress(event.loaded / event.total);
      }
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      // Storage answers XML, not our envelope. The status is the only thing
      // worth carrying: 403 is an expired or mismatched signature, which the
      // screen recovers from by re-reading the run.
      reject(new UploadFailed(request.status));
    });
    request.addEventListener("error", () => reject(new UploadFailed(0)));
    request.addEventListener("abort", () => reject(new UploadFailed(0)));
    options.signal?.addEventListener("abort", () => request.abort());
    request.send(file);
  });
}

/** A failed PUT to storage. `status` 0 is a network error or an abort. */
export class UploadFailed extends Error {
  constructor(readonly status: number) {
    super(`upload failed with status ${status}`);
    this.name = "UploadFailed";
  }
}

/**
 * Export (M11): request → poll → download. `export:raw` is **owner-only**, but
 * both reads are membership-only on purpose — every member may see that an
 * export happened, and only an owner may cause one or take delivery.
 */
export const dataExports = {
  list: (siteId: string) =>
    api.get<{ items: ExportRun[] }>(`/v1/sites/${siteId}/exports`),
  get: (siteId: string, exportId: string) =>
    api.get<ExportRun>(`/v1/sites/${siteId}/exports/${exportId}`),
  create: (siteId: string, idempotencyKey: string) =>
    send<{ export: ExportRun }>("POST", `/v1/sites/${siteId}/exports`, {
      idempotencyKey,
    }),
  /**
   * Hands out bearer URLs and writes exactly one audit row, which is why it is
   * a POST and why a poll must never call it. The URLs live fifteen minutes;
   * repeating the call for a fresh set is an ordinary flow, not an error path,
   * so nothing here caches them.
   */
  download: (siteId: string, exportId: string) =>
    send<ExportDownload>(
      "POST",
      `/v1/sites/${siteId}/exports/${exportId}/download`
    ),
};

export const keys = {
  list: (siteId: string) =>
    api.get<{ items: ApiKeySummary[] }>(`/v1/sites/${siteId}/keys`),
  /**
   * `scopes` is for `private_read` keys only and is omitted rather than sent
   * empty (an empty array is a 400): omitted mints the minimum,
   * `["site:read"]`. `realtime:read`/`revenue:read` are refused for keys by
   * design (ADR-0043 D5), so the type does not offer them.
   */
  create: (
    siteId: string,
    body: { type: ApiKeyType; name?: string; scopes?: ApiKeyScope[] }
  ) => send<CreatedApiKey>("POST", `/v1/sites/${siteId}/keys`, { body }),
  revoke: (siteId: string, keyId: string) =>
    send<null>("DELETE", `/v1/sites/${siteId}/keys/${keyId}`),
};

/**
 * Public and unauthenticated: what the login screen is allowed to draw.
 *
 * `providers` answers two questions in one read — which doors exist, and
 * whether this deployment has anybody in it yet. `setup` is the second one's
 * consequence and is open only while it is true.
 */
export const auth = {
  providers: () =>
    api.get<{ items: AuthProvider[]; setup_required: boolean }>(
      "/v1/auth/providers"
    ),
  /**
   * Creates the first account and signs the caller in — the api sets the
   * session cookie on its own response, so there is nothing to store here.
   */
  setup: (body: { email: string; password: string; name?: string }) =>
    send<null>("POST", "/v1/auth/setup", { body }),
};

export type DeploymentSettings = Schemas["DeploymentSettings"];
export type DeploymentStoredSetting = Schemas["DeploymentStoredSetting"];
export type DeploymentTestEmailStatus = Schemas["DeploymentTestEmailStatus"];

/**
 * What the operator configures from the dashboard rather than from a file on
 * the host.
 *
 * `get` is what decides whether the screen is offered at all: it answers
 * `editable: false` with a reason for a deployment that is configured from its
 * environment, one with no keyring, and a caller who is not the operator — so
 * the tab can simply not be drawn rather than every panel discovering a 403.
 *
 * A secret is written and never read back. The `password` and `api_key` fields
 * carry the surface's three-way semantics: omit to keep, a string to replace,
 * `null` to remove.
 */
export const deployment = {
  get: () => api.get<DeploymentSettings>("/v1/deployment/settings"),
  putEmail: (body: {
    host: string;
    port?: number;
    secure?: boolean;
    user?: string | null;
    password?: string | null;
    from?: string | null;
  }) =>
    send<DeploymentStoredSetting>("PUT", "/v1/deployment/settings/email", {
      body,
    }),
  clearEmail: () => send<null>("DELETE", "/v1/deployment/settings/email"),
  putAssistant: (body: {
    api_key?: string | null;
    model?: string | null;
    base_url?: string | null;
  }) =>
    send<DeploymentStoredSetting>("PUT", "/v1/deployment/settings/assistant", {
      body,
    }),
  clearAssistant: () =>
    send<null>("DELETE", "/v1/deployment/settings/assistant"),
  sendTestEmail: () =>
    send<{ delivery_id: string | null; to: string }>(
      "POST",
      "/v1/deployment/settings/email/test"
    ),
  testEmailStatus: (deliveryId: string) =>
    api.get<DeploymentTestEmailStatus>(
      `/v1/deployment/settings/email/test/${encodeURIComponent(deliveryId)}`
    ),
};

export const publicDashboard = {
  get: (siteId: string) =>
    api.get<PublicDashboardSettings>(`/v1/sites/${siteId}/public-dashboard`),
  put: (
    siteId: string,
    body: {
      enabled: boolean;
      share_overview?: boolean;
      share_geography?: boolean;
      share_realtime?: boolean;
      // The ADR-0039 surfaces. Omitting one here is not "leave it alone" —
      // this is a PUT, so an absent flag is the server's default, which is
      // off. The panel therefore always sends all nine.
      share_timeseries?: boolean;
      share_sessions?: boolean;
      share_pages?: boolean;
      share_sources?: boolean;
      share_devices?: boolean;
      // The ninth flag (ADR-0044): the site's name and favicon domain on the
      // share page header. A modifier on the board's description, not a board
      // card — it alone cannot make a dark share live.
      share_identity?: boolean;
      rotate_slug?: boolean;
    }
  ) =>
    send<PublicDashboardSettings>(
      "PUT",
      `/v1/sites/${siteId}/public-dashboard`,
      { body }
    ),
};

/**
 * What this site's browsers are configured to do (owner or admin).
 *
 * A `PATCH`, not a `PUT`: every field is optional and an absent one means
 * "leave it alone", so a screen that owns one switch sends one switch and
 * cannot silently reset the four it does not render. An empty body is a `400`
 * rather than a no-op.
 *
 * A site that has never written these has no settings row at all, and `get`
 * answers with the product defaults instead of a `404`. That is the state most
 * sites are in, so it is not an error and callers do not branch on it.
 *
 * **Every accepted write bumps `config_version`**, which is what invalidates
 * the tracker-config ETag, the CDN copy, the browser's cached copy and the
 * collector's cache together. The new number is in the response, so a caller
 * can say the save landed. It does not mean browsers have it yet: they hold a
 * config for about thirty seconds, and any screen that writes this should say
 * so rather than let somebody test it on their own site and conclude it broke.
 */
export const ingestSettings = {
  get: (siteId: string, options?: RequestOptions) =>
    api.get<SiteIngestSettings>(
      `/v1/sites/${encodeURIComponent(siteId)}/ingest-settings`,
      options
    ),
  update: (siteId: string, body: UpdateSiteIngestSettings) =>
    send<SiteIngestSettings>(
      "PATCH",
      `/v1/sites/${encodeURIComponent(siteId)}/ingest-settings`,
      { body }
    ),
};

/**
 * Unauthenticated share pages. Every failure is an indistinguishable 404.
 *
 * Eight surfaces, each behind its own owner opt-in (ADR-0039): a slug that
 * serves the overview may still 404 on pages. The board therefore reads every
 * surface independently and folds away whatever comes back empty — there is no
 * endpoint that reports *which* surfaces are shared, and deliberately so, since
 * that list would itself describe a site nobody chose to describe.
 *
 * Every read answers its own `Public*Response` (D-213): the private rows
 * verbatim, under `PublicAnalyticsMeta` — the private meta minus `freshness`,
 * whose watermark told a stranger when the site last had a visitor.
 * `sessions` additionally drops `layering`, whose finalizer watermark is our
 * pipeline's lag rather than a fact about the site.
 */
export const publicShare = {
  overview: (slug: string, query: string) =>
    api.get<PublicOverviewResponse>(
      `/v1/public/${encodeURIComponent(slug)}/overview?${query}`
    ),
  geography: (slug: string, query: string) =>
    api.get<PublicGeographyResponse>(
      `/v1/public/${encodeURIComponent(slug)}/geography?${query}`
    ),
  timeseries: (slug: string, query: string) =>
    api.get<PublicTimeseriesResponse>(
      `/v1/public/${encodeURIComponent(slug)}/timeseries?${query}`
    ),
  sessions: (slug: string, query: string) =>
    api.get<PublicSessionsResponse>(
      `/v1/public/${encodeURIComponent(slug)}/sessions?${query}`
    ),
  pages: (slug: string, query: string) =>
    api.get<PublicPagesResponse>(
      `/v1/public/${encodeURIComponent(slug)}/pages?${query}`
    ),
  sources: (slug: string, query: string) =>
    api.get<PublicSourcesResponse>(
      `/v1/public/${encodeURIComponent(slug)}/sources?${query}`
    ),
  devices: (slug: string, query: string) =>
    api.get<PublicDevicesResponse>(
      `/v1/public/${encodeURIComponent(slug)}/devices?${query}`
    ),
  realtimeToken: (slug: string) =>
    send<Schemas["RealtimeTokenResponse"]>(
      "POST",
      `/v1/public/${encodeURIComponent(slug)}/realtime/token`
    ),
  /**
   * The identity read (ADR-0044) — the one public route that is not an
   * analytics read: no range, no timezone, no meta. Read once per page view
   * and never polled; it changes when an owner renames their site, which is
   * roughly never, and the deploy's rate-limit arithmetic counts on that.
   */
  siteIdentity: (slug: string) =>
    api.get<PublicSiteIdentity>(
      `/v1/public/${encodeURIComponent(slug)}/site`
    ),
};

/* Standalone reads the dashboard screens import directly. ------------------ */

export function listSites(
  options?: RequestOptions
): Promise<SiteListResponse> {
  return api.get<SiteListResponse>("/v1/sites", options);
}

/**
 * The one place a public slug becomes an internal id. URLs carry the slug;
 * every resource operation carries the opaque `site_id` (docs snapshot 03 §8).
 * A slug the caller cannot see answers `404 SITE_NOT_FOUND`.
 */
export function resolveSiteSlug(
  slug: string,
  options?: RequestOptions
): Promise<SiteResolution> {
  const query = new URLSearchParams({ slug });
  return api.get<SiteResolution>(`/v1/sites/resolve?${query}`, options);
}

/** Half-open `[from, to)` in UTC, plus the IANA zone the buckets are cut in. */
export type AnalyticsRange = {
  from: string;
  to: string;
  timezone: string;
};

/**
 * The default analytics window: the last `days` UTC calendar days, today
 * included. `to` is the start of tomorrow UTC and is **exclusive** — an event
 * stamped exactly `to` belongs to the next range.
 */
export function lastDaysUtc(days: number, now: Date = new Date()): AnalyticsRange {
  const endMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  );
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  return {
    from: new Date(startMs).toISOString(),
    to: new Date(endMs).toISOString(),
    timezone: "UTC",
  };
}

/**
 * Slug → site_id, memoized per page load. Every analytics panel on a screen
 * starts from the same `[site]` segment; without this each panel would fire
 * its own identical resolve request. A failed resolve is evicted so a retry
 * actually retries instead of replaying the cached rejection.
 */
const resolutionCache = new Map<string, Promise<SiteResolution>>();

export function resolveSiteSlugCached(slug: string): Promise<SiteResolution> {
  const cached = resolutionCache.get(slug);
  if (cached) return cached;
  const pending = resolveSiteSlug(slug).catch((raised: unknown) => {
    resolutionCache.delete(slug);
    throw raised;
  });
  resolutionCache.set(slug, pending);
  return pending;
}

function analyticsGet<T>(
  siteId: string,
  report: string,
  range: AnalyticsRange,
  options?: RequestOptions,
  extra?: Record<string, string>
): Promise<T> {
  const query = new URLSearchParams({
    from: range.from,
    to: range.to,
    timezone: range.timezone,
    ...extra,
  });
  return api.get<T>(
    `/v1/sites/${encodeURIComponent(siteId)}/analytics/${report}?${query}`,
    options
  );
}

/**
 * `filters` on the six reads below is the ADR-0075 session filter, passed as
 * the serialized JSON the chip row produced (`serializeFilters`). It is
 * accepted on overview, timeseries, pages, sources, geography and devices,
 * and deliberately NOT plumbed into custom events, performance or sessions,
 * where sending one is a `400 VALIDATION_FAILED`: the absence of the option
 * on those fetchers is the guard.
 */
export function getAnalyticsOverview(
  siteId: string,
  range: AnalyticsRange,
  options?: RequestOptions & { resolution?: "hour" | "day"; filters?: string }
): Promise<AnalyticsOverviewResponse> {
  const { resolution, filters, ...rest } = options ?? {};
  return analyticsGet<AnalyticsOverviewResponse>(
    siteId,
    "overview",
    range,
    rest,
    {
      ...(resolution ? { resolution } : {}),
      ...(filters ? { filters } : {}),
    }
  );
}

/**
 * `resolution` picks the grain explicitly; omitted, the server's span-based
 * selection applies. A grain the range/timezone cannot carry answers
 * `RESOLUTION_NOT_AVAILABLE` (not retryable); forcing one coarser than the
 * range is a 200 with a zero-width effective_range and an empty series.
 */
export function getAnalyticsTimeseries(
  siteId: string,
  range: AnalyticsRange,
  options?: RequestOptions & { resolution?: Resolution; filters?: string }
): Promise<AnalyticsTimeseriesResponse> {
  const { resolution, filters, ...rest } = options ?? {};
  return analyticsGet<AnalyticsTimeseriesResponse>(
    siteId,
    "timeseries",
    range,
    rest,
    {
      ...(resolution ? { resolution } : {}),
      ...(filters ? { filters } : {}),
    }
  );
}

/**
 * Session metrics — counts, bounce rate, durations and engagement, plus the
 * `layering` block: numbers after `layering.finalized_through` may still
 * change (an open session finalizes later), so the provisional tail must
 * render as still-settling, never as settled fact.
 */
export function getAnalyticsSessions(
  siteId: string,
  range: AnalyticsRange,
  options?: RequestOptions
): Promise<AnalyticsSessionsResponse> {
  return analyticsGet<AnalyticsSessionsResponse>(
    siteId,
    "sessions",
    range,
    options
  );
}

/**
 * The funnel compute call (unchanged by funnel CRUD): ordered `steps` as
 * repeated params, a conversion `window_ms`, and the range. Running a saved
 * definition means passing its stored fields here.
 */
export function getAnalyticsFunnel(
  siteId: string,
  range: AnalyticsRange,
  input: { steps: string[]; window_ms: number; scope?: FunnelScope },
  options?: RequestOptions
): Promise<AnalyticsFunnelResponse> {
  const query = new URLSearchParams({
    from: range.from,
    to: range.to,
    timezone: range.timezone,
    window_ms: String(input.window_ms),
  });
  if (input.scope) query.set("scope", input.scope);
  for (const step of input.steps) query.append("steps", step);
  return api.get<AnalyticsFunnelResponse>(
    `/v1/sites/${encodeURIComponent(siteId)}/analytics/funnel?${query}`,
    options
  );
}

/**
 * `sort` picks the measure the server ranks AND cuts by: `views` (default),
 * `entrances` or `exits`. The returned page must not be re-sorted client-side:
 * the top-N cut and the sort are one decision, and a top-100-by-views page
 * re-sorted by exits would present that page's biggest exits as the site's
 * biggest. A column header is therefore a request change, not an array sort.
 */
export type PagesSort = "views" | "entrances" | "exits";

export function getAnalyticsPages(
  siteId: string,
  range: AnalyticsRange,
  options?: RequestOptions & { filters?: string; sort?: PagesSort }
): Promise<AnalyticsPagesResponse> {
  const { filters, sort, ...rest } = options ?? {};
  return analyticsGet<AnalyticsPagesResponse>(siteId, "pages", range, rest, {
    ...(filters ? { filters } : {}),
    ...(sort && sort !== "views" ? { sort } : {}),
  });
}

/**
 * The "Earlier" list behind the realtime board (ADR-0024): one row per
 * visitor over a short trailing window. Takes `hours` instead of a range —
 * it is a trailing read, not a chosen one — and is provisional by
 * definition: it reads the leading edge of ingest, where sessions are not
 * finalized yet.
 */
export function getRecentVisitors(
  siteId: string,
  input: { hours: number; timezone: string; limit?: number },
  options?: RequestOptions
): Promise<AnalyticsRecentVisitorsResponse> {
  const query = new URLSearchParams({
    hours: String(input.hours),
    timezone: input.timezone,
  });
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  return api.get<AnalyticsRecentVisitorsResponse>(
    `/v1/sites/${encodeURIComponent(siteId)}/analytics/recent-visitors?${query}`,
    options
  );
}

/**
 * The session-by-session trail behind one recent-visitors row. `hash` is the
 * same value the realtime feed's `events[].visitor` carries, so a live row
 * and an earlier row open the same detail. A rotated-away hash answers
 * `200 { sessions: [] }`, never a 404.
 */
export function getVisitorTrail(
  siteId: string,
  input: { hash: string; hours: number; timezone: string },
  options?: RequestOptions
): Promise<AnalyticsVisitorResponse> {
  const query = new URLSearchParams({
    hash: input.hash,
    hours: String(input.hours),
    timezone: input.timezone,
  });
  return api.get<AnalyticsVisitorResponse>(
    `/v1/sites/${encodeURIComponent(siteId)}/analytics/visitor?${query}`,
    options
  );
}

export function getAnalyticsSources(
  siteId: string,
  range: AnalyticsRange,
  options?: RequestOptions & { filters?: string }
): Promise<AnalyticsSourcesResponse> {
  const { filters, ...rest } = options ?? {};
  return analyticsGet<AnalyticsSourcesResponse>(
    siteId,
    "sources",
    range,
    rest,
    filters ? { filters } : undefined
  );
}

export function getAnalyticsGeography(
  siteId: string,
  range: AnalyticsRange,
  options?: RequestOptions & { filters?: string }
): Promise<AnalyticsGeographyResponse> {
  const { filters, ...rest } = options ?? {};
  return analyticsGet<AnalyticsGeographyResponse>(
    siteId,
    "geography",
    range,
    rest,
    filters ? { filters } : undefined
  );
}

export function getAnalyticsDevices(
  siteId: string,
  range: AnalyticsRange,
  options?: RequestOptions & { filters?: string }
): Promise<AnalyticsDevicesResponse> {
  const { filters, ...rest } = options ?? {};
  return analyticsGet<AnalyticsDevicesResponse>(
    siteId,
    "devices",
    range,
    rest,
    filters ? { filters } : undefined
  );
}

export function getAnalyticsCustomEvents(
  siteId: string,
  range: AnalyticsRange,
  options?: RequestOptions
): Promise<AnalyticsCustomEventsResponse> {
  return analyticsGet<AnalyticsCustomEventsResponse>(
    siteId,
    "custom-events",
    range,
    options
  );
}

export function getAnalyticsPerformance(
  siteId: string,
  range: AnalyticsRange,
  options?: RequestOptions
): Promise<AnalyticsPerformanceResponse> {
  return analyticsGet<AnalyticsPerformanceResponse>(
    siteId,
    "performance",
    range,
    options
  );
}

/**
 * Mints the ≤60-second realtime stream token (frontend_realtime_contract §1).
 * Single-site, single-user; a reconnect always mints a fresh one — by the time
 * a stream drops, the old token has almost certainly expired.
 */
export function mintRealtimeToken(
  siteId: string
): Promise<RealtimeTokenResponse> {
  return send<RealtimeTokenResponse>(
    "POST",
    `/v1/sites/${encodeURIComponent(siteId)}/realtime/token`
  );
}

/* Error handling ---------------------------------------------------------- */

export { ApiError, isRetryableErrorCode };

/**
 * A thrown error's code, as a plain string.
 *
 * Not the `ErrorCode` union, deliberately: an optional surface registers codes
 * the product contract does not declare (`registerErrorCodes`), and a closed
 * union here would make every comparison against one of them a type error at
 * the call sites that legitimately expect it.
 */
export function errorCodeOf(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}

/**
 * `401 UNAUTHENTICATED` from any `/v1` call means the session is gone, not that
 * this particular screen failed. Callers send the user to `/login`; never retry.
 * `REAUTH_REQUIRED` is deliberately not folded in here — the user is still
 * signed in and the rest of the app keeps working.
 */
export function isUnauthenticated(error: unknown): boolean {
  return errorCodeOf(error) === "UNAUTHENTICATED";
}

/**
 * One place that turns an error code into what the user should see. Screens
 * branch on `kind`, never on the message — `message` is explicitly not
 * contract surface.
 */
export type ErrorPresentation = {
  kind:
    | "auth"
    | "forbidden"
    | "reauth"
    | "upsell"
    | "suspended"
    | "quota"
    | "capacity"
    | "not_found"
    | "validation"
    | "conflict"
    | "rate_limited"
    | "unavailable"
    | "range"
    | "filtered_range"
    | "unknown";
  title: string;
  body: string;
  retryable: boolean;
};

/**
 * Copy for the codes this deployment can actually raise.
 *
 * Keyed by `string`, not by `ErrorCode`, for the same reason the contract's
 * status table is (`packages/contracts/src/errors.ts`): an optional surface
 * registers its own codes at import time, and a closed union here would make
 * the one lookup that turns an error into words unable to name them.
 */
const PRESENTATIONS: Record<string, Omit<ErrorPresentation, "retryable">> = {
  UNAUTHENTICATED: {
    kind: "auth",
    title: "Session expired",
    body: "Sign in again to continue.",
  },
  FORBIDDEN: {
    kind: "forbidden",
    title: "Not allowed",
    body: "Your role on this site does not include this action.",
  },
  REAUTH_REQUIRED: {
    kind: "reauth",
    title: "Confirm it is you",
    body: "This action needs a fresh sign-in.",
  },
  SITE_SUSPENDED: {
    kind: "suspended",
    title: "Site paused",
    body: "This site is suspended, so its analytics are closed.",
  },
  SITE_NOT_FOUND: {
    kind: "not_found",
    title: "Site not found",
    body: "It may have been deleted, or you no longer have access.",
  },
  NOT_FOUND: {
    kind: "not_found",
    title: "Not found",
    body: "That resource no longer exists.",
  },
  VALIDATION_FAILED: {
    kind: "validation",
    title: "Check the details",
    body: "Some fields need fixing.",
  },
  IDEMPOTENCY_CONFLICT: {
    kind: "conflict",
    title: "Conflicting request",
    body: "The same request was already sent with different details.",
  },
  ALREADY_MEMBER: {
    kind: "conflict",
    title: "Already on the team",
    body: "That address already belongs to this site; there is nothing to send.",
  },
  ACCOUNT_DELETION_BLOCKED: {
    kind: "conflict",
    title: "Some sites still depend on this account",
    body: "Hand each one over or delete it, then try again.",
  },
  RATE_LIMITED: {
    kind: "rate_limited",
    title: "Slow down",
    body: "Too many requests. Try again shortly.",
  },
  IMPORT_IN_PROGRESS: {
    kind: "conflict",
    title: "An import is already running",
    body: "A site imports one archive at a time. Publish or discard the one in progress first.",
  },
  IMPORT_UPLOAD_MISSING: {
    kind: "conflict",
    title: "The file did not arrive",
    body: "Storage has no archive for this import. Upload it again; the run is still waiting.",
  },
  IMPORT_ROLLBACK_UNAVAILABLE: {
    kind: "conflict",
    title: "Nothing left to roll back to",
    body: "Only the previous import is kept, and it has already been cleaned up.",
  },
  IMPORT_FAILED: {
    kind: "conflict",
    title: "The archive could not be used",
    body: "Nothing was staged from it. Discard this import and try another export.",
  },
  EXPORT_IN_PROGRESS: {
    kind: "conflict",
    title: "An export is already running",
    body: "One export at a time per site. Wait for it to finish, then request another.",
  },
  EXPORT_EXPIRED: {
    kind: "not_found",
    title: "This export has expired",
    body: "Export files are kept for seven days. Request a new one to download it again.",
  },
  RESOLUTION_NOT_AVAILABLE: {
    kind: "range",
    title: "Range not available",
    body: "This range and timezone cannot be served at this grain. Try a shorter range or UTC.",
  },
  /**
   * ADR-0075: a filtered read is answered from the raw events joined to the
   * session facts rather than from a rollup, so it covers at most 92 days
   * while the unfiltered report still answers a year. Its own `kind` rather
   * than `range`, because the recovery is different in kind: the filtered
   * cards offer "last 90 days, chips kept" and "chips cleared, range kept",
   * both of which the generic range presentation has no business offering.
   */
  RANGE_TOO_LARGE: {
    kind: "filtered_range",
    title: "Too long for a filtered view",
    body: "A filtered view covers at most 92 days. Narrow the range, or clear the filters to see all of it.",
  },
  /**
   * The two revenue-connect refusals, which say opposite things about retrying
   * — which is the whole reason they are separate codes (frontend_tasks §24).
   * `PROVIDER_UNAVAILABLE` is the third of that trio and already sits below,
   * where it also serves the analytics reads.
   */
  REVENUE_CREDENTIAL_REJECTED: {
    kind: "conflict",
    title: "Stripe refused that key",
    body: "It is wrong, revoked, or missing a permission. Nothing was saved, and the same key will fail again. Check the permissions and make a new one.",
  },
  REVENUE_ALREADY_CONNECTED: {
    kind: "conflict",
    title: "This site already has a provider",
    body: "Replace its key, or disconnect the current one first.",
  },
  PROVIDER_UNAVAILABLE: {
    kind: "unavailable",
    title: "Data source unavailable",
    body: "Numbers are temporarily unavailable; this is not zero traffic.",
  },
  DATA_NOT_READY: {
    kind: "unavailable",
    title: "Data still processing",
    body: "The pipeline has not caught up yet.",
  },
  SERVICE_UNAVAILABLE: {
    kind: "unavailable",
    title: "Temporarily unavailable",
    body: "Numbers are temporarily unavailable; this is not zero traffic.",
  },
  INTERNAL_ERROR: {
    kind: "unknown",
    title: "Something went wrong",
    body: "Try again in a moment.",
  },
};

/**
 * Copy for a code an optional surface contributes, registered at import time
 * the same way the contract package registers its status (`registerErrorCodes`).
 * Refuses to overwrite an existing entry: two surfaces owning one code's words
 * would make what the user reads depend on module order.
 */
export function registerErrorPresentations(
  entries: Readonly<Record<string, Omit<ErrorPresentation, "retryable">>>
): void {
  for (const [code, presentation] of Object.entries(entries)) {
    const existing = PRESENTATIONS[code];
    if (existing) {
      // Two surfaces owning one code's words would make what the user reads
      // depend on module order, so different words still throw. An identical
      // re-registration is deliberately not a conflict: Fast Refresh
      // re-evaluates a registering module on every edit while this table's
      // module may keep its state, and crashing the app for a module saying
      // the same words twice turns every edit into a dev-server 500.
      // Sameness is field equality, not identity, because the re-evaluated
      // module builds a fresh object.
      const same =
        existing.kind === presentation.kind &&
        existing.title === presentation.title &&
        existing.body === presentation.body;
      if (!same) {
        throw new Error(`error code ${code} already has a presentation`);
      }
      continue;
    }
    PRESENTATIONS[code] = presentation;
  }
}

export function presentError(error: unknown): ErrorPresentation {
  const code = errorCodeOf(error);
  const base = code ? PRESENTATIONS[code] : undefined;
  if (!(code && base)) {
    return {
      kind: "unknown",
      title: "Something went wrong",
      body: "Try again in a moment.",
      retryable: false,
    };
  }
  // Retryability is a property of the product codes; a registered one that is
  // not in that set is simply not retryable, which is the safe answer.
  return { ...base, retryable: isRetryableErrorCode(code as ErrorCode) };
}

/**
 * A field-level issue off `400 VALIDATION_FAILED`, with whatever the server
 * bound to it. The import screen reads two: `size_bytes`/`too_large` carries
 * the archive `limit` (render that, never a constant), and
 * `cutover_date`/`too_late` names a picker that was allowed to go too far.
 */
export type ValidationIssue = {
  field: string;
  code: string;
  limit?: number;
};

export function validationIssueFor(
  error: unknown,
  field: string
): ValidationIssue | null {
  if (!(error instanceof ApiError)) return null;
  const issues = (error.details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues)) return null;
  for (const issue of issues) {
    if (typeof issue !== "object" || issue === null) continue;
    const entry = issue as { field?: unknown; code?: unknown; limit?: unknown };
    if (entry.field !== field) continue;
    return {
      field,
      code: typeof entry.code === "string" ? entry.code : "invalid",
      ...(typeof entry.limit === "number" ? { limit: entry.limit } : {}),
    };
  }
  return null;
}

/** A named string off an error's `details` — `import_run_id`, `export_id`. */
export function errorDetail(error: unknown, key: string): string | null {
  if (!(error instanceof ApiError)) return null;
  const value = (error.details as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : null;
}

/** `details.issues` names the offending fields on VALIDATION_FAILED. */
export function validationIssues(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const details = error.details as { issues?: unknown } | undefined;
  const issues = details?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) =>
    typeof issue === "string"
      ? issue
      : String((issue as { path?: unknown }).path ?? "field")
  );
}
