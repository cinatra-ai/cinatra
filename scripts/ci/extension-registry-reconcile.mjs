#!/usr/bin/env node
// Installable-extension registry reconciliation (cinatra#1120).
//
// Every existing extension drift check iterates the ALREADY-DECLARED list
// (cinatra.devExtensions) to catch SHA-pin drift — none of them notice a repo
// that was never added, or a declared entry whose repo no longer exists. So
// "registration happened" is assumed, never verified: a newly-created
// first-party extension repo can silently never join the dev install, and a
// stale registry entry can point at a deleted/renamed repo.
//
// This check closes that gap. It reconciles the cinatra-ai org's PUBLIC
// installable-extension repos against the registry and flags:
//   - MISSING: a public org repo that IS an installable extension (its root
//     package.json carries a `cinatra.kind` manifest block) but is absent from
//     cinatra.devExtensions — i.e. it would never ship in the dev install.
//   - ORPHAN:  a cinatra.devExtensions entry that does not resolve to a live
//     PUBLIC repo (deleted / renamed / made-private) — a dangling registry
//     member. Reported by COUNT ONLY; orphan names are never printed to the
//     public log (see LOG-SAFETY). An enumeration gap (the repo IS public but
//     the listing missed it) is excluded by the live visibility probe.
// Intentionally-unbundled / non-extension public repos are excluded via a
// recorded allowlist (extension-registry-reconcile.allow.json) so the check is
// COMPLETE without being noisy.
//
// Classification rule (converged during implementation, cinatra#1120):
// presence of `cinatra.kind` in the repo's root package.json. This is the one
// signal that is universal across every extension KIND today (connector /
// agent / artifact / skills / workflow), needs no org-wide relabeling, and
// cleanly excludes the host app repo (which has `cinatra.devExtensions` but no
// `cinatra.kind`) and plain tooling repos (no `cinatra` key at all). A GitHub
// topic was considered and rejected as the PRIMARY signal because no repo
// carries one yet (it would be inert); the rule can be widened later.
//
// LOG-SAFETY (fail-closed, per cinatra#1120): three guarantees.
//   1. Org enumeration is scoped to `type=public` at the API, so non-public
//      repo names never enter this process (do not remove the `type=public`
//      scope). MISSING names come only from that enumeration.
//   2. Orphan names are NEVER printed — orphans are reported by COUNT only. CI
//      uses the repo-scoped GITHUB_TOKEN, for which GitHub returns 404 for a
//      private repo it cannot see, indistinguishable from a genuinely-deleted
//      repo — so a "gone" result cannot be proven public. Count-only is the
//      fail-closed choice (a local run with org read access lists the entries).
//   3. Every printed name (the MISSING set, all from the type=public
//      enumeration) passes `safeLabel` (GitHub repo-name charset), so a
//      malformed name can never inject a second workflow command into the log.
//
// Report-only by default (exit 0): emits one `::warning::` per finding plus a
// summary, mirroring extension-pin-divergence-report.mjs. `--fail-on-drift`
// turns any finding into a non-zero exit for a caller that wants a hard gate.
//
// Pre-install-safe: node builtins + `gh` (org enumeration / manifest probe /
// orphan visibility probe, authed via GH_TOKEN) only.

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readDevExtensionsConfig } from "../../packages/cli/src/cinatra-dev-extensions.mjs";

const ORG = process.env.CINATRA_EXT_RECONCILE_ORG || "cinatra-ai";

// GitHub repo names are restricted to this charset. Every name this script
// prints is validated against it before interpolation into a `::warning::`
// workflow command, so a malformed name (e.g. a crafted cinatra.devExtensions
// URL that parses to a name containing a newline or `%0A`) can never inject a
// second workflow command into the public Actions log, and only well-formed
// public-style repo names are ever emitted (log-safety, defense-in-depth).
const SAFE_REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Emit a repo name only if it is a syntactically valid GitHub repo name. */
export function safeLabel(name) {
  return SAFE_REPO_NAME.test(String(name)) ? String(name) : "<redacted-invalid-name>";
}

/**
 * Pure reconciliation core (the CLI shell below injects the real IO; the tests
 * exercise this directly).
 *
 * @param {object} args
 * @param {string[]} args.orgRepos          PUBLIC, non-archived org repo names.
 * @param {string[]} args.registryRepoNames repo names derived from cinatra.devExtensions URLs.
 * @param {string[]} args.allowlist         repo names intentionally excluded from the installable set.
 * @param {(name: string) => boolean} args.hasExtensionKind  root package.json has cinatra.kind.
 *        Consulted ONLY for candidates (public, unregistered, not allowlisted).
 * @returns {{ missing: string[], orphanCandidates: string[] }}
 */
export function reconcile({ orgRepos, registryRepoNames, allowlist, hasExtensionKind }) {
  const registrySet = new Set(registryRepoNames);
  const allowSet = new Set(allowlist);
  const orgSet = new Set(orgRepos);

  // MISSING: a public org repo that looks like an installable extension but is
  // neither registered nor explicitly excluded. `hasExtensionKind` is only
  // asked about this narrow candidate set (keeps the manifest probes few).
  const missing = orgRepos
    .filter((name) => !registrySet.has(name) && !allowSet.has(name))
    .filter((name) => hasExtensionKind(name) === true)
    .sort();

  // ORPHAN CANDIDATES: registry entries absent from the PUBLIC enumeration.
  // These are then classified by live visibility (classifyOrphans) so we never
  // emit the name of a repo that resolves to a NON-PUBLIC repo, and never
  // false-flag an enumeration gap.
  const orphanCandidates = registryRepoNames.filter((name) => !orgSet.has(name)).sort();

  return { missing, orphanCandidates };
}

/**
 * Classify orphan candidates by a live visibility probe so orphan reporting is
 * LOG-SAFE: a candidate that resolves to a non-public repo is counted but its
 * name is withheld from the public log; only a genuinely-gone repo (whose name
 * is already public in the committed cinatra.devExtensions) is named.
 *
 * @param {string[]} candidates
 * @param {(name: string) => ("gone"|"public"|"nonpublic"|"unknown")} probeVisibility
 * @returns {{ gone: string[], nonPublic: string[], unresolved: string[] }}
 *   gone       = repo no longer exists (deleted/renamed) -> a real orphan, safe to name.
 *   nonPublic  = repo exists but is not public -> real orphan for the dev install, name WITHHELD.
 *   unresolved = probe could not determine (transient/error) -> not flagged, count noted.
 *   (a "public" probe means the enumeration simply missed it -> not an orphan.)
 */
export function classifyOrphans(candidates, probeVisibility) {
  const gone = [];
  const nonPublic = [];
  const unresolved = [];
  for (const name of candidates) {
    switch (probeVisibility(name)) {
      case "gone":
        gone.push(name);
        break;
      case "nonpublic":
        nonPublic.push(name);
        break;
      case "public":
        break; // enumeration gap, not an orphan
      default:
        unresolved.push(name);
    }
  }
  return { gone: gone.sort(), nonPublic: nonPublic.sort(), unresolved: unresolved.sort() };
}

/** repo names from the cinatra.devExtensions git URLs (…/<org>/<repo>.git). */
export function registryRepoNamesFrom(devExtensions) {
  return Object.values(devExtensions || {})
    .map((raw) => {
      const url = raw && typeof raw === "object" ? raw.url : String(raw);
      const m = String(url).match(/[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
      return m ? m[2] : null;
    })
    .filter((n) => typeof n === "string" && n.length > 0);
}

// --------------------------------------------------------------------------
// CLI shell
// --------------------------------------------------------------------------

function ghJsonLines(apiPath, jqFilter) {
  const out = execFileSync("gh", ["api", apiPath, "--paginate", "-q", jqFilter], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** PUBLIC, non-archived org repo names. `type=public` keeps private names out. */
function listPublicOrgRepos() {
  return ghJsonLines(
    `orgs/${ORG}/repos?type=public&per_page=100`,
    ".[] | select(.archived == false) | .name",
  );
}

/** True iff the repo's root package.json carries a `cinatra.kind` manifest. */
function hasExtensionKindLive(name) {
  try {
    const raw = execFileSync(
      "gh",
      ["api", `repos/${ORG}/${name}/contents/package.json`, "-H", "Accept: application/vnd.github.raw"],
      { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const pkg = JSON.parse(raw);
    return typeof pkg?.cinatra?.kind === "string" && pkg.cinatra.kind.length > 0;
  } catch {
    // No package.json, unparseable, or no cinatra.kind -> not an installable extension.
    return false;
  }
}

/** Sleep synchronously (no busy loop) between retries. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Live visibility probe for an orphan candidate. Distinguishes:
 *   - "gone"      : the repos API returns 404 (deleted/renamed) — a real orphan
 *                   whose name is already public in cinatra.devExtensions.
 *   - "public"    : the repo exists and is public (an enumeration gap, not an
 *                   orphan).
 *   - "nonpublic" : the repo exists but is private/internal — a real orphan for
 *                   the dev install, but its NAME must NOT be echoed to the
 *                   public log.
 *   - "unknown"   : the probe could not decide after retries (transient) — not
 *                   flagged.
 * Retries a couple of times so a transient error never masquerades as "gone".
 */
function probeVisibilityLive(name) {
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = execFileSync("gh", ["api", `repos/${ORG}/${name}`, "-q", ".visibility"], {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      return out === "public" ? "public" : "nonpublic";
    } catch (err) {
      // gh exits non-zero on 404 (repo gone) AND on transient errors. A 404 is
      // reported by gh with "Not Found" / "HTTP 404" on stderr; treat that as
      // "gone", any other failure as retryable/unknown.
      const stderr = String(err?.stderr ?? "");
      if (/HTTP 404|Not Found/i.test(stderr)) return "gone";
      if (i < attempts - 1) sleepSync(2_000);
    }
  }
  return "unknown";
}

function readAllowlist(repoRoot) {
  try {
    const doc = JSON.parse(readFileSync(path.join(repoRoot, "scripts/ci/extension-registry-reconcile.allow.json"), "utf8"));
    return (doc.exclusions || []).map((e) => e.repo).filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const failOnDrift = process.argv.includes("--fail-on-drift");

  const devExtensions = readDevExtensionsConfig(repoRoot);
  if (!devExtensions || Object.keys(devExtensions).length === 0) {
    console.error("[extension-registry-reconcile] FAIL: cinatra.devExtensions is empty/absent.");
    process.exit(1);
  }
  const registryRepoNames = registryRepoNamesFrom(devExtensions);
  const allowlist = readAllowlist(repoRoot);
  const orgRepos = listPublicOrgRepos();

  const { missing, orphanCandidates } = reconcile({
    orgRepos,
    registryRepoNames,
    allowlist,
    hasExtensionKind: hasExtensionKindLive,
  });
  const { gone, nonPublic, unresolved } = classifyOrphans(orphanCandidates, probeVisibilityLive);

  for (const name of missing) {
    console.log(
      `::warning::${safeLabel(name)}: PUBLIC installable-extension repo (root package.json has cinatra.kind) is NOT in cinatra.devExtensions ` +
        `— it will never ship in the dev install. Register it (and, if it joins the required/system set, the required lock), ` +
        `or add it to scripts/ci/extension-registry-reconcile.allow.json with a reason.`,
    );
  }
  // ORPHAN reporting is COUNT-ONLY — names are NEVER printed to this public log.
  // Rationale (fail-closed): CI runs with the repo-scoped GITHUB_TOKEN, for
  // which GitHub returns 404 for a private repo it cannot see — indistinguishable
  // from a genuinely-deleted repo. So a "gone" classification cannot be proven to
  // be a public+deleted repo rather than a private+inaccessible one; naming it
  // could leak a non-public name. `gone` + `nonPublic` are therefore both real
  // orphans reported by COUNT, with the reviewer routed to cinatra.devExtensions
  // (a local run with org read access lists the specific entries).
  const orphanCount = gone.length + nonPublic.length;
  if (orphanCount > 0) {
    console.log(
      `::warning::${orphanCount} cinatra.devExtensions entr${orphanCount === 1 ? "y does" : "ies do"} not resolve to a live PUBLIC repo ` +
        `(deleted, renamed, or made-private) — the dev install clones anonymously, so ${orphanCount === 1 ? "it" : "they"} will not materialize. ` +
        `Review cinatra.devExtensions (names withheld from this public log; run this script locally with org read access to list the specific entries).`,
    );
  }
  if (unresolved.length > 0) {
    console.log(
      `::notice::${unresolved.length} orphan candidate(s) could not be resolved (transient/network) — not flagged this run.`,
    );
  }

  const driftCount = missing.length + orphanCount;
  console.log("");
  console.log(`[extension-registry-reconcile] org=${ORG}`);
  console.log(`  public repos scanned:      ${orgRepos.length}`);
  console.log(`  registered (devExtensions): ${registryRepoNames.length}`);
  console.log(`  allowlisted exclusions:    ${allowlist.length}`);
  console.log(`  MISSING (unregistered):    ${missing.length}${missing.length ? `  (${missing.map(safeLabel).join(", ")})` : ""}`);
  console.log(`  ORPHAN (no live public repo, names withheld): ${orphanCount}`);
  if (unresolved.length > 0) console.log(`  UNRESOLVED (transient, not flagged): ${unresolved.length}`);
  if (driftCount === 0) {
    console.log("  -> registry is reconciled with the org's public installable-extension repos.");
  }

  if (failOnDrift && driftCount > 0) process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
