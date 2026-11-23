import {
  analyticsOverviewFixture,
  analyticsSessionsFixture,
  createdSiteFixture,
  publicDashboardSettingsFixture,
  publicGeographyFixture,
  publicOverviewFixture,
  publicSiteIdentityFixture,
  realtimeSnapshotFixture,
  siteInviteFixture,
} from "@openanalytics/contracts";
import type {
  AdCampaignRow,
  AdCampaignsResponse,
  MetaAdsConnection,
  MetaAdsConnectionState,
  AnalyticsCustomEventsResponse,
  AnalyticsDevicesResponse,
  AnalyticsGeographyResponse,
  AnalyticsMeta,
  AnalyticsPagesResponse,
  AnalyticsPerformanceResponse,
  AnalyticsSessionsResponse,
  AnalyticsSourcesResponse,
  ReferrerPathsResponse,
  SourceRow,
  ApiKeySummary,
  ConnectedApp,
  CreatedSite,
  ExportRun,
  ImportProvider,
  ImportRun,
  PublicDashboardSettings,
  RevenueSummaryResponse,
  SiteInvite,
  SiteMember,
  SiteListItem,
  SiteSummary,
  Mention,
  RecentVisitor,
  RevenueTransaction,
  RevenueTimeseriesPoint,
  RevenueTimeseriesResponse,
  RevenueAttributionDimension,
  RevenueAttributionResponse,
  RevenueAttributionRow,
  RevenueSegment,
  RevenueSegmentsResponse,
  SiteIngestSettings,
  SiteMentionSettings,
  ChartNote,
} from "@/lib/api";

/**
 * The one home of mock data for the wired screens, active only when
 * `NEXT_PUBLIC_MOCK_API=1` asks for it. Everything here is typed by the contracts
 * package, so the mocks cannot drift from what the api will actually send —
 * flipping to live changes the data source, never the shapes.
 */

export const MOCK_SITES: SiteListItem[] = [
  {
    site_id: "019f8740-2b3c-7a10-9c1d-4e5f6a7b8c9d",
    slug: "openanalytics",
    name: "getopen.so",
    status: "active",
    role: "owner",
    is_billing_owner: true,
    domains: ["getopen.so"],
    created_at: "2025-11-04T09:12:00.000Z",
    // Data has flowed: onboarding's "tracker installed" step is done.
    first_event_at: "2025-11-04T09:41:07.000Z",
    // Not blocked: all three lifecycle instants are null together (ADR-0030).
    suspended_at: null,
    ingest_grace_until: null,
    retention_deadline: null,
    reporting_currency: "USD",
    // Every site has a reporting clock (ADR-0044, required by ADR-0079 D5).
    // This one's owner picked it; the two below carry the 'UTC' a site gets
    // when nobody ever named one.
    reporting_timezone: "Europe/Istanbul",
    // The card figures (ADR-0080). Set, not null: null would mean "could not be
    // computed", which is a different card from one showing real numbers.
    all_time: {
      visitors: 48_213,
      pageviews: 191_804,
      // An owner with a provider connected — the only case that gets a figure.
      revenue: { net_minor: 1_284_500, currency: "USD" },
    },
    sparkline: [
      412, 508, 466, 613, 702, 688, 754, 810, 905, 862, 940, 1012, 1108, 1044,
      1186, 1240, 1302, 1288, 1355, 1420, 1398, 1476, 1533, 1610, 1588, 1672,
      1740, 1705, 1811, 1890, 1854, 1922, 2008, 2071, 2044, 2130, 2215, 2189,
      2274, 1160,
    ],
  },
  {
    site_id: "019f8740-2b3c-7a10-9c1d-4e5f6a7b8d01",
    slug: "acme",
    name: "acme.com",
    status: "active",
    role: "admin",
    is_billing_owner: false,
    domains: ["acme.com", "www.acme.com"],
    created_at: "2026-01-19T14:40:00.000Z",
    first_event_at: "2026-01-19T15:02:33.000Z",
    suspended_at: null,
    ingest_grace_until: null,
    retention_deadline: null,
    reporting_currency: "USD",
    reporting_timezone: "UTC",
    all_time: {
      visitors: 6_104,
      pageviews: 14_982,
      // `admin`, not `owner`: `revenue:read` is an owner capability, so this
      // caller gets no figure at all rather than a zero.
      revenue: null,
    },
    // Younger than the window: the series starts at the site's first event,
    // rather than padding 34 weeks of leading zeros nobody measured.
    sparkline: [88, 142, 166, 201, 255, 0, 312, 340],
  },
  {
    site_id: "019f8740-2b3c-7a10-9c1d-4e5f6a7b8d02",
    slug: "acme-blog",
    name: "blog.acme.com",
    status: "active",
    role: "viewer",
    is_billing_owner: false,
    domains: [],
    created_at: "2026-05-27T08:05:00.000Z",
    // Never installed: the one case the onboarding step exists for.
    first_event_at: null,
    suspended_at: null,
    ingest_grace_until: null,
    retention_deadline: null,
    reporting_currency: "USD",
    reporting_timezone: "UTC",
    // Waiting for its first event. Zero is the measurement here — nothing has
    // ever arrived — so the card says so instead of showing nothing.
    all_time: { visitors: 0, pageviews: 0, revenue: null },
    sparkline: [],
  },
];

export function mockSiteBySlug(slug: string): SiteSummary {
  return MOCK_SITES.find((site) => site.slug === slug) ?? MOCK_SITES[0];
}

/** The contract's member row now carries the person's email and display name. */
export const MOCK_MEMBERS: SiteMember[] = [
  {
    user_id: "019f8740-2b3c-7a10-9c1d-4e5f6a7b8c11",
    role: "owner",
    email: "owner@example.com",
    name: "Ada Lovelace",
  },
  {
    user_id: "019f8740-2b3c-7a10-9c1d-4e5f6a7b8c12",
    role: "admin",
    email: "admin@example.com",
    name: "Grace Hopper",
  },
  {
    user_id: "019f8740-2b3c-7a10-9c1d-4e5f6a7b8c13",
    role: "viewer",
    email: "viewer@example.com",
    // Null is the "never set a display name" case the contract distinguishes.
    name: null,
  },
];

/** The signed-in user in mock mode — the first member, the billing owner. */
export const MOCK_SELF_USER_ID = MOCK_MEMBERS[0].user_id;

export const MOCK_INVITES: SiteInvite[] = [siteInviteFixture];

/**
 * The connected-apps list, one of each kind the endpoint can return: a
 * dynamically registered MCP client (a `dcr_…` id resolving to the name it
 * registered under) and a first-party client (`oa-cli`, resolving to the
 * product name). Scope descriptions are the consent screen's sentences.
 */
export const MOCK_CONNECTED_APPS: ConnectedApp[] = [
  {
    client_id: "dcr_k3mv82hqidzr1wgy",
    name: "Claude",
    scopes: [
      { scope: "site:read", description: "See your sites and their settings" },
      { scope: "analytics:read", description: "Read your traffic numbers" },
      { scope: "revenue:read", description: "Read your revenue numbers" },
      { scope: "funnels:write", description: "Create and edit funnels" },
    ],
    active_token_count: 1,
    first_authorized_at: "2026-08-01T09:12:00Z",
    last_authorized_at: "2026-08-07T18:40:00Z",
  },
  {
    client_id: "oa-cli",
    name: "Open Analytics CLI",
    scopes: [
      { scope: "site:read", description: "See your sites and their settings" },
      { scope: "analytics:read", description: "Read your traffic numbers" },
    ],
    active_token_count: 2,
    first_authorized_at: "2026-07-21T14:03:00Z",
    last_authorized_at: "2026-08-05T08:27:00Z",
  },
];

export const MOCK_KEYS: ApiKeySummary[] = [
  {
    id: "key_01",
    type: "tracking_write",
    name: "Website",
    key_prefix: "oa_pk_7f3a",
    public_token: createdSiteFixture.tracking_key.public_token,
    // null, not an empty array: a tracking key carries no scopes at all
    // (ADR-0042, D3), which is a different statement from carrying none of them.
    scopes: null,
    // Installed into the website itself, so it outlives whoever pasted it
    // there (ADR-0043, D8).
    held_by: "site",
    rotation_required_at: null,
    created_at: "2026-05-02T10:12:00.000Z",
    last_used_at: "2026-07-25T08:00:00.000Z",
    revoked_at: null,
    expires_at: null,
  },
  {
    id: "key_02",
    type: "private_read",
    name: "Grafana",
    key_prefix: "oa_sk_4f2c",
    public_token: null,
    // The minimum, which is what a key minted before scopes existed reads as —
    // deliberately not `analytics:read`, so the mock shows the case the keys
    // page has to handle: an existing key that cannot read analytics.
    scopes: ["site:read"],
    // The default custody: the person who minted it kept the secret.
    held_by: "user",
    rotation_required_at: null,
    created_at: "2026-06-18T08:41:00.000Z",
    last_used_at: null,
    revoked_at: null,
    expires_at: null,
  },
];

export const MOCK_PUBLIC_DASHBOARD: PublicDashboardSettings =
  publicDashboardSettingsFixture;

/** The identity-on shape (ADR-0044), so the share header stays designable. */
export const MOCK_PUBLIC_SITE_IDENTITY = publicSiteIdentityFixture;

export const MOCK_CREATED_SITE: CreatedSite = createdSiteFixture;

/** The dashboard's own overview — comparison and all. */
export const MOCK_OVERVIEW = analyticsOverviewFixture;
/** The share page's overview — `PublicOverviewResponse` dropped
 * `billable_events` and `comparison` (ADR-0039), so the two mocks split. */
export const MOCK_PUBLIC_OVERVIEW = publicOverviewFixture;
export const MOCK_PUBLIC_GEOGRAPHY = publicGeographyFixture;
export const MOCK_SESSIONS = analyticsSessionsFixture;
/**
 * The overview's sessions read in mock mode: one point per day over the same
 * 30 days the mock traffic chart draws (from 2026-06-20), and the 30 days
 * before it for Compare. Deterministic, and the totals are derived from the
 * series so the tiles and the chart agree.
 */
function mockSessionsSeries(
  startMs: number,
  seed: number,
  bounceBase: number,
  durationBase: number
): AnalyticsSessionsResponse {
  const jitter = (i: number) => {
    const x = Math.sin((i + seed) * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const series = Array.from({ length: 30 }, (_, i) => {
    const sessions = Math.round(240 + i * 4 + jitter(i) * 90);
    const bounceRate = bounceBase + (jitter(i + 50) - 0.5) * 0.12;
    const bounced = Math.round(sessions * bounceRate);
    const avg = Math.round(durationBase + (jitter(i + 90) - 0.5) * 36_000);
    return {
      bucket: new Date(startMs + i * 86_400_000).toISOString(),
      sessions,
      engaged_sessions: sessions - bounced,
      bounced_sessions: bounced,
      bounce_rate: bounced / sessions,
      pageviews: Math.round(sessions * 2.4),
      avg_session_duration_ms: avg,
      avg_active_duration_ms: Math.round(avg * 0.5),
    };
  });
  const sum = (pick: (point: (typeof series)[number]) => number) =>
    series.reduce((total, point) => total + pick(point), 0);
  const sessions = sum((point) => point.sessions);
  const bounced = sum((point) => point.bounced_sessions);
  return {
    ...analyticsSessionsFixture,
    meta: { ...analyticsSessionsFixture.meta, resolution: "day" },
    totals: {
      sessions,
      engaged_sessions: sessions - bounced,
      bounced_sessions: bounced,
      bounce_rate: bounced / sessions,
      pageviews: sum((point) => point.pageviews),
      avg_session_duration_ms:
        sum((point) => point.avg_session_duration_ms * point.sessions) / sessions,
      avg_active_duration_ms:
        sum((point) => point.avg_active_duration_ms * point.sessions) / sessions,
    },
    series,
  };
}

const MOCK_SESSIONS_START_MS = Date.parse("2026-06-20T00:00:00.000Z");
export const MOCK_OVERVIEW_SESSIONS = mockSessionsSeries(
  MOCK_SESSIONS_START_MS,
  0,
  0.36,
  84_000
);
/** The 30 days before: a bouncier, slightly shorter month. */
export const MOCK_OVERVIEW_SESSIONS_PREVIOUS = mockSessionsSeries(
  MOCK_SESSIONS_START_MS - 30 * 86_400_000,
  7,
  0.39,
  79_000
);

/* Analytics panel mocks — the series the overview screen was designed on,
   typed by the contract so they cannot drift from what the api sends. */

const MOCK_ANALYTICS_META: AnalyticsMeta = {
  requested_range: {
    from: "2026-07-19T00:00:00.000Z",
    to: "2026-07-26T00:00:00.000Z",
  },
  effective_range: {
    from: "2026-07-19T00:00:00.000Z",
    to: "2026-07-26T00:00:00.000Z",
  },
  timezone: "UTC",
  resolution: "hour",
  accuracy: "exact",
  data_sources: ["live"],
  freshness: {
    state: "ok",
    watermark: "2026-07-25T23:00:00.000Z",
    as_of: "2026-07-26T00:03:00.000Z",
  },
  comparison_range: null,
  truncated: false,
  cached: false,
  partial: false,
};

export const MOCK_PAGES: AnalyticsPagesResponse = {
  meta: MOCK_ANALYTICS_META,
  items: [
    { page_path: "/", views: 7412, visitors: 3218, entrances: 2894, exits: 1560, bounces: 1103, bounce_rate: 1103 / 2894 },
    { page_path: "/pricing", views: 4102, visitors: 1874, entrances: 655, exits: 890, bounces: 214, bounce_rate: 214 / 655 },
    { page_path: "/blog/why-we-left-ga", views: 2988, visitors: 1402, entrances: 1188, exits: 742, bounces: 561, bounce_rate: 561 / 1188 },
    { page_path: "/docs", views: 2140, visitors: 986, entrances: 301, exits: 498, bounces: 74, bounce_rate: 74 / 301 },
    { page_path: "/changelog", views: 1201, visitors: 512, entrances: 0, exits: 240, bounces: 0, bounce_rate: null },
  ],
};

export const MOCK_SOURCES: AnalyticsSourcesResponse = {
  meta: MOCK_ANALYTICS_META,
  // `channel` is the server's (`packages/domain/src/channel.ts`); these are
  // the values it gives each tuple.
  items: [
    { referrer_domain: "google.com", utm_source: "", utm_medium: "", utm_campaign: "", channel: "organic_search", views: 6320, visitors: 2941 },
    { referrer_domain: "", utm_source: "", utm_medium: "", utm_campaign: "", channel: "direct", views: 4805, visitors: 2210 },
    { referrer_domain: "news.ycombinator.com", utm_source: "", utm_medium: "", utm_campaign: "", channel: "social", views: 2911, visitors: 1345 },
    { referrer_domain: "x.com", utm_source: "", utm_medium: "", utm_campaign: "", channel: "social", views: 1984, visitors: 918 },
    { referrer_domain: "github.com", utm_source: "", utm_medium: "", utm_campaign: "", channel: "referral", views: 1310, visitors: 604 },
    // A paid campaign, a newsletter, a partner link and two more referrers,
    // so every channel the Channels cut can show has a row.
    { referrer_domain: "google.com", utm_source: "google", utm_medium: "cpc", utm_campaign: "brand", channel: "paid", views: 640, visitors: 301 },
    { referrer_domain: "", utm_source: "beehiiv", utm_medium: "email", utm_campaign: "september-digest", channel: "email", views: 520, visitors: 260 },
    { referrer_domain: "lobste.rs", utm_source: "", utm_medium: "", utm_campaign: "", channel: "referral", views: 412, visitors: 198 },
    { referrer_domain: "linkedin.com", utm_source: "", utm_medium: "", utm_campaign: "", channel: "social", views: 380, visitors: 176 },
    { referrer_domain: "", utm_source: "toolhunt", utm_medium: "affiliate", utm_campaign: "", channel: "affiliate", views: 180, visitors: 92 },
    // The assistants, for the AI referrals card. ChatGPT tags its links, and
    // the referrer-less tuple below is a click from its apps: the AI card
    // counts it, the Referrers cut files it under Direct.
    { referrer_domain: "chatgpt.com", utm_source: "chatgpt.com", utm_medium: "", utm_campaign: "", channel: "ai", views: 742, visitors: 356 },
    { referrer_domain: "perplexity.ai", utm_source: "", utm_medium: "", utm_campaign: "", channel: "ai", views: 288, visitors: 141 },
    { referrer_domain: "", utm_source: "chatgpt.com", utm_medium: "", utm_campaign: "", channel: "ai", views: 231, visitors: 118 },
    { referrer_domain: "claude.ai", utm_source: "", utm_medium: "", utm_campaign: "", channel: "ai", views: 173, visitors: 84 },
    { referrer_domain: "gemini.google.com", utm_source: "", utm_medium: "", utm_campaign: "", channel: "ai", views: 96, visitors: 45 },
  ],
};

/**
 * `group_by=channel` over `MOCK_SOURCES`: one row per channel, summed, the
 * tuple fields empty — the shape the api's collapse answers with.
 */
export const MOCK_CHANNELS: AnalyticsSourcesResponse = {
  meta: MOCK_ANALYTICS_META,
  items: Object.values(
    MOCK_SOURCES.items.reduce<Record<string, SourceRow>>((byChannel, row) => {
      const total = byChannel[row.channel] ?? {
        referrer_domain: "",
        utm_source: "",
        utm_medium: "",
        utm_campaign: "",
        channel: row.channel,
        views: 0,
        visitors: 0,
      };
      total.views += row.views;
      total.visitors += row.visitors;
      byChannel[row.channel] = total;
      return byChannel;
    }, {})
  ).sort((a, b) => b.visitors - a.visitors),
};

/**
 * Referring pages for the hosts above that send one. Google, X, LinkedIn and
 * the assistants send only their origin, so they have none, and their rows in
 * the See-all list get no expander.
 */
export const MOCK_REFERRER_PATHS: ReferrerPathsResponse = {
  meta: MOCK_ANALYTICS_META,
  items: [
    { referrer_domain: "news.ycombinator.com", path: "/item", views: 2410, visitors: 1102 },
    { referrer_domain: "news.ycombinator.com", path: "/news", views: 388, visitors: 190 },
    { referrer_domain: "news.ycombinator.com", path: "/best", views: 113, visitors: 53 },
    { referrer_domain: "github.com", path: "/openanalytics/openanalytics", views: 902, visitors: 417 },
    { referrer_domain: "github.com", path: "/awesome-selfhosted/awesome-selfhosted", views: 301, visitors: 139 },
    { referrer_domain: "github.com", path: "/openanalytics/openanalytics/issues/412", views: 107, visitors: 48 },
    { referrer_domain: "lobste.rs", path: "/s/k3x9q2/why_we_left_google_analytics", views: 344, visitors: 166 },
    { referrer_domain: "lobste.rs", path: "/t/privacy", views: 68, visitors: 32 },
  ],
};

export const MOCK_GEOGRAPHY: AnalyticsGeographyResponse = {
  meta: MOCK_ANALYTICS_META,
  items: [
    { country: "DE", city: "Berlin", views: 4020, visitors: 1893 },
    { country: "US", city: "New York", views: 3311, visitors: 1544 },
    { country: "TR", city: "Istanbul", views: 2402, visitors: 1102 },
    { country: "GB", city: "London", views: 2130, visitors: 986 },
    { country: "NL", city: "Amsterdam", views: 1754, visitors: 812 },
    { country: "FR", city: "Paris", views: 1521, visitors: 705 },
    { country: "AZ", city: "Baku", views: 1340, visitors: 623 },
    { country: "ES", city: "Madrid", views: 1160, visitors: 541 },
    { country: "CA", city: "Toronto", views: 1071, visitors: 498 },
    { country: "JP", city: "Tokyo", views: 860, visitors: 402 },
    { country: "IN", city: "Bengaluru", views: 774, visitors: 361 },
    { country: "BR", city: "São Paulo", views: 683, visitors: 318 },
    { country: "PL", city: "Warsaw", views: 590, visitors: 274 },
    { country: "AU", city: "Sydney", views: 497, visitors: 231 },
    { country: "SE", city: "Stockholm", views: 405, visitors: 189 },
  ],
};

export const MOCK_DEVICES: AnalyticsDevicesResponse = {
  meta: MOCK_ANALYTICS_META,
  items: [
    { device_type: "desktop", browser: "Chrome", os: "Windows", views: 6980, visitors: 3120 },
    { device_type: "desktop", browser: "Safari", os: "macOS", views: 3120, visitors: 1411 },
    { device_type: "mobile", browser: "Chrome", os: "Android", views: 2904, visitors: 1114 },
    { device_type: "mobile", browser: "Safari", os: "iOS", views: 3480, visitors: 1619 },
    { device_type: "desktop", browser: "Firefox", os: "Linux", views: 1490, visitors: 689 },
    { device_type: "desktop", browser: "Edge", os: "Windows", views: 1108, visitors: 512 },
    { device_type: "tablet", browser: "Safari", os: "iPadOS", views: 1010, visitors: 471 },
    { device_type: "desktop", browser: "Arc", os: "macOS", views: 640, visitors: 297 },
    { device_type: "desktop", browser: "Brave", os: "Windows", views: 561, visitors: 260 },
    { device_type: "mobile", browser: "Samsung Internet", os: "Android", views: 399, visitors: 184 },
    { device_type: "unknown", browser: "unknown", os: "unknown", views: 190, visitors: 88 },
  ],
};

/**
 * Deliberately mixed: renamed events (a definition supplied `display_name`,
 * which the server join carries), raw `track()` names as sent
 * (`display_name: null`), and one conversion. The counts descend so the
 * list reads sorted.
 */
export const MOCK_CUSTOM_EVENTS: AnalyticsCustomEventsResponse = {
  meta: MOCK_ANALYTICS_META,
  items: [
    {
      event_name: "signup_completed",
      event_type: "conversion",
      events: 1284,
      billable_events: 1284,
      visitors: 1201,
      display_name: "Signed up",
      display_template: null,
      last_seen_at: "2026-07-07T18:42:11.000Z",
      sample_page_path: "/signup",
      sample_properties: { plan: "pro", section: "hero" },
    },
    {
      event_name: "pricing_cta_click",
      event_type: "custom",
      events: 972,
      billable_events: 972,
      visitors: 803,
      display_name: "Clicked pricing CTA",
      display_template: 'Clicked "{{button_label}}" on {{page_path}}',
      last_seen_at: "2026-07-07T17:05:44.000Z",
      sample_page_path: "/pricing",
      sample_properties: { "button-label": "Start free", section: "pricing" },
    },
    {
      event_name: "newsletter_submit",
      event_type: "custom",
      events: 441,
      billable_events: 441,
      visitors: 428,
      display_name: "Joined newsletter",
      display_template: null,
      last_seen_at: "2026-07-07T11:20:03.000Z",
      sample_page_path: "/blog/why-privacy-first-analytics",
      // Fired carrying nothing. `{}` is a different fact from `null` —
      // "no properties" versus "this surface has nothing to say".
      sample_properties: {},
    },
    {
      event_name: "video_play",
      event_type: "custom",
      events: 389,
      billable_events: 389,
      visitors: 274,
      display_name: null,
      display_template: null,
      last_seen_at: "2026-07-06T20:11:00.000Z",
      sample_page_path: "/product-tour",
      sample_properties: { position: "hero" },
    },
    {
      event_name: "docs_feedback",
      event_type: "custom",
      events: 57,
      billable_events: 57,
      visitors: 55,
      display_name: null,
      display_template: null,
      // The absent case, on purpose: an imported row carries no event
      // instant, so the expansion has to look right with all three gone.
      last_seen_at: null,
      sample_page_path: null,
      sample_properties: null,
    },
  ],
};

export const MOCK_PERFORMANCE: AnalyticsPerformanceResponse = {
  meta: MOCK_ANALYTICS_META,
  items: [
    { metric: "LCP", device_type: "desktop", samples: 9800, mean: 1820.4, p50: 1700, p75: 1800, p90: 2600, p95: 3100, p99: 4200, good_samples: 8600, needs_improvement_samples: 900, poor_samples: 300 },
    { metric: "INP", device_type: "desktop", samples: 9100, mean: 152.2, p50: 120, p75: 140, p90: 240, p95: 330, p99: 520, good_samples: 8200, needs_improvement_samples: 700, poor_samples: 200 },
    { metric: "CLS", device_type: "desktop", samples: 9400, mean: 0.05, p50: 0.03, p75: 0.04, p90: 0.09, p95: 0.14, p99: 0.31, good_samples: 8800, needs_improvement_samples: 450, poor_samples: 150 },
    { metric: "FCP", device_type: "desktop", samples: 9700, mean: 1240.8, p50: 1100, p75: 1200, p90: 1900, p95: 2400, p99: 3600, good_samples: 8500, needs_improvement_samples: 950, poor_samples: 250 },
    { metric: "TTFB", device_type: "desktop", samples: 9800, mean: 710.5, p50: 540, p75: 620, p90: 1300, p95: 1900, p99: 2900, good_samples: 6900, needs_improvement_samples: 2200, poor_samples: 700 },
  ],
};

export const MOCK_REALTIME_SNAPSHOT = realtimeSnapshotFixture;

/**
 * Revenue (M12, ADR-0033) — the connected reading the card was designed for.
 *
 * Every figure is integer minor units of `totals.currency`, and the identity
 * closes exactly: 26772 − 6100 − 900 + 900 − 256 = 20416. It is written out
 * rather than computed so a broken card cannot be rescued by a mock that
 * agrees with it.
 *
 * Two details are deliberate rather than decorative. The **dispute appears in
 * both columns** — a won dispute, whose net effect is zero while the event
 * stays visible — because rendering `dispute_withdrawn_minor` alone as "lost"
 * is the mistake the pair exists to prevent. And `unconverted_count` is
 * non-zero with an ISK residue beside it, so design mode shows the footnote
 * rather than the happy path where every transaction converted.
 */
export const MOCK_REVENUE_SUMMARY: RevenueSummaryResponse = {
  meta: {
    ...MOCK_ANALYTICS_META,
    revenue: {
      provider: "stripe",
      connection_status: "connected",
      last_synced_at: "2026-08-01T09:40:00.000Z",
      last_webhook_at: "2026-08-01T09:44:00.000Z",
      rollup_through: "2026-08-01T09:40:00.000Z",
    },
  },
  totals: {
    currency: "USD",
    charge_gross_minor: 26_772,
    refund_minor: 6100,
    dispute_withdrawn_minor: 900,
    dispute_reinstated_minor: 900,
    fee_minor: 256,
    net_minor: 20_416,
    charge_count: 34,
    refund_count: 3,
    dispute_count: 1,
    unconverted_count: 3,
  },
  comparison: {
    totals: {
      currency: "USD",
      charge_gross_minor: 21_400,
      refund_minor: 2200,
      dispute_withdrawn_minor: 0,
      dispute_reinstated_minor: 0,
      fee_minor: 204,
      net_minor: 18_996,
      charge_count: 27,
      refund_count: 1,
      dispute_count: 0,
      unconverted_count: 0,
    },
  },
  unconverted: [
    {
      currency: "ISK",
      charge_gross_minor: 249_000,
      refund_minor: 0,
      dispute_minor: 0,
      transactions: 3,
    },
  ],
};

/**
 * Import / export (M11). The catalog is what a build with only the Plausible
 * adapter answers; the runs and exports are empty because the interesting
 * states — review, published, expired — are reached by acting on the screen,
 * and a fixture that pre-loaded one would hide the first step from whoever is
 * designing against it.
 */
export const MOCK_IMPORT_PROVIDERS: ImportProvider[] = [
  {
    id: "plausible",
    display_name: "Plausible",
    capability: "aggregate_only",
    available: true,
  },
  {
    id: "fathom",
    display_name: "Fathom",
    capability: "aggregate_only",
    available: false,
  },
  {
    id: "simple_analytics",
    display_name: "Simple Analytics",
    capability: "aggregate_only",
    available: false,
  },
  {
    id: "google_analytics",
    display_name: "Google Analytics 4",
    capability: "event_level",
    available: false,
  },
];

export const MOCK_IMPORT_RUNS: ImportRun[] = [];

export const MOCK_EXPORTS: ExportRun[] = [];

/* Mentions and sales ------------------------------------------------------ */

/**
 * Watching on, one extra term, checked twelve minutes ago. Built per domain so
 * the copy names the site being looked at.
 */
export function mockMentionSettings(domain: string): SiteMentionSettings {
  return {
    domain,
    x_enabled: true,
    terms: ["OpenAnalytics"],
    last_polled_at: new Date(Date.now() - 12 * 60_000).toISOString(),
    last_error: null,
  };
}

/**
 * Meta Ads in mock mode (migration 0052). `?mock_meta_ads=not_connected`,
 * `=error`, `=undecryptable` or `=disabled` picks the settings card's other
 * states, for screenshots; the default is a connected account that synced
 * twelve minutes ago.
 */
export function mockMetaAdsConnection(): MetaAdsConnectionState {
  const pick =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("mock_meta_ads");
  if (pick === "not_connected") return { status: "not_connected" };
  const connection: MetaAdsConnection = {
    status: "active",
    ad_account_id: "act_1029384756",
    ad_account_name: "Getopen Ads",
    ad_account_active: true,
    currency: "USD",
    token_last4: "Wq9z",
    connected_at: new Date(Date.now() - 9 * 86_400_000).toISOString(),
    last_attempted_at: new Date(Date.now() - 12 * 60_000).toISOString(),
    last_synced_at: new Date(Date.now() - 12 * 60_000).toISOString(),
    next_sync_at: new Date(Date.now() + 5.8 * 3_600_000).toISOString(),
    last_error: null,
  };
  if (pick === "error") {
    return { ...connection, status: "needs_reconnect", last_error: "unauthorized" };
  }
  if (pick === "undecryptable") return { ...connection, last_error: "credential_undecryptable" };
  if (pick === "disabled") return { ...connection, ad_account_active: false };
  return connection;
}

/**
 * The Ad campaigns card's fixture. The totals and the unmatched spend are
 * computed from the rows, so they add up the way the server's do.
 */
export function mockAdCampaigns(currency = "USD"): AdCampaignsResponse {
  const row = (
    id: string,
    name: string,
    spend: number,
    revenue: number,
    orders: number,
    matched: AdCampaignRow["matched_by"]
  ): AdCampaignRow => ({
    id,
    name,
    spend: { amount_minor: spend, currency },
    spend_converted_minor: spend,
    revenue_minor: revenue,
    orders,
    roas: spend > 0 ? revenue / spend : null,
    roas_unavailable: spend > 0 ? null : "no_spend",
    matched_by: matched,
  });
  const campaigns = [
    row("120211000000001", "Black Friday prospecting", 184_250, 512_000, 41, "name"),
    row("120211000000002", "Retargeting, 30-day visitors", 96_400, 371_500, 33, "name"),
    row("120211000000003", "Lookalike, past buyers", 72_800, 58_900, 6, "name"),
    row("120211000000004", "Founder video", 41_300, 0, 0, null),
    row("120211000000005", "Newsletter lookalike", 18_900, 62_400, 5, "id"),
  ];
  const sum = (pick: (r: AdCampaignRow) => number) =>
    campaigns.reduce((total, r) => total + pick(r), 0);
  const spend = sum((r) => r.spend.amount_minor);
  const revenue = sum((r) => r.revenue_minor);
  const unmatched = campaigns.filter((r) => r.matched_by === null);
  const unmatchedSpend = unmatched.reduce((total, r) => total + r.spend.amount_minor, 0);
  return {
    connection: {
      status: "active",
      ad_account_name: "Getopen Ads",
      currency,
      last_synced_at: new Date(Date.now() - 12 * 60_000).toISOString(),
      last_error: null,
    },
    currency,
    from_day: "2026-10-24",
    to_day: "2026-11-22",
    campaigns,
    totals: {
      spend: { amount_minor: spend, currency },
      spend_converted_minor: spend,
      revenue_minor: revenue,
      orders: sum((r) => r.orders),
      roas: revenue / spend,
      roas_unavailable: null,
    },
    unmatched: {
      campaigns: unmatched.length,
      spend: { amount_minor: unmatchedSpend, currency },
      spend_converted_minor: unmatchedSpend,
    },
  };
}

/**
 * A site's ingest settings in mock mode, with a few exclusions in place so the
 * Exclusions block shows its lists rather than four empty ones.
 */
export function mockIngestSettings(): SiteIngestSettings {
  return {
    config_version: 7,
    timezone: "Europe/Berlin",
    redact_query_keys: [],
    interaction_sampling: 1,
    heartbeat_interval_seconds: 15,
    features: {
      web_vitals: true,
      engagement: true,
      interactions: true,
      heartbeat: true,
    },
    attributed_revenue: false,
    exclusions: {
      ip_ranges: ["203.0.113.0/24", "2001:db8:85a3::/48"],
      paths: ["/admin/*", "/preview"],
      countries: ["DE"],
      hostnames: ["staging.example.com", "*.preview.example.com"],
    },
    exclusions_country_active: true,
  };
}

/** Same days as the overview chart's mock series (2026-06-20, thirty days). */
const mockDay = (day: number, hour: number) =>
  new Date(Date.UTC(2026, 5, 20 + day, hour, 14)).toISOString();

/**
 * Mock mode's stand-in for a stored profile picture: a small drawn portrait as
 * a data address, so nothing is requested from anywhere (never from X). Live,
 * `avatar_url` is a path on our API.
 */
const mockPortrait = (background: string, skin: string, hair: string, shirt: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
      `<rect width="64" height="64" fill="${background}"/>` +
      `<path d="M10 64c2-13 11-20 22-20s20 7 22 20z" fill="${shirt}"/>` +
      `<circle cx="32" cy="28" r="12" fill="${skin}"/>` +
      `<path d="M19 27c0-9 6-14 13-14s13 5 13 14c-3-5-8-7-13-7s-10 2-13 7z" fill="${hair}"/>` +
      `</svg>`
  )}`;

const mockMention = (
  index: number,
  day: number,
  hour: number,
  author: {
    handle: string;
    name: string;
    followers: number | null;
    avatar_url?: string | null;
  },
  text: string,
  extra: Partial<Mention> = {}
): Mention => {
  const postId = `18100000000000${String(index).padStart(5, "0")}`;
  return {
    id: `019f8740-2b3c-7a10-9c1d-${String(index).padStart(12, "0")}`,
    platform: "x",
    post_id: postId,
    url: `https://x.com/${author.handle}/status/${postId}`,
    text,
    author: {
      ...author,
      avatar_url: author.avatar_url ?? null,
      url: `https://x.com/${author.handle}`,
    },
    posted_at: mockDay(day, hour),
    matched_term: "getopen.so",
    links_to_site: true,
    likes: 12,
    reposts: 2,
    replies: 3,
    quotes: null,
    views: 2_400,
    first_seen_at: mockDay(day, hour + 1),
    refreshed_at: mockDay(day, hour + 2),
    ...extra,
  };
};

/** Newest first, the API's order. Day 21 is the traffic spike in the mock series. */
export const MOCK_MENTIONS: Mention[] = [
  mockMention(
    1,
    27,
    16,
    {
      handle: "marta_builds",
      name: "Marta Kowalska",
      followers: 8_900,
      avatar_url: mockPortrait("#dbeafe", "#f1c6a8", "#7c4a2d", "#2563eb"),
    },
    "Moved our docs site off the big analytics suite and onto getopen.so this week. Same numbers, a tenth of the script, and I can finally read the dashboard."
  ),
  mockMention(
    2,
    22,
    9,
    { handle: "indiehackr", name: "Theo", followers: 512 },
    "Is anyone self-hosting OpenAnalytics behind Cloudflare? Wondering how the collector handles the proxy headers.",
    { matched_term: "OpenAnalytics", links_to_site: false, likes: 3, reposts: null, views: null }
  ),
  mockMention(
    3,
    21,
    18,
    {
      handle: "sarahdev",
      name: "Sarah Chen",
      followers: 41_200,
      avatar_url: mockPortrait("#fce7f3", "#e8b894", "#1f1f24", "#be185d"),
    },
    "Privacy-first analytics that doesn't feel like a compromise: https://getopen.so — the realtime globe is a nice touch.",
    { likes: 318, reposts: 64, replies: 27, views: 52_000 }
  ),
  mockMention(
    4,
    21,
    11,
    { handle: "q_ops", name: "", followers: null },
    "getopen.so on the front page today, congrats to the team",
    { likes: null, reposts: null, replies: null, views: null }
  ),
  mockMention(
    5,
    9,
    14,
    {
      handle: "nadia",
      name: "Nadia Haddad",
      followers: 2_300,
      avatar_url: mockPortrait("#dcfce7", "#c68e66", "#3b2418", "#15803d"),
    },
    "Our pricing page conversion story, told by getopen.so funnels. Thread below.",
    { likes: 41, replies: 6, views: 7_800 }
  ),
];

const mockNote = (
  id: number,
  day: number,
  hour: number,
  text: string,
  author: string | null
): ChartNote => ({
  id: `0190a3b4-0000-7000-8000-${String(id).padStart(12, "0")}`,
  at: mockDay(day, hour),
  text,
  // `null` stands for an author whose account is gone.
  created_by: author === null ? null : { name: author },
  created_at: mockDay(day, hour + 1),
  updated_at: mockDay(day, hour + 1),
});

/**
 * The team's notes on the chart, newest first like the API. Day 21 is the
 * traffic spike, so the launch note sits on it next to that day's sales and
 * mentions; one note's author has since left, so it names nobody.
 */
export const MOCK_NOTES: ChartNote[] = [
  mockNote(1, 25, 9, "Newsletter sponsorship went out", null),
  mockNote(2, 21, 8, "Launch post went live\nRealtime globe and the new install guide", "Ada Lovelace"),
  mockNote(3, 21, 14, "Pinned the launch thread", "Grace Hopper"),
  mockNote(4, 14, 7, "Pro is now $49 a month", "Ada Lovelace"),
  mockNote(5, 3, 16, "Moved the docs to the new domain", "Grace Hopper"),
].sort((a, b) => b.at.localeCompare(a.at));

/**
 * Design-mode "Paying visitors" rows, in the wire's own shape: two believable
 * payers. Their ids are the anonymous ids the realtime surfaces key a visitor
 * on, and the chart's mock sales reuse them, so a payer wears the same face
 * on the revenue card and on the chart.
 */
export const MOCK_PAYING_VISITORS: RecentVisitor[] = [
  {
    visitor: "v_mock_payer_one",
    country: "DE",
    device_type: "desktop",
    browser: "chrome",
    os: "macos",
    first_seen: "2026-08-09T08:05:00.000Z",
    last_seen: "2026-08-09T08:41:00.000Z",
    pageviews: 6,
    revenue: { amount_minor: 2900, currency: "USD", transaction_count: 1 },
  },
  {
    visitor: "v_mock_payer_two",
    country: "US",
    device_type: "mobile",
    browser: "safari",
    os: "ios",
    first_seen: "2026-08-09T06:12:00.000Z",
    last_seen: "2026-08-09T06:19:00.000Z",
    pageviews: 0,
    revenue: { amount_minor: 900, currency: "USD", transaction_count: 1 },
  },
];

const mockSale = (
  index: number,
  day: number,
  hour: number,
  grossMinor: number,
  extra: Partial<RevenueTransaction> = {}
): RevenueTransaction => {
  const fee = Math.round(grossMinor * 0.029) + 30;
  return {
    object_id: `ch_mock_${index}`,
    provider: "stripe",
    object_kind: "charge",
    occurred_at: mockDay(day, hour),
    status: "succeeded",
    livemode: true,
    gross: { amount_minor: grossMinor, currency: "USD" },
    refund: { amount_minor: 0, currency: "USD" },
    fee: { amount_minor: fee, currency: "USD" },
    net: { amount_minor: grossMinor - fee, currency: "USD" },
    reporting: { amount_minor: grossMinor - fee, currency: "USD" },
    conversion: null,
    parent_object_id: null,
    order_id: null,
    product_name: "Pro",
    matched_via: "conversion_event",
    confidence: "exact",
    purchase_kind: "new",
    visitor: null,
    ...extra,
  };
};

/**
 * Charges for the chart's sale markers, newest first. One is unconverted EUR.
 * Each carries its buyer's anonymous id for that day: the two paying visitors'
 * where they fit, a buyer of their own otherwise, and one that matched no
 * visitor and keeps the diamond.
 */
export const MOCK_SALES: RevenueTransaction[] = [
  mockSale(1, 28, 10, 4_900, { purchase_kind: "renewal", visitor: "v_mock_payer_one" }),
  mockSale(2, 22, 13, 19_900, { product_name: "Team", visitor: "v_mock_payer_two" }),
  mockSale(3, 21, 19, 4_900, { visitor: "v_mock_buyer_june21_a" }),
  mockSale(4, 21, 17, 4_900, { visitor: "v_mock_buyer_june21_b" }),
  mockSale(5, 21, 15, 4_500, {
    gross: { amount_minor: 4_500, currency: "EUR" },
    net: { amount_minor: 4_340, currency: "EUR" },
    reporting: null,
    visitor: "v_mock_buyer_june21_c",
  }),
  // Partly refunded later: still a sale, worth its gross less the refund.
  mockSale(6, 14, 8, 4_900, {
    purchase_kind: "renewal",
    status: "partially_refunded",
    refund: { amount_minor: 2_000, currency: "USD" },
    net: { amount_minor: 4_900 - 172 - 2_000, currency: "USD" },
    reporting: { amount_minor: 4_900 - 172 - 2_000, currency: "USD" },
    visitor: "v_mock_buyer_june14",
  }),
  // Matched no visitor: nothing a match would fill in (no signal, no
  // confidence, no buyer id), so no face and the diamond stays.
  mockSale(7, 4, 12, 4_900, { matched_via: "none", confidence: "none", visitor: null }),
];

/**
 * The chart's revenue bars, derived from `MOCK_SALES` so a bar and the sale
 * markers under it always agree: one point per UTC day that had a sale, in the
 * reporting currency (USD). The unconverted EUR sale adds nothing to the money
 * and counts in `unconverted_count`, and the partly refunded renewal carries
 * its refund, so mock mode shows the refund outline and the footnote.
 */
export const MOCK_REVENUE_TIMESERIES: RevenueTimeseriesResponse = {
  meta: { ...MOCK_ANALYTICS_META, resolution: "day" },
  series: (() => {
    const byDay = new Map<string, RevenueTimeseriesPoint>();
    for (const sale of [...MOCK_SALES].reverse()) {
      const day = `${sale.occurred_at.slice(0, 10)}T00:00:00.000Z`;
      const point = byDay.get(day) ?? {
        bucket: day,
        currency: "USD",
        charge_gross_minor: 0,
        refund_minor: 0,
        dispute_withdrawn_minor: 0,
        dispute_reinstated_minor: 0,
        fee_minor: 0,
        net_minor: 0,
        charge_count: 0,
        refund_count: 0,
        dispute_count: 0,
        unconverted_count: 0,
      };
      if (sale.reporting === null) {
        point.unconverted_count += 1;
      } else {
        point.charge_gross_minor += sale.gross.amount_minor;
        point.refund_minor += sale.refund.amount_minor;
        point.refund_count += sale.refund.amount_minor > 0 ? 1 : 0;
        point.fee_minor += sale.fee.amount_minor;
        point.net_minor += sale.reporting.amount_minor;
        point.charge_count += 1;
      }
      byDay.set(day, point);
    }
    return [...byDay.values()];
  })(),
};

/**
 * Where each mock sale came from, for the last-touch revenue the Sources card
 * and the Entry pages cut show. Keyed by `MOCK_SALES` id, so the amounts are
 * the sales' own: the unmatched charge is the unattributed row, the EUR sale
 * has no rate and counts as an unconverted order, and renewals are revenue
 * but not orders, as the attribution read reports them.
 */
const MOCK_SALE_TOUCHES: Record<
  string,
  { referrer_domain: string; utm_source: string; entry_page: string }
> = {
  // A click from ChatGPT's app: no referrer, its utm tag.
  ch_mock_1: { referrer_domain: "", utm_source: "chatgpt.com", entry_page: "/" },
  ch_mock_2: { referrer_domain: "google.com", utm_source: "", entry_page: "/pricing" },
  ch_mock_3: { referrer_domain: "news.ycombinator.com", utm_source: "", entry_page: "/blog/why-we-left-ga" },
  ch_mock_4: { referrer_domain: "news.ycombinator.com", utm_source: "", entry_page: "/blog/why-we-left-ga" },
  // The EUR sale with no rate, from ChatGPT's app too: Direct's unconverted order.
  ch_mock_5: { referrer_domain: "", utm_source: "chatgpt.com", entry_page: "/" },
  ch_mock_6: { referrer_domain: "google.com", utm_source: "", entry_page: "/pricing" },
};

/**
 * The attribution's own visitors: sessions that *entered* with each value,
 * which is fewer than the cards' numbers (Direct / none on the Sources card
 * also holds internal navigation, Entry pages counts entries).
 */
const MOCK_ENTRY_VISITORS: Record<string, number> = {
  "": 1_642,
  "google.com": 2_655,
  "news.ycombinator.com": 1_210,
  "chatgpt.com": 402,
  "/": 2_410,
  "/pricing": 588,
  "/blog/why-we-left-ga": 1_051,
};

/** `GET /revenue/attribution` (last touch) over `MOCK_SALES`, per dimension. */
export function mockRevenueAttribution(
  dimension: RevenueAttributionDimension
): RevenueAttributionResponse {
  const rows = new Map<string | null, RevenueAttributionRow>();
  const buyers = new Map<string | null, Set<string>>();
  for (const sale of MOCK_SALES) {
    const touch = MOCK_SALE_TOUCHES[sale.object_id];
    const value =
      touch === undefined
        ? null
        : dimension === "referrer_domain" || dimension === "entry_page" || dimension === "utm_source"
          ? touch[dimension]
          : "";
    const row = rows.get(value) ?? {
      value,
      revenue_minor: 0,
      recurring_revenue_minor: 0,
      orders: 0,
      unconverted_orders: 0,
      buyers: 0,
      visitors: value === null ? null : (MOCK_ENTRY_VISITORS[value] ?? 0),
      conversion_rate: null,
      revenue_per_visitor_minor: null,
    };
    const conversion = sale.purchase_kind === "new" || sale.purchase_kind === "one_off";
    if (sale.reporting === null) {
      row.unconverted_orders += 1;
    } else {
      row.revenue_minor += sale.gross.amount_minor;
      if (!conversion) row.recurring_revenue_minor += sale.gross.amount_minor;
    }
    if (conversion) {
      row.orders += 1;
      if (value !== null && sale.visitor) {
        const set = buyers.get(value) ?? new Set<string>();
        set.add(sale.visitor);
        buyers.set(value, set);
        row.buyers = set.size;
      }
    }
    rows.set(value, row);
  }
  return {
    meta: MOCK_REVENUE_SUMMARY.meta,
    touch: "last",
    dimension,
    currency: "USD",
    visitors_available: true,
    rows: [...rows.values()]
      .map((row) =>
        row.visitors === null || row.visitors === 0
          ? row
          : {
              ...row,
              conversion_rate: row.buyers / row.visitors,
              revenue_per_visitor_minor: row.revenue_minor / row.visitors,
            }
      )
      .sort(
      (a, b) =>
        Number(b.value === null) - Number(a.value === null) ||
        b.revenue_minor - a.revenue_minor
    ),
  };
}

/**
 * Revenue by segment (`GET /revenue/segments`): eleven shown segments of a
 * month, and the site behind them. The site's totals hold the shown rows plus
 * 48 small hidden segments (two buyers, two orders, 9,900 between them), and
 * its visitors are fewer than the rows' sum would be with no overlap, as on
 * the wire: a visitor who entered two ways counts in both segments.
 *
 * The smoothed figures are the server's formula, `(count + k × site rate) /
 * (visitors + k)` with k = 200, computed here only so the fixture is
 * consistent; the screens never recompute them.
 */
const MOCK_SEGMENT_K = 200;
const MOCK_SEGMENT_THRESHOLDS = {
  min_buyers: 10,
  min_segment_visitors: 20,
  confidence: { low_visitors: 100, low_buyers: 3, high_visitors: 1_000, high_buyers: 10 },
};
const MOCK_SEGMENT_SITE = {
  visitors: 5_600,
  buyers: 46,
  orders: 47,
  revenue_minor: 266_400,
  unconverted_orders: 1,
  // Bought in the range after a visit before it: not counted above.
  buyers_last_visit_before_range: 3,
  buyers_last_visit_missing: 0,
};

function mockSegment(
  source: string,
  country: string,
  device: string,
  visitors: number,
  buyers: number,
  orders: number,
  revenue_minor: number,
  unconverted_orders = 0
): RevenueSegment {
  const p = MOCK_SEGMENT_SITE.buyers / MOCK_SEGMENT_SITE.visitors;
  const v = MOCK_SEGMENT_SITE.revenue_minor / MOCK_SEGMENT_SITE.visitors;
  return {
    source,
    country,
    device,
    visitors,
    buyers,
    orders,
    revenue_minor,
    unconverted_orders,
    conversion_rate: buyers / visitors,
    smoothed_conversion_rate: (buyers + MOCK_SEGMENT_K * p) / (visitors + MOCK_SEGMENT_K),
    average_order_value_minor:
      orders - unconverted_orders > 0 ? revenue_minor / (orders - unconverted_orders) : null,
    value_per_visitor_minor: revenue_minor / visitors,
    smoothed_value_per_visitor_minor:
      (revenue_minor + MOCK_SEGMENT_K * v) / (visitors + MOCK_SEGMENT_K),
    confidence:
      visitors < MOCK_SEGMENT_THRESHOLDS.confidence.low_visitors ||
      buyers < MOCK_SEGMENT_THRESHOLDS.confidence.low_buyers
        ? "low"
        : visitors >= MOCK_SEGMENT_THRESHOLDS.confidence.high_visitors &&
            buyers >= MOCK_SEGMENT_THRESHOLDS.confidence.high_buyers
          ? "high"
          : "medium",
  };
}

const MOCK_SEGMENTS_META = {
  ...MOCK_REVENUE_SUMMARY.meta,
  resolution: "hour" as const,
};

export const MOCK_REVENUE_SEGMENTS: RevenueSegmentsResponse = {
  meta: MOCK_SEGMENTS_META,
  status: "ok",
  currency: "USD",
  site: {
    ...MOCK_SEGMENT_SITE,
    conversion_rate: MOCK_SEGMENT_SITE.buyers / MOCK_SEGMENT_SITE.visitors,
    value_per_visitor_minor:
      MOCK_SEGMENT_SITE.revenue_minor / MOCK_SEGMENT_SITE.visitors,
  },
  segments: [
    mockSegment("google.com", "US", "desktop", 1_140, 14, 15, 74_500, 1),
    mockSegment("google.com", "DE", "desktop", 620, 6, 6, 29_400),
    // Also "Google" from Germany on a desktop: the rows show their hosts.
    mockSegment("google.de", "DE", "desktop", 240, 2, 2, 9_800),
    mockSegment("news.ycombinator.com", "US", "desktop", 780, 9, 9, 44_100),
    mockSegment("", "US", "desktop", 690, 5, 5, 24_500),
    mockSegment("google.com", "US", "mobile", 510, 2, 2, 9_800),
    mockSegment("chatgpt.com", "US", "desktop", 260, 4, 4, 39_600),
    mockSegment("news.ycombinator.com", "GB", "desktop", 230, 2, 2, 9_800),
    mockSegment("", "DE", "mobile", 410, 1, 1, 4_900),
    mockSegment("x.com", "US", "mobile", 180, 0, 0, 0),
    // Tiny, with one big order: 209 per visitor raw, and smoothing keeps it
    // from topping the list on the strength of one buyer.
    mockSegment("github.com", "DE", "desktop", 95, 1, 1, 19_900),
    mockSegment("", "GB", "mobile", 140, 0, 0, 0),
  ].sort(
    (a, b) =>
      b.smoothed_value_per_visitor_minor - a.smoothed_value_per_visitor_minor ||
      b.visitors - a.visitors
  ),
  hidden_segments: 48,
  thresholds: MOCK_SEGMENT_THRESHOLDS,
  prior: { k: MOCK_SEGMENT_K },
};

/** A day's worth: four buyers, under the minimum of ten. */
export const MOCK_REVENUE_SEGMENTS_INSUFFICIENT: RevenueSegmentsResponse = {
  meta: MOCK_SEGMENTS_META,
  status: "insufficient_data",
  currency: "USD",
  site: {
    visitors: 1_250,
    buyers: 4,
    orders: 4,
    revenue_minor: 24_100,
    unconverted_orders: 0,
    buyers_last_visit_before_range: 1,
    buyers_last_visit_missing: 0,
    conversion_rate: 4 / 1_250,
    value_per_visitor_minor: 24_100 / 1_250,
  },
  segments: [],
  hidden_segments: 0,
  thresholds: MOCK_SEGMENT_THRESHOLDS,
  prior: { k: MOCK_SEGMENT_K },
};
