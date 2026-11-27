// Which directories under the extension source root are agent sources, and in
// what state (cinatra#4920). One function decides, for the listing handler,
// provider discovery and the boot ingest, so they cannot disagree.
//
// A directory is an agent source directory exactly when it CONTAINS a
// definition file at one of the known relative places below, whatever the
// directory is called; no name is skipped. Each such directory is in exactly
// one of two states:
//
//   READ      a scoped directory (<root>/<vendor>/<slug>) that holds
//             `cinatra/oas.json`. An `agent.json` beside it is never read.
//   REPORTED  every other source directory: a scoped one with only an old
//             file, and any flat one (<root>/<slug>, a directory that is not
//             a vendor's child), whichever files it holds. The message names
//             the directory, the files found and the exact place the
//             definition must be, which is a place that IS read.
//
// Results are keyed by PATH, never by slug: two directories with one slug each
// get their own state, and every directory a by-slug read does NOT select is
// marked `shadowedBy` the one it does select (findAgentDefinition decides, so
// the listing cannot disagree with a read). A definition file belongs to one directory only: the
// flat `<root>/<name>/cinatra/agent.json` is not also the root `agent.json` of
// a scoped slug `cinatra` under `<root>/<name>`.
//
// Plain node:fs, so src/lib readers and the handlers share it.

import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { findAgentDefinition } from "./agent-definition-order";

/** The vendor directory a message names when the reader has no operator vendor. */
const DEFAULT_TARGET_VENDOR = "cinatra-ai";

/** The two slugs whose old flat directory names differ from the slug. */
export const LEGACY_AGENT_DIR_NAMES: Readonly<Record<string, string>> = {
  "drupal-agent": "drupal-content-editor",
  "wordpress-agent": "wordpress-content-editor",
};

/** The relative places a definition file can be, the read one first. */
const DEFINITION_PLACES = ["cinatra/oas.json", "cinatra/agent.json", "agent.json"] as const;

export type AgentSourceDir = (
  | { state: "read"; dir: string; definitionPath: string }
  | {
      state: "reported";
      flat: boolean;
      dir: string;
      /** The files found, relative to `dir`. */
      found: string[];
      /** The scoped directory the agent has to sit in. */
      scopedDir: string;
      /** `<scopedDir>/cinatra/oas.json`, the exact place the definition must be. */
      definitionPath: string;
    }
) & {
  slug: string;
  /** The directory a by-slug read of `slug` selects instead of this one. */
  shadowedBy?: AgentSourceDir;
};

type ReportedAgentSourceDir = Extract<AgentSourceDir, { state: "reported" }>;

function slugOfFlatDir(name: string): string {
  return Object.entries(LEGACY_AGENT_DIR_NAMES).find(([, dirName]) => dirName === name)?.[0] ?? name;
}

/**
 * The state of ONE directory read as scoped or flat, or null when it holds no
 * definition file (it is not a source). `claimed` holds the files an earlier
 * directory already owns; they do not count here, and the files found are added.
 */
function classifyAgentSourceDir(
  dir: string,
  flat: boolean,
  context: { root: string; targetVendor?: string },
  claimed: Set<string> = new Set(),
): AgentSourceDir | null {
  const found = DEFINITION_PLACES.filter((place) => {
    const file = join(dir, place);
    return !claimed.has(file) && existsSync(file);
  });
  for (const place of found) claimed.add(join(dir, place));
  if (found.length === 0) return null;
  const slug = flat ? slugOfFlatDir(basename(dir)) : basename(dir);
  if (!flat && found[0] === "cinatra/oas.json") {
    return { state: "read", slug, dir, definitionPath: join(dir, "cinatra", "oas.json") };
  }
  const scopedDir = flat
    ? join(context.root, context.targetVendor ?? DEFAULT_TARGET_VENDOR, slug)
    : dir;
  return {
    state: "reported",
    slug,
    flat,
    dir,
    found,
    scopedDir,
    definitionPath: join(scopedDir, "cinatra", "oas.json"),
  };
}

/**
 * EVERY agent source directory under `root`, at the two depths: each top-level
 * directory (flat, `<root>/<name>`) and the children of each vendor directory
 * (scoped, `<root>/<vendor>/<slug>`). `vendors` names the vendor directories a
 * reader walks, first to last; `null` makes every top-level directory a vendor.
 * An unreadable `root` THROWS; an unreadable vendor directory is handed to
 * `onUnreadable` and its children are skipped.
 */
export function enumerateAgentSourceDirs(
  root: string,
  vendors: readonly string[] | null,
  options: {
    targetVendor?: string;
    /** The vendors a by-slug read walks; defaults to `vendors`. Without either, nothing is marked shadowed. */
    selectionVendors?: readonly string[];
    onUnreadable?: (dir: string, error: unknown) => void;
  } = {},
): AgentSourceDir[] {
  const selectionVendors = options.selectionVendors ?? vendors;
  const context = { root, targetVendor: options.targetVendor ?? selectionVendors?.[0] };
  const names = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const ordered = vendors === null ? names : [...vendors.filter((v) => names.includes(v)), ...names.filter((n) => !vendors.includes(n))];
  const claimed = new Set<string>();
  const out: AgentSourceDir[] = [];
  for (const name of ordered) {
    const entryDir = join(root, name);
    const flat = classifyAgentSourceDir(entryDir, true, context, claimed);
    if (flat) out.push(flat);
    if (vendors !== null && !vendors.includes(name)) continue;
    try {
      for (const sub of readdirSync(entryDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const scoped = classifyAgentSourceDir(join(entryDir, sub.name), false, context, claimed);
        if (scoped) out.push(scoped);
      }
    } catch (error) {
      options.onUnreadable?.(entryDir, error);
    }
  }
  if (selectionVendors) markShadowed(out, root, selectionVendors);
  return out;
}

/**
 * For every slug held by more than one directory, the by-slug read selects one
 * (findAgentDefinition, never a second copy of its order); every other
 * directory of that slug is marked shadowed by it, whatever the states are.
 */
function markShadowed(states: AgentSourceDir[], root: string, vendors: readonly string[]): void {
  const bySlug = new Map<string, AgentSourceDir[]>();
  for (const s of states) bySlug.set(s.slug, [...(bySlug.get(s.slug) ?? []), s]);
  for (const [slug, group] of bySlug) {
    if (group.length < 2) continue;
    const found = findAgentDefinition({ root, vendors: [...vendors], slug, legacySlug: LEGACY_AGENT_DIR_NAMES[slug] ?? slug });
    if (!found) continue;
    const selected = group.find((s) =>
      found.kind === "oas" ? s.dir === found.rootDir : s.state === "reported" && s.found.some((f) => join(s.dir, f) === found.found),
    );
    if (selected) for (const s of group) if (s !== selected) s.shadowedBy = selected;
  }
}

/** The sentence for a directory a by-slug read does not select, or null. */
export function agentSourceShadowNote(state: AgentSourceDir, base: string = process.cwd()): string | null {
  const by = state.shadowedBy;
  if (!by) return null;
  const show = (p: string) => relative(base, p) || p;
  if (by.state === "read") {
    return `a read of slug ${state.slug} uses ${show(by.dir)} instead of ${show(state.dir)}; keep one of the two directories or give one of them another slug.`;
  }
  const files = by.found.join(" and ");
  return `a read of slug ${state.slug} is decided by ${show(by.dir)}, which holds ${files} and is not read; move ${files} to ${show(by.definitionPath)} or remove the directory.`;
}

/**
 * The sentence for a REPORTED directory: the directory, the files found and the
 * exact place the definition must be. Paths print relative to `base`.
 */
export function agentSourceMessage(state: ReportedAgentSourceDir, base: string = process.cwd()): string {
  const show = (p: string) => relative(base, p) || p;
  const found = state.found.join(" and ");
  const taken = existsSync(state.definitionPath) ? ` ${show(state.definitionPath)} already holds a definition, so keep one of the two.` : "";
  const move = state.flat
    ? `move the directory to ${show(state.scopedDir)}${state.found.includes("cinatra/oas.json") ? "" : " and its definition to cinatra/oas.json"}.`
    : "move it there.";
  return (
    `${show(state.dir)} is an agent in the old layout (${state.flat ? "a directory directly under the source root" : "no cinatra/oas.json"}; found ${found}), ` +
    `so it is not read. The definition must be at ${show(state.definitionPath)}; ${move}${taken}` +
    (state.shadowedBy ? ` This directory is also shadowed: ${agentSourceShadowNote(state, base)}` : "")
  );
}

const warned = new Set<string>();

/** The report line of a directory that needs one: REPORTED, or READ but shadowed. */
export function agentSourceReport(state: AgentSourceDir, base?: string): string | null {
  if (state.state === "reported") return agentSourceMessage(state, base);
  const note = agentSourceShadowNote(state, base);
  return note && `${relative(base ?? process.cwd(), state.dir) || state.dir} is shadowed: ${note}`;
}

/** Log the report line once per directory per process; a stale directory never stops a reader. */
export function warnAgentSource(state: AgentSourceDir): void {
  const line = agentSourceReport(state);
  if (!line || warned.has(state.dir)) return;
  warned.add(state.dir);
  console.warn(`[agents] ${line}`);
}
