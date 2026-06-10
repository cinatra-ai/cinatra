#!/usr/bin/env node
// Regenerate cinatra-required-extensions.lock.json — the committed,
// SHA-pinned acquisition lock for the prod base-image bootable set.
//
// For every `cinatra.requiredExtensions` entry (root package.json) this
// resolves the companion repo's current `main` head to an immutable commit
// SHA, downloads the codeload tarball at that exact SHA, runs it through the
// SAME hardening + canonical tree-hash pipeline prod uses at acquisition time
// (packages/cli/src/prod-extension-acquisition.mjs — one shared definition,
// no parallel implementations), checks the contained package.json against
// the declared entry, and writes the sorted lock.
//
// This is a DEV/RELEASE-time tool: `git ls-remote` is fine here. Production
// never runs this — it consumes only the committed lock (no git/gh binary).
//
// Range gate: each locked packageVersion must satisfy the version range the
// requiredExtensions entry declares. The committed gate of record for that
// contract is the vitest consistency suite
// (packages/extensions/src/__tests__/required-extensions-lock.test.ts, which
// uses the canonical host-side range checker); this script enforces the
// common caret/exact forms inline so a bad lock fails at generation time,
// before CI.
//
// Usage:
//   node scripts/extensions/update-required-extension-lock.mjs              # regenerate all
//   node scripts/extensions/update-required-extension-lock.mjs --select a,b # only listed packages
//                                                                           # (others keep current pins)
//
// Keep this lock and pnpm-lock.yaml in step: the second frozen install in the
// Dockerfile resolves the ACQUIRED extension manifests against pnpm-lock.yaml,
// so regenerate this lock (and re-run `pnpm install`) whenever extension
// dependencies move.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

import {
  LOCK_FILENAME,
  downloadBounded,
  foldTreeHash,
  gunzipBounded,
  inspectTarball,
} from "../../packages/cli/src/prod-extension-acquisition.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCK_PATH = path.join(REPO_ROOT, LOCK_FILENAME);

function fail(msg) {
  console.error(`[update-required-extension-lock] ERROR: ${msg}`);
  process.exit(1);
}

/** Parse one requiredExtensions entry — mirrors the canonical host parser
 * (packages/extensions/src/required-in-prod.ts parseRequiredExtensionEntry):
 * split on the LAST `@` with index > 0; empty range → unpinned. */
function parseEntry(raw) {
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return null;
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return { packageName: trimmed, versionRange: null };
  const range = trimmed.slice(at + 1).trim();
  return { packageName: trimmed.slice(0, at), versionRange: range.length > 0 ? range : null };
}

/** Inline sanity for the common pinned forms (`^x.y.z`, exact, `*`). Anything
 * else defers to the vitest consistency gate rather than duplicating the full
 * canonical checker here. Returns true/false/null (null = unsupported form). */
function versionSatisfiesCommonRange(version, range) {
  const v = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!v) return false;
  const [maj, min, pat] = [Number(v[1]), Number(v[2]), Number(v[3])];
  if (range === "*") return true;
  const exact = range.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (exact) return maj === Number(exact[1]) && min === Number(exact[2]) && pat === Number(exact[3]);
  const caret = range.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
  if (!caret) return null;
  const [cmaj, cmin, cpat] = [Number(caret[1]), Number(caret[2]), Number(caret[3])];
  if (maj !== cmaj) return false;
  if (cmaj > 0) return min > cmin || (min === cmin && pat >= cpat);
  // npm caret on major 0 (canonical semantics, matching the host checker):
  // ^0.minor.patch widens at the PATCH for minor>0, and ^0.0.z admits only
  // the exact patch.
  if (min !== cmin) return false;
  return cmin > 0 ? pat >= cpat : pat === cpat;
}

function lsRemoteMainSha(url) {
  let out;
  try {
    out = execFileSync("git", ["ls-remote", url, "refs/heads/main"], {
      encoding: "utf8",
      timeout: 60_000,
    });
  } catch (err) {
    fail(`git ls-remote ${url} failed: ${err.message}`);
  }
  const sha = out.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) fail(`git ls-remote ${url} returned no main head`);
  return sha;
}

function repoSlugFromUrl(url) {
  const m = String(url).match(/^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/);
  if (!m) fail(`unsupported repo URL (expected https://github.com/<owner>/<name>[.git]): ${url}`);
  return m[1];
}

function parseArgs(argv) {
  let raw = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--select") raw = argv[i + 1] ?? "";
    else if (argv[i].startsWith("--select=")) raw = argv[i].slice("--select=".length);
  }
  const select = raw !== null ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (raw !== null && select.length === 0) fail("--select was given but no package names were provided");
  return { select };
}

const { select } = parseArgs(process.argv.slice(2));

const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
const requiredRaw = rootPkg?.cinatra?.requiredExtensions;
if (!Array.isArray(requiredRaw) || requiredRaw.length === 0) {
  fail("cinatra.requiredExtensions is empty/absent in the root package.json");
}
const devExtensions = rootPkg?.cinatraDevExtensions ?? {};

const existingByName = new Map();
if (existsSync(LOCK_PATH)) {
  try {
    for (const p of JSON.parse(readFileSync(LOCK_PATH, "utf8")).packages ?? []) {
      existingByName.set(p.packageName, p);
    }
  } catch {
    // unreadable existing lock: regenerate everything selected below
  }
}

const shortName = (n) => n.replace(/^@[^/]+\//, "");
const selected = (name) =>
  select.length === 0 || select.includes(name) || select.includes(shortName(name));

const entries = requiredRaw.map(parseEntry).filter(Boolean);

// Fail-closed selector matching: a typo'd --select that matches nothing must
// not silently keep every existing pin and exit green.
if (select.length > 0) {
  const matchable = new Set(entries.flatMap((e) => [e.packageName, shortName(e.packageName)]));
  const unmatched = select.filter((s) => !matchable.has(s));
  if (unmatched.length > 0) {
    fail(
      `--select entries match no required extension: ${unmatched.join(", ")} ` +
        `(valid: the full @scope/name or the short name of a cinatra.requiredExtensions entry)`,
    );
  }
}

const locked = [];
let refreshedCount = 0;
let keptCount = 0;
for (const entry of entries) {
  if (!selected(entry.packageName)) {
    const kept = existingByName.get(entry.packageName);
    if (!kept) fail(`--select skipped ${entry.packageName}, but the existing lock has no entry to keep for it`);
    locked.push(kept);
    keptCount += 1;
    continue;
  }
  const repoUrl = devExtensions[entry.packageName];
  if (typeof repoUrl !== "string" || repoUrl.length === 0) {
    fail(
      `no cinatraDevExtensions repo mapping for required extension ${entry.packageName} — every ` +
        `requiredExtensions entry must map to its companion repo`,
    );
  }
  const repo = repoSlugFromUrl(repoUrl);
  const resolvedSha = lsRemoteMainSha(repoUrl);
  const url = `https://codeload.github.com/${repo}/tar.gz/${resolvedSha}`;
  console.log(`[update-required-extension-lock] ${entry.packageName}: ${repo}#${resolvedSha.slice(0, 12)}`);

  const tarBuffer = await gunzipBounded(await downloadBounded(url));
  const { records, packageJsonRaw, violations } = await inspectTarball(tarBuffer, { tar });
  if (violations.length > 0) {
    fail(`${entry.packageName}: unsafe archive from ${url}:\n  - ${violations.join("\n  - ")}`);
  }
  if (!packageJsonRaw) fail(`${entry.packageName}: archive carries no root package.json`);
  const manifest = JSON.parse(packageJsonRaw);
  if (manifest.name !== entry.packageName) {
    fail(`${entry.packageName}: companion repo package.json is named "${manifest.name}"`);
  }
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    fail(`${entry.packageName}: companion repo version "${manifest.version}" is not a concrete x.y.z`);
  }
  if (entry.versionRange !== null) {
    const ok = versionSatisfiesCommonRange(manifest.version, entry.versionRange);
    if (ok === false) {
      fail(
        `${entry.packageName}: companion repo version ${manifest.version} does not satisfy the declared ` +
          `range "${entry.versionRange}" (cinatra.requiredExtensions) — update the pin or the extension first`,
      );
    }
    if (ok === null) {
      console.warn(
        `[update-required-extension-lock] WARN: range form "${entry.versionRange}" for ${entry.packageName} ` +
          `is not checked here — the vitest consistency suite remains the gate of record.`,
      );
    }
  }

  locked.push({
    packageName: entry.packageName,
    repo,
    resolvedSha,
    packageVersion: manifest.version,
    treeSha256: foldTreeHash(records),
  });
  refreshedCount += 1;
}

locked.sort((a, b) => (a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0));

const doc = {
  note:
    "SHA-pinned acquisition lock for the prod base-image bootable set (every cinatra.requiredExtensions " +
    "entry). Production acquires extension source EXCLUSIVELY from this file via " +
    "packages/cli/src/prod-extension-acquisition.mjs (codeload tarball at resolvedSha, hardened extraction, " +
    "treeSha256 + package.json verification). Regenerate with " +
    "`node scripts/extensions/update-required-extension-lock.mjs`; keep it in step with pnpm-lock.yaml.",
  schemaVersion: 1,
  packages: locked,
};
writeFileSync(LOCK_PATH, JSON.stringify(doc, null, 2) + "\n");
console.log(
  `[update-required-extension-lock] wrote ${locked.length} pinned package(s) to ${LOCK_PATH} ` +
    `(${refreshedCount} refreshed, ${keptCount} kept from the existing lock)`,
);
