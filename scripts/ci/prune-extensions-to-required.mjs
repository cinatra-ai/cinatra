#!/usr/bin/env node
// Prune the on-disk extension universe to the DECLARED bootable set
// (cinatra.extensions) — the full fresh-public-clone build gate's
// presence shape (cinatra#7, dep-drop slice; graduates the one-probe check).
//
// Deletes every extensions/<scope>/<name>/ package directory whose
// package.json name is NOT declared in `cinatra.extensions` (root
// package.json) and prints the removed package names (one per line) to the
// `--out` file so the caller can assert the regenerated maps omit each one.
//
// Data-driven, no extension-name literals. Fail-closed:
//   - refuses an empty/absent extensions declaration;
//   - fails when NOTHING was removed (the clone-back tree always carries
//     optional packages — a no-op prune means the gate degenerated);
//   - fails when a REQUIRED package is missing from disk after the prune
//     (the build below would not exercise the declared bootable set).
//
// Usage:
//   node scripts/ci/prune-extensions-to-required.mjs --out /tmp/pruned-extensions.txt
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;

const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const requiredRaw = rootPkg?.cinatra?.extensions;
if (!Array.isArray(requiredRaw) || requiredRaw.length === 0) {
  console.error("[prune-extensions-to-required] FAIL: cinatra.extensions is empty/absent.");
  process.exit(1);
}
// Mirror the canonical parser's last-@ split (name@range entries).
const required = new Set(
  requiredRaw
    .filter((e) => typeof e === "string" && e.trim().length > 0)
    .map((e) => {
      const t = e.trim();
      const at = t.lastIndexOf("@");
      return at <= 0 ? t : t.slice(0, at);
    }),
);

const extRoot = join(REPO_ROOT, "extensions");
if (!existsSync(extRoot)) {
  console.error("[prune-extensions-to-required] FAIL: extensions/ tree is absent (clone-back missing).");
  process.exit(1);
}

const removed = [];
const kept = [];
for (const scope of readdirSync(extRoot)) {
  const scopeDir = join(extRoot, scope);
  if (!statSync(scopeDir).isDirectory()) continue;
  for (const dir of readdirSync(scopeDir)) {
    const pkgDir = join(scopeDir, dir);
    const manifestPath = join(pkgDir, "package.json");
    if (!statSync(pkgDir).isDirectory() || !existsSync(manifestPath)) continue;
    let name;
    try {
      name = JSON.parse(readFileSync(manifestPath, "utf8")).name;
    } catch {
      console.error(`[prune-extensions-to-required] FAIL: unreadable manifest at ${manifestPath}.`);
      process.exit(1);
    }
    if (required.has(name)) {
      kept.push(name);
    } else {
      rmSync(pkgDir, { recursive: true, force: true });
      removed.push(name);
    }
  }
}

if (removed.length === 0) {
  console.error(
    "[prune-extensions-to-required] FAIL: nothing was pruned — the universe already equals the " +
      "required set, so this gate would not prove presence-aware omission. (CI clones the full " +
      "companion tree; an empty prune means the clone-back or this script regressed.)",
  );
  process.exit(1);
}
const missingRequired = [...required].filter((name) => !kept.includes(name));
if (missingRequired.length > 0) {
  console.error(
    `[prune-extensions-to-required] FAIL: ${missingRequired.length} REQUIRED package(s) missing from ` +
      `disk after the prune: ${missingRequired.join(", ")} — the build would not exercise the declared bootable set.`,
  );
  process.exit(1);
}

removed.sort();
if (outFile) writeFileSync(outFile, removed.join("\n") + "\n");
console.log(
  `[prune-extensions-to-required] OK — pruned ${removed.length} optional package(s); ` +
    `kept the declared bootable set (${kept.length} package(s) = extensions ${required.size}).`,
);
console.log(removed.map((n) => `  - ${n}`).join("\n"));
