// Unit tests for the guarded non-Postgres family upgrade paths
// (cinatra#1421, upgrade-paths epic cinatra#1419) — fast, container-free.
//
// The LIVE guarded-transaction behavior (candidate-volume migrate, rollback,
// cutover, failure injection) is proven by the docker-driving upgrade-from
// arms (scripts/ci/works-after/upgrade-mariadb.sh / upgrade-redis.sh). These
// tests pin the SERVICE-FREE invariants those arms and the cinatra-cli chain
// rely on:
//   - resolve-transition.mjs is fail-closed: unsupported hop / downgrade /
//     unknown service / matrix-revision skew all exit 3; a supported tuple
//     exits 0 and reports the family + image repo;
//   - ledger.mjs implements the transactional journal contract (record /
//     begin / commit / rollback; a second begin refuses; commit/rollback
//     without a journal refuse; a malformed file is never silently reset);
//   - the family path scripts refuse bad invocations with the documented
//     usage exit (2) and refuse an unsupported tuple fail-closed (3) BEFORE
//     any mutation — with no ledger file ever created;
//   - the upgrade-from fixtures pin their source-image digest (cinatra#1422
//     deliverable 2) and drive the committed family paths.
//
// Run: node --test scripts/ci/works-after/__tests__/

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const RESOLVE = resolve(REPO_ROOT, "scripts/upgrade/resolve-transition.mjs");
const LEDGER = resolve(REPO_ROOT, "scripts/upgrade/ledger.mjs");
const MARIADB_PATH = resolve(REPO_ROOT, "scripts/upgrade/mariadb-upgrade-major.sh");
const REDIS_PATH = resolve(REPO_ROOT, "scripts/upgrade/redis-upgrade-major.sh");
const PG_PATH = resolve(REPO_ROOT, "scripts/upgrade/postgres-upgrade-major.sh");

function runNode(args, opts = {}) {
  return spawnSync("node", args, { encoding: "utf8", ...opts });
}
function runBash(args, env = {}) {
  return spawnSync("bash", args, { encoding: "utf8", env: { ...process.env, ...env } });
}

// ── resolve-transition.mjs (fail-closed eligibility) ─────────────────────────

test("supported tuples exit 0 with family + imageRepo in the verdict", () => {
  for (const [svc, from, to, family, repo] of [
    ["wordpress-mariadb", "11.4", "11.8", "mariadb", "mariadb"],
    ["drupal-mariadb", "11.4", "11.8", "mariadb", "mariadb"],
    ["platform-redis", "7", "8", "redis", "redis"],
  ]) {
    const r = runNode([RESOLVE, svc, from, to]);
    assert.equal(r.status, 0, `${svc} ${from}->${to} should be supported: ${r.stderr}`);
    const v = JSON.parse(r.stdout);
    assert.equal(v.supported, true);
    assert.equal(v.service.family, family);
    assert.equal(v.service.imageRepo, repo);
  }
});

test("unsupported hops, downgrades, and unknown services exit fail-closed 3", () => {
  for (const [svc, from, to, why] of [
    ["wordpress-mariadb", "11.4", "12.0", "sequential-only (skips 11.8)"],
    ["wordpress-mariadb", "11.8", "11.4", "downgrade"],
    ["platform-redis", "8", "7", "downgrade (explicitly unsupported)"],
    ["plane-redis", "7.2.11", "8", "valkey: no supported non-hold hop"],
    ["twenty-redis", "7", "8", "unlisted hop"],
    ["no-such-service", "1", "2", "unknown service"],
  ]) {
    const r = runNode([RESOLVE, svc, from, to]);
    assert.equal(r.status, 3, `${svc} ${from}->${to} (${why}) must exit 3, got ${r.status}`);
  }
});

test("a matrix-revision skew is fail-closed (exit 3), never acted on", () => {
  const dir = mkdtempSync(join(tmpdir(), "uf-matrix-"));
  const doctored = JSON.parse(readFileSync(resolve(REPO_ROOT, "docs/architecture/upgrade-matrix.json"), "utf8"));
  doctored.revision += 1;
  const p = join(dir, "matrix.json");
  writeFileSync(p, JSON.stringify(doctored));
  const r = runNode([RESOLVE, "wordpress-mariadb", "11.4", "11.8", "--matrix", p]);
  assert.equal(r.status, 3, "revision skew must fail closed");
  assert.match(r.stderr, /FAIL-CLOSED/);
});

// ── ledger.mjs (transactional journal semantics) ─────────────────────────────

function ledgerOp(file, op, extra = []) {
  return runNode([
    LEDGER, op, "--file", file, "--service", "platform-redis",
    "--image", "redis:7-alpine", "--volume-name", "vol-x", "--volume-created-at", "t0",
    ...extra,
  ]);
}

test("ledger journal: record -> begin -> commit promotes the target; rollback restores the source", () => {
  const dir = mkdtempSync(join(tmpdir(), "uf-ledger-"));
  const f = join(dir, "ledger.json");
  assert.equal(ledgerOp(f, "record").status, 0);
  assert.equal(ledgerOp(f, "begin", ["--image", "redis:8-alpine"]).status, 0);
  let l = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(l.pending.service, "platform-redis", "begin opens the pending journal");
  assert.equal(l.services["platform-redis"].image, "redis:7-alpine", "live entry stays the SOURCE until commit");
  // A second begin while pending must refuse (one migration at a time).
  assert.equal(ledgerOp(f, "begin").status, 6, "second begin must refuse (exit 6)");
  // commit must name the exact pending target.
  assert.equal(ledgerOp(f, "commit", ["--image", "redis:8-alpine"]).status, 0);
  l = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(l.pending, null);
  assert.equal(l.services["platform-redis"].image, "redis:8-alpine", "commit promotes the target");
  // rollback without a journal refuses.
  assert.equal(ledgerOp(f, "rollback").status, 6, "rollback without a pending journal must refuse");
  // A fresh begin + rollback restores the (now 8-alpine) source entry —
  // rollback must name the EXACT pending target it is unwinding.
  assert.equal(ledgerOp(f, "begin", ["--image", "redis:9-alpine"]).status, 0);
  assert.equal(ledgerOp(f, "rollback", ["--image", "redis:6-alpine"]).status, 6, "rollback naming a different target must refuse");
  assert.equal(ledgerOp(f, "rollback", ["--image", "redis:9-alpine"]).status, 0);
  l = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(l.services["platform-redis"].image, "redis:8-alpine", "rollback restores the source entry");
  assert.equal(l.pending, null);
});

test("ledger: begin fail-closes on a volume-identity mismatch; commit refuses a different migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "uf-ledger-"));
  const f = join(dir, "ledger.json");
  assert.equal(ledgerOp(f, "record").status, 0);
  // A recreated same-named volume has a different createdAt — begin must refuse.
  const r = ledgerOp(f, "begin", ["--image", "redis:8-alpine", "--volume-created-at", "t1-recreated"]);
  assert.equal(r.status, 6, "begin against a recreated volume identity must refuse (fail-closed)");
  assert.match(r.stderr, /identity mismatch/);
  // A renamed volume likewise.
  assert.equal(ledgerOp(f, "begin", ["--image", "redis:8-alpine", "--volume-name", "vol-other"]).status, 6);
  // A matching begin, then a commit naming a different target image refuses.
  assert.equal(ledgerOp(f, "begin", ["--image", "redis:8-alpine"]).status, 0);
  assert.equal(ledgerOp(f, "commit", ["--image", "redis:9-alpine"]).status, 6, "commit naming a different target must refuse");
  // A volume destroyed+recreated MID-migration (new createdAt) can never be
  // committed over — fail-closed.
  const rc = ledgerOp(f, "commit", ["--image", "redis:8-alpine", "--volume-created-at", "t9-recreated"]);
  assert.equal(rc.status, 6, "commit over a mid-migration recreated volume must refuse");
  assert.match(rc.stderr, /destroyed\+recreated mid-migration/);
  assert.equal(ledgerOp(f, "commit", ["--image", "redis:8-alpine"]).status, 0);
});

test("ledger: a malformed file is refused (exit 6), never silently reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "uf-ledger-"));
  const f = join(dir, "ledger.json");
  writeFileSync(f, "{not json");
  assert.equal(ledgerOp(f, "record").status, 6);
  assert.equal(readFileSync(f, "utf8"), "{not json", "the corrupt file must be left untouched");
});

// ── family path scripts (pre-mutation refusals; no docker needed) ────────────

test("path scripts: bad invocations exit the documented usage code 2", () => {
  // Missing required args.
  assert.equal(runBash([MARIADB_PATH]).status, 2);
  assert.equal(runBash([REDIS_PATH]).status, 2);
  // Unknown flag.
  assert.equal(runBash([REDIS_PATH, "--bogus", "x"]).status, 2);
  // A known flag with a MISSING value is still the documented usage exit.
  assert.equal(runBash([REDIS_PATH, "--service"]).status, 2, "trailing flag without a value");
  // An image tag that does not bind to the resolved matrix version is a
  // misconfigured invocation (eligibility would cover a version the tag
  // does not run).
  const rBind = runBash(
    [REDIS_PATH, "--service", "platform-redis", "--volume", "v", "--from", "7", "--to", "8", "--from-tag", "8-alpine", "--backup-dir", "/tmp"],
    { UPGRADE_LEDGER_FILE: "/tmp/never-upgrade-paths-test.json" },
  );
  assert.equal(rBind.status, 2, "a --from-tag off the resolved series must refuse");
  assert.match(rBind.stderr, /does not run the matrix version/);
  // mariadb requires the root password via ENV (never argv).
  const r = runBash(
    [MARIADB_PATH, "--service", "wordpress-mariadb", "--volume", "v", "--from", "11.4", "--to", "11.8", "--backup-dir", "/tmp"],
    { UPGRADE_MARIADB_ROOT_PASSWORD: "" },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /UPGRADE_MARIADB_ROOT_PASSWORD/);
});

test("path scripts: an unsupported tuple refuses fail-closed (3) BEFORE any mutation — ledger never created", () => {
  const dir = mkdtempSync(join(tmpdir(), "uf-refuse-"));
  const ledger = join(dir, "never.json");
  const mdb = runBash(
    [MARIADB_PATH, "--service", "wordpress-mariadb", "--volume", "v", "--from", "11.4", "--to", "12.0", "--backup-dir", dir],
    { UPGRADE_MARIADB_ROOT_PASSWORD: "x", UPGRADE_LEDGER_FILE: ledger },
  );
  assert.equal(mdb.status, 3, `mariadb 11.4->12.0 must refuse: ${mdb.stderr}`);
  const rds = runBash(
    [REDIS_PATH, "--service", "platform-redis", "--volume", "v", "--from", "8", "--to", "7", "--backup-dir", dir],
    { UPGRADE_LEDGER_FILE: ledger },
  );
  assert.equal(rds.status, 3, `redis 8->7 downgrade must refuse: ${rds.stderr}`);
  assert.ok(!existsSync(ledger), "a refusal must never touch the ledger");
});

test("path scripts run with errtrace so the transaction ERR trap reaches function-internal failures", () => {
  for (const file of ["scripts/upgrade/mariadb-upgrade-major.sh", "scripts/upgrade/redis-upgrade-major.sh"]) {
    const src = readFileSync(resolve(REPO_ROOT, file), "utf8");
    assert.match(src, /set -Eeuo pipefail/, `${file}: ERR-trap transaction handling requires errtrace (-E)`);
    assert.match(src, /BASH_SUBSHELL/, `${file}: the trap must no-op in subshells via BASH_SUBSHELL (BASHPID is missing on stock macOS bash 3.2)`);
  }
});

// ── fixtures pin their source-image digest (cinatra#1422) ────────────────────

test("upgrade-from fixtures default to digest-bound source AND target images", () => {
  for (const [file, fromVar, toVar] of [
    ["scripts/ci/works-after/upgrade-mariadb.sh", "MARIADB_FROM_TAG", "MARIADB_TO_TAG"],
    ["scripts/ci/works-after/upgrade-redis.sh", "REDIS_FROM_TAG", "REDIS_TO_TAG"],
  ]) {
    const src = readFileSync(resolve(REPO_ROOT, file), "utf8");
    for (const v of [fromVar, toVar]) {
      const m = src.match(new RegExp(`${v}="\\$\\{${v}:-([^}]+)\\}"`));
      assert.ok(m, `${file}: missing overridable default for ${v}`);
      assert.match(m[1], /@sha256:[0-9a-f]{64}$/, `${file}: ${v} default must be digest-bound (pins the fixture bytes)`);
    }
    assert.match(src, /scripts\/upgrade\//, `${file} must drive the committed family path`);
  }
});

// ── postgres family (cinatra#1422 / cinatra-cli#129) ─────────────────────────

test("postgres: supported transitions resolve (platform 17→18 baseline, nango 15→17 case exception)", () => {
  for (const [svc, from, to] of [
    ["platform-postgres", "17", "18"],
    ["nango-postgres", "15", "17"],
  ]) {
    const r = runNode([RESOLVE, svc, from, to]);
    assert.equal(r.status, 0, `${svc} ${from}->${to} should be supported: ${r.stderr}`);
    const v = JSON.parse(r.stdout);
    assert.equal(v.supported, true);
    assert.equal(v.service.family, "postgres");
    assert.equal(v.mechanism, "logical-dump-restore");
  }
});

test("postgres: a downgrade and an unsupported hop fail closed (exit 3)", () => {
  for (const [svc, from, to, why] of [
    ["platform-postgres", "18", "17", "downgrade"],
    ["nango-postgres", "17", "18", "unvalidated upstream"],
    ["twenty-postgres", "16", "18", "no in-place major path"],
  ]) {
    const r = runNode([RESOLVE, svc, from, to]);
    assert.equal(r.status, 3, `${svc} ${from}->${to} (${why}) must exit 3, got ${r.status}`);
  }
});

test("postgres path script: bad invocations exit usage code 2; an unsupported tuple refuses fail-closed 3 with no ledger", () => {
  assert.equal(runBash([PG_PATH]).status, 2, "missing required args");
  assert.equal(runBash([PG_PATH, "--bogus", "x"]).status, 2, "unknown flag");
  // A --from-tag off the resolved series is a misconfigured invocation.
  const rBind = runBash(
    [PG_PATH, "--service", "platform-postgres", "--volume", "v", "--from", "17", "--to", "18", "--from-tag", "18-alpine", "--backup-dir", "/tmp"],
    { UPGRADE_LEDGER_FILE: "/tmp/never-upgrade-postgres-test.json" },
  );
  assert.equal(rBind.status, 2, "a --from-tag off the resolved series must refuse");
  assert.match(rBind.stderr, /does not run the matrix version/);
  // An unsupported tuple refuses fail-closed BEFORE any mutation — ledger never created.
  const dir = mkdtempSync(join(tmpdir(), "uf-pg-refuse-"));
  const ledger = join(dir, "never.json");
  const down = runBash(
    [PG_PATH, "--service", "platform-postgres", "--volume", "v", "--from", "18", "--to", "17", "--backup-dir", dir],
    { UPGRADE_LEDGER_FILE: ledger },
  );
  assert.equal(down.status, 3, `postgres 18->17 downgrade must refuse: ${down.stderr}`);
  assert.ok(!existsSync(ledger), "a refusal must never touch the ledger");
});

test("postgres path script runs with errtrace + the subshell trap guard", () => {
  const src = readFileSync(PG_PATH, "utf8");
  assert.match(src, /set -Eeuo pipefail/, "postgres path: ERR-trap transaction handling requires errtrace (-E)");
  assert.match(src, /BASH_SUBSHELL/, "postgres path: the trap must no-op in subshells via BASH_SUBSHELL");
});

test("upgrade-postgres fixture: digest-bound TARGET pins, bare-major sources, drives the committed pg family path", () => {
  const src = readFileSync(resolve(REPO_ROOT, "scripts/ci/works-after/upgrade-postgres.sh"), "utf8");
  // Field pg SOURCES have no single canonical digest (cinatra#1417) — bare majors.
  for (const v of ["PG_CASEA_FROM_TAG", "PG_CASEB_FROM_TAG"]) {
    const m = src.match(new RegExp(`${v}="\\$\\{${v}:-([^}]+)\\}"`));
    assert.ok(m, `missing overridable default for ${v}`);
    assert.doesNotMatch(m[1], /@sha256:/, `${v} is a field source (no canonical digest) — must be a bare tag`);
  }
  // TARGETS are the matrix pins — digest-bound (pins the fixture's proven bytes).
  for (const v of ["PG_CASEA_TO_TAG", "PG_CASEB_TO_TAG"]) {
    const m = src.match(new RegExp(`${v}="\\$\\{${v}:-([^}]+)\\}"`));
    assert.ok(m, `missing overridable default for ${v}`);
    assert.match(m[1], /@sha256:[0-9a-f]{64}$/, `${v} default must be digest-bound (the matrix target pin)`);
  }
  assert.match(src, /scripts\/upgrade\/postgres-upgrade-major\.sh/, "must drive the committed pg family path");
});
