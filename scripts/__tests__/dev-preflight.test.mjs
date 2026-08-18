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
  classifyServiceUrl,
  createComposeRunner,
  explicitLoopbackPort,
  formatComposeCommand,
  formatUnmanagedServices,
  normalizeSkipFlag,
  readEnvFileValue,
  resolveComposeHostPortPlan,
  resolveComposeProjectName,
  shouldSkipDevPreflight,
  unmanagedComposeServices,
} from "../lib/dev-preflight.mjs";
import { parseHostPort } from "../lib/docker-port-drift.mjs";

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
    expect(explicitLoopbackPort("http://host.docker.internal:13003")).toBe(13003);
  });

  // WHATWG normalizes away a port equal to the scheme default, so `url.port` is
  // "" for BOTH `http://localhost:80` and `http://localhost`. They are different
  // statements here — a stated :80 is a claim on host port 80 — so the port is
  // read off the raw authority when the parser dropped it.
  it("counts a stated scheme-default port as explicit", () => {
    expect(explicitLoopbackPort("http://localhost:80")).toBe(80);
    expect(explicitLoopbackPort("https://127.0.0.1:443/health")).toBe(443);
    expect(explicitLoopbackPort("http://localhost:80/nango")).toBe(80);
  });

  // `new URL()` reports an IPv6 hostname bracketed, so the lookup unwraps it.
  it("handles a bracketed IPv6 loopback URL", () => {
    expect(explicitLoopbackPort("http://[::1]:16379")).toBe(16379);
    expect(explicitLoopbackPort("http://[::1]/nango")).toBeUndefined();
    expect(explicitLoopbackPort("https://[2001:db8::1]:16379")).toBeUndefined();
  });

  // Publishing a container port is a claim on a HOST port: a URL that states no
  // port must not be read as a request to publish the scheme default, and a
  // remote service is not ours to publish at all.
  it("refuses a URL with no explicit port, a remote host, or a non-URL", () => {
    expect(explicitLoopbackPort("http://localhost/nango")).toBeUndefined();
    expect(explicitLoopbackPort("https://nango.example.com")).toBeUndefined();
    expect(explicitLoopbackPort("https://nango.example.com:443")).toBeUndefined();
    expect(explicitLoopbackPort("not a url")).toBeUndefined();
    expect(explicitLoopbackPort(undefined)).toBeUndefined();
  });
});

describe("classifyServiceUrl", () => {
  it("separates 'nothing stated' from 'stated, but not ours'", () => {
    expect(classifyServiceUrl(undefined)).toEqual({ state: "unconfigured" });
    expect(classifyServiceUrl("   ")).toEqual({ state: "unconfigured" });
    expect(classifyServiceUrl("redis://127.0.0.1:16379")).toEqual({
      state: "ours",
      port: 16379,
      url: "redis://127.0.0.1:16379",
    });
    expect(classifyServiceUrl("https://nango.example.com")).toEqual({
      state: "theirs",
      url: "https://nango.example.com",
    });
    expect(classifyServiceUrl("http://localhost/nango")).toEqual({
      state: "theirs",
      url: "http://localhost/nango",
    });
  });
});

// Review item 1. A bare main checkout is NOT a lane: a REDIS_URL there says
// where the app CONNECTS, not what this project publishes. Deriving from it
// republished the SHARED redis on a changed mapping — the reviewer ran the old
// resolver against `redis://127.0.0.1:6579` and got 6579 back.
describe("resolveComposeHostPortPlan — derivation is gated on a named project", () => {
  const REVIEWERS_CASE = { REDIS_URL: "redis://127.0.0.1:6579" };

  it("does NOT derive from service URLs without a configured COMPOSE_PROJECT_NAME", () => {
    const plan = resolveComposeHostPortPlan({
      processEnv: REVIEWERS_CASE,
    });
    expect(plan.portEnv.CINATRA_REDIS_HOST_PORT).toBe("6379"); // not 6579
    expect(plan.unmanaged).toEqual([]);
  });

  it("derives from the same URLs once the checkout names its project", () => {
    const plan = resolveComposeHostPortPlan({
      processEnv: REVIEWERS_CASE,
      projectName: "p2839",
    });
    expect(plan.portEnv.CINATRA_REDIS_HOST_PORT).toBe("6579");
  });

  // A remote service on an UNNAMED project must not be reported unmanaged
  // either: the main checkout's heal keeps working exactly as it always did.
  it("never stands a service down on an unnamed project", () => {
    const plan = resolveComposeHostPortPlan({
      processEnv: { NANGO_SERVER_URL: "https://nango.example.com" },
    });
    expect(plan.unmanaged).toEqual([]);
    expect(plan.portEnv.CINATRA_NANGO_SERVER_HOST_PORT).toBe("3003");
  });

  // An operator naming a published port directly is not an inference from a
  // client URL, so it is honored with or without a project name.
  it("honors an explicit CINATRA_*_HOST_PORT even on an unnamed project", () => {
    const plan = resolveComposeHostPortPlan({
      processEnv: { CINATRA_REDIS_HOST_PORT: "16379" },
    });
    expect(plan.portEnv.CINATRA_REDIS_HOST_PORT).toBe("16379");
  });
});

describe("resolveComposeHostPortPlan", () => {
  const lane = (envFile, processEnv = {}) =>
    resolveComposeHostPortPlan({
      processEnv,
      envFileLookup: (key) => envFile[key],
      projectName: "p2839",
    });

  it("falls back to the historical global ports when nothing states otherwise", () => {
    expect(resolveComposeHostPortPlan({ projectName: "p2839" })).toEqual({
      portEnv: {
        CINATRA_NANGO_SERVER_HOST_PORT: "3003",
        CINATRA_NANGO_CONNECT_HOST_PORT: "3009",
        CINATRA_NANGO_DB_HOST_PORT: "5435",
        CINATRA_REDIS_HOST_PORT: "6379",
      },
      unmanaged: [],
    });
  });

  it("derives lane ports from the same .env.local service URLs the app uses", () => {
    const plan = lane({
      NANGO_SERVER_URL: "http://127.0.0.1:13003",
      NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
      REDIS_URL: "redis://127.0.0.1:16379",
    });
    expect(plan.portEnv).toEqual({
      CINATRA_NANGO_SERVER_HOST_PORT: "13003",
      CINATRA_NANGO_CONNECT_HOST_PORT: "13009",
      CINATRA_NANGO_DB_HOST_PORT: "15435",
      CINATRA_REDIS_HOST_PORT: "16379",
    });
    expect(plan.unmanaged).toEqual([]);
  });

  it("lets an explicit host-port override beat the URL-derived one", () => {
    const plan = lane(
      { REDIS_URL: "redis://127.0.0.1:16379" },
      { CINATRA_REDIS_HOST_PORT: "17379" },
    );
    expect(plan.portEnv.CINATRA_REDIS_HOST_PORT).toBe("17379");
  });

  it("emits every MANAGED key, so a stale ambient value cannot leak through", () => {
    const plan = lane({ REDIS_URL: "redis://127.0.0.1:16379" });
    for (const spec of PREFLIGHT_HOST_PORTS) {
      expect(Object.keys(plan.portEnv)).toContain(spec.envVar);
    }
  });

  it("claims no host port for a service configured on a remote host", () => {
    const plan = lane({ REDIS_URL: "rediss://cache.example.com:6380" });
    expect(plan.portEnv.CINATRA_REDIS_HOST_PORT).toBeUndefined();
    expect(plan.unmanaged).toEqual([
      {
        service: "redis",
        envVar: "CINATRA_REDIS_HOST_PORT",
        urlVar: "REDIS_URL",
        url: "rediss://cache.example.com:6380",
      },
    ]);
  });

  it("claims no host port for a loopback URL that states no port", () => {
    const plan = lane({ NANGO_DATABASE_URL: "postgresql://localhost/nango" });
    expect(plan.portEnv.CINATRA_NANGO_DB_HOST_PORT).toBeUndefined();
    expect(unmanagedComposeServices(plan.unmanaged)).toEqual(["nango-db"]);
  });

  it("treats a stated :80 as an explicit claim, not as the global default", () => {
    const plan = lane({ NANGO_SERVER_URL: "http://127.0.0.1:80" });
    expect(plan.portEnv.CINATRA_NANGO_SERVER_HOST_PORT).toBe("80");
  });

  it("lets an explicit host-port override reclaim an otherwise-unmanaged service", () => {
    const plan = lane(
      { REDIS_URL: "rediss://cache.example.com:6380" },
      { CINATRA_REDIS_HOST_PORT: "16379" },
    );
    expect(plan.portEnv.CINATRA_REDIS_HOST_PORT).toBe("16379");
    expect(plan.unmanaged).toEqual([]);
  });
});

// Review item 4. 3009 had NO derivation source and nothing ever wrote its
// variable, so two ordinary lanes still collided on it — acceptance item 2 of
// the issue was unmet even with the other three ports scoped. It is published by
// the SAME container as nango-server, so it follows nango-server's resolved port
// by the offset the compose files state between them.
describe("resolveComposeHostPortPlan — nango-connect (3009) derivation", () => {
  const lane = (envFile, processEnv = {}) =>
    resolveComposeHostPortPlan({
      processEnv,
      envFileLookup: (key) => envFile[key],
      projectName: "p2839",
    });

  it("follows the lane's nango-server port by the compose files' own offset", () => {
    expect(lane({ NANGO_SERVER_URL: "http://127.0.0.1:13003" }).portEnv).toMatchObject({
      CINATRA_NANGO_SERVER_HOST_PORT: "13003",
      CINATRA_NANGO_CONNECT_HOST_PORT: "13009",
    });
  });

  // The acceptance criterion itself: two ORDINARY lanes — each stating only its
  // own NANGO_SERVER_URL, neither hand-setting a connect port — do not collide.
  it("gives two ordinary lanes distinct connect ports", () => {
    const a = lane({ NANGO_SERVER_URL: "http://127.0.0.1:13003" }).portEnv;
    const b = lane({ NANGO_SERVER_URL: "http://127.0.0.1:14003" }).portEnv;
    expect(a.CINATRA_NANGO_CONNECT_HOST_PORT).toBe("13009");
    expect(b.CINATRA_NANGO_CONNECT_HOST_PORT).toBe("14009");
    expect(a.CINATRA_NANGO_CONNECT_HOST_PORT).not.toBe(b.CINATRA_NANGO_CONNECT_HOST_PORT);
  });

  it("still lets an operator claim the connect port directly", () => {
    const plan = lane(
      { NANGO_SERVER_URL: "http://127.0.0.1:13003" },
      { CINATRA_NANGO_CONNECT_HOST_PORT: "13999" },
    );
    expect(plan.portEnv.CINATRA_NANGO_CONNECT_HOST_PORT).toBe("13999");
  });

  // Same container: if nango-server is not ours to publish, its connect port is
  // not either — and the two must stand down as ONE service, not two.
  it("is unmanaged whenever nango-server is", () => {
    const plan = lane({ NANGO_SERVER_URL: "https://nango.example.com" });
    expect(plan.portEnv.CINATRA_NANGO_CONNECT_HOST_PORT).toBeUndefined();
    expect(unmanagedComposeServices(plan.unmanaged)).toEqual(["nango-server"]);
    // The warning names the deciding URL once, not once per port.
    expect(formatUnmanagedServices(plan.unmanaged)).toBe(
      "NANGO_SERVER_URL=https://nango.example.com",
    );
  });
});

describe("formatUnmanagedServices / unmanagedComposeServices", () => {
  it("names the configured URL that made the preflight stand down", () => {
    expect(
      formatUnmanagedServices([
        { service: "redis", urlVar: "REDIS_URL", url: "rediss://cache.example.com:6380" },
        { service: "nango-server", urlVar: "NANGO_SERVER_URL", url: "http://localhost/nango" },
      ]),
    ).toBe("REDIS_URL=rediss://cache.example.com:6380, NANGO_SERVER_URL=http://localhost/nango");
    expect(formatUnmanagedServices()).toBe("");
    expect(unmanagedComposeServices()).toEqual([]);
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

  // Asserted where it actually bites: the interpolation environment compose is
  // SPAWNED with. `${VAR:-3003}` in the compose files means a global default
  // reaching this env is a real published host port, so the plan must put no
  // value there for a service configured somewhere else — and, because the plan
  // and the runner's baseEnv read the SAME process env, omitting the key cannot
  // let an ambient value take its place either.
  it("hands compose no global-default port for a service configured elsewhere", () => {
    const processEnv = { PATH: "/usr/bin" };
    const envFile = {
      NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango", // ours
      REDIS_URL: "redis://localhost", // loopback, no port stated
    };
    const plan = resolveComposeHostPortPlan({
      processEnv,
      envFileLookup: (key) => envFile[key],
      projectName: "p2839",
    });

    const calls = [];
    const runCompose = createComposeRunner({
      spawnFn: (bin, argv, opts) => {
        calls.push({ bin, argv, opts });
        return fakeChild();
      },
      skip: false,
      projectName: "p2839",
      portEnv: plan.portEnv,
      cwd: "/repo",
      baseEnv: processEnv,
    });

    runCompose(["up", "-d", "nango-server"]);

    const spawnedPorts = Object.fromEntries(
      Object.entries(calls[0].opts.env).filter(
        ([k]) => k.startsWith("CINATRA_") && k.endsWith("_HOST_PORT"),
      ),
    );
    expect(spawnedPorts.CINATRA_REDIS_HOST_PORT).toBeUndefined();
    expect(Object.values(spawnedPorts)).not.toContain("6379");
    expect(spawnedPorts.CINATRA_NANGO_DB_HOST_PORT).toBe("15435");
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

  // Review item 1, end to end: a checkout that names NO project must not derive.
  // The launcher's own REDIS_URL here is a non-6379 loopback port — exactly the
  // reviewer's case — and the heal must still hand compose the global default,
  // because on a bare main checkout that URL says where the app CONNECTS, not
  // what this project publishes.
  it("does not derive host ports when the checkout names no compose project", () => {
    const result = runLauncher("PORT=13839\n");
    expectCleanRun(result);
    const up = result.calls.find((c) => c.argv.includes("up"));
    expect(up, "the Nango heal should have run").toBeDefined();
    // No -p: compose's basename derivation, exactly as before this work.
    expect(up.argv.slice(0, 2)).toEqual(["compose", "-f"]);
    expect(up.ports).toEqual({
      CINATRA_NANGO_SERVER_HOST_PORT: "3003",
      CINATRA_NANGO_CONNECT_HOST_PORT: "3009",
      CINATRA_NANGO_DB_HOST_PORT: "5435",
      CINATRA_REDIS_HOST_PORT: "6379",
    });
  });

  // A remote Nango is not ours to start. `.invalid` is reserved as
  // non-resolvable (RFC 2606), so the /health probe fails on DNS without
  // reaching the network.
  it("does not heal — or publish — a Nango configured on a remote host", () => {
    const result = runLauncher("PORT=13839\nCOMPOSE_PROJECT_NAME=p2839\n", {
      NANGO_SERVER_URL: "https://nango.example.invalid",
    });
    expectCleanRun(result);
    expect(result.calls.filter((c) => c.argv.includes("up"))).toEqual([]);
    expect(result.stderr).toContain("nango.example.invalid");
  });

  // The non-blocking the reviewer asked for: PER-SERVICE stand-down, not a
  // whole-heal refusal. Nango IS ours, but `up -d nango-server` starts its
  // depends_on too — with REDIS_URL pointing elsewhere there is no redis host
  // port this checkout may claim, so healing plain would publish the global
  // 6379. Heal nango-server ALONE instead of refusing outright.
  it("heals nango-server with --no-deps when a depends_on service is configured elsewhere", () => {
    const result = runLauncher("PORT=13839\nCOMPOSE_PROJECT_NAME=p2839\n", {
      REDIS_URL: "rediss://cache.example.com:6380",
    });
    expectCleanRun(result);
    const up = result.calls.find((c) => c.argv.includes("up"));
    expect(up, "nango-server should still be healed").toBeDefined();
    expect(up.argv.slice(-4)).toEqual(["up", "-d", "--no-deps", "nango-server"]);
    // No redis port is claimed, and no global default leaks in its place.
    expect(up.ports.CINATRA_REDIS_HOST_PORT).toBeUndefined();
    expect(Object.values(up.ports)).not.toContain("6379");
    expect(result.stderr).toContain("REDIS_URL=rediss://cache.example.com:6380");
  });

  // A loopback URL that states NO port is the same "not ours" case: the scheme
  // default is not this checkout's to publish, and it must not silently become
  // the global 5435. Stated on NANGO_DATABASE_URL rather than NANGO_SERVER_URL
  // so the /health probe still targets the reserved-closed loopback port above
  // and this test never reaches for :80 on the host running it.
  it("claims no host port for a loopback URL that states no port", () => {
    const result = runLauncher("PORT=13839\nCOMPOSE_PROJECT_NAME=p2839\n", {
      NANGO_DATABASE_URL: "postgresql://localhost/nango",
    });
    expectCleanRun(result);
    const up = result.calls.find((c) => c.argv.includes("up"));
    expect(up.argv).toContain("--no-deps");
    expect(up.ports.CINATRA_NANGO_DB_HOST_PORT).toBeUndefined();
    expect(Object.values(up.ports)).not.toContain("5435");
    expect(result.stderr).toContain("NANGO_DATABASE_URL=postgresql://localhost/nango");
  });

  it("without the flag, scopes its compose calls to the worktree project and ports", () => {
    const result = runLauncher(
      [
        "PORT=13839",
        "COMPOSE_PROJECT_NAME=p2839",
        "NANGO_DATABASE_URL=postgresql://nango:nango@127.0.0.1:15435/nango",
        "",
      ].join("\n"),
    );
    const { calls } = result;

    expectCleanRun(result);
    expect(calls.length).toBeGreaterThan(0);
    const up = calls.find((c) => c.argv.includes("up"));
    expect(up, "the Nango heal should have run").toBeDefined();

    // Project-scoped: not derived from the checkout directory's basename.
    expect(up.argv.slice(0, 3)).toEqual(["compose", "-p", "p2839"]);
    expect(up.argv).toEqual(expect.arrayContaining(["-f", ...COMPOSE_FILES]));
    // Every call the launcher makes carries the same pin, not just the heal —
    // including the read-only drift diagnosis, which shells out on its own.
    for (const call of calls) expect(call.argv.slice(0, 3)).toEqual(["compose", "-p", "p2839"]);

    // Lane ports, from the lane's own env — NOT the global 3003/3009/5435/6379
    // the compose files default to. 3009 is DERIVED from the resolved 3003
    // (review item 4): nothing in this .env.local states it.
    expect(up.ports).toEqual({
      CINATRA_NANGO_SERVER_HOST_PORT: String(closedPort),
      CINATRA_NANGO_CONNECT_HOST_PORT: String(closedPort + 6),
      CINATRA_NANGO_DB_HOST_PORT: "15435",
      CINATRA_REDIS_HOST_PORT: "16379",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The ONE shared derivation step (review item 3)
// ---------------------------------------------------------------------------
//
// `make dev` and `pnpm services` used to bring the stack up on the compose
// files' fixed defaults while `pnpm dev` derived, so whichever ran first decided
// what got published. Both now `eval` this script's output, and the launcher
// imports the same resolvers — so the assertion that matters is that the shared
// step and the launcher agree, not merely that each works alone.

describe("scripts/dev-compose-env.mjs — the shared derivation step", () => {
  const SHARED_STEP = path.join(REPO_ROOT, "scripts", "dev-compose-env.mjs");

  const runStep = (extraEnv = {}, args = []) => {
    const env = { ...process.env };
    delete env.COMPOSE_PROJECT_NAME;
    for (const spec of PREFLIGHT_HOST_PORTS) delete env[spec.envVar];
    for (const key of ["NANGO_SERVER_URL", "NANGO_DATABASE_URL", "REDIS_URL"]) delete env[key];
    Object.assign(env, extraEnv);
    return spawnSync(process.execPath, [SHARED_STEP, ...args], {
      cwd: tmpdir(), // no .env.local here: every case states its own inputs
      encoding: "utf8",
      env,
    });
  };

  it("emits shell exports a Makefile recipe or npm script can eval", () => {
    const result = runStep({
      COMPOSE_PROJECT_NAME: "p2839",
      NANGO_SERVER_URL: "http://127.0.0.1:13003",
      NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
      REDIS_URL: "redis://127.0.0.1:16379",
    });
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toContain("export COMPOSE_PROJECT_NAME='p2839'");
    expect(lines).toContain("export CINATRA_NANGO_SERVER_HOST_PORT='13003'");
    expect(lines).toContain("export CINATRA_NANGO_CONNECT_HOST_PORT='13009'");
    expect(lines).toContain("export CINATRA_NANGO_DB_HOST_PORT='15435'");
    expect(lines).toContain("export CINATRA_REDIS_HOST_PORT='16379'");
    // Every line is an assignment; nothing else can leak into the `eval`.
    for (const line of lines) expect(line).toMatch(/^export [A-Z0-9_]+='[^']*'$/);
  });

  // Docker reads COMPOSE_PROJECT_NAME from its own env but not from
  // `.env.local`, so without this the non-launcher entry points would start a
  // basename-derived project while the launcher pinned the lane's.
  it("exports the project name a lane recorded in .env.local", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cinatra-2839-step-"));
    writeFileSync(
      path.join(dir, ".env.local"),
      "COMPOSE_PROJECT_NAME=p2839 # lane\nREDIS_URL=redis://127.0.0.1:16379\n",
    );
    const env = { ...process.env };
    delete env.COMPOSE_PROJECT_NAME;
    for (const spec of PREFLIGHT_HOST_PORTS) delete env[spec.envVar];
    for (const key of ["NANGO_SERVER_URL", "NANGO_DATABASE_URL", "REDIS_URL"]) delete env[key];
    const result = spawnSync(process.execPath, [SHARED_STEP], { cwd: dir, encoding: "utf8", env });
    rmSync(dir, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("export COMPOSE_PROJECT_NAME='p2839'");
    expect(result.stdout).toContain("export CINATRA_REDIS_HOST_PORT='16379'");
  });

  it("emits the historical defaults and no project pin on a bare checkout", () => {
    const result = runStep({ REDIS_URL: "redis://127.0.0.1:6579" });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("COMPOSE_PROJECT_NAME");
    expect(result.stdout).toContain("export CINATRA_REDIS_HOST_PORT='6379'"); // not 6579
  });

  // The point of item 3: one derivation, not three that can disagree. The
  // step's plan must equal what the launcher resolves from the same inputs.
  it("agrees exactly with the resolver the launcher uses", () => {
    const inputs = {
      COMPOSE_PROJECT_NAME: "p2839",
      NANGO_SERVER_URL: "http://127.0.0.1:13003",
      REDIS_URL: "rediss://cache.example.com:6380",
    };
    const result = runStep(inputs, ["--json"]);
    expect(result.status).toBe(0);
    const fromStep = JSON.parse(result.stdout);
    const fromLauncher = resolveComposeHostPortPlan({
      processEnv: inputs,
      projectName: "p2839",
    });
    expect(fromStep.portEnv).toEqual(fromLauncher.portEnv);
    expect(fromStep.unmanaged).toEqual(fromLauncher.unmanaged);

    // In the mode the entry points actually `eval`, a service configured
    // elsewhere contributes NO export and is reported on stderr instead, so it
    // can never land inside the eval — and no global default takes its place.
    const shell = runStep(inputs);
    expect(shell.stdout).not.toContain("CINATRA_REDIS_HOST_PORT");
    expect(shell.stdout).not.toContain("6379");
    expect(shell.stderr).toContain("REDIS_URL=rediss://cache.example.com:6380");
  });
});

// ---------------------------------------------------------------------------
// 3b. The advertised URL follows the PUBLISHED port (review item 2)
// ---------------------------------------------------------------------------
//
// The port was parameterized but the container still advertised
// `http://localhost:3003`, and NANGO_PUBLIC_SERVER_URL is what the OAuth
// callback is built from (`${NANGO_PUBLIC_SERVER_URL}/oauth/callback`, see
// packages/sdk-extensions/src/host-context.ts) — so a lane published on 13003
// sent its provider callbacks to whatever holds the global 3003, i.e. another
// lane. Asserted against the compose file itself rather than a rendering, so it
// holds in CI with no Docker: the SAME variable must appear on both sides.

describe("docker-compose.yml — advertised Nango URL tracks the published port", () => {
  const compose = readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8");
  const PORT_VAR = "CINATRA_NANGO_SERVER_HOST_PORT";

  it("publishes the host port from the parameterized variable", () => {
    expect(compose).toContain(`- "\${${PORT_VAR}:-3003}:3003"`);
    expect(compose).toContain('- "${CINATRA_NANGO_CONNECT_HOST_PORT:-3009}:3009"');
  });

  it("interpolates both advertised URLs from that same variable", () => {
    expect(compose).toContain(`NANGO_SERVER_URL: http://localhost:\${${PORT_VAR}:-3003}`);
    expect(compose).toContain(`NANGO_PUBLIC_SERVER_URL: http://localhost:\${${PORT_VAR}:-3003}`);
    // The pre-fix literal must be gone from both, or a lane silently advertises
    // the global port again.
    expect(compose).not.toContain("NANGO_SERVER_URL: http://localhost:3003");
    expect(compose).not.toContain("NANGO_PUBLIC_SERVER_URL: http://localhost:3003");
  });

  // SERVER_PORT is the CONTAINER-side listen port — the right-hand side of the
  // mapping — and must NOT follow the host port, or the container would listen
  // somewhere the mapping does not point.
  it("leaves the container-side listen port fixed", () => {
    expect(compose).toContain('SERVER_PORT: "3003"');
  });
});

// ---------------------------------------------------------------------------
// 4. The inline-comment reader's reach beyond the skip flag
// ---------------------------------------------------------------------------
//
// The reviewer's third non-blocking: `parseEnvValue` was added for the skip
// flag, but `readEnvFileValue` is also how the launcher reads PORT and every
// service DSN, so the change reaches those too. That is the intended direction
// — an annotated DSN used to defeat parseHostPort's explicit-port branch — but
// it is only safe because a `#` that is PART of a value still survives.

describe("inline comments in the values the launcher reads (PORT, DSNs)", () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cinatra-2839-dsn-"));
    writeFileSync(
      path.join(dir, ".env.local"),
      [
        "PORT=13839 # lane port",
        "REDIS_URL=redis://127.0.0.1:16379 # lane cache",
        'NANGO_DATABASE_URL="postgresql://nango:nango@127.0.0.1:15435/nango" # lane db',
        "SUPABASE_DB_URL=postgresql://postgres:p#ss@127.0.0.1:15434/postgres",
        "",
      ].join("\n"),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const read = (key) => readEnvFileValue(path.join(dir, ".env.local"), key);

  it("strips the annotation so PORT is a number again", () => {
    expect(read("PORT")).toBe("13839");
    expect(Number(read("PORT"))).toBe(13839);
  });

  // The behavior change that matters downstream: parseHostPort's explicit-port
  // branch only fires on a PARSEABLE URL. The annotated string was not one, so
  // it silently fell back to the bundled default — which is how a lane's own DSN
  // got read as the global port. The reader now hands it a clean DSN.
  it("lets parseHostPort see the explicit port of an annotated DSN", () => {
    const redisFallback = { host: "127.0.0.1", port: 6379 };
    expect(parseHostPort(read("REDIS_URL"), redisFallback)).toEqual({
      host: "127.0.0.1",
      port: 16379,
    });
    expect(
      parseHostPort(read("NANGO_DATABASE_URL"), { host: "127.0.0.1", port: 5435 }),
    ).toMatchObject({ port: 15435 });

    // Pre-fix shape, for contrast: the raw annotated value resolves to the
    // fallback, i.e. the global 6379 this work exists to keep lanes off.
    expect(parseHostPort("redis://127.0.0.1:16379 # lane cache", redisFallback)).toEqual(
      redisFallback,
    );
  });

  // The narrowing that keeps this safe: a `#` with no whitespace before it is
  // part of the value — a dev DB password here — and is NOT truncated. (Such a
  // DSN is not a parseable URL either way, since an unencoded `#` opens a URL
  // fragment; the point is only that the reader does not silently shorten a
  // secret, which would turn a wrong password into a confusing auth failure.)
  it("keeps a # that is part of the value itself", () => {
    expect(read("SUPABASE_DB_URL")).toBe("postgresql://postgres:p#ss@127.0.0.1:15434/postgres");
  });
});
