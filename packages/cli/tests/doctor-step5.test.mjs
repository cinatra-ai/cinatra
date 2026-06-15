// Focused unit tests for cinatra#260 Step 5 — the built-in `cinatra doctor`
// content-editor write-path self-check.
//
// Verifies the codex must-fixes specifically:
//   - creds + public URL asserted as ONE AND (no false PASS from two greens);
//     creds-only must FAIL (the documented false-PASS trap).
//   - an unreachable token endpoint / local /api/mcp / public URL / CMS is
//     SKIPPED-with-warning, NEVER passed.
//   - per-assertion verdicts (pass / fail / skip), incl. CMS-write tool presence.
//   - dev-app clone presence.
//   - SECRET BOUNDARY: no token/secret ever appears in an assertion object.
//
// Hermetic: a mock pg client + injected fetch + injected docker runner. No live
// DB, no app, no docker.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect } from "vitest";

import {
  gatherDoctorReport,
  deriveConfiguredPublicMcpUrl,
  doctorAssertLlmMcpAccess,
  doctorAssertDevAppsPresence,
  DOCTOR_CMS_WRITE_TOOLS,
  LLM_MCP_SETTINGS_KEY,
  MCP_SETTINGS_KEY,
} from "../src/index.mjs";

// --- Mock pg client: answers metadata SELECTs from a programmable store -----
function createMetadataClient(store = {}) {
  return {
    async query(text, params) {
      const sql = String(text);
      if (/select value from .*\.metadata where key/i.test(sql)) {
        const key = params?.[0];
        const value = store[key];
        return { rows: value === undefined ? [] : [{ value: JSON.stringify(value) }], rowCount: value === undefined ? 0 : 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const SCHEMA = "cinatra";
const ENV = { BETTER_AUTH_URL: "http://localhost:3000" };

// connector_config:* keys are stored under the bare suffix in metadata reads.
const LLM_KEY = LLM_MCP_SETTINGS_KEY; // "connector_config:llm_mcp_access"
const MCP_KEY = MCP_SETTINGS_KEY; // "connector_config:mcp_server"

function provisionedLlm() {
  return {
    providers: {
      openai: { clientId: "cinatra-llm-openai", clientSecret: "plain-secret-openai", scope: "mcp:connect" },
    },
  };
}

function publicUrlRow() {
  return { publicBaseUrl: "https://node.example.ts.net", publicBaseUrlSource: "tailscale-auto" };
}

// A fetch stub router keyed by (url, method).
function makeFetch(routes) {
  return async function fetchImpl(url, opts = {}) {
    const method = opts.method ?? "GET";
    const key = `${method} ${url}`;
    const handler = routes[key] ?? routes[url] ?? routes.__default;
    if (!handler) throw new Error(`unrouted fetch: ${key}`);
    return handler(url, opts);
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function throwingFetch() {
  return async function () {
    throw new Error("ECONNREFUSED");
  };
}

// A docker runner stub keyed by the first meaningful arg.
function makeDocker({ running = [], plugins = [], modules = [] } = {}) {
  return function dockerImpl(args) {
    if (args[0] === "ps") {
      const filter = args.find((a) => a.startsWith("name=^/"));
      const name = filter ? filter.replace("name=^/", "").replaceAll("$", "") : "";
      return { status: 0, stdout: running.includes(name) ? name : "" };
    }
    if (args[0] === "exec" && args.includes("plugin")) {
      return { status: 0, stdout: plugins.join("\n") };
    }
    if (args[0] === "exec" && args.includes("pm:list")) {
      return { status: 0, stdout: modules.join("\n") };
    }
    return { status: -1, stdout: "" };
  };
}

const NO_DOCKER = () => {
  throw new Error("docker not found");
};

function byId(report, id) {
  return report.assertions.find((a) => a.id === id);
}

// =========================================================================
// deriveConfiguredPublicMcpUrl — mirrors the RUNTIME read, not CLI validation
// =========================================================================
describe("deriveConfiguredPublicMcpUrl", () => {
  it("appends /api/mcp to a valid origin", () => {
    expect(deriveConfiguredPublicMcpUrl({ publicBaseUrl: "https://x.ts.net" })).toBe(
      "https://x.ts.net/api/mcp",
    );
  });
  it("drops a source==='cli' (retired tunnel) URL", () => {
    expect(
      deriveConfiguredPublicMcpUrl({ publicBaseUrl: "https://dead.example", publicBaseUrlSource: "cli" }),
    ).toBeNull();
  });
  it("normalizes a legacy pathful URL to origin (does NOT reject it)", () => {
    // normalizeOptionalUrl would reject a path; the runtime read normalizes it.
    expect(deriveConfiguredPublicMcpUrl({ publicBaseUrl: "https://x.ts.net/legacy/path" })).toBe(
      "https://x.ts.net/api/mcp",
    );
  });
  it("returns null for empty / invalid / non-http", () => {
    expect(deriveConfiguredPublicMcpUrl({})).toBeNull();
    expect(deriveConfiguredPublicMcpUrl({ publicBaseUrl: "   " })).toBeNull();
    expect(deriveConfiguredPublicMcpUrl({ publicBaseUrl: "ftp://x" })).toBeNull();
    expect(deriveConfiguredPublicMcpUrl({ publicBaseUrl: "not a url" })).toBeNull();
  });
});

// =========================================================================
// 1+2 — single AND (the false-PASS trap)
// =========================================================================
describe("doctorAssertLlmMcpAccess — creds AND public URL as ONE AND", () => {
  it("PASS only when BOTH creds and public URL are present", async () => {
    const client = createMetadataClient({ [LLM_KEY]: provisionedLlm(), [MCP_KEY]: publicUrlRow() });
    const { assertion, publicMcpUrl } = await doctorAssertLlmMcpAccess(client, SCHEMA);
    expect(assertion.verdict).toBe("pass");
    expect(publicMcpUrl).toBe("https://node.example.ts.net/api/mcp");
  });

  it("FAILS (not passes) when creds present but NO public URL — the false-PASS trap", async () => {
    const client = createMetadataClient({ [LLM_KEY]: provisionedLlm(), [MCP_KEY]: {} });
    const { assertion } = await doctorAssertLlmMcpAccess(client, SCHEMA);
    expect(assertion.verdict).toBe("fail");
    expect(assertion.detail).toMatch(/NO public MCP URL/i);
  });

  it("FAILS when public URL present but no creds", async () => {
    const client = createMetadataClient({ [LLM_KEY]: {}, [MCP_KEY]: publicUrlRow() });
    const { assertion } = await doctorAssertLlmMcpAccess(client, SCHEMA);
    expect(assertion.verdict).toBe("fail");
  });

  it("FAILS when neither present", async () => {
    const client = createMetadataClient({});
    const { assertion } = await doctorAssertLlmMcpAccess(client, SCHEMA);
    expect(assertion.verdict).toBe("fail");
  });
});

// =========================================================================
// 8 — dev-app clone presence
// =========================================================================
describe("doctorAssertDevAppsPresence", () => {
  it("SKIPS when no cinatra.devApps config is found at the given root", () => {
    // packages/cli has no cinatra.devApps config → SKIP (not a pass/fail).
    const a = doctorAssertDevAppsPresence(process.cwd());
    expect(a.verdict).toBe("skip");
  });

  it("resolves config from the real repo root (pass when clones present, fail when missing)", () => {
    // The repo root has the config; the dev/ clones are gitignored and may be
    // absent in a fresh worktree. Either pass or fail is valid — SKIP is NOT.
    const repoRoot = path.resolve(process.cwd(), "../..");
    const a = doctorAssertDevAppsPresence(repoRoot);
    expect(["pass", "fail"]).toContain(a.verdict);
  });

  it("FAILS with a clear remediation when a configured clone is missing", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "doctor-devapps-"));
    writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({
        cinatra: {
          devApps: {
            "@cinatra-ai/wordpress-plugin": { path: "dev/wordpress-plugin" },
            "@cinatra-ai/drupal-module": { path: "dev/drupal-module/cinatra" },
          },
        },
      }),
    );
    const a = doctorAssertDevAppsPresence(tmp);
    expect(a.verdict).toBe("fail");
    expect(a.detail).toMatch(/dev\/wordpress-plugin/);
    expect(a.remediation).toMatch(/cinatra setup dev/);
  });

  it("FAILS when config exists but a required CMS entry is UNDECLARED (codex must-fix)", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "doctor-devapps-partial-"));
    // Config present but omits the Drupal entry entirely.
    writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({
        cinatra: {
          devApps: {
            "@cinatra-ai/wordpress-plugin": { path: "dev/wordpress-plugin" },
          },
        },
      }),
    );
    mkdirSync(path.join(tmp, "dev/wordpress-plugin"), { recursive: true });
    const a = doctorAssertDevAppsPresence(tmp);
    expect(a.verdict).toBe("fail");
    expect(a.detail).toMatch(/undeclared/i);
    expect(a.detail).toMatch(/drupal-module/);
  });

  it("PASSES when both configured clones exist on disk", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "doctor-devapps-ok-"));
    writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({
        cinatra: {
          devApps: {
            "@cinatra-ai/wordpress-plugin": { path: "dev/wordpress-plugin" },
            "@cinatra-ai/drupal-module": { path: "dev/drupal-module/cinatra" },
          },
        },
      }),
    );
    mkdirSync(path.join(tmp, "dev/wordpress-plugin"), { recursive: true });
    mkdirSync(path.join(tmp, "dev/drupal-module/cinatra"), { recursive: true });
    expect(doctorAssertDevAppsPresence(tmp).verdict).toBe("pass");
  });
});

// =========================================================================
// gatherDoctorReport — end-to-end with injected fetch + docker
// =========================================================================
describe("gatherDoctorReport — full report", () => {
  function baseStore() {
    return { [LLM_KEY]: provisionedLlm(), [MCP_KEY]: publicUrlRow() };
  }

  it("happy path: token mint OK, local + public tools/list incl. CMS-write tool → those PASS", async () => {
    const TOKEN = "super-secret-token-NEVER-LOG";
    const fetchImpl = makeFetch({
      "POST http://localhost:3000/api/auth/oauth2/token": () =>
        jsonResponse(200, { access_token: TOKEN }),
      "POST http://localhost:3000/api/mcp": () =>
        jsonResponse(200, { result: { tools: [{ name: "blog_post_publish_wordpress_start" }, { name: "crm_contact_search" }] } }),
      "POST https://node.example.ts.net/api/mcp": () =>
        jsonResponse(200, { result: { tools: [{ name: "blog_post_update" }] } }),
    });
    const report = await gatherDoctorReport({
      client: createMetadataClient(baseStore()),
      schemaName: SCHEMA,
      env: ENV,
      repoRoot: process.cwd(),
      fetchImpl,
      dockerImpl: NO_DOCKER,
    });

    expect(byId(report, "llm-mcp-access").verdict).toBe("pass");
    expect(byId(report, "token-mint").verdict).toBe("pass");
    expect(byId(report, "local-tools-list").verdict).toBe("pass");
    expect(byId(report, "public-reachability").verdict).toBe("pass");

    // SECRET BOUNDARY: the minted token must NOT appear anywhere in the report.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("plain-secret-openai");
  });

  it("app down: token endpoint unreachable → token-mint SKIP, local + public SKIP (never PASS)", async () => {
    const report = await gatherDoctorReport({
      client: createMetadataClient(baseStore()),
      schemaName: SCHEMA,
      env: ENV,
      repoRoot: process.cwd(),
      fetchImpl: throwingFetch(),
      dockerImpl: NO_DOCKER,
    });
    expect(byId(report, "token-mint").verdict).toBe("skip");
    expect(byId(report, "local-tools-list").verdict).toBe("skip");
    expect(byId(report, "public-reachability").verdict).toBe("skip");
    // 1+2 is a pure DB read — still PASS.
    expect(byId(report, "llm-mcp-access").verdict).toBe("pass");
  });

  it("local PASS but PUBLIC unreachable → public SKIP (codex must-fix: local success alone is NOT proof)", async () => {
    const fetchImpl = makeFetch({
      "POST http://localhost:3000/api/auth/oauth2/token": () => jsonResponse(200, { access_token: "t" }),
      "POST http://localhost:3000/api/mcp": () =>
        jsonResponse(200, { result: { tools: [{ name: "blog_post_publish_wordpress_start" }] } }),
      "POST https://node.example.ts.net/api/mcp": () => {
        throw new Error("ETIMEDOUT");
      },
    });
    const report = await gatherDoctorReport({
      client: createMetadataClient(baseStore()),
      schemaName: SCHEMA,
      env: ENV,
      repoRoot: process.cwd(),
      fetchImpl,
      dockerImpl: NO_DOCKER,
    });
    expect(byId(report, "local-tools-list").verdict).toBe("pass");
    expect(byId(report, "public-reachability").verdict).toBe("skip");
  });

  it("local tools/list missing the CMS-write tool → FAIL (broad prefix would false-pass)", async () => {
    const fetchImpl = makeFetch({
      "POST http://localhost:3000/api/auth/oauth2/token": () => jsonResponse(200, { access_token: "t" }),
      "POST http://localhost:3000/api/mcp": () =>
        // a LinkedIn publish tool must NOT satisfy the CMS-write requirement
        jsonResponse(200, { result: { tools: [{ name: "blog_post_publish_linkedin_start" }, { name: "crm_contact_search" }] } }),
      "POST https://node.example.ts.net/api/mcp": () => jsonResponse(200, { result: { tools: [] } }),
    });
    const report = await gatherDoctorReport({
      client: createMetadataClient(baseStore()),
      schemaName: SCHEMA,
      env: ENV,
      repoRoot: process.cwd(),
      fetchImpl,
      dockerImpl: NO_DOCKER,
    });
    expect(byId(report, "local-tools-list").verdict).toBe("fail");
    expect(byId(report, "local-tools-list").detail).toMatch(/no CMS-write tool/i);
  });

  it("creds-only (no public URL): token-mint still runs but public is SKIP, llm-mcp-access FAIL", async () => {
    const fetchImpl = makeFetch({
      "POST http://localhost:3000/api/auth/oauth2/token": () => jsonResponse(200, { access_token: "t" }),
      "POST http://localhost:3000/api/mcp": () =>
        jsonResponse(200, { result: { tools: [{ name: "blog_post_update" }] } }),
    });
    const report = await gatherDoctorReport({
      client: createMetadataClient({ [LLM_KEY]: provisionedLlm(), [MCP_KEY]: {} }),
      schemaName: SCHEMA,
      env: ENV,
      repoRoot: process.cwd(),
      fetchImpl,
      dockerImpl: NO_DOCKER,
    });
    expect(byId(report, "llm-mcp-access").verdict).toBe("fail");
    expect(byId(report, "public-reachability").verdict).toBe("skip");
  });

  it("WP/Drupal: container down → SKIP (never PASS); docker absent → SKIP", async () => {
    const report = await gatherDoctorReport({
      client: createMetadataClient(baseStore()),
      schemaName: SCHEMA,
      env: ENV,
      repoRoot: process.cwd(),
      fetchImpl: throwingFetch(),
      dockerImpl: NO_DOCKER,
    });
    expect(byId(report, "wordpress-readiness").verdict).toBe("skip");
    expect(byId(report, "drupal-readiness").verdict).toBe("skip");
  });

  it("WP readiness: container up + mcp-adapter route present + all plugins active → PASS", async () => {
    const fetchImpl = makeFetch({
      __default: (url) => {
        if (url.includes("mcp-adapter-default-server")) return jsonResponse(200, {});
        if (url.includes("_mcp_tools")) return jsonResponse(200, {});
        throw new Error("ECONNREFUSED");
      },
    });
    const dockerImpl = makeDocker({
      running: ["cinatra-wordpress-1", "cinatra-drupal-1"],
      plugins: ["cinatra", "abilities-api", "mcp-adapter", "akismet"],
      modules: ["system", "cinatra", "node"],
    });
    const report = await gatherDoctorReport({
      client: createMetadataClient(baseStore()),
      schemaName: SCHEMA,
      env: ENV,
      repoRoot: process.cwd(),
      fetchImpl,
      dockerImpl,
    });
    expect(byId(report, "wordpress-readiness").verdict).toBe("pass");
    expect(byId(report, "drupal-readiness").verdict).toBe("pass");
  });

  it("WP/Drupal readiness: a 5xx/3xx route status → SKIP, never PASS (codex must-fix)", async () => {
    const fetchImpl = makeFetch({
      __default: (url) => {
        if (url.includes("mcp-adapter-default-server")) return jsonResponse(503, {});
        if (url.includes("_mcp_tools")) return jsonResponse(500, {});
        throw new Error("ECONNREFUSED");
      },
    });
    // Containers up + plugins/modules active — but the route returns 5xx, so the
    // route is NOT proven present → must SKIP (a 500 is not proof of readiness).
    const dockerImpl = makeDocker({
      running: ["cinatra-wordpress-1", "cinatra-drupal-1"],
      plugins: ["cinatra", "abilities-api", "mcp-adapter"],
      modules: ["cinatra"],
    });
    const report = await gatherDoctorReport({
      client: createMetadataClient(baseStore()),
      schemaName: SCHEMA,
      env: ENV,
      repoRoot: process.cwd(),
      fetchImpl,
      dockerImpl,
    });
    expect(byId(report, "wordpress-readiness").verdict).toBe("skip");
    expect(byId(report, "drupal-readiness").verdict).toBe("skip");
  });

  it("public reachability: tools present but NO CMS-write tool → FAIL (stale/wrong endpoint; codex must-fix)", async () => {
    const fetchImpl = makeFetch({
      "POST http://localhost:3000/api/auth/oauth2/token": () => jsonResponse(200, { access_token: "t" }),
      "POST http://localhost:3000/api/mcp": () =>
        jsonResponse(200, { result: { tools: [{ name: "blog_post_update" }] } }),
      // public endpoint answers but exposes only generic tools (e.g. a stale,
      // wrong instance) — must NOT pass the provider-facing gate.
      "POST https://node.example.ts.net/api/mcp": () =>
        jsonResponse(200, { result: { tools: [{ name: "crm_contact_search" }, { name: "crm_account_search" }] } }),
    });
    const report = await gatherDoctorReport({
      client: createMetadataClient(baseStore()),
      schemaName: SCHEMA,
      env: ENV,
      repoRoot: process.cwd(),
      fetchImpl,
      dockerImpl: NO_DOCKER,
    });
    expect(byId(report, "local-tools-list").verdict).toBe("pass");
    const pub = byId(report, "public-reachability");
    expect(pub.verdict).toBe("fail");
    expect(pub.detail).toMatch(/no CMS-write tool/i);
  });

  it("WP readiness: route present but a required plugin inactive → FAIL", async () => {
    const fetchImpl = makeFetch({
      __default: (url) => {
        if (url.includes("mcp-adapter-default-server")) return jsonResponse(401, {});
        if (url.includes("_mcp_tools")) return jsonResponse(404, {});
        throw new Error("ECONNREFUSED");
      },
    });
    const dockerImpl = makeDocker({
      running: ["cinatra-wordpress-1", "cinatra-drupal-1"],
      plugins: ["cinatra"], // abilities-api + mcp-adapter missing
      modules: [], // cinatra module not enabled
    });
    const report = await gatherDoctorReport({
      client: createMetadataClient(baseStore()),
      schemaName: SCHEMA,
      env: ENV,
      repoRoot: process.cwd(),
      fetchImpl,
      dockerImpl,
    });
    const wp = byId(report, "wordpress-readiness");
    expect(wp.verdict).toBe("fail");
    expect(wp.detail).toMatch(/abilities-api|mcp-adapter/);
    // Drupal: /_mcp_tools 404 → module not enabled → FAIL.
    expect(byId(report, "drupal-readiness").verdict).toBe("fail");
  });

  it("counts add up across all 7 assertions", async () => {
    const report = await gatherDoctorReport({
      client: createMetadataClient(baseStore()),
      schemaName: SCHEMA,
      env: ENV,
      repoRoot: process.cwd(),
      fetchImpl: throwingFetch(),
      dockerImpl: NO_DOCKER,
    });
    const total = report.counts.pass + report.counts.fail + report.counts.skip;
    expect(total).toBe(report.assertions.length);
    expect(report.assertions.length).toBe(7);
  });

  it("DOCTOR_CMS_WRITE_TOOLS excludes LinkedIn publish tools", () => {
    expect(DOCTOR_CMS_WRITE_TOOLS).toContain("blog_post_publish_wordpress_start");
    expect(DOCTOR_CMS_WRITE_TOOLS).not.toContain("blog_post_publish_linkedin_start");
  });
});
