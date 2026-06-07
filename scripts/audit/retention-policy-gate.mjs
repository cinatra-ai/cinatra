#!/usr/bin/env node
// Retention-policy completeness gate.
//
// Verifies that every versioned object type REGISTERED IN PRODUCTION CODE has
// a retention_policy declaration in `src/lib/object-history/retention-policy.ts`.
// Missing declarations fail CI. PoC default policy is `indefinite`; the gate
// is about COMPLETENESS, not strictness of values.
//
// Discovery: a JS-based file walk over `src/**` + `packages/**`, EXCLUDING
// `**/__tests__/**` and `*.test.ts`, matching `type: "@cinatra-ai/<ns>:<type>"`
// via a JS regex. A `git grep -E "...\\s..."` approach has two failure modes —
// `\s` is not portable across BREs/EREs on every Git build, and the regex
// matches test-fixture types (`@cinatra-ai/dynamic:noKeys`, `@cinatra-ai/x:y`,
// etc.) that should never require a static retention declaration.
//
// Usage: `node scripts/audit/retention-policy-gate.mjs`
// Programmatic: `import { runGate } from "./retention-policy-gate.mjs"`.

import { readFile, readdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const POLICY_FILE = "src/lib/object-history/retention-policy.ts";

function defaultRepoRoot() {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

// Match `type: "@cinatra-ai/<pkg>:<type>"` (no leading word so it also catches
// computed-key + inline-object property usage). Captures the fully-qualified id.
const TYPE_LITERAL_RE = /type:\s*"(@cinatra-ai\/[^"]+)"/g;

// Walk for `.ts`/`.tsx` files under `root`, skipping test files, declaration
// files, node_modules, build output, and dot-dirs. Async generator yields
// absolute paths.
async function* walkTsFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "node_modules" || e.name === "dist" || e.name === "build") continue;
    const p = join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__") continue;
      yield* walkTsFiles(p);
      continue;
    }
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".ts") && !e.name.endsWith(".tsx")) continue;
    if (e.name.endsWith(".test.ts") || e.name.endsWith(".test.tsx")) continue;
    if (e.name.endsWith(".d.ts")) continue;
    yield p;
  }
}

// Extract the set of declared types from the policy file. Matches quoted keys
// in the RETENTION_POLICIES object literal — covers both dotted (`blog.post`)
// and namespaced (`@cinatra-ai/asset-blog:blog-post`) forms.
export async function loadDeclaredTypes(repoRoot = defaultRepoRoot()) {
  const content = await readFile(resolve(repoRoot, POLICY_FILE), "utf8");
  const declared = new Set();
  const re = /^\s*"([^"]+)"\s*:\s*\{/gm;
  let m;
  while ((m = re.exec(content)) !== null) declared.add(m[1]);
  return declared;
}

// Discover every `type: "@cinatra-ai/..."` literal in PRODUCTION TypeScript
// under `rootDirs`. Test files are skipped — fixture types like
// `@cinatra-ai/dynamic:noKeys` register throwaway types in unit tests and
// must NOT require a static retention declaration. `rootDirs` is parameterized
// for testability against a synthetic tree.
export async function loadDiscoveredTypes(
  repoRoot = defaultRepoRoot(),
  rootDirs = ["src", "packages"],
) {
  const types = new Set();
  for (const rd of rootDirs) {
    const root = resolve(repoRoot, rd);
    for await (const file of walkTsFiles(root)) {
      let content;
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const m of content.matchAll(TYPE_LITERAL_RE)) {
        types.add(m[1]);
      }
    }
  }
  return types;
}

// Programmatic entry point — structured report. Throws on IO errors; callers
// decide whether to `process.exit(1)` on `missing.length > 0`.
export async function runGate(repoRoot = defaultRepoRoot(), rootDirs = ["src", "packages"]) {
  const [declared, discovered] = await Promise.all([
    loadDeclaredTypes(repoRoot),
    loadDiscoveredTypes(repoRoot, rootDirs),
  ]);
  const missing = [];
  for (const t of discovered) {
    if (!declared.has(t)) missing.push(t);
  }
  return { declared, discovered, missing };
}

async function main() {
  const repoRoot = defaultRepoRoot();
  const { declared, discovered, missing } = await runGate(repoRoot);
  if (missing.length === 0) {
    console.log(
      `[retention-policy-gate] clean — ${declared.size} declared, ${discovered.size} discovered, 0 missing.`,
    );
    process.exit(0);
  }
  console.error(
    `[retention-policy-gate] ${missing.length} object type(s) discovered in the codebase but missing a retention declaration in ${POLICY_FILE}:\n`,
  );
  for (const t of missing) console.error(`  ${t}`);
  console.error(
    `\nFix: add an entry to RETENTION_POLICIES with { kind: "indefinite" } (PoC default) or a concrete retention.`,
  );
  process.exit(1);
}

// Only invoke main() when this file is executed directly (not when imported).
const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirect) {
  main().catch((e) => {
    console.error("[retention-policy-gate] fatal:", e);
    process.exit(2);
  });
}
