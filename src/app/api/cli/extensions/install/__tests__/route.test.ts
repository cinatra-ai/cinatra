// POST /api/cli/extensions/install — route wiring, auth mirroring, body
// validation and the batch result/failure mapping (cinatra#4920).
// red-first-expect: Cannot find module '/src/app/api/cli/extensions/install/route'

import { describe, it, expect, vi, beforeEach } from "vitest";

const authorizeCliRequestMock = vi.fn();
const installBatchMock = vi.fn();

vi.mock("@/lib/cli-api/route-guard", () => ({
  authorizeCliRequest: (...args: unknown[]) => authorizeCliRequestMock(...args),
}));
vi.mock("@/lib/extension-install-batch", () => ({
  installExtensionWithDependencies: (...args: unknown[]) => installBatchMock(...args),
}));

import { POST } from "../route";

const URL_ = "https://inst.cinatra.ai/api/cli/extensions/install";
function post(body?: string): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
}

const ADMIN = {
  ok: true,
  actor: {
    userId: "admin-1",
    isPlatformAdmin: true,
    organizationId: "org-1",
    via: "bearer",
  },
};

const BATCH_RESULT = {
  rootPackage: "@example-org/agent-hello",
  rootVersion: "1.2.3",
  installed: [
    { packageName: "@example-org/connector-dep", version: "0.4.0" },
    { packageName: "@example-org/agent-hello", version: "1.2.3" },
  ],
  updated: [],
  installedSideBySide: [],
  alreadyInstalled: [],
  batchId: "batch-1",
};

beforeEach(() => {
  authorizeCliRequestMock.mockReset();
  installBatchMock.mockReset();
  authorizeCliRequestMock.mockResolvedValue(ADMIN);
});

describe("POST /api/cli/extensions/install", () => {
  it("happy path: auth mirrors platform-admin + cli:extensions:write; calls the install batch ONCE with name + range", async () => {
    installBatchMock.mockResolvedValue(BATCH_RESULT);

    const res = await POST(
      post(JSON.stringify({ packageName: "@example-org/agent-hello", version: "^1.2.0" })),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(authorizeCliRequestMock).toHaveBeenCalledWith(expect.anything(), {
      minTier: "platform-admin",
      requiredScope: "cli:extensions:write",
    });
    expect(installBatchMock).toHaveBeenCalledTimes(1);
    const arg = installBatchMock.mock.calls[0][0];
    expect(arg.packageName).toBe("@example-org/agent-hello");
    expect(arg.version).toBe("^1.2.0");
    // The standing-free install envelope (the UI install wrapper's shape): no
    // platformRole, so a compensating uninstall can never take the
    // package-global branch.
    expect(arg.actor).toEqual({
      actorType: "human",
      source: "route",
      userId: "admin-1",
      orgId: "org-1",
    });
    const body = await res.json();
    expect(body).toEqual({
      packageName: "@example-org/agent-hello",
      version: "1.2.3",
      installed: BATCH_RESULT.installed,
      updated: [],
      installedSideBySide: [],
      alreadyInstalled: [],
    });
  });

  it("an absent version passes no version (the batch resolves latest)", async () => {
    installBatchMock.mockResolvedValue(BATCH_RESULT);
    await POST(post(JSON.stringify({ packageName: "@example-org/agent-hello" })));
    expect(installBatchMock).toHaveBeenCalledTimes(1);
    expect(installBatchMock.mock.calls[0][0].version).toBeUndefined();
  });

  it("the dev-admin bypass (no user id, no org) installs with an identity-free envelope", async () => {
    authorizeCliRequestMock.mockResolvedValue({
      ok: true,
      actor: { userId: null, isPlatformAdmin: true, organizationId: null, via: "dev-admin-bypass" },
    });
    installBatchMock.mockResolvedValue(BATCH_RESULT);
    await POST(post(JSON.stringify({ packageName: "@example-org/agent-hello" })));
    expect(installBatchMock.mock.calls[0][0].actor).toEqual({
      actorType: "human",
      source: "route",
    });
  });

  it("unauthenticated → the guard's 401 passes through; the batch is NEVER invoked", async () => {
    authorizeCliRequestMock.mockResolvedValue({ ok: false, status: 401, error: "Unauthorized" });
    const res = await POST(post(JSON.stringify({ packageName: "@example-org/agent-hello" })));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
    expect(installBatchMock).not.toHaveBeenCalled();
  });

  it("wrong scope → the guard's 403 passes through; the batch is NEVER invoked", async () => {
    authorizeCliRequestMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Forbidden: token lacks the cli:extensions:write scope.",
    });
    const res = await POST(post(JSON.stringify({ packageName: "@example-org/agent-hello" })));
    expect(res.status).toBe(403);
    expect(installBatchMock).not.toHaveBeenCalled();
  });

  it("non-administrator → the guard's 403 passes through; the batch is NEVER invoked", async () => {
    authorizeCliRequestMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Forbidden: this CLI endpoint requires platform admin.",
    });
    const res = await POST(post(JSON.stringify({ packageName: "@example-org/agent-hello" })));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/platform admin/);
    expect(installBatchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an unscoped name", { packageName: "agent-hello" }],
    ["an upper-case name", { packageName: "@Example-Org/agent-hello" }],
    ["a path-like name", { packageName: "@example-org/../etc" }],
    ["a missing name", {}],
    ["a non-string name", { packageName: 42 }],
    ["an empty version", { packageName: "@example-org/agent-hello", version: " " }],
    ["a non-string version", { packageName: "@example-org/agent-hello", version: 1 }],
    ["a version with shell characters", { packageName: "@example-org/agent-hello", version: "1.0.0;rm" }],
  ])("%s → 400 before any work", async (_label, body) => {
    const res = await POST(post(JSON.stringify(body)));
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
    expect(installBatchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed JSON body", "{not json"],
    ["an empty body", ""],
    ["a JSON array body", JSON.stringify(["@example-org/agent-hello"])],
    ["a JSON string body", JSON.stringify("@example-org/agent-hello")],
  ])("%s → 400 before any work", async (_label, raw) => {
    const res = await POST(post(raw));
    expect(res.status).toBe(400);
    expect(installBatchMock).not.toHaveBeenCalled();
  });

  it("a batch failure surfaces the batch's own failure text", async () => {
    installBatchMock.mockRejectedValue(
      new Error(
        "Installing @example-org/agent-hello@1.2.3 failed at dependency @example-org/connector-dep: boom",
      ),
    );
    const res = await POST(post(JSON.stringify({ packageName: "@example-org/agent-hello" })));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe(
      "Installing @example-org/agent-hello@1.2.3 failed at dependency @example-org/connector-dep: boom",
    );
  });
});
