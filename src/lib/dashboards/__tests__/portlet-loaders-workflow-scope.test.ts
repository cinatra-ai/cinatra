/**
 * PORT-10 workflow-status loader scope guard. Proves the loaders use the
 * SESSION orgId, require an org match, and never broaden a project-scoped
 * workflow to a caller lacking a project read grant (org_admin/org_owner
 * bypass).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  readWorkflowSpy: vi.fn(),
  listWorkflowsSpy: vi.fn(async () => [{ id: "wf1", name: "WF One", status: "active" }]),
  authz: {
    orgId: "sess-org" as string | null,
    primitiveActor: { actorType: "human", source: "ui", userId: "u" },
    roleHints: { orgRole: "member" } as { orgRole: string } | undefined,
    actorContext: { projectGrants: [], projectIds: [] } as { projectGrants: { projectId: string }[]; projectIds: string[] } | undefined,
  },
}));

vi.mock("@/lib/dashboards/portlet-authz", () => ({
  resolvePortletAuthz: vi.fn(async () => h.authz),
  objectResourceCheck: (row: { id: string }) => ({ resourceType: "object", resourceId: row.id }),
  canReadObject: vi.fn(async () => true),
}));
vi.mock("@/lib/objects-store", () => ({ listObjectsByFilter: vi.fn(() => []), getObjectById: vi.fn(() => null) }));
vi.mock("@/lib/artifacts/artifact-service", () => ({ listArtifacts: vi.fn(() => []), getArtifact: vi.fn(() => null) }));
vi.mock("@/lib/object-history/eligibility", () => ({ listEventsForObject: vi.fn(() => []) }));
vi.mock("@/lib/authz/enforce-resource-access", () => ({ enforceResourceAccess: vi.fn(async () => undefined) }));
vi.mock("@cinatra-ai/workflows/store", () => ({ readWorkflow: h.readWorkflowSpy, listWorkflows: h.listWorkflowsSpy }));

import { loadWorkflowStatusSingle, loadWorkflowStatusList } from "../portlet-loaders";

beforeEach(() => {
  h.readWorkflowSpy.mockReset();
  h.listWorkflowsSpy.mockClear();
  h.authz.orgId = "sess-org";
  h.authz.roleHints = { orgRole: "member" };
  h.authz.actorContext = { projectGrants: [], projectIds: [] };
});

describe("PORT-10 loadWorkflowStatusSingle", () => {
  it("returns the workflow when org matches and it has no project scope", async () => {
    h.readWorkflowSpy.mockResolvedValueOnce({ workflow: { id: "wf1", name: "WF", status: "active", orgId: "sess-org", projectId: null }, tasks: [], dependencies: [], approvals: [] });
    const out = await loadWorkflowStatusSingle({ workflowId: "wf1" });
    expect(out?.workflowId).toBe("wf1");
  });

  it("returns null when the workflow belongs to a DIFFERENT org (no cross-tenant read)", async () => {
    h.readWorkflowSpy.mockResolvedValueOnce({ workflow: { id: "wf1", name: "WF", status: "active", orgId: "other-org", projectId: null }, tasks: [], dependencies: [], approvals: [] });
    const out = await loadWorkflowStatusSingle({ workflowId: "wf1" });
    expect(out).toBeNull();
  });

  it("returns null for a project-scoped workflow when the member lacks a project grant", async () => {
    h.readWorkflowSpy.mockResolvedValueOnce({ workflow: { id: "wf1", name: "WF", status: "active", orgId: "sess-org", projectId: "proj-1" }, tasks: [], dependencies: [], approvals: [] });
    const out = await loadWorkflowStatusSingle({ workflowId: "wf1" });
    expect(out).toBeNull();
  });

  it("allows a project-scoped workflow when the actor holds a read grant", async () => {
    h.authz.actorContext = { projectGrants: [{ projectId: "proj-1" }], projectIds: ["proj-1"] };
    h.readWorkflowSpy.mockResolvedValueOnce({ workflow: { id: "wf1", name: "WF", status: "active", orgId: "sess-org", projectId: "proj-1" }, tasks: [], dependencies: [], approvals: [] });
    const out = await loadWorkflowStatusSingle({ workflowId: "wf1" });
    expect(out?.workflowId).toBe("wf1");
  });

  it("allows org_admin to read any project-scoped workflow in the org", async () => {
    h.authz.roleHints = { orgRole: "org_admin" };
    h.readWorkflowSpy.mockResolvedValueOnce({ workflow: { id: "wf1", name: "WF", status: "active", orgId: "sess-org", projectId: "proj-z" }, tasks: [], dependencies: [], approvals: [] });
    const out = await loadWorkflowStatusSingle({ workflowId: "wf1" });
    expect(out?.workflowId).toBe("wf1");
  });
});

describe("PORT-10 loadWorkflowStatusList", () => {
  it("lists with the SESSION orgId + the given projectId when the actor can read it", async () => {
    h.authz.actorContext = { projectGrants: [{ projectId: "proj-1" }], projectIds: ["proj-1"] };
    const out = await loadWorkflowStatusList({ projectId: "proj-1" });
    expect(h.listWorkflowsSpy).toHaveBeenCalledWith({ orgId: "sess-org", projectId: "proj-1" });
    expect(out.workflows).toHaveLength(1);
  });

  it("returns EMPTY (never broadens) when the member cannot read the project", async () => {
    const out = await loadWorkflowStatusList({ projectId: "proj-secret" });
    expect(out.workflows).toEqual([]);
    expect(h.listWorkflowsSpy).not.toHaveBeenCalled();
  });
});
