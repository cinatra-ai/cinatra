import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// Route-handler integration test. The authz kernel runs for real (so the
// platform-only gate is exercised end-to-end); QueueDash, the session, and the
// audit sink are mocked so no Redis/DB is needed. Asserts: reads allowed,
// destructive ops gated on operations.execute, unknown procedures fail closed,
// and QueueDash is never reached on a denial.
// ---------------------------------------------------------------------------

const getActorContext = vi.fn<() => Promise<ActorContext | undefined>>();
const fetchRequestHandler = vi.fn();
const logAuditEventStrict = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getActorContext: () => getActorContext(),
}));
vi.mock("@/lib/background-jobs", () => ({
  getQueueDashContext: async () => ({ queues: [] }),
}));
vi.mock("@trpc/server/adapters/fetch", () => ({
  fetchRequestHandler: (...a: unknown[]) => {
    fetchRequestHandler(...a);
    return new Response(JSON.stringify({ forwarded: true }), { status: 200 });
  },
}));
// A minimal stand-in for the QueueDash router exposing the same
// `_def.procedures[name]._def.type` shape the route reads.
vi.mock("@queuedash/api", () => {
  const mk = (type: "query" | "mutation") => ({ _def: { type } });
  return {
    appRouter: {
      _def: {
        procedures: {
          "queue.list": mk("query"),
          "queue.metrics": mk("query"),
          "job.logs": mk("query"),
          "job.retry": mk("mutation"),
          "job.remove": mk("mutation"),
          "queue.clean": mk("mutation"),
        },
      },
    },
  };
});
vi.mock("@/lib/authz/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/authz/audit")>("@/lib/authz/audit");
  return { ...actual, logAuditEventStrict: (i: unknown) => logAuditEventStrict(i) };
});

const ENDPOINT = "https://app.test/api/admin/operations/jobs";

function platformAdmin(): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "admin-1",
    organizationId: "org-1",
    platformRole: "platform_admin",
    orgRole: "member",
    authSource: "ui",
    policyVersion: "v2",
  };
}
function orgAdmin(): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-2",
    organizationId: "org-1",
    platformRole: "member",
    orgRole: "org_admin",
    authSource: "ui",
    policyVersion: "v2",
  };
}

function makeReq(path: string, method = "POST"): Request {
  return new Request(`${ENDPOINT}/${path}?batch=1`, { method });
}

describe("operations/jobs route handler", () => {
  beforeEach(() => {
    logAuditEventStrict.mockResolvedValue({ id: "audit-1" });
    fetchRequestHandler.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("401 when unauthenticated", async () => {
    getActorContext.mockResolvedValue(undefined);
    const { POST } = await import("../route");
    const res = await POST(makeReq("queue.list"));
    expect(res.status).toBe(401);
    expect(fetchRequestHandler).not.toHaveBeenCalled();
  });

  it("platform admin can list (read) — forwarded, no audit row", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const { GET } = await import("../route");
    const res = await GET(makeReq("queue.list", "GET"));
    expect(res.status).toBe(200);
    expect(fetchRequestHandler).toHaveBeenCalledTimes(1);
    expect(logAuditEventStrict).not.toHaveBeenCalled();
  });

  it("platform admin can retry (execute) — forwarded with one audit row", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const { POST } = await import("../route");
    const res = await POST(makeReq("job.retry"));
    expect(res.status).toBe(200);
    expect(fetchRequestHandler).toHaveBeenCalledTimes(1);
    expect(logAuditEventStrict).toHaveBeenCalledTimes(1);
  });

  it("org_admin (non-platform) is denied a destructive op — NOT forwarded", async () => {
    getActorContext.mockResolvedValue(orgAdmin());
    const { POST } = await import("../route");
    const res = await POST(makeReq("job.retry"));
    expect(res.status).toBe(403);
    expect(fetchRequestHandler).not.toHaveBeenCalled();
    expect(logAuditEventStrict).not.toHaveBeenCalled();
  });

  it("org_admin (non-platform) is denied a read too (operations.read is platform-only)", async () => {
    getActorContext.mockResolvedValue(orgAdmin());
    const { GET } = await import("../route");
    const res = await GET(makeReq("queue.list", "GET"));
    expect(res.status).toBe(403);
    expect(fetchRequestHandler).not.toHaveBeenCalled();
  });

  it("unknown procedure fails closed (403) and never reaches QueueDash", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const { POST } = await import("../route");
    const res = await POST(makeReq("job.nuke"));
    expect(res.status).toBe(403);
    expect(fetchRequestHandler).not.toHaveBeenCalled();
    expect(logAuditEventStrict).not.toHaveBeenCalled();
  });

  it("a batch with one unknown proc denies the WHOLE batch (nothing forwarded)", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const { POST } = await import("../route");
    const res = await POST(makeReq("job.retry,job.nuke"));
    expect(res.status).toBe(403);
    expect(fetchRequestHandler).not.toHaveBeenCalled();
    expect(logAuditEventStrict).not.toHaveBeenCalled();
  });

  it("an audit-write failure aborts the batch with 503 — not forwarded", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    logAuditEventStrict.mockRejectedValueOnce(new Error("db down"));
    const { POST } = await import("../route");
    const res = await POST(makeReq("job.retry"));
    expect(res.status).toBe(503);
    expect(fetchRequestHandler).not.toHaveBeenCalled();
  });

  it("a cross-origin request is rejected 403 before auth runs", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const req = new Request(`${ENDPOINT}/queue.list?batch=1`, {
      method: "POST",
      headers: { origin: "https://evil.test" },
    });
    const { POST } = await import("../route");
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(getActorContext).not.toHaveBeenCalled();
    expect(fetchRequestHandler).not.toHaveBeenCalled();
  });
});
