#!/usr/bin/env node
// HEAD-vs-pin divergence report for the companion extension repos
// (cinatra#141; the floating-HEAD canary's first step).
//
// CI clone-back is pinned to the committed lock shas
// (cinatra-required-extensions.lock.json + cinatra-dev-extensions.lock.json),
// so companion-repo drift no longer reds host `main` — it accumulates
// silently until a deliberate bump PR. This report makes that drift VISIBLE:
// for every `cinatra.devExtensions` entry it resolves the companion repo's
// current branch head (`git ls-remote`) and compares it to the committed pin,
// emitting one `::warning::` annotation per diverged repo and a summary
// table. Exit code is 0 by default (a report, not a gate); the
// `--fail-on-divergence` flag turns divergence (or an unresolvable head) into
// a non-zero exit for callers that want a hard signal.
//
// Pre-install-safe (node builtins + `git` only) — it runs before `pnpm
// install` in the canary, exactly like the clone-back itself.

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  loadDevExtensionPins,
  readDevExtensionsConfig,
} from "../../packages/cli/src/cinatra-dev-extensions.mjs";

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Pure comparison (CLI shell below; tests exercise this directly).
 * `entries`: [{ pkgName, url, branch, pinnedSha, source }]
 * `lsRemoteHead({ url, branch })`: returns the 40-hex head sha or throws.
 * Returns rows with status "match" | "diverged" | "unresolvable".
 */
export function computeDivergence({ entries, lsRemoteHead }) {
  const rows = [];
  for (const e of entries) {
    let headSha = null;
    let status;
    try {
      headSha = lsRemoteHead({ url: e.url, branch: e.branch });
      if (typeof headSha !== "string" || !COMMIT_SHA_RE.test(headSha)) {
        status = "unresolvable";
        headSha = null;
      } else {
        status = headSha === e.pinnedSha ? "match" : "diverged";
      }
    } catch {
      status = "unresolvable";
    }
    rows.push({ ...e, headSha, status });
  }
  return rows;
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const failOnDivergence = process.argv.includes("--fail-on-divergence");

  const config = readDevExtensionsConfig(repoRoot);
  if (!config || Object.keys(config).length === 0) {
    console.error("[extension-pin-divergence] FAIL: cinatra.devExtensions is empty/absent.");
    process.exit(1);
  }
  // Reuses the fail-closed pin loader — a malformed/incomplete lock set is a
  // hard error here too (the report must never silently skip a repo).
  const pins = loadDevExtensionPins(repoRoot);

  const entries = Object.entries(config).map(([pkgName, rawSpec]) => {
    const spec = rawSpec && typeof rawSpec === "object" ? rawSpec : { url: String(rawSpec) };
    const pin = pins.get(pkgName);
    return { pkgName, url: spec.url, branch: spec.branch || "main", pinnedSha: pin.sha, source: pin.source };
  });

  const lsRemoteHead = ({ url, branch }) => {
    const out = execFileSync("git", ["ls-remote", url, `refs/heads/${branch}`], {
      encoding: "utf8",
      timeout: 60_000,
    });
    return out.split(/\s+/)[0];
  };

  const rows = computeDivergence({ entries, lsRemoteHead });
  const diverged = rows.filter((r) => r.status === "diverged");
  const unresolvable = rows.filter((r) => r.status === "unresolvable");

  for (const r of rows) {
    if (r.status === "match") continue;
    const line =
      r.status === "diverged"
        ? `${r.pkgName}: ${r.branch} head ${r.headSha} != pinned ${r.pinnedSha} (${r.source})`
        : `${r.pkgName}: could not resolve ${r.branch} head at ${r.url}`;
    console.log(`::warning::${line}`);
  }

  console.log("");
  console.log(`[extension-pin-divergence] ${rows.length} repos checked:`);
  console.log(`  in sync:      ${rows.length - diverged.length - unresolvable.length}`);
  console.log(`  diverged:     ${diverged.length}${diverged.length ? `  (${diverged.map((r) => r.pkgName).join(", ")})` : ""}`);
  console.log(`  unresolvable: ${unresolvable.length}${unresolvable.length ? `  (${unresolvable.map((r) => r.pkgName).join(", ")})` : ""}`);
  if (diverged.length > 0) {
    console.log(
      "  -> companion tips have moved past the committed pins; land a bump PR " +
        "(docs/extension-clone-pinning.md) to re-integrate them deliberately.",
    );
  }

  if (failOnDivergence && (diverged.length > 0 || unresolvable.length > 0)) process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
