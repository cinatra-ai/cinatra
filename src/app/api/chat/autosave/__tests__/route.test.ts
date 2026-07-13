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
const writeSkillAutosaveUserPref = vi.fn();
const readSkillAutosaveConfig = vi.fn(() => ({
  enabled: false,
  userCanConfigure: false,
  userCanSeeIndicator: true,
}));
const readSkillAutosaveUserPref = vi.fn((_userId?: string) => ({
  chatCaptureEnabled: null as boolean | null,
}));

vi.mock("@/lib/auth-session", () => ({
  getActorContext: () => getActorContext(),
}));
vi.mock("@/lib/skill-autosave", () => ({
  readSkillAutosaveConfig: () => readSkillAutosaveConfig(),
  writeSkillAutosaveConfig: (...a: unknown[]) => writeSkillAutosaveConfig(...a),
  readSkillAutosaveUserPref: (...a: unknown[]) => readSkillAutosaveUserPref(...(a as [string])),
  writeSkillAutosaveUserPref: (...a: unknown[]) => writeSkillAutosaveUserPref(...a),
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

  // ---- per-user chat-capture preference arm (cinatra#1367) ----

  it("GET carries the caller's own userChatCaptureEnabled", async () => {
    getActorContext.mockResolvedValue(orgAdmin());
    readSkillAutosaveUserPref.mockReturnValueOnce({ chatCaptureEnabled: false });
    const { GET } = await import("../route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userChatCaptureEnabled: boolean | null };
    expect(body.userChatCaptureEnabled).toBe(false);
    expect(readSkillAutosaveUserPref).toHaveBeenCalledWith("user-2");
  });

  it("PATCH user arm 403 for a non-admin while userCanConfigure is off — pref never written", async () => {
    getActorContext.mockResolvedValue(orgAdmin());
    const { PATCH } = await import("../route");
    const res = await PATCH(patchReq({ userChatCaptureEnabled: false }));
    expect(res.status).toBe(403);
    expect(writeSkillAutosaveUserPref).not.toHaveBeenCalled();
    expect(logAuditEventStrict).not.toHaveBeenCalled();
  });

  it("PATCH user arm writes the CALLER's own pref when userCanConfigure is on — audited", async () => {
    getActorContext.mockResolvedValue(orgAdmin());
    readSkillAutosaveConfig.mockReturnValue({
      enabled: true,
      userCanConfigure: true,
      userCanSeeIndicator: true,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(patchReq({ userChatCaptureEnabled: false }));
    expect(res.status).toBe(200);
    expect(logAuditEventStrict).toHaveBeenCalledTimes(1);
    expect(writeSkillAutosaveUserPref).toHaveBeenCalledWith("user-2", {
      chatCaptureEnabled: false,
    });
    // Global config untouched by the user arm.
    expect(writeSkillAutosaveConfig).not.toHaveBeenCalled();
    readSkillAutosaveConfig.mockReset();
    readSkillAutosaveConfig.mockImplementation(() => ({
      enabled: false,
      userCanConfigure: false,
      userCanSeeIndicator: true,
    }));
  });

  it("PATCH user arm allows a platform admin regardless of userCanConfigure; null resets to follow-default", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const { PATCH } = await import("../route");
    const res = await PATCH(patchReq({ userChatCaptureEnabled: null }));
    expect(res.status).toBe(200);
    expect(writeSkillAutosaveUserPref).toHaveBeenCalledWith("admin-1", {
      chatCaptureEnabled: null,
    });
  });

  it("PATCH without either arm stays a read — nothing written, nothing audited", async () => {
    getActorContext.mockResolvedValue(platformAdmin());
    const { PATCH } = await import("../route");
    const res = await PATCH(patchReq({}));
    expect(res.status).toBe(200);
    expect(writeSkillAutosaveConfig).not.toHaveBeenCalled();
    expect(writeSkillAutosaveUserPref).not.toHaveBeenCalled();
    expect(logAuditEventStrict).not.toHaveBeenCalled();
  });
});
