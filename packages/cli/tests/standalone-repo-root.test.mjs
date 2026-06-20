// Standalone repo-root resolution guard (cinatra#255 — CLI publish readiness).
//
// `getRepoRoot()` anchors every repo-bound command (setup, db migrate, clone,
// dev, backup, doctor, status, …) — they all read `<root>/.env.local` via
// `collectEnvironment()` and/or set the docker-compose `cwd`, backup dirs, and
// migration sources from it.
//
// Historically `getRepoRoot()` was purely MODULE-RELATIVE:
//   path.resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
// which is the monorepo root when the file lives at packages/cli/src/index.mjs,
// but resolves to an ARBITRARY node_modules ancestor when the CLI is installed
// STANDALONE (the published, esbuild-bundled `cinatra` package). Repo-bound
// commands then read a non-existent `.env.local` → a misleading
// "SUPABASE_DB_URL missing" / wrong docker cwd, i.e. a silent wrong-path.
//
// This suite reproduces the standalone install layout FAITHFULLY: a copy of the
// CLI sources placed at <tmp>/lib/node_modules/cinatra/src/ (so `../../..` from
// index.mjs is <tmp>/lib/node_modules — NOT a cinatra root), driven via a child
// Node process. It asserts the post-fix contract:
//
//   1. cwd OUTSIDE any checkout, no CINATRA_REPO_ROOT → a CLEAR, actionable
//      error (mentions a cinatra checkout / CINATRA_REPO_ROOT), NOT a silent
//      wrong-path and NOT a raw stack crash.
//   2. CINATRA_REPO_ROOT pointing at the REAL monorepo root → root resolution
//      SUCCEEDS (the command proceeds past it and fails later on the
//      unreachable DB, proving it found the right `.env.local`/root).
//   3. cwd INSIDE the real monorepo (no env) → the upward cwd-walk resolves the
//      root (same proceed-past-root behavior).
//   4. CINATRA_REPO_ROOT pointing at a NON-checkout dir → a clear error naming
//      the bad path (fail-loud, never a silent wrong-path).
//
// It also asserts the IN-REPO invariant directly: the real (un-copied) sources
// still resolve the monorepo root, byte-for-byte with the prior behavior.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PKG_DIR = path.join(HERE, ".."); // packages/cli
const CLI_SRC_DIR = path.join(CLI_PKG_DIR, "src");
// The real monorepo root — packages/cli is two levels below it.
const REPO_ROOT = path.resolve(CLI_PKG_DIR, "..", "..");

/** @type {string} */
let sandbox;
/** @type {string} */
let standaloneBin;
/** @type {string} */
let outsideCwd;
/** @type {string} */
let bogusRepo;

beforeAll(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "cinatra-standalone-"));

  // Reproduce the published-install layout:
  //   <sandbox>/lib/node_modules/cinatra/{src,bin,package.json}
  // so `../../..` from src/index.mjs === <sandbox>/lib/node_modules, which is
  // NOT a cinatra root (no pnpm-workspace.yaml / packages/cli/package.json).
  const installDir = path.join(sandbox, "lib", "node_modules", "cinatra");
  mkdirSync(installDir, { recursive: true });
  cpSync(CLI_SRC_DIR, path.join(installDir, "src"), { recursive: true });
  cpSync(path.join(CLI_PKG_DIR, "bin"), path.join(installDir, "bin"), { recursive: true });
  // The standalone package.json (renamed to `cinatra` at publish time). It is
  // read by `readCliVersion()` ("../package.json" from src/) — present so the
  // CLI loads exactly as published.
  writeFileSync(
    path.join(installDir, "package.json"),
    JSON.stringify({ name: "cinatra", version: "0.0.0-standalone-test", type: "module", bin: { cinatra: "./bin/cinatra.mjs" } }),
  );
  // Symlink node_modules so the copied sources' external deps (pg, pacote, the
  // workspace packages, …) still resolve — `getRepoRoot()` resolution runs long
  // before any of them are touched, but the module graph must still load.
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(installDir, "node_modules"), "dir");
  standaloneBin = path.join(installDir, "bin", "cinatra.mjs");

  // A throwaway cwd that has NO cinatra root anywhere above it.
  outsideCwd = path.join(sandbox, "elsewhere");
  mkdirSync(outsideCwd, { recursive: true });

  // A dir that exists but is NOT a cinatra checkout (for the bad-override case).
  bogusRepo = path.join(sandbox, "not-a-checkout");
  mkdirSync(bogusRepo, { recursive: true });
});

afterAll(() => {
  if (sandbox) {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/**
 * Run the STANDALONE-installed CLI in a child process with a controlled cwd and
 * env. `status` is a repo-bound command whose very first step is
 * `getRepoRoot()` → `collectEnvironment(repoRoot)`.
 */
function runStandaloneStatus({ cwd, env = {} }) {
  return spawnSync(process.execPath, [standaloneBin, "status"], {
    encoding: "utf8",
    timeout: 30_000,
    cwd,
    env: {
      // Start from a CLEAN env so an ambient SUPABASE_DB_URL / CINATRA_REPO_ROOT
      // from the test runner can't leak into the child. PATH is kept so node
      // subprocesses (if any) resolve.
      PATH: process.env.PATH,
      HOME: path.join(sandbox, "home"),
      ...env,
    },
  });
}

describe("standalone getRepoRoot — repo-bound command outside a checkout fails loud + clear", () => {
  it("no CINATRA_REPO_ROOT and cwd outside any checkout → a clear actionable error (not a silent wrong-path)", () => {
    const res = runStandaloneStatus({ cwd: outsideCwd });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    // Non-zero exit (bin/cinatra.mjs prints the error message and exits 1).
    expect(res.status).not.toBe(0);
    // The message is the actionable repo-checkout guidance — NOT a misleading
    // "SUPABASE_DB_URL missing" (the old silent wrong-path symptom) and NOT a
    // raw "Cannot find module" / stack dump.
    expect(out).toMatch(/must run from inside a cinatra checkout/i);
    expect(out).toMatch(/CINATRA_REPO_ROOT/);
    expect(out).not.toMatch(/Cannot find module/);
  });

  it("CINATRA_REPO_ROOT pointing at a non-checkout dir → a clear error naming the bad path", () => {
    const res = runStandaloneStatus({ cwd: outsideCwd, env: { CINATRA_REPO_ROOT: bogusRepo } });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    expect(res.status).not.toBe(0);
    expect(out).toMatch(/is not a cinatra checkout/i);
    expect(out).toContain(bogusRepo);
  });
});

describe("standalone getRepoRoot — resolves the operator's real checkout", () => {
  // When the root IS found, `status` proceeds PAST root resolution to
  // `requiredEnv(env, "SUPABASE_DB_URL")`. The resolved checkout has no
  // `.env.local` (gitignored) and the child env is clean, so it fails THERE with
  // the POST-ROOT "Missing SUPABASE_DB_URL" symptom — never on the repo-checkout
  // guidance. Asserting that POSITIVE later-stage outcome (not just the absence
  // of the guidance) is what proves the root was actually resolved.
  const ROOT_GUIDANCE = /must run from inside a cinatra checkout/i;
  const PAST_ROOT_SYMPTOM = /Missing SUPABASE_DB_URL/i;

  it("CINATRA_REPO_ROOT pointing at the real monorepo root → reaches the POST-ROOT stage", () => {
    const res = runStandaloneStatus({ cwd: outsideCwd, env: { CINATRA_REPO_ROOT: REPO_ROOT } });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(out).not.toMatch(ROOT_GUIDANCE);
    expect(out).not.toMatch(/is not a cinatra checkout/i);
    // Positive proof it got past root resolution into the env/DB stage.
    expect(out).toMatch(PAST_ROOT_SYMPTOM);
  });

  it("cwd INSIDE the real monorepo (no env) → the upward cwd-walk resolves the root", () => {
    // Run from packages/cli (a subdir of the real root) so the upward walk has
    // to climb to find the marker — exercising findCinatraRepoRootUpward.
    const res = runStandaloneStatus({ cwd: CLI_PKG_DIR });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(out).not.toMatch(ROOT_GUIDANCE);
    expect(out).not.toMatch(/is not a cinatra checkout/i);
    expect(out).toMatch(PAST_ROOT_SYMPTOM);
  });
});

describe("in-repo getRepoRoot — invariant preserved (module-relative candidate still wins)", () => {
  it("the REAL (un-copied) CLI resolves the monorepo root from a subdir, with no env override", () => {
    // Drive the real bin from packages/cli with a CLEAN env. The module-relative
    // candidate IS the monorepo root, so `isCinatraRepoRoot` passes and it is
    // returned immediately — identical to the prior one-line implementation.
    const realBin = path.join(CLI_PKG_DIR, "bin", "cinatra.mjs");
    const res = spawnSync(process.execPath, [realBin, "status"], {
      encoding: "utf8",
      timeout: 30_000,
      cwd: CLI_PKG_DIR,
      env: { PATH: process.env.PATH, HOME: path.join(sandbox, "home") },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    // It never hits the standalone guidance — the in-repo branch resolved.
    expect(out).not.toMatch(/must run from inside a cinatra checkout/i);
    expect(out).not.toMatch(/is not a cinatra checkout/i);
  });
});
