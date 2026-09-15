#!/usr/bin/env node
// No provider credential lives in a file under `docker/` — tracked OR generated.
//
// WHY THIS GATE EXISTS. The knowledge-graph indexer used to receive its
// provider key from `docker/graphiti/.graphiti.env`, a 0600 file the bring-up
// wrote in clear and `env_file:` read at container start. The file was
// gitignored, so no gate could see it, and nothing removed it: it outlived the
// containers, the branch and the checkout, and a decrypted credential sat on
// disk until somebody deleted it by hand. `scripts/gen-graphiti-env.mjs` now
// hands the key to `docker compose` through the process environment instead and
// writes no such file. This gate is what keeps that true — for that service and
// for every service added under `docker/` afterwards.
//
// TWO POPULATIONS, and both matter:
//
//   TRACKED   — `git ls-files docker/`. A credential committed into the tree is
//               published to everyone who clones, forever, and rotating it is
//               the only remedy. This half runs in CI.
//   ON DISK   — everything actually present under `docker/`, gitignored files
//               INCLUDED. That is the half the sibling product-tree-hygiene
//               gate deliberately does not have (it asserts against the tracked
//               tree by design), and it is the half that catches the defect
//               above: `.graphiti.env` was never tracked, it was generated. On
//               a CI runner the working tree is a fresh checkout, so this half
//               is a no-op there and does its work locally and on a lane, where
//               the generated file would be.
//
// A FINDING NEVER QUOTES THE CREDENTIAL. Output names the file, the line and the
// SHAPE that matched — never the matched text. CI logs are broadly readable, so
// a gate that printed its finding would publish the very thing it caught.
//
// Deterministic and dependency-free (node + git only), like
// `scripts/ci/product-tree-hygiene.mjs`, so it runs in the pure-node `gates`
// job with no install. Its unit suite
// (`scripts/ci/__tests__/no-keys-in-docker-tree.test.mjs`) is vitest and rides
// the root include.
//
//   node scripts/ci/no-keys-in-docker-tree.mjs
//   node scripts/ci/no-keys-in-docker-tree.mjs --json
//   node scripts/ci/no-keys-in-docker-tree.mjs --root <dir>   (fixture trees)

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { findKeyShapedLines } from "../lib/key-shaped-values.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// KNOWN, AND DELIBERATELY NOT EXEMPTED: `scripts/gen-wayflow-env.mjs` still
// writes `docker/wayflow/.wayflow.env` with `OPENAI_API_KEY` in clear when
// `.env.local` states one, so a LOCAL run on such a machine flags it. That is a
// true finding — the same artifact shape the knowledge-graph indexer just
// stopped using — and an allowlist entry here would only hide it. CI is
// unaffected (a runner has no generated file), and the contract doc records it
// as the next thing to move.

/** The subtree this gate owns. */
export const SCANNED_DIR = "docker";

/**
 * Directory names never worth walking: they are not product, they are large,
 * and a dependency install under `docker/` is the product-tree-hygiene gate's
 * finding, not this one's.
 */
export const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "venv",
  ".mypy_cache",
  ".ruff_cache",
]);

/** How much of one file this gate reads. A file above this size is a container
 *  image, a wheel or model weights, not configuration — but "too big to read
 *  whole" must not become "not scanned at all", or appending a credential to a
 *  large file would be a way past this gate. So an oversized file is read up to
 *  this many bytes and scanned; only what lies beyond the prefix is out of
 *  reach, and nothing that size is text a credential would hide in. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Is this content text we can meaningfully scan? A NUL byte says binary, and a
 * binary blob's random bytes are exactly where a length-floored pattern would
 * produce a false positive.
 *
 * @param {Buffer} buf
 */
function looksBinary(buf) {
  return buf.includes(0);
}

/**
 * Every file under `<root>/docker` that exists ON DISK, repo-relative and
 * POSIX-separated.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function onDiskPaths(root) {
  const base = join(root, SCANNED_DIR);
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // An unreadable directory is not a finding — it is a permissions fact.
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(relative(root, full).split(sep).join("/"));
    }
  };
  try {
    if (!statSync(base).isDirectory()) return [];
  } catch {
    return [];
  }
  walk(base);
  return out.sort();
}

/**
 * Every TRACKED file under `docker/`, repo-relative. Empty when git is not
 * available or the root is not a repository (a fixture tree) — the on-disk half
 * still covers it.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function trackedPaths(root) {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", SCANNED_DIR], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // Swallow git's own stderr: a fixture tree is not a repository, and
      // "not a git repository" is the expected answer there, not a warning
      // worth printing over a passing test run.
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The first `MAX_FILE_BYTES` of a file, as a Buffer. Used for a file too large
 * to read whole: the alternative is skipping it, and a skipped file is a hole
 * in the gate.
 *
 * @param {string} full
 * @returns {Buffer}
 */
function readPrefix(full) {
  const fd = openSync(full, "r");
  try {
    const buf = Buffer.alloc(MAX_FILE_BYTES);
    const read = readSync(fd, buf, 0, MAX_FILE_BYTES, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Scan `paths` (repo-relative) under `root`.
 *
 * @param {string} root
 * @param {string[]} paths
 * @returns {{ path: string, line: number, label: string }[]}
 */
export function scanFiles(root, paths) {
  const hits = [];
  for (const rel of [...new Set(paths)].sort()) {
    const full = join(root, rel);
    let buf;
    try {
      const stats = statSync(full);
      if (!stats.isFile()) continue;
      buf = stats.size > MAX_FILE_BYTES ? readPrefix(full) : readFileSync(full);
    } catch {
      // A tracked path that is not on disk (a sparse checkout, a deleted file
      // still in the index) is nothing to scan.
      continue;
    }
    if (looksBinary(buf)) continue;
    for (const { label, line } of findKeyShapedLines(buf.toString("utf8"))) {
      hits.push({ path: rel, line, label });
    }
  }
  return hits;
}

/**
 * The gate, as a function: both populations, scanned once.
 *
 * @param {string} root
 * @returns {{ hits: {path: string, line: number, label: string}[], scanned: number }}
 */
export function findHits(root = REPO_ROOT) {
  const paths = [...new Set([...trackedPaths(root), ...onDiskPaths(root)])];
  return { hits: scanFiles(root, paths), scanned: paths.length };
}

function main(argv) {
  const args = argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const root = rootIndex === -1 ? REPO_ROOT : resolve(args[rootIndex + 1] ?? ".");
  const { hits, scanned } = findHits(root);

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ hits, scanned })}\n`);
    return hits.length > 0 ? 1 : 0;
  }

  if (hits.length > 0) {
    console.error("[no-keys-in-docker-tree] FAIL:");
    // The SHAPE and the position, never the value.
    for (const { path, line, label } of hits) {
      console.error(`  ${path}:${line}\t${label}`);
    }
    console.error(
      `\n[no-keys-in-docker-tree] ${hits.length} key-shaped value(s) in ` +
        `${new Set(hits.map((h) => h.path)).size} file(s) under ${SCANNED_DIR}/.\n\n` +
        "A container gets a credential from the PROCESS ENVIRONMENT of the\n" +
        "`docker compose` invocation that creates it, never from a file in the\n" +
        "tree. A file under docker/ outlives the containers, the branch and the\n" +
        "checkout: a decrypted credential written there stays on disk until\n" +
        "somebody deletes it by hand. See\n" +
        "docs/internals/contracts/no-provider-key-at-rest.md and\n" +
        "scripts/gen-graphiti-env.mjs for the road that replaces it. If a value\n" +
        "flagged here is NOT a credential, it is shaped exactly like one — give\n" +
        "it a shape that is not (the named sentinels in docker/graphiti/config.yaml\n" +
        "are the precedent).",
    );
    return 1;
  }

  console.log(
    `[no-keys-in-docker-tree] OK — ${scanned} file(s) under ${SCANNED_DIR}/ ` +
      "(tracked + on disk), 0 key-shaped values.",
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
