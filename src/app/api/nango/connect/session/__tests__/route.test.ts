// The /api/nango/connect/session route must require a
// VALIDATED session for all scopes and additionally require manage authority
// (org-admin/org-owner OR platform-admin) for app / missing scope — the
// app-scope path mutates shared, instance-global connector state. A missing
// `scope` is the privileged *app* default and must be gated as such.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getAuthSession = vi.fn();
const resolveOrgRoleForSession = vi.fn();
const isPlatformAdmin = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: (...args: unknown[]) => getAuthSession(...args),
  resolveOrgRoleForSession: (...args: unknown[]) => resolveOrgRoleForSession(...args),
  isPlatformAdmin: (...args: unknown[]) => isPlatformAdmin(...args),
}));

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import { NANGO_SYSTEM_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";
import { POST } from "../route";

const handleNangoConnectSessionRequest = vi.fn(async () => ({
  body: { token: "tok" } as Record<string, unknown>,
  status: 200,
}));

function registerNangoSurface() {
  registerCapabilityProvider(NANGO_SYSTEM_CAPABILITY, {
    packageName: "@cinatra-ai/nango-connector",
    impl: {
      isNangoConfigured: () => true,
      getNangoStatus: () => ({ status: "connected", detail: "" }),
      getNangoSettings: () => ({}),
      providerConfigKeys: {},
      handleNangoConnectSessionRequest,
    },
  });
}

function sessionRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/nango/connect/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetCapabilityRegistry();
  registerNangoSurface();
  handleNangoConnectSessionRequest.mockResolvedValue({ body: { token: "tok" }, status: 200 } as never);
  isPlatformAdmin.mockReturnValue(false);
  resolveOrgRoleForSession.mockResolvedValue(undefined);
});

describe("nango connect/session — session + manage authz", () => {
  it("denies app scope with NO session (401) and never delegates", async () => {
    getAuthSession.mockResolvedValue(null);
    const res = await POST(sessionRequest({ connectorKey: "github", scope: "app" }));
    expect(res.status).toBe(401);
    expect(handleNangoConnectSessionRequest).not.toHaveBeenCalled();
  });

  it("denies MISSING scope with no session (treated as privileged app) → 401", async () => {
    getAuthSession.mockResolvedValue(null);
    const res = await POST(sessionRequest({ connectorKey: "github" }));
    expect(res.status).toBe(401);
    expect(handleNangoConnectSessionRequest).not.toHaveBeenCalled();
  });

  it("denies user scope with no session (401)", async () => {
    getAuthSession.mockResolvedValue(null);
    const res = await POST(sessionRequest({ connectorKey: "github", scope: "user" }));
    expect(res.status).toBe(401);
    expect(handleNangoConnectSessionRequest).not.toHaveBeenCalled();
  });

  it("denies app scope for a non-admin authenticated user (403)", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "u1" } });
    resolveOrgRoleForSession.mockResolvedValue("member");
    const res = await POST(sessionRequest({ connectorKey: "github", scope: "app" }));
    expect(res.status).toBe(403);
    expect(handleNangoConnectSessionRequest).not.toHaveBeenCalled();
  });

  it("denies MISSING scope for a non-admin authenticated user (privileged app → 403)", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "u1" } });
    resolveOrgRoleForSession.mockResolvedValue("member");
    const res = await POST(sessionRequest({ connectorKey: "github" }));
    expect(res.status).toBe(403);
    expect(handleNangoConnectSessionRequest).not.toHaveBeenCalled();
  });

  it("allows app scope for an org-admin (delegates)", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "u1" } });
    resolveOrgRoleForSession.mockResolvedValue("org_admin");
    const res = await POST(sessionRequest({ connectorKey: "github", scope: "app" }));
    expect(res.status).toBe(200);
    expect(handleNangoConnectSessionRequest).toHaveBeenCalledTimes(1);
  });

  it("allows app scope for an org-owner (delegates)", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "u1" } });
    resolveOrgRoleForSession.mockResolvedValue("org_owner");
    const res = await POST(sessionRequest({ connectorKey: "github", scope: "app" }));
    expect(res.status).toBe(200);
    expect(handleNangoConnectSessionRequest).toHaveBeenCalledTimes(1);
  });

  it("allows app scope for a platform admin (delegates)", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "u1" } });
    isPlatformAdmin.mockReturnValue(true);
    const res = await POST(sessionRequest({ connectorKey: "github", scope: "app" }));
    expect(res.status).toBe(200);
    expect(handleNangoConnectSessionRequest).toHaveBeenCalledTimes(1);
  });

  it("allows user scope for an authenticated user and passes the validated userId", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "u1", email: "u@x", name: "U" } });
    const res = await POST(sessionRequest({ connectorKey: "github", scope: "user" }));
    expect(res.status).toBe(200);
    expect(handleNangoConnectSessionRequest).toHaveBeenCalledTimes(1);
    const opts = (handleNangoConnectSessionRequest.mock.calls[0] as unknown as unknown[])[1] as {
      userId?: string;
    };
    expect(opts.userId).toBe("u1");
  });
});
