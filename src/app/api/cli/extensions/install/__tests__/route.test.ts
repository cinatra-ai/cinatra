// POST /api/cli/extensions/install — route wiring, auth mirroring, body
// validation, the canonical install primitive call and the error mapping
// (cinatra#4920).
// red-first-expect: Cannot find module '/src/app/api/cli/extensions/install/route'

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ bootstrapLoaded: false }));
const authorizeCliRequestMock = vi.fn();
const extensionsInstallMock = vi.fn();
const bootstrapSeenAtCall: boolean[] = [];

vi.mock("@/lib/cli-api/route-guard", () => ({
  authorizeCliRequest: (...args: unknown[]) => authorizeCliRequestMock(...args),
}));
// The handler bootstrap registers the kind handlers. The stand-in only records
// that the route's own import path loaded it.
vi.mock("@cinatra-ai/extensions/handler-bootstrap", () => {
  state.bootstrapLoaded = true;
  return {};
});
// The canonical install primitive (the `extensions_install` MCP tool's
// function). Its own resolution, visibility gate and batch call are covered by
// packages/extensions/src/__tests__/extensions-install-allowed-kinds-4920.test.ts.
vi.mock("@cinatra-ai/extensions/mcp-handlers", () => ({
  EXTENSION_KIND_NOT_ALLOWED: "EXTENSION_KIND_NOT_ALLOWED",
  EXTENSION_NOT_VISIBLE: "EXTENSION_NOT_VISIBLE",
  createExtensionsPrimitiveHandlers: () => ({
    extensions_install: (...args: unknown[]) => {
      bootstrapSeenAtCall.push(state.bootstrapLoaded);
      return extensionsInstallMock(...args);
    },
  }),
}));

import { POST } from "../route";
// The real wrapper the install batch throws for a member failure (it keeps the
// registry error as `cause`).
import { BatchMemberInstallError } from "@/lib/extension-install-batch";

const URL_ = "https://inst.cinatra.ai/api/cli/extensions/install";
function post(body?: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    ...(body === undefined ? {} : { body }),
  });
}
const OK_BODY = JSON.stringify({ packageName: "@example-org/agent-hello", version: "1.2.3" });

const ADMIN = {
  ok: true,
  actor: {
    userId: "admin-1",
    isPlatformAdmin: true,
    organizationId: "org-1",
    via: "bearer",
  },
};

beforeEach(() => {
  authorizeCliRequestMock.mockReset();
  extensionsInstallMock.mockReset();
  bootstrapSeenAtCall.length = 0;
  authorizeCliRequestMock.mockResolvedValue(ADMIN);
  extensionsInstallMock.mockResolvedValue({
    success: true,
    packageName: "@example-org/agent-hello",
    packageVersion: "1.2.3",
  });
});

describe("POST /api/cli/extensions/install", () => {
  it("happy path: auth mirrors platform-admin + cli:extensions:write; calls the canonical primitive ONCE with name, exact version, envelope and the agent/skill kinds", async () => {
    const res = await POST(post(OK_BODY));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ packageName: "@example-org/agent-hello", version: "1.2.3" });
    expect(authorizeCliRequestMock).toHaveBeenCalledWith(expect.anything(), {
      minTier: "platform-admin",
      requiredScope: "cli:extensions:write",
    });
    expect(extensionsInstallMock).toHaveBeenCalledTimes(1);
    expect(extensionsInstallMock).toHaveBeenCalledWith(
      { packageName: "@example-org/agent-hello", packageVersion: "1.2.3" },
      // The standing-free install envelope (the UI install wrapper's shape).
      { actorType: "human", source: "route", userId: "admin-1", orgId: "org-1" },
      { allowedKinds: ["agent", "skill"] },
    );
  });

  it("the handler bootstrap is loaded by the route's own import path before the primitive runs (no empty handler registry)", async () => {
    await POST(post(OK_BODY));
    expect(bootstrapSeenAtCall).toEqual([true]);
  });

  it("the dev-admin bypass (no user id, no org) installs with an identity-free envelope", async () => {
    authorizeCliRequestMock.mockResolvedValue({
      ok: true,
      actor: { userId: null, isPlatformAdmin: true, organizationId: null, via: "dev-admin-bypass" },
    });
    await POST(post(OK_BODY));
    expect(extensionsInstallMock).toHaveBeenCalledTimes(1);
    expect(extensionsInstallMock.mock.calls[0][1]).toEqual({ actorType: "human", source: "route" });
  });

  it("unauthenticated → the guard's 401 passes through; the primitive is NEVER invoked", async () => {
    authorizeCliRequestMock.mockResolvedValue({ ok: false, status: 401, error: "Unauthorized" });
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
    expect(extensionsInstallMock).not.toHaveBeenCalled();
  });

  it("wrong scope → the guard's 403 passes through; the primitive is NEVER invoked", async () => {
    authorizeCliRequestMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Forbidden: token lacks the cli:extensions:write scope.",
    });
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(403);
    expect(extensionsInstallMock).not.toHaveBeenCalled();
  });

  it("non-administrator → the guard's 403 passes through; the primitive is NEVER invoked", async () => {
    authorizeCliRequestMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Forbidden: this CLI endpoint requires platform admin.",
    });
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/platform admin/);
    expect(extensionsInstallMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an unscoped name", { packageName: "agent-hello", version: "1.2.3" }],
    ["an upper-case name", { packageName: "@Example-Org/agent-hello", version: "1.2.3" }],
    ["a path-like name", { packageName: "@example-org/../etc", version: "1.2.3" }],
    ["a missing name", { version: "1.2.3" }],
    ["a non-string name", { packageName: 42, version: "1.2.3" }],
    ["a missing version", { packageName: "@example-org/agent-hello" }],
    ["a caret range", { packageName: "@example-org/agent-hello", version: "^1.2.0" }],
    ["a tilde range", { packageName: "@example-org/agent-hello", version: "~1.2.0" }],
    ["a comparator range", { packageName: "@example-org/agent-hello", version: ">=1.0.0" }],
    ["a dist-tag", { packageName: "@example-org/agent-hello", version: "next" }],
    ["latest", { packageName: "@example-org/agent-hello", version: "latest" }],
    ["an x-range", { packageName: "@example-org/agent-hello", version: "1.x" }],
    ["a non-string version", { packageName: "@example-org/agent-hello", version: 1 }],
    ["a version with shell characters", { packageName: "@example-org/agent-hello", version: "1.0.0;rm" }],
    ["a numeric prerelease with a leading zero", { packageName: "@example-org/agent-hello", version: "1.2.3-01" }],
    ["a major with a leading zero", { packageName: "@example-org/agent-hello", version: "01.2.3" }],
    ["a two-part version", { packageName: "@example-org/agent-hello", version: "1.2" }],
    ["an empty prerelease", { packageName: "@example-org/agent-hello", version: "1.2.3-" }],
    ["an empty build", { packageName: "@example-org/agent-hello", version: "1.2.3+" }],
    ["an equals-prefixed version", { packageName: "@example-org/agent-hello", version: "=1.2.3" }],
  ])("%s → 400 before any work", async (_label, body) => {
    const res = await POST(post(JSON.stringify(body)));
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
    expect(extensionsInstallMock).not.toHaveBeenCalled();
  });

  it("a prerelease exact version is accepted", async () => {
    const res = await POST(
      post(JSON.stringify({ packageName: "@example-org/agent-hello", version: "1.2.3-rc.1" })),
    );
    expect(res.status).toBe(200);
    expect(extensionsInstallMock).toHaveBeenCalledTimes(1);
    expect(extensionsInstallMock.mock.calls[0][0]).toEqual({
      packageName: "@example-org/agent-hello",
      packageVersion: "1.2.3-rc.1",
    });
  });

  it.each([
    ["a malformed JSON body", "{not json"],
    ["an empty body", ""],
    ["a JSON array body", JSON.stringify(["@example-org/agent-hello"])],
    ["a JSON string body", JSON.stringify("@example-org/agent-hello")],
  ])("%s → 400 before any work", async (_label, raw) => {
    const res = await POST(post(raw));
    expect(res.status).toBe(400);
    expect(extensionsInstallMock).not.toHaveBeenCalled();
  });

  it("a cross-origin request is refused before authorization and before the primitive", async () => {
    const res = await POST(post(OK_BODY, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Cross-origin request rejected.");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(authorizeCliRequestMock).not.toHaveBeenCalled();
    expect(extensionsInstallMock).not.toHaveBeenCalled();
  });

  it.each([
    ["text/plain (a CORS-simple type)", "text/plain"],
    ["form encoding", "application/x-www-form-urlencoded"],
    ["JSON-looking prefix (application/jsonp)", "application/jsonp"],
  ])("a %s body is refused with 415 before authorization and before the primitive", async (_label, type) => {
    const res = await POST(post(OK_BODY, { "content-type": type }));
    expect(res.status).toBe(415);
    expect(authorizeCliRequestMock).not.toHaveBeenCalled();
    expect(extensionsInstallMock).not.toHaveBeenCalled();
  });

  it("application/json with a charset is accepted", async () => {
    const res = await POST(post(OK_BODY, { "content-type": "application/json; charset=utf-8" }));
    expect(res.status).toBe(200);
  });

  it("a body over the size cap is refused with 413 before the primitive", async () => {
    const big = JSON.stringify({
      packageName: "@example-org/agent-hello",
      version: "1.2.3",
      pad: "x".repeat(20 * 1024),
    });
    const res = await POST(post(big));
    expect(res.status).toBe(413);
    expect(extensionsInstallMock).not.toHaveBeenCalled();
  });

  it.each([
    ["E404", "404 Not Found - GET https://registry.example.test/@example-org%2fconnector-dep - Not found"],
    ["ETARGET", "No matching version found for @example-org/connector-dep@0.4.0."],
  ])("a dependency's registry %s, wrapped by the batch as its cause, → 404 not found", async (code, text) => {
    const registryError = Object.assign(new Error(text), { code, statusCode: code === "E404" ? 404 : undefined });
    extensionsInstallMock.mockRejectedValue(
      new BatchMemberInstallError(
        `Installing @example-org/agent-hello@1.2.3 failed at dependency @example-org/connector-dep: ${text}. No dependencies needed rollback; Previously-installed extensions were not touched.`,
        "@example-org/connector-dep",
        [],
        [],
        registryError,
      ),
    );
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe(
      "Not found in the registry: @example-org/agent-hello@1.2.3 or one of its dependencies.",
    );
  });

  it("a kind that needs an access target → 422 naming the product's marketplace page", async () => {
    extensionsInstallMock.mockRejectedValue(
      Object.assign(new Error("internal detail"), { code: "EXTENSION_KIND_NOT_ALLOWED", kind: "connector" }),
    );
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error).toMatch(/a connector package/);
    expect(error).toMatch(/marketplace page/);
    expect(error).not.toMatch(/internal detail/);
  });

  it("a private package of another scope → 403 with the visibility message", async () => {
    extensionsInstallMock.mockRejectedValue(
      Object.assign(new Error("x"), { code: "EXTENSION_NOT_VISIBLE" }),
    );
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Package @example-org/agent-hello is private and not accessible from this instance.",
    );
  });

  it.each([["E404"], ["ETARGET"]])("a registry %s → 404 not found", async (code) => {
    extensionsInstallMock.mockRejectedValue(Object.assign(new Error("registry said no"), { code }));
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe(
      "Not found in the registry: @example-org/agent-hello@1.2.3 or one of its dependencies.",
    );
  });

  it("a marketplace entitlement denial → 403", async () => {
    extensionsInstallMock.mockRejectedValue(new Error("authorize failed: cinatra.install_not_entitled"));
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/not entitled to install @example-org\/agent-hello@1\.2\.3/);
  });

  it("a requires-rebuild result → 409 with its message", async () => {
    extensionsInstallMock.mockResolvedValue({
      success: false,
      requiresRebuild: true,
      packageName: "@example-org/agent-hello",
      packageVersion: "1.2.3",
      message: "a dependency ships a bundled setup page; rebuild the host",
    });
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/rebuild the host/);
  });

  it("a contract-violation result → 422 with its message and fields", async () => {
    extensionsInstallMock.mockResolvedValue({
      success: false,
      contractViolation: true,
      packageName: "@example-org/agent-hello",
      packageVersion: "1.2.3",
      missingFields: ["cinatra.riskLevel"],
      message: "missing cinatra.riskLevel",
    });
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "missing cinatra.riskLevel",
      missingFields: ["cinatra.riskLevel"],
    });
  });

  it("a batch failure surfaces the batch's own failure text", async () => {
    // Title kept from the first version; the assertion now pins that an
    // unexpected failure returns a FIXED message (no downstream text).
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    extensionsInstallMock.mockRejectedValue(
      new Error("Installing @example-org/agent-hello@1.2.3 failed at dependency @example-org/connector-dep: boom"),
    );
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to install the extension package.");
    expect(errorSpy).toHaveBeenCalledWith("[cli-api/extensions/install] failed", expect.any(Error));
    errorSpy.mockRestore();
  });
});
