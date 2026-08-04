/**
 * THE HOST-OWNED TYPED SETUP CONNECTION WRITER (cinatra#2390, epic #2385 S5).
 *
 * What is pinned here, end-to-end through the REAL `dispatchExtensionUiAction`
 * (dependency-injected, exactly as the generic action route drives it):
 *
 *  - the writer addresses the connector's DEFAULT LIVE install and dispatches
 *    its registered non-redirecting `saveConnection` action with the form's
 *    flat values map;
 *  - the UNTRUSTED result shape is interpreted fail-closed: only the known
 *    banner names are success, and unknown/absent banners never leak the
 *    untrusted object's text into the typed result;
 *  - a thrown handler error (the 500 arm) is SANITIZED server-side before it
 *    becomes the typed result's message — a key echoed back by the provider
 *    never survives raw;
 *  - the writer NEVER throws a redirect and NEVER produces a URL: the typed
 *    result is the only channel.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The heavy graph edges are stubbed; the writer's DEFAULT deps are not used in
// these tests (deps are injected), but the module-level imports must resolve.
vi.mock("@/lib/extensions", () => ({}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/extensions/enforce-extension-access", () => ({
  canExtensionAccess: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/extension-ui-registry", () => ({
  resolveExtensionUiAction: vi.fn(() => null),
}));
vi.mock("@/lib/extension-version-keyed-serving", () => ({
  resolveVersionKeyedUiAction: vi.fn(() => ({
    kind: "refuse",
    code: "UNPINNED",
    message: "not pinned",
  })),
}));
vi.mock("@/lib/extension-host-actor", () => ({
  resolveExtensionActorContext: vi.fn(async () => ({ userId: "admin" })),
}));
// A marker sanitizer: the real redaction is pinned by
// setup-readiness-saga.test.ts; here we prove the writer ROUTES through it.
vi.mock("@/lib/setup-readiness-saga", () => ({
  sanitizeReadinessMessage: (text: string) =>
    `[sanitized]${text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]")}`,
}));

import { saveSetupProviderConnection } from "@/lib/setup-provider-connection-writer";
import { dispatchExtensionUiAction } from "@/lib/extension-action-dispatch";

type InstallRow = {
  id: string;
  packageName: string;
  kind: string;
  status: string;
  isDefault?: boolean;
  version?: string | null;
  ownerLevel: string;
  ownerId: string | null;
  organizationId: string | null;
};

function liveInstall(overrides: Partial<InstallRow> = {}): InstallRow {
  return {
    id: "install-1",
    packageName: "@cinatra-ai/openai-connector",
    kind: "connector",
    status: "active",
    isDefault: true,
    version: "0.1.9",
    ownerLevel: "instance",
    ownerId: null,
    organizationId: null,
    ...overrides,
  };
}

/** Deps that drive the REAL dispatch against an in-memory registry. */
function depsWith(params: {
  rows: InstallRow[];
  handler?: (input: unknown) => Promise<unknown>;
  authorized?: boolean;
}) {
  const handlerCalls: unknown[] = [];
  const deps = {
    resolveInstallRows: vi.fn(async () => params.rows as never),
    resolveActor: vi.fn(async () => ({ userId: "admin" })),
    dispatch: vi.fn(
      (
        input: Parameters<typeof dispatchExtensionUiAction>[0],
        dispatchDeps: Parameters<typeof dispatchExtensionUiAction>[1],
      ) =>
        // The REAL dispatch pipeline, with the writer's own deps — same
        // authorization walk the generic action route performs.
        dispatchExtensionUiAction(input, {
          ...dispatchDeps,
          authorize: async (row, actor) =>
            params.authorized === false ? false : dispatchDeps.authorize(row, actor),
          resolveAction: (packageName, actionId) =>
            params.handler && actionId === "saveConnection"
              ? {
                  packageName,
                  id: actionId,
                  handler: async (input: unknown) => {
                    handlerCalls.push(input);
                    return params.handler!(input);
                  },
                }
              : null,
        }),
    ),
  };
  return { deps, handlerCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveSetupProviderConnection — typed, sanitized, redirect-free", () => {
  it("dispatches the registered saveConnection action on the DEFAULT LIVE install with the flat values map", async () => {
    const { deps, handlerCalls } = depsWith({
      rows: [
        liveInstall({ id: "old-archived", status: "archived" }),
        liveInstall({ id: "side-by-side", isDefault: false }),
        liveInstall({ id: "the-default" }),
      ],
      handler: async () => ({ banner: "saved" }),
    });

    const result = await saveSetupProviderConnection(
      "openai",
      { apiKey: "sk-live", projectId: "p1" },
      deps as never,
    );

    expect(result).toEqual({ ok: true, code: "saved", sanitizedMessage: null });
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ installId: "the-default", actionId: "saveConnection" }),
      expect.anything(),
    );
    expect(handlerCalls).toEqual([{ apiKey: "sk-live", projectId: "p1" }]);
  });

  it("maps the degraded-save banner to ok + STATIC warning copy", async () => {
    const { deps } = depsWith({
      rows: [liveInstall()],
      handler: async () => ({ banner: "savedWithoutConnectionService" }),
    });
    const result = await saveSetupProviderConnection("openai", { apiKey: "k" }, deps as never);
    expect(result.ok).toBe(true);
    expect(result.code).toBe("saved-degraded");
    expect(result.sanitizedMessage).toContain("connection-service copy");
  });

  it("NO live default install → connector-unavailable (typed, static copy)", async () => {
    const { deps } = depsWith({
      rows: [liveInstall({ status: "archived" }), liveInstall({ isDefault: false })],
    });
    const result = await saveSetupProviderConnection("openai", {}, deps as never);
    expect(result).toMatchObject({ ok: false, code: "connector-unavailable" });
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("an UNKNOWN banner is a fail-closed rejection whose copy never lifts the untrusted result's text", async () => {
    const { deps } = depsWith({
      rows: [liveInstall()],
      handler: async () => ({ banner: "totally-made-up", detail: "EVIL-UNTRUSTED-TEXT" }),
    });
    const result = await saveSetupProviderConnection("openai", { apiKey: "k" }, deps as never);
    expect(result).toMatchObject({ ok: false, code: "save-rejected" });
    expect(result.sanitizedMessage).not.toContain("EVIL-UNTRUSTED-TEXT");
    expect(result.sanitizedMessage).not.toContain("totally-made-up");
  });

  it("a THROWING handler (the 500 arm) is SANITIZED — a provider echoing the key back never survives raw", async () => {
    const { deps } = depsWith({
      rows: [liveInstall({ packageName: "@cinatra-ai/anthropic-connector" })],
      handler: async () => {
        throw new Error("upstream rejected sk-ant-SECRETVALUE0123456789");
      },
    });
    const result = await saveSetupProviderConnection("anthropic", { apiKey: "k" }, deps as never);
    expect(result).toMatchObject({ ok: false, code: "save-failed" });
    expect(result.sanitizedMessage).toContain("[sanitized]");
    expect(result.sanitizedMessage).not.toContain("SECRETVALUE");
  });

  it("an UNAUTHORIZED actor gets the dispatch's 404 → connector-unavailable (existence not leaked)", async () => {
    const { deps, handlerCalls } = depsWith({
      rows: [liveInstall()],
      handler: async () => ({ banner: "saved" }),
      authorized: false,
    });
    const result = await saveSetupProviderConnection("openai", { apiKey: "k" }, deps as never);
    expect(result).toMatchObject({ ok: false, code: "connector-unavailable" });
    expect(handlerCalls).toEqual([]);
  });

  it("NO registered action for the id → 404 → connector-unavailable", async () => {
    const { deps } = depsWith({ rows: [liveInstall()] }); // no handler registered
    const result = await saveSetupProviderConnection("openai", { apiKey: "k" }, deps as never);
    expect(result).toMatchObject({ ok: false, code: "connector-unavailable" });
  });

  it("a failing install-row read is a typed save-failed, never a throw", async () => {
    const deps = {
      resolveInstallRows: vi.fn(async () => {
        throw new Error("canonical store down");
      }),
      resolveActor: vi.fn(async () => ({})),
      dispatch: vi.fn(),
    };
    const result = await saveSetupProviderConnection("openai", {}, deps as never);
    expect(result).toMatchObject({ ok: false, code: "save-failed" });
    expect(result.sanitizedMessage).toContain("[sanitized]");
  });
});
