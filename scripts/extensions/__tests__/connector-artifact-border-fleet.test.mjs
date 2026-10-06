// cinatra#3821 — the connector border over the MATERIALIZED tree.
//
// On the application's pull requests the root unit tier runs with the
// companion repositories cloned into extensions/cinatra-ai/<slug>. This test
// reads every package of kind connector there and runs the connector border
// check (classes 4 and 5) on it with the rules derived from this repository's
// live SDK source. It asserts:
//   - no border finding outside the floor (CONNECTOR_ARTIFACT_BORDER_FLOOR);
//   - no stale floor entry (the floor only shrinks);
//   - every floor entry's package is materialized (a floor entry for a
//     package that is not read here would never be proven);
// and it FAILS CLOSED when it finds no connector at all.
//
// It calls the exported checks directly, so it needs no `npm pack` per package.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConnectorArtifactBorder, checkConnectorManifestBorder } from "../conformance-gate.mjs";
import { loadLiveRules, CONNECTOR_ARTIFACT_BORDER_FLOOR } from "../lib/conformance-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const EXT_ROOT = join(REPO_ROOT, "extensions", "cinatra-ai");

function readConnectors() {
  if (!existsSync(EXT_ROOT)) return [];
  const out = [];
  for (const slug of readdirSync(EXT_ROOT).sort()) {
    const pkgPath = join(EXT_ROOT, slug, "package.json");
    if (!existsSync(pkgPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue;
    }
    if (pkg?.cinatra?.kind === "connector") out.push({ dir: join(EXT_ROOT, slug), pkg });
  }
  return out;
}

describe("connector border over the materialized tree", () => {
  it("F: every materialized connector stays inside the floor, and the floor holds no stale entry", () => {
    const rules = loadLiveRules(REPO_ROOT);
    expect(rules.ok).toBe(true);

    const connectors = readConnectors();
    // FAIL CLOSED: a tree with no connector proves nothing.
    expect(connectors.length).toBeGreaterThan(0);

    const outside = [];
    const stale = [];
    const floored = [];
    for (const { dir, pkg } of connectors) {
      for (const f of checkConnectorManifestBorder(dir, pkg)) outside.push(`${pkg.name}: [${f.rule}] ${f.file}`);
      const result = checkConnectorArtifactBorder(dir, pkg, rules);
      for (const f of result.findings) outside.push(`${pkg.name}: [${f.rule}] ${f.file}: ${f.detail}`);
      for (const f of result.stale) stale.push(`${pkg.name}: ${f.detail}`);
      for (const f of result.floored) floored.push(f.floorKey);
    }

    expect(outside).toEqual([]);
    expect(stale).toEqual([]);

    const materialized = new Set(connectors.map((c) => c.pkg.name));
    const floorPackages = [...new Set(Object.keys(CONNECTOR_ARTIFACT_BORDER_FLOOR).map((k) => k.split(":")[0]))];
    expect(floorPackages.filter((name) => !materialized.has(name))).toEqual([]);

    expect([...new Set(floored)].sort()).toEqual(Object.keys(CONNECTOR_ARTIFACT_BORDER_FLOOR).sort());
  });
});
