// The agent SOURCE LAYOUT, decided in one place (cinatra#4920).
//
// An agent's definition file is `<root>/<vendor>/<slug>/cinatra/oas.json`: the
// SCOPED shape, with the file at that place. Every directory that looks like an
// agent source is in exactly one of two states, and no reader has a third:
//
//   READ      a scoped directory with `cinatra/oas.json`. Its definition is the
//             one the readers open.
//   REPORTED  any other directory with an agent file: a scoped directory with
//             only an `agent.json` (root or `cinatra/`), and a FLAT
//             `<root>/<slug>` directory with `cinatra/oas.json` or an
//             `agent.json`. It is not read as an agent, and the message names
//             the directory, what was found, and the exact place its definition
//             must be.
//
// A directory that holds agent directories itself (a vendor directory) is not
// an agent source, so its own files are not looked at. A directory with no
// agent file at all is nothing.
//
// Every reader asks `classifyAgentSourceDir` (one directory) or
// `enumerateAgentSourceDirs` (a whole root), so the reading rule and the
// reporting rule are the same function and cannot drift apart. There is no
// conversion here; the cure is the operator's move.
//
// Plain `node:fs` only, so the dev-source readers in `src/lib` and the handlers
// in this package share one rule without importing each other.

import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";

/** The vendor directory a message names when the reader has no operator vendor. */
export const DEFAULT_TARGET_VENDOR = "cinatra-ai";

/** The two slugs whose old flat directory names differ from the slug. */
export const LEGACY_AGENT_DIR_NAMES: Readonly<Record<string, string>> = {
  "drupal-agent": "drupal-content-editor",
  "wordpress-agent": "wordpress-content-editor",
};

export type AgentSourceKind = "scoped" | "flat";

export type AgentSourceDir =
  | {
      state: "read";
      kind: "scoped";
      dir: string;
      slug: string;
      /** `<dir>/cinatra/oas.json`, the file the readers open. */
      definitionPath: string;
    }
  | {
      state: "reported";
      kind: AgentSourceKind;
      dir: string;
      slug: string;
      /** What the directory holds, relative to it: `cinatra/oas.json`, `cinatra/agent.json`, `agent.json`. */
      found: string[];
      /** The directory the agent must sit in to be read. */
      scopedDir: string;
      /** `<scopedDir>/cinatra/oas.json`, the exact place the definition must be. */
      definitionPath: string;
    };

export type AgentSourceContext = {
  /** The source root the directory sits under. */
  root: string;
  /** The vendor directory a flat agent is told to move into. */
  targetVendor?: string;
};

/** The one definition file of a scoped agent directory. */
export function scopedDefinitionPath(dir: string): string {
  return join(dir, "cinatra", "oas.json");
}

function slugOfFlatDirName(name: string): string {
  for (const [slug, dirName] of Object.entries(LEGACY_AGENT_DIR_NAMES)) {
    if (dirName === name) return slug;
  }
  return name;
}

/**
 * The state of ONE directory read as `kind`, or null when it has no agent file
 * (it is not an agent source). `slug` names the agent when the caller knows it;
 * otherwise it is the directory's own name (a flat legacy directory name maps
 * back to its slug).
 */
export function classifyAgentSourceDir(
  dir: string,
  kind: AgentSourceKind,
  context: AgentSourceContext,
  slug?: string,
): AgentSourceDir | null {
  const hasOas = existsSync(scopedDefinitionPath(dir));
  if (kind === "scoped" && hasOas) {
    return { state: "read", kind, dir, slug: slug ?? basename(dir), definitionPath: scopedDefinitionPath(dir) };
  }
  const found: string[] = [];
  if (hasOas) found.push("cinatra/oas.json");
  if (existsSync(join(dir, "cinatra", "agent.json"))) found.push("cinatra/agent.json");
  if (existsSync(join(dir, "agent.json"))) found.push("agent.json");
  if (found.length === 0) return null;
  const agentSlug = slug ?? (kind === "flat" ? slugOfFlatDirName(basename(dir)) : basename(dir));
  const scopedDir = kind === "scoped" ? dir : join(context.root, context.targetVendor ?? DEFAULT_TARGET_VENDOR, agentSlug);
  return { state: "reported", kind, dir, slug: agentSlug, found, scopedDir, definitionPath: scopedDefinitionPath(scopedDir) };
}

/**
 * EVERY agent source directory under `root`, each in its one state.
 *
 * `vendors` are the vendor directory names whose children are agent
 * directories, probed in that order (a reader that looks under the operator's
 * vendor and the first-party one passes those two); `null` means every
 * top-level directory is a vendor (the boot walk). A top-level directory that
 * holds no agent directory is itself looked at as a flat agent directory, and
 * so is a vendor directory that holds none.
 *
 * An unreadable `root` THROWS, as it always did; an unreadable directory below
 * it is skipped and handed to `onUnreadable`, so a reader that must answer for
 * it can.
 */
export function enumerateAgentSourceDirs(
  root: string,
  vendors: readonly string[] | null,
  options: { targetVendor?: string; onUnreadable?: (dir: string, error: unknown) => void } = {},
): AgentSourceDir[] {
  const context: AgentSourceContext = { root, targetVendor: options.targetVendor };
  const names = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const ordered = vendors === null ? names : [...vendors.filter((v) => names.includes(v)), ...names.filter((n) => !vendors.includes(n))];

  const out: AgentSourceDir[] = [];
  for (const name of ordered) {
    const entryDir = join(root, name);
    if (vendors === null || vendors.includes(name)) {
      const children: AgentSourceDir[] = [];
      try {
        for (const sub of readdirSync(entryDir, { withFileTypes: true })) {
          // The inner `cinatra/` folder of a flat agent directory is not a slug.
          if (!sub.isDirectory() || sub.name === "cinatra") continue;
          const child = classifyAgentSourceDir(join(entryDir, sub.name), "scoped", context);
          if (child) children.push(child);
        }
      } catch (error) {
        options.onUnreadable?.(entryDir, error);
      }
      if (children.length > 0) {
        out.push(...children);
        continue;
      }
    }
    const flat = classifyAgentSourceDir(entryDir, "flat", context);
    if (flat) out.push(flat);
  }
  return out;
}

/**
 * EVERY agent source directory of the agent `slug`: `<root>/<vendor>/<slug>`
 * for each vendor (in order), then the flat `<root>/<legacyDirName>`. Several
 * can share one slug (a vendor directory and a flat one) and each has its own
 * state. The caller has already checked that `slug` and the vendors are single
 * safe path segments.
 */
export function agentSourceDirsForSlug(
  root: string,
  vendors: readonly string[],
  slug: string,
  options: { legacyDirName?: string; targetVendor?: string } = {},
): AgentSourceDir[] {
  const context: AgentSourceContext = { root, targetVendor: options.targetVendor ?? vendors[0] };
  const out: AgentSourceDir[] = [];
  const seen = new Set<string>();
  const candidates: Array<{ dir: string; kind: AgentSourceKind }> = [
    ...vendors.map((vendor) => ({ dir: join(root, vendor, slug), kind: "scoped" as const })),
    { dir: join(/* turbopackIgnore: true */ root, options.legacyDirName ?? slug), kind: "flat" as const },
  ];
  for (const { dir, kind } of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const state = classifyAgentSourceDir(dir, kind, context, slug);
    if (state) out.push(state);
  }
  return out;
}

/**
 * The sentence for a REPORTED directory: which directory, what was found, and
 * the exact place the definition must be. With `base`, paths print relative to
 * it. For a flat directory the place is the scoped one, never only a file name.
 */
export function agentSourceMessage(state: Extract<AgentSourceDir, { state: "reported" }>, base?: string): string {
  const show = (p: string) => (base === undefined ? p : relative(base, p));
  const found = state.found.join(" and ");
  if (state.kind === "scoped") {
    return (
      `${show(state.dir)} is an agent in the old layout (it has ${found} and no cinatra/oas.json), ` +
      `so it is not read as an agent: move it to cinatra/oas.json (${show(state.definitionPath)}).`
    );
  }
  const taken = existsSync(scopedDefinitionPath(state.scopedDir))
    ? ` ${show(state.scopedDir)} already holds another agent, so keep one of the two.`
    : "";
  return (
    `${show(state.dir)} is an agent in the old layout (a flat directory with ${found}), ` +
    `so it is not read as an agent: move the directory to ${show(state.scopedDir)}, ` +
    `so that its definition is at ${show(state.definitionPath)}.${taken}`
  );
}

const warnedDirs = new Set<string>();

/**
 * Log the sentence once per directory per process, so a reader that runs on
 * every page view does not repeat it. Never throws: a stale directory must not
 * stop the boot or the listing of the other agents.
 */
export function warnAgentSource(state: Extract<AgentSourceDir, { state: "reported" }>): void {
  if (warnedDirs.has(state.dir)) return;
  warnedDirs.add(state.dir);
  console.warn(`[agents] ${agentSourceMessage(state)}`);
}

/** The REPORTED states of a list, narrowed. */
export function reportedAgentSources(states: readonly AgentSourceDir[]): Array<Extract<AgentSourceDir, { state: "reported" }>> {
  return states.filter((s): s is Extract<AgentSourceDir, { state: "reported" }> => s.state === "reported");
}
