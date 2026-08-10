// cinatra#2607 — the production-build launcher's env seam.
//
// The launcher owns exactly one knob (the bundler, which is an ARGV flag Next
// resolves before next.config.ts is read) and reports the other. The contract
// these tests pin is the one the acceptance criteria turn on: with every knob
// unset the argv handed to Next is exactly `build` — the command the package
// script ran before this file existed — and nothing extra is printed.

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACCEPTED_BUNDLERS,
  MINIMUM_BUILDER_MEMORY_BYTES,
  MINIMUM_BUILDER_MEMORY_GIB,
  buildKnobSummary,
  builderMemoryWarning,
  formatGiB,
  readCgroupMemoryLimit,
  readKnob,
  resolveBuilderMemory,
  resolveBundlerFlags,
  resolveNextArgs,
} from "../next-build.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("readKnob", () => {
  it("treats an absent variable and a docker-style empty ARG identically", () => {
    expect(readKnob({}, "CINATRA_BUILD_BUNDLER")).toBe("");
    // `ARG CINATRA_BUILD_BUNDLER=` forwards an empty string, not an absent var.
    expect(readKnob({ CINATRA_BUILD_BUNDLER: "" }, "CINATRA_BUILD_BUNDLER")).toBe("");
    expect(readKnob({ CINATRA_BUILD_BUNDLER: "   " }, "CINATRA_BUILD_BUNDLER")).toBe("");
  });

  it("trims a value the operator padded", () => {
    expect(readKnob({ CINATRA_BUILD_CPUS: " 2 " }, "CINATRA_BUILD_CPUS")).toBe("2");
  });
});

describe("resolveBundlerFlags", () => {
  it("passes NO flag when the knob is unset — unset means today's build", () => {
    expect(resolveBundlerFlags({})).toEqual({ flags: [], bundler: "" });
    expect(resolveBundlerFlags({ CINATRA_BUILD_BUNDLER: "" })).toEqual({ flags: [], bundler: "" });
  });

  it("selects the webpack fallback", () => {
    expect(resolveBundlerFlags({ CINATRA_BUILD_BUNDLER: "webpack" })).toEqual({
      flags: ["--webpack"],
      bundler: "webpack",
    });
  });

  it("lets an operator pin the default bundler explicitly", () => {
    expect(resolveBundlerFlags({ CINATRA_BUILD_BUNDLER: "turbopack" })).toEqual({
      flags: ["--turbopack"],
      bundler: "turbopack",
    });
  });

  it("accepts the documented values case-insensitively", () => {
    for (const value of ACCEPTED_BUNDLERS) {
      expect(resolveBundlerFlags({ CINATRA_BUILD_BUNDLER: value.toUpperCase() }).bundler).toBe(value);
    }
  });

  it("fails closed on an unrecognised value instead of silently using the default", () => {
    expect(() => resolveBundlerFlags({ CINATRA_BUILD_BUNDLER: "rspack" })).toThrow(
      /not a recognised bundler/,
    );
    expect(() => resolveBundlerFlags({ CINATRA_BUILD_BUNDLER: "web pack" })).toThrow(
      /CINATRA_BUILD_BUNDLER="web pack"/,
    );
  });
});

describe("resolveNextArgs", () => {
  it("is exactly `build` when nothing is set — the pre-#2607 command", () => {
    expect(resolveNextArgs({}, [])).toEqual(["build"]);
  });

  it("puts the bundler flag before operator-forwarded arguments", () => {
    expect(resolveNextArgs({ CINATRA_BUILD_BUNDLER: "webpack" }, ["--debug"])).toEqual([
      "build",
      "--webpack",
      "--debug",
    ]);
  });

  it("forwards extra arguments untouched when no knob is set", () => {
    expect(resolveNextArgs({}, ["--experimental-build-mode", "compile"])).toEqual([
      "build",
      "--experimental-build-mode",
      "compile",
    ]);
  });
});

describe("buildKnobSummary", () => {
  it("prints nothing at all when every knob is unset", () => {
    expect(buildKnobSummary({})).toBeNull();
    // NODE_OPTIONS alone is cinatra#2606's knob and is not ours to announce.
    expect(buildKnobSummary({ NODE_OPTIONS: "--max-old-space-size=4096" })).toBeNull();
  });

  it("names every knob the operator moved, plus the heap ceiling for context", () => {
    const summary = buildKnobSummary({
      CINATRA_BUILD_BUNDLER: "webpack",
      CINATRA_BUILD_CPUS: "2",
      NODE_OPTIONS: "--max-old-space-size=2048",
    });
    expect(summary).toContain("bundler=webpack");
    expect(summary).toContain("cpus=2");
    expect(summary).toContain("NODE_OPTIONS=--max-old-space-size=2048");
  });

  it("reports a knob it does not itself own (the config consumes it)", () => {
    expect(buildKnobSummary({ CINATRA_BUILD_CPUS: "1" })).toContain("cpus=1");
  });
});

describe("the checkout wiring the knobs depend on", () => {
  it("routes `pnpm build` through the launcher", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts.build).toBe("node scripts/next-build.mjs");
  });

  it("declares every knob as a Dockerfile ARG — an undeclared build-arg is silently dropped", () => {
    const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    for (const knob of ["CINATRA_BUILD_BUNDLER", "CINATRA_BUILD_CPUS"]) {
      expect(dockerfile).toMatch(new RegExp(`^ARG ${knob}=\\s*$`, "m"));
      // ...and forwards it to the build, not merely declares it.
      expect(dockerfile).toContain(`${knob}="$${knob}"`);
    }
  });

  it("keeps every Dockerfile knob defaulted to empty so a bare `docker build` is unchanged", () => {
    const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    const declarations = dockerfile.match(/^ARG CINATRA_BUILD_[A-Z_]+=.*$/gm) ?? [];
    expect(declarations.length).toBe(2);
    for (const line of declarations) expect(line).toMatch(/=$/);
  });

  it("gates the next.config knob on a set value — spread, never a default", () => {
    const config = readFileSync(path.join(repoRoot, "next.config.ts"), "utf8");
    expect(config).toContain("CINATRA_BUILD_CPUS");
    expect(config).toMatch(/\.\.\.\(buildCpus !== undefined \? \{ cpus: buildCpus \} : \{\}\)/);
  });

  it("does NOT wire experimental.turbopackMemoryLimit — measured inert on 16.2.10", () => {
    // Four builds on the constrained profile (limit unset / 512 MB / 2048 MB,
    // and 2048 MB with turbopackFileSystemCacheForBuild) all peaked within 1%
    // of each other and all died the same way. A knob that changes nothing is
    // worse than no knob: it sends an operator down a dead end. If a later Next
    // makes it bind, wire it back WITH a fresh measurement — not on faith.
    const config = readFileSync(path.join(repoRoot, "next.config.ts"), "utf8");
    expect(config).not.toMatch(/^\s*turbopackMemoryLimit:/m);
  });
});

// ---------------------------------------------------------------------------
// The builder-memory preflight (cinatra#2633).
//
// The floor is a MEASURED number — cold builds reaped at 9 GiB and 12 GiB caps,
// and one completing at a 16 GiB cap — so these tests pin the two things a unit
// test can actually protect: that the preflight reads the number the build
// really has (the cgroup limit governing this process, not the host's memory),
// and that the floor cannot drift apart across the three files that state it.
// ---------------------------------------------------------------------------

describe("readCgroupMemoryLimit", () => {
  const reader = (files) => (file) => {
    if (!(file in files)) {
      const error = new Error(`ENOENT: no such file or directory, open '${file}'`);
      error.code = "ENOENT";
      throw error;
    }
    return files[file];
  };

  it("reads a cgroup v2 cap", () => {
    expect(readCgroupMemoryLimit(reader({ "/sys/fs/cgroup/memory.max": "12884901888\n" }))).toBe(
      12884901888,
    );
  });

  it("treats cgroup v2 `max` as uncapped, not as a number", () => {
    expect(readCgroupMemoryLimit(reader({ "/sys/fs/cgroup/memory.max": "max\n" }))).toBeNull();
  });

  it("falls back to cgroup v1", () => {
    expect(
      readCgroupMemoryLimit(
        reader({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9663676416" }),
      ),
    ).toBe(9663676416);
  });

  it("treats cgroup v1's page-counter sentinel as uncapped", () => {
    // An uncapped v1 cgroup reports ~9.2e18. Reading that as a real limit would
    // silently disable the preflight on every v1 host.
    expect(
      readCgroupMemoryLimit(
        reader({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712" }),
      ),
    ).toBeNull();
  });

  it("is null off Linux, where neither file exists", () => {
    expect(readCgroupMemoryLimit(reader({}))).toBeNull();
  });

  it("is null on unparseable content rather than throwing into the build", () => {
    expect(readCgroupMemoryLimit(reader({ "/sys/fs/cgroup/memory.max": "not-a-number" }))).toBeNull();
  });

  it("follows the process's own cgroup path, not just the cgroupfs root", () => {
    // A nested runner (no private cgroup namespace) sees an uncapped root and
    // the real cap further down. Reading only the root would report "uncapped".
    const limit = readCgroupMemoryLimit(
      reader({
        "/proc/self/cgroup": "0::/system.slice/runner.scope\n",
        "/sys/fs/cgroup/memory.max": "max\n",
        "/sys/fs/cgroup/system.slice/memory.max": "max\n",
        "/sys/fs/cgroup/system.slice/runner.scope/memory.max": "17179869184\n",
      }),
    );
    expect(limit).toBe(17179869184);
  });

  it("keeps the TIGHTEST limit on the chain — an ancestor can bind harder", () => {
    const limit = readCgroupMemoryLimit(
      reader({
        "/proc/self/cgroup": "0::/outer/inner\n",
        "/sys/fs/cgroup/memory.max": "max\n",
        "/sys/fs/cgroup/outer/memory.max": "8589934592\n",
        "/sys/fs/cgroup/outer/inner/memory.max": "17179869184\n",
      }),
    );
    expect(limit).toBe(8589934592);
  });

  it("does not fall through to cgroup v1 when a v2 hierarchy is readable", () => {
    // The v1 file below governs nothing on a v2 host; treating it as the answer
    // would report a cap this process is not actually subject to.
    const limit = readCgroupMemoryLimit(
      reader({
        "/proc/self/cgroup": "0::/\n",
        "/sys/fs/cgroup/memory.max": "max\n",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": "2147483648",
      }),
    );
    expect(limit).toBeNull();
  });

  it("resolves the cgroup v1 memory controller's own path", () => {
    const limit = readCgroupMemoryLimit(
      reader({
        "/proc/self/cgroup": "3:cpu,cpuacct:/x\n2:memory:/docker/abc\n",
        "/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes": "4294967296",
      }),
    );
    expect(limit).toBe(4294967296);
  });
});

describe("resolveBuilderMemory", () => {
  const gib = (n) => n * 1024 ** 3;

  it("prefers the container cap over the host's memory — the whole point", () => {
    // os.totalmem() calls sysinfo(2), which is not cgroup-aware: inside a
    // container it reports the HOST. Reporting that would flatter every
    // containerised build, which is all of them.
    const memory = resolveBuilderMemory({
      totalMemoryBytes: gib(64),
      cgroupLimitBytes: gib(6),
    });
    expect(memory).toEqual({ bytes: gib(6), source: "container memory limit" });
  });

  it("uses total system memory when the build is uncapped", () => {
    const memory = resolveBuilderMemory({ totalMemoryBytes: gib(8), cgroupLimitBytes: null });
    expect(memory).toEqual({ bytes: gib(8), source: "total system memory" });
  });

  it("keeps the smaller of the two when a cap exceeds the machine", () => {
    const memory = resolveBuilderMemory({ totalMemoryBytes: gib(8), cgroupLimitBytes: gib(32) });
    expect(memory.bytes).toBe(gib(8));
  });

  it("is null when neither number is knowable", () => {
    expect(resolveBuilderMemory({})).toBeNull();
    expect(resolveBuilderMemory({ totalMemoryBytes: 0, cgroupLimitBytes: -1 })).toBeNull();
  });
});

describe("builderMemoryWarning", () => {
  const gib = (n) => n * 1024 ** 3;

  it("says nothing at or above the floor — a big enough builder's log is untouched", () => {
    expect(builderMemoryWarning({ bytes: MINIMUM_BUILDER_MEMORY_BYTES, source: "x" })).toBeNull();
    expect(builderMemoryWarning({ bytes: gib(64), source: "x" })).toBeNull();
    expect(builderMemoryWarning(null)).toBeNull();
  });

  it("names what the build has, where that came from, and the floor", () => {
    const warning = builderMemoryWarning({ bytes: gib(6), source: "container memory limit" });
    expect(warning).toContain("6.0 GiB");
    expect(warning).toContain("container memory limit");
    expect(warning).toContain(`${MINIMUM_BUILDER_MEMORY_GIB}.0 GiB`);
  });

  it("points at the evidence and says it is not a gate", () => {
    const warning = builderMemoryWarning({ bytes: gib(6), source: "total system memory" });
    expect(warning).toContain("docs/internals/workflows/constrained-host-builds.md");
    expect(warning).toContain("WARNING");
    expect(warning).toContain("not a gate");
    // exit 137 is what an operator actually sees; naming it is the whole value.
    expect(warning).toContain("137");
  });
});

describe("formatGiB", () => {
  it("states bytes in the unit the floor is stated in", () => {
    expect(formatGiB(12 * 1024 ** 3)).toBe("12.0 GiB");
    expect(formatGiB(5922 * 1024 ** 2)).toBe("5.8 GiB");
  });
});

describe("the floor, stated in three places", () => {
  // The number lives in the launcher; the Dockerfile and the doc restate it in
  // prose for readers who never open the launcher. Nothing but this test stops
  // one of the three from drifting.
  it("is the same number in the Dockerfile build stage", () => {
    const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(`MINIMUM BUILDER MEMORY: ${MINIMUM_BUILDER_MEMORY_GIB} GiB`);
  });

  it("is the same number in the constrained-host-builds doc", () => {
    const doc = readFileSync(
      path.join(repoRoot, "docs", "internals", "workflows", "constrained-host-builds.md"),
      "utf8",
    );
    expect(doc).toContain(`## Minimum builder memory: ${MINIMUM_BUILDER_MEMORY_GIB} GiB`);
  });
});

// ---------------------------------------------------------------------------
// The launcher, actually launched.
//
// Everything above is pure. These run `scripts/next-build.mjs` for real, in a
// throwaway project whose `next` is a stub that reports the argv it was handed
// and then exits (or kills itself) on command. That covers the parts a pure
// test cannot see: binary resolution, argv forwarding, exit-code propagation,
// and — the one that matters most on a host that reaps builds — that a
// SIGNALLED child still reads as signalled to whatever ran `pnpm build`.
// ---------------------------------------------------------------------------

const launcher = path.join(repoRoot, "scripts", "next-build.mjs");
const sandboxes = [];

/** A throwaway project whose only dependency is a stub `next`. */
function makeProjectWithStubNext() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cinatra-next-build-"));
  sandboxes.push(dir);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "stub-host" }));
  const nextDir = path.join(dir, "node_modules", "next");
  mkdirSync(nextDir, { recursive: true });
  // No `exports` map, so classic resolution finds ./package.json and the bin.
  writeFileSync(
    path.join(nextDir, "package.json"),
    JSON.stringify({ name: "next", version: "0.0.0-stub", bin: { next: "./stub.js" } }),
  );
  writeFileSync(
    path.join(nextDir, "stub.js"),
    [
      "const argv = process.argv.slice(2);",
      "console.log('STUB_ARGV=' + JSON.stringify(argv));",
      "if (process.env.STUB_SUICIDE_SIGNAL) {",
      "  process.kill(process.pid, process.env.STUB_SUICIDE_SIGNAL);",
      "  setTimeout(() => {}, 1000);",
      "} else {",
      "  process.exit(Number(process.env.STUB_EXIT_CODE ?? 0));",
      "}",
      "",
    ].join("\n"),
  );
  return dir;
}

function runLauncher(env = {}, args = []) {
  const cwd = makeProjectWithStubNext();
  return spawnSync(process.execPath, [launcher, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

describe("the launcher, run for real", () => {
  it("hands Next exactly `build` when nothing is set, and succeeds", () => {
    const result = runLauncher();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('STUB_ARGV=["build"]');
    // Nothing extra on an untouched build.
    expect(result.stdout).not.toContain("constrained-build knobs");
  });

  it("hands Next the bundler flag and forwarded arguments in order", () => {
    const result = runLauncher({ CINATRA_BUILD_BUNDLER: "webpack" }, ["--debug"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('STUB_ARGV=["build","--webpack","--debug"]');
    expect(result.stdout).toContain("bundler=webpack");
  });

  it("propagates the build's exit code", () => {
    const result = runLauncher({ STUB_EXIT_CODE: "3" });
    expect(result.status).toBe(3);
  });

  it("dies of the SAME signal the build died of — a reaped build is not exit 1", () => {
    const result = runLauncher({ STUB_SUICIDE_SIGNAL: "SIGTERM" });
    expect(result.signal).toBe("SIGTERM");
    expect(result.status).toBeNull();
  });

  it("refuses an unrecognised bundler before launching anything", () => {
    const result = runLauncher({ CINATRA_BUILD_BUNDLER: "rspack" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a recognised bundler");
    expect(result.stdout).not.toContain("STUB_ARGV");
  });

  it("says where it looked when `next` cannot be resolved", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "cinatra-next-build-empty-"));
    sandboxes.push(cwd);
    writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "no-next" }));
    const result = spawnSync(process.execPath, [launcher], { cwd, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not resolve the `next` binary");
  });
});
