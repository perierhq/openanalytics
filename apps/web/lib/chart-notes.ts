/**
 * Chart notes, the pure half on the dashboard: the text rule the form checks
 * before it sends, and the conversion between a moment and the wall-clock
 * time a person types in the chart's own timezone.
 *
 * The text rule mirrors the API's (`packages/domain/src/chart-notes.ts`): the
 * server is the judge, and this only keeps the Save button honest.
 */

import type { ChartNote } from "@/lib/api";

/** Mirrors `CHART_NOTE_TEXT_MAX_LENGTH`. */
export const NOTE_TEXT_MAX = 280;

/** Every control character except the newline: C0, DEL and C1. */
const CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u;

/**
 * The text as the server stores it: every line break folded to `\n`, then
 * trimmed (`normalizeChartNoteText`).
 */
export function normalizeNoteText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** Characters as the server counts them: code points, so an emoji is one. */
export function noteTextLength(text: string): number {
  return [...normalizeNoteText(text)].length;
}

export type NoteTextProblem = "empty" | "too_long" | "control_characters";

/** What is wrong with a draft, or null when the server will take it. */
export function noteTextProblem(text: string): NoteTextProblem | null {
  const trimmed = normalizeNoteText(text);
  if (trimmed.length === 0) return "empty";
  if (CONTROL_CHARS.test(trimmed)) return "control_characters";
  if ([...trimmed].length > NOTE_TEXT_MAX) return "too_long";
  return null;
}

/** The wall-clock parts of an instant in a zone. */
function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** How far the zone's wall clock is ahead of UTC at `ms`, in milliseconds. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * An instant as a `datetime-local` value ("2026-11-10T14:05") on the zone's
 * wall clock, to the minute.
 */
export function toZonedInput(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * The instant a `datetime-local` value names on the zone's wall clock, or
 * null when the value is not one. A time skipped by a clock change lands on
 * the instant just after the gap; a repeated hour takes its first pass.
 */
export function fromZonedInput(value: string, timeZone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  if (!Number.isFinite(wall)) return null;
  // Two passes: the offset at the first guess may differ from the offset at
  // the answer when a clock change sits between them.
  let guess = wall - zoneOffsetMs(wall, timeZone);
  guess = wall - zoneOffsetMs(guess, timeZone);
  return guess;
}

/**
 * Where a new note starts: the bucket it was opened from, or now. Either way
 * on a whole minute, which is all the time field can show.
 */
export function defaultNoteTime(nowMs: number, bucketStartMs?: number): number {
  const ms = bucketStartMs ?? nowMs;
  return Math.floor(ms / 60_000) * 60_000;
}

/** Owners and admins write notes (`site:settings`); every member reads them. */
export function canWriteNotes(role: string): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Mock mode's notes (`NEXT_PUBLIC_MOCK_API=1`): an in-memory site that
 * answers the way the API does, so design mode can add, edit and delete.
 */
export function createMockNoteStore(seed: readonly ChartNote[], authorName: string | null) {
  let notes = [...seed];
  return {
    // Every note, whatever the range, like the mock mentions: the mock chart
    // plots a fixed series, and the layer drops what falls outside it.
    list: async () => ({
      items: [...notes].sort((a, b) => b.at.localeCompare(a.at)),
    }),
    create: async (body: { at: string; text: string }): Promise<ChartNote> => {
      const now = new Date().toISOString();
      const note: ChartNote = {
        id: crypto.randomUUID(),
        at: body.at,
        text: normalizeNoteText(body.text),
        created_by: { name: authorName },
        created_at: now,
        updated_at: now,
      };
      notes = [...notes, note];
      return note;
    },
    update: async (id: string, body: { at?: string; text?: string }): Promise<ChartNote> => {
      const found = notes.find((note) => note.id === id);
      if (!found) throw new Error("No note with this id on this site");
      const next: ChartNote = {
        ...found,
        ...(body.at === undefined ? {} : { at: body.at }),
        ...(body.text === undefined ? {} : { text: normalizeNoteText(body.text) }),
        updated_at: new Date().toISOString(),
      };
      notes = notes.map((note) => (note.id === id ? next : note));
      return next;
    },
    remove: async (id: string): Promise<void> => {
      notes = notes.filter((note) => note.id !== id);
    },
  };
}
