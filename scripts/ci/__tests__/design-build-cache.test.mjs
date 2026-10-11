// The design suite's runner-local build cache (cinatra#3771): read, and RUN.
//
// The shape cases read the pixel-diff job of design-visual-verify.yml: the
// cache is restored before the build and kept after it, on self-hosted runners
// only and only for a pull request that carries the label design-build-cache
// (cinatra#3810), and the build falls back to a full build.
//
// The run cases lay out one self-hosted runner the way the job sees it (a work
// root, the workspace and the checkout beneath it, the job's temporary
// directory, its step output and summary files) under a temporary directory,
// put a stand-in `pnpm` first on PATH, and run the workflow's OWN restore, build
// and keep commands, read out of the workflow, in the order the job runs them.
// scripts/ci/design-build-cache.sh is written for the GNU coreutils of the
// Linux runners; where they are absent (a developer's macOS) the run cases are
// skipped rather than run against other tools.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "ci", "design-build-cache.sh");
const WORKFLOW = readFileSync(
  path.join(REPO_ROOT, ".github", "workflows", "design-visual-verify.yml"),
  "utf8",
);

/** The pixel-diff job's steps, in file order, as {name, text}. */
function pixelDiffSteps() {
  const from = WORKFLOW.indexOf("\n  pixel-diff:\n");
  const rest = WORKFLOW.slice(from + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  const block = end === -1 ? rest : rest.slice(0, end + 1);
  const steps = [];
  for (const line of block.split("\n")) {
    const head = line.match(/^ {6}- name: (.+)$/);
    if (head) {
      steps.push({ name: head[1].trim(), text: `${line}\n` });
      continue;
    }
    if (steps.length > 0) steps[steps.length - 1].text += `${line}\n`;
  }
  return steps;
}

const STEPS = pixelDiffSteps();
const RESTORE = /^Restore the design build cache/;
const BUILD = /^Build \(standalone production server\)$/;
const KEEP = /^Keep the design build cache/;
const indexOfStep = (matcher) => STEPS.findIndex((s) => matcher.test(s.name));
const stepText = (matcher) => STEPS.find((s) => matcher.test(s.name))?.text ?? "";
const runLine = (matcher) => stepText(matcher).match(/^ {8}run: (.+)$/m)?.[1];
const ifLine = (matcher) => stepText(matcher).match(/^ {8}if: (.+)$/m)?.[1];

describe("design-visual-verify.yml pixel-diff: the runner-local build cache", () => {
  it("restores the cache right before the build and keeps it right after", () => {
    expect(indexOfStep(RESTORE)).toBeGreaterThan(-1);
    expect(indexOfStep(BUILD)).toBe(indexOfStep(RESTORE) + 1);
    expect(indexOfStep(KEEP)).toBe(indexOfStep(BUILD) + 1);
  });

  it("runs on self-hosted runners only, guarded by the runner's own environment", () => {
    const restore = stepText(RESTORE);
    expect(restore).toMatch(/^ {8}id: build-cache$/m);
    expect(ifLine(RESTORE)).toContain("runner.environment == 'self-hosted'");
    expect(restore).not.toContain("vars.");
    expect(runLine(RESTORE)).toBe("bash scripts/ci/design-build-cache.sh restore");
  });

  it("restores the cache only for a pull request that carries the label design-build-cache", () => {
    // Off unless labelled (cinatra#3810). A merge-queue run has no pull
    // request, so it reads as a run without the label and skips the step.
    expect(ifLine(RESTORE)).toBe(
      "${{ runner.environment == 'self-hosted' && contains(github.event.pull_request.labels.*.name, 'design-build-cache') }}",
    );
    // The label's name is written once in the workflow, in that condition.
    expect(WORKFLOW.split("'design-build-cache'")).toHaveLength(2);
    // A skipped restore step answers nothing: the build then gets an empty
    // switch, and the keep step does not run.
    expect(stepText(BUILD)).toMatch(
      /^ {10}CINATRA_TURBOPACK_BUILD_FS_CACHE: \$\{\{ steps\.build-cache\.outputs\.fs-cache \}\}$/m,
    );
    expect(ifLine(KEEP)).toBe("${{ steps.build-cache.outputs.fs-cache == '1' }}");
  });

  it("hands the event and the branch names to the script through env", () => {
    for (const name of [
      "DESIGN_BUILD_CACHE_EVENT",
      "DESIGN_BUILD_CACHE_PR",
      "DESIGN_BUILD_CACHE_HEAD_BRANCH",
      "DESIGN_BUILD_CACHE_BASE_BRANCH",
    ]) {
      expect(stepText(RESTORE)).toMatch(new RegExp(`^ {10}${name}: \\$\\{\\{ .+ \\}\\}$`, "m"));
    }
  });

  it("switches the build cache on from the restore step's answer, and falls back to a full build", () => {
    expect(stepText(BUILD)).toMatch(
      /^ {10}CINATRA_TURBOPACK_BUILD_FS_CACHE: \$\{\{ steps\.build-cache\.outputs\.fs-cache \}\}$/m,
    );
    expect(runLine(BUILD)).toBe('pnpm build || bash scripts/ci/design-build-cache.sh rebuild "$?"');
  });

  it("keeps the cache only after a build that succeeded with it on", () => {
    const keep = stepText(KEEP);
    expect(keep).toMatch(/^ {8}if: \$\{\{ steps\.build-cache\.outputs\.fs-cache == '1' \}\}$/m);
    expect(keep).not.toMatch(/always\(\)|failure\(\)/);
    expect(runLine(KEEP)).toBe("bash scripts/ci/design-build-cache.sh save");
  });

  it("never names the store or the build cache as an upload", () => {
    const uploads = STEPS.filter((s) => s.text.includes("uses: actions/upload-artifact@"));
    expect(uploads.length).toBeGreaterThan(0);
    for (const upload of uploads) {
      const uploaded = upload.text.match(/^ {10}path: (.+)$/m)?.[1] ?? "";
      expect(uploaded).not.toMatch(/design-build-cache|\.next/);
    }
  });

  it("turns the framework's build cache on in next.config.ts for exactly \"1\"", () => {
    const config = readFileSync(path.join(REPO_ROOT, "next.config.ts"), "utf8");
    expect(config).toMatch(
      /\.\.\.\(process\.env\.CINATRA_TURBOPACK_BUILD_FS_CACHE === "1"\s*\?\s*\{ turbopackFileSystemCacheForBuild: true \}\s*:\s*\{\}\)/,
    );
  });
});

const GNU =
  spawnSync("bash", ["-c", "stat -c %Y . && cp --version && mv --version && sha256sum --version"], {
    stdio: "ignore",
  }).status === 0;

// Stand-in for `pnpm build`: records the switch it saw, writes what a build
// with the switch on writes, and exits as the case asks.
const FAKE_PNPM = [
  "#!/usr/bin/env bash",
  'printf \'switch=%s\\n\' "${CINATRA_TURBOPACK_BUILD_FS_CACHE-unset}" >>"$FAKE_PNPM_LOG"',
  "mkdir -p .next/standalone",
  'if [ "${CINATRA_TURBOPACK_BUILD_FS_CACHE:-}" = 1 ] && [ -z "${FAKE_WRITES_NO_CACHE:-}" ]; then',
  "  mkdir -p .next/cache/turbopack/db",
  '  printf \'build %s\\n\' "${FAKE_BUILD_MARK:-0}" >.next/cache/turbopack/db/00000001.sst',
  '  head -c "${FAKE_CACHE_BYTES:-4096}" /dev/zero >.next/cache/turbopack/db/00000002.blob',
  '  if [ -n "${FAKE_INVALIDATE:-}" ]; then touch .next/cache/turbopack/__turbo_tasks_invalidated_db; fi',
  '  exit "${FAKE_EXIT_WITH_CACHE:-0}"',
  "fi",
  'exit "${FAKE_EXIT_WITHOUT_CACHE:-0}"',
  "",
].join("\n");

const KEY = /^[0-9a-f]{16}-[0-9a-f]{16}$/;
const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRunner() {
  const root = mkdtempSync(path.join(tmpdir(), "design-build-cache-"));
  made.push(root);
  const workspace = path.join(root, "runner", "_work", "cinatra");
  const checkout = path.join(workspace, "cinatra");
  const store = path.join(root, "runner", "_work", "_design-build-cache");
  const bin = path.join(root, "bin");
  const log = path.join(root, "pnpm.log");
  mkdirSync(path.join(checkout, "scripts", "ci"), { recursive: true });
  mkdirSync(bin);
  copyFileSync(SCRIPT, path.join(checkout, "scripts", "ci", "design-build-cache.sh"));
  writeFileSync(path.join(checkout, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(checkout, "next.config.ts"), "export default {};\n");
  writeFileSync(path.join(bin, "pnpm"), FAKE_PNPM);
  chmodSync(path.join(bin, "pnpm"), 0o755);
  let jobs = 0;

  /** One pixel-diff job on this runner: restore, build and keep, as the job runs them. */
  function job({ event = "pull_request", pr = "7", head = "feat/x", base = "main", env = {} } = {}) {
    jobs += 1;
    // The checkout's clean: nothing of an earlier job's .next survives it.
    rmSync(path.join(checkout, ".next"), { recursive: true, force: true });
    const temp = path.join(root, `temp-${jobs}`);
    mkdirSync(temp);
    const output = path.join(temp, "output");
    const summary = path.join(temp, "summary");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const jobEnv = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RUNNER_WORKSPACE: workspace,
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      FAKE_PNPM_LOG: log,
      // The disk these cases run on may be fuller than the default floor.
      DESIGN_BUILD_CACHE_MIN_FREE_PERCENT: "0",
      ...env,
    };
    const run = (command, extra) =>
      spawnSync("bash", ["-e", "-c", command], {
        cwd: checkout,
        env: { ...jobEnv, ...extra },
        encoding: "utf8",
      });
    const restore = run(runLine(RESTORE), {
      DESIGN_BUILD_CACHE_EVENT: event,
      DESIGN_BUILD_CACHE_PR: pr,
      DESIGN_BUILD_CACHE_HEAD_BRANCH: head,
      DESIGN_BUILD_CACHE_BASE_BRANCH: base,
    });
    const restored = path.join(checkout, ".next", "cache", "turbopack", "db", "00000001.sst");
    const restoredMark = existsSync(restored) ? readFileSync(restored, "utf8") : null;
    const fsCache = readFileSync(output, "utf8").match(/^fs-cache=(.*)$/m)?.[1];
    const build = run(runLine(BUILD), { CINATRA_TURBOPACK_BUILD_FS_CACHE: fsCache ?? "" });
    const keep = build.status === 0 && fsCache === "1" ? run(runLine(KEEP), {}) : null;
    return { restore, restoredMark, fsCache, build, keep, summary: readFileSync(summary, "utf8") };
  }

  const kept = () => (existsSync(store) ? readdirSync(store).filter((n) => KEY.test(n)).sort() : []);
  const keyOf = (scope) =>
    kept().find((key) => readFileSync(path.join(store, key, "manifest"), "utf8").includes(`scope=${scope}\n`));
  const builds = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line.startsWith("switch="))
          .map((line) => line.slice("switch=".length))
      : [];
  return { store, job, kept, keyOf, builds };
}

describe.skipIf(!GNU)("scripts/ci/design-build-cache.sh, run on a stand-in runner", () => {
  it("keeps a pull request's first build and restores it WARM on its next job", () => {
    const runner = makeRunner();
    const first = runner.job({ env: { FAKE_BUILD_MARK: "first" } });
    expect(first.fsCache).toBe("1");
    expect(first.restore.stdout).toContain("design build cache: COLD: nothing is kept for pull request 7");
    expect(first.build.status).toBe(0);
    expect(first.keep.stdout).toContain("design build cache: KEPT the cache of pull request 7, branch feat/x");
    expect(runner.kept()).toHaveLength(1);

    const second = runner.job({ env: { FAKE_BUILD_MARK: "second" } });
    expect(second.restore.stdout).toContain(
      "design build cache: WARM: restored the cache of pull request 7, branch feat/x",
    );
    expect(second.restoredMark).toBe("build first\n");
    expect(second.summary).toContain("WARM");
    expect(second.keep.stdout).toContain("the WARM build before it took about");
    expect(runner.builds()).toEqual(["1", "1"]);
  });

  it("discards a cache whose content no longer matches its manifest, names it, and builds in full", () => {
    const runner = makeRunner();
    runner.job();
    const [key] = runner.kept();
    appendFileSync(path.join(runner.store, key, "cache", "turbopack", "db", "00000001.sst"), "flipped");
    const next = runner.job();
    expect(next.restore.stdout).toContain(
      `::warning::design build cache: DISCARDED the cache under key ${key}: its content does not match its manifest; this job runs a full build`,
    );
    expect(next.restoredMark).toBeNull();
    expect(next.fsCache).toBe("1");
    expect(next.keep.stdout).toContain("design build cache: KEPT");
  });

  it("discards a save that never finished, and a cache holding a link", () => {
    const runner = makeRunner();
    runner.job();
    const [key] = runner.kept();
    rmSync(path.join(runner.store, key, "manifest"));
    const unfinished = runner.job();
    expect(unfinished.restore.stdout).toContain(
      `DISCARDED the cache under key ${key}: it has no manifest or no cache directory, so its save never finished`,
    );
    expect(unfinished.restoredMark).toBeNull();

    symlinkSync("elsewhere", path.join(runner.store, key, "cache", "link"));
    const linked = runner.job();
    expect(linked.restore.stdout).toContain(
      `DISCARDED the cache under key ${key}: it holds something that is neither a directory nor a plain file`,
    );
    expect(linked.restoredMark).toBeNull();
  });

  it("runs a build that failed with the cache on once more from nothing with it off", () => {
    const runner = makeRunner();
    runner.job();
    const [key] = runner.kept();
    const failing = runner.job({ env: { FAKE_EXIT_WITH_CACHE: "1" } });
    expect(failing.build.status).toBe(0);
    expect(failing.build.stdout).toContain(
      `::warning::design build cache: DISCARDED the cache under key ${key}: the build failed (exit 1) with the cache on`,
    );
    expect(runner.builds()).toEqual(["1", "1", ""]);
    expect(failing.keep.stdout).toContain("NOT KEPT: the build ran again without the cache");
    expect(runner.kept()).toEqual([]);
  });

  it("leaves a build that fails with the cache off its own exit code", () => {
    const runner = makeRunner();
    const off = runner.job({ event: "push", env: { FAKE_EXIT_WITHOUT_CACHE: "3" } });
    expect(off.fsCache).toBe("");
    expect(off.restore.stdout).toContain("design build cache: OFF: a run of the 'push' event keeps no build cache");
    expect(off.build.status).toBe(3);
    expect(runner.builds()).toEqual([""]);
  });

  it("turns the cache off, and says why, on a runner that names no work root", () => {
    const runner = makeRunner();
    const off = runner.job({ env: { RUNNER_WORKSPACE: "" } });
    expect(off.fsCache).toBe("");
    expect(off.restore.stdout).toContain(
      "design build cache: OFF: the runner names no writable work root outside the checkout",
    );
    expect(off.build.status).toBe(0);
    expect(runner.builds()).toEqual([""]);
  });

  it("seeds a pull request from the base branch's cache, which only the merge queue writes", () => {
    const runner = makeRunner();
    const queue = runner.job({ event: "merge_group", pr: "", head: "", base: "refs/heads/main" });
    expect(queue.keep.stdout).toContain("design build cache: KEPT the cache of branch main");
    const baseKey = runner.keyOf("branch main");
    const manifest = readFileSync(path.join(runner.store, baseKey, "manifest"), "utf8");

    // A head branch named like the base branch still keeps its own scope.
    const pr = runner.job({ pr: "8", head: "main" });
    expect(pr.restore.stdout).toContain("design build cache: WARM: restored the cache of branch main");
    expect(pr.keep.stdout).toContain("KEPT the cache of pull request 8, branch main");
    expect(runner.kept()).toHaveLength(2);
    expect(readFileSync(path.join(runner.store, baseKey, "manifest"), "utf8")).toBe(manifest);
  });

  it("prunes the store oldest first down to its size", () => {
    const runner = makeRunner();
    const env = { DESIGN_BUILD_CACHE_MAX_MIB: "1", FAKE_CACHE_BYTES: String(400 * 1024) };
    runner.job({ pr: "11", head: "a", env });
    runner.job({ pr: "12", head: "b", env });
    const now = Date.now() / 1000;
    const age = (scope, hours) => {
      const manifest = path.join(runner.store, runner.keyOf(scope), "manifest");
      utimesSync(manifest, now - hours * 3600, now - hours * 3600);
    };
    age("pull request 11, branch a", 3);
    age("pull request 12, branch b", 2);
    const third = runner.job({ pr: "13", head: "c", env });
    expect(third.keep.stdout).toMatch(/PRUNED the cache under key [0-9a-f-]+ \(1 MiB, last used 3 h ago\)/);
    expect(runner.keyOf("pull request 11, branch a")).toBeUndefined();
    expect(runner.keyOf("pull request 12, branch b")).toBeDefined();
    expect(runner.keyOf("pull request 13, branch c")).toBeDefined();
  });

  it("never keeps a cache Turbopack marked invalid, nor one the build did not write", () => {
    const runner = makeRunner();
    const marked = runner.job({ env: { FAKE_INVALIDATE: "1" } });
    expect(marked.keep.stdout).toContain("NOT KEPT: Turbopack marked its own cache invalid during this build");
    expect(runner.kept()).toEqual([]);

    const unwritten = runner.job({ env: { FAKE_WRITES_NO_CACHE: "1" } });
    expect(unwritten.keep.stdout).toContain(
      "::warning::design build cache: NOT KEPT: the build left no Turbopack cache under .next/cache",
    );
    expect(runner.kept()).toEqual([]);
  });
});
