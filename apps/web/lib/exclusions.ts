/**
 * Server-side exclusions: the rules the Exclusions block checks before it
 * saves, mirrored from `normalizeIngestExclusions` in `@openanalytics/domain`.
 *
 * The web app may import only the contracts package, so the rules are copied
 * rather than shared: the same limits, the same normalised spelling (an
 * address becomes CIDR, a host is lowercased, a country uppercased), so a
 * value the form accepts is one the server accepts and stores the same way.
 * The server stays the authority; this exists so a typo is explained under
 * the field instead of coming back as a failed save.
 *
 * Kept free of React and of runtime imports from `lib/api`, so it is tested
 * here and the form only asks.
 */

import type { SiteIngestSettings, SiteRole } from "./api";
import { ZONE_COUNTRY } from "./timezone-countries";

export type ExclusionLists = SiteIngestSettings["exclusions"];
export type ExclusionKind = keyof ExclusionLists;

export const EXCLUSION_LIMITS: Record<ExclusionKind, number> = {
  ip_ranges: 50,
  paths: 50,
  countries: 250,
  hostnames: 20,
};
export const PATH_MAX_LENGTH = 200;
const PATH_MAX_WILDCARDS = 10;
const HOSTNAME_MAX_LENGTH = 253;

export const EMPTY_EXCLUSIONS: ExclusionLists = {
  ip_ranges: [],
  paths: [],
  countries: [],
  hostnames: [],
};

/** `PATCH /ingest-settings` is owner or admin, and so is the read. */
export function canEditExclusions(role: SiteRole): boolean {
  return role === "owner" || role === "admin";
}

/* -------------------------------- addresses ------------------------------- */

function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = BigInt(0);
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << BigInt(8)) | BigInt(octet);
  }
  return value;
}

function parseIpv6(text: string): bigint | null {
  if (text.length === 0 || text.length > 45) return null;
  let head = text;
  let tail: bigint | null = null;
  const lastColon = text.lastIndexOf(":");
  if (lastColon !== -1 && text.slice(lastColon + 1).includes(".")) {
    tail = parseIpv4(text.slice(lastColon + 1));
    if (tail === null) return null;
    head = text.slice(0, lastColon + 1);
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  }
  const limit = tail === null ? 8 : 6;
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const read = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups: number[] = [];
    for (const group of segment.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  let groups: number[];
  if (halves.length === 2) {
    const left = read(halves[0] ?? "");
    const right = read(halves[1] ?? "");
    if (left === null || right === null) return null;
    const missing = limit - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    const all = read(head);
    if (all === null || all.length !== limit) return null;
    groups = all;
  }
  let value = BigInt(0);
  for (const group of groups) value = (value << BigInt(16)) | BigInt(group);
  if (tail !== null) value = (value << BigInt(32)) | tail;
  return value;
}

function mask(bits: number, prefix: number): bigint {
  if (prefix === 0) return BigInt(0);
  const all = (BigInt(1) << BigInt(bits)) - BigInt(1);
  return (all >> BigInt(bits - prefix)) << BigInt(bits - prefix);
}

function formatIpv4(value: bigint): string {
  return [24, 16, 8, 0]
    .map((shift) => String((value >> BigInt(shift)) & BigInt(0xff)))
    .join(".");
}

function formatIpv6(value: bigint): string {
  const groups: number[] = [];
  for (let index = 7; index >= 0; index -= 1) {
    groups.push(Number((value >> BigInt(index * 16)) & BigInt(0xffff)));
  }
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < 8; ) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
}

/** `::ffff:0:0`, the top of the IPv4-mapped block. */
const MAPPED_BLOCK = BigInt(0xffff) << BigInt(32);

type RangeCheck =
  | { readonly value: string }
  | { readonly problem: "invalid" | "covers_ipv4_mapped" };

/** An address or range as the server stores it (CIDR), or null. */
export function normalizeIpRange(input: string): string | null {
  const checked = checkIpRange(input);
  return "value" in checked ? checked.value : null;
}

/**
 * The server's reading of an address or range, including its one refusal
 * that is not a typo: an IPv6 range shorter than /96 that covers
 * `::ffff:0:0/96`. IPv4 clients are matched as IPv4, so IPv6 rules never
 * match them, and such a range would look like it covers them.
 */
function checkIpRange(input: string): RangeCheck {
  const trimmed = input.trim();
  const slash = trimmed.indexOf("/");
  const addressText = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const v6 = addressText.includes(":");
  let value = v6 ? parseIpv6(addressText) : parseIpv4(addressText);
  if (value === null) return { problem: "invalid" };
  let bits = v6 ? 128 : 32;
  let prefix = bits;
  if (slash !== -1) {
    const text = trimmed.slice(slash + 1);
    if (!/^(0|[1-9][0-9]{0,2})$/.test(text)) return { problem: "invalid" };
    prefix = Number(text);
    if (prefix > bits) return { problem: "invalid" };
  }
  let version: 4 | 6 = v6 ? 6 : 4;
  // An IPv4-mapped IPv6 range is stored as the IPv4 range it is.
  if (v6 && prefix >= 96 && value >> BigInt(32) === BigInt(0xffff)) {
    value = value & BigInt(0xffffffff);
    prefix -= 96;
    bits = 32;
    version = 4;
  }
  const network = value & mask(bits, prefix);
  if (version === 6 && prefix < 96 && (MAPPED_BLOCK & mask(128, prefix)) === network) {
    return { problem: "covers_ipv4_mapped" };
  }
  return {
    value: `${version === 4 ? formatIpv4(network) : formatIpv6(network)}/${prefix}`,
  };
}

/* --------------------------- paths, hosts, countries ---------------------- */

function wildcardCount(path: string): number {
  return path.split("*").length - 1;
}

export function normalizePath(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/") || trimmed.length > PATH_MAX_LENGTH) return null;
  if (/[?#\s]/.test(trimmed)) return null;
  if (wildcardCount(trimmed) > PATH_MAX_WILDCARDS) return null;
  return trimmed;
}

const HOST_LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;

/**
 * The ASCII form a URL carries for a host (`bücher.de` → `xn--bcher-kva.de`),
 * from the browser's own URL parser, as the server does. Anything the parser
 * would read as more than a host is refused first.
 */
function asciiHost(host: string): string | null {
  if (/[/\\?#@:[\]%\s]/.test(host)) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

export function normalizeHostname(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  let wildcard = false;
  if (host.startsWith("*.")) {
    wildcard = true;
    host = host.slice(2);
  }
  if (host === "") return null;
  const ascii = asciiHost(host);
  if (ascii === null) return null;
  host = ascii.endsWith(".") ? ascii.slice(0, -1) : ascii;
  if (host === "" || host.length > HOSTNAME_MAX_LENGTH) return null;
  if (!host.split(".").every((label) => HOST_LABEL.test(label))) return null;
  return wildcard ? `*.${host}` : host;
}

/**
 * Codes a country rule may name: every country the tz database names, plus
 * the two ISO codes it has no zone for (Bouvet Island, Heard and McDonald
 * Islands) and `XK`, which GeoIP databases report for Kosovo. The same set the
 * server accepts.
 */
let countryCodes: ReadonlySet<string> | undefined;
function exclusionCountryCodes(): ReadonlySet<string> {
  countryCodes ??= new Set([...Object.values(ZONE_COUNTRY), "BV", "HM", "XK"]);
  return countryCodes;
}

export function normalizeCountry(input: string): string | null {
  const code = input.trim().toUpperCase();
  return exclusionCountryCodes().has(code) ? code : null;
}

const NORMALIZE: Record<ExclusionKind, (input: string) => string | null> = {
  ip_ranges: normalizeIpRange,
  paths: normalizePath,
  countries: normalizeCountry,
  hostnames: normalizeHostname,
};

/** What a rejected entry should say, by list. Says what to type instead. */
const INVALID: Record<ExclusionKind, string> = {
  ip_ranges:
    "Enter an IP address like 203.0.113.7 or a range like 203.0.113.0/24.",
  paths: "Start with / and leave out ? and #, for example /admin/*.",
  countries: "Pick a country from the list.",
  hostnames:
    "Enter a host like staging.example.com, without https:// or a path. *. at the start covers subdomains.",
};

const NOUN: Record<ExclusionKind, string> = {
  ip_ranges: "addresses",
  paths: "paths",
  countries: "countries",
  hostnames: "hostnames",
};

export type ExclusionCheck =
  | {
      readonly ok: true;
      readonly value: string;
      /** Shown under the field after adding: what the value was stored as. */
      readonly note?: string;
    }
  | { readonly ok: false; readonly problem: string };

/**
 * Whether `candidate` can join `existing` in a list, and the stored spelling
 * it will have. The message is shown under the field.
 */
export function checkNewExclusion(
  kind: ExclusionKind,
  candidate: string,
  existing: readonly string[]
): ExclusionCheck {
  const limit = EXCLUSION_LIMITS[kind];
  if (existing.length >= limit) {
    return {
      ok: false,
      problem: `You can add up to ${limit} ${NOUN[kind]}. Remove one to add another.`,
    };
  }
  if (kind === "paths" && candidate.trim().length > PATH_MAX_LENGTH) {
    return {
      ok: false,
      problem: `A path can be at most ${PATH_MAX_LENGTH} characters.`,
    };
  }
  if (kind === "paths" && wildcardCount(candidate.trim()) > PATH_MAX_WILDCARDS) {
    return {
      ok: false,
      problem: `Use at most ${PATH_MAX_WILDCARDS} * in one path.`,
    };
  }
  if (kind === "ip_ranges") {
    const checked = checkIpRange(candidate);
    if ("problem" in checked && checked.problem === "covers_ipv4_mapped") {
      return {
        ok: false,
        problem:
          "This IPv6 range would also cover IPv4 addresses, which IPv6 rules never match. Use a /96 or narrower IPv6 range, and add IPv4 ranges separately.",
      };
    }
  }
  const value = NORMALIZE[kind](candidate);
  if (value === null) return { ok: false, problem: INVALID[kind] };
  if (existing.includes(value)) {
    return { ok: false, problem: "That's already in the list." };
  }
  const typed = candidate.trim().toLowerCase().replace(/\.$/, "");
  if (kind === "hostnames" && typed !== value) {
    // Only an internationalised host is stored in a spelling the owner did
    // not type; say so, with the form they typed, so the chip is recognisable.
    return {
      ok: true,
      value,
      note: `Saved as ${value}, the form browsers report for ${candidate.trim()}.`,
    };
  }
  return { ok: true, value };
}

/* --------------------------------- countries ------------------------------ */

let regionNames: Intl.DisplayNames | null | undefined;

/** "Germany" for `DE`, or the code where the runtime has no region names. */
export function countryName(code: string): string {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  if (regionNames === null) return code;
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

let countryOptions: { code: string; name: string }[] | undefined;

/**
 * Every country a rule may name, by name. The codes come from the zone table
 * the timezone picker already ships (plus the three it has no zone for); the
 * names from the platform.
 */
export function exclusionCountryOptions(): readonly { code: string; name: string }[] {
  if (countryOptions === undefined) {
    const codes = [...exclusionCountryCodes()];
    countryOptions = codes
      .map((code) => ({ code, name: countryName(code) }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
  }
  return countryOptions;
}
