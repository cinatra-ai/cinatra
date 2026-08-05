// Coverage-ratchet BASE RESOLUTION (cinatra#2430).
//
// design-visual-verify.yml triggers on `pull_request` only, so its HEAD is the
// merge commit GitHub froze into the run's event, while the old ratchet step
// resolved the base branch's LIVE TIP at step-execution time:
//
//   git fetch --no-tags --depth=1 origin "+refs/heads/$GITHUB_BASE_REF:…"
//   node scripts/design/check-conformance-ratchet.mjs "origin/$GITHUB_BASE_REF"
//
// Those two disagree whenever the base's allowlist SHRINKS after the run's
// snapshot was recorded — most plainly on a RE-RUN, which replays the frozen
// merge commit against today's tip. The frozen HEAD still carries the removed
// exemptions and the shrink-only comparison reads them as ADDED: a hard red on
// a PR that touched nothing.
//
// These tests build that shape at the GIT level (a bare origin, a recorded
// refs/pull/N/merge, the base advancing afterwards, and a workspace fetched the
// way actions/checkout clones a pull_request run at its DEFAULT depth) and drive
// the REAL scripts/design/check-conformance-ratchet.mjs over it — plus the REAL
// shell body of the workflow step, extracted from the YAML. So they prove the
// failure mode, that the recorded-base-SHA fix is immune to it, that a fresh run
// is unchanged, and that the step still fails CLOSED.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const RATCHET_REL = "scripts/design/check-conformance-ratchet.mjs";
const ALLOWLIST_REL = "tests/e2e/design/conformance/allowlist.json";
const WORKFLOW_REL = ".github/workflows/design-visual-verify.yml";
const STEP_NAME = "conformance coverage ratchet (shrink-only)";

// The pre-fix step body, verbatim — kept here so the race stays reproducible
// after the workflow no longer contains it.
const OLD_STEP_BODY = [
  'git fetch --no-tags --depth=1 origin "+refs/heads/$GITHUB_BASE_REF:refs/remotes/origin/$GITHUB_BASE_REF"',
  'node scripts/design/check-conformance-ratchet.mjs "origin/$GITHUB_BASE_REF"',
].join("\n");

const gitIn = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function writeIn(cwd, rel, body) {
  mkdirSync(path.join(cwd, rel, ".."), { recursive: true });
  writeFileSync(path.join(cwd, rel), body);
}

function commitIn(cwd, msg) {
  gitIn(cwd, "add", "-A");
  gitIn(cwd, "-c", "user.email=a@b.c", "-c", "user.name=test", "commit", "-q", "-m", msg);
  return gitIn(cwd, "rev-parse", "HEAD");
}

const allowlistJson = (surfaces) =>
  `${JSON.stringify({ allow: surfaces.map((surface) => ({ surface, reason: "not yet covered" })) }, null, 2)}\n`;

/** Run a shell body the way the runner does (bash -e -u -o pipefail, cwd=ws). */
function runShell(body, { cwd, env }) {
  try {
    const stdout = execFileSync("bash", ["-c", body], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

/** The `run: |` body of a named step, dedented — the text CI actually executes. */
function extractStepRunBody(yml, stepName) {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (start < 0) throw new Error(`step "${stepName}" not found`);
  const stepIndent = lines[start].indexOf("- name:");
  let i = start + 1;
  for (; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (/^run: \|-?$/.test(trimmed)) break;
    // Ran off the end of this step without finding a literal-block `run:`.
    if (trimmed.startsWith("- name:") || i === lines.length - 1) {
      throw new Error(`step "${stepName}" has no "run: |" block`);
    }
  }
  const body = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    const line = lines[j];
    if (line.trim() !== "" && line.search(/\S/) <= stepIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((l) => l.trim() !== "").map((l) => l.search(/\S/)));
  return `${body.map((l) => l.slice(indent)).join("\n").trimEnd()}\n`;
}

/**
 * Returns { ws, baseSha, mergeSha, liveTip } where `ws` mirrors a
 * design-visual-verify checkout: actions/checkout at its DEFAULT fetch-depth,
 * detached at the merge commit frozen in the event.
 *   baseShrinks: the base branch drops an allowlist entry AFTER the merge
 *                commit is recorded (the re-run race).
 *   prAddsExemption: the PR itself adds an exemption (a genuine ratchet red).
 */
function buildRatchetWorkspace({ baseShrinks, prAddsExemption = false }) {
  const root = mkdtempSync(path.join(tmpdir(), "ratchet-base-"));
  const origin = path.join(root, "origin.git");
  const up = path.join(root, "upstream");
  gitIn(root, "init", "-q", "--bare", "-b", "main", origin);
  // GitHub serves `git fetch origin <sha>` for REACHABLE commits; a stock bare
  // repo does not unless told to. Mirror exactly that (not allowAnySHA1InWant,
  // which is broader than the server the workflow actually talks to), so an
  // unreachable SHA still fails here the way it would in CI.
  gitIn(origin, "config", "uploadpack.allowReachableSHA1InWant", "true");

  mkdirSync(up);
  gitIn(up, "init", "-q", "-b", "main");
  gitIn(up, "remote", "add", "origin", origin);

  // Base: the REAL ratchet script + a two-entry allowlist. The script resolves
  // its repo root from its own location, so the copy must sit at the real path.
  mkdirSync(path.join(up, path.dirname(RATCHET_REL)), { recursive: true });
  copyFileSync(path.join(REPO_ROOT, RATCHET_REL), path.join(up, RATCHET_REL));
  writeIn(up, ALLOWLIST_REL, allowlistJson(["surface-a", "surface-b"]));
  const baseSha = commitIn(up, "base"); // == github.event.pull_request.base.sha
  gitIn(up, "push", "-q", "origin", "main");

  // The PR: by default it touches NOTHING the ratchet reads.
  gitIn(up, "checkout", "-q", "-b", "pr-head");
  writeIn(up, "docs/unrelated.md", "an untouched-by-the-ratchet change\n");
  if (prAddsExemption) writeIn(up, ALLOWLIST_REL, allowlistJson(["surface-a", "surface-b", "surface-c"]));
  const headSha = commitIn(up, "pr");

  // The merge commit GitHub freezes into the event as github.sha.
  gitIn(up, "checkout", "-q", "-b", "merge-ref", baseSha);
  gitIn(up, "-c", "user.email=a@b.c", "-c", "user.name=test", "merge", "-q", "--no-ff", "-m", "merge pr", headSha);
  const mergeSha = gitIn(up, "rev-parse", "HEAD");
  gitIn(up, "push", "-q", "origin", "merge-ref:refs/pull/1/merge");

  // …and only THEN does someone land coverage for surface-b on the base.
  let liveTip = baseSha;
  if (baseShrinks) {
    gitIn(up, "checkout", "-q", "main");
    writeIn(up, ALLOWLIST_REL, allowlistJson(["surface-a"]));
    liveTip = commitIn(up, "cover surface-b: drop its exemption");
    gitIn(up, "push", "-q", "origin", "main");
  }

  const ws = path.join(root, "workspace");
  mkdirSync(ws);
  gitIn(ws, "init", "-q");
  // file:// (not a plain path) so --depth behaves like it does over the wire.
  gitIn(ws, "remote", "add", "origin", `file://${origin}`);
  gitIn(ws, "fetch", "--no-tags", "--depth=1", "-q", "origin", `+${mergeSha}:refs/remotes/pull/1/merge`);
  gitIn(ws, "checkout", "-q", "--detach", mergeSha);
  return { ws, baseSha, mergeSha, liveTip };
}

const runOldStep = (ws) => runShell(OLD_STEP_BODY, { cwd: ws, env: { GITHUB_BASE_REF: "main" } });
const runNewStep = (ws, baseSha) =>
  runShell(extractStepRunBody(readFileSync(path.join(REPO_ROOT, WORKFLOW_REL), "utf8"), STEP_NAME), {
    cwd: ws,
    env: { BASE_SHA: baseSha },
  });

describe("conformance coverage ratchet — base resolution on a re-run (cinatra#2430)", () => {
  it("live-tip base reds an UNTOUCHED PR after the base allowlist shrinks; the recorded base SHA stays green", () => {
    const { ws, baseSha, liveTip } = buildRatchetWorkspace({ baseShrinks: true });
    expect(liveTip).not.toBe(baseSha);

    // RED BEFORE — the old step, verbatim, on the frozen snapshot.
    const before = runOldStep(ws);
    expect(gitIn(ws, "rev-parse", "origin/main")).toBe(liveTip); // today's tip, not the run's base
    expect(before.code).toBe(1);
    expect(before.stderr).toMatch(/conformance ratchet FAILED: the allowlist is SHRINK-ONLY/);
    expect(before.stderr).toMatch(/surface-b\/\*/);

    // GREEN AFTER — the shipped step, on the same workspace.
    const after = runNewStep(ws, baseSha);
    expect(after.code).toBe(0);
    expect(after.stdout).toMatch(new RegExp(`conformance ratchet base: ${baseSha} \\(recorded PR base commit\\)`));
    expect(after.stdout).toMatch(new RegExp(`conformance ratchet OK vs ${baseSha}`));

    // …and the PR genuinely changed nothing the ratchet reads (asserted once
    // the step has brought the recorded base commit into the workspace).
    expect(gitIn(ws, "diff", "--name-only", `${baseSha}..HEAD`).split("\n")).toEqual(["docs/unrelated.md"]);
  });

  it("fetches the recorded base BY SHA with no --depth, leaving the frozen HEAD's graft alone", () => {
    const { ws, baseSha } = buildRatchetWorkspace({ baseShrinks: true });
    const shallowBefore = readFileSync(path.join(ws, ".git", "shallow"), "utf8").trim();

    expect(runNewStep(ws, baseSha).code).toBe(0);

    // The base commit is now in hand and readable AT that commit…
    expect(gitIn(ws, "rev-parse", `${baseSha}^{commit}`)).toBe(baseSha);
    expect(() => gitIn(ws, "cat-file", "-e", `${baseSha}:${ALLOWLIST_REL}`)).not.toThrow();
    // …and nothing re-grafted the checkout the run was handed.
    expect(readFileSync(path.join(ws, ".git", "shallow"), "utf8").trim()).toBe(shallowBefore);
    // origin/main was never resolved at all — the live tip is now irrelevant.
    expect(() => gitIn(ws, "rev-parse", "--verify", "origin/main")).toThrow();
  });

  it("fresh run (base unmoved): the recorded base SHA IS the live tip and both verdicts agree", () => {
    const { ws, baseSha, liveTip } = buildRatchetWorkspace({ baseShrinks: false });
    expect(liveTip).toBe(baseSha);

    const old = runOldStep(ws);
    expect(old.code).toBe(0);
    expect(gitIn(ws, "rev-parse", "origin/main")).toBe(baseSha); // equivalence, at the git level
    expect(old.stdout).toMatch(/conformance ratchet OK vs origin\/main: 2 exemptions at HEAD/);

    const fresh = runNewStep(ws, baseSha);
    expect(fresh.code).toBe(0);
    expect(fresh.stdout).toMatch(new RegExp(`conformance ratchet OK vs ${baseSha}: 2 exemptions at HEAD`));
  });

  it("a REAL ratchet violation is still red under the recorded base SHA", () => {
    const { ws, baseSha } = buildRatchetWorkspace({ baseShrinks: true, prAddsExemption: true });
    const res = runNewStep(ws, baseSha);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/conformance ratchet FAILED: the allowlist is SHRINK-ONLY/);
    expect(res.stderr).toMatch(/surface-c\/\*/);
    // surface-b was removed on the base AFTER the snapshot, so it must NOT be
    // reported — that is exactly the spurious finding this fix removes.
    expect(res.stderr).not.toMatch(/surface-b/);
  });
});

describe("conformance coverage ratchet — fail-closed (cinatra#2430)", () => {
  it("an unresolvable recorded base commit fails the step with a clear message", () => {
    const { ws } = buildRatchetWorkspace({ baseShrinks: false });
    const absent = "0".repeat(39) + "1"; // well-formed, not in any history
    const res = runNewStep(ws, absent);
    expect(res.code).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(
      new RegExp(`conformance ratchet FAILED: recorded PR base commit ${absent} could not be fetched`),
    );
    expect(`${res.stdout}${res.stderr}`).toMatch(/must not fail open/);
    // It failed BEFORE reaching the check — it never reported a green verdict.
    expect(res.stdout).not.toMatch(/conformance ratchet OK/);
  });

  it("an empty recorded base commit fails the step rather than skipping the check", () => {
    const { ws } = buildRatchetWorkspace({ baseShrinks: false });
    const res = runNewStep(ws, "");
    expect(res.code).toBe(1);
    expect(`${res.stdout}${res.stderr}`).toMatch(/carries no pull_request\.base\.sha/);
    expect(res.stdout).not.toMatch(/conformance ratchet OK/);
  });
});

describe("design-visual-verify.yml — the ratchet base stays pinned to the run's snapshot", () => {
  const yml = () => readFileSync(path.join(REPO_ROOT, WORKFLOW_REL), "utf8");

  it("the workflow exists and the ratchet step still runs the ratchet script", () => {
    expect(existsSync(path.join(REPO_ROOT, WORKFLOW_REL))).toBe(true);
    expect(extractStepRunBody(yml(), STEP_NAME)).toMatch(/node scripts\/design\/check-conformance-ratchet\.mjs/);
  });

  it("never re-resolves the base branch's live tip (a re-introduction of cinatra#2430)", () => {
    const body = extractStepRunBody(yml(), STEP_NAME);
    expect(body).not.toMatch(/GITHUB_BASE_REF/);
    expect(body).not.toMatch(/refs\/heads\//);
    // No shallow re-graft either (the cinatra#2212 anti-pattern).
    expect(body).not.toMatch(/^\s*git fetch[^\n]*--depth/m);
  });

  it("passes the run's own recorded base commit to the ratchet script", () => {
    expect(yml()).toMatch(/BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    const body = extractStepRunBody(yml(), STEP_NAME);
    expect(body).toMatch(/node scripts\/design\/check-conformance-ratchet\.mjs "\$\{BASE_SHA\}"/);
    // The immutable SHA is logged.
    expect(body).toMatch(/echo "conformance ratchet base: \$\{BASE_SHA\}/);
  });

  it("keeps the step fail-closed (set -euo pipefail + explicit resolve guards)", () => {
    const body = extractStepRunBody(yml(), STEP_NAME);
    expect(body).toMatch(/set -euo pipefail/);
    expect(body).toMatch(/rev-parse --verify --quiet "\$\{BASE_SHA\}\^\{commit\}"/);
    expect((body.match(/must not fail open/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
