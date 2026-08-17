// Dev-server preflight policy + guard tests (cinatra#2839).
//
// Two layers, because the bug had two layers:
//
//   1. UNIT — the pure decisions in scripts/lib/dev-preflight.mjs: where the
//      skip flag is read from, which compose project the preflight may act on,
//      and which host ports it publishes. Dependency-injected; no Docker.
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
  PREFLIGHT_HOST_PORTS,
  buildComposeArgs,
  createComposeRunner,
  explicitLoopbackPort,
  formatComposeCommand,
  normalizeSkipFlag,
  readEnvFileValue,
  resolveComposeHostPortEnv,
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

describe("explicitLoopbackPort", () => {
  it("reads an explicit port off a loopback service URL", () => {
    expect(explicitLoopbackPort("http://127.0.0.1:13003")).toBe(13003);
    expect(explicitLoopbackPort("redis://localhost:16379")).toBe(16379);
    expect(explicitLoopbackPort("postgresql://nango:nango@127.0.0.1:15435/nango")).toBe(15435);
  });

  // Publishing a container port is a claim on a HOST port: a URL that states no
  // port must not be read as a request to publish the scheme default, and a
  // remote service is not ours to publish at all.
  it("refuses a URL with no explicit port, a remote host, or a non-URL", () => {
    expect(explicitLoopbackPort("http://localhost/nango")).toBeUndefined();
    expect(explicitLoopbackPort("https://nango.example.com:443")).toBeUndefined();
    expect(explicitLoopbackPort("not a url")).toBeUndefined();
    expect(explicitLoopbackPort(undefined)).toBeUndefined();
  });
});

describe("resolveComposeHostPortEnv", () => {
  it("falls back to the historical global ports when nothing overrides them", () => {
    expect(resolveComposeHostPortEnv()).toEqual({
      CINATRA_NANGO_SERVER_HOST_PORT: "3003",
      CINATRA_NANGO_CONNECT_HOST_PORT: "3009",
      CINATRA_NANGO_DB_HOST_PORT: "5435",
      CINATRA_REDIS_HOST_PORT: "6379",
    });
  });

  // The acceptance criterion: without the skip flag, the preflight's services
  // take their ports from the worktree env, not from hardcoded globals.
  it("derives lane ports from the same .env.local service URLs the app uses", () => {
    const envFile = {
      NANGO_SERVER_URL: "http://127.0.0.1:13003",
      NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
      REDIS_URL: "redis://127.0.0.1:16379",
      CINATRA_NANGO_CONNECT_HOST_PORT: "13009",
    };
    expect(
      resolveComposeHostPortEnv({ envFileLookup: (key) => envFile[key] }),
    ).toEqual({
      CINATRA_NANGO_SERVER_HOST_PORT: "13003",
      CINATRA_NANGO_CONNECT_HOST_PORT: "13009",
      CINATRA_NANGO_DB_HOST_PORT: "15435",
      CINATRA_REDIS_HOST_PORT: "16379",
    });
  });

  it("lets an explicit host-port override beat the URL-derived one", () => {
    expect(
      resolveComposeHostPortEnv({
        processEnv: { CINATRA_REDIS_HOST_PORT: "16380" },
        envFileLookup: (key) => (key === "REDIS_URL" ? "redis://127.0.0.1:16379" : undefined),
      }).CINATRA_REDIS_HOST_PORT,
    ).toBe("16380");
  });

  it("always emits every key, so a stale ambient value cannot leak through", () => {
    const resolved = resolveComposeHostPortEnv({ processEnv: {} });
    for (const spec of PREFLIGHT_HOST_PORTS) {
      expect(resolved[spec.envVar]).toBeTypeOf("string");
    }
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

  it("passes the lane project and host-port env when the flag is not set", async () => {
    const calls = [];
    const runCompose = createComposeRunner({
      spawnFn: (bin, argv, opts) => {
        calls.push({ bin, argv, opts });
        return fakeChild();
      },
      skip: false,
      projectName: "p2839",
      portEnv: { CINATRA_REDIS_HOST_PORT: "16379" },
      cwd: "/repo",
      baseEnv: { PATH: "/usr/bin", CINATRA_REDIS_HOST_PORT: "6379" },
    });

    runCompose(["up", "-d", "nango-server"]);

    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe("docker");
    expect(calls[0].argv.slice(0, 3)).toEqual(["compose", "-p", "p2839"]);
    expect(calls[0].argv.slice(-3)).toEqual(["up", "-d", "nango-server"]);
    expect(calls[0].opts.cwd).toBe("/repo");
    // The resolved port overrides the ambient one rather than inheriting it.
    expect(calls[0].opts.env.CINATRA_REDIS_HOST_PORT).toBe("16379");
    expect(calls[0].opts.env.PATH).toBe("/usr/bin");
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
        "const ports = Object.fromEntries(",
        "  Object.entries(process.env).filter(",
        '    ([k]) => k.startsWith("CINATRA_") && k.endsWith("_HOST_PORT"),',
        "  ),",
        ");",
        "appendFileSync(",
        "  process.env.CINATRA_TEST_DOCKER_LOG,",
        '  JSON.stringify({ argv: process.argv.slice(2), ports }) + "\\n",',
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
    for (const spec of PREFLIGHT_HOST_PORTS) delete env[spec.envVar];
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

  // The issue's headline: the flag's promise is that NOTHING is started.
  it("makes zero docker calls when the flag is set in the shell env", () => {
    const { calls } = runLauncher("PORT=13839\n", { CINATRA_SKIP_DEV_PREFLIGHT: "1" });
    expect(calls).toEqual([]);
  });

  // The regression itself: the lane set the flag where lanes keep their config.
  it("makes zero docker calls when the flag is set in the worktree .env.local", () => {
    const { calls } = runLauncher("PORT=13839\nCINATRA_SKIP_DEV_PREFLIGHT=1\n");
    expect(calls).toEqual([]);
  });

  it("without the flag, scopes its compose calls to the worktree project and ports", () => {
    const { calls } = runLauncher(
      [
        "PORT=13839",
        "COMPOSE_PROJECT_NAME=p2839",
        "NANGO_DATABASE_URL=postgresql://nango:nango@127.0.0.1:15435/nango",
        "CINATRA_NANGO_CONNECT_HOST_PORT=13009",
        "",
      ].join("\n"),
    );

    expect(calls.length).toBeGreaterThan(0);
    const up = calls.find((c) => c.argv.includes("up"));
    expect(up, "the Nango heal should have run").toBeDefined();

    // Project-scoped: not derived from the checkout directory's basename.
    expect(up.argv.slice(0, 3)).toEqual(["compose", "-p", "p2839"]);
    expect(up.argv).toEqual(expect.arrayContaining(["-f", ...COMPOSE_FILES]));

    // Lane ports, from the lane's own env — NOT the global 3003/3009/5435/6379
    // the compose files default to.
    expect(up.ports).toEqual({
      CINATRA_NANGO_SERVER_HOST_PORT: String(closedPort),
      CINATRA_NANGO_CONNECT_HOST_PORT: "13009",
      CINATRA_NANGO_DB_HOST_PORT: "15435",
      CINATRA_REDIS_HOST_PORT: "16379",
    });
  });
});
