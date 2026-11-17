"use client";

import { ArrowDown01Icon, Cancel01Icon } from "hugeicons-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import type { ErrorPresentation } from "@/lib/api";
import {
  EXCLUSION_LIMITS,
  checkNewExclusion,
  countryName,
  exclusionCountryOptions,
  type ExclusionKind,
  type ExclusionLists,
} from "@/lib/exclusions";
import { cn } from "@/lib/utils";

/**
 * Settings → General → Exclusions, without its read or its writes: what the
 * container in `exclusions-panel.tsx` draws and what the tests render. It
 * imports no runtime from `lib/api`, so it renders in the test runner without
 * the generated client.
 *
 * Four lists, one editor each, built like the mention terms editor: chips you
 * can remove, a field and an Add button under them, and the reason a value
 * was refused under the field it was typed into. Countries are picked from a
 * list rather than typed, so there is nothing to get wrong.
 */

const inputClass =
  "h-9 min-w-0 flex-1 rounded-xl border border-input bg-white px-3 text-sm outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px] aria-invalid:border-destructive";

const LISTS: {
  kind: ExclusionKind;
  title: string;
  description: string;
  placeholder: string;
  /** Addresses, paths and hosts are data, and read as such. */
  mono: boolean;
}[] = [
  {
    kind: "ip_ranges",
    title: "IP addresses",
    description:
      "Visits from these addresses aren't counted. Use it for your office or your own devices. Enter one address, or a range like 203.0.113.0/24.",
    placeholder: "203.0.113.7",
    mono: true,
  },
  {
    kind: "paths",
    title: "Pages",
    description:
      "Visits to these paths aren't counted. * matches anything, so /admin/* covers every page under /admin/.",
    placeholder: "/admin/*",
    mono: true,
  },
  {
    kind: "countries",
    title: "Countries",
    description: "Visits from these countries aren't counted.",
    placeholder: "",
    mono: false,
  },
  {
    kind: "hostnames",
    title: "Hostnames",
    description:
      "Visits to these hosts aren't counted, for example a staging site. *.example.com covers its subdomains but not example.com itself.",
    placeholder: "staging.example.com",
    mono: true,
  },
];

/** What a chip says. A country reads as its name; everything else as stored. */
function chipLabel(kind: ExclusionKind, value: string): string {
  return kind === "countries" ? countryName(value) : value;
}

export function ExclusionsForm({
  exclusions,
  countryActive,
  canEdit,
  busy,
  error,
  onChange,
}: {
  exclusions: ExclusionLists;
  /** `exclusions_country_active`: false says the GeoIP database resolved no
   * country lately, so country rules may match nothing. */
  countryActive: boolean | null;
  canEdit: boolean;
  busy: boolean;
  error: ErrorPresentation | null;
  /** The whole set, because a save replaces all four lists. */
  onChange: (next: ExclusionLists) => void;
}) {
  return (
    <div>
      {LISTS.map((list) => (
        <ExclusionList
          busy={busy}
          canEdit={canEdit}
          description={list.description}
          key={list.kind}
          kind={list.kind}
          mono={list.mono}
          note={
            list.kind === "countries" &&
            countryActive === false &&
            exclusions.countries.length > 0
              ? "These may have no effect: this install's GeoIP database hasn't resolved a visitor's country in the last week. If your host sends a country header instead, they still apply."
              : null
          }
          onChange={(values) => onChange({ ...exclusions, [list.kind]: values })}
          placeholder={list.placeholder}
          title={list.title}
          values={exclusions[list.kind]}
        />
      ))}

      {error ? (
        <p
          className="px-5 pt-3 text-xs leading-5 text-destructive-foreground"
          role="alert"
        >
          <strong>{error.title}</strong> {error.body}
        </p>
      ) : null}

      <div className="flex flex-col gap-1 px-5 py-3 text-xs leading-5 text-muted-foreground">
        <p>
          Excluded visits are dropped before they&rsquo;re stored, so they
          don&rsquo;t appear in any report or in Realtime. A change applies
          within about a minute.
        </p>
        {!canEdit ? <p>Only an owner or admin can change this.</p> : null}
      </div>
    </div>
  );
}

function ExclusionList({
  kind,
  title,
  description,
  placeholder,
  mono,
  note,
  values,
  canEdit,
  busy,
  onChange,
}: {
  kind: ExclusionKind;
  title: string;
  description: string;
  placeholder: string;
  mono: boolean;
  note: string | null;
  values: readonly string[];
  canEdit: boolean;
  busy: boolean;
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  /** What the last added value was stored as, when that differs from what
   * was typed (an internationalised host). Cleared by the next edit. */
  const [saved, setSaved] = React.useState<string | null>(null);
  const limit = EXCLUSION_LIMITS[kind];
  const full = values.length >= limit;
  const id = `exclusions-${kind}`;

  const add = (candidate: string) => {
    const checked = checkNewExclusion(kind, candidate, values);
    if (!checked.ok) {
      setProblem(checked.problem);
      return;
    }
    setProblem(null);
    setSaved(checked.note ?? null);
    setDraft("");
    onChange([...values, checked.value]);
  };

  return (
    <div className="flex flex-col gap-3 border-b border-border px-5 py-4">
      <div>
        <p className="text-sm font-medium" id={`${id}-label`}>
          {title}
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
        {note ? (
          <p className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-warning-foreground">
            <span
              aria-hidden="true"
              className="mt-[7px] size-1.5 shrink-0 rounded-full bg-warning"
            />
            {note}
          </p>
        ) : null}
      </div>

      {values.length > 0 ? (
        <ul aria-labelledby={`${id}-label`} className="flex flex-wrap gap-1.5">
          {values.map((value) => {
            const label = chipLabel(kind, value);
            return (
              <li
                className={cn(
                  "flex h-7 items-center gap-1 rounded-full border border-border bg-white text-xs",
                  canEdit ? "pl-2.5 pr-1" : "px-2.5"
                )}
                key={value}
              >
                <span className={cn("max-w-64 truncate", mono && "font-mono")}>
                  {label}
                </span>
                {canEdit ? (
                  <button
                    aria-label={`Remove ${label}`}
                    className="flex size-5 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-black/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                    disabled={busy}
                    onClick={() => {
                      setProblem(null);
                      onChange(values.filter((entry) => entry !== value));
                    }}
                    type="button"
                  >
                    <Cancel01Icon className="size-3" />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">None.</p>
      )}

      {canEdit ? (
        kind === "countries" ? (
          <CountryPicker
            busy={busy}
            full={full}
            id={id}
            limit={limit}
            onPick={add}
            values={values}
          />
        ) : (
          <form
            className="flex flex-col gap-1.5"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              add(draft);
            }}
          >
            <div className="flex items-center gap-2">
              <input
                aria-describedby={problem ? `${id}-problem` : undefined}
                aria-invalid={problem ? true : undefined}
                aria-labelledby={`${id}-label`}
                autoCapitalize="off"
                autoComplete="off"
                className={inputClass}
                disabled={busy || full}
                id={`${id}-input`}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (problem) setProblem(null);
                  if (saved) setSaved(null);
                }}
                placeholder={full ? `${limit} of ${limit}` : placeholder}
                spellCheck={false}
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
                id={`${id}-problem`}
              >
                {problem}
              </p>
            ) : saved ? (
              <p className="text-xs leading-5 text-muted-foreground" role="status">
                {saved}
              </p>
            ) : null}
          </form>
        )
      ) : null}
    </div>
  );
}

/**
 * A native select of every country by name: choosing one adds it. Native
 * because it brings type-to-find, the platform's own list on a phone and a
 * keyboard model nobody has to learn, and a panel that clips its overflow
 * cannot host a floating list anyway.
 */
function CountryPicker({
  id,
  values,
  full,
  limit,
  busy,
  onPick,
}: {
  id: string;
  values: readonly string[];
  full: boolean;
  limit: number;
  busy: boolean;
  onPick: (code: string) => void;
}) {
  const options = exclusionCountryOptions();
  return (
    <div className="relative flex">
      <select
        aria-labelledby={`${id}-label`}
        className={cn(inputClass, "cursor-pointer appearance-none pr-9")}
        disabled={busy || full}
        id={`${id}-input`}
        onChange={(event) => {
          if (event.target.value !== "") onPick(event.target.value);
        }}
        value=""
      >
        <option disabled value="">
          {full ? `${limit} of ${limit}` : "Add a country…"}
        </option>
        {options.map((option) => (
          <option
            disabled={values.includes(option.code)}
            key={option.code}
            value={option.code}
          >
            {option.name}
          </option>
        ))}
      </select>
      <ArrowDown01Icon
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

/**
 * What a viewer sees in the block's place. Reading the lists is owner or admin
 * (`GET /ingest-settings` is `site:settings`, like the write), so a viewer is
 * told the block exists and who can use it rather than shown a refused read.
 */
export function ExclusionsViewerNotice() {
  return (
    <div className="flex flex-col gap-1 p-5 text-sm leading-6 text-muted-foreground">
      <p>
        Visits from addresses, pages, countries or hosts listed here aren&rsquo;t
        counted.
      </p>
      <p>Only an owner or admin can see and change the lists.</p>
    </div>
  );
}
