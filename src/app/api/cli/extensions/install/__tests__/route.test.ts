// POST /api/cli/extensions/install — route wiring, auth mirroring, body
// validation, the gatekept-only rule, the canonical install primitive call and
// the error mapping (cinatra#4920).
// red-first-expect: Cannot find module '/src/app/api/cli/extensions/install/route'

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ bootstrapLoaded: false, gatekept: true }));
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
// The product's one predicate for "gatekept install is on".
vi.mock("@/lib/gatekept-install", () => ({
  isGatekeptInstallEnabled: () => state.gatekept,
}));
// The canonical install primitive (the `extensions_install` MCP tool's
// function). Its authorize-first gatekept path, kind check and batch call are
// covered by packages/extensions/src/__tests__/extensions-install-allowed-kinds-4920.test.ts.
vi.mock("@cinatra-ai/extensions/mcp-handlers", () => ({
  EXTENSION_KIND_NOT_ALLOWED: "EXTENSION_KIND_NOT_ALLOWED",
  createExtensionsPrimitiveHandlers: () => ({
    extensions_install: (...args: unknown[]) => {
      bootstrapSeenAtCall.push(state.bootstrapLoaded);
      return extensionsInstallMock(...args);
    },
  }),
}));

import { POST } from "../route";
// The real error the install batch throws for a failed member (it carries the
// packages its rollback could not remove in `compensationFailures`).
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
  state.gatekept = true;
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
    ["a v-prefixed version", { packageName: "@example-org/agent-hello", version: "v1.2.3" }],
    ["a version with a leading space", { packageName: "@example-org/agent-hello", version: " 1.2.3" }],
    ["a version with a trailing space", { packageName: "@example-org/agent-hello", version: "1.2.3 " }],
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

  it("gatekept install off → 409 before the body is read and before the primitive", async () => {
    state.gatekept = false;
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "Installing through the CLI needs the marketplace-gatekept install mode on this instance.",
    );
    expect(extensionsInstallMock).not.toHaveBeenCalled();
  });

  it("gatekept install off is checked after authorization (an unauthenticated caller still gets 401)", async () => {
    state.gatekept = false;
    authorizeCliRequestMock.mockResolvedValue({ ok: false, status: 401, error: "Unauthorized" });
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(401);
  });

  it("a failed batch member whose rollback is incomplete → 500 naming the packages for manual removal, no downstream text", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchError = Object.assign(
      new Error("404 Not Found - GET https://broker.example.test/@example-org%2fconnector-dep - secret detail"),
      { code: "E404", statusCode: 404 },
    );
    extensionsInstallMock.mockRejectedValue(
      new BatchMemberInstallError(
        "Installing @example-org/agent-hello@1.2.3 failed at dependency @example-org/connector-dep: 404 Not Found. ROLLBACK INCOMPLETE for @example-org/skill-dep — these may need manual removal. Previously-installed extensions were not touched.",
        "@example-org/connector-dep",
        [],
        ["@example-org/skill-dep"],
        fetchError,
      ),
    );
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error:
        "Installing @example-org/agent-hello@1.2.3 failed and its rollback is incomplete; these packages may need manual removal: @example-org/skill-dep.",
      needsManualRemoval: ["@example-org/skill-dep"],
    });
    expect(JSON.stringify(body)).not.toMatch(/secret detail|404/);
    errorSpy.mockRestore();
  });

  it("a failed batch member wrapped in another error is still found", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const inner = new BatchMemberInstallError("m", "@example-org/connector-dep", [], ["@example-org/skill-dep"]);
    extensionsInstallMock.mockRejectedValue(Object.assign(new Error("outer"), { cause: inner }));
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(500);
    expect((await res.json()).needsManualRemoval).toEqual(["@example-org/skill-dep"]);
    errorSpy.mockRestore();
  });

  it("a failed batch member with a complete rollback → the generic 500, even when its cause is a registry 404", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    extensionsInstallMock.mockRejectedValue(
      new BatchMemberInstallError(
        "Installing @example-org/agent-hello@1.2.3 failed at dependency @example-org/connector-dep: 404 Not Found. Rolled back the dependencies this install had added (@example-org/skill-dep); Previously-installed extensions were not touched.",
        "@example-org/connector-dep",
        ["@example-org/skill-dep"],
        [],
        Object.assign(new Error("404 Not Found"), { code: "E404", statusCode: 404 }),
      ),
    );
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to install the extension package." });
    errorSpy.mockRestore();
  });

  it.each([
    [
      "requires-rebuild",
      {
        success: false,
        requiresRebuild: true,
        packageName: "@example-org/agent-hello",
        packageVersion: "1.2.3",
        message: "@example-org/agent-hello requires a host rebuild",
        compensationFailures: ["@example-org/skill-dep"],
      },
    ],
    [
      "contract-violation",
      {
        success: false,
        contractViolation: true,
        packageName: "@example-org/agent-hello",
        packageVersion: "1.2.3",
        missingFields: ["cinatra.riskLevel"],
        message: "missing cinatra.riskLevel",
        compensationFailures: ["@example-org/skill-dep"],
      },
    ],
  ])("a %s result after a FAILED rollback (the primitive's structured result with compensationFailures) → the incomplete-rollback 500, not a 4xx", async (_label, result) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    extensionsInstallMock.mockResolvedValue(result);
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error:
        "Installing @example-org/agent-hello@1.2.3 failed and its rollback is incomplete; these packages may need manual removal: @example-org/skill-dep.",
      needsManualRemoval: ["@example-org/skill-dep"],
    });
    errorSpy.mockRestore();
  });

  it("a raw structured error thrown with compensationFailures → the incomplete-rollback 500", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    extensionsInstallMock.mockRejectedValue(
      Object.assign(new Error("refused"), {
        code: "REQUIRES_REBUILD",
        compensationFailures: ["@example-org/skill-dep"],
      }),
    );
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(500);
    expect((await res.json()).needsManualRemoval).toEqual(["@example-org/skill-dep"]);
    errorSpy.mockRestore();
  });

  it("an unexpected failure → the fixed generic 500, logged server-side", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    extensionsInstallMock.mockRejectedValue(new Error("boom with internal detail"));
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to install the extension package.");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]!.slice(1)).toEqual([
      "failed",
      "@example-org/agent-hello@1.2.3",
      "Error",
      "none",
      "unrecoverable",
      "none",
      "no",
    ]);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toMatch(/internal detail/);
    errorSpy.mockRestore();
  });

  it.each([
    ["a plain marketplace-style error", (e: Error) => e],
    ["a failed batch member", (e: Error) => new BatchMemberInstallError(`failed: ${e.message}`, "@example-org/dep", [], [], e)],
    [
      "a failed batch member with an incomplete rollback",
      (e: Error) => new BatchMemberInstallError(`failed: ${e.message}`, "@example-org/dep", [], ["@example-org/dep"], e),
    ],
  ])("%s: no upstream message or body text reaches the log (cinatra#4920)", async (_label, wrap) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstream = Object.assign(
      new Error("marketplace call failed: token=sk-live-SECRET123 upstream said no"),
      {
        name: "MarketplaceMcpError",
        code: "cinatra.install_unavailable token=sk-live-SECRET123",
        httpStatus: 502,
        responseBody: '{"error":"internal","debug":"Bearer sk-live-SECRET123"}',
      },
    );
    extensionsInstallMock.mockRejectedValue(wrap(upstream));
    const res = await POST(post(OK_BODY));
    expect(res.status).toBeGreaterThanOrEqual(500);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(errorSpy).toHaveBeenCalled();
    expect(logged).not.toMatch(/SECRET123|upstream said no|debug/);
    for (const call of errorSpy.mock.calls) {
      for (const arg of call) expect(typeof arg === "string" || typeof arg === "number").toBe(true);
    }
    expect(JSON.stringify(await res.json())).not.toMatch(/SECRET123/);
    errorSpy.mockRestore();
  });

  it("a root whose authorized kind differs from its manifest kind → 422, nothing installed (cinatra#4920)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    extensionsInstallMock.mockRejectedValue(
      Object.assign(new Error("internal detail"), {
        code: "EXTENSION_KIND_MISMATCH",
        kind: "connector",
        authorizedKind: "agent",
      }),
    );
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error).toBe(
      "@example-org/agent-hello@1.2.3 was not installed: the kind the marketplace authorized differs from the kind in the package manifest.",
    );
    errorSpy.mockRestore();
  });

  it("a kind refusal does not echo an unknown kind string (cinatra#4920)", async () => {
    extensionsInstallMock.mockRejectedValue(
      Object.assign(new Error("x"), { code: "EXTENSION_KIND_NOT_ALLOWED", kind: "<script>sk-live-SECRET" }),
    );
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error).toMatch(/is an extension package/);
    expect(error).not.toMatch(/SECRET|script/);
  });

  it("a root-only install whose dispatcher rollback failed (compensationFailures on the dispatcher error) → the incomplete-rollback 500 (cinatra#4920)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    extensionsInstallMock.mockRejectedValue(
      Object.assign(
        new Error(
          "install of @example-org/agent-hello failed in the agent handler AFTER the store pipeline finalized (x) — AND the dispatcher compensation ALSO failed (archive threw); manual recovery required",
        ),
        { compensationFailures: ["@example-org/agent-hello"] },
      ),
    );
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error:
        "Installing @example-org/agent-hello@1.2.3 failed and its rollback is incomplete; these packages may need manual removal: @example-org/agent-hello.",
      needsManualRemoval: ["@example-org/agent-hello"],
    });
    expect(errorSpy.mock.calls[0]!.at(-1)).toBe("@example-org/agent-hello");
    errorSpy.mockRestore();
  });
});
