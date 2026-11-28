// Which directories under the extension source root are agent sources, and in
// what state (cinatra#4920). This file CLASSIFIES; it does no I/O. The listing
// handler, provider discovery and the boot ingest each walk the tree with their
// own reads, deadlines and error handling (exactly as before this piece), hand
// in what they found, and get the same answer back, so they cannot disagree.
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
// marked `shadowedBy` the one it does select (selectAgentDefinition decides, so
// the listing cannot disagree with a read). A definition file belongs to one
// directory only: the flat `<root>/<name>/cinatra/agent.json` is not also the
// root `agent.json` of a scoped slug `cinatra` under `<root>/<name>`.

import { basename, dirname, join, relative } from "node:path";
import { selectAgentDefinition } from "./agent-definition-order";

/** The first-party vendor directory every reader walks. */
export const FIRST_PARTY_VENDOR = "cinatra-ai";

/** The two slugs whose old flat directory names differ from the slug. */
export const LEGACY_AGENT_DIR_NAMES: Readonly<Record<string, string>> = {
  "drupal-agent": "drupal-content-editor",
  "wordpress-agent": "wordpress-content-editor",
};

/** The relative places a definition file can be, the read one first. A caller checks which of these exist in a directory. */
export const DEFINITION_PLACES = ["cinatra/oas.json", "cinatra/agent.json", "agent.json"] as const;

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
      /** A definition is already at `definitionPath` (the caller's walk saw it). */
      occupied: boolean;
    }
) & {
  slug: string;
  /** The directory a by-slug read of `slug` selects instead of this one. */
  shadowedBy?: AgentSourceDir;
};

type ReportedAgentSourceDir = Extract<AgentSourceDir, { state: "reported" }>;

/** One directory a caller looked at: which of DEFINITION_PLACES exist in it. */
export type AgentSourceCandidate = {
  dir: string;
  /** Flat: `<root>/<name>`. Scoped: `<root>/<vendor>/<slug>`. */
  flat: boolean;
  present: readonly string[];
};

function slugOfFlatDir(name: string): string {
  return Object.entries(LEGACY_AGENT_DIR_NAMES).find(([, dirName]) => dirName === name)?.[0] ?? name;
}

/**
 * The state of every candidate directory, in the order given; a directory with
 * no definition file is not a source and is left out. `vendors` is the vendor
 * list a by-slug read walks (operator first, then first-party); `null` when the
 * caller does not know the operator's vendor (the boot ingest does not read the
 * instance identity), in which case a directory is marked shadowed only where
 * every possible operator vendor gives the same selection.
 */
export function classifyAgentSourceDirs(
  candidates: readonly AgentSourceCandidate[],
  context: { root: string; vendors: readonly string[] | null },
): AgentSourceDir[] {
  const { root, vendors } = context;
  const targetVendor = vendors?.[0] ?? FIRST_PARTY_VENDOR;
  // A file belongs to one directory: a flat directory owns it before a scoped one.
  const claimed = new Set<string>();
  const found = new Map<AgentSourceCandidate, string[]>();
  for (const flat of [true, false]) {
    for (const c of candidates) {
      if (c.flat !== flat) continue;
      const own = c.present.filter((place) => !claimed.has(join(c.dir, place)));
      for (const place of own) claimed.add(join(c.dir, place));
      found.set(c, own);
    }
  }
  const exists = new Set(candidates.flatMap((c) => c.present.map((place) => join(c.dir, place))));
  const out: AgentSourceDir[] = [];
  for (const c of candidates) {
    const files = found.get(c)!;
    if (files.length === 0) continue;
    const slug = c.flat ? slugOfFlatDir(basename(c.dir)) : basename(c.dir);
    if (!c.flat && files[0] === "cinatra/oas.json") {
      out.push({ state: "read", slug, dir: c.dir, definitionPath: join(c.dir, "cinatra", "oas.json") });
      continue;
    }
    const scopedDir = c.flat ? join(root, targetVendor, slug) : c.dir;
    const definitionPath = join(scopedDir, "cinatra", "oas.json");
    out.push({ state: "reported", slug, flat: c.flat, dir: c.dir, found: files, scopedDir, definitionPath, occupied: exists.has(definitionPath) });
  }
  markShadowed(out, root, vendors, (file) => exists.has(file));
  return out;
}

/**
 * For every slug held by more than one directory, the by-slug read selects one
 * (selectAgentDefinition, never a second copy of its order); every other
 * directory of that slug is marked shadowed by it, whatever the states are.
 */
function markShadowed(states: AgentSourceDir[], root: string, vendors: readonly string[] | null, has: (file: string) => boolean): void {
  const bySlug = new Map<string, AgentSourceDir[]>();
  for (const s of states) bySlug.set(s.slug, [...(bySlug.get(s.slug) ?? []), s]);
  const pick = (group: AgentSourceDir[], walked: string[], slug: string): AgentSourceDir | undefined => {
    const found = selectAgentDefinition({ root, vendors: walked, slug, legacySlug: LEGACY_AGENT_DIR_NAMES[slug] ?? slug }, has);
    if (!found) return undefined;
    return group.find((s) =>
      found.kind === "oas" ? s.dir === found.rootDir : s.state === "reported" && s.found.some((f) => join(s.dir, f) === found.found),
    );
  };
  for (const [slug, group] of bySlug) {
    if (group.length < 2) continue;
    let selected: AgentSourceDir | undefined;
    if (vendors) selected = pick(group, [...vendors], slug);
    else {
      // The operator's vendor is not known: try each vendor directory that could be it.
      const scopedVendors = group.flatMap((s) => (s.state === "reported" && s.flat ? [] : [basename(dirname(s.dir))]));
      const possible: Array<string | null> = [null, ...new Set(scopedVendors.filter((v) => v !== FIRST_PARTY_VENDOR))];
      const picks = possible.map((op) => pick(group, op ? [op, FIRST_PARTY_VENDOR] : [FIRST_PARTY_VENDOR], slug));
      selected = picks.every((p) => p === picks[0]) ? picks[0] : undefined;
    }
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
  const taken = state.occupied ? ` ${show(state.definitionPath)} already holds a definition, so keep one of the two.` : "";
  const move = state.flat
    ? `move the directory to ${show(state.scopedDir)}${state.found.includes("cinatra/oas.json") ? "" : " and its definition to cinatra/oas.json"} (${basename(dirname(state.scopedDir))} is a vendor directory the readers walk).`
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
