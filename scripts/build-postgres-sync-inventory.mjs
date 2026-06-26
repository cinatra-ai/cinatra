#!/usr/bin/env node
/**
 * Postgres sync-bridge caller inventory builder (#303).
 *
 * Statically scans every direct `runPostgresQueriesSync(` call site across
 * `src/` and `packages/` and emits a machine-readable JSON inventory consumed
 * by the inventory ratchet test at:
 *   src/lib/__tests__/postgres-sync-inventory.test.ts
 *
 * The per-file CLASSIFICATION (sync-required / migratable-request-path /
 * migratable-background-setup) + justification lives in the hand-authored TS
 * augmentation:
 *   src/lib/postgres-sync-inventory.ts
 *
 * The inventory records the CALL COUNT per file, not just presence. The ratchet
 * gate fails when:
 *   - a file appears in the scan but is not classified, OR
 *   - a classified file no longer appears in the scan (stale), OR
 *   - any file's call count GROWS beyond its recorded count (a new direct
 *     sync call site was added — to an existing OR a brand-new file), OR
 *   - the generated file is out of date with the source tree (--check).
 *
 * Usage:
 *   node scripts/build-postgres-sync-inventory.mjs           (rebuild)
 *   node scripts/build-postgres-sync-inventory.mjs --check   (fail if stale)
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const ROOTS = ["src", "packages"];
const OUT = join(ROOT, "docs/architecture/postgres-sync-inventory.json");

// Direct call sites only (not the import, not the definition's `export function`).
const CALL_RE = /runPostgresQueriesSync\s*\(/g;

// The definition module is excluded — it is the escape hatch itself, not a
// caller of it. Tests/stubs/fixtures are excluded — they are not prod paths.
const DEFINITION_FILE = "src/lib/postgres-sync.ts";

/** @param {string} dir */
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry === "node_modules" ||
      entry === ".next" ||
      entry === "dist" ||
      entry === "__generated__"
    ) {
      continue;
    }
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

function isExcluded(rel) {
  if (rel === DEFINITION_FILE) return true;
  if (/__tests__|__stubs__|__mocks__/.test(rel)) return true;
  if (/\.test\.tsx?$/.test(rel)) return true;
  if (/\.spec\.tsx?$/.test(rel)) return true;
  return false;
}

/** @returns {{ file: string, calls: number }[]} */
function scan() {
  /** @type {{ file: string, calls: number }[]} */
  const out = [];
  for (const r of ROOTS) {
    for (const full of walk(join(ROOT, r))) {
      const rel = relative(ROOT, full).split("\\").join("/");
      if (isExcluded(rel)) continue;
      const src = readFileSync(full, "utf8");
      const matches = src.match(CALL_RE);
      if (matches && matches.length > 0) {
        out.push({ file: rel, calls: matches.length });
      }
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

function build() {
  const callers = scan();
  return {
    generatedBy: "scripts/build-postgres-sync-inventory.mjs",
    note:
      "DO NOT EDIT BY HAND. Re-run `pnpm sync:inventory`. Per-file classification + justification lives in src/lib/postgres-sync-inventory.ts.",
    totalCallSites: callers.reduce((n, c) => n + c.calls, 0),
    callers,
  };
}

function serialize(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

const isCheck = process.argv.includes("--check");
const isPrint = process.argv.includes("--print");
const built = build();
const next = serialize(built);

if (isPrint) {
  // Emit the LIVE scan to stdout without touching the committed file. The ratchet
  // gate uses this to compare the live tree against the committed baseline (so
  // the ratchet can never degrade into a committed-vs-committed no-op).
  process.stdout.write(next);
} else if (isCheck) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    current = "";
  }
  if (current !== next) {
    console.error(
      `[postgres-sync-inventory] ${relative(ROOT, OUT)} is stale.\n` +
        "Run `pnpm sync:inventory` and commit the result.",
    );
    process.exit(1);
  }
  console.log(`[postgres-sync-inventory] ${relative(ROOT, OUT)} is up to date.`);
} else {
  writeFileSync(OUT, next);
  console.log(`[postgres-sync-inventory] wrote ${relative(ROOT, OUT)}.`);
}
