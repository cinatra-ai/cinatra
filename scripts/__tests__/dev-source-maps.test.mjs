// cinatra#3758 — the source-map switch of the development server launcher.
//
// Three layers, in the order a regression would reach them:
//
//   1. UNIT — the pure decision in scripts/lib/dev-source-maps.mjs: which values
//      are accepted, where the value is read from, and the arguments `next`
//      gets.
//   2. THE LAUNCHER, RUN FOR REAL — scripts/dev-server.mjs copied into a temp
//      tree with the libraries it imports (it resolves `.env.local` and `next`
//      from its own location and the launch directory, so the copy is what
//      makes the fixture hermetic; what runs is the shipped file, byte for
//      byte). `next` is a stub that prints the arguments and the NODE_OPTIONS it
//      was handed, and the Docker preflight is skipped, with a `docker` on PATH
//      that fails every call, so nothing is ever started. The unset case pins
//      both byte for byte: `dev` and nothing else, and the `dev` script's own
//      NODE_OPTIONS, unchanged.
//   3. THE FRAMEWORK CONTRACT the switch relies on — `next dev` adds
//      `--enable-source-maps` to its server process unless it is given
//      `--disable-source-maps`, and then leaves out that option alone. Read
//      from the installed framework, so a framework upgrade that changes it
//      fails here instead of silently turning the switch into a no-op.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEV_SOURCE_MAPS_ENV_VAR,
  DEV_SOURCE_MAPS_OFF,
  DISABLE_SOURCE_MAPS_FLAG,
  resolveDevSourceMaps,
  resolveNextDevArgs,
  statedDevSourceMaps,
} from "../lib/dev-source-maps.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Values the switch refuses: anything but unset, empty or `0`. */
const REFUSED = ["1", "true", "false", "off", "no", "yes", "00", "-1", "0.5", "disable"];

// ---------------------------------------------------------------------------
// 1. Pure decision
// ---------------------------------------------------------------------------

describe("resolveDevSourceMaps", () => {
  it("keeps source maps when nothing states the variable, or states it blank", () => {
    expect(resolveDevSourceMaps()).toEqual({ sourceMaps: true });
    expect(resolveDevSourceMaps({ processEnv: {}, envFileValues: [undefined, undefined] })).toEqual({
      sourceMaps: true,
    });
    for (const blank of ["", "   "]) {
      expect(
        resolveDevSourceMaps({ processEnv: { [DEV_SOURCE_MAPS_ENV_VAR]: blank }, envFileValues: [blank] }),
      ).toEqual({ sourceMaps: true });
    }
  });

  it("leaves them out on 0, from the shell or from .env.local", () => {
    expect(DEV_SOURCE_MAPS_OFF).toBe("0");
    expect(resolveDevSourceMaps({ processEnv: { [DEV_SOURCE_MAPS_ENV_VAR]: "0" } })).toEqual({
      sourceMaps: false,
    });
    expect(resolveDevSourceMaps({ processEnv: { [DEV_SOURCE_MAPS_ENV_VAR]: " 0 " } })).toEqual({
      sourceMaps: false,
    });
    expect(resolveDevSourceMaps({ processEnv: {}, envFileValues: [undefined, "0"] })).toEqual({
      sourceMaps: false,
    });
  });

  it("reads the shell first, then the first .env.local that states a value", () => {
    expect(
      statedDevSourceMaps({ processEnv: { [DEV_SOURCE_MAPS_ENV_VAR]: "0" }, envFileValues: ["yes"] }),
    ).toBe("0");
    expect(
      statedDevSourceMaps({ processEnv: { [DEV_SOURCE_MAPS_ENV_VAR]: "" }, envFileValues: ["", "0", "yes"] }),
    ).toBe("0");
    expect(statedDevSourceMaps({ processEnv: {}, envFileValues: [] })).toBeUndefined();
  });

  it("refuses every other value by the variable's name, with the accepted form", () => {
    for (const value of REFUSED) {
      expect(() => resolveDevSourceMaps({ processEnv: { [DEV_SOURCE_MAPS_ENV_VAR]: value } })).toThrow(
        `${DEV_SOURCE_MAPS_ENV_VAR}="${value}" is not an accepted value. Set it to 0 to start the development server without source maps, or leave it unset to keep them.`,
      );
    }
    // A refused value in .env.local refuses just the same.
    expect(() => resolveDevSourceMaps({ processEnv: {}, envFileValues: ["false"] })).toThrow(
      DEV_SOURCE_MAPS_ENV_VAR,
    );
  });
});

describe("resolveNextDevArgs", () => {
  it("hands next exactly `dev` and the forwarded arguments while source maps are kept", () => {
    expect(resolveNextDevArgs()).toEqual(["dev"]);
    expect(resolveNextDevArgs({ forwardedArgs: [], sourceMaps: true })).toEqual(["dev"]);
    expect(resolveNextDevArgs({ forwardedArgs: ["--turbopack"], sourceMaps: true })).toEqual([
      "dev",
      "--turbopack",
    ]);
  });

  it("adds --disable-source-maps once when they are off", () => {
    expect(DISABLE_SOURCE_MAPS_FLAG).toBe("--disable-source-maps");
    expect(resolveNextDevArgs({ forwardedArgs: [], sourceMaps: false })).toEqual([
      "dev",
      "--disable-source-maps",
    ]);
    expect(resolveNextDevArgs({ forwardedArgs: ["--webpack"], sourceMaps: false })).toEqual([
      "dev",
      "--webpack",
      "--disable-source-maps",
    ]);
    expect(
      resolveNextDevArgs({ forwardedArgs: ["--disable-source-maps"], sourceMaps: false }),
    ).toEqual(["dev", "--disable-source-maps"]);
  });
});

// ---------------------------------------------------------------------------
// 2. The launcher, run for real
// ---------------------------------------------------------------------------

/** The NODE_OPTIONS the `dev` package script sets, read from package.json itself. */
function devScriptNodeOptions() {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const match = /^NODE_OPTIONS='([^']*)' node scripts\/dev-server\.mjs$/.exec(pkg.scripts.dev);
  expect(match, `unexpected "dev" script: ${pkg.scripts.dev}`).not.toBeNull();
  return match[1];
}

describe("dev-server.mjs, run for real with a stub next", () => {
  let dir;
  let launcher;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cinatra-3758-dev-"));
    const scriptsDir = path.join(dir, "scripts");
    mkdirSync(path.join(scriptsDir, "lib"), { recursive: true });
    launcher = path.join(scriptsDir, "dev-server.mjs");
    copyFileSync(path.join(REPO_ROOT, "scripts", "dev-server.mjs"), launcher);
    // Every library the launcher could import, so a new import does not break the fixture.
    for (const file of readdirSync(path.join(REPO_ROOT, "scripts", "lib"))) {
      if (file.endsWith(".mjs")) {
        copyFileSync(path.join(REPO_ROOT, "scripts", "lib", file), path.join(scriptsDir, "lib", file));
      }
    }

    // A `docker` first on PATH that fails every call: nothing can be started even in principle.
    const bin = path.join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nexit 1\n");
    chmodSync(path.join(bin, "docker"), 0o755);

    // The stub `next`: report what it was handed, then exit cleanly.
    const nextBin = path.join(dir, "node_modules", ".bin");
    mkdirSync(nextBin, { recursive: true });
    writeFileSync(
      path.join(nextBin, "next"),
      [
        "#!/usr/bin/env node",
        "console.log('STUB_ARGV=' + JSON.stringify(process.argv.slice(2)));",
        "console.log('STUB_NODE_OPTIONS=' + JSON.stringify(process.env.NODE_OPTIONS ?? null));",
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    chmodSync(path.join(nextBin, "next"), 0o755);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = ({ envLocal = "", env = {}, args = [] } = {}) => {
    writeFileSync(path.join(dir, ".env.local"), envLocal);
    const childEnv = {
      ...process.env,
      PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
      NODE_OPTIONS: devScriptNodeOptions(),
      CINATRA_SKIP_DEV_PREFLIGHT: "1",
    };
    // Whatever the ambient shell carries, each case states its own inputs.
    delete childEnv[DEV_SOURCE_MAPS_ENV_VAR];
    delete childEnv.PORT;
    delete childEnv.COMPOSE_PROJECT_NAME;
    Object.assign(childEnv, env);
    const result = spawnSync(process.execPath, [launcher, ...args], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: childEnv,
    });
    const argvLine = /^STUB_ARGV=(.*)$/m.exec(result.stdout);
    const nodeOptionsLine = /^STUB_NODE_OPTIONS=(.*)$/m.exec(result.stdout);
    return {
      ...result,
      nextArgv: argvLine ? JSON.parse(argvLine[1]) : null,
      nextNodeOptions: nodeOptionsLine ? JSON.parse(nodeOptionsLine[1]) : null,
    };
  };

  const expectCleanRun = (result) => {
    expect(
      result.status,
      `launcher exited ${result.status} (signal ${result.signal})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
  };

  it("unset: hands next exactly `dev` and the dev script's NODE_OPTIONS, byte for byte", () => {
    const result = run();
    expectCleanRun(result);
    expect(result.nextArgv).toEqual(["dev"]);
    expect(result.nextNodeOptions).toBe(devScriptNodeOptions());
    expect(result.stdout).not.toContain(DEV_SOURCE_MAPS_ENV_VAR);
  });

  it("empty: the same as unset", () => {
    const result = run({ env: { [DEV_SOURCE_MAPS_ENV_VAR]: "" }, envLocal: `${DEV_SOURCE_MAPS_ENV_VAR}=\n` });
    expectCleanRun(result);
    expect(result.nextArgv).toEqual(["dev"]);
    expect(result.nextNodeOptions).toBe(devScriptNodeOptions());
  });

  it("0 in the shell: adds only --disable-source-maps and leaves NODE_OPTIONS untouched", () => {
    const result = run({ env: { [DEV_SOURCE_MAPS_ENV_VAR]: "0" } });
    expectCleanRun(result);
    expect(result.nextArgv).toEqual(["dev", "--disable-source-maps"]);
    expect(result.nextNodeOptions).toBe(devScriptNodeOptions());
    expect(result.stdout).toContain(
      "[dev-server] CINATRA_DEV_SOURCE_MAPS=0 — starting the server process without source maps (--disable-source-maps).",
    );
  });

  it("0 in .env.local: the same, after the forwarded arguments", () => {
    const result = run({ envLocal: `${DEV_SOURCE_MAPS_ENV_VAR}=0\n`, args: ["--turbopack"] });
    expectCleanRun(result);
    expect(result.nextArgv).toEqual(["dev", "--turbopack", "--disable-source-maps"]);
    expect(result.nextNodeOptions).toBe(devScriptNodeOptions());
  });

  it("refuses any other value by name before it starts anything", () => {
    for (const [value, where] of [
      ["1", "shell"],
      ["false", ".env.local"],
    ]) {
      const result =
        where === "shell"
          ? run({ env: { [DEV_SOURCE_MAPS_ENV_VAR]: value } })
          : run({ envLocal: `${DEV_SOURCE_MAPS_ENV_VAR}=${value}\n` });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `[dev-server] ✖ ${DEV_SOURCE_MAPS_ENV_VAR}="${value}" is not an accepted value. Set it to 0`,
      );
      // `next` never ran, and the launcher never got as far as recording a server.
      expect(result.nextArgv).toBeNull();
      expect(existsSync(path.join(dir, ".next", "dev-server.json"))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The framework contract
// ---------------------------------------------------------------------------

describe("the installed framework honours --disable-source-maps", () => {
  const require = createRequire(import.meta.url);
  const nextDevSource = readFileSync(require.resolve("next/dist/cli/next-dev.js"), "utf8");
  const nextBinSource = readFileSync(require.resolve("next/dist/bin/next"), "utf8");

  it("declares the flag on `next dev`", () => {
    expect(nextBinSource).toContain("'--disable-source-maps'");
  });

  it("leaves --enable-source-maps out of the server's options when given it, and adds it otherwise", () => {
    expect(nextDevSource).toMatch(
      /if \(options\.disableSourceMaps\) \{\s*delete nodeOptions\['enable-source-maps'\];\s*\} else \{\s*nodeOptions\['enable-source-maps'\] = true;\s*\}/,
    );
  });
});
