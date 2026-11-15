"use client";

import { Cancel01Icon } from "hugeicons-react";
import * as React from "react";
import { relativeTime } from "@/components/dashboard/data-state";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ErrorPresentation, SiteMentionSettings } from "@/lib/api";
import {
  MAX_TERM_LENGTH,
  MAX_TERMS,
  validateNewTerm,
} from "@/lib/mentions";
import { cn } from "@/lib/utils";

/**
 * The Mentions settings block without its read or its writes: what the
 * container in `mention-settings.tsx` draws and what the tests render. It
 * imports no runtime from `lib/api`, so it renders in the test runner without
 * the generated client.
 */

export function mentionStatusLine(settings: SiteMentionSettings): string {
  if (settings.last_error === "unavailable") {
    return "The last check failed: the X search service didn't answer.";
  }
  if (settings.last_error === "invalid_response") {
    return "The last check failed: the X search service sent something we couldn't read.";
  }
  const checked = relativeTime(settings.last_polled_at);
  return checked ? `Last checked ${checked}` : "Not checked yet";
}

const inputClass =
  "h-9 min-w-0 flex-1 rounded-xl border border-input bg-white px-3 text-sm outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px] aria-invalid:border-destructive";

/** The block itself, without the read: what the tests render. */
export function MentionSettingsForm({
  settings,
  canEdit,
  busy,
  error,
  onToggle,
  onTermsChange,
}: {
  settings: SiteMentionSettings;
  canEdit: boolean;
  busy: boolean;
  error: ErrorPresentation | null;
  onToggle: (enabled: boolean) => void;
  onTermsChange: (terms: string[]) => void;
}) {
  const [draft, setDraft] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const { domain, terms } = settings;
  const full = terms.length >= MAX_TERMS;
  const failed = settings.last_error !== null;
  // Watching needs something to search: the server refuses x_enabled with no
  // domain and no terms, so the switch says why instead of failing.
  const hasDomain = domain !== "";
  const nothingToSearch = !hasDomain && terms.length === 0;
  const lastTermLocked = !hasDomain && settings.x_enabled && terms.length === 1;

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateNewTerm(draft, terms, domain);
    setProblem(found);
    if (found) return;
    onTermsChange([...terms, draft.trim()]);
    setDraft("");
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <p className="text-sm font-medium" id="mention-watch-label">
            Watch X for mentions
          </p>
          <p
            className="mt-1 text-xs leading-5 text-muted-foreground"
            id="mention-watch-description"
          >
            {/* One string, not JSX text around `{domain}`: the dev build
                dropped the space after the first interpolation. */}
            {hasDomain
              ? `Searches X for posts that mention ${domain} and the terms below. When it's on, ${domain} and your terms are sent to the X search service on each check. Nothing about your visitors is sent.`
              : "Searches X for posts that mention the terms below. When it's on, your terms are sent to the X search service on each check. Nothing about your visitors is sent."}
          </p>
        </div>
        <Switch
          aria-describedby="mention-watch-description"
          aria-labelledby="mention-watch-label"
          checked={settings.x_enabled}
          className="mt-0.5"
          disabled={!canEdit || busy || (!settings.x_enabled && nothingToSearch)}
          onCheckedChange={(next: boolean) => onToggle(next)}
        />
      </div>

      <div className="flex flex-col gap-3 px-5 py-4">
        <div>
          <p className="text-sm font-medium" id="mention-terms-label">
            Search terms
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Up to {MAX_TERMS}, for example your product name.
            {hasDomain ? ` ${domain} is always searched.` : null}
          </p>
          {canEdit && nothingToSearch ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Add a domain to the site or at least one term first.
            </p>
          ) : null}
        </div>

        {terms.length > 0 ? (
          <ul aria-labelledby="mention-terms-label" className="flex flex-wrap gap-1.5">
            {terms.map((term) => (
              <li
                className={cn(
                  "flex h-7 items-center gap-1 rounded-full border border-border bg-white text-xs",
                  canEdit ? "pl-2.5 pr-1" : "px-2.5"
                )}
                key={term}
              >
                <span className="max-w-48 truncate">{term}</span>
                {canEdit ? (
                  <button
                    aria-label={`Remove ${term}`}
                    className="flex size-5 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-black/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                    disabled={busy || lastTermLocked}
                    onClick={() =>
                      onTermsChange(terms.filter((entry) => entry !== term))
                    }
                    type="button"
                  >
                    <Cancel01Icon className="size-3" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No extra terms.</p>
        )}

        {canEdit ? (
          <form className="flex flex-col gap-1.5" noValidate onSubmit={add}>
            <div className="flex items-center gap-2">
              <input
                aria-describedby={problem ? "mention-term-problem" : undefined}
                aria-invalid={problem ? true : undefined}
                aria-labelledby="mention-terms-label"
                className={inputClass}
                disabled={busy || full}
                id="mention-term-input"
                maxLength={MAX_TERM_LENGTH + 1}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (problem) setProblem(null);
                }}
                placeholder={full ? `${MAX_TERMS} of ${MAX_TERMS} terms` : "OpenAnalytics"}
                value={draft}
              />
              <Button
                disabled={busy || full || draft.trim() === ""}
                size="sm"
                type="submit"
                variant="secondary"
              >
                Add
              </Button>
            </div>
            {problem ? (
              <p
                className="text-xs leading-5 text-destructive-foreground"
                id="mention-term-problem"
              >
                {problem}
              </p>
            ) : null}
          </form>
        ) : null}

        {error ? (
          <p className="text-xs leading-5 text-destructive-foreground" role="alert">
            <strong>{error.title}</strong> {error.body}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3 text-xs leading-5">
        <p
          className={cn(
            "flex items-center gap-1.5",
            failed ? "text-warning-foreground" : "text-muted-foreground"
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              failed
                ? "bg-warning"
                : settings.x_enabled
                  ? "bg-success"
                  : "bg-muted-foreground/40"
            )}
          />
          {mentionStatusLine(settings)}
        </p>
        {!canEdit ? (
          <p className="text-muted-foreground">
            Only an owner or admin can change this.
          </p>
        ) : null}
      </div>
    </div>
  );
}
