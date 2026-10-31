// One design build at a time on a self-hosted machine: read, and RUN.
//
// scripts/ci/design-build-host-lock.sh runs the design suite's production
// build under one lock for the whole machine. Several self-hosted runners
// share one machine, and design builds that overlapped there were killed with
// exit 137 while builds that ran alone were not (the script's header has the
// counts). The run cases below start the real script with a stand-in build
// and a lock directory of their own; the lock cases need util-linux flock, GNU
// stat and Linux's /proc/self/fd, and are skipped where one is absent (a
// developer's macOS), as the GNU cases of design-build-cache.test.mjs are. The two cases that read file permissions
// are skipped for root, which file modes do not bind. The cases that need two
// jobs at once use a handshake (a gate file and the waiting line), never a
// fixed pause, and the waits of one case share one end. The clean-up ends a
// process only while its /proc/<pid>/cmdline names a path of the case. The
// shape cases read the two workflows whose Build step takes the PIXEL runners.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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
// The lock cases need util-linux flock, GNU stat and Linux's /proc/self/fd
// (the script reads the open file's identity there).
const CAN_LOCK =
  HAS_FLOCK &&
  existsSync("/proc/self/fd") &&
  spawnSync("bash", ["-c", "stat -c %i . && stat --version"], { stdio: "ignore" }).status === 0;
const REAL_STAT = spawnSync("bash", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
// The permission cases need an account that file modes bind; root ignores them.
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const LOCK_CASE_TIMEOUT_MS = 30_000;
// The waits of one case share one end, set this long ahead when the case
// starts, so all of them together stay well inside LOCK_CASE_TIMEOUT_MS.
const HANDSHAKE_MS = 20_000;
const WAITING_LINE = "design build host lock: held by another design build on this machine; waiting up to 60 s";

// Stand-in for the build: one line when it starts and one when it ends, in a
// shared log, and the exit code it is told to give. It writes its own pid to
// <log>.pids, so the case can find it (and the clean-up can end it) when the
// script that started it is gone. Between the two lines it can wait for a
// gate file (FAKE_BUILD_GATE, the case's handshake) and pause. With
// FAKE_BUILD_LEAVES_PID it also leaves a process running after it ends (as a
// build's stray worker would) and writes that process's pid to the file named;
// that process is `sleep 30` under the name <log>.stray, so the clean-up can
// tell it from any other process.
// With FAKE_BUILD_PROBE (files separated by ":") it writes, for each file,
// whether another job could lock it now ("free <file>" or "locked <file>"),
// to FAKE_BUILD_PROBE_LOG.
const FAKE_BUILD = [
  "#!/usr/bin/env bash",
  'printf \'%s\\n\' "$$" >>"$FAKE_BUILD_LOG.pids"',
  'printf \'start %s\\n\' "$1" >>"$FAKE_BUILD_LOG"',
  'if [ -n "${FAKE_BUILD_LEAVES_PID:-}" ]; then (exec -a "$FAKE_BUILD_LOG.stray" sleep 30) >/dev/null 2>&1 </dev/null & printf \'%s\\n\' "$!" >"$FAKE_BUILD_LEAVES_PID"; fi',
  'if [ -n "${FAKE_BUILD_PROBE:-}" ]; then',
  '  IFS=: read -r -a probe <<<"$FAKE_BUILD_PROBE"',
  '  for f in "${probe[@]}"; do if flock -n "$f" true; then echo "free $f"; else echo "locked $f"; fi; done >>"$FAKE_BUILD_PROBE_LOG"',
  "fi",
  'if [ -n "${FAKE_BUILD_GATE:-}" ]; then',
  '  i=0; while [ ! -e "$FAKE_BUILD_GATE" ] && [ "$i" -lt 1200 ]; do sleep 0.05; i=$((i + 1)); done',
  "fi",
  'if [ -n "${FAKE_BUILD_PAUSE:-}" ]; then sleep "$FAKE_BUILD_PAUSE"; fi',
  'printf \'end %s\\n\' "$1" >>"$FAKE_BUILD_LOG"',
  'exit "${FAKE_BUILD_EXIT:-0}"',
  "",
].join("\n");

const made = [];
const holders = [];
const strays = [];
const steps = [];
const killQuietly = (pid) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
};
// True only while <pid> runs a command line that names every one of <marks>
// (paths of the case), read from /proc/<pid>/cmdline just before a kill, so the
// clean-up never ends a process that was given a pid that became free.
const runsWith = (pid, ...marks) => {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return marks.every((mark) => cmdline.includes(mark));
  } catch {
    return false;
  }
};
afterEach(() => {
  // Processes a stand-in build left running, by the pid file the case registered before its run.
  for (const { pidFile, mark } of strays.splice(0)) {
    const pid = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";
    if (/^\d+$/.test(pid) && runsWith(pid, mark)) killQuietly(Number(pid));
  }
  // The holder's whole group (flock(1) and the command it keeps the lock for),
  // while its leader is still flock on the case's lock file.
  for (const { child, lockFile } of holders.splice(0)) {
    if (runsWith(child.pid, "flock", lockFile)) killQuietly(-child.pid);
  }
  for (const step of steps.splice(0)) {
    const running = step.child.exitCode === null && step.child.signalCode === null;
    if (running && runsWith(step.child.pid, SCRIPT, step.build)) killQuietly(step.child.pid);
  }
  for (const dir of made.splice(0)) {
    // Stand-in builds that outlived their script (a case that killed it, or a failed case).
    const pids = path.join(dir, "build.log.pids");
    for (const pid of existsSync(pids) ? readFileSync(pids, "utf8").split("\n") : []) {
      if (/^\d+$/.test(pid) && runsWith(pid, path.join(dir, "build.sh"))) killQuietly(Number(pid));
    }
    rmSync(dir, { recursive: true, force: true });
  }
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

/**
 * The script as a Build step runs it, with <label> as the stand-in build's
 * name, started and not awaited: `stdout` grows as the script prints, `exited`
 * settles when the script itself ends, `closed` when its output is closed too.
 */
function startStep(w, label, env = {}) {
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
  const step = { child, build: w.build, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (step.stdout += chunk));
  child.stderr.on("data", (chunk) => (step.stderr += chunk));
  step.exited = new Promise((resolve) => child.on("exit", (status, signal) => resolve({ status, signal })));
  step.closed = new Promise((resolve) =>
    child.on("close", (status) =>
      resolve({ status, stdout: step.stdout, stderr: step.stderr, seconds: (Date.now() - started) / 1000 }),
    ),
  );
  steps.push(step);
  return step;
}

/** The script as a Build step runs it, awaited to its end. */
const runStep = (w, label, env = {}) => startStep(w, label, env).closed;

/**
 * Waits until test() holds, at the latest until <end> (a Date.now() time that
 * all the waits of one case share); a case fails here, never by a fixed sleep.
 */
async function waitUntil(what, test, end) {
  while (Date.now() < end) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const buildLog = (w) => (existsSync(w.log) ? readFileSync(w.log, "utf8").trim().split("\n") : []);
const buildPids = (w) =>
  existsSync(`${w.log}.pids`) ? readFileSync(`${w.log}.pids`, "utf8").trim().split("\n").map(Number) : [];
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const canLockNow = (file) => spawnSync("flock", ["-n", file, "true"]).status === 0;

/** Another job holding the machine's lock until the case ends. */
async function holdLock(lockFile) {
  const holder = spawn("flock", [lockFile, "sleep", "60"], { stdio: "ignore", detached: true });
  holders.push({ child: holder, lockFile });
  for (let i = 0; i < 100; i += 1) {
    if (spawnSync("flock", ["-n", lockFile, "true"]).status !== 0) return holder;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the holder never took the lock");
}

describe.skipIf(!CAN_LOCK)("scripts/ci/design-build-host-lock.sh on a self-hosted runner", () => {
  it(
    "lets one build compile at a time: the second job waits for the first, on the same lock file",
    async () => {
      const w = workdir();
      const releaseA = path.join(w.root, "release-a");
      const end = Date.now() + HANDSHAKE_MS;
      // Job a takes the lock; its build runs until the case releases it.
      const stepA = startStep(w, "a", { FAKE_BUILD_GATE: releaseA });
      await waitUntil("build a to start", () => buildLog(w).includes("start a"), end);
      // The handshake: job b starts only now and says that it waits for the lock a holds.
      const stepB = startStep(w, "b");
      await waitUntil("job b to wait for the lock", () => stepB.stdout.includes(WAITING_LINE), end);
      expect(buildLog(w)).toEqual(["start a"]);
      writeFileSync(releaseA, "");
      const [a, b] = await Promise.all([stepA.closed, stepB.closed]);
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      // Never two builds at once: b's build starts after a's build ends.
      expect(buildLog(w)).toEqual(["start a", "end a", "start b", "end b"]);
      expect(a.stdout).not.toContain(WAITING_LINE);
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

  it(
    "leaves the lock free when the build ends, even with a process the build left running",
    async () => {
      const w = workdir();
      const pidFile = path.join(w.root, "stray.pid");
      // Registered before the run, so the clean-up ends the stray process even when an assertion below fails.
      strays.push({ pidFile, mark: `${w.log}.stray` });
      const r = await runStep(w, "a", { FAKE_BUILD_LEAVES_PID: pidFile });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("design build host lock: released after the build (exit 0)");
      const stray = Number(readFileSync(pidFile, "utf8").trim());
      // The build's stray process is still running, and it holds the lock's
      // descriptor (the build passed it on)...
      expect(isAlive(stray)).toBe(true);
      // ...and still the next job takes the lock at once: the script released it after the build.
      expect(canLockNow(w.lockFile)).toBe(true);
    },
    LOCK_CASE_TIMEOUT_MS,
  );

  it(
    "builds anyway, with a named line, when the wait is not a whole number of seconds",
    async () => {
      const w = workdir();
      const r = await runStep(w, "a", { DESIGN_BUILD_LOCK_WAIT_SECONDS: "45m", FAKE_BUILD_EXIT: "8" });
      expect(r.status).toBe(8);
      expect(buildLog(w)).toEqual(["start a", "end a"]);
      expect(r.stdout).toContain(
        "design build host lock: NOT TAKEN: the wait '45m' is not a whole number of seconds; building without the lock",
      );
      expect(r.stdout).not.toContain("lock file");
      expect(readdirSync(w.lockDir)).toEqual([]);
    },
    LOCK_CASE_TIMEOUT_MS,
  );

  it(
    "never uses a lock file that is a symbolic link, and builds anyway when no directory is usable",
    async () => {
      const w = workdir();
      const linkDir = path.join(w.root, "link-dir");
      mkdirSync(linkDir);
      const target = path.join(w.root, "link-target");
      symlinkSync(target, path.join(linkDir, LOCK_NAME));
      const notADirectory = path.join(w.root, "a-file");
      writeFileSync(notADirectory, "");
      const dirs = `${linkDir}:${path.join(w.root, "no-such-directory")}:${notADirectory}`;
      const r = await runStep(w, "a", { DESIGN_BUILD_LOCK_DIRS: dirs, FAKE_BUILD_EXIT: "9" });
      expect(r.status).toBe(9);
      expect(buildLog(w)).toEqual(["start a", "end a"]);
      expect(r.stdout).toContain(
        `design build host lock: NOT TAKEN: no lock file can be opened or made in ${dirs}; building without the lock`,
      );
      // The link was neither followed nor used to make its target.
      expect(existsSync(target)).toBe(false);
    },
    LOCK_CASE_TIMEOUT_MS,
  );

  it(
    "takes the lock in the first usable directory of a list that starts with unusable ones",
    async () => {
      const w = workdir();
      const linkDir = path.join(w.root, "link-dir");
      mkdirSync(linkDir);
      const target = path.join(w.root, "link-target");
      symlinkSync(target, path.join(linkDir, LOCK_NAME));
      const dirs = `${linkDir}:${path.join(w.root, "no-such-directory")}:${w.lockDir}`;
      const r = await runStep(w, "a", { DESIGN_BUILD_LOCK_DIRS: dirs });
      expect(r.status).toBe(0);
      expect(buildLog(w)).toEqual(["start a", "end a"]);
      const chosen = r.stdout.match(/^design build host lock: lock file (\S+) \(device \d+ inode \d+\), runner runner-a$/m);
      expect(chosen?.[1]).toBe(w.lockFile);
      expect(r.stdout).toMatch(/^design build host lock: TAKEN after \d+ s; building$/m);
      expect(existsSync(target)).toBe(false);
    },
    LOCK_CASE_TIMEOUT_MS,
  );

  it(
    "keeps the lock while the build runs, also when only the script is killed",
    async () => {
      const w = workdir();
      const releaseA = path.join(w.root, "release-a");
      const end = Date.now() + HANDSHAKE_MS;
      const stepA = startStep(w, "a", { FAKE_BUILD_GATE: releaseA });
      await waitUntil(
        "job a to take the lock and start its build",
        () => /^design build host lock: TAKEN after \d+ s; building$/m.test(stepA.stdout) && buildLog(w).includes("start a"),
        end,
      );
      // Only the script dies (SIGKILL, so it can do nothing more); its build lives on.
      stepA.child.kill("SIGKILL");
      expect((await stepA.exited).signal).toBe("SIGKILL");
      const [buildA] = buildPids(w);
      expect(isAlive(buildA)).toBe(true);
      // The lock is still taken by the build that runs...
      expect(canLockNow(w.lockFile)).toBe(false);
      // ...so the next job waits for it, and builds only after that build ends.
      const stepB = startStep(w, "b");
      await waitUntil("job b to wait for the lock", () => stepB.stdout.includes(WAITING_LINE), end);
      expect(buildLog(w)).toEqual(["start a"]);
      writeFileSync(releaseA, "");
      const b = await stepB.closed;
      expect(b.status).toBe(0);
      expect(buildLog(w)).toEqual(["start a", "end a", "start b", "end b"]);
      expect(b.stdout).toMatch(/^design build host lock: TAKEN after \d+ s; building$/m);
    },
    LOCK_CASE_TIMEOUT_MS,
  );

  // A second writer that replaces the lock file, or a stat that cannot read an
  // identity, at a moment that a stand-in `stat` first on PATH makes certain.
  // The script checks twice that the path names the open file: after the open
  // (stat calls 1 and 2: the open file, then the path) and after the lock is
  // taken (calls 3 and 4). The stand-in counts its calls in <root>/stat-calls.
  // - "open-file", "open-link": at call 1 it moves the opened file aside to
  //   <file>.old and puts a new regular file, or a symbolic link to the opened
  //   file, in its place; then it runs the real stat.
  // - "fail": every call fails, and the lock file stays as it is.
  // - "check-file", "check-link": at call 2 it runs the real stat first and
  //   keeps its output, so the first check passes; then it replaces the file
  //   as above and prints the kept output. The replacement is in place before
  //   the lock is taken.
  // - "recheck-fail": call 4 (the path's identity after the lock) fails.
  for (const [what, mode] of [
    ["is replaced by another regular file between the open and the first check", "open-file"],
    ["is replaced by a symbolic link to the opened file between the open and the first check", "open-link"],
    ["cannot be identified (every stat fails)", "fail"],
    ["is replaced by another regular file between the first check and the lock", "check-file"],
    ["is replaced by a symbolic link to the opened file between the first check and the lock", "check-link"],
    ["cannot be identified after the lock is taken (the path's stat fails)", "recheck-fail"],
  ]) {
    it(
      `does not use a lock file that ${what}, and builds anyway`,
      async () => {
        const w = workdir();
        writeFileSync(w.lockFile, "");
        const opened = statSync(w.lockFile).ino;
        const moved = !mode.endsWith("fail");
        // "open-*" and "fail" are refused at the first check, the others at the second.
        const atSecondCheck = mode.startsWith("check-") || mode === "recheck-fail";
        const shimBin = path.join(w.root, "shim-bin");
        mkdirSync(shimBin);
        const shim = path.join(shimBin, "stat");
        writeFileSync(
          shim,
          [
            "#!/usr/bin/env bash",
            'n=$(($(cat "$SHIM_CALLS" 2>/dev/null || echo 0) + 1))',
            'printf \'%s\\n\' "$n" >"$SHIM_CALLS"',
            "replace() {",
            '  mv "$SHIM_TARGET" "$SHIM_TARGET.old" || exit 98',
            '  if [ "${SHIM_MODE#*-}" = link ]; then ln -s "$SHIM_TARGET.old" "$SHIM_TARGET"',
            '  else : >"$SHIM_TARGET.new" && mv "$SHIM_TARGET.new" "$SHIM_TARGET"; fi',
            "}",
            'case "$SHIM_MODE:$n" in',
            "  fail:* | recheck-fail:4) exit 1 ;;",
            "  open-file:1 | open-link:1) replace ;;",
            "  check-file:2 | check-link:2)",
            '    out="$("$SHIM_REAL_STAT" "$@")"; rc=$?',
            "    replace",
            '    printf \'%s\\n\' "$out"; exit "$rc" ;;',
            "esac",
            'exec "$SHIM_REAL_STAT" "$@"',
            "",
          ].join("\n"),
        );
        chmodSync(shim, 0o755);
        const calls = path.join(w.root, "stat-calls");
        const probeLog = path.join(w.root, "probe.log");
        const probed = moved ? [`${w.lockFile}.old`, w.lockFile] : [w.lockFile];
        const r = await runStep(w, "a", {
          PATH: `${shimBin}:${process.env.PATH}`,
          SHIM_CALLS: calls,
          SHIM_TARGET: w.lockFile,
          SHIM_MODE: mode,
          SHIM_REAL_STAT: REAL_STAT,
          FAKE_BUILD_PROBE: probed.join(":"),
          FAKE_BUILD_PROBE_LOG: probeLog,
          FAKE_BUILD_EXIT: "5",
        });
        expect(r.status).toBe(5);
        expect(buildLog(w)).toEqual(["start a", "end a"]);
        const lines = r.stdout.split("\n");
        if (atSecondCheck) {
          // The first check passed: the script named the file it opened...
          const named = lines.findIndex((l) => l.startsWith(`design build host lock: lock file ${w.lockFile} (device `));
          expect(named, "the lock file line").toBeGreaterThan(-1);
          expect(lines[named]).toMatch(new RegExp(` inode ${opened}\\), runner runner-a$`));
          // ...and after the lock it found that the path no longer names that file.
          const refused = lines.indexOf(
            `design build host lock: not using ${w.lockFile}: after the lock was taken, the file that was locked is not shown to be the regular file this path names`,
          );
          expect(refused, "the not using line after the lock").toBeGreaterThan(named);
          expect(lines).toContain("design build host lock: NOT TAKEN: the lock was released again; building without the lock");
        } else {
          expect(lines).toContain(
            `design build host lock: not using ${w.lockFile}: the file that was opened is not shown to be the regular file this path names`,
          );
          expect(lines).toContain(
            `design build host lock: NOT TAKEN: no lock file can be opened or made in ${w.lockDir}; building without the lock`,
          );
          // No identity is printed for a file it does not use.
          expect(r.stdout).not.toMatch(/^design build host lock: lock file /m);
        }
        // No TAKEN line, and no lock is held during the build: every file is free.
        expect(r.stdout).not.toMatch(/^design build host lock: TAKEN after/m);
        expect(readFileSync(probeLog, "utf8").trim().split("\n")).toEqual(probed.map((f) => `free ${f}`));
        // The file the script opened: moved aside, or still in place.
        expect(statSync(moved ? `${w.lockFile}.old` : w.lockFile).ino).toBe(opened);
        // The stand-in acted: two stat calls for the first check, two more for the second.
        expect(Number(readFileSync(calls, "utf8").trim()), "the stat calls").toBe(atSecondCheck ? 4 : 2);
      },
      LOCK_CASE_TIMEOUT_MS,
    );
  }

  it.skipIf(IS_ROOT)(
    "goes on to the next directory when it may not make the lock file in one",
    async () => {
      const w = workdir();
      const noWrite = path.join(w.root, "no-write");
      mkdirSync(noWrite);
      chmodSync(noWrite, 0o555);
      const r = await runStep(w, "a", { DESIGN_BUILD_LOCK_DIRS: `${noWrite}:${w.lockDir}` });
      expect(r.status).toBe(0);
      expect(buildLog(w)).toEqual(["start a", "end a"]);
      expect(readdirSync(noWrite)).toEqual([]);
      const chosen = r.stdout.match(/^design build host lock: lock file (\S+) \(device \d+ inode \d+\), runner runner-a$/m);
      expect(chosen?.[1]).toBe(w.lockFile);
      expect(r.stdout).toMatch(/^design build host lock: TAKEN after \d+ s; building$/m);
    },
    LOCK_CASE_TIMEOUT_MS,
  );

  it.skipIf(IS_ROOT)(
    "goes on to the next directory when it may not open the lock file in one",
    async () => {
      const w = workdir();
      const noRead = path.join(w.root, "no-read");
      mkdirSync(noRead);
      const unreadable = path.join(noRead, LOCK_NAME);
      writeFileSync(unreadable, "");
      chmodSync(unreadable, 0o000);
      const r = await runStep(w, "a", { DESIGN_BUILD_LOCK_DIRS: `${noRead}:${w.lockDir}` });
      expect(r.status).toBe(0);
      expect(buildLog(w)).toEqual(["start a", "end a"]);
      expect(statSync(unreadable).mode & 0o777).toBe(0);
      const chosen = r.stdout.match(/^design build host lock: lock file (\S+) \(device \d+ inode \d+\), runner runner-a$/m);
      expect(chosen?.[1]).toBe(w.lockFile);
      expect(r.stdout).toMatch(/^design build host lock: TAKEN after \d+ s; building$/m);
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
