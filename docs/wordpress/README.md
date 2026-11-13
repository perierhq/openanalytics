# WordPress integration contract

What the plugin talks to, and what the backend promises it. The design and its
reasoning are recorded in ADR-0042, which is kept outside this repository;
this file is the working document a plugin author codes against.

**Scope.** M14 shipped the backend half. The PHP plugin is written elsewhere,
against this contract. Every response shape here is generated from
`packages/contracts/openapi/openapi.yaml`, and a recorded set of real responses
lives beside this file in [`fixtures.json`](fixtures.json) — produced by driving
the actual app in a test, so it cannot drift from what the API returns.

---

## 1. The credential

One credential does everything the plugin does from PHP: a **private read key**
(`oa_sk_…`), minted in the dashboard by someone with the `credentials:manage`
capability.

- The raw token is shown **once**, at creation. Only its SHA-256 hash is stored;
  there is no endpoint that returns it again. The plugin stores it in
  `wp_options` (or better, a constant in `wp-config.php`) and it never reaches
  the browser.
- It is bound to **one site**. There is no `site_id` anywhere in the paths below
  — the key names the site.
- It is revocable and can carry an expiry. Both take effect on the next request.

### Scopes

| Scope            | What it opens                                        |
| ---------------- | ---------------------------------------------------- |
| `site:read`      | `GET /v1/read/site` — the site context and `install` |
| `analytics:read` | the seven reads under `/v1/read/analytics/`          |

`site:read` is the minimum and the default. A key minted without naming scopes
gets exactly that, and a key minted before scopes existed reads the same way —
so **an existing key will not have `analytics:read`**, and the plugin's setup
screen has to say so rather than assume.

```
POST /v1/sites/{site_id}/keys
{ "type": "private_read", "name": "WordPress — shop.example.com",
  "scopes": ["site:read", "analytics:read"] }
```

`site:read` is folded in automatically. An unknown scope name, an empty array,
or `scopes` on a `tracking_write` key are each a `400 VALIDATION_FAILED` naming
the field — the key is not minted narrow and left to fail later.

### Rotation and revocation

There is no rotate verb, deliberately. Rotation is **mint the new key, switch the
plugin, revoke the old one** — two keys are live at once, so the site is never
without a working credential. A single-call rotate that invalidated the old key
immediately would be an outage with a friendly name.

`GET /v1/sites/{site_id}/keys` shows `last_used_at`, refreshed at minute
granularity, which is how an administrator tells the live key from two dead ones
before revoking.

### Authentication and its refusals

`Authorization: Bearer oa_sk_…` on every request below.

| Status | Meaning                                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `401`  | No key, a malformed key, a revoked/expired key, or a `tracking_write` key                                                     |
| `403`  | The key is valid; it does not carry the scope this read needs. **Do not re-check the token** — mint one with `analytics:read` |
| `402`  | The site is `billing_blocked`. Analytics is closed until billing is restored                                                  |
| `404`  | The site is being deleted, or is gone                                                                                         |
| `429`  | The key spent its budget. `Retry-After` says when                                                                             |
| `503`  | The deployment's query gateway is unavailable. Retryable                                                                      |

The budget is **per key**, 60 requests per minute with a burst of 120 — not per
IP address, so a plugin on a shared host is not charged for its neighbours.

---

## 2. Site selection and installing the tracker

```
GET /v1/read/site
```

```jsonc
{
  "site_id": "…",
  "slug": "shop",
  "name": "Shop",
  "status": "active",
  "install": {
    "tracking_key": "oa_pk_…", // may be null
    "script_url": "https://c.getopen.so/oa.js",
    "collector_url": "https://c.getopen.so",
  },
}
```

This is the site-selection contract: the plugin asks which site its key belongs
to and renders `name`, rather than being configured with a site id an
administrator could paste wrong.

`install` is what the plugin needs to inject the tracker without a dashboard
session. Render exactly:

```html
<script
  async
  src="{script_url}"
  data-key="{tracking_key}"
  data-collector="{collector_url}"
></script>
```

- **`tracking_key` is public.** It ships in the HTML of every page — it is an
  ingest identifier and is accepted on no read endpoint. Do not treat it like the
  read key.
- Any member of `install` may be `null`. `tracking_key: null` means the site has
  no live tracking key and the plugin should say so instead of emitting a broken
  tag. `script_url`/`collector_url` are `null` when the deployment has not been
  told its collector's public origin — fall back to the plugin's own setting.
- Put the tag in `<head>`. `async` is deliberate: the tracker records the first
  pageview immediately and folds in the site's configuration afterwards.

See [`../frontend/tracker_snippet.md`](../frontend/tracker_snippet.md) for the
optional attributes (consent flags, `data-oa-event`).

### The config cache

The tracker fetches `GET /v1/tracker/config` itself; the plugin does not proxy
it. It carries `ETag` and `Cache-Control: public, max-age=300,
stale-while-revalidate=3600`, keyed on the site's `config_version`, so a
dashboard change reaches browsers without a plugin update.

If the plugin caches anything of its own — the install block, say — cache it in
`wp_options` with a short TTL and **honour the response's `ETag`**. Do not cache
the read key's responses across administrators.

---

## 3. Reading statistics

Seven reads, all `GET`, all requiring `analytics:read`:

```
/v1/read/analytics/overview      ?from&to&timezone[&compare][&resolution]
/v1/read/analytics/timeseries    ?from&to&timezone[&compare][&resolution]
/v1/read/analytics/pages         ?from&to&timezone[&limit]
/v1/read/analytics/sources       ?from&to&timezone[&limit]
/v1/read/analytics/geography     ?from&to&timezone[&limit]
/v1/read/analytics/devices       ?from&to&timezone[&limit]
/v1/read/analytics/sessions      ?from&to&timezone
```

- `from`/`to` are ISO-8601 **UTC** instants; `timezone` is an IANA identifier
  and is what the buckets are aligned to.
- `resolution` is `minute | hour | day | week`. **Send it.** Automatic selection
  returns `minute` grain for a 24-hour range — about 1 440 buckets for a chart
  that wants a few dozen — and per-bucket `visitors` are _not summable_, so
  re-bucketing client-side over-counts. Ask for `hour` on a day, `day` on a
  month, `week` on a year.
- `limit` on the top-N reports is 1–500, default 100.

These are the same responses the dashboard renders, including `meta.freshness`
(how far the pipeline has caught up) and, on `sessions`, `layering` (the
watermark past which numbers can still be revised). Show freshness somewhere: an
unattended screen has nobody to ask why a number looks low.

**What a key cannot read:** individual visitors (`recent-visitors`, `visitor`),
revenue, custom events, funnels and web vitals. None of these is behind a scope
you can request — they are not on this surface at all.

### Response compatibility

The surface is versioned `/v1` and grows additively. The plugin's obligation is
the other direction: **ignore unknown fields and never fail on one.** A field
appearing in a response is not a breaking change and will not be announced.

---

## 4. Sending events from PHP

The plugin's normal path is the **browser tracker** — the script tag above. Read
this section only if something server-side needs to send events too.

**Idempotency already holds, for any sender.** Every event carries a
client-minted UUIDv7 `event_id`, created _before_ the first send attempt so a
lost response still deduplicates. A retry inside the dedup window is a `202`
counted as `duplicate`; the same id with a different payload is a `409
IDEMPOTENCY_CONFLICT` and nothing from that request is stored.

Two things will bite a server-side sender, and neither produces an error you can
see:

1. **The domain allowlist.** If the site has configured domains, an
   `Origin`-less request is refused with `403` — the allowlist is a browser
   instrument and a caller with no `Origin` is indistinguishable from a forged
   browser request that stripped it. A site with **no** configured domains
   accepts server-side events today. There is no per-sender credential that
   would let a site keep the allowlist _and_ accept PHP; ADR-0042 D10 records why
   M14 did not invent one, and what building it would take.
2. **Bot filtering.** A filtered request answers `202` and stores nothing. An
   unrecognized agent — WordPress's own `WordPress/6.5; https://…` — is _not_
   filtered; an agent string containing a crawler signature is. If a
   server-side chart stays at zero with no errors, this is the first thing to
   check.

Set `client.sdk = "wordpress"` and `client.sdk_version` to the plugin's version.
Both reach the stored event, which is how a plugin release is visible in event
context, and neither has ever changed shape — a plugin update cannot break an
older event schema.

---

## 5. Checklist for the plugin

- [ ] Store the read key outside the browser; never print it in admin HTML.
- [ ] On save, call `GET /v1/read/site` and show `name` — that is the "connected
      to" confirmation, and it validates the key in the same call.
- [ ] Treat `403` as "this key lacks `analytics:read`", with a link to mint one.
- [ ] Render the snippet from `install`, and say something honest when
      `tracking_key` is `null`.
- [ ] Always send `resolution` on `overview` and `timeseries`.
- [ ] Show `meta.freshness`.
- [ ] Back off on `429` using `Retry-After`; do not poll faster than the screen
      is looked at.
- [ ] Ignore unknown response fields.
