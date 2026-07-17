#!/usr/bin/env node
// Restore the `pnpmfileChecksum` that the hosted Renovate (Mend) app strips
// from a regenerated pnpm-lock.yaml.
//
// ROOT CAUSE (why this script exists at all)
// ------------------------------------------
// This repo ships a default-path `.pnpmfile.cjs` whose `readPackage` hook
// re-hydrates the cloned companion extensions' first-party `"*"` specs to
// `workspace:*` (see the Dockerfile header + `.pnpmfile.cjs`). pnpm records a
// checksum of that pnpmfile in the lockfile (`pnpmfileChecksum:`) and, under
// `pnpm install --frozen-lockfile`, recomputes it and FAILS the install if the
// lockfile's value is absent or stale:
//
//     [ERR_PNPM_LOCKFILE_CONFIG_MISMATCH] Cannot proceed with the frozen
//     installation. The current "pnpmfileChecksum" configuration doesn't match
//     the value found in the lockfile
//
// The hosted Renovate app runs its lockfile regeneration with
// `pnpm install --ignore-pnpmfile` (it refuses to execute the repo's arbitrary
// pnpmfile code — a supply-chain stance we can't and shouldn't override on the
// Mend cloud), and pnpm — verified on this repo's exact packageManager pin
// pnpm@11.1.2, and unfixed through pnpm 11.4 (pnpm/pnpm#10944, #7951) — DROPS
// the `pnpmfileChecksum` line from the lockfile whenever `--ignore-pnpmfile` is
// set. Every Renovate PR therefore lands a lockfile with no checksum, and every
// frozen-install gate (31 of them, plus the Docker build) reds out.
//
// Non-fixes, ruled out with evidence (do NOT reach for these):
//   * pnpm-version alignment / renovate `constraints.pnpm` — pnpm 11.1.2 (CI's
//     own version) still drops the checksum under `--ignore-pnpmfile`; matching
//     versions changes nothing. It is the FLAG, not a version skew.
//   * renovate.json `ignoreScripts:false` / allowScripts — the Mend cloud app
//     will not execute the pnpmfile regardless (renovatebot/renovate#30812).
//   * a pnpm "skip the pnpmfile but keep the checksum" setting — does not exist
//     (pnpm maintainers: "sorely needed").
//   * relocating/removing `.pnpmfile.cjs` — it is load-bearing for the Docker
//     prod build (`cinatra extensions acquire-prod`) and the clone-back CI
//     frozen installs; moving it re-introduces the same mismatch there.
//   * disabling `--frozen-lockfile` in CI — weakens the supply-chain posture.
//
// WHAT THIS DOES
// --------------
// Deterministically recomputes the checksum from the on-disk `.pnpmfile.cjs`
// (`sha256-<base64(sha256(fileBytes))>` — the exact format pnpm writes, verified
// against the committed lockfile) and re-inserts the single `pnpmfileChecksum:`
// line into pnpm-lock.yaml at pnpm's canonical position (immediately before
// `patchedDependencies:`). It does NOT re-resolve dependencies: it never runs
// `pnpm install`, so it cannot alter Renovate's controlled version bump — the
// only line it touches is the checksum. Idempotent: a lockfile that already
// carries the correct checksum is left byte-for-byte unchanged.
//
// Because the checksum is computed from whatever `.pnpmfile.cjs` is present, the
// repaired lockfile always matches the pnpmfile CI will load, which is exactly
// the invariant `--frozen-lockfile` enforces. This does NOT weaken the guard:
// the automation that calls this (`.github/workflows/renovate-lockfile-repair.yml`)
// is scoped to Renovate-authored `renovate/**` branches, and Renovate never
// edits `.pnpmfile.cjs` — a human PR that changes the pnpmfile still faces the
// real frozen-lockfile check.
//
// MANUAL RUNBOOK (unblock one Renovate PR without the automation)
// ---------------------------------------------------------------
//   git fetch origin renovate/<branch> && git switch renovate/<branch>
//   node scripts/ci/repair-pnpmfile-checksum.mjs
//   git commit -am "chore: restore pnpmfileChecksum stripped by Renovate --ignore-pnpmfile"
//   git push                       # push as yourself so the gates re-run and go green
//
// Note: ticking Renovate's "rebase/retry" checkbox does NOT fix it — that just
// re-runs Renovate, which strips the checksum again. The repair has to run
// AFTER Renovate writes the lockfile.
//
// Pre-install-safe: node builtins only, no dependency on a completed install.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const args = { check: false, lock: "pnpm-lock.yaml", pnpmfile: ".pnpmfile.cjs" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--lock") args.lock = argv[++i];
    else if (a === "--pnpmfile") args.pnpmfile = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
    else {
      console.error(`repair-pnpmfile-checksum: unknown argument '${a}'`);
      process.exit(2);
    }
  }
  return args;
}

// The exact string pnpm records: `sha256-` + base64(sha256(raw pnpmfile bytes)).
function computeChecksum(pnpmfileBytes) {
  return "sha256-" + createHash("sha256").update(pnpmfileBytes).digest("base64");
}

const CHECKSUM_LINE = /^pnpmfileChecksum:[ \t]*(\S+)[ \t]*$/m;

function repair(lockText, expected) {
  const existing = lockText.match(CHECKSUM_LINE);
  if (existing) {
    if (existing[1] === expected) return { changed: false, reason: "already-correct", text: lockText };
    return {
      changed: true,
      reason: "updated-stale",
      text: lockText.replace(CHECKSUM_LINE, `pnpmfileChecksum: ${expected}`),
    };
  }
  // Insert at pnpm's canonical position: the top-level key immediately before
  // `patchedDependencies:`, reproducing the committed layout (`overrides` ->
  // blank -> pnpmfileChecksum -> blank -> patchedDependencies) exactly so the
  // next real `pnpm install` sees no churn. The blank-line run before
  // `patchedDependencies:` is normalized to a single blank, so the output is
  // byte-identical whether the regenerator emitted one blank or several.
  const beforePatched = /\n(?:[ \t]*\n)+(?=^patchedDependencies:)/m;
  if (beforePatched.test(lockText)) {
    return {
      changed: true,
      reason: "inserted",
      text: lockText.replace(beforePatched, `\n\npnpmfileChecksum: ${expected}\n\n`),
    };
  }
  // Fallback for a lockfile without patchedDependencies: place it right after
  // the `lockfileVersion:` line (still a valid top-level key; position does not
  // affect the frozen-install check).
  const version = /^(lockfileVersion:.*\n)/m;
  if (version.test(lockText)) {
    return {
      changed: true,
      reason: "inserted-after-version",
      text: lockText.replace(version, `$1\npnpmfileChecksum: ${expected}\n`),
    };
  }
  return { changed: false, reason: "no-anchor", text: lockText };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/ci/repair-pnpmfile-checksum.mjs [--check] [--lock <path>] [--pnpmfile <path>]",
    );
    process.exit(0);
  }

  const lockPath = path.resolve(args.lock);
  const pnpmfilePath = path.resolve(args.pnpmfile);

  if (!existsSync(lockPath)) {
    console.error(`repair-pnpmfile-checksum: lockfile not found at ${lockPath}`);
    process.exit(2);
  }
  if (!existsSync(pnpmfilePath)) {
    // No pnpmfile => pnpm records no checksum => nothing to enforce or repair.
    console.log(
      `repair-pnpmfile-checksum: no ${args.pnpmfile} present — nothing to repair.`,
    );
    process.exit(0);
  }

  const expected = computeChecksum(readFileSync(pnpmfilePath));
  const lockText = readFileSync(lockPath, "utf8");
  const result = repair(lockText, expected);

  if (result.reason === "no-anchor") {
    console.error(
      "repair-pnpmfile-checksum: could not locate an insertion anchor in the lockfile " +
        "(no existing pnpmfileChecksum, patchedDependencies, or lockfileVersion). Aborting " +
        "rather than writing a malformed lockfile.",
    );
    process.exit(2);
  }

  if (!result.changed) {
    console.log(`repair-pnpmfile-checksum: pnpmfileChecksum already correct (${expected}).`);
    process.exit(0);
  }

  if (args.check) {
    console.error(
      `repair-pnpmfile-checksum: pnpmfileChecksum ${result.reason === "updated-stale" ? "is stale" : "is missing"} ` +
        `in ${args.lock} (expected ${expected}). Run without --check to repair.`,
    );
    process.exit(1);
  }

  writeFileSync(lockPath, result.text);
  console.log(
    `repair-pnpmfile-checksum: ${result.reason === "updated-stale" ? "updated" : "inserted"} ` +
      `pnpmfileChecksum: ${expected} in ${args.lock}.`,
  );
  process.exit(0);
}

// Only run when invoked directly (keeps the pure functions importable by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { computeChecksum, repair, CHECKSUM_LINE };
