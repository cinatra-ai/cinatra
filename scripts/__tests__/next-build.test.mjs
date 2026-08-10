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
  buildKnobSummary,
  readKnob,
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
