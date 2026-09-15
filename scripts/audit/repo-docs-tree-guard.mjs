#!/usr/bin/env node
// Repo docs-layout tree-state guard (cinatra#1446 AC8).
//
// docs/ is the in-repo engineering/agent documentation home and must stay
// structurally clean after the #1446/#1420 relocation:
//   1. docs/ top-level tracked entries are EXACTLY {README.md, internals}
//      — README.md a regular file (git mode 100644), internals a directory
//      (tracked files beneath it, no tracked entry named exactly docs/internals).
//   2. NO *.json anywhere under docs/** — machine-consumed config/data lives
//      under config/ (e.g. config/upgrade/upgrade-matrix.json), never in docs.
//   3. NO PROOF ARTIFACTS ARE TRACKED — neither `pr-evidence` nor `evidence`,
//      as a directory or as a tracked entry with that exact name. Captures,
//      run records and PR proof bundles are posted on the pull request and
//      cited by commit-SHA permalink; they never enter the product tree.
//      `.gitignore` is not enforcement — `git add -f` walks straight past it,
//      and a 150MB proof tree is exactly the thing somebody force-adds "just
//      this once". This is the check that actually holds the line.
//
// Deterministic and dependency-free (node + git only): asserts against the
// TRACKED tree (git ls-files), so it is independent of build artifacts,
// node_modules, or working-tree scratch files. Run from anywhere in the repo:
//   node scripts/audit/repo-docs-tree-guard.mjs

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Tracked paths (NUL-safe) under a pathspec. */
function tracked(pathspec) {
  const out = execFileSync("git", ["ls-files", "-z", "--", pathspec], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean);
}

/** Tracked `mode<TAB>path` stage entries (NUL-safe) under a pathspec. */
function trackedWithMode(pathspec) {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--format=%(objectmode) %(path)", "--", pathspec],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const sp = line.indexOf(" ");
      return { mode: line.slice(0, sp), path: line.slice(sp + 1) };
    });
}

const errors = [];
const docsFiles = tracked("docs/");

// 1a. Top level is exactly {README.md, internals}.
const topLevel = [...new Set(docsFiles.map((f) => f.replace(/^docs\//, "").split("/")[0]))].sort();
if (JSON.stringify(topLevel) !== JSON.stringify(["README.md", "internals"])) {
  errors.push(
    `docs/ top-level tracked entries must be exactly {README.md, internals}; found: {${topLevel.join(", ")}}. ` +
      "In-repo engineering/agent docs belong under docs/internals/ (see docs/internals/README.md); " +
      "machine config belongs under config/.",
  );
}

// 1b. README.md is a REGULAR FILE (mode 100644) — a symlink (120000) does not
// pass. The pathspec `docs/README.md` RECURSES: were docs/README.md a directory
// (a tracked docs/README.md/<child>), ls-files would return that child as a
// single 100644 entry and falsely accept it — so also require the entry's path
// to be EXACTLY docs/README.md (a blob at that path), not a descendant.
const readme = trackedWithMode("docs/README.md");
if (readme.length !== 1 || readme[0].mode !== "100644" || readme[0].path !== "docs/README.md") {
  errors.push(
    `docs/README.md must be a tracked regular file (mode 100644) at exactly docs/README.md; found: ${
      readme.length ? readme.map((e) => `${e.mode} ${e.path}`).join(", ") : "absent"
    }.`,
  );
}

// 1c. internals is a DIRECTORY: tracked files beneath it, and no tracked
// entry (file/symlink) named exactly docs/internals.
if (!docsFiles.some((f) => f.startsWith("docs/internals/"))) {
  errors.push("docs/internals/ must exist (no tracked files beneath it).");
}
if (docsFiles.includes("docs/internals")) {
  errors.push("docs/internals must be a directory, not a tracked file/symlink.");
}

// 2. No *.json anywhere under docs/**.
const jsonUnderDocs = docsFiles.filter((f) => f.endsWith(".json"));
if (jsonUnderDocs.length > 0) {
  errors.push(
    `machine-consumed *.json must live under config/, not docs/: ${jsonUnderDocs.join(", ")}`,
  );
}

// 3. No proof-artifact tree is tracked. Each pathspec matches BOTH a tracked
// entry with exactly that name AND everything beneath it as a directory.
const PROOF_ARTIFACT_ROOTS = ["evidence", "pr-evidence"];

/** The tracked proof-artifact paths, as an error string, or null when clean. */
function proofArtifactViolation(root, paths) {
  if (paths.length === 0) return null;
  return (
    `${root}/ must be absent from the product tree — proof artifacts are posted on the PR and ` +
    `cited by commit-SHA permalink, never committed: ${paths.slice(0, 5).join(", ")}` +
    `${paths.length > 5 ? ` … (+${paths.length - 5} more)` : ""}`
  );
}

for (const root of PROOF_ARTIFACT_ROOTS) {
  const violation = proofArtifactViolation(root, tracked(root));
  if (violation) errors.push(violation);
}

if (errors.length > 0) {
  console.error("[repo-docs-tree-guard] FAIL:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `[repo-docs-tree-guard] OK — docs/ = {README.md, internals/} (${docsFiles.length} tracked files, 0 json), ` +
    `no tracked proof artifacts (${PROOF_ARTIFACT_ROOTS.map((r) => `${r}/`).join(", ")}).`,
);
