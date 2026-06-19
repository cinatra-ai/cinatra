// cinatra#320 — dev-env Plane auto-setup (`autoSetupLocalPlane`).
//
// Verifies the SMOKE-GROUNDED wiring discipline (Plane CE 1.3.1, #315/#320):
//   - container down            -> skipped (with the `--profile plane` hint)
//   - up but HTTP unreachable    -> skipped (still booting)
//   - up, no PLANE_MCP_URL       -> skipped, NO row wired (community compose
//                                   ships no MCP bridge; an enabled row pointing
//                                   at a non-existent endpoint would mislead)
//   - up, bridge URL set but it
//     does not answer tools/list -> skipped, NO row wired
//   - up, bridge answers         -> row wired LAYER-A: allowedTools set,
//                                   allowedCatalogTools null, nangoConnectionId
//                                   null (X-API-Key auth, NOT a Nango Bearer),
//                                   serverUrl = the bridge URL.
//
// SECRET BOUNDARY: assertions only check statuses/booleans/equality + the wired
// row shape — never a credential value.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock the docker/curl shell surface. probeDockerContainer + the HTTP retry
// probe both go through execSync; we route by inspecting the command string.
const execSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (cmd: string, ...rest: unknown[]) => execSyncMock(cmd, ...rest),
  spawnSync: vi.fn(),
}));

// Force the Drupal clone-presence check (existsSync) true so unrelated boot
// branches never touch the real fs; Plane never reads fs anyway.
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));

const getByIdMock = vi.fn();
const upsertMock = vi.fn();
vi.mock("@/lib/external-mcp-registry", () => ({
  getExternalMcpServerById: (...a: unknown[]) => getByIdMock(...a),
  upsertExternalMcpServer: (...a: unknown[]) => upsertMock(...a),
  resolveExternalMcpServerBearer: vi.fn(),
  EXTERNAL_MCP_NANGO_PROVIDER_CONFIG_KEY: "cinatra-external-mcp",
}));

// Stub the Twenty keygen module (imported at top-level of dev-auto-setup) so the
// import graph resolves without the real .mjs.
vi.mock("@/lib/twenty-keygen.mjs", () => ({
  buildSeedDevArgs: vi.fn(() => []),
  buildGenerateApiKeyArgs: vi.fn(() => []),
  parseTwentyApiKey: vi.fn(() => null),
  probeTwentyBearer: vi.fn(),
}));

const PROXY = "cinatra-plane-proxy-1";

/** Route the mocked execSync: docker ps -> container name; curl -> http code. */
function routeExecSync({ containerUp, httpUp }: { containerUp: boolean; httpUp: boolean }) {
  execSyncMock.mockImplementation((cmd: string) => {
    if (cmd.includes("docker ps")) {
      return Buffer.from(containerUp ? PROXY : "");
    }
    if (cmd.includes("curl")) {
      // probeHttpAnswered reads the printed http_code; 200 = reachable.
      if (!httpUp) throw new Error("connection refused");
      return Buffer.from("200");
    }
    return Buffer.from("");
  });
}

describe("autoSetupLocalPlane", () => {
  beforeEach(() => {
    vi.resetModules();
    execSyncMock.mockReset();
    getByIdMock.mockReset();
    upsertMock.mockReset();
    delete process.env.PLANE_MCP_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PLANE_MCP_URL;
    vi.unstubAllGlobals();
  });

  it("skips when the Plane container is not running", async () => {
    routeExecSync({ containerUp: false, httpUp: false });
    const { autoSetupLocalPlane } = await import("@/lib/dev-auto-setup");
    const res = await autoSetupLocalPlane();
    expect(res.status).toBe("skipped");
    expect("reason" in res && res.reason).toContain("--profile plane");
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("skips when Plane is up but HTTP is not reachable yet", async () => {
    routeExecSync({ containerUp: true, httpUp: false });
    // The reachability probe sleeps between bounded retries; fake timers so the
    // 12 × 2.5s backoff window resolves instantly instead of stalling the suite.
    vi.useFakeTimers();
    const { autoSetupLocalPlane } = await import("@/lib/dev-auto-setup");
    const pending = autoSetupLocalPlane();
    await vi.runAllTimersAsync();
    const res = await pending;
    vi.useRealTimers();
    expect(res.status).toBe("skipped");
    expect("reason" in res && res.reason).toContain("not reachable");
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("does NOT wire a row when no PLANE_MCP_URL is configured (no bridge in the community compose)", async () => {
    routeExecSync({ containerUp: true, httpUp: true });
    const { autoSetupLocalPlane } = await import("@/lib/dev-auto-setup");
    const res = await autoSetupLocalPlane();
    expect(res.status).toBe("skipped");
    expect("reason" in res && res.reason).toContain("PLANE_MCP_URL");
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("does NOT wire a row when PLANE_MCP_URL is set but the bridge does not answer tools/list", async () => {
    routeExecSync({ containerUp: true, httpUp: true });
    process.env.PLANE_MCP_URL = "http://localhost:9999/mcp";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 502 })),
    );
    const { autoSetupLocalPlane } = await import("@/lib/dev-auto-setup");
    const res = await autoSetupLocalPlane();
    expect(res.status).toBe("skipped");
    expect("reason" in res && res.reason).toContain("tools/list");
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("does NOT wire a row when the bridge answers tools/list but advertises no known Plane tool", async () => {
    routeExecSync({ containerUp: true, httpUp: true });
    process.env.PLANE_MCP_URL = "http://localhost:7071/mcp";
    // A valid MCP server, but not Plane (or an empty catalog) — must be rejected.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "some_other_tool" }] } }),
      ),
    );
    const { autoSetupLocalPlane } = await import("@/lib/dev-auto-setup");
    const res = await autoSetupLocalPlane();
    expect(res.status).toBe("skipped");
    expect("reason" in res && res.reason).toContain("tools/list");
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("wires a LAYER-A row (no Bearer, no catalog allowlist) when the MCP bridge answers", async () => {
    routeExecSync({ containerUp: true, httpUp: true });
    process.env.PLANE_MCP_URL = "http://localhost:7070/mcp";
    getByIdMock.mockReturnValue(null); // fresh row -> "created"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              { name: "create_work_item" },
              { name: "list_work_items" },
              { name: "delete_work_item" },
            ],
          },
        }),
      ),
    );
    const { autoSetupLocalPlane } = await import("@/lib/dev-auto-setup");
    const res = await autoSetupLocalPlane();

    expect(res.status).toBe("created");
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const arg = upsertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.id).toBe("plane-workspace");
    expect(arg.serverUrl).toBe("http://localhost:7070/mcp");
    expect(arg.enabled).toBe(true);
    expect(arg.scope).toBe("workspace");
    // Plane is X-API-Key custom-header auth — never a Nango Bearer.
    expect(arg.nangoConnectionId).toBeNull();
    // Layer A (literal tool names), NOT Layer B (execute_tool catalog).
    expect(arg.allowedCatalogTools).toBeNull();
    expect(Array.isArray(arg.allowedTools)).toBe(true);
    expect(arg.allowedTools).toContain("create_work_item");
    expect(arg.allowedTools).toContain("list_work_items");
    // The native execute_tool dispatcher must NOT appear (Plane has none).
    expect(arg.allowedTools).not.toContain("execute_tool");
  });

  it("reports already-wired when the row already exists", async () => {
    routeExecSync({ containerUp: true, httpUp: true });
    process.env.PLANE_MCP_URL = "http://localhost:7070/mcp";
    getByIdMock.mockReturnValue({ id: "plane-workspace" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "list_projects" }] } }),
      ),
    );
    const { autoSetupLocalPlane } = await import("@/lib/dev-auto-setup");
    const res = await autoSetupLocalPlane();
    expect(res.status).toBe("already-wired");
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });
});
