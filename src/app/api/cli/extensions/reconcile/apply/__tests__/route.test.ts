// POST /api/cli/extensions/reconcile/apply — route wiring, CAS 409 mapping,
// body parsing, and auth mirroring.

import { describe, it, expect, vi, beforeEach } from "vitest";

const authorizeCliRequestMock = vi.fn();
const applyReconcileMock = vi.fn();

vi.mock("@/lib/cli-api/route-guard", () => ({
  authorizeCliRequest: (...args: unknown[]) => authorizeCliRequestMock(...args),
}));
vi.mock("@/lib/cli-api/extensions-reconcile", () => {
  const PLAN_DIGEST_MISMATCH_CODE = "plan-digest-mismatch";
  class PlanDigestMismatchError extends Error {
    code = PLAN_DIGEST_MISMATCH_CODE;
  }
  return {
    applyReconcile: (...args: unknown[]) => applyReconcileMock(...args),
    PLAN_DIGEST_MISMATCH_CODE,
    PlanDigestMismatchError,
  };
});

import { POST } from "../route";

const URL_ = "https://inst.cinatra.ai/api/cli/extensions/reconcile/apply";
function post(body?: string): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
}

const SAMPLE_RESULT = {
  planDigest: "sha256:abc",
  applied: [{ packageName: "@acme/foo", fromVersion: "1.0.0", toVersion: "1.1.0" }],
  failed: [],
  droppedByRecheck: [],
  auditWriteFailures: 0,
  initiatingOperator: "admin-1",
  systemExecutor: "system:extension-auto-update",
};

beforeEach(() => {
  authorizeCliRequestMock.mockReset();
  applyReconcileMock.mockReset();
  authorizeCliRequestMock.mockResolvedValue({ ok: true, actor: { userId: "admin-1" } });
});

describe("POST /api/cli/extensions/reconcile/apply", () => {
  it("empty body → re-plans against live (expectedDigest undefined); auth mirrors platform-admin + cli:extensions:write", async () => {
    applyReconcileMock.mockResolvedValue(SAMPLE_RESULT);

    const res = await POST(post());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SAMPLE_RESULT);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(authorizeCliRequestMock).toHaveBeenCalledWith(expect.anything(), {
      minTier: "platform-admin",
      requiredScope: "cli:extensions:write",
    });
    expect(applyReconcileMock).toHaveBeenCalledWith({
      expectedDigest: undefined,
      initiatingOperator: "admin-1",
    });
  });

  it("forwards `planDigest` from the body as the CAS `expectedDigest`", async () => {
    applyReconcileMock.mockResolvedValue(SAMPLE_RESULT);

    await POST(post(JSON.stringify({ planDigest: "sha256:pinned" })));

    expect(applyReconcileMock).toHaveBeenCalledWith({
      expectedDigest: "sha256:pinned",
      initiatingOperator: "admin-1",
    });
  });

  it("a digest-CAS mismatch → HTTP 409 with the `plan-digest-mismatch` code the CLI keys on", async () => {
    applyReconcileMock.mockRejectedValue(
      Object.assign(new Error("mismatch"), { code: "plan-digest-mismatch" }),
    );

    const res = await POST(post(JSON.stringify({ planDigest: "sha256:stale" })));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("plan-digest-mismatch");
    expect(body.error).toMatch(/plan changed since the supplied --plan-digest/);
  });

  it("records the dev-admin-bypass principal when the guard actor has no user id", async () => {
    authorizeCliRequestMock.mockResolvedValue({ ok: true, actor: { userId: null } });
    applyReconcileMock.mockResolvedValue(SAMPLE_RESULT);

    await POST(post());

    expect(applyReconcileMock).toHaveBeenCalledWith({
      expectedDigest: undefined,
      initiatingOperator: "system:dev-admin-bypass",
    });
  });

  it("a non-string planDigest → 400 (never reaches apply)", async () => {
    const res = await POST(post(JSON.stringify({ planDigest: 42 })));
    expect(res.status).toBe(400);
    expect(applyReconcileMock).not.toHaveBeenCalled();
  });

  it("an explicit `planDigest: null` → 400, NOT a silent unpinned apply (fail-closed)", async () => {
    const res = await POST(post(JSON.stringify({ planDigest: null })));
    expect(res.status).toBe(400);
    expect(applyReconcileMock).not.toHaveBeenCalled();
  });

  it("an empty-string planDigest → 400", async () => {
    const res = await POST(post(JSON.stringify({ planDigest: "  " })));
    expect(res.status).toBe(400);
    expect(applyReconcileMock).not.toHaveBeenCalled();
  });

  it("a JSON array body → 400 (not a valid object body)", async () => {
    const res = await POST(post(JSON.stringify(["cli:extensions:write"])));
    expect(res.status).toBe(400);
    expect(applyReconcileMock).not.toHaveBeenCalled();
  });

  it("a malformed JSON body → 400 (never reaches apply)", async () => {
    const res = await POST(post("{not json"));
    expect(res.status).toBe(400);
    expect(applyReconcileMock).not.toHaveBeenCalled();
  });

  it("a non-object JSON body → 400", async () => {
    const res = await POST(post(JSON.stringify("a string")));
    expect(res.status).toBe(400);
    expect(applyReconcileMock).not.toHaveBeenCalled();
  });

  it("under-privileged → guard passthrough; apply is NEVER invoked", async () => {
    authorizeCliRequestMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Forbidden: this CLI endpoint requires platform admin.",
    });

    const res = await POST(post());

    expect(res.status).toBe(403);
    expect(applyReconcileMock).not.toHaveBeenCalled();
  });

  it("an unexpected apply error → 500", async () => {
    applyReconcileMock.mockRejectedValue(new Error("boom"));
    const res = await POST(post());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Failed to apply the reconcile plan/);
  });
});
