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
  copyFileSync,
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
  composeDefaultProjectName,
  createComposeRunner,
  explicitLoopbackPort,
  formatComposeCommand,
  formatConnectPortMismatch,
  formatGuardedComposeCommand,
  formatUnmanagedServices,
  isLinkedWorktree,
  normalizeComposeProjectName,
  normalizeSkipFlag,
  planMessages,
  readEnvFileValue,
  resolveComposeHostPortPlan,
  resolveComposeProjectName,
  resolvePublishedHostPort,
  shouldSkipDevPreflight,
  unmanagedComposeServices,
} from "../lib/dev-preflight.mjs";
import {
  BUNDLED_DB_SERVICES,
  diagnoseDockerPortDrift,
  formatDriftRemedy,
  parseHostPort,
  shouldDiagnoseDrift,
} from "../lib/docker-port-drift.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const DEV_SERVER = path.join(REPO_ROOT, "scripts", "dev-server.mjs");
const DEV_COMPOSE_ENV = path.join(REPO_ROOT, "scripts", "dev-compose-env.mjs");

/**
 * Is `dir` a LINKED git worktree — according to GIT, not according to the module
 * under test?
 *
 * The suite runs both from the main checkout (CI, a plain clone) and from a
 * linked worktree (any lane), and `laneScope` now tells those two apart, so the
 * entry-point cases below have two correct outcomes and must know which host
 * they are on. Asking `isLinkedWorktree` would make the expectation the
 * implementation restated, so the precondition comes from git itself: the
 * per-worktree gitdir differs from the shared common dir in a linked worktree
 * and is the same path in the main checkout. `isLinkedWorktree` is then pinned
 * AGAINST this answer in its own test, which is what keeps the branch honest.
 *
 * Returns false when git cannot answer (no git on PATH, a source export) —
 * matching the module's own conservative fallback.
 */
const gitSaysLinkedWorktree = (dir) => {
  const ask = (flag) => spawnSync("git", ["-C", dir, "rev-parse", flag], { encoding: "utf8" });
  const own = ask("--git-dir");
  const shared = ask("--git-common-dir");
  if (own.status !== 0 || shared.status !== 0) return false;
  return path.resolve(dir, own.stdout.trim()) !== path.resolve(dir, shared.stdout.trim());
};

// Fixed once: every case below reads the same answer for the checkout the suite
// is running in.
const REPO_IS_LINKED_WORKTREE = gitSaysLinkedWorktree(REPO_ROOT);

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
    // Empty IS unset — `VAR=` is how a shell spells "no value", and how compose
    // reads it — so it falls through to the next source rather than counting as
    // a statement.
    expect(
      resolveComposeProjectName({ processEnv: { COMPOSE_PROJECT_NAME: "" } }),
    ).toBeUndefined();
    expect(
      resolveComposeProjectName({ processEnv: { COMPOSE_PROJECT_NAME: "" }, envFileValues: ["p2839"] }),
    ).toBe("p2839");
  });

  // The RAW value, whitespace and all. Trimming here decided the canonicality
  // question before `resolveComposeHostPortPlan` could ask it, on a value the
  // operator never stated — see the two cases in the `laneScope` block below.
  it("returns the stated value raw, without trimming it into a different name", () => {
    expect(
      resolveComposeProjectName({ processEnv: { COMPOSE_PROJECT_NAME: " cinatra" } }),
    ).toBe(" cinatra");
    expect(
      resolveComposeProjectName({ processEnv: { COMPOSE_PROJECT_NAME: "cinatra " } }),
    ).toBe("cinatra ");
  });

  // …and a whitespace-only value is a STATED value, not an absent one. Reading
  // it as "nothing stated" put it in the one scope nothing can refuse, so no
  // project-name line was emitted and the invalid ambient value survived into
  // compose.
  it("treats a whitespace-only value as stated, not as an unscoped checkout", () => {
    expect(
      resolveComposeProjectName({ processEnv: { COMPOSE_PROJECT_NAME: "  " } }),
    ).toBe("  ");
    // It does not fall through to `.env.local` either: the shell stated it.
    expect(
      resolveComposeProjectName({
        processEnv: { COMPOSE_PROJECT_NAME: "  " },
        envFileValues: ["p2839"],
      }),
    ).toBe("  ");
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
      processEnv: {
        ...REVIEWERS_CASE,
        // Stated so the lane's plan is complete; the subject is REDIS_URL.
        NANGO_SERVER_URL: "http://127.0.0.1:13003",
        NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
      },
      projectName: "p2839",
    });
    expect(plan.portEnv.CINATRA_REDIS_HOST_PORT).toBe("6579");
    expect(plan.refusals).toEqual([]);
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
  // Every case in here states the OTHER services' URLs, because a named lane
  // that omits one is a refusal now (see the describe below) — the point of
  // each test is the one service it varies.
  const LANE_URLS = {
    NANGO_SERVER_URL: "http://127.0.0.1:13003",
    NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
    REDIS_URL: "redis://127.0.0.1:16379",
  };
  const lane = (envFile, processEnv = {}) =>
    resolveComposeHostPortPlan({
      processEnv,
      envFileLookup: (key) => ({ ...LANE_URLS, ...envFile })[key],
      projectName: "p2839",
    });

  it("falls back to the historical global ports on the UNSCOPED checkout", () => {
    expect(resolveComposeHostPortPlan({})).toMatchObject({
      portEnv: {
        CINATRA_NANGO_SERVER_HOST_PORT: "3003",
        CINATRA_NANGO_CONNECT_HOST_PORT: "3009",
        CINATRA_NANGO_DB_HOST_PORT: "5435",
        CINATRA_REDIS_HOST_PORT: "6379",
      },
      unmanaged: [],
      refusals: [],
      warnings: [],
      laneScope: "unscoped",
    });
  });

  it("derives lane ports from the same .env.local service URLs the app uses", () => {
    const plan = lane(LANE_URLS);
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
  // The other two services are stated in every case: a named lane that omits
  // one is refused now, and the subject here is the connect port alone.
  const OTHER_LANE_URLS = {
    NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
    REDIS_URL: "redis://127.0.0.1:16379",
  };
  const lane = (envFile, processEnv = {}) =>
    resolveComposeHostPortPlan({
      processEnv,
      envFileLookup: (key) => ({ ...OTHER_LANE_URLS, ...envFile })[key],
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

// Review round 2, item 1. The hole the previous shape left: with a project name
// configured and a service URL simply ABSENT, the plan handed back that
// service's shared default without a word — and a test blessed it. Two named
// lanes each omitting one URL collide on that service with each other AND with
// the operator's stack, which is the exact quiet failure this work exists to
// kill. A named lane is now refused, attributably.
describe("resolveComposeHostPortPlan — a named lane is never given a shared default silently", () => {
  const LANE_URLS = {
    NANGO_SERVER_URL: "http://127.0.0.1:13003",
    NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
    REDIS_URL: "redis://127.0.0.1:16379",
  };
  const plan = (input) => resolveComposeHostPortPlan({ projectName: "p2839", ...input });

  it("refuses the service whose URL is missing, and names it and both fixes", () => {
    const statedButRedis = { ...LANE_URLS };
    delete statedButRedis.REDIS_URL;
    const result = plan({ processEnv: statedButRedis });

    expect(result.laneScope).toBe("lane");
    expect(result.refusals.map((r) => r.envVar)).toEqual(["CINATRA_REDIS_HOST_PORT"]);
    expect(result.refusals[0].reason).toBe("missing-service-url");
    // No key at all: NOT the shared 6379 under another name.
    expect(result.portEnv.CINATRA_REDIS_HOST_PORT).toBeUndefined();
    expect(Object.values(result.portEnv)).not.toContain("6379");
    // The services this lane DID state are unaffected — the refusal is
    // per-service, not a whole-plan collapse.
    expect(result.portEnv.CINATRA_NANGO_SERVER_HOST_PORT).toBe("13003");

    const [message] = planMessages(result.refusals);
    expect(message).toContain("REDIS_URL"); // the missing variable
    expect(message).toContain("CINATRA_REDIS_HOST_PORT"); // fix 1: state the port
    expect(message).toContain("unset COMPOSE_PROJECT_NAME"); // fix 2: stop being a lane
    expect(message).toContain("6379"); // the default it refuses to hand out
  });

  // The collision the refusal prevents, spelled out: before this, BOTH lanes
  // got 6379 back and neither was told.
  it("refuses both of two lanes that each omit a different URL", () => {
    const a = plan({
      processEnv: { NANGO_SERVER_URL: "http://127.0.0.1:13003", REDIS_URL: LANE_URLS.REDIS_URL },
    });
    const b = plan({
      processEnv: {
        NANGO_SERVER_URL: "http://127.0.0.1:14003",
        NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:25435/nango",
      },
    });
    expect(a.refusals.map((r) => r.envVar)).toEqual(["CINATRA_NANGO_DB_HOST_PORT"]);
    expect(b.refusals.map((r) => r.envVar)).toEqual(["CINATRA_REDIS_HOST_PORT"]);
    expect(a.portEnv.CINATRA_NANGO_DB_HOST_PORT).toBeUndefined();
    expect(b.portEnv.CINATRA_REDIS_HOST_PORT).toBeUndefined();
  });

  // HARD CAUTION, and the reason `laneScope` exists. The canonical single-stack
  // flow sets no project name at all (scripts/setup.sh, the Makefile and
  // package.json pass no `-p` and export none), so it can never be refused —
  // and a checkout that merely PINS the name compose already derives from its
  // own directory has not become a second lane either.
  it("never refuses the unscoped checkout", () => {
    const result = resolveComposeHostPortPlan({ processEnv: {} });
    expect(result.laneScope).toBe("unscoped");
    expect(result.refusals).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.portEnv.CINATRA_REDIS_HOST_PORT).toBe("6379");
  });

  it("warns instead of refusing when the name IS this checkout's compose default", () => {
    const result = resolveComposeHostPortPlan({
      projectName: "cinatra_cinatra",
      defaultProjectName: "/Users/dev/src/cinatra_cinatra",
      processEnv: {},
    });
    expect(result.laneScope).toBe("checkout");
    expect(result.refusals).toEqual([]);
    // Loud, and it says what will happen and what to do if it is wrong.
    expect(result.warnings.map((w) => w.envVar)).toEqual([
      "CINATRA_NANGO_SERVER_HOST_PORT",
      "CINATRA_NANGO_DB_HOST_PORT",
      "CINATRA_REDIS_HOST_PORT",
    ]);
    expect(planMessages(result.warnings)[0]).toContain("collide on 3003");
    // …and `make dev` still gets the historical values it always had.
    expect(result.portEnv).toEqual({
      CINATRA_NANGO_SERVER_HOST_PORT: "3003",
      CINATRA_NANGO_CONNECT_HOST_PORT: "3009",
      CINATRA_NANGO_DB_HOST_PORT: "5435",
      CINATRA_REDIS_HOST_PORT: "6379",
    });
  });

  // A DIFFERENT name in the same checkout is a second project on one host —
  // the situation a shared default actually breaks.
  it("treats a name that differs from the compose default as a lane", () => {
    const result = resolveComposeHostPortPlan({
      projectName: "p2839",
      defaultProjectName: "/Users/dev/src/cinatra_cinatra",
      processEnv: {},
    });
    expect(result.laneScope).toBe("lane");
    expect(result.refusals.length).toBe(3);
  });

  // Compose's normalization applies to the name it DERIVES from a directory
  // basename — that is the only side of the `checkout` comparison it is valid
  // on, and `composeDefaultProjectName` is where it belongs.
  it("normalizes the directory-derived side the way compose does", () => {
    expect(normalizeComposeProjectName("Cinatra_Cinatra")).toBe("cinatra_cinatra");
    expect(normalizeComposeProjectName(" -p2839! ")).toBe("p2839");
    expect(composeDefaultProjectName("/Users/dev/src/Cinatra_Cinatra")).toBe("cinatra_cinatra");
  });

  // …but an EXPLICIT COMPOSE_PROJECT_NAME is only VALIDATED by compose, never
  // normalized: `Cinatra_Cinatra` is rejected with "invalid project name", not
  // folded into `cinatra_cinatra`. Normalizing it before the comparison (the
  // pre-fix shape) classified a name that could never boot as this checkout's
  // own no-op pin, and let the run continue to compose's own late error.
  it("refuses a stated project name compose would reject, rather than pinning it", () => {
    const result = resolveComposeHostPortPlan({
      projectName: "Cinatra_Cinatra",
      defaultProjectName: "/Users/dev/src/cinatra_cinatra",
    });
    expect(result.laneScope).not.toBe("checkout");
    const refusal = result.refusals.find((r) => r.reason === "project-name-not-canonical");
    expect(refusal).toBeDefined();
    expect(refusal.envVar).toBe("COMPOSE_PROJECT_NAME");
    // Names the variable, compose's rule, and both ways out.
    expect(refusal.message).toContain("COMPOSE_PROJECT_NAME=Cinatra_Cinatra");
    expect(refusal.message).toContain("lowercase alphanumeric characters, hyphens and underscores");
    expect(refusal.message).toContain("COMPOSE_PROJECT_NAME=cinatra_cinatra");
  });

  // The same rule for a name that is not merely mis-cased but unusable outright.
  it("refuses a stated project name with characters compose forbids", () => {
    const result = resolveComposeHostPortPlan({
      projectName: "Cinatra!",
      defaultProjectName: "/Users/dev/src/cinatra",
    });
    expect(result.laneScope).not.toBe("checkout");
    expect(result.refusals.some((r) => r.reason === "project-name-not-canonical")).toBe(true);
  });

  // Whitespace is a character compose forbids too, and it is the one that
  // survives a trim. ` cinatra` trimmed to a canonical `cinatra` and was
  // classified as this checkout's own no-op pin — the operator's stated value
  // silently rewritten into a name they never asked for, on a run that then
  // continued. Compose rejects the raw value outright.
  it("refuses a stated name whose only defect is leading whitespace", () => {
    const result = resolveComposeHostPortPlan({
      projectName: " cinatra",
      defaultProjectName: "/Users/dev/src/cinatra",
    });
    expect(result.laneScope).not.toBe("checkout");
    const refusal = result.refusals.find((r) => r.reason === "project-name-not-canonical");
    expect(refusal).toBeDefined();
    // Quoted, or the whole defect is invisible in the message that reports it.
    expect(refusal.message).toContain(`COMPOSE_PROJECT_NAME=" cinatra"`);
    expect(refusal.message).toContain("lowercase alphanumeric characters, hyphens and underscores");
    // Both ways out, one of which is the name they probably meant.
    expect(refusal.message).toContain("COMPOSE_PROJECT_NAME=cinatra instead");
    expect(refusal.message).toContain(`unset COMPOSE_PROJECT_NAME`);
  });

  it("refuses a trailing-whitespace name the same way", () => {
    const result = resolveComposeHostPortPlan({
      projectName: "p2839 ",
      defaultProjectName: "/Users/dev/src/cinatra",
    });
    expect(result.refusals.some((r) => r.reason === "project-name-not-canonical")).toBe(true);
  });

  // A stated-but-empty name is a CONFIG ERROR, not an unscoped checkout. Trimmed
  // to empty it read as "nothing stated at all" and landed in `unscoped` — the
  // one scope nothing here may refuse — so the step emitted no project-name line
  // and the invalid ambient value survived into every later compose invocation,
  // failing late with compose's own error. That is the exact late failure this
  // guard exists to prevent; see the evaluated-shell test in section 3a.
  it("refuses a whitespace-only name instead of reading it as unscoped", () => {
    const result = resolveComposeHostPortPlan({
      projectName: "   ",
      defaultProjectName: "/Users/dev/src/cinatra",
    });
    expect(result.laneScope).not.toBe("unscoped");
    const refusal = result.refusals.find((r) => r.reason === "project-name-not-canonical");
    expect(refusal).toBeDefined();
    expect(refusal.envVar).toBe("COMPOSE_PROJECT_NAME");
    expect(refusal.message).toContain(`COMPOSE_PROJECT_NAME="   "`);
    // Nothing to suggest instead — it normalizes to nothing at all.
    expect(refusal.message).toContain("Choose a name matching that rule");
    expect(refusal.message).toContain("unset COMPOSE_PROJECT_NAME");
  });

  // The unscoped checkout is still reached the only two ways a shell can say
  // "no value": the variable absent, or set to the empty string.
  it("still reads an absent or empty project name as the unscoped checkout", () => {
    for (const projectName of [undefined, ""]) {
      const result = resolveComposeHostPortPlan({
        projectName,
        defaultProjectName: "/Users/dev/src/cinatra",
        processEnv: {},
      });
      expect(result.laneScope).toBe("unscoped");
      expect(result.refusals).toEqual([]);
      expect(result.portEnv.CINATRA_REDIS_HOST_PORT).toBe("6379");
    }
  });

  // The pin that IS a no-op: already canonical, and exactly the name compose
  // derives from this directory. Still `checkout`, still lenient.
  it("treats an already-canonical pin of the derived name as this checkout", () => {
    const result = resolveComposeHostPortPlan({
      projectName: "cinatra_cinatra",
      defaultProjectName: "/Users/dev/src/cinatra_cinatra",
    });
    expect(result.laneScope).toBe("checkout");
    expect(result.refusals).toEqual([]);
  });

  // An explicit port for every scoped service is a complete lane: no refusal,
  // no URL required.
  it("is satisfied by explicit CINATRA_*_HOST_PORT claims alone", () => {
    const result = plan({
      processEnv: {
        CINATRA_NANGO_SERVER_HOST_PORT: "13003",
        CINATRA_NANGO_DB_HOST_PORT: "15435",
        CINATRA_REDIS_HOST_PORT: "16379",
      },
    });
    expect(result.refusals).toEqual([]);
    expect(result.portEnv.CINATRA_NANGO_CONNECT_HOST_PORT).toBe("13009");
  });
});

// Review round 2, item 2. The companion port is nangoServerPort + 6, so a server
// port in 65530-65535 derives something that is not a port at all. Falling back
// to the global 3009 there broke BOTH of the properties the offset exists for:
// the companion stopped following its own container, and every lane in that band
// landed on the one shared default.
describe("resolveComposeHostPortPlan — companion-port overflow is refused, not defaulted", () => {
  const lane = (serverPort) =>
    resolveComposeHostPortPlan({
      projectName: "p2839",
      processEnv: {
        NANGO_SERVER_URL: `http://127.0.0.1:${serverPort}`,
        NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
        REDIS_URL: "redis://127.0.0.1:16379",
      },
    });

  // 65529 is the last server port whose companion still fits (65529 + 6 =
  // 65535); 65530 is the first that does not.
  it("derives right up to the boundary", () => {
    expect(lane(65529).portEnv).toMatchObject({
      CINATRA_NANGO_SERVER_HOST_PORT: "65529",
      CINATRA_NANGO_CONNECT_HOST_PORT: "65535",
    });
    expect(lane(65529).refusals).toEqual([]);
  });

  it("refuses every server port whose companion overflows", () => {
    for (const serverPort of [65530, 65531, 65532, 65533, 65534, 65535]) {
      const result = lane(serverPort);
      expect(result.refusals.map((r) => r.reason)).toEqual(["companion-port-overflow"]);
      // Never the shared default, which is what made this a collision bug and
      // not merely a wrong number.
      expect(result.portEnv.CINATRA_NANGO_CONNECT_HOST_PORT).toBeUndefined();
      expect(Object.values(result.portEnv)).not.toContain("3009");
      // The server port it derives FROM is still resolved, so the message can
      // name the real culprit.
      expect(result.portEnv.CINATRA_NANGO_SERVER_HOST_PORT).toBe(String(serverPort));
    }
  });

  it("tells the operator which port to lower, and to what", () => {
    const [message] = planMessages(lane(65533).refusals);
    expect(message).toContain("CINATRA_NANGO_SERVER_HOST_PORT=65533");
    expect(message).toContain("65539"); // the value that is not a port
    expect(message).toContain("at most 65529"); // the actionable ceiling
  });

  // The UNSCOPED half of the same rule, which the refusal used to swallow: this
  // branch's own immunity says nothing may refuse the operator's single stack,
  // and the explicit override is honored on an unscoped checkout, so the
  // overflow band was reachable there and took `make dev` away. There is also no
  // second stack for the fallback to collide with, so the historical default is
  // the right answer. Found in Codex convergence on this round's diff.
  it("warns and publishes the default instead of refusing the unscoped checkout", () => {
    const result = resolveComposeHostPortPlan({
      processEnv: { CINATRA_NANGO_SERVER_HOST_PORT: "65530" },
    });
    expect(result.laneScope).toBe("unscoped");
    expect(result.refusals).toEqual([]);
    expect(result.warnings.map((w) => w.reason)).toEqual(["companion-port-overflow"]);
    expect(result.portEnv.CINATRA_NANGO_SERVER_HOST_PORT).toBe("65530");
    expect(result.portEnv.CINATRA_NANGO_CONNECT_HOST_PORT).toBe("3009");
    // It says only what this step can know. Whether some other stack on the host
    // already holds 3009 is a bind-time answer, and the message does not claim
    // to have it. (Codex round 7.)
    const [warning] = planMessages(result.warnings);
    expect(warning).toContain("the port it would have published anyway");
    expect(warning).toContain("a bind-time answer this step cannot give");
  });

  // …and the fallback port is itself just another claim: if something else in the
  // plan already holds it, the finished-plan uniqueness check says so, and the
  // overflow warning must not have promised otherwise. (Codex round 2.)
  it("does not promise the fallback is free when the plan itself claims it", () => {
    const result = resolveComposeHostPortPlan({
      processEnv: {
        CINATRA_NANGO_SERVER_HOST_PORT: "65530", // companion overflows → falls back to 3009
        CINATRA_REDIS_HOST_PORT: "3009", // …which this already claims
      },
    });
    expect(result.refusals).toEqual([]);
    expect(result.warnings.map((w) => w.reason)).toEqual([
      "companion-port-overflow",
      "duplicate-host-port",
    ]);
    const [overflow, duplicate] = planMessages(result.warnings);
    expect(overflow).not.toContain("collides with nothing");
    expect(overflow).toContain("reported by the uniqueness check");
    expect(duplicate).toContain("host port 3009 is claimed twice");
  });

  // Same band reached through the explicit override rather than the URL.
  it("refuses an overflowing companion behind an explicit server-port override", () => {
    const result = resolveComposeHostPortPlan({
      projectName: "p2839",
      processEnv: {
        CINATRA_NANGO_SERVER_HOST_PORT: "65534",
        CINATRA_NANGO_DB_HOST_PORT: "15435",
        CINATRA_REDIS_HOST_PORT: "16379",
      },
    });
    expect(result.refusals.map((r) => r.reason)).toEqual(["companion-port-overflow"]);
  });

  // An operator who states the connect port outright is not guessing, so there
  // is nothing to refuse.
  it("accepts an overflowing server port when the companion is stated outright", () => {
    const result = resolveComposeHostPortPlan({
      projectName: "p2839",
      processEnv: {
        CINATRA_NANGO_SERVER_HOST_PORT: "65534",
        CINATRA_NANGO_CONNECT_HOST_PORT: "13009",
        CINATRA_NANGO_DB_HOST_PORT: "15435",
        CINATRA_REDIS_HOST_PORT: "16379",
      },
    });
    expect(result.refusals).toEqual([]);
    expect(result.portEnv.CINATRA_NANGO_CONNECT_HOST_PORT).toBe("13009");
  });
});

// Review round 2, item 4. An INVALID ambient CINATRA_*_HOST_PORT was rejected
// and then nothing was emitted in its place — but omitting a key cannot unset a
// variable: `createComposeRunner` spreads the plan OVER the ambient environment,
// and an `eval` that prints no line for a key leaves the shell's own value
// standing. The rejected value reached compose either way.
describe("resolveComposeHostPortPlan — a rejected ambient override is replaced, not dropped", () => {
  const INVALID = ["abc", "0", "-1", "65536", "13003:13003", "13 003"];

  it("publishes the historical default in its place on the unscoped checkout", () => {
    for (const bad of INVALID) {
      const result = resolveComposeHostPortPlan({
        processEnv: { CINATRA_REDIS_HOST_PORT: bad },
      });
      // The KEY IS PRESENT — that is the fix. An omitted key leaves `bad` in
      // place in the environment compose interpolates from.
      expect(result.portEnv.CINATRA_REDIS_HOST_PORT).toBe("6379");
      expect(result.warnings.map((w) => w.reason)).toEqual(["invalid-host-port-override"]);
      expect(planMessages(result.warnings)[0]).toContain(bad);
    }
  });

  it("refuses it on a named lane rather than guessing a port", () => {
    const result = resolveComposeHostPortPlan({
      projectName: "p2839",
      processEnv: {
        CINATRA_REDIS_HOST_PORT: "not-a-port",
        NANGO_SERVER_URL: "http://127.0.0.1:13003",
        NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
        REDIS_URL: "redis://127.0.0.1:16379", // stated, and still not guessed at
      },
    });
    expect(result.refusals.map((r) => r.reason)).toEqual(["invalid-host-port-override"]);
    expect(planMessages(result.refusals)[0]).toContain("CINATRA_REDIS_HOST_PORT=not-a-port");
  });

  // Where it actually bit: the unmanaged branch. The service is configured
  // elsewhere, so the plan emitted no key — and the invalid ambient value sailed
  // through to compose as the published host port.
  it("does not let an invalid ambient value survive a stand-down", () => {
    const processEnv = {
      PATH: "/usr/bin",
      CINATRA_REDIS_HOST_PORT: "nope",
      REDIS_URL: "rediss://cache.example.com:6380", // not ours to publish
    };
    const scoped = resolveComposeHostPortPlan({
      projectName: "p2839",
      defaultProjectName: "/src/cinatra",
      processEnv,
    });
    // A lane refuses outright, so nothing is spawned at all (asserted below).
    expect(scoped.refusals.map((r) => r.envVar)).toContain("CINATRA_REDIS_HOST_PORT");

    // Unscoped, the same ambient value is REPLACED by the historical default
    // rather than left standing.
    const unscoped = resolveComposeHostPortPlan({ processEnv });
    expect(unscoped.portEnv.CINATRA_REDIS_HOST_PORT).toBe("6379");
  });

  // An empty or whitespace-only value is "not stated", not "stated wrongly" —
  // an exported-but-empty shell variable must not become a refusal.
  it("treats an empty ambient value as unset", () => {
    const result = resolveComposeHostPortPlan({
      processEnv: { CINATRA_REDIS_HOST_PORT: "   " },
    });
    expect(result.warnings).toEqual([]);
    expect(result.portEnv.CINATRA_REDIS_HOST_PORT).toBe("6379");
  });
});

// Round-3 non-blocking item: a worktree naming its project after its own
// directory classified as `checkout`, so a missing URL only warned and then
// published the shared default — into the operator's stack. The residual the
// review said "needs a main-worktree probe". This is that probe.
describe("isLinkedWorktree — the main-checkout probe", () => {
  let root;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "cinatra-2839-wt-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const fixture = (name, build) => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    build(dir);
    return dir;
  };

  it("reads a `.git` DIRECTORY as the main checkout", () => {
    const dir = fixture("main", (d) => mkdirSync(path.join(d, ".git")));
    expect(isLinkedWorktree(dir)).toBe(false);
  });

  it("reads a `.git` FILE pointing at a worktree admin dir as a linked worktree", () => {
    const dir = fixture("linked", (d) => {
      // The shape `git worktree add` really writes: a pointer file, and an admin
      // directory carrying `commondir` (and `gitdir`) back to the shared repo.
      const admin = path.join(root, "repo.git", "worktrees", "lane");
      mkdirSync(admin, { recursive: true });
      writeFileSync(path.join(admin, "commondir"), "../..\n");
      writeFileSync(path.join(d, ".git"), `gitdir: ${admin}\n`);
    });
    expect(isLinkedWorktree(dir)).toBe(true);
  });

  // `git clone --separate-git-dir` writes a `.git` FILE in a MAIN checkout too.
  // Stopping at "is it a file?" called the operator's own single checkout a
  // second stack and applied the lane refusals to it. (Codex round 4.)
  it("reads a --separate-git-dir MAIN checkout as the main checkout", () => {
    const dir = fixture("separate", (d) => {
      const repo = path.join(root, "elsewhere.git");
      mkdirSync(repo, { recursive: true });
      writeFileSync(path.join(repo, "HEAD"), "ref: refs/heads/main\n"); // no commondir
      writeFileSync(path.join(d, ".git"), `gitdir: ${repo}\n`);
    });
    expect(isLinkedWorktree(dir)).toBe(false);
  });

  it("resolves a RELATIVE gitdir against the checkout, as git may write it", () => {
    const dir = fixture("relative", (d) => {
      const admin = path.join(d, "..", "rel.git", "worktrees", "lane");
      mkdirSync(admin, { recursive: true });
      writeFileSync(path.join(admin, "commondir"), "../..\n");
      writeFileSync(path.join(d, ".git"), "gitdir: ../rel.git/worktrees/lane\n");
    });
    expect(isLinkedWorktree(dir)).toBe(true);
  });

  it("is conservative about anything that is not demonstrably a second checkout", () => {
    const dir = fixture("bare", () => {});
    expect(isLinkedWorktree(dir)).toBe(false);
    // A `.git` file that names nothing, or names a path that is not there.
    const junk = fixture("junk", (d) => writeFileSync(path.join(d, ".git"), "not a pointer\n"));
    expect(isLinkedWorktree(junk)).toBe(false);
    const dangling = fixture("dangling", (d) =>
      writeFileSync(path.join(d, ".git"), "gitdir: /nowhere/.git/worktrees/gone\n"),
    );
    expect(isLinkedWorktree(dangling)).toBe(false);
    // A gitfile is `gitdir: <path>` and nothing else, space mandatory — a note
    // above it, junk below it, or a missing space is not a pointer git would
    // read either. (Codex rounds 5 and 6.)
    const withAdmin = (name, body) =>
      fixture(name, (d) => {
        const admin = path.join(root, `${name}.git`, "worktrees", "lane");
        mkdirSync(admin, { recursive: true });
        writeFileSync(path.join(admin, "commondir"), "../..\n");
        writeFileSync(path.join(d, ".git"), body(admin));
      });
    expect(isLinkedWorktree(withAdmin("buried", (a) => `# a stray note\ngitdir: ${a}\n`))).toBe(
      false,
    );
    expect(isLinkedWorktree(withAdmin("trailing", (a) => `gitdir: ${a}\n# junk below\n`))).toBe(
      false,
    );
    expect(isLinkedWorktree(withAdmin("nospace", (a) => `gitdir:${a}\n`))).toBe(false);
    // Two spaces: git keeps the second one as part of the path, so it names a
    // directory that is not there. Eating it here would have this probe and git
    // disagree about which directory was named. (Codex round 8.)
    expect(isLinkedWorktree(withAdmin("twospace", (a) => `gitdir:  ${a}\n`))).toBe(false);
    // A trailing SPACE is part of the path, not padding to strip: stripping it
    // would read a directory git does not name. Stricter than git here is fine —
    // it lands on "the main checkout", which changes nothing. (Codex round 9.)
    expect(isLinkedWorktree(withAdmin("trailspace", (a) => `gitdir: ${a} \n`))).toBe(false);
    // CRLF is a line ending, not path content.
    expect(isLinkedWorktree(withAdmin("crlf", (a) => `gitdir: ${a}\r\n`))).toBe(true);
    // …and the well-formed one, built the same way, still reads as linked.
    expect(isLinkedWorktree(withAdmin("wellformed", (a) => `gitdir: ${a}\n`))).toBe(true);
    // …and `commondir` must be a regular FILE, not merely a name on disk.
    const dirCommon = fixture("dircommon", (d) => {
      const admin = path.join(root, "dircommon.git", "worktrees", "lane");
      mkdirSync(path.join(admin, "commondir"), { recursive: true });
      writeFileSync(path.join(d, ".git"), `gitdir: ${admin}\n`);
    });
    expect(isLinkedWorktree(dirCommon)).toBe(false);
    expect(isLinkedWorktree(path.join(root, "does-not-exist"))).toBe(false);
    expect(isLinkedWorktree("")).toBe(false);
    expect(isLinkedWorktree(undefined)).toBe(false);
  });

  // The one that keeps the entry-point branch below from being a tautology: the
  // cheap stat probe must agree with git's own answer for the checkout this
  // suite is running in, whichever kind that is.
  it("agrees with git's own answer for this checkout", () => {
    expect(isLinkedWorktree(REPO_ROOT)).toBe(REPO_IS_LINKED_WORKTREE);
  });
});

describe("resolveComposeHostPortPlan — a linked worktree is never the operator's checkout", () => {
  // The worktree's own basename, pinned as its project name: canonical, and
  // exactly what compose would derive here anyway.
  const WORKTREE = "/Users/dev/cinatra-worktrees/x2839";
  const pinnedToOwnBasename = (linkedWorktree) =>
    resolveComposeHostPortPlan({
      envFileLookup: () => undefined, // no service URL stated — the leaky case
      projectName: "x2839",
      defaultProjectName: WORKTREE,
      linkedWorktree,
    });

  it("warns and publishes the defaults when it IS the main checkout", () => {
    const plan = pinnedToOwnBasename(false);
    expect(plan.laneScope).toBe("checkout");
    expect(plan.refusals).toEqual([]);
    expect(plan.portEnv.CINATRA_REDIS_HOST_PORT).toBe("6379");
    expect(planMessages(plan.warnings).join("\n")).toContain("collide on 6379");
  });

  it("refuses the same pin from a linked worktree instead of warning", () => {
    const plan = pinnedToOwnBasename(true);
    expect(plan.laneScope).toBe("lane");
    expect(plan.warnings).toEqual([]);
    expect(plan.refusals.map((r) => r.reason)).toEqual([
      "missing-service-url",
      "missing-service-url",
      "missing-service-url",
    ]);
    // Nothing is handed the shared default behind that refusal.
    expect(plan.portEnv.CINATRA_REDIS_HOST_PORT).toBeUndefined();
    expect(planMessages(plan.refusals).join("\n")).toContain("REDIS_URL is not stated");
  });

  it("still resolves a worktree that states its ports, refusing nothing", () => {
    const plan = resolveComposeHostPortPlan({
      envFileLookup: (key) =>
        ({
          NANGO_SERVER_URL: "http://127.0.0.1:13003",
          NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
          REDIS_URL: "redis://127.0.0.1:16379",
        })[key],
      projectName: "x2839",
      defaultProjectName: WORKTREE,
      linkedWorktree: true,
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.portEnv).toEqual({
      CINATRA_NANGO_SERVER_HOST_PORT: "13003",
      CINATRA_NANGO_CONNECT_HOST_PORT: "13009",
      CINATRA_NANGO_DB_HOST_PORT: "15435",
      CINATRA_REDIS_HOST_PORT: "16379",
    });
  });

  // The immunity that outranks everything here: the unscoped single-stack flow
  // is not refusable, and the probe must not become a back door into refusing it.
  it("leaves the UNSCOPED checkout untouched even inside a linked worktree", () => {
    const plan = resolveComposeHostPortPlan({
      defaultProjectName: WORKTREE,
      linkedWorktree: true,
    });
    expect(plan.laneScope).toBe("unscoped");
    expect(plan.refusals).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.portEnv).toEqual({
      CINATRA_NANGO_SERVER_HOST_PORT: "3003",
      CINATRA_NANGO_CONNECT_HOST_PORT: "3009",
      CINATRA_NANGO_DB_HOST_PORT: "5435",
      CINATRA_REDIS_HOST_PORT: "6379",
    });
  });

  it("defaults to the main checkout, so an unprobed caller behaves as before", () => {
    const plan = resolveComposeHostPortPlan({
      envFileLookup: () => undefined,
      projectName: "x2839",
      defaultProjectName: WORKTREE,
    });
    expect(plan.laneScope).toBe("checkout");
  });
});

// Round-3 non-blocking item: every rule decides ONE service in isolation, so a
// plan could be individually correct and collectively impossible. The reviewer's
// own case is the first test here.
describe("resolveComposeHostPortPlan — the finished plan claims each host port once", () => {
  it("refuses the lane whose derived companion lands on another scoped port", () => {
    const plan = resolveComposeHostPortPlan({
      envFileLookup: (key) =>
        ({
          // 16373 + 6 = 16379, which is the very port REDIS_URL claims.
          NANGO_SERVER_URL: "http://127.0.0.1:16373",
          NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
          REDIS_URL: "redis://127.0.0.1:16379",
        })[key],
      projectName: "p2839",
    });
    const duplicate = plan.refusals.filter((r) => r.reason === "duplicate-host-port");
    expect(duplicate).toHaveLength(1);
    const message = duplicate[0].message;
    expect(message).toContain("host port 16379 is claimed twice");
    expect(message).toContain("CINATRA_NANGO_CONNECT_HOST_PORT");
    expect(message).toContain("CINATRA_REDIS_HOST_PORT");
    // It names the DECIDING source of each claim: one port nobody typed, one read
    // off the URL that did.
    expect(message).toContain(
      "the nango-server container publishes it alongside CINATRA_NANGO_SERVER_HOST_PORT=16373, " +
        "so it follows that port by +6",
    );
    expect(message).toContain("read from REDIS_URL=redis://127.0.0.1:16379");
  });

  it("says nothing about a lane whose four ports are already distinct", () => {
    const plan = resolveComposeHostPortPlan({
      envFileLookup: (key) =>
        ({
          NANGO_SERVER_URL: "http://127.0.0.1:13003",
          NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
          REDIS_URL: "redis://127.0.0.1:16379",
        })[key],
      projectName: "p2839",
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it("leaves the bundled defaults alone — they collide with nothing", () => {
    const plan = resolveComposeHostPortPlan({});
    expect(plan.refusals).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it("catches two explicit overrides that claim the same port", () => {
    const plan = resolveComposeHostPortPlan({
      processEnv: {
        CINATRA_NANGO_DB_HOST_PORT: "15435",
        CINATRA_REDIS_HOST_PORT: "15435",
      },
      envFileLookup: (key) =>
        ({
          NANGO_SERVER_URL: "http://127.0.0.1:13003",
        })[key],
      projectName: "p2839",
    });
    const duplicate = plan.refusals.filter((r) => r.reason === "duplicate-host-port");
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0].message).toContain("stated directly as CINATRA_NANGO_DB_HOST_PORT=15435");
    expect(duplicate[0].message).toContain("stated directly as CINATRA_REDIS_HOST_PORT=15435");
  });

  // The unscoped checkout is reachable too — the companion derives there as
  // well — and it is the one scope nothing may refuse. It gets the warning.
  it("warns, never refuses, on the unscoped checkout", () => {
    const plan = resolveComposeHostPortPlan({
      // 6373 + 6 = 6379, the redis default this checkout also publishes.
      processEnv: { CINATRA_NANGO_SERVER_HOST_PORT: "6373" },
    });
    expect(plan.laneScope).toBe("unscoped");
    expect(plan.refusals).toEqual([]);
    const duplicate = plan.warnings.filter((w) => w.reason === "duplicate-host-port");
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0].message).toContain("host port 6379 is claimed twice");
    // The claims still stand exactly as resolved; nothing is quietly rewritten.
    expect(plan.portEnv.CINATRA_NANGO_CONNECT_HOST_PORT).toBe("6379");
    expect(plan.portEnv.CINATRA_REDIS_HOST_PORT).toBe("6379");
  });

  // A service that stood down claims no port at all, so it cannot collide with
  // one — the check must read the finished plan, not the service list.
  it("ignores a service this checkout does not publish", () => {
    const plan = resolveComposeHostPortPlan({
      envFileLookup: (key) =>
        ({
          NANGO_SERVER_URL: "http://127.0.0.1:16373",
          NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
          // Configured elsewhere → no claim on 16379, so the companion's 16379
          // is the only claim on it.
          REDIS_URL: "rediss://cache.example.com:16379",
        })[key],
      projectName: "p2839",
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.portEnv.CINATRA_NANGO_CONNECT_HOST_PORT).toBe("16379");
    expect(plan.portEnv.CINATRA_REDIS_HOST_PORT).toBeUndefined();
  });
});

// The branch's own stated immunity, asserted as ONE invariant rather than
// re-derived per rule. Every refusal reason this module can produce is reached
// from a named lane below; none of them may reach the unscoped checkout, which
// is the operator's single `make dev` stack. A rule added later that forgets its
// unscoped half fails here.
describe("resolveComposeHostPortPlan — the unscoped checkout is never refused", () => {
  const CASES = {
    "missing service URL": { envFileLookup: () => undefined },
    "an unusable explicit override": {
      processEnv: { CINATRA_REDIS_HOST_PORT: "not-a-port" },
    },
    "a companion port that overflows": {
      processEnv: { CINATRA_NANGO_SERVER_HOST_PORT: "65530" },
    },
    "one host port claimed twice": {
      processEnv: { CINATRA_NANGO_SERVER_HOST_PORT: "6373" },
    },
    "a service configured somewhere else": {
      envFileLookup: (key) => (key === "REDIS_URL" ? "rediss://cache.example.com:6380" : undefined),
    },
  };

  for (const [what, input] of Object.entries(CASES)) {
    it(`refuses a named lane on ${what}, and never the unscoped checkout`, () => {
      const lane = resolveComposeHostPortPlan({ ...input, projectName: "p2839" });
      const unscoped = resolveComposeHostPortPlan(input);

      expect(unscoped.laneScope).toBe("unscoped");
      expect(unscoped.refusals).toEqual([]);
      // …and it is still handed a complete, publishable plan.
      for (const spec of PREFLIGHT_HOST_PORTS) {
        expect(Object.keys(unscoped.portEnv)).toContain(spec.envVar);
      }

      // The same input on a lane is a refusal or a stand-down — proof that the
      // case really is one the module acts on, not an inert input.
      expect(lane.refusals.length + lane.unmanaged.length).toBeGreaterThan(0);
    });
  }
});

// The line between the two tests, recorded so it is a choice and not an
// accident (Codex round 3 asked which one governs the `checkout` scope). It
// divides on what the checkout STATED, not on how big the blast radius is.
describe("resolveComposeHostPortPlan — the operator's own pin: stated vs omitted", () => {
  const OWN = { projectName: "cinatra", defaultProjectName: "/Users/dev/src/cinatra" };

  it("only WARNS about what the checkout merely omits", () => {
    const plan = resolveComposeHostPortPlan({ ...OWN, envFileLookup: () => undefined });
    expect(plan.laneScope).toBe("checkout");
    expect(plan.refusals).toEqual([]);
    expect(plan.warnings.map((w) => w.reason)).toContain("shared-default-on-named-checkout");
    expect(plan.portEnv.CINATRA_REDIS_HOST_PORT).toBe("6379");
  });

  // …and REFUSES what it states and cannot publish. Compose fails on each of
  // these anyway, so failing here — naming the variable and the rule — is
  // strictly earlier and clearer than failing at bind time.
  const STATED = {
    "an unusable explicit override": {
      processEnv: { CINATRA_REDIS_HOST_PORT: "not-a-port" },
      reason: "invalid-host-port-override",
    },
    "a companion port that overflows": {
      processEnv: { CINATRA_NANGO_SERVER_HOST_PORT: "65530" },
      reason: "companion-port-overflow",
    },
    "two URLs that claim one port": {
      envFileLookup: (key) =>
        ({
          NANGO_SERVER_URL: "http://127.0.0.1:16373",
          REDIS_URL: "redis://127.0.0.1:16379",
        })[key],
      reason: "duplicate-host-port",
    },
  };

  for (const [what, { reason, ...input }] of Object.entries(STATED)) {
    it(`refuses ${what}, pin or no pin`, () => {
      const plan = resolveComposeHostPortPlan({ ...OWN, ...input });
      expect(plan.laneScope).toBe("checkout");
      expect(plan.refusals.map((r) => r.reason)).toContain(reason);
    });
  }
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

// Round-3 non-blocking item: two diagnostics still PRINTED a bare bring-up that
// diverged from every guarded entry point. A pasted `docker compose up` is
// unpinned (the step is what exports COMPOSE_PROJECT_NAME, which Docker never
// reads from `.env.local`) and unguarded (it skips every refusal).
describe("printed bring-ups are the guarded chain, not a bare compose up", () => {
  const guarded = formatGuardedComposeCommand({ args: ["up", "-d"], requireManageable: true });

  it("assigns the step's output, evals it, and only then runs compose", () => {
    expect(guarded).toBe(
      `CINATRA_COMPOSE_ENV="$(node scripts/dev-compose-env.mjs --require-manageable)" && ` +
        `eval "$CINATRA_COMPOSE_ENV" && ` +
        `docker compose -f ${COMPOSE_FILES[0]} -f ${COMPOSE_FILES[1]} up -d`,
    );
  });

  // ASSIGN-then-eval, not `eval "$(…)"` — the exit status of a command
  // substitution inside `eval` is discarded, so a refusal would not stop the up.
  // The same shape the Makefile / package.json / setup.sh recipes use.
  it("never evals the step's output directly, so a refusal stops the chain", () => {
    expect(guarded).not.toMatch(/eval\s+"\$\(/);
    expect(guarded.indexOf("CINATRA_COMPOSE_ENV=\"$(")).toBeLessThan(guarded.indexOf("eval "));
  });

  it("drops --require-manageable for a bring-up that is not whole-stack", () => {
    expect(formatGuardedComposeCommand({ args: ["up", "-d", "graphiti"] })).not.toContain(
      "--require-manageable",
    );
  });

  // No `-p`: the eval puts COMPOSE_PROJECT_NAME into the shell compose inherits,
  // exactly as the real recipes do. Pinning here as well would print a command
  // no entry point runs, naming a project resolved somewhere other than the step
  // the ports came from.
  // No `-p`: the step's own `export COMPOSE_PROJECT_NAME` is what pins the
  // project, and the eval puts it in the shell compose inherits. Pinning here
  // as well would print a command no entry point runs, naming a project resolved
  // somewhere other than the step the ports came from.
  it("leaves the project pin to the step's own export", () => {
    expect(guarded).not.toContain(" -p ");
    // A COMPLETE lane, stated in the environment so the repo's own `.env.local`
    // (present on a dev machine, absent in CI) cannot change what this observes.
    const env = { ...process.env };
    for (const spec of PREFLIGHT_HOST_PORTS) delete env[spec.envVar];
    Object.assign(env, {
      COMPOSE_PROJECT_NAME: "p2839",
      NANGO_SERVER_URL: "http://127.0.0.1:13003",
      NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
      REDIS_URL: "redis://127.0.0.1:16379",
    });
    const step = spawnSync(process.execPath, [DEV_COMPOSE_ENV], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      env,
    });
    expect(step.status).toBe(0);
    expect(step.stdout).toContain("export COMPOSE_PROJECT_NAME='p2839'");
  });

  it("is what the drift remedy prints", () => {
    const remedy = formatDriftRemedy(["Redis"]);
    expect(remedy).toContain(guarded);
    // …and the pre-fix line is gone: every COMMAND line the remedy offers (the
    // indented ones — prose about the cause is not a command) goes through the
    // step. The bare bring-up it used to print does not appear.
    const commands = remedy.split("\n").filter((line) => /^\s{4}\S/.test(line));
    expect(commands.length).toBeGreaterThan(0);
    for (const line of commands) {
      if (!line.includes("docker compose")) continue;
      expect(line).toContain("dev-compose-env.mjs");
    }
    expect(remedy).not.toContain(
      "# or: docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d",
    );
  });

  it("is what check-services.mjs prints", () => {
    const source = readFileSync(path.join(REPO_ROOT, "scripts", "check-services.mjs"), "utf8");
    expect(source).toContain("formatGuardedComposeCommand");
    // The pre-fix literal, byte for byte, is gone from the file.
    expect(source).not.toContain(
      "docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d",
    );
  });

  // The remedy and the real recipe are one builder, so they cannot fork. Read
  // off the Makefile so a future edit to either side has to break this.
  it("prints the same guard shape the Makefile actually runs", () => {
    const makefile = readFileSync(path.join(REPO_ROOT, "Makefile"), "utf8");
    const recipe = makefile
      .split("\n")
      .find((line) => line.includes("CINATRA_COMPOSE_ENV") && line.includes("docker compose"));
    expect(recipe, "the Makefile dev target should carry the guarded chain").toBeDefined();
    // `make` doubles the `$` for its own expansion; compare the shell text.
    const shell = recipe.trim().replace(/\$\$/g, "$");
    expect(shell.startsWith('CINATRA_COMPOSE_ENV="$(node scripts/dev-compose-env.mjs')).toBe(true);
    expect(shell).toContain('&& eval "$CINATRA_COMPOSE_ENV" && docker compose');
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

  // Round-1 non-blocking item 3: this reader is shared, so the inline-comment
  // rule also changes how PORT and the service DSNs are read
  // (scripts/dev-server.mjs). That widening is deliberate — pin BOTH halves of
  // it at the consumer contract, `parseHostPort(readEnvFileValue(...))`, which
  // is exactly how dev-server.mjs's envHostPort() resolves a bundled service.
  it("hands the DSN consumer a value it can parse, comment or no comment", () => {
    const file = path.join(dir, "dsn.env");
    writeFileSync(
      file,
      [
        // Annotated: previously parsed to no host port at all, so the drift
        // guard silently compared against the bundled default instead.
        "ANNOTATED=redis://127.0.0.1:16379 # the lane cache",
        // A `#` that is part of the value: must survive untouched, or the
        // launcher would probe the wrong port and mis-report drift.
        "PW_HASH=postgresql://postgres:pa%23ssword@127.0.0.1:15434/postgres",
        "PW_RAW_HASH=postgresql://postgres:pa#ssword@127.0.0.1:15434/postgres",
        "PORT_ANNOTATED=13839 # lane port",
      ].join("\n"),
    );
    const fallback = { host: "127.0.0.1", port: 6379 };

    expect(parseHostPort(readEnvFileValue(file, "ANNOTATED"), fallback)).toEqual({
      host: "127.0.0.1",
      port: 16379,
    });
    expect(parseHostPort(readEnvFileValue(file, "PW_HASH"), fallback)).toEqual({
      host: "127.0.0.1",
      port: 15434,
    });
    // A RAW `#` in a password is not valid DSN syntax — WHATWG reads it as the
    // start of a fragment, so parseHostPort falls back, exactly as it does on
    // `main`. What matters for this reader is that the value reaches the parser
    // WHOLE: the truncation the comment rule could have caused does not happen.
    expect(readEnvFileValue(file, "PW_RAW_HASH")).toBe(
      "postgresql://postgres:pa#ssword@127.0.0.1:15434/postgres",
    );
    // PORT is handed to Next.js verbatim, so it must come out as a bare number.
    expect(readEnvFileValue(file, "PORT_ANNOTATED")).toBe("13839");
  });
});

// ---------------------------------------------------------------------------
// 1b. The OTHER door to Docker: the read-only drift diagnosis
// ---------------------------------------------------------------------------

// Round-1 non-blocking item 2: the "single chokepoint" claim was overstated —
// diagnoseDockerPortDrift spawns `docker` itself and never passes through
// createComposeRunner. It now carries the same guard on its own spawning
// function, and builds its compose argv from the shared builder.
describe("diagnoseDockerPortDrift guard", () => {
  let dir;
  let dockerLog;
  let originalPath;

  const SERVICE = {
    composeService: "redis",
    label: "Redis",
    containerPort: 6379,
    defaultHostPort: 6379,
    envVar: "REDIS_URL",
  };

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cinatra-2839-drift-"));
    dockerLog = path.join(dir, "docker-calls.log");
    const bin = path.join(dir, "bin");
    mkdirSync(bin, { recursive: true });
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

    originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    process.env.CINATRA_TEST_DOCKER_LOG = dockerLog;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    delete process.env.CINATRA_TEST_DOCKER_LOG;
    rmSync(dir, { recursive: true, force: true });
  });

  const calls = () =>
    existsSync(dockerLog)
      ? readFileSync(dockerLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];

  it("spawns NOTHING when the skip flag is set", () => {
    rmSync(dockerLog, { force: true });
    const result = diagnoseDockerPortDrift({
      service: SERVICE,
      mainRoot: dir,
      expectedHostPort: 6379,
      skip: true,
    });
    expect(result).toEqual({ available: false, skipped: true });
    expect(calls()).toEqual([]);
  });

  it("without the flag, builds its compose argv from the shared builder", () => {
    rmSync(dockerLog, { force: true });
    diagnoseDockerPortDrift({ service: SERVICE, mainRoot: dir, expectedHostPort: 6379 });
    const [first] = calls();
    expect(first, "the drift diagnosis should have shelled out").toBeDefined();
    expect(first.argv).toEqual(buildComposeArgs({ args: ["ps", "-aq", "redis"] }));
    // No `-p`: drift diagnosis inspects the MAIN checkout's shared stack, which
    // is compose's own basename-derived project — pinning a lane project here
    // would diagnose the wrong containers.
    expect(first.argv).not.toContain("-p");
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
      // Stated for the same reason a real lane must state it: a named lane with
      // no host port for a scoped service is refused, not defaulted (item 1).
      // Cases that name a project and want a heal must be complete lanes.
      NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
    };
    // Whatever the ambient shell carries, each case states its own inputs.
    delete env.CINATRA_SKIP_DEV_PREFLIGHT;
    delete env.COMPOSE_PROJECT_NAME;
    // A shell PORT outranks `.env.local` by design, so an ambient one would
    // hide what each case states in its own file.
    delete env.PORT;
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

  // The drift diagnosis is the launcher's OTHER door to Docker, and it only
  // opens when a service sits on its bundled DEFAULT host port (anything else
  // reads as "not our stack" and is skipped before any shell-out). Every other
  // case here pins lane ports, so this one states the defaults deliberately:
  // the configuration in which the read-only path WOULD spawn `docker`, still
  // zero calls behind the flag.
  it("makes zero docker calls on the drift path too, at the bundled default ports", () => {
    const result = runLauncher("PORT=13839\nCINATRA_SKIP_DEV_PREFLIGHT=1\n", {
      SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:5434/postgres",
      REDIS_URL: "redis://127.0.0.1:6379",
    });
    expectCleanRun(result);
    expect(result.calls).toEqual([]);
  });

  // Round-1 non-blocking item 3, end to end: the shared reader's inline-comment
  // rule also governs PORT. An annotated lane port must reach Next.js as a bare
  // number, not as `13839 # lane port`.
  it("resolves an annotated .env.local PORT to the bare port", () => {
    const result = runLauncher(
      ["PORT=13839 # lane port", "CINATRA_SKIP_DEV_PREFLIGHT=1", ""].join("\n"),
    );
    expectCleanRun(result);
    expect(result.stdout).toContain("[dev-server] PORT=13839 ");
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

    // Round-3 non-blocking item: `--no-deps` buys the stand-down, but it does
    // NOT re-point the container — nango-server reaches redis by the
    // project-internal name fixed in docker-compose.yml, so a genuinely external
    // one degrades to an unhealthy container. The launcher now says that up
    // front instead of leaving the operator to discover it after the poll.
    expect(result.stderr).toContain("does not re-point the container");
    expect(result.stderr).toContain("project-internal name fixed in docker-compose.yml");
    // …and it says RUNNING and reachable, not merely "exists": a stopped
    // container in the project resolves to nothing and is the same failure.
    expect(result.stderr).toContain("is RUNNING and reachable on this compose project's network");
    expect(result.stderr).toContain("start and stay");
    // The terminal "still not healthy" line also names the stranded dependency,
    // but it is not reachable here: the recording shim exits non-zero, so the
    // launcher takes the `compose up failed` branch and never reaches the
    // 60-second health poll. Asserted on the up-front warning, which is the line
    // an operator reads BEFORE the wait.
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

  // Review round 2, item 1, at the launcher. A named lane with no host port for
  // a scoped service has no safe thing to publish, so the heal does not run at
  // all — the refusal is enforced at the same chokepoint the skip flag is, not
  // printed and then ignored.
  it("makes zero docker calls when a named lane's plan cannot be resolved", () => {
    const result = runLauncher("PORT=13839\nCOMPOSE_PROJECT_NAME=p2839\n", {
      NANGO_DATABASE_URL: "", // the lane states no port for nango-db
    });
    expectCleanRun(result); // the app still boots; only Docker stands down
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain("NANGO_DATABASE_URL");
    expect(result.stderr).toContain("not touching Docker");
  });

  // Review round 2, item 2, at the launcher: the overflow band never reaches
  // compose carrying the shared 3009.
  it("makes zero docker calls when the companion port overflows", () => {
    const result = runLauncher("PORT=13839\nCOMPOSE_PROJECT_NAME=p2839\n", {
      CINATRA_NANGO_SERVER_HOST_PORT: "65533",
    });
    expectCleanRun(result);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain("65539");
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
      [
        "COMPOSE_PROJECT_NAME=p2839 # lane",
        "REDIS_URL=redis://127.0.0.1:16379",
        // A named lane states every scoped service or it is refused (item 1).
        "NANGO_SERVER_URL=http://127.0.0.1:13003",
        "NANGO_DATABASE_URL=postgresql://nango:nango@127.0.0.1:15435/nango",
        "",
      ].join("\n"),
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
      NANGO_DATABASE_URL: "postgresql://nango:nango@127.0.0.1:15435/nango",
      REDIS_URL: "rediss://cache.example.com:6380",
    };
    const result = runStep(inputs, ["--json"]);
    expect(result.status).toBe(0);
    const fromStep = JSON.parse(result.stdout);
    const fromLauncher = resolveComposeHostPortPlan({
      processEnv: inputs,
      projectName: "p2839",
      defaultProjectName: REPO_ROOT,
    });
    expect(fromStep.portEnv).toEqual(fromLauncher.portEnv);
    expect(fromStep.unmanaged).toEqual(fromLauncher.unmanaged);
    // Same for the two channels that decide whether anything runs at all.
    expect(fromStep.refusals).toEqual(fromLauncher.refusals);
    expect(fromStep.warnings).toEqual(fromLauncher.warnings);
    expect(fromStep.laneScope).toBe(fromLauncher.laneScope);

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
// 3a. The whole-stack entry points, driven as the shell actually runs them
// ---------------------------------------------------------------------------
//
// The equivalence tests above compare the step's PLAN with the launcher's. They
// never ran the `Makefile` / package.json line, so two things they could not see
// went wrong:
//
//   - `eval "$(node scripts/dev-compose-env.mjs)"` throws the step's exit status
//     away (eval of an empty string succeeds), so a refusal printed on stderr
//     was followed by `docker compose up` anyway.
//   - a whole-stack `up -d` cannot honor a per-service stand-down at all, so a
//     remote/portless service still started on its compose default there. The
//     step warned into a void.
//
// So these tests take the guard PREFIX out of the real Makefile recipe and the
// real npm script, assert the entry points agree on it, and run it through `sh`
// with a marker standing in for `docker compose up`. Reaching the marker means
// the real recipe would have reached the `up`.

describe("whole-stack entry points — the guard the Makefile and package.json actually run", () => {
  const SHARED_STEP = path.join(REPO_ROOT, "scripts", "dev-compose-env.mjs");
  const MAKEFILE = readFileSync(path.join(REPO_ROOT, "Makefile"), "utf8");
  const PKG = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

  // Plain throws, not `expect`, and called from inside the tests: an entry point
  // that loses the guard must fail a NAMED test, not the file's collection.
  /** The `assign → eval` prefix of one recipe, up to (not including) the `up`. */
  const guardOf = (commandLine) => {
    const start = commandLine.indexOf("CINATRA_COMPOSE_ENV=");
    const end = commandLine.indexOf(" && docker compose", start);
    if (start < 0) throw new Error(`no compose-env guard in: ${commandLine}`);
    if (end <= start) throw new Error(`no docker compose up after the guard in: ${commandLine}`);
    return commandLine.slice(start, end);
  };

  // The recipe line of one target, as the SHELL sees it: make doubles every `$`
  // in a recipe, so `$$(…)` on disk is `$(…)` at run time.
  const makefileRecipe = (target) => {
    const lines = MAKEFILE.split("\n");
    const start = lines.findIndex((l) => l.startsWith(`${target}:`));
    if (start < 0) throw new Error(`no ${target}: target in the Makefile`);
    const body = lines.slice(start + 1);
    const end = body.findIndex((l) => !l.startsWith("\t"));
    const line = (end === -1 ? body : body.slice(0, end)).find((l) =>
      l.includes("dev-compose-env.mjs"),
    );
    if (!line) throw new Error(`no ${target} recipe line running the shared step`);
    return line.trim().replace(/\$\$/g, "$");
  };

  const MAKE_DEV_GUARD = () => guardOf(makefileRecipe("dev"));
  const SERVICES_GUARD = () => guardOf(PKG.scripts.services);
  const KG_REFRESH_GUARD = () => guardOf(PKG.scripts["kg:refresh"]);

  it("uses one identical guard for both whole-stack bring-ups", () => {
    expect(SERVICES_GUARD()).toBe(MAKE_DEV_GUARD());
    expect(MAKE_DEV_GUARD()).toContain("--require-manageable");
  });

  // `kg:refresh` brings up graphiti (+ neo4j) only — neither is a scoped
  // service, so there is no stand-down for it to violate and it does not pass
  // --require-manageable. It still assigns-then-evals, so a plan the step
  // refuses outright stops it.
  it("uses the same assign-then-eval shape for the graphiti-only bring-up", () => {
    expect(KG_REFRESH_GUARD()).toContain('CINATRA_COMPOSE_ENV="$(node scripts/dev-compose-env.mjs)"');
    expect(KG_REFRESH_GUARD()).toContain('eval "$CINATRA_COMPOSE_ENV"');
    expect(KG_REFRESH_GUARD()).not.toContain("--require-manageable");
  });

  // The shape that swallowed the exit status must not come back anywhere.
  it("nowhere evals the step's output directly", () => {
    expect(MAKEFILE).not.toContain('eval "$$(node scripts/dev-compose-env.mjs');
    expect(JSON.stringify(PKG.scripts)).not.toContain("eval \\\"$(node scripts/dev-compose-env.mjs");
  });

  const MARKER = "COMPOSE_UP_WOULD_RUN";

  /**
   * Run one entry point's guard through `sh`, exactly as make / npm run it,
   * with a marker where `docker compose up` would be. The only edit is the
   * script PATH (these run in a temp lane dir, not the checkout root).
   */
  const runGuard = (guard, { envLocal = "", extraEnv = {} } = {}) => {
    const dir = mkdtempSync(path.join(tmpdir(), "cinatra-2839-entry-"));
    writeFileSync(path.join(dir, ".env.local"), envLocal);
    // The step's absolute path is handed over through the ENVIRONMENT, never
    // interpolated into the shell text: `JSON.stringify` is JSON quoting, not
    // shell quoting, so a checkout path containing `$` or a backtick would still
    // expand inside the double quotes it produces (CodeQL
    // js/shell-command-injection-from-environment). `"$CINATRA_TEST_SHARED_STEP"`
    // is expanded by the shell itself, which never re-parses the value.
    const script = `${guard.replace(
      "node scripts/dev-compose-env.mjs",
      'node "$CINATRA_TEST_SHARED_STEP"',
    )} && echo ${MARKER} && env`;

    const env = { ...process.env, CINATRA_TEST_SHARED_STEP: SHARED_STEP };
    delete env.COMPOSE_PROJECT_NAME;
    for (const spec of PREFLIGHT_HOST_PORTS) delete env[spec.envVar];
    for (const key of ["NANGO_SERVER_URL", "NANGO_DATABASE_URL", "REDIS_URL"]) delete env[key];
    Object.assign(env, extraEnv);

    const result = spawnSync("sh", ["-c", script], { cwd: dir, encoding: "utf8", env });
    rmSync(dir, { recursive: true, force: true });

    const reached = result.stdout.includes(MARKER);
    const exported = Object.fromEntries(
      result.stdout
        .split("\n")
        .map((line) => /^(COMPOSE_PROJECT_NAME|CINATRA_[A-Z_]*_HOST_PORT)=(.*)$/.exec(line))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
    );
    return { ...result, reached, exported };
  };

  const LANE = [
    "COMPOSE_PROJECT_NAME=p2839",
    "NANGO_SERVER_URL=http://127.0.0.1:13003",
    "NANGO_DATABASE_URL=postgresql://nango:nango@127.0.0.1:15435/nango",
    "REDIS_URL=redis://127.0.0.1:16379",
    "",
  ].join("\n");

  // The canonical single-stack flow, unchanged: no project name anywhere, the
  // historical ports, and the `up` runs.
  it("brings the unscoped checkout up on the historical ports", () => {
    const result = runGuard(MAKE_DEV_GUARD());
    expect(result.status).toBe(0);
    expect(result.reached).toBe(true);
    expect(result.exported).toEqual({
      CINATRA_NANGO_SERVER_HOST_PORT: "3003",
      CINATRA_NANGO_CONNECT_HOST_PORT: "3009",
      CINATRA_NANGO_DB_HOST_PORT: "5435",
      CINATRA_REDIS_HOST_PORT: "6379",
    });
    expect(result.exported.COMPOSE_PROJECT_NAME).toBeUndefined();
  });

  // …and the exported values are what compose interpolates, from the lane's own
  // `.env.local` — which Docker does not read for COMPOSE_PROJECT_NAME.
  it("brings a complete lane up on the lane's ports", () => {
    const result = runGuard(MAKE_DEV_GUARD(), { envLocal: LANE });
    expect(result.status).toBe(0);
    expect(result.reached).toBe(true);
    expect(result.exported).toEqual({
      COMPOSE_PROJECT_NAME: "p2839",
      CINATRA_NANGO_SERVER_HOST_PORT: "13003",
      CINATRA_NANGO_CONNECT_HOST_PORT: "13009",
      CINATRA_NANGO_DB_HOST_PORT: "15435",
      CINATRA_REDIS_HOST_PORT: "16379",
    });
  });

  // Item 1 at the entry point: the `up` must not run at all.
  it("stops before the up when a named lane states no port for a service", () => {
    const result = runGuard(MAKE_DEV_GUARD(), {
      envLocal: LANE.replace("REDIS_URL=redis://127.0.0.1:16379\n", ""),
    });
    expect(result.status).not.toBe(0);
    expect(result.reached).toBe(false);
    expect(result.stderr).toContain("REDIS_URL");
    // Nothing was exported either — an empty stdout is the whole point.
    expect(result.exported).toEqual({});
  });

  // Item 3, the one this section exists for: a whole-stack `up` cannot leave a
  // service out, so a lane that stands one down does not get to run it.
  it("stops before the up when a lane stands a service down", () => {
    const result = runGuard(MAKE_DEV_GUARD(), {
      envLocal: LANE.replace(
        "REDIS_URL=redis://127.0.0.1:16379",
        "REDIS_URL=rediss://cache.example.com:6380",
      ),
    });
    expect(result.status).not.toBe(0);
    expect(result.reached).toBe(false);
    expect(result.stderr).toContain("refusing to start the whole stack");
    expect(result.stderr).toContain("REDIS_URL=rediss://cache.example.com:6380");
    // The alternative that DOES honor a stand-down is named in the message.
    expect(result.stderr).toContain("pnpm dev");
  });

  it("stops the same way from the pnpm services guard", () => {
    const result = runGuard(SERVICES_GUARD(), {
      envLocal: LANE.replace(
        "REDIS_URL=redis://127.0.0.1:16379",
        "REDIS_URL=rediss://cache.example.com:6380",
      ),
    });
    expect(result.status).not.toBe(0);
    expect(result.reached).toBe(false);
  });

  // kg:refresh starts graphiti alone, so a redis stand-down is not its problem:
  // it proceeds, and simply claims no redis port.
  it("lets the graphiti-only bring-up proceed through a stand-down", () => {
    const result = runGuard(KG_REFRESH_GUARD(), {
      envLocal: LANE.replace(
        "REDIS_URL=redis://127.0.0.1:16379",
        "REDIS_URL=rediss://cache.example.com:6380",
      ),
    });
    expect(result.status).toBe(0);
    expect(result.reached).toBe(true);
    expect(result.exported.CINATRA_REDIS_HOST_PORT).toBeUndefined();
    expect(result.stderr).toContain("not claiming a host port for");
  });

  // HARD CAUTION at the entry point: pinning the very name compose derives from
  // this checkout is a no-op, not a second lane, and `make dev` must survive it
  // — from the MAIN checkout. From a linked worktree the same pin is a second
  // stack (round-3 non-blocking item), so the step refuses instead. Both are one
  // rule; which one this host sees comes from git, not from the module under
  // test. See `gitSaysLinkedWorktree`.
  it("warns but still runs when the pinned name is this checkout's compose default", () => {
    const result = runGuard(MAKE_DEV_GUARD(), {
      extraEnv: { COMPOSE_PROJECT_NAME: composeDefaultProjectName(REPO_ROOT) },
    });
    if (REPO_IS_LINKED_WORKTREE) {
      expect(result.status).not.toBe(0);
      expect(result.reached).toBe(false);
      expect(result.stderr).toContain("REDIS_URL is not stated");
      return;
    }
    expect(result.status).toBe(0);
    expect(result.reached).toBe(true);
    expect(result.exported.CINATRA_REDIS_HOST_PORT).toBe("6379");
    expect(result.stderr).toContain("collide on 6379");
  });

  // Item 4 where the omission actually leaked: an invalid ambient value is
  // already IN the shell, so a plan that emits no line for that key leaves it
  // standing and compose publishes it. The replacement line is what corrects it.
  it("overwrites an invalid ambient host-port value in the evaluated shell", () => {
    const result = runGuard(MAKE_DEV_GUARD(), {
      extraEnv: { CINATRA_REDIS_HOST_PORT: "not-a-port" },
    });
    expect(result.status).toBe(0);
    expect(result.reached).toBe(true);
    expect(result.exported.CINATRA_REDIS_HOST_PORT).toBe("6379");
    expect(result.stderr).toContain("not-a-port");
  });

  // THE SAME LEAK, on the project name itself — the last hole in the
  // canonicality check. A whitespace-only COMPOSE_PROJECT_NAME used to trim to
  // empty, read as the unscoped checkout, and emit no project-name line; the
  // ambient `"   "` was already in the shell being `eval`ed into, so it stood,
  // reached `docker compose`, and failed THERE with compose's own "invalid
  // project name" — after the recipe had run part of the way. Refusing it stops
  // the chain before the up, which is the only outcome that cannot leak: there
  // is no later process to leak into.
  it("stops before the up on a whitespace-only ambient project name", () => {
    const result = runGuard(MAKE_DEV_GUARD(), {
      extraEnv: { COMPOSE_PROJECT_NAME: "   " },
    });
    expect(result.status).not.toBe(0);
    expect(result.reached).toBe(false);
    // The ambient value never reaches a compose invocation: the marker (and the
    // `env` that would show it) is never reached at all.
    expect(result.exported).toEqual({});
    expect(result.stdout).toBe("");
    // …and the refusal is attributable, quoting the value so it is visible.
    expect(result.stderr).toContain(`COMPOSE_PROJECT_NAME="   "`);
    expect(result.stderr).toContain("not a name Docker Compose accepts");
  });

  // The other half of the hole, at the entry point: a name that trims to the
  // checkout's own default is NOT the checkout's own pin.
  it("stops before the up on a leading-space ambient project name", () => {
    const result = runGuard(MAKE_DEV_GUARD(), {
      extraEnv: { COMPOSE_PROJECT_NAME: ` ${composeDefaultProjectName(REPO_ROOT)}` },
    });
    expect(result.status).not.toBe(0);
    expect(result.reached).toBe(false);
    expect(result.exported).toEqual({});
    expect(result.stderr).toContain(
      `COMPOSE_PROJECT_NAME=" ${composeDefaultProjectName(REPO_ROOT)}"`,
    );
    // The name they meant is named for them, rather than assumed for them.
    expect(result.stderr).toContain(
      `COMPOSE_PROJECT_NAME=${composeDefaultProjectName(REPO_ROOT)} instead`,
    );
  });

  // …and an EMPTY ambient value is still no statement at all: the canonical
  // single-stack flow survives `COMPOSE_PROJECT_NAME=` in the environment.
  it("still brings the checkout up on an empty ambient project name", () => {
    const result = runGuard(MAKE_DEV_GUARD(), { extraEnv: { COMPOSE_PROJECT_NAME: "" } });
    expect(result.status).toBe(0);
    expect(result.reached).toBe(true);
    expect(result.exported.CINATRA_REDIS_HOST_PORT).toBe("6379");
  });

  // ---------------------------------------------------------------------------
  // 3a-ter. The LIFECYCLE targets (cinatra#2849) — `make down`, `make logs`,
  // `make clean` (`docker compose down -v`, destructive) and
  // `pnpm services:down`. Startup resolves a compose project; these did not —
  // each ran a BARE `docker compose …`, which Compose resolves against the
  // directory-basename project because it does NOT read COMPOSE_PROJECT_NAME
  // from `.env.local`. On a scoped lane that means `make down` leaves the
  // lane's own stack running (it acted on the operator's project instead) and
  // `make clean` wipes the OPERATOR'S volumes rather than the lane's own.
  //
  // The fix is not a second resolver: it is the exact same guarded chain
  // `make dev` runs, minus `--require-manageable` (that flag exists only to
  // make a WHOLE-STACK `up` honor a per-service stand-down; down/logs/clean
  // never start anything, so there is nothing to stand down).
  // ---------------------------------------------------------------------------

  const MAKE_DOWN_GUARD = () => guardOf(makefileRecipe("down"));
  const MAKE_LOGS_GUARD = () => guardOf(makefileRecipe("logs"));
  const MAKE_CLEAN_GUARD = () => guardOf(makefileRecipe("clean"));
  const SERVICES_DOWN_GUARD = () => guardOf(PKG.scripts["services:down"]);

  const BASE_GUARD =
    'CINATRA_COMPOSE_ENV="$(node scripts/dev-compose-env.mjs)" && eval "$CINATRA_COMPOSE_ENV"';

  it("wires down/logs/clean and services:down to the SAME guard `make dev` runs, not a second resolver", () => {
    expect(MAKE_DOWN_GUARD()).toBe(BASE_GUARD);
    expect(MAKE_LOGS_GUARD()).toBe(BASE_GUARD);
    expect(MAKE_CLEAN_GUARD()).toBe(BASE_GUARD);
    expect(SERVICES_DOWN_GUARD()).toBe(BASE_GUARD);
    // `make dev`'s own guard is this exact chain plus the whole-stack-only flag
    // passed to the shared step — one shared prefix, never a fork.
    expect(MAKE_DEV_GUARD()).toBe(BASE_GUARD.replace(".mjs)", ".mjs --require-manageable)"));
  });

  for (const [name, guardFn] of [
    ["make down", MAKE_DOWN_GUARD],
    ["make logs", MAKE_LOGS_GUARD],
    ["make clean", MAKE_CLEAN_GUARD],
    ["pnpm services:down", SERVICES_DOWN_GUARD],
  ]) {
    // The unscoped checkout: today's behavior, unchanged. No COMPOSE_PROJECT_NAME
    // is resolved, so the bare `docker compose …` form Compose would run is
    // equivalent to what it always ran here.
    it(`${name} resolves the unscoped checkout to no project name — bare form, exactly as before`, () => {
      const result = runGuard(guardFn());
      expect(result.status).toBe(0);
      expect(result.reached).toBe(true);
      expect(result.exported.COMPOSE_PROJECT_NAME).toBeUndefined();
    });

    // The scoped lane: this is the blocker. Before the fix, `makefileRecipe`
    // above cannot even find a guarded recipe line for these targets — proving
    // the bare-compose form carries no `-p` / COMPOSE_PROJECT_NAME at all. After
    // the fix, the lane's project name is exported here exactly as `make dev`
    // exports it for the SAME `.env.local`.
    it(`${name} resolves a scoped lane to the SAME project name \`make dev\` resolves for it`, () => {
      const result = runGuard(guardFn(), { envLocal: LANE });
      const devResult = runGuard(MAKE_DEV_GUARD(), { envLocal: LANE });
      expect(result.status).toBe(0);
      expect(result.reached).toBe(true);
      expect(result.exported.COMPOSE_PROJECT_NAME).toBe("p2839");
      expect(result.exported.COMPOSE_PROJECT_NAME).toBe(devResult.exported.COMPOSE_PROJECT_NAME);
    });
  }

  it("setup.sh's stop-infra hint points at the guarded `make down`, not a bare `docker compose down`", () => {
    const setupSh = readFileSync(path.join(REPO_ROOT, "scripts", "setup.sh"), "utf8");
    expect(setupSh).not.toContain('echo "  Stop infra:       docker compose down"');
    expect(setupSh).toMatch(/Stop infra:\s*make down/);
  });
});

// ---------------------------------------------------------------------------
// 3a-bis. scripts/setup.sh — the FIFTH whole-stack entry point
// ---------------------------------------------------------------------------
//
// `make setup` runs `bash scripts/setup.sh`, which brings the WHOLE stack up
// (`docker compose … up -d`) exactly like `make dev` and `pnpm services`. It had
// no guard at all: in a lane whose COMPOSE_PROJECT_NAME and service URLs live in
// `.env.local`, setup ignored the lane's project (compose fell back to the
// directory-derived one), published the four historical defaults, and bypassed
// every refusal this branch added.
//
// Its guard cannot be the entry points' one-line `&&` chain. setup.sh runs under
// `set -e`, and errexit EXEMPTS a command that is part of an `&&` list — so a
// refusal would skip the `up` and then let the REST of setup run to "Setup
// complete!". The shape here is therefore: a standalone assignment with an
// explicit `|| error`, then `eval` on its own line.
//
// Same method as the tests above: take the guard out of the REAL file and run
// it, with a marker standing in for everything setup.sh does afterwards.
// Reaching the marker means the real script would have reached its `up`.

describe("scripts/setup.sh — the fifth guarded whole-stack entry point", () => {
  const SHARED_STEP = path.join(REPO_ROOT, "scripts", "dev-compose-env.mjs");
  const SETUP_SH_PATH = path.join(REPO_ROOT, "scripts", "setup.sh");
  const SETUP_SH = readFileSync(SETUP_SH_PATH, "utf8");
  const SETUP_LINES = SETUP_SH.split("\n");

  // Plain throws, not `expect`: a setup.sh that loses its guard must fail a
  // NAMED test rather than blow up this file's collection.

  /**
   * setup.sh's own preamble — shebang, `set -euo pipefail`, the colour vars and
   * the info()/error() helpers, up to and including prompt(). Taken from the
   * real file so the guard below runs under the REAL shell options and the REAL
   * `error` (which is what has to exit 1).
   */
  const setupPreamble = () => {
    const end = SETUP_LINES.findIndex((l) => l.startsWith("prompt()"));
    if (end < 0) throw new Error("scripts/setup.sh lost its info()/error() preamble");
    const preamble = SETUP_LINES.slice(0, end + 1).join("\n");
    if (!/^set -[a-z]*e/m.test(preamble)) {
      throw new Error("scripts/setup.sh no longer sets -e; the guard's abort reasoning changes");
    }
    return preamble;
  };

  /** The assign → `|| error` → eval block, verbatim from scripts/setup.sh. */
  const setupGuard = () => {
    const start = SETUP_LINES.findIndex((l) => l.startsWith("CINATRA_COMPOSE_ENV="));
    if (start < 0) throw new Error("no compose-env guard in scripts/setup.sh");
    const end = SETUP_LINES.findIndex(
      (l, i) => i >= start && l.startsWith('eval "$CINATRA_COMPOSE_ENV"'),
    );
    if (end < start) throw new Error("scripts/setup.sh never evals the guard's output");
    return SETUP_LINES.slice(start, end + 1).join("\n");
  };

  /** The line number of setup.sh's first `docker compose`, 1-based. */
  const firstComposeLine = () =>
    SETUP_LINES.findIndex((l) => /^\s*docker compose /.test(l)) + 1;
  const guardLine = () =>
    SETUP_LINES.findIndex((l) => l.startsWith("CINATRA_COMPOSE_ENV=")) + 1;

  it("runs the shared step with --require-manageable, like the other whole-stack ups", () => {
    expect(setupGuard()).toContain("node scripts/dev-compose-env.mjs --require-manageable");
    expect(setupGuard()).toContain('eval "$CINATRA_COMPOSE_ENV"');
  });

  // The `&&`-chain shape is CORRECT in the Makefile and package.json (make and
  // npm check the whole line's status) and WRONG here (errexit exempts it, so
  // the script would sail on). Assert setup.sh does not use it.
  it("does not chain the guard with && , which set -e would exempt", () => {
    expect(setupGuard()).not.toContain("&& eval");
    expect(setupGuard()).not.toContain("&& docker compose");
    expect(setupGuard()).toContain("|| error");
    expect(SETUP_SH).not.toContain('eval "$(node scripts/dev-compose-env.mjs');
  });

  // Placement is the whole point: a guard AFTER the first compose call has
  // already let that call run on the wrong project.
  it("places the guard before the first compose invocation in the file", () => {
    expect(guardLine()).toBeGreaterThan(0);
    expect(firstComposeLine()).toBeGreaterThan(0);
    expect(guardLine()).toBeLessThan(firstComposeLine());
  });

  // PROPAGATION, asserted structurally: `eval` exports into setup.sh's own
  // shell, so every later `docker compose` inherits it as a child — but only
  // because the script never changes directory and never runs compose inside a
  // subshell or a function body, either of which the exports still reach but
  // whose cwd would break the relative `-f` paths.
  it("never cd's, so every later compose invocation shares the guard's cwd", () => {
    expect(SETUP_LINES.filter((l) => /^\s*(cd|pushd|popd)\s/.test(l))).toEqual([]);
  });

  const MARKER = "SETUP_WOULD_CONTINUE";

  /**
   * Run setup.sh's REAL preamble + REAL guard through bash, with a marker
   * standing in for the `up` and everything setup.sh does after it. The only
   * edit is the script PATH (these run in a temp lane dir, not the checkout).
   */
  const runSetupGuard = ({ envLocal = "", extraEnv = {} } = {}) => {
    const dir = mkdtempSync(path.join(tmpdir(), "cinatra-2839-setup-"));
    writeFileSync(path.join(dir, ".env.local"), envLocal);
    // Same reason as runGuard above: the absolute path travels in the
    // environment, so no path text is ever parsed as shell (CodeQL
    // js/shell-command-injection-from-environment).
    const script = [
      setupPreamble(),
      setupGuard().replace(
        "node scripts/dev-compose-env.mjs",
        'node "$CINATRA_TEST_SHARED_STEP"',
      ),
      `echo ${MARKER}`,
      "env",
    ].join("\n");

    const env = { ...process.env, CINATRA_TEST_SHARED_STEP: SHARED_STEP };
    delete env.COMPOSE_PROJECT_NAME;
    for (const spec of PREFLIGHT_HOST_PORTS) delete env[spec.envVar];
    for (const key of ["NANGO_SERVER_URL", "NANGO_DATABASE_URL", "REDIS_URL"]) delete env[key];
    Object.assign(env, extraEnv);

    const result = spawnSync("bash", ["-c", script], { cwd: dir, encoding: "utf8", env });
    rmSync(dir, { recursive: true, force: true });

    const reached = result.stdout.includes(MARKER);
    const exported = Object.fromEntries(
      result.stdout
        .split("\n")
        .map((line) => /^(COMPOSE_PROJECT_NAME|CINATRA_[A-Z_]*_HOST_PORT)=(.*)$/.exec(line))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
    );
    return { ...result, reached, exported };
  };

  const LANE = [
    "COMPOSE_PROJECT_NAME=p2839",
    "NANGO_SERVER_URL=http://127.0.0.1:13003",
    "NANGO_DATABASE_URL=postgresql://nango:nango@127.0.0.1:15435/nango",
    "REDIS_URL=redis://127.0.0.1:16379",
    "",
  ].join("\n");

  // The canonical `make setup` on a fresh clone: no project name, historical
  // ports, setup proceeds exactly as before this branch.
  it("sets an unscoped checkout up on the historical ports", () => {
    const result = runSetupGuard();
    expect(result.status).toBe(0);
    expect(result.reached).toBe(true);
    expect(result.exported).toEqual({
      CINATRA_NANGO_SERVER_HOST_PORT: "3003",
      CINATRA_NANGO_CONNECT_HOST_PORT: "3009",
      CINATRA_NANGO_DB_HOST_PORT: "5435",
      CINATRA_REDIS_HOST_PORT: "6379",
    });
    expect(result.exported.COMPOSE_PROJECT_NAME).toBeUndefined();
  });

  // The blocker itself: a lane's project name and ports now reach every compose
  // call setup.sh makes, instead of the directory-derived project + defaults.
  it("exports the lane's project and ports for every later compose invocation", () => {
    const result = runSetupGuard({ envLocal: LANE });
    expect(result.status).toBe(0);
    expect(result.reached).toBe(true);
    expect(result.exported).toEqual({
      COMPOSE_PROJECT_NAME: "p2839",
      CINATRA_NANGO_SERVER_HOST_PORT: "13003",
      CINATRA_NANGO_CONNECT_HOST_PORT: "13009",
      CINATRA_NANGO_DB_HOST_PORT: "15435",
      CINATRA_REDIS_HOST_PORT: "16379",
    });
  });

  // …and the Nango health wait that follows must track the PUBLISHED port, or a
  // lane on 13003 waits forever on the global 3003 (an unbounded `until` loop).
  it("waits for Nango on the published port, not a hardcoded 3003", () => {
    expect(SETUP_SH).toContain("${CINATRA_NANGO_SERVER_HOST_PORT:-3003}/health");
    expect(SETUP_SH).not.toContain("http://127.0.0.1:3003/health");
  });

  // The abort that the `&&` shape would have swallowed: a refusal must stop the
  // SCRIPT, not merely skip the `up`.
  it("stops the whole script when a named lane states no port for a service", () => {
    const result = runSetupGuard({
      envLocal: LANE.replace("REDIS_URL=redis://127.0.0.1:16379\n", ""),
    });
    expect(result.status).not.toBe(0);
    expect(result.reached).toBe(false);
    expect(result.stderr).toContain("REDIS_URL");
    // Attributable: setup.sh names itself in the abort, not just the step.
    expect(result.stdout + result.stderr).toContain("scripts/setup.sh");
    expect(result.exported).toEqual({});
  });

  it("stops the whole script when a lane stands a service down", () => {
    const result = runSetupGuard({
      envLocal: LANE.replace(
        "REDIS_URL=redis://127.0.0.1:16379",
        "REDIS_URL=rediss://cache.example.com:6380",
      ),
    });
    expect(result.status).not.toBe(0);
    expect(result.reached).toBe(false);
    expect(result.stderr).toContain("refusing to start the whole stack");
  });

  it("corrects an invalid ambient host-port override before the stack starts", () => {
    const result = runSetupGuard({ extraEnv: { CINATRA_REDIS_HOST_PORT: "not-a-port" } });
    expect(result.status).toBe(0);
    expect(result.reached).toBe(true);
    expect(result.exported.CINATRA_REDIS_HOST_PORT).toBe("6379");
    expect(result.stderr).toContain("not-a-port");
  });

  // A pin of this checkout's own compose default is a no-op, not a lane —
  // `make setup` must survive it, same as `make dev`.
  // Same one rule as the `make dev` case above, at setup's own guard: the no-op
  // pin survives from the MAIN checkout, and is a second stack — so a refusal —
  // from a linked worktree. The precondition comes from git, not from the module
  // under test.
  it("warns but still proceeds when the pinned name is this checkout's compose default", () => {
    const result = runSetupGuard({
      extraEnv: { COMPOSE_PROJECT_NAME: composeDefaultProjectName(REPO_ROOT) },
    });
    if (REPO_IS_LINKED_WORKTREE) {
      expect(result.status).not.toBe(0);
      expect(result.reached).toBe(false);
      return;
    }
    expect(result.status).toBe(0);
    expect(result.reached).toBe(true);
    expect(result.exported.CINATRA_REDIS_HOST_PORT).toBe("6379");
  });

  // Review item 2, at the entry point: a stated name compose would reject stops
  // setup before anything starts.
  it("stops the whole script when the stated project name is not canonical", () => {
    const result = runSetupGuard({ extraEnv: { COMPOSE_PROJECT_NAME: "Cinatra!" } });
    expect(result.status).not.toBe(0);
    expect(result.reached).toBe(false);
    expect(result.stderr).toContain("COMPOSE_PROJECT_NAME=Cinatra!");
    expect(result.exported).toEqual({});
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

// ---------------------------------------------------------------------------
// The DB-drift preflight, scoped to the worktree's plan (cinatra#2839 item 2)
// ---------------------------------------------------------------------------
//
// The launcher has TWO doors to Docker, and only one of them was scoped. The
// compose runner honors the resolved host-port plan (#2845, #2849); the
// READ-ONLY drift diagnosis above it still measured every bundled service
// against the HARDCODED global default (`BUNDLED_DB_SERVICES[].defaultHostPort`
// — redis 6379), which is exactly the port #2849 made per-worktree. Three
// outcomes followed on a correctly-configured lane, and the middle one is a
// hard boot failure:
//
//   A. A lane that claims redis's host port directly (CINATRA_REDIS_HOST_PORT)
//      was measured at the GLOBAL 6379. Its healthy container publishes the
//      lane port instead, so `detectDriftFromInspect` found no 6379 binding,
//      called that drift, and `pnpm dev` exited 1 — refusing to start a lane
//      whose configuration is correct.
//   B. A lane that states REDIS_URL on its own port was skipped entirely
//      ("not our stack"), so the drift guard silently ceased to exist for the
//      lanes the scoping exists to serve.
//   C. A lane that STANDS REDIS DOWN — the plan claims no host port for it, so
//      it is somebody else's service — was diagnosed anyway, against the LANE's
//      compose project, and could condemn the boot over a container that is not
//      this checkout's to judge.
//
// The fix reads the expected port from the SAME plan the compose runner is
// pinned to (`resolvePublishedHostPort`), never a second derivation. These
// cases drive the real launcher with a fake `docker` that answers `ps`/
// `inspect`, so what is asserted is the launcher's actual exit status and its
// actual argv — not a restatement of the resolver.
describe("dev-server.mjs DB-drift preflight is scoped to the worktree's plan", () => {
  let dir;
  let dockerLog;
  let laneRedisPort;
  let laneAltRedisPort;
  let unscopedRedisPort;
  let lanePgPort;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "cinatra-2839-drift-"));
    dockerLog = path.join(dir, "docker-calls.log");
    // Closed, so every probed service reads as DOWN and the drift diagnosis is
    // the path under test. Reserved rather than hardcoded: a lane port that
    // happened to be live on the test host would silently skip the diagnosis.
    laneRedisPort = await reserveClosedPort();
    // A SECOND closed port, so a case can state a published port and a connect
    // port that differ without either of them being a port anything runs on.
    laneAltRedisPort = await reserveClosedPort();
    // A THIRD closed port for the UNSCOPED cases. They need the same guarantee
    // for a stronger reason: the launcher only reaches the drift diagnosis after
    // its TCP probe FAILS, so an unscoped case pinned to redis's historical
    // 6379 measures whether the operator's bundled redis is up — and goes red on
    // exactly the machine this preflight exists to serve.
    unscopedRedisPort = await reserveClosedPort();
    lanePgPort = await reserveClosedPort();

    // Fake `docker`: records argv, then answers `ps -aq` / `inspect` from the
    // environment so a container can be SIMULATED without one existing. Any
    // command the case did not arm for still exits non-zero, so nothing is ever
    // really started and no bounded wait runs long.
    const bin = path.join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, "docker-recorder.cjs"),
      [
        'const { appendFileSync } = require("node:fs");',
        "const argv = process.argv.slice(2);",
        "appendFileSync(",
        "  process.env.CINATRA_TEST_DOCKER_LOG,",
        '  JSON.stringify({ argv }) + "\\n",',
        ");",
        "const containerId = process.env.CINATRA_TEST_DOCKER_PS_ID;",
        'if (containerId && argv.includes("ps") && argv.includes("-aq")) {',
        '  process.stdout.write(containerId + "\\n");',
        "  process.exit(0);",
        "}",
        "const published = process.env.CINATRA_TEST_DOCKER_PORTS;",
        'if (published && argv[0] === "inspect") {',
        '  process.stdout.write("true\\t" + published + "\\n");',
        "  process.exit(0);",
        "}",
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

    const nextBin = path.join(dir, "node_modules", ".bin");
    mkdirSync(nextBin, { recursive: true });
    const nextStub = path.join(nextBin, "next");
    writeFileSync(nextStub, "#!/usr/bin/env node\nprocess.exit(0);\n");
    chmodSync(nextStub, 0o755);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * Run the real launcher in the temp worktree.
   *
   * `containerPorts` is the `.NetworkSettings.Ports` JSON the fake `docker
   * inspect` reports for the simulated redis container; omitted means no
   * container exists at all (`ps -aq` returns nothing).
   *
   * Everything the launcher reads is stated in `.env.local`, and every relevant
   * shell variable is deleted, because a shell value outranks the file and the
   * whole point of these cases is what a LANE FILE resolves to.
   */
  const runLauncher = (envLocal, { containerPorts } = {}) => {
    rmSync(dockerLog, { force: true });
    writeFileSync(path.join(dir, ".env.local"), envLocal);

    const env = {
      ...process.env,
      PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
      CINATRA_TEST_DOCKER_LOG: dockerLog,
    };
    if (containerPorts) {
      env.CINATRA_TEST_DOCKER_PS_ID = "lane-redis-container";
      env.CINATRA_TEST_DOCKER_PORTS = containerPorts;
    } else {
      delete env.CINATRA_TEST_DOCKER_PS_ID;
      delete env.CINATRA_TEST_DOCKER_PORTS;
    }
    for (const key of [
      "CINATRA_SKIP_DEV_PREFLIGHT",
      "COMPOSE_PROJECT_NAME",
      "PORT",
      "REDIS_URL",
      "SUPABASE_DB_URL",
      "NEO4J_URI",
      "NANGO_SERVER_URL",
      "NANGO_DATABASE_URL",
    ]) {
      delete env[key];
    }
    for (const spec of PREFLIGHT_HOST_PORTS) delete env[spec.envVar];

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

  /**
   * A complete lane: it names its own compose project and states a host port
   * for every scoped service, so `resolveComposeHostPortPlan` refuses nothing
   * and the drift path is the only thing under test.
   *
   * Nango is pointed at a RESERVED (RFC 2606) remote host on purpose: that
   * stands nango-server down, so the Nango heal makes zero docker calls and
   * every call in the log belongs to the drift diagnosis.
   */
  const laneEnv = (redisLine) =>
    [
      "PORT=13839",
      "COMPOSE_PROJECT_NAME=p2839lane",
      redisLine,
      "NANGO_SERVER_URL=https://nango.example.invalid",
      `NANGO_DATABASE_URL=postgresql://nango:nango@127.0.0.1:15435/nango`,
      `SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:${lanePgPort}/postgres`,
      "",
    ].join("\n");

  const redisCalls = (calls) =>
    calls.filter((c) => c.argv.includes("redis") || c.argv[0] === "inspect");

  // Case A — the boot-blocking one. The lane claims redis's published port
  // directly; its container publishes exactly that. Measuring against the
  // global 6379 turned a correct lane into "drift" and exited 1.
  it("does not condemn a lane whose redis publishes the port the plan claims", () => {
    const result = runLauncher(laneEnv(`CINATRA_REDIS_HOST_PORT=${laneRedisPort}`), {
      containerPorts: `{"6379/tcp":[{"HostIp":"127.0.0.1","HostPort":"${laneRedisPort}"}]}`,
    });
    expect(
      result.status,
      `launcher exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).not.toContain("Docker host-port drift");
    // …and it does not pass in silence either: the lane publishes redis on its
    // own port while the app, stating no REDIS_URL, connects to the shared
    // 6379 — the operator's container. Not condemning the boot is right; saying
    // nothing would leave the lane bleeding into another stack all session.
    expect(result.stderr).toContain("but the app connects on 6379");
    expect(result.stderr).toContain("CINATRA_REDIS_HOST_PORT");
  });

  // Case B — the guard comes BACK for a lane. This container really is the
  // base-only-compose failure the diagnosis exists to name, at the LANE's port,
  // so the launcher must refuse — and it must have looked at the LANE's compose
  // project to find out.
  it("diagnoses real drift at the lane's own published port, in the lane's project", () => {
    const result = runLauncher(
      laneEnv(`REDIS_URL=redis://127.0.0.1:${laneRedisPort}`),
      { containerPorts: '{"6379/tcp":null}' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Docker host-port drift");
    const ps = result.calls.find((c) => c.argv.includes("ps"));
    expect(ps, "the drift diagnosis should have inspected the lane's redis").toBeDefined();
    expect(ps.argv.slice(0, 3)).toEqual(["compose", "-p", "p2839lane"]);
  });

  // Case B′ — same lane, healthy container. The port IS published, so this is
  // not drift: the launcher warns that redis is not reachable yet and boots.
  it("clears a lane whose redis container publishes the lane port", () => {
    const result = runLauncher(
      laneEnv(`REDIS_URL=redis://127.0.0.1:${laneRedisPort}`),
      { containerPorts: `{"6379/tcp":[{"HostIp":"127.0.0.1","HostPort":"${laneRedisPort}"}]}` },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Docker host-port drift");
    expect(result.stderr).toContain("not reachable yet");
  });

  // Case C — the plan STOOD REDIS DOWN (a loopback URL with no port states no
  // host-port claim), so no container here is this checkout's to judge. The
  // diagnosis must not run at all, let alone condemn the boot.
  it("never diagnoses a service the plan claims no host port for", () => {
    const result = runLauncher(laneEnv("REDIS_URL=redis://127.0.0.1/0"), {
      containerPorts: '{"6379/tcp":null}',
    });
    expect(
      result.status,
      `launcher exited ${result.status}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).not.toContain("Docker host-port drift");
    expect(redisCalls(result.calls)).toEqual([]);
  });

  // The regression pin: the operator's UNSCOPED checkout states no project name,
  // so the diagnosis behaves exactly as it did before any of this work —
  // compose's own basename derivation, measuring the port THIS checkout
  // publishes. Nothing here may take `make dev` away.
  //
  // Reserved rather than hardcoded, for the reason this block already states
  // once. Writing the historical 6379 into this case made it measure the test
  // HOST instead of the launcher: `make dev` publishes redis there, the probe
  // then answers, the diagnosis is skipped and the launcher exits 0 — so the
  // case went red on every machine with the bundled stack up, and on the
  // machines where it passed nobody could tell whether it passed because the
  // behavior is right or because the port happened to be free.
  //
  // The unscoped checkout STATES the reserved port instead, so the plan resolves
  // the same claim the historical default resolves for it — published and
  // connect agree, and no host service can answer at the address. That the
  // UNSTATED port is still the historical 6379 is pinned where it costs no
  // socket at all: "answers the historical default for the unscoped checkout"
  // (resolvePublishedHostPort, below) and the companion case underneath.
  //
  // The simulated container publishes the GLOBAL 6379 on purpose: a launcher
  // that regressed to the hardcoded default would find its port published, call
  // the container healthy and exit 0. Only one that measures the port this
  // checkout resolved sees the drift.
  it("still diagnoses the unscoped checkout at the port it publishes, with no -p", () => {
    const result = runLauncher(
      [
        "PORT=13839",
        `CINATRA_REDIS_HOST_PORT=${unscopedRedisPort}`,
        `REDIS_URL=redis://127.0.0.1:${unscopedRedisPort}`,
        "NANGO_SERVER_URL=https://nango.example.invalid",
        `SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:${lanePgPort}/postgres`,
        "",
      ].join("\n"),
      { containerPorts: '{"6379/tcp":[{"HostIp":"127.0.0.1","HostPort":"6379"}]}' },
    );
    expect(
      result.status,
      `launcher exited ${result.status}\nstderr:\n${result.stderr}`,
    ).toBe(1);
    expect(result.stderr).toContain("Docker host-port drift");
    const ps = result.calls.find((c) => c.argv.includes("ps"));
    // No `-p`: compose's own basename derivation, unchanged.
    expect(ps.argv.slice(0, 2)).toEqual(["compose", "-f"]);
  });

  // …and the other half of that pin, end-to-end and still without touching
  // 6379: an unscoped checkout that STATES no host port publishes the
  // HISTORICAL DEFAULT, whatever its `REDIS_URL` says. The consequence is
  // observable without probing that port — the app connects on the reserved
  // port instead, published and connect disagree, so `shouldDiagnoseDrift`
  // switches off and no container is inspected for redis. A build in which the
  // unscoped default moved to the app's port would diagnose here and refuse.
  //
  // The note stays silent too: this checkout only OMITTED a host port, which is
  // the unscoped immunity the mismatch warning keeps (round-4 finding 4 narrowed
  // it to what a checkout STATES). "Not reachable yet" is the honest answer.
  it("publishes the historical default for an unscoped checkout that states no host port", () => {
    const result = runLauncher(
      [
        "PORT=13839",
        `REDIS_URL=redis://127.0.0.1:${unscopedRedisPort}`,
        "NANGO_SERVER_URL=https://nango.example.invalid",
        `SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:${lanePgPort}/postgres`,
        "",
      ].join("\n"),
      { containerPorts: '{"6379/tcp":null}' },
    );
    expect(
      result.status,
      `launcher exited ${result.status}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).not.toContain("Docker host-port drift");
    expect(result.stderr).not.toContain("published on host port");
    expect(result.stderr).toContain("PostgreSQL, Redis not reachable yet");
    expect(redisCalls(result.calls)).toEqual([]);
  });

  // Item 1 still holds over the whole widened path: the flag's promise is that
  // NOTHING is touched, and the drift door is the one that spawns `docker`
  // without the compose runner.
  it("makes zero docker calls on every scoped drift shape behind the skip flag", () => {
    for (const redisLine of [
      `CINATRA_REDIS_HOST_PORT=${laneRedisPort}`,
      `REDIS_URL=redis://127.0.0.1:${laneRedisPort}`,
      "REDIS_URL=redis://127.0.0.1/0",
    ]) {
      const result = runLauncher(
        `${laneEnv(redisLine)}CINATRA_SKIP_DEV_PREFLIGHT=1\n`,
        { containerPorts: '{"6379/tcp":null}' },
      );
      expect(result.status, `for ${redisLine}: ${result.stderr}`).toBe(0);
      expect(result.calls, `for ${redisLine}`).toEqual([]);
    }
  });

  // Round-4 review, finding 4. An UNSCOPED checkout that states
  // CINATRA_REDIS_HOST_PORT makes a claim the plan honors whatever its scope,
  // so published and connect disagree and `shouldDiagnoseDrift` skips — and the
  // skip sat in front of the probe, so the service was not even probed. The
  // operator got no mismatch note, no drift refusal and no "not reachable yet",
  // then ECONNREFUSED deep in app boot: the exact failure this preflight exists
  // to move forward. The base gave a wrong-but-loud answer here; silence is
  // worse than either.
  it("does not fall silent on an unscoped checkout that stated its own redis port", () => {
    const result = runLauncher(
      [
        "PORT=13839",
        `CINATRA_REDIS_HOST_PORT=${laneRedisPort}`,
        `REDIS_URL=redis://127.0.0.1:${laneAltRedisPort}`,
        "NANGO_SERVER_URL=https://nango.example.invalid",
        `SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:${lanePgPort}/postgres`,
        "",
      ].join("\n"),
    );
    expect(
      result.status,
      `launcher exited ${result.status}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).toContain(`published on host port ${laneRedisPort}`);
    expect(result.stderr).toContain(`the app connects on ${laneAltRedisPort}`);
    // The probe must still have happened: the mismatched port is not one this
    // checkout publishes, so there is no drift to diagnose — but "nothing is
    // listening there" is still the operator's answer.
    expect(result.stderr).toContain("PostgreSQL, Redis not reachable yet");
  });

  // Round-4 review, the new medium. A lane pointing REDIS_URL at a non-loopback
  // host runs against an external service on purpose. The note would call that
  // remote answer somebody else's local stack and advise re-pointing at
  // 127.0.0.1 — a false claim with an unsafe remedy attached.
  it("says nothing about a lane whose redis is a non-loopback host", () => {
    const result = runLauncher(
      laneEnv(
        `CINATRA_REDIS_HOST_PORT=${laneRedisPort}\nREDIS_URL=redis://192.0.2.10:6379`,
      ),
    );
    expect(
      result.status,
      `launcher exited ${result.status}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).not.toContain("published on host port");
    expect(result.stderr).not.toContain("Docker host-port drift");
  });
});

// ---------------------------------------------------------------------------
// resolvePublishedHostPort — the one answer both drift callers read
// ---------------------------------------------------------------------------
describe("resolvePublishedHostPort", () => {
  const REDIS = BUNDLED_DB_SERVICES.find((s) => s.composeService === "redis");
  const POSTGRES = BUNDLED_DB_SERVICES.find((s) => s.composeService === "postgres");

  const planFor = (processEnv, envFile = {}) =>
    resolveComposeHostPortPlan({
      processEnv,
      envFileLookup: (key) => envFile[key],
      projectName: processEnv.COMPOSE_PROJECT_NAME,
      defaultProjectName: "/tmp/some-checkout",
    });

  const askRedis = (plan) =>
    resolvePublishedHostPort({
      composeService: REDIS.composeService,
      defaultHostPort: REDIS.defaultHostPort,
      plan,
    });

  it("answers the historical default for the unscoped checkout", () => {
    expect(askRedis(planFor({}))).toMatchObject({ published: 6379, parameterized: true });
  });

  it("answers the port a lane derived from its own REDIS_URL", () => {
    const plan = planFor(
      { COMPOSE_PROJECT_NAME: "p2839" },
      {
        REDIS_URL: "redis://127.0.0.1:16379",
        NANGO_SERVER_URL: "http://127.0.0.1:13003",
        NANGO_DATABASE_URL: "postgresql://n:n@127.0.0.1:15435/nango",
      },
    );
    expect(plan.refusals).toEqual([]);
    expect(askRedis(plan)).toMatchObject({ published: 16379 });
  });

  it("answers the port a lane claimed directly with CINATRA_REDIS_HOST_PORT", () => {
    const plan = planFor(
      { COMPOSE_PROJECT_NAME: "p2839", CINATRA_REDIS_HOST_PORT: "16379" },
      {
        NANGO_SERVER_URL: "http://127.0.0.1:13003",
        NANGO_DATABASE_URL: "postgresql://n:n@127.0.0.1:15435/nango",
      },
    );
    expect(plan.refusals).toEqual([]);
    expect(askRedis(plan)).toMatchObject({ published: 16379 });
  });

  it("reports a stand-down for a service the plan claims no host port for", () => {
    const plan = planFor(
      { COMPOSE_PROJECT_NAME: "p2839" },
      {
        REDIS_URL: "redis://redis.example.com:6379",
        NANGO_SERVER_URL: "http://127.0.0.1:13003",
        NANGO_DATABASE_URL: "postgresql://n:n@127.0.0.1:15435/nango",
      },
    );
    expect(askRedis(plan)).toMatchObject({ standDown: true });
    expect(askRedis(plan).published).toBeUndefined();
  });

  // postgres and neo4j are NOT parameterized by the plan — the compose files
  // state their host ports — so this must keep answering the fixed default even
  // for a fully-scoped lane, or the diagnosis would move a port nothing moved.
  it("keeps the fixed default for a service the plan does not parameterize", () => {
    const plan = planFor(
      { COMPOSE_PROJECT_NAME: "p2839", CINATRA_REDIS_HOST_PORT: "16379" },
      {
        NANGO_SERVER_URL: "http://127.0.0.1:13003",
        NANGO_DATABASE_URL: "postgresql://n:n@127.0.0.1:15435/nango",
      },
    );
    expect(
      resolvePublishedHostPort({
        composeService: POSTGRES.composeService,
        defaultHostPort: POSTGRES.defaultHostPort,
        plan,
      }),
    ).toEqual({ published: 5434, parameterized: false });
  });

  it("falls back to the default when handed no plan at all", () => {
    expect(
      resolvePublishedHostPort({
        composeService: REDIS.composeService,
        defaultHostPort: REDIS.defaultHostPort,
      }),
    ).toMatchObject({ published: 6379 });
  });

  // The gate the resolver feeds: same connect port, two different published
  // ports, two different answers.
  it("is what makes shouldDiagnoseDrift ask about the lane's port", () => {
    const at = (port, published) =>
      shouldDiagnoseDrift({ host: "127.0.0.1", port }, REDIS, published);
    expect(at(16379, 16379)).toBe(true);
    expect(at(16379, 6379)).toBe(false);
    expect(at(6379, 16379)).toBe(false);
    // Unchanged for a caller that states nothing — the pre-#2839 signature.
    expect(shouldDiagnoseDrift({ host: "127.0.0.1", port: 6379 }, REDIS)).toBe(true);
  });
});

// The second caller of the same diagnosis. `pnpm check:services` reported drift
// too, and it read the global default AND passed no project — so on a lane it
// inspected the basename-derived project rather than the lane's. One mechanism
// may not have one honest caller and one dishonest one.
describe("check-services.mjs reads the same plan as the launcher", () => {
  const source = readFileSync(path.join(REPO_ROOT, "scripts", "check-services.mjs"), "utf8");

  it("resolves the published host port instead of the hardcoded default", () => {
    expect(source).toContain("resolvePublishedHostPort");
    expect(source).toMatch(/shouldDiagnoseDrift\([^)]*claim\.published\)/s);
  });

  it("pins its drift diagnosis to the resolved compose project", () => {
    expect(source).toMatch(/diagnoseDockerPortDrift\(\{[^}]*projectName: composeProjectName/s);
  });

  it("stands down for a service the plan claims no host port for", () => {
    expect(source).toContain("if (claim.standDown) continue;");
  });
});

// ---------------------------------------------------------------------------
// formatConnectPortMismatch — published here, connected there
// ---------------------------------------------------------------------------
describe("formatConnectPortMismatch", () => {
  const claim = {
    parameterized: true,
    published: 16379,
    envVar: "CINATRA_REDIS_HOST_PORT",
    urlVar: "REDIS_URL",
  };

  it("names both ports and both fixes when a lane publishes one and connects to another", () => {
    const message = formatConnectPortMismatch({
      service: "Redis",
      claim,
      connectHost: "127.0.0.1",
      connectPort: 6379,
      laneScope: "lane",
    });
    expect(message).toContain("published on host port 16379");
    expect(message).toContain("the app connects on 6379");
    expect(message).toContain("REDIS_URL");
    expect(message).toContain("CINATRA_REDIS_HOST_PORT");
  });

  it("says nothing when the published port IS the connect port", () => {
    expect(
      formatConnectPortMismatch({
        service: "Redis",
        claim,
        connectHost: "127.0.0.1",
        connectPort: 16379,
        laneScope: "lane",
      }),
    ).toBeUndefined();
  });

  // The immunity every rule in this module states explicitly: a checkout that
  // names no compose project is the operator's single stack, and nothing here
  // remarks on it.
  it("never remarks on the unscoped checkout", () => {
    for (const laneScope of ["unscoped", undefined]) {
      expect(
        formatConnectPortMismatch({
          service: "Redis",
          claim,
          connectHost: "127.0.0.1",
          connectPort: 6379,
          laneScope,
        }),
      ).toBeUndefined();
    }
  });

  // postgres/neo4j host ports are pinned in the compose files, so a lane whose
  // DSN names another one of those is the ordinary external-service case.
  it("says nothing about a service the plan does not parameterize", () => {
    expect(
      formatConnectPortMismatch({
        service: "PostgreSQL",
        claim: { parameterized: false, published: 5434 },
        connectHost: "127.0.0.1",
        connectPort: 15434,
        laneScope: "lane",
      }),
    ).toBeUndefined();
  });

  it("says nothing about a service the plan stood down", () => {
    expect(
      formatConnectPortMismatch({
        service: "Redis",
        claim: { ...claim, standDown: true, published: undefined },
        connectHost: "127.0.0.1",
        connectPort: 6379,
        laneScope: "lane",
      }),
    ).toBeUndefined();
  });

  // The operator's own no-op pin is still a SCOPED checkout: a warning never
  // takes `make dev` away, and the bleed is just as real there.
  it("warns on the checkout's own pin too — it is a warning, not a refusal", () => {
    expect(
      formatConnectPortMismatch({
        service: "Redis",
        claim,
        connectHost: "127.0.0.1",
        connectPort: 6379,
        laneScope: "checkout",
      }),
    ).toBeDefined();
  });
});

// The same note on the other surface an operator reads.
describe("check-services.mjs reports the connect/publish mismatch too", () => {
  const source = readFileSync(path.join(REPO_ROOT, "scripts", "check-services.mjs"), "utf8");

  it("builds the note from the shared formatter, not a second wording", () => {
    expect(source).toContain("formatConnectPortMismatch");
    expect(source).toMatch(/laneScope: composeHostPortPlan\.laneScope/);
  });

  it("prints what it collected", () => {
    expect(source).toMatch(/for \(const note of mismatchNotes\)/);
  });
});

// Round-2 Codex finding: the note is built from the plan, which reads the shell
// first — so the endpoint it is compared against must too, or an exported
// service URL makes the check accuse a lane of a mismatch the app and the plan
// agree on. (This surface is source-level; the launcher's own precedence is
// covered end to end above, where `runLauncher` deletes every shell variable
// precisely because a shell value outranks the file.)
describe("check-services.mjs resolves service endpoints shell-over-file", () => {
  const source = readFileSync(path.join(REPO_ROOT, "scripts", "check-services.mjs"), "utf8");

  it("overlays the shell value over the .env.local one for every endpoint it reads", () => {
    expect(source).toMatch(/const env = \{ \.\.\.fileEnv \};/);
    expect(source).toMatch(/for \(const key of ENDPOINT_VARS\)/);
    expect(source).toMatch(/const shell = process\.env\[key\];/);
  });

  // Every URL the check turns into a probed endpoint must be in the list, or
  // that one service keeps the old file-only precedence silently.
  it("covers every service URL the check probes", () => {
    const probed = [...source.matchAll(/hostPort\(env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(probed.length).toBeGreaterThan(0);
    const declared = source.slice(
      source.indexOf("const ENDPOINT_VARS = ["),
      source.indexOf("];", source.indexOf("const ENDPOINT_VARS = [")),
    );
    for (const key of new Set(probed)) {
      expect(declared, `${key} is probed but keeps file-only precedence`).toContain(`"${key}"`);
    }
  });

  // …and nothing else: the MCP fallback vars are deliberately file-only, which
  // their own note in that file states.
  it("leaves the deliberately file-only MCP vars alone", () => {
    const declared = source.slice(
      source.indexOf("const ENDPOINT_VARS = ["),
      source.indexOf("];", source.indexOf("const ENDPOINT_VARS = [")),
    );
    expect(declared).not.toContain("MCP_PUBLIC_BASE_URL");
    expect(declared).not.toContain("APP_PUBLIC_URL");
  });
});

// Codex round-2 hardening: a claim whose published port is not a port can only
// produce a message that names a non-port.
describe("formatConnectPortMismatch refuses to name a non-port", () => {
  it("says nothing when the claim carries no usable published port", () => {
    for (const published of [undefined, NaN, 0, 70000, "nope"]) {
      expect(
        formatConnectPortMismatch({
          service: "Redis",
          claim: { parameterized: true, published, envVar: "V", urlVar: "U" },
          connectPort: 6379,
          laneScope: "lane",
        }),
      ).toBeUndefined();
    }
  });

  it("says nothing when the connect port is not a port", () => {
    for (const connectPort of [undefined, NaN, 0, 70000]) {
      expect(
        formatConnectPortMismatch({
          service: "Redis",
          claim: { parameterized: true, published: 16379, envVar: "V", urlVar: "U" },
          connectPort,
          laneScope: "lane",
        }),
      ).toBeUndefined();
    }
  });
});

// Round-3 Codex finding: `resolvePublishedHostPort` falls back to the historical
// default when a plan resolved no key, on the stated assumption that the caller
// already stood the run down on the refusal. The launcher does (`planRefused`);
// the reporting surface did not, so it could name a port compose was never going
// to publish.
describe("check-services.mjs stands down on a refused plan, as the launcher does", () => {
  const source = readFileSync(path.join(REPO_ROOT, "scripts", "check-services.mjs"), "utf8");

  it("gates the whole Docker-inspecting block on the plan resolving", () => {
    expect(source).toMatch(/const planRefused = composeHostPortPlan\.refusals\.length > 0;/);
    expect(source).toMatch(/if \(!planRefused\) \{/);
  });

  // The gate moved DOWN one level (round-4 review finding 3): the note is owed
  // to every bundled service, the Docker inspection only to a service that is
  // down. Pinned as source text because the behavioral cases below prove the
  // note; this states which of the two the down set is allowed to decide.
  it("keeps the down set on the drift diagnosis, not on the note", () => {
    expect(source).toMatch(/const down = downByLabel\.get\(svc\.label\);\n\s*if \(!down\) continue;\n\s*if \(!shouldDiagnoseDrift/);
  });

  it("prints the refusals rather than swallowing them", () => {
    expect(source).toMatch(/planMessages\(composeHostPortPlan\.refusals\)/);
  });

  it("resolves the app's own port shell-over-file too", () => {
    expect(source).toMatch(/Number\(process\.env\.PORT\) \|\| Number\(fileEnv\.PORT\)/);
  });
});

// ---------------------------------------------------------------------------
// Round-4 review: the mismatch warning must be TRUE before it is loud
// ---------------------------------------------------------------------------
//
// `formatConnectPortMismatch` states a strong claim — "whatever answers on that
// port is somebody else's" — and prescribes re-pointing the URL at loopback.
// Two inputs decide whether that claim is true at all, and the first version
// read neither: the connection HOST (a lane may connect to an external service
// by design, where both halves of the message are false) and whether an
// UNSCOPED checkout STATED a host port of its own (where the message is the
// only signal left, because the drift diagnosis skips the mismatched port).
describe("formatConnectPortMismatch is host-aware", () => {
  const claim = {
    parameterized: true,
    published: 16379,
    envVar: "CINATRA_REDIS_HOST_PORT",
    urlVar: "REDIS_URL",
  };

  // The negative control the review asks for. A lane pointing REDIS_URL at a
  // non-loopback host runs against an external/shared service ON PURPOSE. The
  // message would tell it the remote answer belongs to another local stack and
  // advise re-pointing at 127.0.0.1 — a false claim and an unsafe remedy. This
  // is the same test `shouldDiagnoseDrift` keeps for the same reason.
  it("says nothing when the app connects to a NON-loopback host", () => {
    for (const connectHost of ["192.0.2.10", "redis.example.com", "10.0.0.5"]) {
      expect(
        formatConnectPortMismatch({
          service: "Redis",
          claim,
          connectHost,
          connectPort: 6379,
          laneScope: "lane",
        }),
        `expected silence for ${connectHost}`,
      ).toBeUndefined();
    }
  });

  it("still speaks for every loopback spelling", () => {
    for (const connectHost of ["127.0.0.1", "localhost", "::1", "0.0.0.0"]) {
      expect(
        formatConnectPortMismatch({
          service: "Redis",
          claim,
          connectHost,
          connectPort: 6379,
          laneScope: "lane",
        }),
        `expected a message for ${connectHost}`,
      ).toBeDefined();
    }
  });

  // The unscoped checkout's immunity covers what it OMITS, not what it STATES.
  // A checkout that wrote CINATRA_REDIS_HOST_PORT=16379 made a claim, and the
  // plan honored it regardless of scope; measuring the app's 6379 against that
  // published 16379 also switches the drift diagnosis off, so this note is the
  // only thing between the operator and an ECONNREFUSED in app boot.
  it("reaches an unscoped checkout that STATED its own host port", () => {
    const message = formatConnectPortMismatch({
      service: "Redis",
      claim: { ...claim, stated: true },
      connectHost: "127.0.0.1",
      connectPort: 6379,
      laneScope: "unscoped",
    });
    expect(message).toContain("published on host port 16379");
    expect(message).toContain("the app connects on 6379");
  });

  // …and the immunity still holds for the checkout that stated nothing: its
  // published port is the historical default it would have used anyway.
  it("still never remarks on an unscoped checkout that stated nothing", () => {
    for (const laneScope of ["unscoped", undefined]) {
      expect(
        formatConnectPortMismatch({
          service: "Redis",
          claim,
          connectHost: "127.0.0.1",
          connectPort: 6379,
          laneScope,
        }),
      ).toBeUndefined();
    }
  });
});

// The plan has to REMEMBER which claims the operator typed, or the rule above
// cannot be asked. `stated` is exactly the direct CINATRA_*_HOST_PORT claims —
// a derived companion port and a historical default are not statements.
describe("resolveComposeHostPortPlan records the ports the operator STATED", () => {
  const planFor = (processEnv, envFile = {}) =>
    resolveComposeHostPortPlan({
      processEnv,
      envFileLookup: (key) => envFile[key],
      projectName: processEnv.COMPOSE_PROJECT_NAME,
      defaultProjectName: "/tmp/some-checkout",
    });

  it("lists a direct claim and nothing else", () => {
    const plan = planFor({ CINATRA_REDIS_HOST_PORT: "16379" });
    expect(plan.stated).toContain("CINATRA_REDIS_HOST_PORT");
    expect(plan.stated).not.toContain("CINATRA_NANGO_SERVER_HOST_PORT");
    expect(plan.stated).not.toContain("CINATRA_NANGO_CONNECT_HOST_PORT");
  });

  it("is empty for a checkout that stated no host port at all", () => {
    expect(planFor({}).stated).toEqual([]);
  });

  it("does not count a port read out of a service URL as a direct claim", () => {
    const plan = planFor(
      { COMPOSE_PROJECT_NAME: "p2913" },
      {
        REDIS_URL: "redis://127.0.0.1:16379",
        NANGO_SERVER_URL: "http://127.0.0.1:13003",
        NANGO_DATABASE_URL: "postgresql://n:n@127.0.0.1:15435/nango",
      },
    );
    expect(plan.refusals).toEqual([]);
    expect(plan.stated).toEqual([]);
  });

  it("hands the claim through resolvePublishedHostPort so the formatter can ask", () => {
    const REDIS = BUNDLED_DB_SERVICES.find((s) => s.composeService === "redis");
    const ask = (plan) =>
      resolvePublishedHostPort({
        composeService: REDIS.composeService,
        defaultHostPort: REDIS.defaultHostPort,
        plan,
      });
    expect(ask(planFor({ CINATRA_REDIS_HOST_PORT: "16379" }))).toMatchObject({
      published: 16379,
      stated: true,
    });
    expect(ask(planFor({}))).toMatchObject({ published: 6379, stated: false });
  });
});

// ---------------------------------------------------------------------------
// check-services.mjs, EXECUTED — not grepped (round-4 review finding 5)
// ---------------------------------------------------------------------------
//
// Every earlier assertion about this file matched STRINGS in its source. Those
// pins are kept (they are cheap and they name the shared resolver), but they
// cannot fail on behavior: they pass with the block unreachable, with the note
// built from the wrong reader, and with the note gated on the down set. Two
// review findings arrived through exactly that gap. So the real file is run as
// a subprocess against a fixture `.env.local`, with a `docker` stub that fails
// every call — the same shape the launcher's own guards use, and the reason
// nothing containerized is ever started here.
//
// The script resolves its `.env.local` from its OWN location, so the fixture is
// a temp tree holding a copy of the script and the four dependency-free
// libraries it imports. What runs is the shipped file, byte for byte.
describe("check-services.mjs, run against a fixture .env.local", () => {
  let dir;
  let script;
  let listener;
  let upPort;
  const closed = {};

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "cinatra-2913-check-"));
    mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
    copyFileSync(
      path.join(REPO_ROOT, "scripts", "check-services.mjs"),
      path.join(dir, "scripts", "check-services.mjs"),
    );
    for (const file of [
      "dev-preflight.mjs",
      "docker-port-drift.mjs",
      "nango-health.mjs",
      "wayflow-down-hint.mjs",
    ]) {
      copyFileSync(
        path.join(REPO_ROOT, "scripts", "lib", file),
        path.join(dir, "scripts", "lib", file),
      );
    }
    script = path.join(dir, "scripts", "check-services.mjs");

    // `docker`, first on PATH, that fails every call: the drift diagnosis
    // degrades to "unavailable" exactly as it does on a host without Docker,
    // and NOTHING can be started by this suite even in principle.
    const bin = path.join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, "docker");
    writeFileSync(shim, "#!/bin/sh\nexit 1\n");
    chmodSync(shim, 0o755);

    // One real listener on an ephemeral port. It is the only way to assert the
    // note exists while the service reads UP — the review's finding 3 — without
    // going anywhere near the operator's own 6379.
    listener = net.createServer(() => {});
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    upPort = listener.address().port;

    for (const key of ["redis", "pg", "nango", "nangoDb", "graphiti", "wayflow", "app"]) {
      closed[key] = await reserveClosedPort();
    }
  });

  afterAll(() => {
    listener?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The services this check probes that are NOT under test, each pointed at a
   * reserved closed port so no case depends on what the operator happens to be
   * running. (Verdaccio and Neo4j have no env var — their rows are never
   * asserted on.)
   */
  const baseLines = () => [
    `PORT=${closed.app}`,
    `NANGO_SERVER_URL=http://127.0.0.1:${closed.nango}`,
    `NANGO_DATABASE_URL=postgresql://n:n@127.0.0.1:${closed.nangoDb}/nango`,
    `SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:${closed.pg}/postgres`,
    `GRAPHITI_URL=http://127.0.0.1:${closed.graphiti}`,
    `WAYFLOW_BASE_URL=http://127.0.0.1:${closed.wayflow}`,
  ];

  const run = (lines) => {
    writeFileSync(path.join(dir, ".env.local"), [...baseLines(), ...lines, ""].join("\n"));
    const env = {
      ...process.env,
      NO_COLOR: "1",
      PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
    };
    // Every input is stated in the fixture file; a shell value outranks it, so
    // an ambient one would decide the case instead of the case.
    for (const key of [
      "COMPOSE_PROJECT_NAME",
      "PORT",
      "REDIS_URL",
      "SUPABASE_DB_URL",
      "NEO4J_URI",
      "NANGO_SERVER_URL",
      "NANGO_DATABASE_URL",
      "GRAPHITI_URL",
      "WAYFLOW_BASE_URL",
      "CINATRA_WAYFLOW_RUNTIME",
      "MCP_PUBLIC_BASE_URL",
      "APP_PUBLIC_URL",
    ]) {
      delete env[key];
    }
    for (const spec of PREFLIGHT_HOST_PORTS) delete env[spec.envVar];

    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      timeout: 120_000,
      env,
    });
    expect(result.error, `check-services failed to run: ${result.error}`).toBeUndefined();
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(out, "check-services produced no output").toContain("Cinatra service check");
    return out;
  };

  /** The one printed row for a service, so an assertion names a row not a file. */
  const row = (out, name) =>
    out.split("\n").find((line) => line.includes(`  ${name}  `) || line.includes(` ${name} `)) ?? "";

  // Finding 1. `readEnvLocal` did not strip dotenv inline comments; the plan's
  // reader does. A lane annotating its cache URL was told its own correct
  // configuration was the cross-lane bleed — and its Redis row probed the
  // OPERATOR's port while reporting under the lane's name.
  it("does not accuse a lane whose REDIS_URL carries an inline comment", () => {
    const out = run([
      "COMPOSE_PROJECT_NAME=p2913lane",
      `REDIS_URL=redis://127.0.0.1:${closed.redis} # lane cache`,
    ]);
    expect(row(out, "Redis")).toContain(`127.0.0.1:${closed.redis}`);
    expect(out).not.toContain("is published on host port");
  });

  // Finding 3. The bleed this note exists for makes the service read UP: the
  // lane publishes its own redis while the app talks to one that answers on the
  // shared port. Building the note inside the down-set gate meant it could only
  // appear when there was no bleed to report.
  it("prints the mismatch note while the service reads UP", () => {
    const out = run([
      "COMPOSE_PROJECT_NAME=p2913lane",
      `CINATRA_REDIS_HOST_PORT=${closed.redis}`,
      `REDIS_URL=redis://127.0.0.1:${upPort}`,
    ]);
    expect(row(out, "Redis")).toContain("up");
    expect(out).toContain(`Redis is published on host port ${closed.redis}`);
    expect(out).toContain(`the app connects on ${upPort}`);
  });

  // The new medium. A lane pointing at an external redis by design is not
  // bleeding into anybody's stack, and "re-point REDIS_URL at 127.0.0.1" would
  // move it off the service it was configured for.
  it("says nothing when the app connects to a non-loopback host", () => {
    const out = run([
      "COMPOSE_PROJECT_NAME=p2913lane",
      `CINATRA_REDIS_HOST_PORT=${closed.redis}`,
      "REDIS_URL=redis://192.0.2.10:6379",
    ]);
    expect(out).not.toContain("is published on host port");
  });

  // Finding 4, on this surface: an unscoped checkout that STATED a host port
  // got total silence, because the note's unscoped guard covered what a
  // checkout omits and what it states alike.
  it("reaches an unscoped checkout that stated its own host port", () => {
    const out = run([
      `CINATRA_REDIS_HOST_PORT=${closed.redis}`,
      `REDIS_URL=redis://127.0.0.1:${upPort}`,
    ]);
    expect(out).toContain(`Redis is published on host port ${closed.redis}`);
  });

  // …and the immunity that argument protects is intact: a checkout that stated
  // no host port publishes the historical default and is never remarked on.
  it("still says nothing to an unscoped checkout that stated no host port", () => {
    const out = run([`REDIS_URL=redis://127.0.0.1:${upPort}`]);
    expect(out).not.toContain("is published on host port");
  });

  // The plan's stand-down still reaches this surface unchanged: a refused plan
  // prints its refusals instead of naming ports compose will not publish.
  it("prints the plan's refusals instead of a note when the plan does not resolve", () => {
    const out = run([
      "COMPOSE_PROJECT_NAME=p2913lane",
      "CINATRA_REDIS_HOST_PORT=not-a-port",
    ]);
    expect(out).toContain("Compose host-port scoping is unresolved");
    expect(out).not.toContain("is published on host port");
  });
});
