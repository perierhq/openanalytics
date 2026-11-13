/**
 * Funnel steps as the editor and the readings show them.
 *
 * The contract's step is a string in one of two forms (see `parseFunnelStep`
 * in `@openanalytics/domain`): a plain key — a page path or an event name,
 * matched exactly — or a JSON step object starting with `{`:
 * `{"page":"/discount/*"}` for a path pattern, `{"event":"plan_selected",
 * "where":{"plan":"yearly"}}` for an event with property conditions.
 *
 * The editor writes the plain form whenever it can, so a funnel that uses no
 * wildcard and no condition is stored exactly as before step kinds existed.
 */

/** Most property conditions one event step may carry (the domain's bound). */
export const MAX_STEP_CONDITIONS = 3;

export type EditableStep = {
  kind: "page" | "event";
  /** The path (with any `*`) or the event name. */
  value: string;
  /** Conditions as typed: `plan=yearly, trigger=paywall`. Events only. */
  where: string;
};

type StepObject =
  | { page: string }
  | { event: string; where?: Record<string, string> };

function parseObject(raw: string): StepObject | null {
  if (!raw.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    if ("page" in value && typeof value.page === "string") {
      return { page: value.page };
    }
    if ("event" in value && typeof value.event === "string") {
      const where =
        "where" in value && typeof value.where === "object" && value.where
          ? Object.fromEntries(
              Object.entries(value.where).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === "string"
              )
            )
          : undefined;
      return { event: value.event, where };
    }
    return null;
  } catch {
    return null;
  }
}

function whereText(where: Record<string, string> | undefined): string {
  return Object.entries(where ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

/** A stored step, read back into the editor's fields. */
export function editableStep(raw: string): EditableStep {
  const parsed = parseObject(raw);
  if (parsed === null) {
    return {
      kind: raw.startsWith("/") ? "page" : "event",
      value: raw,
      where: "",
    };
  }
  if ("page" in parsed) return { kind: "page", value: parsed.page, where: "" };
  return { kind: "event", value: parsed.event, where: whereText(parsed.where) };
}

/**
 * The conditions text as a record, or the reason it is not one. Empty text
 * is no conditions. Each part is `key=value`; the first `=` splits it.
 */
export function parseWhere(
  text: string
): { ok: true; where: Record<string, string> } | { ok: false; reason: string } {
  const where: Record<string, string> = {};
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  for (const part of parts) {
    const at = part.indexOf("=");
    if (at <= 0) {
      return { ok: false, reason: `"${part}" is not property=value` };
    }
    where[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  if (Object.keys(where).length > MAX_STEP_CONDITIONS) {
    return {
      ok: false,
      reason: `At most ${MAX_STEP_CONDITIONS} conditions per step`,
    };
  }
  return { ok: true, where };
}

/**
 * The editor's fields as the contract's string, or `""` for an empty row.
 * A page without `*` and an event without conditions stay plain keys.
 */
export function storedStep(step: EditableStep): string {
  const value = step.value.trim();
  if (step.kind === "page") {
    if (value === "") return "";
    const path = value.startsWith("/") ? value : `/${value}`;
    return path.includes("*") ? JSON.stringify({ page: path }) : path;
  }
  const name = value.replace(/^\/+/, "");
  if (name === "") return "";
  const parsed = parseWhere(step.where);
  const where = parsed.ok ? parsed.where : {};
  return Object.keys(where).length === 0
    ? name
    : JSON.stringify({ event: name, where });
}

/** A step as a short human label: the path or name, then its conditions. */
export function stepLabel(raw: string): string {
  const parsed = parseObject(raw);
  if (parsed === null) return raw;
  if ("page" in parsed) return parsed.page;
  const conditions = whereText(parsed.where);
  return conditions === "" ? parsed.event : `${parsed.event} · ${conditions}`;
}
