'use client'

import * as React from 'react'
import { relativeTime } from '@/components/dashboard/data-state'
import { Button } from '@/components/ui/button'
import type { ErrorPresentation, MetaAdsConnection, MetaAdsConnectionState } from '@/lib/api'
import {
  normalizeAdAccountInput,
  validateMetaConnectInput,
  type MetaConnectProblems,
} from '@/lib/meta-ads'
import { cn } from '@/lib/utils'

/**
 * The Meta Ads block of Settings → Integrations, without its read or its
 * writes: what the container in `meta-ads-settings.tsx` draws and what the
 * tests render. Types only from `lib/api`, so it renders in the test runner
 * without the generated client.
 *
 * Three states, each its own screen rather than one form with flags:
 *
 * - **Not connected**: how to make the token, the two fields, and what is
 *   sent where. The instructions are the content, because a token made with
 *   the wrong access probes fine and reads nothing.
 * - **Connected**: which account, the token's ending, when it last synced.
 *   The token field stays closed until the owner asks to replace it. The
 *   status line warns when Meta reported the account disabled on connect, or
 *   when this install's keyring can't read the stored token.
 * - **Needs a new token**: Meta refused the stored one, syncing has stopped,
 *   and the token field is open with the account already filled in.
 */

export function metaAdsStatusLine(connection: MetaAdsConnection): string {
  if (connection.status === 'needs_reconnect') {
    return 'Syncing stopped: Meta refused the token. Paste a new one to start again.'
  }
  if (connection.last_error === 'credential_undecryptable') {
    return 'This install can’t read the saved token. Restore the encryption key, or reconnect.'
  }
  if (connection.ad_account_active === false) {
    return 'Meta reports this ad account as disabled, so there’s no new spend to read.'
  }
  switch (connection.last_error) {
    case 'rate_limited':
      return 'Meta asked us to slow down. The next sync waits until it’s allowed.'
    case 'unavailable':
      return 'The last sync failed: Meta didn’t answer. It tries again within an hour.'
    case 'invalid_response':
      return 'The last sync failed: Meta sent something we couldn’t read.'
    default: {
      const synced = relativeTime(connection.last_synced_at)
      return synced ? `Last synced ${synced}` : 'First sync in progress'
    }
  }
}

const inputClass =
  'h-9 w-full min-w-0 rounded-xl border border-input bg-white px-3 text-sm outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px] aria-invalid:border-destructive'

export type MetaConnectInput = { adAccountId: string; token: string }

/** The steps, in the order a person does them in Meta's own screens. */
function TokenSteps() {
  return (
    <ol className="flex list-decimal flex-col gap-1 pl-4 text-xs leading-5 text-muted-foreground marker:text-muted-foreground/70">
      <li>
        In Meta for Developers, create an app of the Business type and add it to the business that
        owns the ad account.
      </li>
      <li>
        In Meta Business Settings, add a System User and give it access to the ad account. Viewing
        performance is enough.
      </li>
      <li>
        Generate a token for that System User with the app, tick{' '}
        <code className="font-mono text-foreground/80">ads_read</code>, and choose a token that
        doesn’t expire.
      </li>
      <li>Paste the ad account id and the token below.</li>
    </ol>
  )
}

function ConnectFields({
  initialAccountId,
  accountLocked,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialAccountId: string
  accountLocked: boolean
  busy: boolean
  submitLabel: string
  onSubmit: (input: MetaConnectInput) => void
  onCancel?: () => void
}) {
  const [accountId, setAccountId] = React.useState(initialAccountId)
  const [token, setToken] = React.useState('')
  const [problems, setProblems] = React.useState<MetaConnectProblems>({})

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const found = validateMetaConnectInput({ adAccountId: accountId, token })
    setProblems(found)
    if (found.adAccountId || found.token) return
    onSubmit({
      adAccountId: normalizeAdAccountInput(accountId) ?? accountId.trim(),
      token: token.trim(),
    })
  }

  return (
    <form className="flex flex-col gap-3" noValidate onSubmit={submit}>
      {/* A replacement token is for the account named above it, so the
          id is not asked for again. */}
      {accountLocked ? null : (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Ad account id</span>
          <input
            aria-describedby={problems.adAccountId ? 'meta-ads-account-problem' : undefined}
            aria-invalid={problems.adAccountId ? true : undefined}
            autoComplete="off"
            className={inputClass}
            disabled={busy}
            id="meta-ads-account"
            onChange={(event) => {
              setAccountId(event.target.value)
              if (problems.adAccountId) setProblems({ ...problems, adAccountId: undefined })
            }}
            placeholder="act_1234567890"
            spellCheck={false}
            value={accountId}
          />
          {problems.adAccountId ? (
            <span
              className="text-xs leading-5 text-destructive-foreground"
              id="meta-ads-account-problem"
            >
              {problems.adAccountId}
            </span>
          ) : null}
        </label>
      )}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">System User token</span>
        <input
          aria-describedby={problems.token ? 'meta-ads-token-problem' : undefined}
          aria-invalid={problems.token ? true : undefined}
          autoComplete="off"
          className={inputClass}
          disabled={busy}
          id="meta-ads-token"
          onChange={(event) => {
            setToken(event.target.value)
            if (problems.token) setProblems({ ...problems, token: undefined })
          }}
          placeholder="EAAG…"
          spellCheck={false}
          type="password"
          value={token}
        />
        {problems.token ? (
          <span
            className="text-xs leading-5 text-destructive-foreground"
            id="meta-ads-token-problem"
          >
            {problems.token}
          </span>
        ) : null}
      </label>
      <div className="flex items-center gap-2">
        <Button loading={busy} size="sm" type="submit">
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button disabled={busy} onClick={onCancel} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
        ) : null}
        {busy ? (
          <span className="text-xs text-muted-foreground">Checking the token with Meta…</span>
        ) : null}
      </div>
    </form>
  )
}

/** What leaves the install, said where the owner decides to send it. */
function WhatIsSent() {
  return (
    <p className="text-xs leading-5 text-muted-foreground">
      The ad account id and the token are sent to{' '}
      <code className="font-mono text-foreground/80">graph.facebook.com</code> from this server
      only, every six hours, to read daily spend per campaign. The token is stored encrypted and
      never shown again.
    </p>
  )
}

export function MetaAdsSettingsForm({
  state,
  canManage,
  busy,
  error,
  unsupported,
  onConnect,
  onDisconnect,
}: {
  state: MetaAdsConnectionState
  canManage: boolean
  busy: boolean
  error: ErrorPresentation | null
  /** The deployment has no credential keyring, so it cannot store a token. */
  unsupported: boolean
  onConnect: (input: MetaConnectInput) => void
  onDisconnect: () => void
}) {
  const [replacing, setReplacing] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)

  const failure = (
    <>
      {unsupported ? (
        <p className="text-xs leading-5 text-muted-foreground" role="status">
          This deployment can’t store a token: it has no credential keyring configured. Nothing is
          wrong with yours.
        </p>
      ) : null}
      {error ? (
        <p className="text-xs leading-5 text-destructive-foreground" role="alert">
          <strong>{error.title}</strong> {error.body}
        </p>
      ) : null}
    </>
  )

  if (state.status === 'not_connected') {
    if (!canManage) {
      return (
        <p className="px-5 py-4 text-xs leading-5 text-muted-foreground">
          Only the site’s owner can see and connect Meta Ads.
        </p>
      )
    }
    return (
      <div className="flex flex-col gap-4 p-5">
        <div>
          <p className="text-sm font-medium">Connect a Meta ad account</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Spend per campaign beside the revenue each campaign brought in, matched by{' '}
            <code className="font-mono text-foreground/80">utm_campaign</code>.
          </p>
        </div>
        <TokenSteps />
        <ConnectFields
          accountLocked={false}
          busy={busy}
          initialAccountId=""
          onSubmit={onConnect}
          submitLabel="Connect"
        />
        {failure}
        <WhatIsSent />
      </div>
    )
  }

  const refused = state.status === 'needs_reconnect'
  const failed = refused || state.last_error !== null || state.ad_account_active === false
  const tokenOpen = canManage && (refused || replacing)

  return (
    <div>
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {state.ad_account_name || state.ad_account_id}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            <span className="font-mono">{state.ad_account_id}</span> · {state.currency} · Token
            ending {state.token_last4 || '—'}
          </p>
        </div>
      </div>

      {tokenOpen ? (
        <div className="flex flex-col gap-3 border-t border-border px-5 py-4">
          {refused ? null : (
            <p className="text-xs leading-5 text-muted-foreground">
              Paste a new token for the same System User. The spend already read stays.
            </p>
          )}
          <ConnectFields
            accountLocked
            busy={busy}
            initialAccountId={state.ad_account_id}
            onCancel={refused ? undefined : () => setReplacing(false)}
            onSubmit={onConnect}
            submitLabel={refused ? 'Reconnect' : 'Replace token'}
          />
          {failure}
        </div>
      ) : null}

      {canManage && !tokenOpen ? (
        <div className="flex flex-col gap-2 border-t border-border px-5 py-4">
          {confirming ? (
            <>
              <p className="text-xs leading-5 text-muted-foreground">
                The token and the spend read with it are deleted. Revenue is not touched. Connecting
                again reads the last 90 days.
              </p>
              <div className="flex items-center gap-2">
                <Button loading={busy} onClick={onDisconnect} size="sm" variant="destructive">
                  Yes, disconnect
                </Button>
                <Button onClick={() => setConfirming(false)} size="sm" variant="secondary">
                  Keep it
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <Button onClick={() => setReplacing(true)} size="sm" variant="secondary">
                Replace token
              </Button>
              <Button onClick={() => setConfirming(true)} size="sm" variant="secondary">
                Disconnect
              </Button>
            </div>
          )}
          {failure}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3 text-xs leading-5">
        <p
          className={cn(
            'flex items-center gap-1.5',
            failed ? 'text-warning-foreground' : 'text-muted-foreground',
          )}
        >
          <span
            aria-hidden="true"
            className={cn('size-1.5 rounded-full', failed ? 'bg-warning' : 'bg-success')}
          />
          {metaAdsStatusLine(state)}
        </p>
        {!canManage ? (
          <p className="text-muted-foreground">Only the site’s owner can change this.</p>
        ) : null}
      </div>
    </div>
  )
}
