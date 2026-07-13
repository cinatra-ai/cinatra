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
//   3. pr-evidence is ABSENT from the tree — both the directory and any
//      tracked entry named exactly `pr-evidence` (render/screenshot evidence
//      goes to an evidence branch by commit-SHA permalink, never the product tree).
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

// 3. pr-evidence absent — the pathspec `pr-evidence` matches both a tracked
// entry named exactly pr-evidence AND everything under pr-evidence/.
const prEvidence = tracked("pr-evidence");
if (prEvidence.length > 0) {
  errors.push(
    `pr-evidence must be absent from the product tree (evidence goes to an evidence branch): ${prEvidence
      .slice(0, 5)
      .join(", ")}${prEvidence.length > 5 ? ` … (+${prEvidence.length - 5} more)` : ""}`,
  );
}

if (errors.length > 0) {
  console.error("[repo-docs-tree-guard] FAIL:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `[repo-docs-tree-guard] OK — docs/ = {README.md, internals/} (${docsFiles.length} tracked files, 0 json), pr-evidence absent.`,
);
