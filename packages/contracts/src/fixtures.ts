import type { components } from './generated/api.ts'

/**
 * Typed example responses per analytics endpoint (plan Milestone 7 item 10).
 *
 * These exist so the frontend can build and render against a mock before the
 * backend is reachable (docs snapshot 03 §4: contract-and-fixtures first). Each
 * fixture is annotated with its generated schema type, so a contract change that
 * the fixture does not follow fails the contracts build — a fixture that has
 * drifted from the schema is worse than none, because it teaches the frontend a
 * shape the server will never send.
 *
 * They are deliberately small and deterministic; they are examples, not a data
 * generator.
 */

type Schemas = components['schemas']

const META: Schemas['AnalyticsMeta'] = {
  requested_range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' },
  effective_range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' },
  timezone: 'America/New_York',
  resolution: 'hour',
  // A live-only read, which is the shape every response had before imports
  // existed and the one the frontend renders by default (ADR-0032, D5).
  data_sources: ['live'],
  accuracy: 'exact',
  freshness: {
    state: 'ok',
    watermark: '2026-07-07T23:00:00.000Z',
    as_of: '2026-07-08T00:03:00.000Z',
  },
  comparison_range: { from: '2026-06-24T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
  truncated: false,
  cached: false,
  partial: false,
}

/**
 * The **public** query envelope (ADR-0039, D10): `META` without `freshness`.
 *
 * Built field by field rather than spread-and-deleted, for the same reason
 * `toPublicMeta` is: a field added to `AnalyticsMeta` tomorrow must not reach a
 * public fixture by inheritance, or the mock starts teaching the frontend a
 * shape the server refuses to send. `PublicAnalyticsMeta` is
 * `additionalProperties: false`, so a fixture carrying `freshness` is not merely
 * generous — it is invalid.
 */
const PUBLIC_META: Schemas['PublicAnalyticsMeta'] = {
  requested_range: META.requested_range,
  effective_range: META.effective_range,
  timezone: META.timezone,
  resolution: META.resolution,
  data_sources: META.data_sources,
  accuracy: META.accuracy,
  comparison_range: null,
  truncated: META.truncated,
  cached: META.cached,
  partial: META.partial,
}

export const analyticsOverviewFixture: Schemas['AnalyticsOverviewResponse'] = {
  meta: META,
  totals: { events: 48210, pageviews: 41003, visitors: 12874, billable_events: 45120 },
  comparison: {
    totals: { events: 44890, pageviews: 38221, visitors: 11940, billable_events: 41980 },
  },
}

export const analyticsTimeseriesFixture: Schemas['AnalyticsTimeseriesResponse'] = {
  meta: META,
  series: [
    { bucket: '2026-07-01T00:00:00.000Z', events: 1820, pageviews: 1560, visitors: 640 },
    { bucket: '2026-07-01T01:00:00.000Z', events: 1610, pageviews: 1402, visitors: 588 },
    { bucket: '2026-07-01T02:00:00.000Z', events: 1490, pageviews: 1300, visitors: 512 },
  ],
  comparison: {
    series: [
      { bucket: '2026-06-24T00:00:00.000Z', events: 1700, pageviews: 1450, visitors: 600 },
      { bucket: '2026-06-24T01:00:00.000Z', events: 1550, pageviews: 1330, visitors: 560 },
      { bucket: '2026-06-24T02:00:00.000Z', events: 1400, pageviews: 1220, visitors: 490 },
    ],
  },
}

export const analyticsPagesFixture: Schemas['AnalyticsPagesResponse'] = {
  meta: META,
  items: [
    {
      page_path: '/',
      views: 18402,
      visitors: 9210,
      entrances: 7104,
      exits: 3980,
      bounces: 3120,
      bounce_rate: 3120 / 7104,
    },
    {
      page_path: '/pricing',
      views: 6120,
      visitors: 4890,
      entrances: 1180,
      exits: 2240,
      bounces: 402,
      bounce_rate: 402 / 1180,
    },
    // A path no session ever began on: `entrances` is a measured zero, so the
    // rate has no denominator and is null rather than 0 (ADR-0075, D-E1).
    {
      page_path: '/blog/launch',
      views: 3210,
      visitors: 2980,
      entrances: 0,
      exits: 640,
      bounces: 0,
      bounce_rate: null,
    },
  ],
}

export const analyticsSourcesFixture: Schemas['AnalyticsSourcesResponse'] = {
  meta: META,
  items: [
    {
      referrer_domain: 'google.com',
      utm_source: '',
      utm_medium: 'organic',
      utm_campaign: '',
      channel: 'organic_search',
      views: 9120,
      visitors: 7010,
    },
    {
      referrer_domain: '',
      utm_source: 'newsletter',
      utm_medium: 'email',
      utm_campaign: 'july-launch',
      channel: 'email',
      views: 3120,
      visitors: 2880,
    },
  ],
}

export const analyticsGeographyFixture: Schemas['AnalyticsGeographyResponse'] = {
  meta: META,
  items: [
    { country: 'US', city: 'New York', views: 8120, visitors: 5010 },
    { country: 'DE', city: 'Berlin', views: 3120, visitors: 2410 },
    { country: 'GB', city: 'London', views: 2890, visitors: 2200 },
  ],
}

export const publicGeographyFixture: Schemas['PublicGeographyResponse'] = {
  meta: PUBLIC_META,
  items: [
    { country: 'US', city: 'New York', views: 8120, visitors: 5010, city_suppressed: false },
    { country: 'DE', city: null, views: 640, visitors: 190, city_suppressed: true },
  ],
}

export const analyticsDevicesFixture: Schemas['AnalyticsDevicesResponse'] = {
  meta: META,
  items: [
    { device_type: 'desktop', browser: 'Chrome', os: 'Windows', views: 12010, visitors: 8100 },
    { device_type: 'mobile', browser: 'Safari', os: 'iOS', views: 9800, visitors: 7020 },
  ],
}

export const analyticsCustomEventsFixture: Schemas['AnalyticsCustomEventsResponse'] = {
  meta: META,
  items: [
    {
      event_name: 'signup',
      event_type: 'conversion',
      events: 412,
      billable_events: 412,
      visitors: 398,
      display_name: null,
      display_template: null,
      // What one event last did (ADR-0038, D5). The properties are one event's
      // own bag, post-redaction, exactly as a `data-oa-prop-section` or a
      // `track()` call would have sent them.
      last_seen_at: '2026-07-20T10:24:31.118Z',
      sample_page_path: '/pricing',
      sample_properties: { section: 'hero', plan: 'pro' },
    },
    {
      event_name: 'add_to_cart',
      event_type: 'custom',
      events: 1820,
      billable_events: 1820,
      visitors: 1440,
      display_name: null,
      display_template: null,
      // The other half of the contract: a row whose range predates ClickHouse
      // migration 0021, or an imported name, honestly answers nothing.
      last_seen_at: null,
      sample_page_path: null,
      sample_properties: null,
    },
  ],
}

export const analyticsPerformanceFixture: Schemas['AnalyticsPerformanceResponse'] = {
  meta: META,
  items: [
    {
      metric: 'LCP',
      device_type: 'desktop',
      samples: 9800,
      mean: 1820.4,
      p50: 1700,
      p75: 2100,
      p90: 2600,
      p95: 3100,
      p99: 4200,
      good_samples: 7100,
      needs_improvement_samples: 2100,
      poor_samples: 600,
    },
  ],
}

export const analyticsSessionsFixture: Schemas['AnalyticsSessionsResponse'] = {
  meta: META,
  layering: {
    finalized_through: '2026-07-07T00:00:00.000Z',
    provisional_through: '2026-07-07T23:00:00.000Z',
  },
  totals: {
    sessions: 8120,
    engaged_sessions: 5210,
    bounced_sessions: 2910,
    bounce_rate: 0.3584,
    pageviews: 19840,
    avg_session_duration_ms: 84210,
    avg_active_duration_ms: 41180,
  },
  series: [
    {
      bucket: '2026-07-01T00:00:00.000Z',
      sessions: 640,
      engaged_sessions: 410,
      bounced_sessions: 230,
      bounce_rate: 0.3594,
      pageviews: 1580,
      avg_session_duration_ms: 82110,
      avg_active_duration_ms: 40120,
    },
    {
      bucket: '2026-07-01T01:00:00.000Z',
      sessions: 588,
      engaged_sessions: 372,
      bounced_sessions: 216,
      bounce_rate: 0.3673,
      pageviews: 1402,
      avg_session_duration_ms: 79980,
      avg_active_duration_ms: 39010,
    },
  ],
}

export const analyticsFunnelFixture: Schemas['AnalyticsFunnelResponse'] = {
  meta: {
    requested_range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' },
    timezone: 'America/New_York',
    scope: 'visitor',
    window_ms: 1_800_000,
    freshness: {
      state: 'ok',
      watermark: '2026-07-07T23:00:00.000Z',
      as_of: '2026-07-08T00:03:00.000Z',
    },
    cached: false,
  },
  steps: [
    { step: 1, key: '/pricing', count: 4200, conversion_rate: 1 },
    { step: 2, key: 'signup_started', count: 1890, conversion_rate: 0.45 },
    { step: 3, key: 'signup', count: 940, conversion_rate: 0.2238 },
  ],
}

/**
 * The public session read (ADR-0039, D4): the private fixture minus `layering`.
 *
 * Built by destructuring rather than retyping the numbers, so the two fixtures
 * cannot drift into disagreeing about what the same range contains — the public
 * surface withholds the finalizer's watermark, not a number.
 */
export const publicSessionsFixture: Schemas['PublicSessionsResponse'] = {
  meta: PUBLIC_META,
  totals: analyticsSessionsFixture.totals,
  series: analyticsSessionsFixture.series,
}

/**
 * The four reads whose **rows** are the private ones and whose **envelope** is
 * not (ADR-0039, D4 for the rows, D10 for the meta).
 *
 * They exist because the fixture map used to point these operations at the
 * private fixtures, whose `meta` still carries `freshness` — a key
 * `PublicAnalyticsMeta` rejects. Nothing caught it: the meta was passed by
 * reference, and TypeScript's excess-property check only fires on object
 * literals. The rows are shared with the private fixtures on purpose; the public
 * surface withholds a statement about our pipeline, not a number.
 */
export const publicTimeseriesFixture: Schemas['PublicTimeseriesResponse'] = {
  meta: PUBLIC_META,
  series: analyticsTimeseriesFixture.series,
  // Structurally present and always null: the public surface accepts no
  // `compare`, so this field has never carried anything else (ADR-0039, D8).
  comparison: null,
}

export const publicPagesFixture: Schemas['PublicPagesResponse'] = {
  meta: PUBLIC_META,
  items: analyticsPagesFixture.items,
}

export const publicSourcesFixture: Schemas['PublicSourcesResponse'] = {
  meta: PUBLIC_META,
  items: analyticsSourcesFixture.items,
}

export const publicDevicesFixture: Schemas['PublicDevicesResponse'] = {
  meta: PUBLIC_META,
  items: analyticsDevicesFixture.items,
}

/**
 * The public range totals (ADR-0039, decision 4 as amended).
 *
 * Field by field rather than spread from the private fixture, and deliberately
 * so: this fixture is the shape a frontend builds against, and a spread would
 * carry `billable_events` back in the day someone reordered the private one.
 * The numbers are the private fixture's own, because the public surface
 * withholds a billing quantity rather than reporting different traffic.
 */
export const publicOverviewFixture: Schemas['PublicOverviewResponse'] = {
  meta: PUBLIC_META,
  totals: {
    events: analyticsOverviewFixture.totals.events,
    pageviews: analyticsOverviewFixture.totals.pageviews,
    visitors: analyticsOverviewFixture.totals.visitors,
  },
}

/**
 * A partially shared dashboard: the chart and the totals are public, the
 * breakdowns are not. A fixture with every flag on would hide the case the
 * per-surface opt-in exists for (ADR-0039, D2) — a client must render a board
 * whose cards are individually missing, not an all-or-nothing one.
 */
export const publicDashboardSettingsFixture: Schemas['PublicDashboardSettings'] = {
  enabled: true,
  share_slug: 'sunny-otter-4821',
  share_overview: true,
  share_geography: false,
  share_realtime: false,
  share_timeseries: true,
  share_sessions: true,
  share_pages: false,
  share_sources: false,
  share_devices: false,
  share_identity: true,
}

/**
 * The public site-identity read with identity published (ADR-0044).
 *
 * The mock's default is the *named* case, because it is the one with four keys
 * and therefore the one a component can be built wrong against. The anonymous
 * case is `publicSiteIdentityAnonymousFixture` below, and a client that only
 * ever sees this one would never learn that the two identity keys can be
 * **absent** rather than null.
 */
export const publicSiteIdentityFixture: Schemas['PublicSiteIdentity'] = {
  display_name: 'Acme Metrics',
  favicon_domain: 'acme.example',
  reporting_timezone: 'Asia/Baku',
  first_event_at: '2026-06-02T08:14:09.221Z',
}

/**
 * The same read on a share whose owner has **not** opted identity in.
 *
 * The two identity keys are missing from the object entirely — not `null` — and
 * that is the whole point of the fixture: `display_name` and `favicon_domain`
 * are optional in the schema, so this object is as valid as the one above, and
 * a component that reads `body.display_name ?? 'Shared dashboard'` behaves
 * correctly while one that reads `body.display_name === null` does not
 * (ADR-0044, D1). The two rendering facts are still here, because an anonymous
 * share still has to cut its buckets and anchor "All time".
 */
export const publicSiteIdentityAnonymousFixture: Schemas['PublicSiteIdentity'] = {
  reporting_timezone: 'Asia/Baku',
  first_event_at: '2026-06-02T08:14:09.221Z',
}

export const realtimeTokenResponseFixture: Schemas['RealtimeTokenResponse'] = {
  token: 'OA1-RT1.eyJ2IjoxfQ.c2lnbmF0dXJl',
  expires_at: '2026-07-20T10:31:00.000Z',
  epoch_check_seconds: 15,
}

export const realtimeSnapshotFixture: Schemas['RealtimeSnapshot'] = {
  type: 'snapshot',
  generated_at: '2026-07-20T10:30:00.000Z',
  active_visitors: 128,
  pages: [
    { path: '/', visitors: 61 },
    { path: '/pricing', visitors: 24 },
    { path: '/blog/launch', visitors: 11 },
  ],
  countries: [
    { country: 'US', visitors: 54 },
    { country: 'DE', visitors: 18 },
    { country: 'unknown', visitors: 7 },
  ],
  devices: [
    { device_type: 'desktop', visitors: 74 },
    { device_type: 'mobile', visitors: 48 },
    { device_type: 'tablet', visitors: 4 },
    { device_type: 'unknown', visitors: 2 },
  ],
  browsers: [
    { browser: 'chrome', visitors: 70 },
    { browser: 'safari', visitors: 33 },
    { browser: 'firefox', visitors: 15 },
  ],
  operating_systems: [
    { os: 'windows', visitors: 52 },
    { os: 'macos', visitors: 39 },
    { os: 'ios', visitors: 24 },
  ],
  cities: [
    { city: 'New York', visitors: 21 },
    { city: 'Berlin', visitors: 12 },
  ],
  events: [
    {
      event_id: '3f1c0a3e-6d1a-4a2b-9f27-2b8c5c1e7a01',
      occurred_at: '2026-07-20T10:29:58.400Z',
      visitor: 'b2d1f0c9a8e7',
      path: '/pricing',
      country: 'US',
      device_type: 'desktop',
      browser: 'chrome',
      os: 'windows',
      referrer: 'news.ycombinator.com',
    },
    {
      event_id: '9a4e2b77-0c53-4f18-8d6a-1c9f4e2b7701',
      occurred_at: '2026-07-20T10:29:51.100Z',
      visitor: '77aa10ffbc31',
      path: '/',
      // Geo and UA are both absent here on purpose: `null` is "not recorded",
      // which is a different statement from the `unknown` bucket.
      country: null,
      device_type: null,
      browser: null,
      os: null,
      referrer: null,
    },
  ],
  present: [
    {
      // The same visitor as the newest feed event — a `present` row and a feed
      // event join on this field, which is how a row gets its page history.
      visitor: 'b2d1f0c9a8e7',
      last_seen_at: '2026-07-20T10:29:58.400Z',
      path: '/pricing',
      country: 'US',
      device_type: 'desktop',
      browser: 'chrome',
      os: 'windows',
    },
    {
      // A visitor the feed cannot name: present on heartbeats alone, their last
      // page view long since aged out. This row is the whole point of `present`
      // — before it, this person was an anonymous `+1` on the board.
      visitor: 'c40b9e17d2aa',
      last_seen_at: '2026-07-20T10:29:44.000Z',
      path: '/docs/install',
      country: null,
      device_type: 'mobile',
      browser: null,
      os: null,
    },
  ],
}

export const publicRealtimeSnapshotFixture: Schemas['PublicRealtimeSnapshot'] = {
  type: 'snapshot',
  generated_at: '2026-07-20T10:30:00.000Z',
  active_visitors: 128,
}

export const realtimeControlFixture: Schemas['RealtimeControl'] = {
  type: 'control',
  action: 'disconnect',
  reason: 'access_revoked',
}

export const createdSiteFixture: Schemas['CreatedSite'] = {
  site_id: '019f8740-2b3c-7a10-9c1d-4e5f6a7b8c9d',
  slug: 'acme-metrics',
  name: 'Acme Metrics',
  status: 'active',
  role: 'owner',
  is_billing_owner: true,
  tracking_key: {
    id: '019f8740-2b3c-7a10-9c1d-4e5f6a7b8cae',
    public_token: 'oa_pk_7f3a91c25be84d0fa1c6d2e5b8074391',
    key_prefix: 'oa_pk_7f3a',
  },
  created_at: '2026-07-01T09:30:00.000Z',
}

export const siteInviteFixture: Schemas['SiteInvite'] = {
  invite_id: '019f8740-2b3c-7a10-9c1d-4e5f6a7b8cbf',
  email: 'teammate@example.com',
  role: 'admin',
  invited_by_user_id: '019f8740-2b3c-7a10-9c1d-4e5f6a7b8c11',
  created_at: '2026-07-20T10:30:00.000Z',
  expires_at: '2026-07-27T10:30:00.000Z',
  status: 'pending',
}

export const expiredSiteInviteFixture: Schemas['SiteInvite'] = {
  invite_id: '019f8740-2b3c-7a10-9c1d-4e5f6a7b8cc0',
  email: 'lapsed@example.com',
  role: 'viewer',
  invited_by_user_id: '019f8740-2b3c-7a10-9c1d-4e5f6a7b8c11',
  created_at: '2026-07-01T10:30:00.000Z',
  // In the past relative to `siteInviteFixture`: the row a manager resends.
  expires_at: '2026-07-08T10:30:00.000Z',
  status: 'expired',
}

export const inviteResentFixture: Schemas['InviteResent'] = {
  invite_id: '019f8740-2b3c-7a10-9c1d-4e5f6a7b8cc0',
  expires_at: '2026-08-04T10:30:00.000Z',
  status: 'pending',
}

/**
 * A saved funnel definition. Note what it does *not* carry: no counts, no
 * conversion rates, no range. Computing it is a separate call to
 * `GET /v1/sites/{site_id}/analytics/funnel`, whose response fixture is
 * `analyticsFunnelFixture`.
 */
export const funnelDefinitionFixture: Schemas['FunnelDefinition'] = {
  id: '019f8740-2b3c-7a10-9c1d-4e5f6a7b8cc0',
  name: 'Checkout',
  steps: ['/pricing', '/signup', '/checkout', 'purchase'],
  scope: 'visitor',
  window_ms: 604800000,
  created_by_user_id: '019f8740-2b3c-7a10-9c1d-4e5f6a7b8c11',
  created_at: '2026-07-20T10:30:00.000Z',
  updated_at: '2026-07-20T10:30:00.000Z',
  // Null is the statement "this definition is live".
  archived_at: null,
}

/**
 * A widget as its owner sees it (ADR-0045).
 *
 * Configuration only — no numbers, exactly like `funnelDefinitionFixture`. The
 * origin allowlist is a real list rather than `["*"]`, because `*` is the case
 * that needs no client handling and an empty list is the case that renders
 * nowhere; a named origin is the one an owner actually configures.
 */
export const widgetFixture: Schemas['Widget'] = {
  id: 'w3f9xk21qm70c4bd',
  surface: 'pages',
  title: 'Most read this week',
  range: '7d',
  limit: 5,
  allowed_origins: ['https://shop.example.com'],
  enabled: true,
  embed_url: 'https://api.getopen.so/embed/w3f9xk21qm70c4bd',
  embed_snippet:
    '<iframe src="https://api.getopen.so/embed/w3f9xk21qm70c4bd" title="Most read this week" width="100%" height="320" loading="lazy" style="border:0;color-scheme:normal"></iframe>',
  created_by_user_id: '019f8740-2b3c-7a10-9c1d-4e5f6a7b8c11',
  created_at: '2026-08-07T09:12:00.000Z',
  updated_at: '2026-08-07T09:12:00.000Z',
}

/**
 * The anonymous widget read (ADR-0045, D3).
 *
 * `data` is `publicPagesFixture` **verbatim** — the same object the public share
 * surface serves for the same surface — which is the property the envelope
 * exists to preserve: one card component renders a share and a widget from one
 * code path. A client picks that component from `widget.surface` and never from
 * the shape of `data`, because `pages`, `sources` and `devices` are all
 * `{meta, items}`.
 */
export const publicWidgetFixture: Schemas['PublicWidgetResponse'] = {
  widget: {
    surface: widgetFixture.surface,
    title: widgetFixture.title,
    range: widgetFixture.range,
    limit: widgetFixture.limit,
  },
  data: publicPagesFixture,
}

/**
 * The other end of the widget contract: a `realtime` widget.
 *
 * It is the fixture that carries `range: null` and `limit: null`, which no other
 * surface does — a mock that only served the `pages` case would let a renderer
 * be built that assumes a widget always has a window. Its `data` is the
 * `active_visitors`-only payload (ADR-0024, D7), polled rather than streamed.
 */
export const publicRealtimeWidgetFixture: Schemas['PublicWidgetResponse'] = {
  widget: {
    surface: 'realtime',
    title: 'Reading right now',
    range: null,
    limit: null,
  },
  data: publicRealtimeSnapshotFixture,
}

/**
 * A user who has chosen a zone. The unset case is `{ timezone: null }` and is
 * the state every existing account starts in (ADR-0026) — a mock that only ever
 * returns this fixture would never exercise the browser-default fallback, which
 * is the branch most accounts actually take.
 */
export const userPreferencesFixture: Schemas['UserPreferences'] = {
  timezone: 'Asia/Baku',
}

/** All fixtures, keyed by endpoint operationId, for a mock server or MSW handler. */
export const ANALYTICS_FIXTURES = {
  getAnalyticsOverview: analyticsOverviewFixture,
  getAnalyticsTimeseries: analyticsTimeseriesFixture,
  getAnalyticsPages: analyticsPagesFixture,
  getAnalyticsSources: analyticsSourcesFixture,
  getAnalyticsGeography: analyticsGeographyFixture,
  getAnalyticsDevices: analyticsDevicesFixture,
  getAnalyticsCustomEvents: analyticsCustomEventsFixture,
  getAnalyticsPerformance: analyticsPerformanceFixture,
  getAnalyticsSessions: analyticsSessionsFixture,
  getAnalyticsFunnel: analyticsFunnelFixture,
  getPublicOverview: publicOverviewFixture,
  getPublicGeography: publicGeographyFixture,
  // Every public read serves `PublicAnalyticsMeta`, so every one of them needs
  // its own fixture. The four ADR-0039 reads used to point at the private
  // fixtures here, on the strength of D4's "the rows are the same" — which was
  // true of the rows and never of the envelope D10 later narrowed.
  getPublicTimeseries: publicTimeseriesFixture,
  getPublicSessions: publicSessionsFixture,
  getPublicPages: publicPagesFixture,
  getPublicSources: publicSourcesFixture,
  getPublicDevices: publicDevicesFixture,
  // The identity-published case (ADR-0044). A mock that served the anonymous
  // one would let a board be built that never renders a name at all.
  getPublicSiteIdentity: publicSiteIdentityFixture,
  getPublicDashboardSettings: publicDashboardSettingsFixture,
  // The widget surface (ADR-0045): one configured widget, and the anonymous read
  // of it. `publicRealtimeWidgetFixture` is the `range: null` case and is
  // exported on its own rather than mapped, since one operation has one fixture.
  getSiteWidget: widgetFixture,
  getPublicWidget: publicWidgetFixture,
  createSite: createdSiteFixture,
  getUserPreferences: userPreferencesFixture,
} as const
