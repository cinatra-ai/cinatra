// Verifies getDrupalMcpInstanceStatuses + probeDrupalMcp source the Bearer
// header from the Nango vault (via the host shim @/lib/nango) and classify
// probe responses correctly. The LLM toolbox BUILDER that used to live in
// @/lib/drupal-mcp-connection moved into the drupal-mcp-connector extension
// (src/mcp/toolbox.ts) — its tests live there now.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/drupal-api", () => ({
  getDrupalAPISettings: vi.fn(),
}));

vi.mock("@/lib/wordpress-mcp-connection", () => ({
  isPrivateUrl: vi.fn((u: string) => /localhost|127\.0\.0\.1|::1/.test(u)),
}));

vi.mock("@/lib/nango-system", () => ({
  buildBearerAuthHeaderFromNango: vi.fn(),
}));

// cinatra#967: the owner-aware instance-gating seam. `null` (default) means
// "no identity resolved/seeded" — the probe falls through to the pre-#967
// ungated Bearer resolution, same as every other test in this file.
vi.mock("@/lib/instance-connection-actor", () => ({
  enforceInstanceConnectionUse: vi.fn(async () => null),
}));

import { getDrupalAPISettings } from "@/lib/drupal-api";
import { buildBearerAuthHeaderFromNango } from "@/lib/nango-system";
import { enforceInstanceConnectionUse } from "@/lib/instance-connection-actor";
import { ConnectionUseDeniedError } from "@/lib/connection-use-gate";
import {
  getDrupalMcpInstanceStatuses,
  probeDrupalMcp,
  resolveDrupalMcpServerUrl,
} from "@/lib/drupal-mcp-connection";

const inst = (id: string, siteUrl?: string) => ({
  id,
  name: `Site ${id}`,
  siteUrl: siteUrl ?? `https://site-${id}.example.com`,
  nangoConnectionId: id,
  providerConfigKey: "cinatra-drupal",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default Nango success — individual tests override.
  vi.mocked(buildBearerAuthHeaderFromNango).mockResolvedValue({ Authorization: "Bearer default-token" });
  // Default fetch: 200 OK so HEAD-probe classify is "registered".
  vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200 } as Response)));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveDrupalMcpServerUrl", () => {
  it("appends the MCP route to the trimmed site URL", () => {
    expect(resolveDrupalMcpServerUrl("https://site.example.com/")).toBe(
      "https://site.example.com/_mcp_tools",
    );
  });
});

describe("probeDrupalMcp — classification", () => {
  // Note: drupal-mcp-connection.ts has a module-level probeCache keyed by
  // the resolved endpoint. Use unique siteUrls per test to avoid bleed.

  it("classifies HTTP 401 as auth_error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 401 } as Response)));
    expect(await probeDrupalMcp("https://probe-401.example.com", "Bearer t")).toBe("auth_error");
  });

  it("treats HTTP 405 as registered (HEAD-not-supported fallback)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 405 } as Response)));
    expect(await probeDrupalMcp("https://probe-405.example.com", "Bearer t")).toBe("registered");
  });
});

describe("getDrupalMcpInstanceStatuses — Nango-backed probe", () => {
  it("classifies unreachable when Nango credential is missing (no token in response)", async () => {
    vi.mocked(getDrupalAPISettings).mockReturnValue({
      instances: [inst("status-missing-cred", "https://status-missing.example.com")],
    });
    vi.mocked(buildBearerAuthHeaderFromNango).mockResolvedValueOnce(null);

    const statuses = await getDrupalMcpInstanceStatuses();

    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe("unreachable");
    expect(JSON.stringify(statuses[0])).not.toContain("Bearer");
  });

  it("issues HEAD probe with the Nango-resolved Authorization header", async () => {
    vi.mocked(getDrupalAPISettings).mockReturnValue({
      instances: [inst("status-ok", "https://status-ok.example.com")],
    });
    vi.mocked(buildBearerAuthHeaderFromNango).mockResolvedValueOnce({ Authorization: "Bearer token-a" });

    const statuses = await getDrupalMcpInstanceStatuses();

    expect(statuses[0].status).toBe("registered");
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "https://status-ok.example.com/_mcp_tools",
      expect.objectContaining({ method: "HEAD", headers: { Authorization: "Bearer token-a" } }),
    );
  });

  it("cinatra#967: gates each instance's Bearer resolution via enforceInstanceConnectionUse, threading its {orgId, runBy} binding, BEFORE the raw Nango read", async () => {
    const instanceWithBinding = { ...inst("status-gated", "https://status-gated.example.com"), orgId: "org-1", runBy: "user-1" };
    vi.mocked(getDrupalAPISettings).mockReturnValue({ instances: [instanceWithBinding] });
    const callOrder: string[] = [];
    vi.mocked(enforceInstanceConnectionUse).mockImplementationOnce(async () => {
      callOrder.push("gate");
      return null;
    });
    vi.mocked(buildBearerAuthHeaderFromNango).mockImplementationOnce(async () => {
      callOrder.push("readback");
      return { Authorization: "Bearer token-a" };
    });

    await getDrupalMcpInstanceStatuses();

    expect(vi.mocked(enforceInstanceConnectionUse)).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorKey: "drupal",
        connectionId: "status-gated",
        binding: { orgId: "org-1", runBy: "user-1" },
        source: "drupal-mcp-connection",
      }),
    );
    expect(callOrder).toEqual(["gate", "readback"]);
  });

  it("cinatra#967: a ConnectionUseDeniedError for one instance surfaces as auth_error and does not abort the sweep for other instances", async () => {
    vi.mocked(getDrupalAPISettings).mockReturnValue({
      instances: [
        inst("denied-instance", "https://denied.example.com"),
        inst("ok-instance", "https://ok-instance.example.com"),
      ],
    });
    vi.mocked(enforceInstanceConnectionUse)
      .mockRejectedValueOnce(
        new ConnectionUseDeniedError({ statusCode: 403, reason: "forbidden", message: "denied" }),
      )
      .mockResolvedValueOnce(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const statuses = await getDrupalMcpInstanceStatuses();

    expect(statuses).toHaveLength(2);
    expect(statuses.find((s) => s.id === "denied-instance")?.status).toBe("auth_error");
    expect(statuses.find((s) => s.id === "ok-instance")?.status).toBe("registered");
    expect(warn).toHaveBeenCalled();
  });

  it("cinatra#967: a NON-deny error (e.g. a DB/identity-seeding failure) stays LOUD — rethrown, never swallowed into a status code", async () => {
    class DbFailure extends Error {}
    vi.mocked(getDrupalAPISettings).mockReturnValue({
      instances: [inst("db-failure-instance", "https://db-failure.example.com")],
    });
    vi.mocked(enforceInstanceConnectionUse).mockRejectedValueOnce(new DbFailure("db down"));

    await expect(getDrupalMcpInstanceStatuses()).rejects.toThrow(DbFailure);
  });
});
