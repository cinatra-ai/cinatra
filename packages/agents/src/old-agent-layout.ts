// The OLD agent source layout, named in one place (cinatra#4920).
//
// An agent's definition file is `cinatra/oas.json`. A directory that holds an
// `agent.json` (at its root or in its `cinatra/` folder) and no
// `cinatra/oas.json` is an agent in the old layout. No reader opens it any
// more, and none skips it silently either: each reader that meets one says
// which directory it is and what to do with it. There is no conversion here;
// the cure is the operator's move.
//
// Plain `node:fs` only, so the dev-source readers in `src/lib` and the handlers
// in this package share one rule without importing each other.

import { existsSync } from "node:fs";
import { join } from "node:path";

/** True when `dir` has an `agent.json` (root or `cinatra/`) and no `cinatra/oas.json`. */
export function isOldLayoutAgentDir(dir: string): boolean {
  if (existsSync(join(dir, "cinatra", "oas.json"))) return false;
  return existsSync(join(dir, "cinatra", "agent.json")) || existsSync(join(dir, "agent.json"));
}

/**
 * EVERY old-layout directory of the agent `slug`: `<root>/<vendor>/<slug>` for
 * each vendor segment (in order), then the flat `<root>/<legacySlug>` the
 * retired read ladder also probed. Several can share one slug (a vendor
 * directory and a flat one), and each is its own directory to move, so none is
 * dropped. The caller has already checked that `slug` and the vendor segments
 * are single safe path segments.
 */
export function findOldLayoutAgentDirs(
  root: string,
  vendors: readonly string[],
  slug: string,
  legacySlug: string = slug,
): string[] {
  const candidates = [
    ...vendors.map((vendor) => join(root, vendor, slug)),
    join(/* turbopackIgnore: true */ root, legacySlug),
  ];
  return candidates.filter((dir) => isOldLayoutAgentDir(dir));
}

/** The one sentence every reader uses for an old-layout directory. */
export function oldLayoutAgentMessage(dir: string): string {
  return (
    `${dir} is an agent in the old layout (it has an agent.json and no cinatra/oas.json), ` +
    "so it is not read as an agent: move it to cinatra/oas.json."
  );
}

const warnedDirs = new Set<string>();

/**
 * Log the sentence once per directory per process, so a reader that runs on
 * every page view does not repeat it. Never throws: a stale directory must not
 * stop the boot or the listing of the other agents.
 */
export function warnOldLayoutAgentDir(dir: string): void {
  if (warnedDirs.has(dir)) return;
  warnedDirs.add(dir);
  console.warn(`[agents] ${oldLayoutAgentMessage(dir)}`);
}
