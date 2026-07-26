import { describe, expect, it, vi } from "vitest";

import {
  CookieJar,
  DEMO_DEFAULTS,
  SUPPORTED_PLANE_VERSIONS,
  mintPlaneToken,
  probePlaneVersion,
  provisionPlane,
  readEnvValue,
  redirectErrorCode,
  resolveOptions,
  slugify,
  trimTrailingSlashes,
  upsertEnvAll,
  upsertEnvContent,
  validatePlaneToken,
} from "../fixtures/provision-plane.mjs";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("provision-plane pure helpers", () => {
  it("trimTrailingSlashes strips trailing slashes only", () => {
    expect(trimTrailingSlashes("http://x/")).toBe("http://x");
    expect(trimTrailingSlashes("http://x///")).toBe("http://x");
    expect(trimTrailingSlashes("http://x")).toBe("http://x");
  });

  it("slugify lowercases + collapses invalid chars", () => {
    expect(slugify("ACME Group")).toBe("acme-group");
    expect(slugify("A_b.C")).toBe("a-b-c");
    expect(slugify("")).toBe("workspace");
  });

  it("upsertEnvContent rewrites-if-present, appends-if-absent, ignores commented", () => {
    expect(upsertEnvContent("", "A", "1")).toBe("A=1\n");
    expect(upsertEnvContent("A=old\n", "A", "new")).toBe("A=new\n");
    expect(upsertEnvContent("B=2", "A", "1")).toBe("B=2\nA=1\n");
    // A commented line is NOT rewritten — a fresh active line is appended.
    expect(upsertEnvContent("# A=x\n", "A", "1")).toBe("# A=x\nA=1\n");
    // A `$`-bearing value is written VERBATIM (function-replacement guards
    // against `$&`/`$'`/`` $` ``/`$1` being interpreted as replacement patterns).
    expect(upsertEnvContent("K=old\n", "K", "a$&b$`c$1")).toBe("K=a$&b$`c$1\n");
  });

  it("upsertEnvAll + readEnvValue round-trip", () => {
    const content = upsertEnvAll("", [
      ["PLANE_API_KEY", "plane_api_abc"],
      ["PLANE_WORKSPACE_SLUG", "acme"],
    ]);
    expect(readEnvValue(content, "PLANE_API_KEY")).toBe("plane_api_abc");
    expect(readEnvValue(content, "PLANE_WORKSPACE_SLUG")).toBe("acme");
    expect(readEnvValue(content, "MISSING")).toBeNull();
  });

  it("redirectErrorCode extracts a Location error_code (null on success)", () => {
    expect(redirectErrorCode("http://localhost:3400/?error_code=BAD", "http://localhost:3400")).toBe("BAD");
    expect(redirectErrorCode("http://localhost:3400/spaces", "http://localhost:3400")).toBeNull();
    expect(redirectErrorCode(null, "http://localhost:3400")).toBeNull();
  });

  it("resolveOptions applies demo defaults + slugifies", () => {
    const o = resolveOptions({});
    expect(o.adminEmail).toBe(DEMO_DEFAULTS.adminEmail);
    expect(o.workspaceSlug).toBe("acme");
    const o2 = resolveOptions({ PLANE_WORKSPACE_SLUG: "My WS", PLANE_URL: "http://localhost:3400/" });
    expect(o2.workspaceSlug).toBe("my-ws");
  });

  it("CookieJar absorbs Set-Cookie and replays as a Cookie header", () => {
    const jar = new CookieJar();
    jar.absorb({ headers: { getSetCookie: () => ["session=abc; Path=/; HttpOnly", "csrftoken=xyz; Path=/"] } });
    expect(jar.get("session")).toBe("abc");
    expect(jar.get("csrftoken")).toBe("xyz");
    expect(jar.header()).toContain("session=abc");
    expect(jar.header()).toContain("csrftoken=xyz");
  });
});

// ---------------------------------------------------------------------------
// Network flow (injected fetch)
// ---------------------------------------------------------------------------

const jsonRes = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });

describe("validatePlaneToken", () => {
  it("200 -> ok, 401 -> unauthorized, 500 -> unreachable, throw -> unreachable", async () => {
    expect(await validatePlaneToken(async () => jsonRes([]), "http://x", "acme", "k")).toBe("ok");
    expect(await validatePlaneToken(async () => jsonRes({}, 401), "http://x", "acme", "k")).toBe("unauthorized");
    expect(await validatePlaneToken(async () => jsonRes({}, 500), "http://x", "acme", "k")).toBe("unreachable");
    expect(
      await validatePlaneToken(async () => {
        throw new Error("down");
      }, "http://x", "acme", "k"),
    ).toBe("unreachable");
  });
});

describe("probePlaneVersion", () => {
  it("reads the nested instance.current_version then the flat fallback", async () => {
    expect(await probePlaneVersion(async () => jsonRes({ instance: { current_version: "1.3.1" } }), "http://x")).toBe(
      "1.3.1",
    );
    expect(await probePlaneVersion(async () => jsonRes({ current_version: "1.4.0" }), "http://x")).toBe("1.4.0");
    expect(await probePlaneVersion(async () => jsonRes({}, 500), "http://x")).toBeNull();
  });
});

/**
 * A scripted fake Plane CE 1.3.1 for the CSRF sign-in -> mint sequence. Routes
 * by method + URL suffix; carries a fake cookie jar via getSetCookie.
 */
function makePlaneFetch({ projects = [], failSignIn = false } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${url}`);
    const setCookie = (name) => ({ "set-cookie": `${name}=v; Path=/` });
    const withGetSetCookie = (res, cookieName) => {
      // Node's Response exposes getSetCookie via headers; emulate for the jar.
      res.headers.getSetCookie = () => (cookieName ? [`${cookieName}=v; Path=/`] : []);
      return res;
    };
    if (url.endsWith("/auth/get-csrf-token/")) {
      return withGetSetCookie(jsonRes({ csrf_token: "csrf-123" }, 200, setCookie("csrftoken")), "csrftoken");
    }
    if (url.endsWith("/api/instances/admins/sign-up/")) {
      return withGetSetCookie(new Response("", { status: 302, headers: { location: "http://localhost:3400/" } }), "session");
    }
    if (url.endsWith("/auth/sign-in/")) {
      const loc = failSignIn ? "http://localhost:3400/?error_code=INVALID" : "http://localhost:3400/";
      return withGetSetCookie(new Response("", { status: 302, headers: { location: loc } }), "session");
    }
    if (url.endsWith("/api/workspaces/") && method === "POST") {
      return withGetSetCookie(jsonRes({ id: "ws-1", slug: "acme" }), null);
    }
    if (url.includes("/api/workspaces/") && url.endsWith("/projects/") && method === "GET") {
      return withGetSetCookie(jsonRes(projects), null);
    }
    if (url.includes("/api/workspaces/") && url.endsWith("/projects/") && method === "POST") {
      return withGetSetCookie(jsonRes({ id: "proj-created" }), null);
    }
    if (url.endsWith("/api/users/api-tokens/") && method === "POST") {
      return withGetSetCookie(jsonRes({ token: "plane_api_minted_0001" }), null);
    }
    return withGetSetCookie(new Response("", { status: 404 }), null);
  });
  return { fetchImpl, calls };
}

describe("mintPlaneToken", () => {
  it("drives the full sequence and returns the minted PAT (existing project reused)", async () => {
    const { fetchImpl, calls } = makePlaneFetch({ projects: [{ id: "proj-existing" }] });
    const out = await mintPlaneToken(fetchImpl, {
      baseUrl: "http://localhost:3400",
      adminEmail: "demo-admin@plane.localhost",
      adminPassword: "Cinatra-demo-plane-0",
      workspaceSlug: "acme",
      workspaceName: "ACME Group",
      tokenLabel: "cinatra-plane-mcp-demo",
    });
    expect(out).toEqual({ pat: "plane_api_minted_0001", workspaceSlug: "acme", projectId: "proj-existing" });
    expect(calls.some((c) => c.includes("/api/users/api-tokens/"))).toBe(true);
  });

  it("creates a project when the workspace has none", async () => {
    const { fetchImpl } = makePlaneFetch({ projects: [] });
    const out = await mintPlaneToken(fetchImpl, {
      baseUrl: "http://localhost:3400",
      adminEmail: "demo-admin@plane.localhost",
      adminPassword: "Cinatra-demo-plane-0",
      workspaceSlug: "acme",
    });
    expect(out.projectId).toBe("proj-created");
  });

  it("throws a DEFINITE error on a failed sign-in (never a transient re-mint trigger)", async () => {
    const { fetchImpl } = makePlaneFetch({ failSignIn: true });
    await expect(
      mintPlaneToken(fetchImpl, {
        baseUrl: "http://localhost:3400",
        adminEmail: "demo-admin@plane.localhost",
        adminPassword: "wrong",
        workspaceSlug: "acme",
      }),
    ).rejects.toMatchObject({ name: "PlaneProvisionError", transient: false });
  });
});

// ---------------------------------------------------------------------------
// Orchestration (injected fetch + in-memory IO)
// ---------------------------------------------------------------------------

function memIo(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    io: {
      readFileOr: (p, fb) => (store.has(p) ? store.get(p) : fb),
      writeFile: (p, content) => store.set(p, content),
      mkdirp: () => {},
    },
    store,
  };
}

describe("provisionPlane orchestration", () => {
  it("version-gated: an unsupported Plane version skips the mint (no write)", async () => {
    const { io, store } = memIo();
    const fetchImpl = async (url) =>
      url.endsWith("/api/instances/") ? jsonRes({ instance: { current_version: "9.9.9" } }) : jsonRes({}, 404);
    const r = await provisionPlane({ env: {}, fetchImpl, io });
    expect(r.status).toBe("skipped");
    expect(r.note).toBe("version-unsupported");
    expect(store.size).toBe(0);
  });

  it("reuse-first: an existing valid bridge PAT is reused (no mint)", async () => {
    const { io, store } = memIo();
    // Seed the bridge env with a prior PAT at the SAME absolute path the module
    // resolves (REPO_ROOT/docker/plane-mcp/.plane-mcp.env).
    const path = await import("node:path");
    const url = await import("node:url");
    const modUrl = new URL("../fixtures/provision-plane.mjs", import.meta.url);
    const repoRoot = path.resolve(path.dirname(url.fileURLToPath(modUrl)), "..", "..");
    const bridgeEnvAbs = path.resolve(repoRoot, "docker/plane-mcp/.plane-mcp.env");
    store.set(bridgeEnvAbs, "PLANE_API_KEY=plane_api_prior\nPLANE_WORKSPACE_SLUG=acme\n");

    // The prior PAT validates (projects list 200) — never reaches version/mint.
    const fetchImpl = vi.fn(async (u) => {
      if (u.includes("/api/v1/workspaces/") && u.endsWith("/projects/")) return jsonRes([]);
      throw new Error("should not be called for reuse (no version probe, no mint)");
    });
    const r = await provisionPlane({ env: {}, fetchImpl, io });
    expect(r.status).toBe("reused");
    expect(r.minted).toBe(false);
    expect(r.connected).toBe(true);
  });

  it("full mint: writes the bridge env (with PAT) + .env.local (without PAT)", async () => {
    const path = await import("node:path");
    const url = await import("node:url");
    const modUrl = new URL("../fixtures/provision-plane.mjs", import.meta.url);
    const repoRoot = path.resolve(path.dirname(url.fileURLToPath(modUrl)), "..", "..");
    const bridgeEnvAbs = path.resolve(repoRoot, "docker/plane-mcp/.plane-mcp.env");
    const envLocalAbs = path.resolve(repoRoot, ".env.local");

    const { io, store } = memIo();
    const scripted = makePlaneFetch({ projects: [{ id: "proj-existing" }] });
    const fetchImpl = async (u, init) => {
      if (u.endsWith("/api/instances/")) return jsonRes({ instance: { current_version: "1.3.1" } });
      if (u.includes("/api/v1/workspaces/") && u.endsWith("/projects/")) return jsonRes([]); // validate -> ok
      return scripted.fetchImpl(u, init);
    };
    const r = await provisionPlane({ env: {}, fetchImpl, io });
    expect(r.status).toBe("connected");
    expect(r.minted).toBe(true);
    expect(SUPPORTED_PLANE_VERSIONS).toContain(r.version);

    const bridgeEnv = store.get(bridgeEnvAbs);
    expect(bridgeEnv).toContain("PLANE_API_KEY=plane_api_minted_0001");
    expect(bridgeEnv).toContain("PLANE_WORKSPACE_SLUG=acme");
    expect(bridgeEnv).toContain("PLANE_BASE_URL=http://api:8000");

    const envLocal = store.get(envLocalAbs);
    expect(envLocal).toContain("PLANE_URL=http://localhost:3400");
    expect(envLocal).toContain("PLANE_WORKSPACE_SLUG=acme");
    expect(envLocal).toContain("PLANE_MCP_URL=http://localhost:3450/mcp");
    // The PAT is NEVER written to the app env.
    expect(envLocal).not.toContain("plane_api_minted_0001");
    expect(envLocal).not.toContain("PLANE_API_KEY=");
  });
});
