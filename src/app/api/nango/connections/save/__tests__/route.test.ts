// Transport-registration cutover: the nango connection-save route runs REGISTRATION-DRIVEN post-save
// hooks (the `nango-connection-saved` capability) instead of a hardcoded
// connector branch. A hook fires only when connectorKey/scope match; hook
// failures never fail the save response.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

import { NANGO_SYSTEM_CAPABILITY } from "@cinatra-ai/sdk-extensions";
import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import { POST } from "../route";

// Post serverEntry cutover (cinatra#151) the route resolves the
// connector-authored nango-system surface instead of importing the package —
// register a fake surface through the REAL resolver path.
const handleNangoConnectionSaveRequest = vi.fn(async () => ({
  body: { success: true } as Record<string, unknown>,
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
      handleNangoConnectionSaveRequest,
    },
  });
}

function saveRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/nango/connections/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function registerHook(connectorKey: string, scope: "app" | "user" | undefined, run: () => Promise<void>) {
  registerCapabilityProvider("nango-connection-saved", {
    packageName: `@v/${connectorKey}-connector`,
    impl: { connectorKey, ...(scope ? { scope } : {}), run },
  });
}

beforeEach(() => {
  __resetCapabilityRegistry();
  registerNangoSurface();
  handleNangoConnectionSaveRequest.mockResolvedValue({
    body: { success: true },
    status: 200,
  } as never);
});

describe("nango connection-save route — registration-driven post-save hooks", () => {
  it("runs the matching hook with the session user id", async () => {
    const run = vi.fn(async () => {});
    registerHook("gmail", "user", run);
    const res = await POST(saveRequest({ connectorKey: "gmail", scope: "user" }));
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledWith({ userId: "user-1" });
  });

  it("does not run hooks for a different connectorKey or scope", async () => {
    const run = vi.fn(async () => {});
    registerHook("gmail", "user", run);
    await POST(saveRequest({ connectorKey: "apollo", scope: "user" }));
    await POST(saveRequest({ connectorKey: "gmail", scope: "app" }));
    expect(run).not.toHaveBeenCalled();
  });

  it("a scope-less hook matches any scope", async () => {
    const run = vi.fn(async () => {});
    registerHook("gmail", undefined, run);
    await POST(saveRequest({ connectorKey: "gmail", scope: "app" }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a throwing hook never fails the save response", async () => {
    registerHook("gmail", "user", async () => {
      throw new Error("refresh failed");
    });
    const res = await POST(saveRequest({ connectorKey: "gmail", scope: "user" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it("does not run hooks when the save itself failed", async () => {
    handleNangoConnectionSaveRequest.mockResolvedValue({
      body: { success: false },
      status: 400,
    } as never);
    const run = vi.fn(async () => {});
    registerHook("gmail", "user", run);
    const res = await POST(saveRequest({ connectorKey: "gmail", scope: "user" }));
    expect(res.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("ignores malformed hook impls (structural guard)", async () => {
    registerCapabilityProvider("nango-connection-saved", {
      packageName: "@v/bad",
      impl: { not: "a hook" },
    });
    const res = await POST(saveRequest({ connectorKey: "gmail", scope: "user" }));
    expect(res.status).toBe(200);
  });
});
