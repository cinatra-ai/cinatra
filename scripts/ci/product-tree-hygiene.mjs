#!/usr/bin/env node
// Product tree hygiene gate — nothing development-related lives in a checkout.
//
// The product tree carries the PRODUCT: source, tests, fixtures, config, and
// the in-repo engineering docs. It does not carry the things a developer or an
// agent generates while working on the product — proofs, screenshots, planning
// notes, agent scratch, dependency installs, build output, local runtime data.
// Those belong OUTSIDE every checkout: proofs are recorded on the PR, planning
// lives in the tracker, installs are rebuilt by the toolchain, and a real test
// input is a NAMED FIXTURE under tests/** (a fixture is product; a capture of a
// run is not).
//
// A pre-commit hook enforces this on ONE machine. This gate enforces it for the
// org, on every pull request, mechanically — and it is the reason a stray
// proof directory, planning note, or dependency install cannot re-enter the
// tree by way of a rebase, a `git add -A`, or an agent working from a different
// profile. (The names themselves are the rule set below, not this prose.)
//
// TWO ANCHORING CLASSES, and the difference is load-bearing:
//
//   ANY DEPTH — names that are never legitimate product paths at any level.
//     A `node_modules/` or an `evidence/` is the same mistake nested inside a
//     package as it is at the root, so `packages/x/evidence/y.png` is caught.
//
//   ROOT ONLY — names that ARE legitimate product somewhere else in the tree,
//     either nested or at a designated home. This repo
//     tracks `src/app/agents/[vendor]/[packageName]/[instanceId]/data/page.tsx`
//     (a route segment named `data`) and 330 files under `packages/extensions/`
//     (a workspace package named `extensions`). Those are product. Only the
//     ROOT `data/` and `extensions/` are the local-runtime clone targets the
//     ruling is about, so those rules anchor at the root and the nested product
//     paths are untouched — by ANCHORING, never by an allowlist.
//
// There is NO allowlist file, deliberately. An allowlist is how a rule like
// this dies: the first exception is argued once, and after that the list is the
// policy. If a path is genuinely product, it does not match these names; if it
// matches these names, it is not product. A rule that needs an exception is a
// rule that is wrong and gets fixed in this file, in the open.
//
// Deterministic and dependency-free (node + git only): asserts against the
// TRACKED tree (git ls-files), so it is independent of the working tree — your
// local node_modules/, .next/, and scratch directories are not the subject, and
// a gitignored file is never a finding. Run from anywhere in the repo:
//   node scripts/ci/product-tree-hygiene.mjs
//   node scripts/ci/product-tree-hygiene.mjs --json
//   git ls-files | node scripts/ci/product-tree-hygiene.mjs --stdin

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Directory names that are never a legitimate product path AT ANY DEPTH.
 * Matched as a path SEGMENT: `evidence/...` and `packages/x/evidence/...` both
 * hit; `pr-evidence/` does not hit the `evidence` rule (the segment must be the
 * whole name) and carries its own rule below.
 */
export const ANY_DEPTH_DIRS = [
  "node_modules",
  ".next",
  ".pytest_cache",
  "__pycache__",
  ".claude",
  ".planning",
  "evidence",
  "pr-evidence",
];

/**
 * Directory names forbidden only at the ROOT — nested, each is a real product
 * name in this repo (see the header). Root-anchored, not allowlisted.
 */
export const ROOT_DIRS = ["data", "dev", "extensions", "test-results"];

/** Individual files forbidden at the ROOT. */
export const ROOT_FILES = [
  // Next.js writes it on every build; it is regenerated, never authored.
  { rule: "root:next-env.d.ts", re: /^next-env\.d\.ts$/ },
  // Local environment, by definition machine-specific — and a credential risk.
  { rule: "root:.env.local", re: /^\.env\.local$/ },
  { rule: "root:.env.*.local", re: /^\.env\.[^/]+\.local$/ },
  // Per-slice integration tiers that accreted at the root, one config per issue
  // number, until the root listing read as a worklog. These are real product —
  // they simply do not belong in the root namespace, and they now live at
  // `vitest/integration/<NNNN>.config.ts`. The rule is root-anchored AND
  // extension-bound so the new home never matches (`vitest/integration/...` has
  // no `vitest.integration-` root segment) and neither does a package-local one.
  {
    rule: "root:vitest.integration-*.config.*",
    re: /^vitest\.integration-[^/]+\.config\.(ts|mts|js|mjs)$/,
  },
];

/** Escape a literal directory name for embedding in a RegExp. */
function esc(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The full rule set, in evaluation order. Each entry is `{ rule, re }`; `rule`
 * is the stable identifier printed beside every hit and emitted in --json.
 */
export const RULES = [
  ...ANY_DEPTH_DIRS.map((name) => ({
    rule: `any-depth:${name}/`,
    re: new RegExp(`(^|/)${esc(name)}/`),
  })),
  ...ROOT_DIRS.map((name) => ({
    rule: `root:${name}/`,
    re: new RegExp(`^${esc(name)}/`),
  })),
  ...ROOT_FILES,
];

/**
 * Find every forbidden path in `paths`. Returns `[{ path, rule }]` — the FIRST
 * matching rule per path, so a path is reported once with the most specific
 * reason it is here rather than once per overlapping rule.
 */
export function findHits(paths) {
  const hits = [];
  for (const path of paths) {
    const match = RULES.find(({ re }) => re.test(path));
    if (match) hits.push({ path, rule: match.rule });
  }
  return hits;
}

/** Tracked paths (NUL-safe), relative to the repo root. */
function trackedPaths() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

/** Newline-separated paths on stdin, for `--stdin`. */
function stdinPaths() {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  return raw.split("\n").filter(Boolean);
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const paths = args.includes("--stdin") ? stdinPaths() : trackedPaths();
  const hits = findHits(paths);

  if (json) {
    process.stdout.write(`${JSON.stringify({ hits })}\n`);
    return hits.length > 0 ? 1 : 0;
  }

  if (hits.length > 0) {
    console.error("[product-tree-hygiene] FAIL:");
    for (const { rule, path } of hits) console.error(`  ${rule}\t${path}`);
    const byRule = new Map();
    for (const { rule } of hits) byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    console.error(
      `\n[product-tree-hygiene] ${hits.length} forbidden path(s) in the tracked tree ` +
        `across ${byRule.size} rule(s): ${[...byRule]
          .map(([rule, n]) => `${rule} (${n})`)
          .join(", ")}.`,
    );
    console.error(
      "\nDevelopment artifacts do not live in the checkout. Proofs and screenshots\n" +
        "are recorded on the PR; planning notes live in the tracker; installs and\n" +
        "build output are regenerated by the toolchain; a real test input is a NAMED\n" +
        "FIXTURE under tests/**, not a captured run. Remove the paths from the tree\n" +
        "(`git rm -r --cached <path>`) and add them to .gitignore. There is no\n" +
        "allowlist: a path that belongs to the product does not match these names.",
    );
    return 1;
  }

  console.log(
    `[product-tree-hygiene] OK — ${paths.length} tracked paths, 0 development artifacts ` +
      `(${RULES.length} rules: ${ANY_DEPTH_DIRS.length} any-depth, ` +
      `${ROOT_DIRS.length + ROOT_FILES.length} root-anchored).`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
