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
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
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

// ── fixture candidate defaults ───────────────────────────────────────────────
// An arm declares each candidate image as an OVERRIDABLE default:
//   VAR="${VAR:-<default expression>}"
// The default is either a literal (a fixture-only source pin the matrix does not
// carry) or a RUNTIME DERIVATION from the upgrade matrix
// (`$(wa_matrix_pin …)`, cinatra#2304). These helpers read the expression and
// EVALUATE it exactly as the arm does — with scripts/ci/works-after/lib.sh
// sourced — so every assertion below is about the value the arm actually runs,
// literal or derived.
const LIB_SH = resolve(REPO_ROOT, "scripts/ci/works-after/lib.sh");

// ANCHORED to a whole line and required to be UNIQUE (codex round-1): an
// unanchored first-match would happily read a commented-out or dead duplicate
// assignment and prove drift against a line the arm never runs.
function defaultExprOf(src, v, label = "") {
  const hits = [...src.matchAll(new RegExp(`^${v}="\\$\\{${v}:-([^}]+)\\}"$`, "gm"))];
  assert.equal(
    hits.length,
    1,
    `${label}expected exactly one live assignment for ${v}, found ${hits.length}`,
  );
  return hits[0][1];
}

function resolveDefault(fileRel, v) {
  const src = readFileSync(resolve(REPO_ROOT, fileRel), "utf8");
  const expr = defaultExprOf(src, v, `${fileRel}: `);
  assert.doesNotMatch(expr, /"/, `${fileRel}: ${v} default must not contain a double quote (unevaluable here)`);
  const r = runBash(["-c", `set -euo pipefail; source "${LIB_SH}"; printf '%s' "${expr}"`]);
  assert.equal(r.status, 0, `${fileRel}: ${v} default did not resolve (${expr}): ${r.stderr}`);
  return r.stdout;
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
  const doctored = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/upgrade/upgrade-matrix.json"), "utf8"));
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
      // RESOLVED (a derived default resolves through wa_matrix_pin) — the arm
      // must run digest-bound bytes however the default is expressed.
      assert.match(
        resolveDefault(file, v),
        /@sha256:[0-9a-f]{64}$/,
        `${file}: ${v} default must resolve digest-bound (pins the fixture bytes)`,
      );
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
  const file = "scripts/ci/works-after/upgrade-postgres.sh";
  // Field pg SOURCES have no single canonical digest (cinatra#1417) — bare majors.
  for (const v of ["PG_CASEA_FROM_TAG", "PG_CASEB_FROM_TAG"]) {
    assert.doesNotMatch(
      resolveDefault(file, v),
      /@sha256:/,
      `${v} is a field source (no canonical digest) — must be a bare tag`,
    );
  }
  // TARGETS are the matrix pins — digest-bound (pins the fixture's proven bytes).
  for (const v of ["PG_CASEA_TO_TAG", "PG_CASEB_TO_TAG"]) {
    assert.match(
      resolveDefault(file, v),
      /@sha256:[0-9a-f]{64}$/,
      `${v} default must resolve digest-bound (the matrix target pin)`,
    );
  }
  assert.match(src, /scripts\/upgrade\/postgres-upgrade-major\.sh/, "must drive the committed pg family path");
});

// ── the fixture defaults ARE the matrix pins (cinatra#2194 / cinatra#2304) ────
// Every candidate image below is a projection of ONE source of truth: the
// docker-compose.yml pin, mirrored into config/upgrade/upgrade-matrix.json by
// Renovate's paired custom manager (cinatra#1863) and gated equal by
// scripts/check-upgrade-matrix.mjs check #4. A fixture that carried its own
// copied literal was a THIRD carrier nothing co-updates: it drifted onto a
// retired digest once (cinatra#2194) and made every Renovate digest PR born red
// on the guard below (cinatra#2304, PR #2301). The defaults are now DERIVED at
// runtime, so the carrier is gone by construction — these tests prove the
// derivation resolves to the matrix value and that no literal creeps back.
const MATRIX_CARRIED_DEFAULTS = [
  // [file, var, serviceId, coupledRepo|null, "ref" | "tag"]
  ["scripts/ci/works-after/upgrade-postgres.sh", "PG_CASEA_TO_TAG", "platform-postgres", null, "tag"],
  ["scripts/ci/works-after/upgrade-postgres.sh", "PG_CASEB_TO_TAG", "nango-postgres", null, "tag"],
  ["scripts/ci/works-after/nango.sh", "NANGO_SERVER_IMAGE", "nango-postgres", "nangohq/nango-server", "ref"],
  ["scripts/ci/works-after/upgrade-neo4j.sh", "NEO4J_TO_TAG", "neo4j", null, "tag"],
  ["scripts/ci/works-after/graphiti.sh", "NEO4J_IMAGE", "neo4j", null, "ref"],
  ["scripts/ci/works-after/upgrade-redis.sh", "REDIS_TO_TAG", "platform-redis", null, "tag"],
];

function matrixPinOf(matrix, serviceId, coupledRepo) {
  const svc = matrix.services.find((s) => s.id === serviceId);
  assert.ok(svc, `matrix must define service '${serviceId}'`);
  if (!coupledRepo) return svc.baselinePin.image;
  const hits = (svc.coupledAppImages ?? []).filter((c) => c.image.startsWith(`${coupledRepo}:`));
  assert.equal(hits.length, 1, `matrix must couple exactly one ${coupledRepo} to ${serviceId}`);
  return hits[0].image;
}

test("works-after fixture defaults EQUAL the matrix pins (drift guard, cinatra#2194/cinatra#2304)", () => {
  const matrix = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/upgrade/upgrade-matrix.json"), "utf8"));
  for (const [file, v, serviceId, coupledRepo, form] of MATRIX_CARRIED_DEFAULTS) {
    const pin = matrixPinOf(matrix, serviceId, coupledRepo);
    // A "tag" var carries the pin with the image repo stripped (postgres:X -> X).
    const expected = form === "tag" ? pin.slice(pin.split("@")[0].lastIndexOf(":") + 1) : pin;
    assert.equal(
      resolveDefault(file, v),
      expected,
      `${file}: ${v} default must resolve to the matrix ${serviceId}${coupledRepo ? ` / ${coupledRepo}` : ""} pin`,
    );
  }
});

test("the drift-guard table covers EVERY matrix-derived fixture default (no silent new projection)", () => {
  // MATRIX_CARRIED_DEFAULTS is the only place a derivation's INTENT (which
  // service/coupled image it must resolve to) is asserted; a new derived default
  // that never reaches the table would be unchecked. Scan the arms and require
  // every `VAR="${VAR:-$(wa_matrix_pin …)}"` to have a row.
  const armsDir = resolve(REPO_ROOT, "scripts/ci/works-after");
  const covered = new Set(MATRIX_CARRIED_DEFAULTS.map(([file, v]) => `${file}|${v}`));
  const found = [];
  for (const f of readdirSync(armsDir).filter((n) => n.endsWith(".sh"))) {
    const src = readFileSync(join(armsDir, f), "utf8");
    for (const m of src.matchAll(/^([A-Z0-9_]+)="\$\{\1:-\$\(wa_matrix_pin [^}]*\}"$/gm)) {
      found.push(`scripts/ci/works-after/${f}|${m[1]}`);
    }
  }
  assert.ok(found.length >= MATRIX_CARRIED_DEFAULTS.length, `expected at least ${MATRIX_CARRIED_DEFAULTS.length} derived defaults, found ${found.length}`);
  assert.deepEqual(
    found.filter((k) => !covered.has(k)),
    [],
    "a matrix-derived fixture default is missing from MATRIX_CARRIED_DEFAULTS — add a row so its intended service/pin is asserted",
  );
});

test("resolve-transition --pin/--image-repo fail closed on malformed invocations (cinatra#2304)", () => {
  // A typo must never silently change WHICH pin is printed (codex round-1).
  for (const [args, code, why] of [
    [["--pin", "neo4j", "--tagg"], 2, "unknown flag must not be swallowed as a positional"],
    [["--pin", "nango-postgres", "--couple", "nangohq/nango-server"], 2, "misspelled --coupled must not fall back to the baseline pin"],
    [["--image-repo", "neo4j", "--pin", "platform-redis"], 2, "mixed modes must refuse"],
    [["--pin", "neo4j", "stray"], 2, "a stray positional must refuse"],
    [["--coupled", "x"], 2, "--coupled without --pin must refuse"],
    [["--pin", "twenty-postgres"], 3, "a digestless matrix pin must refuse (a derived default pins bytes)"],
    [["--pin", "nope"], 3, "an unknown service must refuse"],
    [["--pin", "nango-postgres", "--coupled", "nope/nope"], 3, "an unmatched coupled repo must refuse"],
    // A repeated value flag must not silently last-one-wins (codex round-1).
    [["--pin", "neo4j", "--pin", "platform-redis"], 2, "a duplicate --pin must refuse, not print the second pin"],
    [["--image-repo", "neo4j", "--image-repo", "platform-redis"], 2, "a duplicate --image-repo must refuse"],
    [["--pin", "neo4j", "--coupled", "a", "--coupled", "b"], 2, "a duplicate --coupled must refuse"],
    // An omitted value must be a usage error, not a swallowed flag.
    [["--pin", "--tag"], 2, "--pin with no value must not swallow the next flag"],
    [["--pin", "nango-postgres", "--coupled", "--tag"], 2, "--coupled with no value must not swallow the next flag"],
  ]) {
    const r = runNode([RESOLVE, ...args]);
    assert.equal(r.status, code, `${args.join(" ")}: ${why} (stdout=${r.stdout} stderr=${r.stderr})`);
    assert.equal(r.stdout, "", `${args.join(" ")}: a refusal must print no image`);
  }
});

test("resolve-transition --tag projects repo:tag@digest and refuses a tagless ref (registry-port safe)", () => {
  const matrix = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/upgrade/upgrade-matrix.json"), "utf8"));
  const digest = `sha256:${"a".repeat(64)}`;
  const svc = matrix.services.find((s) => s.id === "platform-redis");
  const write = (image) => {
    svc.baselinePin.image = image;
    svc.baselinePin.digest = digest;
    const p = join(mkdtempSync(join(tmpdir(), "wa-pin-")), "upgrade-matrix.json");
    writeFileSync(p, JSON.stringify(matrix));
    return p;
  };
  // A registry host:port colon must NOT be mistaken for the tag separator.
  const withPort = runNode([RESOLVE, "--pin", "platform-redis", "--tag", "--matrix", write(`registry:5000/org/img:8-alpine@${digest}`)]);
  assert.equal(withPort.status, 0, withPort.stderr);
  assert.equal(withPort.stdout, `8-alpine@${digest}`);
  // A digest-only (tagless) ref has nothing to project — refuse, never emit junk.
  const tagless = runNode([RESOLVE, "--pin", "platform-redis", "--tag", "--matrix", write(`registry:5000/org/img@${digest}`)]);
  assert.equal(tagless.status, 3, `a tagless ref must refuse: ${tagless.stdout}`);
  assert.equal(tagless.stdout, "");
});

test("--image-repo / --coupled parse a registry host:port ref correctly (codex round-1)", () => {
  // imageRepoOf must split on the tag colon (first colon AFTER the last slash),
  // never a registry port — otherwise a ported ref shears down to its hostname
  // and a --coupled lookup silently mis-resolves.
  const matrix = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/upgrade/upgrade-matrix.json"), "utf8"));
  const digest = `sha256:${"b".repeat(64)}`;
  const svc = matrix.services.find((s) => s.id === "platform-redis");
  svc.baselinePin.image = `registry:5000/org/img@${digest}`;
  svc.baselinePin.digest = digest;
  svc.coupledAppImages = [{ image: `registry:5000/org/app@${digest}`, major: "x", digest }];
  const p = join(mkdtempSync(join(tmpdir(), "wa-repo-")), "upgrade-matrix.json");
  writeFileSync(p, JSON.stringify(matrix));

  const repo = runNode([RESOLVE, "--image-repo", "platform-redis", "--matrix", p]);
  assert.equal(repo.status, 0, repo.stderr);
  assert.equal(repo.stdout, "registry:5000/org/img", "a registry port must not be mistaken for a tag separator");

  const coupled = runNode([RESOLVE, "--pin", "platform-redis", "--coupled", "registry:5000/org/app", "--matrix", p]);
  assert.equal(coupled.status, 0, coupled.stderr);
  assert.equal(coupled.stdout, `registry:5000/org/app@${digest}`);
});

test("no works-after arm hardcodes a matrix pin digest — the third-carrier class stays gone (cinatra#2304)", () => {
  // Self-maintaining anti-carrier invariant: a digest the matrix carries must
  // never ALSO appear as a literal in an arm. (Fixture-only SOURCE pins — a
  // retired series the matrix does not model — are unaffected: their digests
  // are not matrix values.)
  const matrix = JSON.parse(readFileSync(resolve(REPO_ROOT, "config/upgrade/upgrade-matrix.json"), "utf8"));
  const matrixDigests = new Set();
  for (const s of matrix.services) {
    for (const pin of [s.baselinePin, ...(s.coupledAppImages ?? [])]) {
      const m = /(sha256:[0-9a-f]{64})/.exec(pin?.image ?? "");
      if (m) matrixDigests.add(m[1]);
      if (pin?.digest) matrixDigests.add(pin.digest);
    }
  }
  const armsDir = resolve(REPO_ROOT, "scripts/ci/works-after");
  const offenders = [];
  for (const f of readdirSync(armsDir).filter((f) => f.endsWith(".sh"))) {
    const src = readFileSync(join(armsDir, f), "utf8");
    for (const m of src.matchAll(/sha256:[0-9a-f]{64}/g)) {
      if (matrixDigests.has(m[0])) offenders.push(`${f}: ${m[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a works-after arm hardcodes a digest the upgrade matrix already carries — derive it with wa_matrix_pin instead (a copied literal is the carrier cinatra#2304 removed):\n  ${offenders.join("\n  ")}`,
  );
});

// ── neo4j family (cinatra#1421) ──────────────────────────────────────────────
// The one non-Postgres stateful family whose supported hop is a real
// DATA-MIGRATING transition (the semver->CalVer store-format upgrade). The LIVE
// guarded behaviour (offline `neo4j-admin database migrate`, rollback, cutover,
// failure injection) is proven by the docker-driving upgrade-neo4j arm; these
// pin the container-free invariants.
const NEO4J_PATH = resolve(REPO_ROOT, "scripts/upgrade/neo4j-upgrade-major.sh");

test("neo4j: the supported store-format hop resolves; downgrade + unlisted + unknown fail closed", () => {
  const ok = runNode([RESOLVE, "neo4j", "5.26", "2026.05"]);
  assert.equal(ok.status, 0, `neo4j 5.26->2026.05 should be supported: ${ok.stderr}`);
  const v = JSON.parse(ok.stdout);
  assert.equal(v.supported, true);
  assert.equal(v.service.family, "neo4j");
  assert.equal(v.mechanism, "in-place-store-format");
  for (const [from, to, why] of [
    ["2026.05", "5.26", "downgrade"],
    ["5.26", "5.26", "unlisted no-op"],
    ["4.4", "2026.05", "unlisted source"],
  ]) {
    assert.equal(runNode([RESOLVE, "neo4j", from, to]).status, 3, `neo4j ${from}->${to} (${why}) must fail closed`);
  }
});

test("neo4j path script: bad invocations exit usage code 2; the neo4j password is required via env", () => {
  assert.equal(runBash([NEO4J_PATH]).status, 2, "missing required args");
  assert.equal(runBash([NEO4J_PATH, "--bogus", "x"]).status, 2, "unknown flag");
  // The neo4j password must come from the environment (never argv).
  const rPw = runBash(
    [NEO4J_PATH, "--service", "neo4j", "--volume", "v", "--from", "5.26", "--to", "2026.05", "--backup-dir", "/tmp"],
    { UPGRADE_NEO4J_PASSWORD: "", UPGRADE_LEDGER_FILE: "/tmp/never-neo4j-paths-test.json" },
  );
  assert.equal(rPw.status, 2, "missing UPGRADE_NEO4J_PASSWORD must refuse");
  assert.match(rPw.stderr, /UPGRADE_NEO4J_PASSWORD/);
  // A --from-tag that does not bind to the resolved series is a usage error.
  const rBind = runBash(
    [NEO4J_PATH, "--service", "neo4j", "--volume", "v", "--from", "5.26", "--to", "2026.05", "--from-tag", "2026.05-community", "--backup-dir", "/tmp"],
    { UPGRADE_NEO4J_PASSWORD: "longenough8", UPGRADE_LEDGER_FILE: "/tmp/never-neo4j-paths-test.json" },
  );
  assert.equal(rBind.status, 2, "a --from-tag off the resolved series must refuse");
  assert.match(rBind.stderr, /does not run the matrix version/);
});

test("neo4j path script: an unsupported tuple refuses fail-closed (3) BEFORE any mutation — ledger never created", () => {
  const dir = mkdtempSync(join(tmpdir(), "uf-neo-refuse-"));
  const ledger = join(dir, "never.json");
  const down = runBash(
    [NEO4J_PATH, "--service", "neo4j", "--volume", "v", "--from", "2026.05", "--to", "5.26", "--backup-dir", dir],
    { UPGRADE_NEO4J_PASSWORD: "longenough8", UPGRADE_LEDGER_FILE: ledger },
  );
  assert.equal(down.status, 3, `neo4j 2026.05->5.26 downgrade must refuse: ${down.stderr}`);
  assert.ok(!existsSync(ledger), "a refusal must never touch the ledger");
});

test("neo4j path script runs with errtrace + the subshell trap guard", () => {
  const src = readFileSync(NEO4J_PATH, "utf8");
  assert.match(src, /set -Eeuo pipefail/, "neo4j path: ERR-trap transaction handling requires errtrace (-E)");
  assert.match(src, /BASH_SUBSHELL/, "neo4j path: the trap must no-op in subshells via BASH_SUBSHELL");
});

test("upgrade-neo4j fixture: digest-bound source AND target defaults, drives the committed neo4j family path", () => {
  const src = readFileSync(resolve(REPO_ROOT, "scripts/ci/works-after/upgrade-neo4j.sh"), "utf8");
  for (const v of ["NEO4J_FROM_TAG", "NEO4J_TO_TAG"]) {
    assert.match(
      resolveDefault("scripts/ci/works-after/upgrade-neo4j.sh", v),
      /@sha256:[0-9a-f]{64}$/,
      `${v} default must resolve digest-bound (pins the fixture bytes)`,
    );
  }
  assert.match(src, /scripts\/upgrade\/neo4j-upgrade-major\.sh/, "must drive the committed neo4j family path");
});
