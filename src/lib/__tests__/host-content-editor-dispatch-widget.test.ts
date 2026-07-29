// S5-W1 §5 — the HOST-side delegated-widget dispatch guarantees:
//  - ATOMICITY GUARD: a public_site_widget delegation on the MCP frame WITHOUT a
//    matching actorOverride FAILS LOUD (never a silent fall-through to install
//    identity) — closing the parity gap even if a connector never binds
//    resolveWidgetActor.
//  - actorOverride FORWARDED VERBATIM into the carrier agent_run (runBy/orgId/
//    sourceType) with cinatra_run_id injected (G1/G4).
//  - G11 POINT-OF-USE re-assert: a caller preCreateAuthorize is honored; absent
//    one, the widget path defaults to a live org-membership re-check (a revoked
//    member is refused at the run-creation boundary, no run created).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- A2A + LLM runtime edges -------------------------------------------------
const sendTask = vi.fn();
const createExternalA2AClient = vi.fn(async () => ({ sendTask }));
const buildA2aBearerToken = vi.fn(async () => "bearer-token");
vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: (...a: unknown[]) => createExternalA2AClient(...(a as [])),
}));
vi.mock("@cinatra-ai/llm", () => ({
  buildA2aBearerToken: (...a: unknown[]) => buildA2aBearerToken(...(a as [])),
}));

// --- agents store ------------------------------------------------------------
// cinatra#1940 P3: createAgentRun now takes a REQUIRED trailing `authority`
// param (the guarded creation perimeter); the mock forwards it.
const createAgentRun = vi.fn<(input: { id: string }, authority?: unknown) => Promise<unknown>>();
const readAgentTemplateByPackageName = vi.fn<(pkg: string) => Promise<unknown>>();
const readLatestAgentVersionIdForTemplate = vi.fn<(id: string) => Promise<unknown>>();
const transitionRunStatus = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
vi.mock("@cinatra-ai/agents", () => ({
  createAgentRun: (input: { id: string }, authority?: unknown) => createAgentRun(input, authority),
  readAgentTemplateByPackageName: (pkg: string) => readAgentTemplateByPackageName(pkg),
  readLatestAgentVersionIdForTemplate: (id: string) => readLatestAgentVersionIdForTemplate(id),
  transitionRunStatus: (...a: unknown[]) => transitionRunStatus(...a),
}));

// The per-install identity resolver MUST NOT be reached on the widget path.
const resolveContentEditorIdentityForInstance = vi.fn();
vi.mock("@/lib/content-editor-run-identity", () => ({
  resolveContentEditorIdentityForInstance: (...a: unknown[]) =>
    resolveContentEditorIdentityForInstance(...a),
}));

// --- the trusted widget-frame reader + membership re-check (host seams) -------
let frameActor: { delegation: "public_site_widget"; runBy: string; orgId: string; instanceId: string } | null =
  null;
vi.mock("@/lib/widget-actor-frame", () => ({
  resolveWidgetActorFromFrame: () => frameActor,
}));
const resolveOrgRoleForUser = vi.fn<(orgId: string, userId: string) => Promise<string | undefined>>();
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: (orgId: string, userId: string) => resolveOrgRoleForUser(orgId, userId),
}));

import { dispatchContentEditorViaA2A } from "@/lib/host-content-editor-dispatch";

const OVERRIDE = {
  runBy: "user-77",
  orgId: "org-9",
  instanceId: "site-1",
  sourceType: "public_site_widget" as const,
};

function lastRunInput(): { runBy?: string; orgId?: string; sourceType?: string } {
  return (createAgentRun.mock.calls.at(-1)?.[0] ?? {}) as {
    runBy?: string;
    orgId?: string;
    sourceType?: string;
  };
}
function lastSentText(): string {
  const call = sendTask.mock.calls.at(-1)?.[0] as {
    message: { parts: Array<{ kind: string; text: string }> };
  };
  return call.message.parts[0].text;
}

beforeEach(() => {
  vi.clearAllMocks();
  frameActor = null;
  buildA2aBearerToken.mockResolvedValue("bearer-token");
  createExternalA2AClient.mockResolvedValue({ sendTask });
  readAgentTemplateByPackageName.mockResolvedValue({ id: "tmpl_wp" });
  readLatestAgentVersionIdForTemplate.mockResolvedValue("ver_1");
  createAgentRun.mockImplementation(async (input: { id: string }) => ({ id: input.id, inputParams: {} }));
  sendTask.mockResolvedValue({
    history: [{ role: "agent", parts: [{ kind: "text", text: '{"postId":"7"}' }] }],
  });
  resolveOrgRoleForUser.mockResolvedValue("member");
});
afterEach(() => vi.clearAllMocks());

describe("host content-editor dispatch — S5 delegated-widget", () => {
  it("ATOMICITY: widget frame present + NO actorOverride → fail loud, no run", async () => {
    frameActor = { delegation: "public_site_widget", runBy: "user-77", orgId: "org-9", instanceId: "site-1" };
    await expect(
      dispatchContentEditorViaA2A({
        agentUrl: "http://agent",
        payload: { instanceId: "site-1" },
        timeoutMs: 1000,
        packageName: "@cinatra-ai/wordpress-agent",
        // NO actorOverride — the parity gap.
      }),
    ).rejects.toThrow(/public_site_widget delegation is active/);
    expect(createAgentRun).not.toHaveBeenCalled();
    expect(resolveContentEditorIdentityForInstance).not.toHaveBeenCalled();
  });

  it("ATOMICITY: override that does NOT match the frame actor → fail loud, no run", async () => {
    frameActor = { delegation: "public_site_widget", runBy: "user-77", orgId: "org-9", instanceId: "site-1" };
    await expect(
      dispatchContentEditorViaA2A({
        agentUrl: "http://agent",
        payload: { instanceId: "site-1" },
        timeoutMs: 1000,
        packageName: "@cinatra-ai/wordpress-agent",
        // orgId differs from the trusted frame actor.
        actorOverride: { ...OVERRIDE, orgId: "org-EVIL" },
        preCreateAuthorize: async () => true,
      }),
    ).rejects.toThrow(/does not match the server-verified/);
    expect(createAgentRun).not.toHaveBeenCalled();
  });

  it("forwards actorOverride VERBATIM into the carrier run + injects cinatra_run_id (G1/G4)", async () => {
    frameActor = { delegation: "public_site_widget", runBy: "user-77", orgId: "org-9", instanceId: "site-1" };
    await dispatchContentEditorViaA2A({
      agentUrl: "http://agent",
      payload: { instanceId: "site-1", postId: 7 },
      timeoutMs: 1000,
      packageName: "@cinatra-ai/wordpress-agent",
      actorOverride: OVERRIDE,
      preCreateAuthorize: async () => true,
    });
    const run = lastRunInput();
    expect(run.runBy).toBe("user-77");
    expect(run.orgId).toBe("org-9");
    expect(run.sourceType).toBe("public_site_widget");
    expect(lastSentText()).toContain("cinatra_run_id");
    // NEVER the install/single-tenant resolver on the widget path (no downgrade).
    expect(resolveContentEditorIdentityForInstance).not.toHaveBeenCalled();
  });

  it("G11 default re-assert: absent caller hook, a LIVE member proceeds", async () => {
    frameActor = { delegation: "public_site_widget", runBy: "user-77", orgId: "org-9", instanceId: "site-1" };
    resolveOrgRoleForUser.mockResolvedValue("org_admin");
    await dispatchContentEditorViaA2A({
      agentUrl: "http://agent",
      payload: { instanceId: "site-1" },
      timeoutMs: 1000,
      packageName: "@cinatra-ai/wordpress-agent",
      actorOverride: OVERRIDE,
      // no preCreateAuthorize — the host default membership re-check applies.
    });
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith("org-9", "user-77");
    expect(createAgentRun).toHaveBeenCalledTimes(1);
  });

  it("G11 default re-assert: absent caller hook, a REVOKED member → refused, no run", async () => {
    frameActor = { delegation: "public_site_widget", runBy: "user-77", orgId: "org-9", instanceId: "site-1" };
    resolveOrgRoleForUser.mockResolvedValue(undefined); // no membership row
    await expect(
      dispatchContentEditorViaA2A({
        agentUrl: "http://agent",
        payload: { instanceId: "site-1" },
        timeoutMs: 1000,
        packageName: "@cinatra-ai/wordpress-agent",
        actorOverride: OVERRIDE,
      }),
    ).rejects.toThrow();
    expect(createAgentRun).not.toHaveBeenCalled();
  });

  it("no widget frame + no override → normal path (guard inert, install identity)", async () => {
    frameActor = null;
    resolveContentEditorIdentityForInstance.mockResolvedValue({ orgId: "org_1", runBy: "u_admin" });
    await dispatchContentEditorViaA2A({
      agentUrl: "http://agent",
      payload: { instanceId: "site-1" },
      timeoutMs: 1000,
      packageName: "@cinatra-ai/wordpress-agent",
    });
    expect(resolveContentEditorIdentityForInstance).toHaveBeenCalledTimes(1);
    expect(lastRunInput().sourceType).toBe("content_editor_dispatch");
  });
});
