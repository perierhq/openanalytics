"use client";

import * as React from "react";
import { NoteGlyph } from "@/components/dashboard/chart-marker-glyphs";
import { PlusIcon } from "@/components/icons/hugeicons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ChartNote } from "@/lib/api";
import {
  fromZonedInput,
  normalizeNoteText,
  NOTE_TEXT_MAX,
  noteTextLength,
  noteTextProblem,
  toZonedInput,
} from "@/lib/chart-notes";
import { cn } from "@/lib/utils";

/**
 * Chart notes on the dashboard: the section a marker's popover shows, and the
 * one form that adds or edits a note, in the popover and behind the legend's
 * "Add note" button alike.
 *
 * Presentational: the writes come in as `actions`, already bound to the site,
 * and a viewer gets `actions: null`, so their popover has nothing to click.
 * Nothing is shown before the server confirms; a failed write keeps the form
 * open with the reason above its buttons.
 */

/** The writes a member with `site:settings` may make; null for a viewer. */
export type NoteActions = {
  /** The zone the chart is drawn in; the form's time field uses its clock. */
  timeZone: string;
  create: (body: { at: string; text: string }) => Promise<void>;
  update: (id: string, body: { at?: string; text?: string }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** A failed write, in words for the person who tried it. */
  describeError: (raised: unknown) => string;
};

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

const FORM_ID_PREFIX = "chart-note";

/** From here on the counter is read out as it changes; below it, it is quiet. */
const NOTE_TEXT_ANNOUNCE_FROM = 260;

export function NoteForm({
  timeZone,
  initialAtMs,
  initialText = "",
  submitLabel,
  onSubmit,
  onCancel,
}: {
  timeZone: string;
  initialAtMs: number;
  initialText?: string;
  submitLabel: string;
  /**
   * Resolves once the server confirmed; rejects with the reason shown.
   * `atChanged` is whether the time field differs from where it started, to
   * the minute it shows: a note pinned at 09:00:30 opens at 09:00, and saving
   * only new text must not move it.
   */
  onSubmit: (body: { atMs: number; atChanged: boolean; text: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const id = `${FORM_ID_PREFIX}-${React.useId()}`;
  const [initialWhen] = React.useState(() => toZonedInput(initialAtMs, timeZone));
  const [when, setWhen] = React.useState(initialWhen);
  const [text, setText] = React.useState(initialText);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const textRef = React.useRef<HTMLTextAreaElement | null>(null);

  const atMs = fromZonedInput(when, timeZone);
  const problem = noteTextProblem(text);
  const length = noteTextLength(text);
  const over = length > NOTE_TEXT_MAX;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (atMs === null || problem !== null || busy) return;
    // Save is about to wait disabled, and a disabled button drops focus to
    // the page, which the popover answers by taking focus to its container a
    // frame later, over wherever the close puts it. The text field stays
    // usable while the save waits, so focus waits there.
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement && active.type === "submit") {
      textRef.current?.focus({ preventScroll: true });
    }
    setBusy(true);
    setError(null);
    onSubmit({ atMs, atChanged: when !== initialWhen, text }).then(
      () => setBusy(false),
      (raised: unknown) => {
        setBusy(false);
        setError(raised instanceof Error ? raised.message : String(raised));
      }
    );
  };

  return (
    <form
      className="flex flex-col gap-2.5"
      onKeyDown={(event) => {
        // Escape leaves the form, not the whole popover.
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
      onSubmit={submit}
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <label className="font-medium" htmlFor={`${id}-when`}>
            When
          </label>
          <span className="truncate text-muted-foreground">{timeZone}</span>
        </div>
        <Input
          aria-invalid={atMs === null || undefined}
          id={`${id}-when`}
          onChange={(event) => setWhen(event.target.value)}
          required
          size="sm"
          step={60}
          type="datetime-local"
          value={when}
        />
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <label className="font-medium" htmlFor={`${id}-text`}>
            Note
          </label>
          <span
            className={cn("tabular-nums", over ? "text-destructive-foreground" : "text-muted-foreground")}
            id={`${id}-count`}
          >
            {length}/{NOTE_TEXT_MAX}
          </span>
          {/* Read out only near the limit: a count announced on every
              keystroke from the first would drown the typing. */}
          <span aria-live="polite" className="sr-only">
            {length >= NOTE_TEXT_ANNOUNCE_FROM ? `${length} of ${NOTE_TEXT_MAX} characters` : ""}
          </span>
        </div>
        <Textarea
          aria-describedby={`${id}-count`}
          aria-invalid={over || problem === "control_characters" || undefined}
          autoFocus
          id={`${id}-text`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // ⌘/Ctrl+Enter saves, as in most note fields; Enter is a new line.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Launched the new pricing page"
          ref={textRef}
          rows={3}
          size="sm"
          value={text}
        />
      </div>
      {error ? (
        <p className="text-xs leading-5 text-destructive-foreground" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Button onClick={onCancel} size="xs" type="button" variant="ghost">
          Cancel
        </Button>
        <Button
          disabled={atMs === null || problem !== null}
          loading={busy}
          size="xs"
          type="submit"
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** A small text button for a note's row: quiet until pointed at. */
function RowAction({
  children,
  className,
  ...props
}: React.ComponentProps<"button">) {
  // `ref` is an ordinary prop in React 19, carried by the spread below.
  return (
    <button
      className={cn(
        "cursor-pointer rounded-sm text-xs font-medium text-muted-foreground outline-none transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring [@media(hover:hover)]:hover:text-foreground",
        className
      )}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

type Mode =
  | { kind: "idle" }
  | { kind: "adding" }
  | { kind: "editing"; id: string }
  | { kind: "deleting"; id: string; busy: boolean; error: string | null };

/**
 * Where focus goes after the next render: the button that opened a form or a
 * confirmation once it closes, or the confirmation's Cancel once it opens.
 */
type FocusTarget =
  | { kind: "edit"; id: string }
  | { kind: "delete"; id: string }
  | { kind: "add" }
  | { kind: "confirm" };

/**
 * A bucket's notes in its marker popover: each note's text, author and time.
 * With `actions`, every note gets Edit and Delete in place, and the bucket an
 * "Add note" that starts at the bucket's own start.
 *
 * `onEngagedChange` tells the popover a form or a confirmation is open, so a
 * pointer drifting off it does not throw away what was typed.
 *
 * Focus follows the person: a confirmation opens on its Cancel, and a form or
 * confirmation that closes hands focus back to the button that opened it, or
 * to "Add note" when that button went with its note. It never drops to the
 * page, where the popover would read it as focus leaving and close.
 */
export function NotesSection({
  notes,
  bucketStartMs,
  timeLabel,
  actions,
  onEngagedChange,
}: {
  notes: readonly ChartNote[];
  bucketStartMs: number;
  /** "14:15" — a note's time, in the chart's zone. */
  timeLabel: (date: Date) => string;
  actions: NoteActions | null;
  onEngagedChange?: (engaged: boolean) => void;
}) {
  const [mode, setModeState] = React.useState<Mode>({ kind: "idle" });
  const setMode = (next: Mode) => {
    setModeState(next);
    onEngagedChange?.(next.kind !== "idle");
  };

  const editButtons = React.useRef(new Map<string, HTMLButtonElement>());
  const deleteButtons = React.useRef(new Map<string, HTMLButtonElement>());
  const addButton = React.useRef<HTMLButtonElement | null>(null);
  const confirmCancel = React.useRef<HTMLButtonElement | null>(null);
  const confirmGroup = React.useRef<HTMLDivElement | null>(null);
  const focusNext = React.useRef<FocusTarget | null>(null);
  // Whether focus is somewhere in this section, or was until the element
  // holding it was removed (which moves it to the page, not anywhere else).
  const holdsFocus = React.useRef(false);

  /** Back to idle, and focus to `opener` (or "Add note" if it is gone). */
  const close = (opener: FocusTarget) => {
    focusNext.current = opener;
    setMode({ kind: "idle" });
  };

  // After every render, before paint: a form or confirmation that just
  // closed has unmounted whatever held focus.
  //
  // The dashboard drops a deleted or moved note from its list a render before
  // the write's promise lets the close run, so the row holding focus can go
  // on its own. Focus then sits on the page, and the popover would take it to
  // its container on the next frame; catching it here, in the same commit,
  // keeps it in the section.
  React.useLayoutEffect(() => {
    const lost =
      holdsFocus.current &&
      (document.activeElement === null || document.activeElement === document.body);
    const target = focusNext.current ?? (lost ? ({ kind: "add" } as const) : null);
    if (target === null) return;
    focusNext.current = null;
    const element =
      target.kind === "edit"
        ? editButtons.current.get(target.id)
        : target.kind === "delete"
          ? deleteButtons.current.get(target.id)
          : target.kind === "confirm"
            ? confirmCancel.current
            : null;
    (element ?? addButton.current)?.focus();
  });

  if (notes.length === 0 && actions === null) return null;

  const fail = (raised: unknown) =>
    new Error(actions ? actions.describeError(raised) : String(raised));

  return (
    <section
      className="flex flex-col gap-1.5"
      onBlur={(event) => {
        // Only a move to a real element elsewhere is leaving; a removed
        // element blurs to nothing.
        const next = event.relatedTarget;
        if (next !== null && !event.currentTarget.contains(next)) holdsFocus.current = false;
      }}
      onFocus={() => {
        holdsFocus.current = true;
      }}
    >
      {notes.length > 0 ? (
        <p className="flex items-center gap-2 font-medium">
          <span className="flex size-2 items-center justify-center">
            <NoteGlyph />
          </span>
          {plural(notes.length, "note", "notes")}
        </p>
      ) : null}
      {notes.length > 0 ? (
        <ul className="flex flex-col gap-2.5 pl-4">
          {notes.map((note) => {
            const at = new Date(note.at);
            if (actions && mode.kind === "editing" && mode.id === note.id) {
              return (
                <li key={note.id}>
                  <NoteForm
                    initialAtMs={at.getTime()}
                    initialText={note.text}
                    onCancel={() => close({ kind: "edit", id: note.id })}
                    onSubmit={async ({ atMs, atChanged, text }) => {
                      // Only what changed: the time when its field was
                      // touched, the text when it differs once stored.
                      const body = {
                        ...(atChanged ? { at: new Date(atMs).toISOString() } : {}),
                        ...(normalizeNoteText(text) === note.text ? {} : { text }),
                      };
                      if (body.at !== undefined || body.text !== undefined) {
                        try {
                          await actions.update(note.id, body);
                        } catch (raised) {
                          throw fail(raised);
                        }
                      }
                      close({ kind: "edit", id: note.id });
                    }}
                    submitLabel="Save"
                    timeZone={actions.timeZone}
                  />
                </li>
              );
            }
            const deleting = mode.kind === "deleting" && mode.id === note.id ? mode : null;
            const author = note.created_by?.name ?? null;
            return (
              <li className="flex flex-col gap-0.5" key={note.id}>
                <p className="whitespace-pre-line break-words text-xs leading-5 select-text">
                  {note.text}
                </p>
                <div className="flex items-center gap-3 text-xs leading-5">
                  <span className="min-w-0 truncate text-muted-foreground">
                    {author ? `${author} · ` : ""}
                    <span className="tabular-nums">{timeLabel(at)}</span>
                  </span>
                  {actions && !deleting ? (
                    <span className="ml-auto flex shrink-0 items-center gap-2.5">
                      <RowAction
                        aria-label={`Edit note: ${note.text.slice(0, 40)}`}
                        onClick={() => setMode({ kind: "editing", id: note.id })}
                        ref={(node) => {
                          // Runs when React attaches the button, never in render.
                          if (node) editButtons.current.set(note.id, node);
                          else editButtons.current.delete(note.id);
                        }}
                      >
                        Edit
                      </RowAction>
                      <RowAction
                        aria-label={`Delete note: ${note.text.slice(0, 40)}`}
                        onClick={() => {
                          focusNext.current = { kind: "confirm" };
                          setMode({ kind: "deleting", id: note.id, busy: false, error: null });
                        }}
                        ref={(node) => {
                          if (node) deleteButtons.current.set(note.id, node);
                          else deleteButtons.current.delete(note.id);
                        }}
                      >
                        Delete
                      </RowAction>
                    </span>
                  ) : null}
                </div>
                {actions && deleting ? (
                  <div
                    className="mt-1 flex flex-col gap-1.5 rounded-md bg-black/4 p-2 outline-none"
                    onKeyDown={(event) => {
                      // Escape leaves the confirmation, not the whole popover.
                      if (event.key !== "Escape") return;
                      event.stopPropagation();
                      if (!deleting.busy) close({ kind: "delete", id: note.id });
                    }}
                    ref={confirmGroup}
                    role="group"
                    aria-busy={deleting.busy || undefined}
                    aria-label="Confirm delete"
                    // Focus waits here while the delete runs (see below).
                    tabIndex={-1}
                  >
                    <p className="text-xs leading-5">Delete this note for everyone on the site?</p>
                    {deleting.error ? (
                      <p className="text-xs leading-5 text-destructive-foreground" role="alert">
                        {deleting.error}
                      </p>
                    ) : null}
                    <div className="flex justify-end gap-1.5">
                      <Button
                        onClick={() => close({ kind: "delete", id: note.id })}
                        ref={confirmCancel}
                        size="xs"
                        variant="ghost"
                      >
                        Cancel
                      </Button>
                      <Button
                        loading={deleting.busy}
                        onClick={() => {
                          // This button waits disabled; a focused button that
                          // turns disabled drops focus to the page, and the
                          // popover would take it from there. The
                          // confirmation itself holds it instead.
                          confirmGroup.current?.focus({ preventScroll: true });
                          setMode({ ...deleting, busy: true, error: null });
                          actions.remove(note.id).then(
                            // The note's own buttons went with it.
                            () => close({ kind: "add" }),
                            (raised: unknown) => {
                              focusNext.current = { kind: "confirm" };
                              setMode({ ...deleting, busy: false, error: fail(raised).message });
                            }
                          );
                        }}
                        size="xs"
                        variant="destructive"
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {actions && mode.kind === "adding" ? (
        <div className={cn(notes.length > 0 && "pt-1")}>
          <NoteForm
            initialAtMs={bucketStartMs}
            onCancel={() => close({ kind: "add" })}
            onSubmit={async ({ atMs, text }) => {
              try {
                await actions.create({ at: new Date(atMs).toISOString(), text });
              } catch (raised) {
                throw fail(raised);
              }
              close({ kind: "add" });
            }}
            submitLabel="Add note"
            timeZone={actions.timeZone}
          />
        </div>
      ) : null}
      {actions && mode.kind !== "adding" ? (
        <RowAction
          className="flex items-center gap-1 self-start pl-4"
          onClick={() => setMode({ kind: "adding" })}
          ref={addButton}
        >
          <PlusIcon className="size-3.5" />
          Add note
        </RowAction>
      ) : null}
    </section>
  );
}
