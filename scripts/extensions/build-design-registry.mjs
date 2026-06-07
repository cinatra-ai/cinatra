#!/usr/bin/env node
// Builds the Cinatra design-system shadcn registry (`@cinatra-ai`) from
// registry.json into committed `public/r/*.json`, and gates that the committed
// output never drifts from source.
//
// The registry items point at the single source of truth (src/components/ui/* +
// src/lib/utils.ts); `shadcn build` inlines that source + each item's declared
// npm dependencies into static JSON a consumer `shadcn add @cinatra-ai/<item>`
// can resolve.
//
// PINNED CLI: SHADCN_VERSION below is the only allowed version — never
// `@latest`, especially in CI (a CLI bump can silently change output shape).
//
// Usage:
//   node scripts/extensions/build-design-registry.mjs           # validate + (re)build public/r
//   node scripts/extensions/build-design-registry.mjs --check    # validate + build-to-temp + diff (no writes)

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHADCN_VERSION = "4.8.2";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY = "./registry.json";
const OUT = "public/r";

function shadcn(args) {
  execFileSync(
    "corepack",
    ["pnpm", "dlx", `shadcn@${SHADCN_VERSION}`, ...args],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
}

function readJsonDir(dir) {
  const out = new Map();
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".json")) out.set(name, readFileSync(join(dir, name), "utf8"));
  }
  return out;
}

function diffRegistryDirs(committedDir, freshDir) {
  const committed = readJsonDir(committedDir);
  const fresh = readJsonDir(freshDir);
  const drift = [];
  for (const [name, content] of fresh) {
    if (!committed.has(name)) drift.push(`missing in public/r: ${name}`);
    else if (committed.get(name) !== content) drift.push(`stale content: ${name}`);
  }
  for (const name of committed.keys()) {
    if (!fresh.has(name)) drift.push(`orphan in public/r (not in registry.json): ${name}`);
  }
  return drift;
}

function main() {
  const check = process.argv.includes("--check");
  shadcn(["registry", "validate", REGISTRY]);

  if (!check) {
    shadcn(["build", REGISTRY, "-o", OUT]);
    console.log(`[build-design-registry] built → ${OUT}`);
    return;
  }

  const tmp = mkdtempSync(join(tmpdir(), "cinatra-registry-"));
  try {
    shadcn(["build", REGISTRY, "-o", tmp]);
    const drift = diffRegistryDirs(join(REPO_ROOT, OUT), tmp);
    if (drift.length > 0) {
      console.error("[build-design-registry] DRIFT — public/r is stale vs registry.json + source:");
      for (const d of drift) console.error(`  - ${d}`);
      console.error("Run `node scripts/extensions/build-design-registry.mjs` to rebuild.");
      process.exit(1);
    }
    console.log("[build-design-registry] OK — public/r matches a fresh build.");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { SHADCN_VERSION, diffRegistryDirs };
