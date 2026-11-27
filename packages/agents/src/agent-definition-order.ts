// The ONE place that decides which directory a by-slug / by-name read of an
// agent definition takes (cinatra#4920). Used by the by-slug handlers
// (mcp/agent-source-paths.ts) and by the compiler (oas-compiler.ts), which
// pass their own vendor lists and legacy slug, so they cannot disagree about
// the order.
//
// Pure (node:fs and node:path only) so the compiler can import it without
// pulling in the instance-identity store (agent-source-paths imports it hard;
// the compiler reads it lazily on purpose).
//
// Order, the same as the four-rung probe on main (resolveAgentJsonPathForRead):
//   1. for each vendor, in the order given (operator first, then first-party):
//      <root>/<vendor>/<slug>/            (cinatra/oas.json; old: cinatra/agent.json)
//   2. the legacy directory <root>/<legacySlug>/
//                                         (old only: cinatra/agent.json, agent.json)
// The FIRST directory that holds ANY definition file decides: a
// `cinatra/oas.json` there is read; only an old-layout file there is the
// migration error for THAT directory. A later directory is never consulted.
// An old file is never read.

import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export type AgentDefinitionLookup =
  | { kind: "oas"; path: string; rootDir: string }
  | { kind: "old"; found: string; required: string; message: string };

export function agentOasPath(root: string, vendor: string, slug: string): string {
  return join(root, vendor, slug, "cinatra", "oas.json");
}

export function oldDefinitionFileMessage(found: string, required: string): string {
  const show = (p: string) => relative(process.cwd(), p) || p;
  return (
    `Agent definition is in the old layout: found ${show(found)} in ${show(dirname(found).replace(/[\\/]cinatra$/, ""))}, which is no longer read. ` +
    `The definition must be at ${show(required)}; move it there.`
  );
}

export function findAgentDefinition(args: {
  root: string;
  vendors: string[];
  slug: string;
  legacySlug: string;
}): AgentDefinitionLookup | null {
  const { root, vendors, slug, legacySlug } = args;
  const old = (found: string, required: string): AgentDefinitionLookup => ({
    kind: "old",
    found,
    required,
    message: oldDefinitionFileMessage(found, required),
  });
  for (const vendor of vendors) {
    const oas = agentOasPath(root, vendor, slug);
    if (existsSync(oas)) return { kind: "oas", path: oas, rootDir: join(root, vendor, slug) };
    const oldFile = join(root, vendor, slug, "cinatra", "agent.json");
    if (existsSync(oldFile)) return old(oldFile, oas);
  }
  // The legacy directory holds old-layout files only; it names the first
  // vendor's `cinatra/oas.json` as the place to move the definition to.
  if (vendors.length > 0) {
    const required = agentOasPath(root, vendors[0], slug);
    const legacyRoot = join(/* turbopackIgnore: true */ root, legacySlug);
    for (const found of [join(legacyRoot, "cinatra", "agent.json"), join(legacyRoot, "agent.json")]) {
      if (existsSync(found)) return old(found, required);
    }
  }
  return null;
}
