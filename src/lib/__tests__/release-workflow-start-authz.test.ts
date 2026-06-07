import { describe, it, expect, vi, beforeEach } from "vitest";

// Start-time and instantiation re-auth probes the host injects into
// the release-workflows engine. `resolveWorkflowApprovers` / `approverResolvable`
// resolve an approval scope to concrete users; `workflowAgentRefAvailable`
// reuses the agent_task executor's template resolution + cross-org tenancy gate.

// The agent probe's module imports the agents store + the enqueue chokepoint at
// top level; mock both so the leaf re-auth logic is exercised in isolation.
const readAgentTemplateById = vi.fn();
const readAgentTemplateByPackageName = vi.fn();
vi.mock("@cinatra-ai/agents", () => ({
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  readAgentTemplateByPackageName: (...a: unknown[]) => readAgentTemplateByPackageName(...a),
  createAgentRun: vi.fn(),
  readAgentRunById: vi.fn(),
  readAgentVersionsByTemplate: vi.fn(),
  TERMINAL_RUN_STATUSES: [],
}));
vi.mock("@/lib/agent-run-enqueue", () => ({ enqueueAgentRun: vi.fn() }));

// Approver resolution hits public.member / public."teamMember" / public."user"
// via betterAuthDb.execute(sql) — mock it to return controlled rows.
const dbExecute = vi.fn();
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { execute: (...a: unknown[]) => dbExecute(...a) },
}));

import { resolveWorkflowApprovers, approverResolvable } from "@/lib/workflow-approvers";
import { workflowAgentRefAvailable } from "@/lib/workflow-agent-executor";

describe("resolveWorkflowApprovers", () => {
  beforeEach(() => dbExecute.mockReset());

  it("user scope → the named user IF a member of the workflow org", async () => {
    dbExecute.mockResolvedValue({ rows: [{ userId: "u1" }] });
    expect(await resolveWorkflowApprovers({ level: "user", id: "u1" }, "org-1")).toEqual(["u1"]);
  });

  it("user scope → empty if the named user is NOT in the workflow org (cross-tenant guard)", async () => {
    dbExecute.mockResolvedValue({ rows: [] });
    expect(await resolveWorkflowApprovers({ level: "user", id: "userB" }, "org-1")).toEqual([]);
  });

  it("user scope without id → empty, no DB hit", async () => {
    expect(await resolveWorkflowApprovers({ level: "user" }, "org-1")).toEqual([]);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it("team scope → distinct members of a team that belongs to the workflow org", async () => {
    dbExecute.mockResolvedValue({ rows: [{ userId: "a" }, { userId: "b" }, { userId: "a" }] });
    expect(await resolveWorkflowApprovers({ level: "team", id: "t1" }, "org-1")).toEqual(["a", "b"]);
  });

  it("organization scope → empty for a FOREIGN org id (cross-tenant guard)", async () => {
    expect(await resolveWorkflowApprovers({ level: "organization", id: "org-OTHER" }, "org-1")).toEqual([]);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it("organization scope → owners/admins (id falls back to orgId), single query", async () => {
    dbExecute.mockResolvedValue({ rows: [{ userId: "owner" }, { userId: "admin" }] });
    expect(await resolveWorkflowApprovers({ level: "organization" }, "org-1")).toEqual(["owner", "admin"]);
    expect(dbExecute).toHaveBeenCalledTimes(1);
  });

  it("organization scope → falls back to all members when no owner/admin", async () => {
    dbExecute
      .mockResolvedValueOnce({ rows: [] }) // owner/admin query: none
      .mockResolvedValueOnce({ rows: [{ userId: "m1" }, { userId: "m2" }] }); // all members
    expect(await resolveWorkflowApprovers({ level: "organization", id: "org-1" }, "org-1")).toEqual(["m1", "m2"]);
    expect(dbExecute).toHaveBeenCalledTimes(2);
  });

  it("workspace scope → platform admins", async () => {
    dbExecute.mockResolvedValue({ rows: [{ id: "pa1" }] });
    expect(await resolveWorkflowApprovers({ level: "workspace" }, "org-1")).toEqual(["pa1"]);
  });

  it("unknown / null scope → empty", async () => {
    expect(await resolveWorkflowApprovers({ level: "galaxy" }, "org-1")).toEqual([]);
    expect(await resolveWorkflowApprovers(null, "org-1")).toEqual([]);
  });
});

describe("approverResolvable (resolution-backed)", () => {
  beforeEach(() => dbExecute.mockReset());

  it("true when the scope resolves to >= 1 approver", async () => {
    dbExecute.mockResolvedValue({ rows: [{ userId: "owner" }] });
    expect(await approverResolvable({ level: "organization", id: "org-1" }, "org-1")).toBe(true);
  });

  it("false when the scope resolves to nobody", async () => {
    dbExecute.mockResolvedValue({ rows: [] });
    expect(await approverResolvable({ level: "team", id: "empty-team" }, "org-1")).toBe(false);
  });

  it("false for an unresolvable scope (user without id, no DB hit)", async () => {
    expect(await approverResolvable({ level: "user" }, "org-1")).toBe(false);
    expect(dbExecute).not.toHaveBeenCalled();
  });
});

describe("workflowAgentRefAvailable (agent re-auth)", () => {
  beforeEach(() => {
    readAgentTemplateById.mockReset();
    readAgentTemplateByPackageName.mockReset();
  });

  it("resolves by templateId and accepts a same-org template", async () => {
    readAgentTemplateById.mockResolvedValue({ id: "tpl-1", orgId: "org-1" });
    expect(await workflowAgentRefAvailable({ templateId: "tpl-1" }, "org-1")).toBe(true);
    expect(readAgentTemplateById).toHaveBeenCalledWith("tpl-1");
  });

  it("falls back to package-name resolution when no templateId", async () => {
    readAgentTemplateByPackageName.mockResolvedValue({ id: "tpl-2", orgId: "org-1" });
    expect(await workflowAgentRefAvailable({ package: "@acme/agent" }, "org-1")).toBe(true);
    expect(readAgentTemplateByPackageName).toHaveBeenCalledWith("@acme/agent");
  });

  it("accepts a null-origin (public) template in any org", async () => {
    readAgentTemplateById.mockResolvedValue({ id: "tpl-pub", orgId: null });
    expect(await workflowAgentRefAvailable({ templateId: "tpl-pub" }, "org-9")).toBe(true);
  });

  it("rejects a foreign-org template (cross-tenant gate)", async () => {
    readAgentTemplateById.mockResolvedValue({ id: "tpl-3", orgId: "org-OTHER" });
    expect(await workflowAgentRefAvailable({ templateId: "tpl-3" }, "org-1")).toBe(false);
  });

  it("rejects an unresolvable ref", async () => {
    readAgentTemplateById.mockResolvedValue(null);
    readAgentTemplateByPackageName.mockResolvedValue(null);
    expect(await workflowAgentRefAvailable({ templateId: "missing", package: "nope" }, "org-1")).toBe(false);
    expect(await workflowAgentRefAvailable({}, "org-1")).toBe(false);
  });
});
