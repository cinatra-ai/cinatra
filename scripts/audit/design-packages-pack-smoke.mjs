#!/usr/bin/env node
/**
 * Design-packages pack-smoke (local).
 *
 * Runs `pnpm pack` on `@cinatra-ai/design` and `@cinatra-ai/sdk-ui`, then
 * verifies the produced tarballs contain the expected files (CSS, TS, README,
 * LICENSE). This is the LOCAL smoke that ships in CI without requiring a
 * reachable production Verdaccio — when the deploy wrapper / production
 * registry credentials are available, a separate publish step (see CI job
 * docs) actually publishes the same tarballs.
 *
 * Acceptance check:
 *   - `pnpm pack` succeeds for both packages
 *   - The tarball contains every entry in EXPECTED_FILES
 *   - The tarball does NOT contain entries from FORBIDDEN_FILES
 *     (`node_modules/`, `.env*`, `*.local.json`)
 *   - Files declared on `consumerPortableEntryPoints` (the subpaths external
 *     consumers actually import) and their transitive in-package imports
 *     contain ZERO app-local alias references (`@/components/*`, `@/lib/*`,
 *     `@/app/*`). This is the consumer-portability blocker that a pure
 *     content check misses — a tarball can contain a file that compiles
 *     inside the monorepo but breaks the moment an external consumer's
 *     `tsc` walks it.
 *
 * Usage:
 *   node scripts/audit/design-packages-pack-smoke.mjs
 *   node scripts/audit/design-packages-pack-smoke.mjs --json
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exec = promisify(execFile);
const REPO_ROOT = resolve(new URL("../..", import.meta.url).pathname);

const TARGETS = [
  {
    name: "@cinatra-ai/design",
    packageDir: "packages/design",
    expectedFiles: [
      "package/package.json",
      "package/src/index.ts",
      "package/src/tokens.css",
      "package/src/theme.css",
      "package/src/utilities.css",
      "package/src/fonts.css",
      "package/src/index.css",
      "package/src/brand/colors.ts",
      "package/src/brand/logo.ts",
      "package/src/brand/icon.svg",
      "package/src/brand/apple-icon.png",
      "package/README.md",
      "package/LICENSE",
    ],
    forbiddenFiles: [
      "package/node_modules",
      "package/.env",
      "package/.env.local",
    ],
    // External consumers can import any of these. Every TS file reachable
    // from these entry points MUST be free of app-local `@/` aliases.
    consumerPortableEntryPoints: [
      "package/src/index.ts",
      "package/src/brand/colors.ts",
      "package/src/brand/logo.ts",
    ],
  },
  {
    name: "@cinatra-ai/sdk-ui",
    packageDir: "packages/sdk-ui",
    expectedFiles: [
      "package/package.json",
      "package/src/index.ts",
      "package/src/marketplace.ts",
      "package/src/main.tsx",
      "package/src/page-header.tsx",
      "package/src/page-content.tsx",
      "package/src/status-pill.tsx",
      "package/src/extension-card.tsx",
      "package/src/lib/utils.ts",
      "package/src/lib/extension-accent.ts",
      "package/README.md",
      "package/LICENSE",
    ],
    forbiddenFiles: [
      "package/node_modules",
      "package/.env",
      "package/.env.local",
    ],
    // The `/marketplace` subpath is the consumer-portable surface. The root
    // export (`src/index.ts`) intentionally re-exports cinatra-app-internal
    // modules that DO use `@/components/*` / `@/lib/utils` — those are
    // explicitly NOT consumer-portable. The smoke verifies that
    // `src/marketplace.ts` and its transitive in-package imports stay clean.
    consumerPortableEntryPoints: [
      "package/src/marketplace.ts",
    ],
  },
];

/**
 * App-local TS alias patterns. Any TS file reachable from a consumer-portable
 * entry point that imports one of these will break an external consumer's
 * typecheck.
 */
const APP_LOCAL_IMPORT_PATTERNS = [
  /from\s+["']@\/[^"']+["']/g,
  /import\s+["']@\/[^"']+["']/g,
  /import\(["']@\/[^"']+["']\)/g,
];

/**
 * List a tarball's entries via `tar -tzf`. Returns sorted array of file paths.
 */
async function listTarball(tarballAbsPath) {
  const { stdout } = await exec("tar", ["-tzf", tarballAbsPath]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

/**
 * Extract a single file from a tarball via `tar -xzOf` and return its
 * contents as a UTF-8 string.
 */
async function readTarballFile(tarballAbsPath, entry) {
  const { stdout } = await exec("tar", ["-xzOf", tarballAbsPath, entry]);
  return stdout;
}

/**
 * Resolve a relative import specifier inside the tarball to the actual
 * tarball entry it would target. Returns null when the import is non-relative
 * (npm package — out of scope for the in-package alias scan).
 */
function resolveRelative(fromEntry, importPath) {
  if (!importPath.startsWith(".")) return null;
  const fromDir = fromEntry.replace(/\/[^/]+$/, "");
  const segments = `${fromDir}/${importPath}`.split("/");
  const stack = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join("/");
}

/**
 * Walk transitive in-package imports starting from an entry point, returning
 * the set of TS files reachable. Files in the set will be scanned for
 * forbidden app-local aliases.
 */
async function walkInPackageImports(tarballAbsPath, entries, entryPoint) {
  const visited = new Set();
  const queue = [entryPoint];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    if (!entries.includes(current)) continue;
    visited.add(current);
    const content = await readTarballFile(tarballAbsPath, current);
    const importPattern = /(?:from\s+|import\s+|import\()["']([^"']+)["']/g;
    let m;
    while ((m = importPattern.exec(content)) !== null) {
      const spec = m[1];
      const resolved = resolveRelative(current, spec);
      if (resolved === null) continue;
      // Try common TS extensions.
      const candidates = [
        resolved,
        `${resolved}.ts`,
        `${resolved}.tsx`,
        `${resolved}/index.ts`,
        `${resolved}/index.tsx`,
      ];
      for (const c of candidates) {
        if (entries.includes(c) && !visited.has(c)) {
          queue.push(c);
          break;
        }
      }
    }
  }
  return visited;
}

/**
 * Scan a TS file for app-local `@/` imports and return all hits.
 */
function findAppLocalImports(content) {
  const hits = [];
  for (const pattern of APP_LOCAL_IMPORT_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = re.exec(content)) !== null) {
      hits.push(m[0]);
    }
  }
  return hits;
}

/**
 * Run `pnpm pack` on one package directory; returns the absolute path of the
 * produced tarball. The pack is written into a fresh tempdir so we never
 * pollute the repo root.
 */
async function packOne({ name, packageDir }) {
  const outDir = await mkdtemp(join(tmpdir(), "design-pack-smoke-"));
  // Use `pnpm pack` from the package directory; pnpm writes to cwd.
  // `--pack-destination` is supported by pnpm 11+ and is the safe way to
  // direct the tarball outside the package dir.
  const { stdout } = await exec(
    "corepack",
    ["pnpm", "pack", "--pack-destination", outDir],
    { cwd: join(REPO_ROOT, packageDir) },
  );
  const tarballPath = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".tgz"))
    .pop();
  if (!tarballPath) {
    throw new Error(`pnpm pack succeeded but no tarball path found in stdout for ${name}.`);
  }
  return { tarballPath, outDir };
}

/**
 * Smoke a single target — pack, list, verify expected/forbidden entries.
 */
async function smokeTarget(target) {
  const findings = [];
  let outDir = null;
  try {
    const { tarballPath, outDir: dir } = await packOne(target);
    outDir = dir;
    const entries = await listTarball(tarballPath);
    for (const expected of target.expectedFiles) {
      if (!entries.includes(expected)) {
        findings.push({
          severity: "missing",
          target: target.name,
          file: expected,
          reason: `Expected file not found in ${target.name} tarball.`,
        });
      }
    }
    for (const forbidden of target.forbiddenFiles) {
      const matched = entries.find(
        (e) => e === forbidden || e.startsWith(`${forbidden}/`),
      );
      if (matched) {
        findings.push({
          severity: "forbidden",
          target: target.name,
          file: matched,
          reason: `Forbidden entry present in ${target.name} tarball (\`pnpm pack\` should not include this).`,
        });
      }
    }
    // Also verify the package's `package.json` declares a `name` matching
    // the expected name — defensive parsing in case the lockfile + package.json
    // get out of sync.
    const pjEntry = entries.find((e) => e === "package/package.json");
    if (pjEntry) {
      const { stdout: pjContent } = await exec("tar", ["-xzOf", tarballPath, "package/package.json"]);
      try {
        const pj = JSON.parse(pjContent);
        if (pj.name !== target.name) {
          findings.push({
            severity: "mismatch",
            target: target.name,
            file: "package/package.json",
            reason: `name mismatch: tarball declares "${pj.name}", smoke expected "${target.name}".`,
          });
        }
      } catch (err) {
        findings.push({
          severity: "parse",
          target: target.name,
          file: "package/package.json",
          reason: `package.json parse failed: ${err.message}`,
        });
      }
    }
    // Consumer-portability alias scan — walk transitive in-package imports
    // from each declared entry point and verify NO app-local `@/` aliases
    // appear in any reached file.
    for (const entryPoint of target.consumerPortableEntryPoints ?? []) {
      if (!entries.includes(entryPoint)) {
        findings.push({
          severity: "missing",
          target: target.name,
          file: entryPoint,
          reason: `Declared consumer-portable entry point not in tarball.`,
        });
        continue;
      }
      const reachable = await walkInPackageImports(tarballPath, entries, entryPoint);
      for (const file of reachable) {
        const content = await readTarballFile(tarballPath, file);
        const hits = findAppLocalImports(content);
        for (const hit of hits) {
          findings.push({
            severity: "alias",
            target: target.name,
            file,
            reason: `Reachable from consumer-portable entry "${entryPoint}" but uses an app-local alias that does NOT resolve outside the cinatra-app monorepo: ${hit}`,
          });
        }
      }
    }
    return { target: target.name, entries, findings };
  } catch (err) {
    findings.push({
      severity: "exec",
      target: target.name,
      file: target.packageDir,
      reason: `pnpm pack failed: ${err.message}`,
    });
    return { target: target.name, entries: [], findings };
  } finally {
    if (outDir) {
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Run smoke on every target. Exported for unit tests.
 */
export async function runSmoke() {
  const results = await Promise.all(TARGETS.map(smokeTarget));
  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = (() => {
  try {
    return resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (isMain) {
  const wantJson = process.argv.includes("--json");
  const results = await runSmoke();
  const allFindings = results.flatMap((r) => r.findings);
  if (wantJson) {
    process.stdout.write(JSON.stringify({ ok: allFindings.length === 0, results }, null, 2));
    process.stdout.write("\n");
    process.exit(allFindings.length === 0 ? 0 : 1);
  }
  if (allFindings.length === 0) {
    for (const r of results) {
      console.log(`[design-packages-pack-smoke] OK — ${r.target} packed cleanly (${r.entries.length} entries).`);
    }
    process.exit(0);
  }
  console.error("[design-packages-pack-smoke] FAIL:");
  for (const f of allFindings) {
    console.error(`  [${f.severity}] ${f.target} ${f.file}`);
    console.error(`      ${f.reason}`);
  }
  process.exit(1);
}
