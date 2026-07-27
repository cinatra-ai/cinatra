#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CI gate: SKILL PACKAGING + STRUCTURE (cinatra#2089, epic #2086 S2).
//
// Runs THE shared verdict (`scripts/audit/_lib/skill-packaging-verdict.mjs`)
// — the same module the store-install seam
// (`src/lib/skill-packaging-install-gate.ts`) and the extension repos' publish
// gate consume — over two universes:
//
//   ARM A — the HOST's own in-package skills. Every git-tracked SKILL.md under
//           `packages/` and `src/` is a bundle root; its directory is the
//           bundle. The four core-shipped skills (assistant-mention-poll,
//           trigger, send-email-outreach-campaign, mcp-autodiscovery) pass the
//           SAME schema as the catalog's system tier — that is the point.
//
//   ARM B — the CLONED-BACK extension universe (`extensions/<owner>/<repo>/`,
//           hydrated by .github/actions/clone-extensions at the SHAs pinned in
//           the two lock files). Each package dispatches on `cinatra.kind`:
//             kind:"skill" → one-bundle / singular-suffix / bundle schema,
//                            with the enumerated legacy ledger applied;
//             any other    → the package-wide SKILL.md ban (ANY path outside
//                            the shared fixture allowlist).
//           Arm B is SKIPPED with a notice when `extensions/` is absent, so a
//           local run without clone-back still exercises Arm A.
//
// Two policy artifacts, both shared verbatim with the other two enforcement
// points:
//   config/skill-fixture-allowlist.json          — what is not a loadable skill
//   config/skill-packaging-legacy-exceptions.json — the expiring S3 ledger
// The ledger also carries the `embeddedSkills` ratchet — the embedded-skill
// findings that already exist in the pinned extension universe and that the S3
// migration wave (cinatra#2090) will delete. ONE artifact, so the CI gate and
// the store-install seam can never ratchet differently.
//
// Usage:
//   node scripts/audit/skill-packaging-gate.mjs                  # exit 1 on any NEW finding
//   node scripts/audit/skill-packaging-gate.mjs --write-baseline # regenerate the ratchet
//   node scripts/audit/skill-packaging-gate.mjs --strict         # also fail on STALE baseline entries
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  VERDICT_CONTRACT_VERSION,
  SKILL_ROUTER_FILENAME,
  applyLegacyExceptions,
  formatViolations,
  matchesAllowlist,
  resolveFixtureAllowlist,
  validateNonSkillExtensionPackage,
  validateSkillBundle,
  validateSkillExtensionPackage,
} from "./_lib/skill-packaging-verdict.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const ALLOWLIST_PATH = join(REPO_ROOT, "config", "skill-fixture-allowlist.json");
const LEDGER_PATH = join(REPO_ROOT, "config", "skill-packaging-legacy-exceptions.json");

const HOST_SCAN_PREFIXES = ["packages/", "src/"];
const EXTENSIONS_ROOT = join(REPO_ROOT, "extensions");
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo"]);

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** POSIX-relative path of `abs` under `root`. */
function relPosix(root, abs) {
  return relative(root, abs).split(/[\\/]/).join(posix.sep);
}

// ---------------------------------------------------------------------------
// ARM A — host in-package skills
// ---------------------------------------------------------------------------

function gitTrackedFiles() {
  try {
    return execFileSync("git", ["ls-files"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Every git-tracked SKILL.md under the host scan prefixes, paired with the
 * other tracked files that share its directory subtree (the bundle).
 */
export function collectHostBundles(trackedFiles, allowlist) {
  const routers = trackedFiles.filter(
    (f) =>
      f.endsWith(`/${SKILL_ROUTER_FILENAME}`) &&
      HOST_SCAN_PREFIXES.some((p) => f.startsWith(p)) &&
      !matchesAllowlist(f, allowlist),
  );
  return routers.map((router) => {
    const dir = router.slice(0, -(SKILL_ROUTER_FILENAME.length + 1));
    const prefix = `${dir}/`;
    const files = trackedFiles
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({ path: f.slice(prefix.length), abs: join(REPO_ROOT, f) }));
    return { relDir: dir, dirName: dir.split("/").pop(), routerRel: router, files };
  });
}

function sizeOf(abs) {
  try {
    return statSync(abs).size;
  } catch {
    return 0;
  }
}

function runArmA(allowlist) {
  const bundles = collectHostBundles(gitTrackedFiles(), allowlist);
  const violations = [];
  for (const b of bundles) {
    let routerText;
    try {
      routerText = readFileSync(join(REPO_ROOT, b.routerRel), "utf8");
    } catch {
      continue;
    }
    violations.push(
      ...validateSkillBundle({
        dirName: b.dirName,
        routerText,
        files: b.files.map((f) => ({ path: f.path, byteLength: sizeOf(f.abs) })),
        label: b.relDir,
      }),
    );
  }
  return { scanned: bundles.length, violations };
}

// ---------------------------------------------------------------------------
// ARM B — cloned-back extension packages
// ---------------------------------------------------------------------------

/** Walk a package tree, returning POSIX package-relative file paths. */
function walkPackageFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        out.push(relPosix(root, full));
      }
    }
  };
  walk(root);
  return out;
}

/** Every cloned-back package root (`extensions/<owner>/<repo>/package.json`). */
export function discoverExtensionPackages(extensionsRoot) {
  if (!existsSync(extensionsRoot)) return [];
  const out = [];
  for (const owner of readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!owner.isDirectory()) continue;
    const ownerDir = join(extensionsRoot, owner.name);
    for (const repo of readdirSync(ownerDir, { withFileTypes: true })) {
      if (!repo.isDirectory()) continue;
      const root = join(ownerDir, repo.name);
      const manifestPath = join(root, "package.json");
      if (!existsSync(manifestPath)) continue;
      const pkg = readJson(manifestPath, null);
      if (!pkg || typeof pkg !== "object") continue;
      const kind = pkg.cinatra?.kind;
      if (typeof kind !== "string") continue;
      out.push({ root, packageName: pkg.name, kind, cinatra: pkg.cinatra });
    }
  }
  return out.sort((a, b) => String(a.packageName).localeCompare(String(b.packageName)));
}

/**
 * Group a package's files into bundles (a directory holding a `SKILL.md`) and
 * strays. A bundle's files are everything under the bundle directory.
 */
export function groupPackageBundles(files) {
  const routers = files.filter((f) => f === SKILL_ROUTER_FILENAME || f.endsWith(`/${SKILL_ROUTER_FILENAME}`));
  const bundles = [];
  const strays = [];
  for (const router of routers) {
    const dir = router === SKILL_ROUTER_FILENAME ? "" : router.slice(0, -(SKILL_ROUTER_FILENAME.length + 1));
    // The canonical authoring layout is `skills/<name>/SKILL.md`. A router at
    // any other depth is not a bundle root the packager would upload.
    const segments = dir === "" ? [] : dir.split("/");
    if (segments.length !== 2 || segments[0] !== "skills") {
      strays.push(router);
      continue;
    }
    const prefix = `${dir}/`;
    bundles.push({
      relDir: dir,
      dirName: segments[1],
      routerRel: router,
      bundleFiles: files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length)),
    });
  }
  return { bundles, strays };
}

function runArmB(allowlist, ledger, baseline, options) {
  const packages = discoverExtensionPackages(EXTENSIONS_ROOT);
  const violations = [];
  const waivedAll = [];
  const embeddedFindings = [];

  for (const pkg of packages) {
    const files = walkPackageFiles(pkg.root);
    if (pkg.kind === "skill") {
      const { bundles, strays } = groupPackageBundles(files);
      const raw = validateSkillExtensionPackage({
        packageName: pkg.packageName,
        manifest: pkg.cinatra,
        straySkillMdPaths: strays,
        bundles: bundles.map((b) => ({
          dirName: b.dirName,
          relDir: `${pkg.packageName}/${b.relDir}`,
          routerText: (() => {
            try {
              return readFileSync(join(pkg.root, b.routerRel), "utf8");
            } catch {
              return "";
            }
          })(),
          files: b.bundleFiles.map((p) => ({ path: p, byteLength: sizeOf(join(pkg.root, b.relDir, p)) })),
        })),
      });
      const { blocking, waived } = applyLegacyExceptions(raw, {
        packageName: pkg.packageName,
        ledger,
      });
      violations.push(...blocking.map((v) => ({ ...v, packageName: pkg.packageName })));
      waivedAll.push(...waived.map((v) => ({ ...v, packageName: pkg.packageName })));
      continue;
    }
    const skillMds = files.filter((f) => f === SKILL_ROUTER_FILENAME || f.endsWith(`/${SKILL_ROUTER_FILENAME}`));
    const found = validateNonSkillExtensionPackage({
      packageName: pkg.packageName,
      kind: pkg.kind,
      skillMdPaths: skillMds,
      allowlist,
    });
    for (const v of found) {
      embeddedFindings.push({ ...v, packageName: pkg.packageName, key: `${pkg.packageName} :: ${v.path}` });
    }
  }

  const baselineSet = new Set(baseline);
  const newEmbedded = embeddedFindings.filter((f) => !baselineSet.has(f.key));
  const stale = options.strict ? baseline.filter((k) => !embeddedFindings.some((f) => f.key === k)) : [];

  return {
    scanned: packages.length,
    violations,
    waived: waivedAll,
    embeddedFindings,
    newEmbedded,
    stale,
    skipped: packages.length === 0 && !existsSync(EXTENSIONS_ROOT),
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function run(options = {}) {
  const policy = readJson(ALLOWLIST_PATH, {});
  const ledger = readJson(LEDGER_PATH, { exceptions: [] });
  const hostAllowlist = resolveFixtureAllowlist(policy, "cinatra");
  const extensionAllowlist = resolveFixtureAllowlist(policy, "__extension-repo__");
  const baseline = Array.isArray(ledger.embeddedSkills) ? ledger.embeddedSkills : [];

  const armA = runArmA(hostAllowlist);
  const armB = runArmB(extensionAllowlist, ledger, baseline, options);
  return { armA, armB, hostAllowlist, extensionAllowlist };
}

function main() {
  const argv = process.argv.slice(2);
  const writeBaseline = argv.includes("--write-baseline");
  const strict = argv.includes("--strict");
  const { armA, armB } = run({ strict });

  if (writeBaseline) {
    const keys = [...new Set(armB.embeddedFindings.map((f) => f.key))].sort();
    const ledger = readJson(LEDGER_PATH, {});
    ledger.embeddedSkills = keys;
    writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
    console.log(
      `[skill-packaging-gate] ledger embeddedSkills written: ${keys.length} entr(ies) ` +
        "(regenerate ONLY with the clone-back universe hydrated).",
    );
    return;
  }

  const blocking = [...armA.violations, ...armB.violations];
  let failed = false;

  console.log(
    `[skill-packaging-gate] verdict v${VERDICT_CONTRACT_VERSION} — ` +
      `${armA.scanned} host bundle(s), ${armB.scanned} cloned-back extension package(s).`,
  );
  if (armB.skipped) {
    console.log(
      "[skill-packaging-gate] extensions/ not hydrated — ARM B (extension packages) skipped. " +
        "CI runs it after .github/actions/clone-extensions.",
    );
  }
  if (armB.waived.length > 0) {
    console.log(
      `[skill-packaging-gate] ${armB.waived.length} violation(s) WAIVED by config/skill-packaging-legacy-exceptions.json ` +
        "(the S3 migration wave deletes these entries):",
    );
    for (const v of armB.waived) console.log(`  ~ [${v.code}] ${v.message}`);
  }

  if (blocking.length > 0) {
    failed = true;
    console.error(`\n${formatViolations(blocking, "skill packaging")}`);
  }
  if (armB.newEmbedded.length > 0) {
    failed = true;
    console.error(
      `\n[skill-packaging-gate] ${armB.newEmbedded.length} NEW embedded skill(s) in non-skill extension(s) ` +
        "(not in the baseline ratchet):",
    );
    for (const f of armB.newEmbedded) console.error(`  - ${f.key}\n      ${f.message}`);
  }
  if (armB.stale.length > 0) {
    failed = true;
    console.error(
      `\n[skill-packaging-gate] ${armB.stale.length} STALE baseline entry(ies) — the embedded skill is gone; ` +
        "remove it from the baseline:",
    );
    for (const k of armB.stale) console.error(`  - ${k}`);
  }

  if (failed) process.exit(1);
  console.log(
    `[skill-packaging-gate] OK (${armB.embeddedFindings.length} embedded skill(s) still pending the S3 migration wave).`,
  );
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error("[skill-packaging-gate] unexpected error", err);
    process.exit(1);
  }
}
