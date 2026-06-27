import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// Route-handler regression test for the skill-autosave config route.
// The authz kernel runs for real; the session, the skill-autosave store, and
// the audit sink are mocked. Asserts: GET needs a session (401), PATCH is
// platform-admin only (401 no session, 403 non-platform), cross-origin -> 403,
// and the global config is NEVER written on a denial.
// ---------------------------------------------------------------------------

const getActorContext = vi.fn<() => Promise<ActorContext | undefined>>();
const writeSkillAutosaveConfig = vi.fn();
const logAuditEventStrict = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getActorContext: () => getActorContext(),
}));
vi.mock("@/lib/skill-autosave", () => ({
  readSkillAutosaveConfig: () => ({
    enabled: false,
    userCanConfigure: false,
    userCanSeeIndicator: true,
  }),
  writeSkillAutosaveConfig: (...a: unknown[]) => writeSkillAutosaveConfig(...a),
}));
vi.mock("@/lib/authz/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/authz/audit")>("@/lib/authz/audit");
  return { ...actual, logAuditEventStrict: (i: unknown) => logAuditEventStrict(i) };
});

const ENDPOINT = "https://app.test/api/chat/autosave";

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

function patchReq(bodyObj: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(bodyObj),
  });
}

describe("chat/autosave route handler (global config gate)", () => {
  beforeEach(() => {
    logAuditEventStrict.mockResolvedValue({ id: "audit-1" });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("GET 401 when unauthenticated", async () => {
    getActorContext.mockResolvedValue(undefined);
    const { GET } = await import("../route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("GET 200 for any authenticated actor", async () => {
    getActorContext.mockResolvedValue(orgAdmin());
    const { GET } = await import("../route");
    const res = await GET();
    expect(res.status).toBe(200);
  });

  it("PATCH 401 when unauthenticated — config never written", async () => {
    getActorContext.mockResolvedValue(undefined);
    const { PATCH } = await import("../route");
    const res = await PATCH(patchReq({ enabled: true }));
    expect(res.status).toBe(401);
    expect(writeSkillAutosaveConfig).not.toHaveBeenCalled();
  });

  it("PATCH 403 for a non-platform actor (org_admin) — config never written", async () => {
    getActorContext.mockResolvedValue(orgAdmin());
    const { PATCH } = await import("../route");
    const res = await PATCH(patchReq({ enabled: true }));
    expect(res.status).toBe(403);
    expect(writeSkillAutosaveConfig).not.toHaveBeenCalled();
    expect(logAuditEventStrict).not.toHaveBeenCalled();
  });

  it("PATCH 403 cross-origin before auth runs — config never written", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const { PATCH } = await import("../route");
    const res = await PATCH(patchReq({ enabled: true }, { origin: "https://evil.test" }));
    expect(res.status).toBe(403);
    expect(getActorContext).not.toHaveBeenCalled();
    expect(writeSkillAutosaveConfig).not.toHaveBeenCalled();
  });

  it("PATCH platform admin — audited, then config written", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const { PATCH } = await import("../route");
    const res = await PATCH(patchReq({ enabled: true }));
    expect(res.status).toBe(200);
    expect(logAuditEventStrict).toHaveBeenCalledTimes(1);
    expect(writeSkillAutosaveConfig).toHaveBeenCalledWith({ enabled: true });
  });

  it("PATCH 503 when the pre-write audit fails — config never written", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    logAuditEventStrict.mockRejectedValueOnce(new Error("db down"));
    const { PATCH } = await import("../route");
    const res = await PATCH(patchReq({ enabled: true }));
    expect(res.status).toBe(503);
    expect(writeSkillAutosaveConfig).not.toHaveBeenCalled();
  });
});
