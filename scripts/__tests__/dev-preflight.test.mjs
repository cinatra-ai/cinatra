// Dev-server preflight policy + guard tests (cinatra#2839).
//
// Two layers, because the bug had two layers:
//
//   1. UNIT — the pure decisions in scripts/lib/dev-preflight.mjs: where the
//      skip flag is read from and which compose project the preflight may act
//      on. Dependency-injected; no Docker.
//
//   2. GUARD — scripts/dev-server.mjs driven end to end as a subprocess with a
//      FAKE `docker` first on PATH (a recorder that logs its argv + the compose
//      interpolation env and exits non-zero) and a stub `next` binary. Nothing
//      containerized is ever started: the assertion is precisely that the real
//      launcher makes ZERO docker calls behind the flag, and correctly-scoped
//      ones without it. This is the "a test or guard proves the flag's promise"
//      the issue asks for — a unit test of the policy alone would not have
//      caught the original defect, which was the launcher reading the flag from
//      the wrong place.
//
// Auto-discovered by the root vitest suite via the `scripts/__tests__/**`
// include glob (same as scripts/__tests__/nango-health.test.mjs, which covers
// the sibling scripts/lib/nango-health.mjs).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import net from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPOSE_FILES,
  buildComposeArgs,
  createComposeRunner,
  formatComposeCommand,
  normalizeSkipFlag,
  readEnvFileValue,
  resolveComposeProjectName,
  shouldSkipDevPreflight,
} from "../lib/dev-preflight.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const DEV_SERVER = path.join(REPO_ROOT, "scripts", "dev-server.mjs");

// ---------------------------------------------------------------------------
// 1. Pure policy
// ---------------------------------------------------------------------------

describe("normalizeSkipFlag", () => {
  it("recognizes the documented value and the usual truthy spellings", () => {
    for (const raw of ["1", "true", "TRUE", " yes ", "on"]) {
      expect(normalizeSkipFlag(raw)).toBe(true);
    }
  });

  it("recognizes explicit falsy values as a real 'do not skip' statement", () => {
    for (const raw of ["0", "false", "no", "off"]) {
      expect(normalizeSkipFlag(raw)).toBe(false);
    }
  });

  it("reports absent/empty/unrecognized as 'not stated' so callers can fall through", () => {
    for (const raw of [undefined, null, "", "   ", "maybe"]) {
      expect(normalizeSkipFlag(raw)).toBeUndefined();
    }
  });
});

describe("shouldSkipDevPreflight", () => {
  it("honors the flag from the shell environment", () => {
    expect(
      shouldSkipDevPreflight({ processEnv: { CINATRA_SKIP_DEV_PREFLIGHT: "1" } }),
    ).toBe(true);
  });

  // The cinatra#2839 defect: a worktree lane records its configuration in
  // .env.local — the same file the launcher already reads PORT from — and the
  // flag was honored from the process env ONLY, so the lane got a full
  // preflight (and its containers) behind a flag that promises none.
  it("honors the flag from .env.local, where a worktree lane states it", () => {
    expect(
      shouldSkipDevPreflight({ processEnv: {}, envFileValues: ["1"] }),
    ).toBe(true);
  });

  it("takes the first stated .env.local value across the files it consults", () => {
    expect(
      shouldSkipDevPreflight({ processEnv: {}, envFileValues: [undefined, "true"] }),
    ).toBe(true);
  });

  it("lets an explicit shell value override a .env.local opt-out for one run", () => {
    expect(
      shouldSkipDevPreflight({
        processEnv: { CINATRA_SKIP_DEV_PREFLIGHT: "0" },
        envFileValues: ["1"],
      }),
    ).toBe(false);
  });

  it("defaults to running the preflight when nothing states otherwise", () => {
    expect(shouldSkipDevPreflight()).toBe(false);
    expect(
      shouldSkipDevPreflight({ processEnv: {}, envFileValues: [undefined, ""] }),
    ).toBe(false);
  });
});

describe("resolveComposeProjectName", () => {
  it("prefers the shell COMPOSE_PROJECT_NAME", () => {
    expect(
      resolveComposeProjectName({
        processEnv: { COMPOSE_PROJECT_NAME: "p2839" },
        envFileValues: ["from-file"],
      }),
    ).toBe("p2839");
  });

  // Docker reads COMPOSE_PROJECT_NAME from its own process env but NOT from
  // .env.local, which is exactly where a lane names its project.
  it("falls back to the value a worktree recorded in .env.local", () => {
    expect(
      resolveComposeProjectName({ processEnv: {}, envFileValues: ["p2839"] }),
    ).toBe("p2839");
  });

  it("returns undefined when unset, preserving compose's basename derivation", () => {
    expect(resolveComposeProjectName()).toBeUndefined();
    expect(
      resolveComposeProjectName({ processEnv: { COMPOSE_PROJECT_NAME: "  " } }),
    ).toBeUndefined();
  });
});

describe("buildComposeArgs / formatComposeCommand", () => {
  it("pins the project and both compose files", () => {
    expect(buildComposeArgs({ projectName: "p2839", args: ["up", "-d", "nango-server"] })).toEqual([
      "compose",
      "-p",
      "p2839",
      "-f",
      COMPOSE_FILES[0],
      "-f",
      COMPOSE_FILES[1],
      "up",
      "-d",
      "nango-server",
    ]);
  });

  it("omits -p when no project is configured (main-checkout behavior)", () => {
    expect(buildComposeArgs({ args: ["ps"] })).not.toContain("-p");
  });

  // Guidance an operator pastes must carry the same project flag the launcher
  // used — an unpinned paste forks a second, network-isolated project.
  it("renders operator guidance from the same builder", () => {
    expect(formatComposeCommand({ projectName: "p2839", args: ["logs", "nango-server"] })).toBe(
      `docker compose -p p2839 -f ${COMPOSE_FILES[0]} -f ${COMPOSE_FILES[1]} logs nango-server`,
    );
  });
});

describe("createComposeRunner", () => {
  const fakeChild = () => ({ once: () => {}, kill: () => {} });

  it("spawns NOTHING when the skip flag is set", async () => {
    const calls = [];
    const runCompose = createComposeRunner({
      spawnFn: (...args) => {
        calls.push(args);
        return fakeChild();
      },
      skip: true,
      projectName: "p2839",
      cwd: "/tmp/does-not-matter",
    });

    const result = await runCompose(["up", "-d", "nango-server"]);

    expect(calls).toHaveLength(0);
    expect(result).toEqual({ available: false, skipped: true });
  });

  it("pins the spawned compose to the lane project when the flag is not set", async () => {
    const calls = [];
    const runCompose = createComposeRunner({
      spawnFn: (bin, argv, opts) => {
        calls.push({ bin, argv, opts });
        return fakeChild();
      },
      skip: false,
      projectName: "p2839",
      cwd: "/repo",
    });

    runCompose(["up", "-d", "nango-server"]);

    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe("docker");
    expect(calls[0].argv.slice(0, 3)).toEqual(["compose", "-p", "p2839"]);
    expect(calls[0].argv.slice(-3)).toEqual(["up", "-d", "nango-server"]);
    expect(calls[0].opts.cwd).toBe("/repo");
  });

});

describe("readEnvFileValue", () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cinatra-2839-env-"));
    writeFileSync(
      path.join(dir, ".env.local"),
      [
        "# a comment",
        "",
        "PORT=13839",
        'export COMPOSE_PROJECT_NAME="p2839"',
        "REDIS_URL='redis://127.0.0.1:16379'",
        "EMPTY=",
        // Inline comments — dotenv syntax a lane really writes.
        "BARE_COMMENT=1 # lane isolation",
        'DQ_COMMENT="1" # lane isolation',
        "SQ_COMMENT='1' # lane isolation",
        'HASH_IN_DQ="a # b"',
        "HASH_IN_SQ='a # b'",
        "HASH_IN_VALUE=pa#ssword",
        "URL_WITH_FRAGMENT=http://127.0.0.1:13003/x#frag",
        "ONLY_COMMENT= # nothing stated",
        'EXPORTED_COMMENT=export_is_not_here',
        "export EXPORTED_WITH_COMMENT=p2839 # the lane project",
      ].join("\n"),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads plain, exported and quoted values, and skips comments", () => {
    const file = path.join(dir, ".env.local");
    expect(readEnvFileValue(file, "PORT")).toBe("13839");
    expect(readEnvFileValue(file, "COMPOSE_PROJECT_NAME")).toBe("p2839");
    expect(readEnvFileValue(file, "REDIS_URL")).toBe("redis://127.0.0.1:16379");
  });

  it("returns undefined for an unset key, an empty value or a missing file", () => {
    const file = path.join(dir, ".env.local");
    expect(readEnvFileValue(file, "NOPE")).toBeUndefined();
    expect(readEnvFileValue(file, "EMPTY")).toBeUndefined();
    expect(readEnvFileValue(path.join(dir, "absent"), "PORT")).toBeUndefined();
  });

  // Finding 2: `CINATRA_SKIP_DEV_PREFLIGHT=1 # lane isolation` parsed as the
  // literal "1 # lane isolation", which normalizeSkipFlag reports as "not
  // stated" — so the flag was silently ignored and the preflight ran. Same
  // silent-drop shape as the original cinatra#2839 defect.
  it("strips an inline comment from bare and quoted values", () => {
    const file = path.join(dir, ".env.local");
    expect(readEnvFileValue(file, "BARE_COMMENT")).toBe("1");
    expect(readEnvFileValue(file, "DQ_COMMENT")).toBe("1");
    expect(readEnvFileValue(file, "SQ_COMMENT")).toBe("1");
    expect(readEnvFileValue(file, "EXPORTED_WITH_COMMENT")).toBe("p2839");
    // …and the stripped value is a value the flag reader actually recognizes.
    expect(normalizeSkipFlag(readEnvFileValue(file, "BARE_COMMENT"))).toBe(true);
    expect(normalizeSkipFlag(readEnvFileValue(file, "DQ_COMMENT"))).toBe(true);
    expect(normalizeSkipFlag(readEnvFileValue(file, "SQ_COMMENT"))).toBe(true);
  });

  it("keeps a # that is inside quotes or part of the value itself", () => {
    const file = path.join(dir, ".env.local");
    expect(readEnvFileValue(file, "HASH_IN_DQ")).toBe("a # b");
    expect(readEnvFileValue(file, "HASH_IN_SQ")).toBe("a # b");
    // No whitespace before the `#` → not a comment, so a dev password or a URL
    // fragment is not silently truncated.
    expect(readEnvFileValue(file, "HASH_IN_VALUE")).toBe("pa#ssword");
    expect(readEnvFileValue(file, "URL_WITH_FRAGMENT")).toBe("http://127.0.0.1:13003/x#frag");
  });

  it("leaves comment-free values exactly as written", () => {
    const file = path.join(dir, ".env.local");
    expect(readEnvFileValue(file, "PORT")).toBe("13839");
    expect(readEnvFileValue(file, "REDIS_URL")).toBe("redis://127.0.0.1:16379");
    expect(readEnvFileValue(file, "EXPORTED_COMMENT")).toBe("export_is_not_here");
  });

  it("treats a value that is nothing but a comment as unset", () => {
    expect(readEnvFileValue(path.join(dir, ".env.local"), "ONLY_COMMENT")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end guard: the real launcher, a fake docker, zero containers
// ---------------------------------------------------------------------------

// A port nothing is listening on, so the Nango /health probe fails fast and the
// preflight proceeds to its (faked) compose heal. Bound then released, which is
// how we know it is free without hardcoding one.
async function reserveClosedPort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

describe("dev-server.mjs preflight (end-to-end, fake docker)", () => {
  let dir;
  let dockerLog;
  let closedPort;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "cinatra-2839-dev-"));
    dockerLog = path.join(dir, "docker-calls.log");
    closedPort = await reserveClosedPort();

    // Fake `docker`, first on PATH: record argv + the compose interpolation env,
    // then fail. Failing keeps the launcher's bounded-wait paths short and
    // guarantees nothing is ever really started.
    const bin = path.join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    // The recorder is a .cjs file invoked through a tiny sh wrapper, so the
    // extensionless `docker` on PATH never depends on how Node resolves the
    // module type of an extensionless script.
    writeFileSync(
      path.join(bin, "docker-recorder.cjs"),
      [
        'const { appendFileSync } = require("node:fs");',
        "appendFileSync(",
        "  process.env.CINATRA_TEST_DOCKER_LOG,",
        '  JSON.stringify({ argv: process.argv.slice(2) }) + "\\n",',
        ");",
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    const shim = path.join(bin, "docker");
    writeFileSync(
      shim,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$(dirname "$0")/docker-recorder.cjs" "$@"\n`,
    );
    chmodSync(shim, 0o755);

    // Stub `next` so the launcher's final spawn exits cleanly instead of
    // booting a real dev server (the app is never started by this test).
    const nextBin = path.join(dir, "node_modules", ".bin");
    mkdirSync(nextBin, { recursive: true });
    const nextStub = path.join(nextBin, "next");
    writeFileSync(nextStub, "#!/usr/bin/env node\nprocess.exit(0);\n");
    chmodSync(nextStub, 0o755);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Run the real launcher in the temp worktree and return the docker calls. */
  const runLauncher = (envLocal, extraEnv = {}) => {
    rmSync(dockerLog, { force: true });
    writeFileSync(path.join(dir, ".env.local"), envLocal);

    const env = {
      ...process.env,
      PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
      CINATRA_TEST_DOCKER_LOG: dockerLog,
      // Pinned explicitly so the repo's own .env.local (present on a dev
      // machine, absent in CI) cannot change what this test observes.
      NANGO_SERVER_URL: `http://127.0.0.1:${closedPort}`,
      // Lane DB/cache ports: not the bundled defaults, so the read-only
      // DB-port drift diagnosis correctly treats them as "not our stack" and
      // the Nango heal is the only docker interaction in play.
      SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:15434/postgres",
      REDIS_URL: "redis://127.0.0.1:16379",
    };
    // Whatever the ambient shell carries, each case states its own inputs.
    delete env.CINATRA_SKIP_DEV_PREFLIGHT;
    delete env.COMPOSE_PROJECT_NAME;
    Object.assign(env, extraEnv);

    const result = spawnSync(process.execPath, [DEV_SERVER], {
      cwd: dir,
      encoding: "utf8",
      timeout: 120_000,
      env,
    });
    const calls = existsSync(dockerLog)
      ? readFileSync(dockerLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return { ...result, calls };
  };

  // Every case below also asserts the launcher RAN TO COMPLETION: a zero-docker
  // result is only evidence of the flag's promise if the launcher actually got
  // past the preflight and spawned (the stubbed) `next`. A crash in the
  // preflight would otherwise read as a pass.
  const expectCleanRun = (result) => {
    expect(
      result.status,
      `launcher exited ${result.status} (signal ${result.signal})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.error).toBeUndefined();
  };

  // The issue's headline: the flag's promise is that NOTHING is started.
  it("makes zero docker calls when the flag is set in the shell env", () => {
    const result = runLauncher("PORT=13839\n", { CINATRA_SKIP_DEV_PREFLIGHT: "1" });
    expectCleanRun(result);
    expect(result.calls).toEqual([]);
  });

  // The regression itself: the lane set the flag where lanes keep their config.
  it("makes zero docker calls when the flag is set in the worktree .env.local", () => {
    const result = runLauncher("PORT=13839\nCINATRA_SKIP_DEV_PREFLIGHT=1\n");
    expectCleanRun(result);
    expect(result.calls).toEqual([]);
  });

  // Finding 2, end to end: the lane annotates WHY it opted out. Before the
  // reader handled inline comments the value read as "1 # lane isolation",
  // normalizeSkipFlag reported "not stated", and the full preflight ran —
  // the original defect's shape, reached through a different door.
  it("makes zero docker calls when the .env.local flag carries an inline comment", () => {
    const result = runLauncher(
      ["PORT=13839", "CINATRA_SKIP_DEV_PREFLIGHT=1 # lane isolation: no shared containers", ""].join(
        "\n",
      ),
    );
    expectCleanRun(result);
    expect(result.calls).toEqual([]);
  });

  it("makes zero docker calls when the quoted .env.local flag carries an inline comment", () => {
    const result = runLauncher(
      ["PORT=13839", 'CINATRA_SKIP_DEV_PREFLIGHT="1" # lane isolation', ""].join("\n"),
    );
    expectCleanRun(result);
    expect(result.calls).toEqual([]);
  });

  // The other half of the guard: WITHOUT the flag the preflight does run, and
  // every call it makes is pinned to the lane's own compose project rather than
  // the checkout directory's basename — so the heal acts on the stack the lane
  // already owns instead of forking a second, invisible one.
  it("without the flag, scopes its compose calls to the worktree project", () => {
    const result = runLauncher(["PORT=13839", "COMPOSE_PROJECT_NAME=p2839", ""].join("\n"));
    const { calls } = result;

    expectCleanRun(result);
    expect(calls.length).toBeGreaterThan(0);
    const up = calls.find((c) => c.argv.includes("up"));
    expect(up, "the Nango heal should have run").toBeDefined();

    // Project-scoped: not derived from the checkout directory's basename.
    expect(up.argv.slice(0, 3)).toEqual(["compose", "-p", "p2839"]);
    expect(up.argv).toEqual(expect.arrayContaining(["-f", ...COMPOSE_FILES]));
    // Every call the launcher makes carries the same pin, not just the heal.
    for (const call of calls) expect(call.argv.slice(0, 3)).toEqual(["compose", "-p", "p2839"]);
  });
});
