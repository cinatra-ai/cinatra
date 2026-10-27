// One design build at a time on a self-hosted machine: read, and RUN.
//
// scripts/ci/design-build-host-lock.sh runs the design suite's production
// build under one lock for the whole machine. Several self-hosted runners
// share one machine, and design builds that overlapped there were killed with
// exit 137 while builds that ran alone were not (the script's header has the
// counts). The run cases below start the real script with a stand-in build
// and a lock directory of their own; the lock cases need util-linux flock and
// are skipped where it is absent (a developer's macOS), as the GNU cases of
// design-build-cache.test.mjs are. The shape cases read the two workflows
// whose Build step takes the PIXEL runners.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "ci", "design-build-host-lock.sh");
const LOCK_NAME = "cinatra-design-build.lock";
const BASH = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim() || "/bin/bash";
const HAS_FLOCK = spawnSync("bash", ["-c", "command -v flock"]).status === 0;
const LOCK_CASE_TIMEOUT_MS = 30_000;

// Stand-in for the build: one line when it starts and one when it ends, in a
// shared log, a pause between them, and the exit code it is told to give.
const FAKE_BUILD = [
  "#!/usr/bin/env bash",
  'printf \'start %s\\n\' "$1" >>"$FAKE_BUILD_LOG"',
  'if [ -n "${FAKE_BUILD_PAUSE:-}" ]; then sleep "$FAKE_BUILD_PAUSE"; fi',
  'printf \'end %s\\n\' "$1" >>"$FAKE_BUILD_LOG"',
  'exit "${FAKE_BUILD_EXIT:-0}"',
  "",
].join("\n");

const made = [];
const holders = [];
afterEach(() => {
  // The holder's whole group: flock(1) and the command it keeps the lock for.
  for (const holder of holders.splice(0)) {
    try {
      process.kill(-holder.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workdir() {
  const root = mkdtempSync(path.join(tmpdir(), "design-build-host-lock-"));
  made.push(root);
  const lockDir = path.join(root, "lock");
  mkdirSync(lockDir);
  const build = path.join(root, "build.sh");
  writeFileSync(build, FAKE_BUILD);
  chmodSync(build, 0o755);
  const log = path.join(root, "build.log");
  return { root, lockDir, build, log, lockFile: path.join(lockDir, LOCK_NAME) };
}

/** The script as a Build step runs it, with <label> as the stand-in build's name. */
function runStep(w, label, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(BASH, [SCRIPT, BASH, w.build, label], {
      env: {
        ...process.env,
        DESIGN_BUILD_LOCK_RUNNER_ENVIRONMENT: "self-hosted",
        DESIGN_BUILD_LOCK_DIRS: w.lockDir,
        DESIGN_BUILD_LOCK_WAIT_SECONDS: "60",
        RUNNER_NAME: `runner-${label}`,
        FAKE_BUILD_LOG: w.log,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr, seconds: (Date.now() - started) / 1000 }));
  });
}

const buildLog = (w) => (existsSync(w.log) ? readFileSync(w.log, "utf8").trim().split("\n") : []);

/** Another job holding the machine's lock until the case ends. */
async function holdLock(lockFile) {
  const holder = spawn("flock", [lockFile, "sleep", "60"], { stdio: "ignore", detached: true });
  holders.push(holder);
  for (let i = 0; i < 100; i += 1) {
    if (spawnSync("flock", ["-n", lockFile, "true"]).status !== 0) return holder;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the holder never took the lock");
}

describe.skipIf(!HAS_FLOCK)("scripts/ci/design-build-host-lock.sh on a self-hosted runner", () => {
  it(
    "lets one build compile at a time: the second job waits for the first, on the same lock file",
    async () => {
      const w = workdir();
      const [a, b] = await Promise.all([
        runStep(w, "a", { FAKE_BUILD_PAUSE: "1.5" }),
        runStep(w, "b", { FAKE_BUILD_PAUSE: "1.5" }),
      ]);
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      const log = buildLog(w);
      expect(log).toHaveLength(4);
      // Never two builds at once: each start is followed by its own end.
      expect(log[1]).toBe(log[0].replace("start", "end"));
      expect(log[3]).toBe(log[2].replace("start", "end"));
      const waited = [a, b].filter((r) =>
        r.stdout.includes("design build host lock: held by another design build on this machine; waiting up to 60 s"),
      );
      expect(waited).toHaveLength(1);
      for (const r of [a, b]) {
        expect(r.stdout).toMatch(/^design build host lock: TAKEN after \d+ s; building$/m);
        expect(r.stdout).toContain("design build host lock: released after the build (exit 0)");
      }
      // The first runs prove the lock is shared by printing the same file identity.
      const identity = (r) =>
        r.stdout.match(/^design build host lock: lock file (\S+) \((device \d+ inode \d+)\), runner runner-[ab]$/m)?.slice(1);
      expect(identity(a)).toBeDefined();
      expect(identity(a)).toEqual(identity(b));
      expect(identity(a)[0]).toBe(w.lockFile);
    },
    LOCK_CASE_TIMEOUT_MS,
  );

  it(
    "returns the build's own exit code",
    async () => {
      const w = workdir();
      const r = await runStep(w, "a", { FAKE_BUILD_EXIT: "7" });
      expect(r.status).toBe(7);
      expect(buildLog(w)).toEqual(["start a", "end a"]);
      expect(r.stdout).toContain("design build host lock: released after the build (exit 7)");
    },
    LOCK_CASE_TIMEOUT_MS,
  );

  it(
    "builds anyway, with a named line, when the wait ends without the lock",
    async () => {
      const w = workdir();
      const holder = await holdLock(w.lockFile);
      const r = await runStep(w, "a", { DESIGN_BUILD_LOCK_WAIT_SECONDS: "1", FAKE_BUILD_EXIT: "3" });
      expect(r.status).toBe(3);
      expect(buildLog(w)).toEqual(["start a", "end a"]);
      expect(r.stdout).toContain("design build host lock: held by another design build on this machine; waiting up to 1 s");
      expect(r.stdout).toMatch(
        /^design build host lock: NOT TAKEN: the lock was not free after \d+ s; building without the lock$/m,
      );
      expect(r.seconds).toBeLessThan(20);
      expect(holder.exitCode).toBeNull();
    },
    LOCK_CASE_TIMEOUT_MS,
  );

  it(
    "builds anyway, with a named line, when no lock file can be opened or made",
    async () => {
      const w = workdir();
      // Not a directory and not there at all: neither can hold a lock file, for any account.
      const notADirectory = path.join(w.root, "build.log-is-a-file");
      writeFileSync(notADirectory, "");
      const missing = path.join(w.root, "no-such-directory");
      const dirs = `${notADirectory}:${missing}`;
      const r = await runStep(w, "a", { DESIGN_BUILD_LOCK_DIRS: dirs, FAKE_BUILD_EXIT: "5" });
      expect(r.status).toBe(5);
      expect(buildLog(w)).toEqual(["start a", "end a"]);
      expect(r.stdout).toContain(
        `design build host lock: NOT TAKEN: no lock file can be opened or made in ${dirs}; building without the lock`,
      );
      expect(existsSync(missing)).toBe(false);
    },
    LOCK_CASE_TIMEOUT_MS,
  );

  it(
    "does not wait for a held lock on a GitHub-hosted runner",
    async () => {
      const w = workdir();
      await holdLock(w.lockFile);
      const r = await runStep(w, "a", { DESIGN_BUILD_LOCK_RUNNER_ENVIRONMENT: "github-hosted" });
      expect(r.status).toBe(0);
      expect(buildLog(w)).toEqual(["start a", "end a"]);
      expect(r.stdout).toContain(
        "design build host lock: not used: the runner environment is github-hosted, not self-hosted; building",
      );
      expect(r.seconds).toBeLessThan(20);
    },
    LOCK_CASE_TIMEOUT_MS,
  );
});

describe("scripts/ci/design-build-host-lock.sh without a lock", () => {
  it(
    "builds anyway, with a named line, when flock is not on the runner",
    async () => {
      const w = workdir();
      const emptyBin = path.join(w.root, "bin");
      mkdirSync(emptyBin);
      const r = await runStep(w, "a", { PATH: emptyBin, FAKE_BUILD_EXIT: "4" });
      expect(r.status).toBe(4);
      expect(buildLog(w)).toEqual(["start a", "end a"]);
      expect(r.stdout).toContain("design build host lock: NOT TAKEN: flock is not on this runner; building without the lock");
      expect(readdirSync(w.lockDir)).toEqual([]);
    },
    LOCK_CASE_TIMEOUT_MS,
  );

  it(
    "does nothing on a GitHub-hosted runner: no lock file, the build at once",
    async () => {
      const w = workdir();
      const r = await runStep(w, "a", { DESIGN_BUILD_LOCK_RUNNER_ENVIRONMENT: "github-hosted", FAKE_BUILD_EXIT: "6" });
      expect(r.status).toBe(6);
      expect(buildLog(w)).toEqual(["start a", "end a"]);
      expect(r.stdout).toContain(
        "design build host lock: not used: the runner environment is github-hosted, not self-hosted; building",
      );
      expect(r.stdout).not.toContain("lock file");
      expect(readdirSync(w.lockDir)).toEqual([]);
    },
    LOCK_CASE_TIMEOUT_MS,
  );
});

/** The Build step of a workflow as text, and the timeout of the job that holds it. */
function buildStep(file) {
  const lines = readFileSync(path.join(REPO_ROOT, ".github", "workflows", file), "utf8").split("\n");
  const at = lines.findIndex((l) => /^\s*- name: Build \(standalone production server\)$/.test(l));
  expect(at, `${file} has a Build (standalone production server) step`).toBeGreaterThan(-1);
  const indent = lines[at].match(/^(\s*)-/)[1];
  let end = at + 1;
  while (end < lines.length && !lines[end].startsWith(`${indent}- `) && (lines[end] === "" || lines[end].startsWith(`${indent} `))) {
    end += 1;
  }
  const timeouts = lines.slice(0, at).filter((l) => /^\s+timeout-minutes: \d+$/.test(l));
  return {
    text: lines.slice(at, end).join("\n"),
    jobTimeoutMinutes: Number(timeouts.at(-1)?.match(/(\d+)$/)[1]),
    others: lines.filter((l, i) => (i < at || i >= end) && l.includes("design-build-host-lock.sh") && !/^\s*#/.test(l)),
  };
}

describe("the PIXEL Build steps run under the machine's design build lock", () => {
  for (const [file, run] of [
    [
      "design-visual-verify.yml",
      "bash scripts/ci/design-build-host-lock.sh bash -c 'pnpm build || bash scripts/ci/design-build-cache.sh rebuild \"$?\"'",
    ],
    ["design-baselines-refresh.yml", "bash scripts/ci/design-build-host-lock.sh pnpm build"],
  ]) {
    it(`${file}: the Build step, and only it, goes through the script`, () => {
      const step = buildStep(file);
      expect(step.text.match(/^\s+run: (.+)$/m)?.[1]).toBe(run);
      expect(step.text).toMatch(/^\s+DESIGN_BUILD_LOCK_RUNNER_ENVIRONMENT: \$\{\{ runner\.environment \}\}$/m);
      expect(step.others).toEqual([]);
    });

    it(`${file}: the wait is at most half of the job's timeout`, () => {
      const step = buildStep(file);
      const wait = Number(step.text.match(/^\s+DESIGN_BUILD_LOCK_WAIT_SECONDS: ["']?(\d+)["']?$/m)?.[1]);
      expect(wait).toBeGreaterThan(0);
      expect(step.jobTimeoutMinutes).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual((step.jobTimeoutMinutes * 60) / 2);
    });
  }
});
