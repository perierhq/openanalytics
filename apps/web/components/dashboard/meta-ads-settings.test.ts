import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { MetaAdsConnection, MetaAdsConnectionState } from "@/lib/api"
import { MetaAdsSettingsForm, metaAdsStatusLine } from "./meta-ads-settings-form"

const connected = (overrides: Partial<MetaAdsConnection> = {}): MetaAdsConnection => ({
  status: "active",
  ad_account_id: "act_1234567890",
  ad_account_name: "Acme Ads",
  ad_account_active: true,
  currency: "USD",
  token_last4: "Wq9z",
  connected_at: "2026-11-20T10:00:00.000Z",
  last_attempted_at: null,
  last_synced_at: null,
  next_sync_at: "2026-11-20T10:00:00.000Z",
  last_error: null,
  ...overrides,
})

const render = (state: MetaAdsConnectionState, canManage = true) =>
  renderToStaticMarkup(
    createElement(MetaAdsSettingsForm, {
      state,
      canManage,
      busy: false,
      error: null,
      unsupported: false,
      onConnect: () => {},
      onDisconnect: () => {},
    })
  )

describe("not connected", () => {
  it("explains how to make a System User token with ads_read, and asks for the id and the token", () => {
    const html = render({ status: "not_connected" })
    expect(html).toContain("System User")
    expect(html).toContain("ads_read")
    expect(html).toMatch(/<input[^>]*id="meta-ads-account"/)
    expect(html).toMatch(/<input[^>]*id="meta-ads-token"[^>]*type="password"|<input[^>]*type="password"[^>]*id="meta-ads-token"/)
    expect(html).toContain("graph.facebook.com")
    expect(html).toContain(">Connect<")
  })

  it("shows anyone but the owner why there is nothing to do", () => {
    const html = render({ status: "not_connected" }, false)
    expect(html).toContain("Only the site’s owner can see and connect Meta Ads.")
    expect(html).not.toContain("meta-ads-token")
  })
})

describe("connected", () => {
  it("names the account and the token's ending, and offers to disconnect", () => {
    const html = render(connected({ last_synced_at: new Date(Date.now() - 5 * 60_000).toISOString() }))
    expect(html).toContain("Acme Ads")
    expect(html).toContain("act_1234567890")
    expect(html).toContain("Token ending Wq9z")
    expect(html).toContain("Last synced 5 min ago")
    expect(html).toContain("Disconnect")
    expect(html).not.toMatch(/<input[^>]*id="meta-ads-account"/)
  })

  it("never renders the token field until asked to replace it", () => {
    expect(render(connected())).not.toContain("meta-ads-token")
  })
})

describe("error", () => {
  it("asks for a new token when Meta refused the old one, keeping the account", () => {
    const html = render(connected({ status: "needs_reconnect", last_error: "unauthorized" }))
    expect(html).toContain("Syncing stopped: Meta refused the token. Paste a new one to start again.")
    expect(html).toMatch(/<input[^>]*id="meta-ads-token"/)
    expect(html).toContain("act_1234567890")
    expect(html).not.toMatch(/<input[^>]*id="meta-ads-account"/)
  })

  it("tells the owner when this install can't read the saved token, keeping the replace option", () => {
    const html = render(connected({ last_error: "credential_undecryptable" }))
    expect(html).toContain(
      "This install can’t read the saved token. Restore the encryption key, or reconnect."
    )
    expect(html).toContain("Replace token")
  })

  it("says the account is disabled when Meta reported it so on connect", () => {
    const html = render(connected({ ad_account_active: false }))
    expect(html).toContain("Meta reports this ad account as disabled, so there’s no new spend to read.")
  })

  it("says plainly when a sync failed and that it will try again", () => {
    const html = render(connected({ last_error: "unavailable" }))
    expect(html).toContain("The last sync failed: Meta didn’t answer. It tries again within an hour.")
  })
})

describe("the status line", () => {
  it("covers every state in plain words", () => {
    expect(metaAdsStatusLine(connected())).toBe("First sync in progress")
    expect(metaAdsStatusLine(connected({ last_error: "rate_limited" }))).toBe(
      "Meta asked us to slow down. The next sync waits until it’s allowed."
    )
    expect(metaAdsStatusLine(connected({ last_error: "invalid_response" }))).toBe(
      "The last sync failed: Meta sent something we couldn’t read."
    )
    expect(
      metaAdsStatusLine(connected({ status: "needs_reconnect", last_error: "unauthorized" }))
    ).toBe("Syncing stopped: Meta refused the token. Paste a new one to start again.")
    expect(metaAdsStatusLine(connected({ last_error: "credential_undecryptable" }))).toBe(
      "This install can’t read the saved token. Restore the encryption key, or reconnect."
    )
    expect(metaAdsStatusLine(connected({ ad_account_active: false }))).toBe(
      "Meta reports this ad account as disabled, so there’s no new spend to read."
    )
    // A null status (Meta didn't say) is not a warning.
    expect(metaAdsStatusLine(connected({ ad_account_active: null }))).toBe("First sync in progress")
  })
})
