import { describe, it, expect, vi } from "vitest";
import {
  buildWorkflowResourceRef,
  isReadable,
  filterReadable,
  canManage,
  assertWorkflowProjectWritable,
  buildExecutionActor,
  buildChildRunProvenance,
  type ScopedRow,
  type WorkflowActor,
} from "../scope";
import {
  lintWorkflowSpecForTriggerBundling,
  lintManifestForTriggerBundling,
} from "../lint/trigger-bundling";
import type { WorkflowSpec } from "../spec/schema";

const actor = (over: Partial<WorkflowActor> = {}): WorkflowActor => ({
  organizationId: "org-1",
  userId: "user-1",
  teamIds: ["team-a"],
  ...over,
});

describe("read-visibility (cross-tenant safety)", () => {
  it("never reveals a row from another org", () => {
    const row: ScopedRow = { orgId: "org-2", ownerLevel: "organization" };
    expect(isReadable(row, actor())).toBe(false);
  });

  it("org/workspace rows are visible to members of the matching org", () => {
    expect(isReadable({ orgId: "org-1", ownerLevel: "organization" }, actor())).toBe(true);
    expect(isReadable({ orgId: "org-1", ownerLevel: "workspace" }, actor())).toBe(true);
  });

  it("team rows require team membership", () => {
    expect(isReadable({ orgId: "org-1", ownerLevel: "team", ownerId: "team-a" }, actor())).toBe(true);
    expect(isReadable({ orgId: "org-1", ownerLevel: "team", ownerId: "team-z" }, actor())).toBe(false);
  });

  it("user rows require ownership", () => {
    expect(isReadable({ orgId: "org-1", ownerLevel: "user", ownerId: "user-1" }, actor())).toBe(true);
    expect(isReadable({ orgId: "org-1", ownerLevel: "user", ownerId: "user-2" }, actor())).toBe(false);
  });

  it("platform_admin bypasses tenant scoping", () => {
    const admin = actor({ organizationId: null, platformRole: "platform_admin" });
    expect(isReadable({ orgId: "org-9", ownerLevel: "user", ownerId: "x" }, admin)).toBe(true);
  });

  it("project-scoped rows require a project-access grant (fail-closed)", () => {
    const row = { orgId: "org-1", ownerLevel: "organization", projectId: "proj-x" };
    expect(isReadable(row, actor())).toBe(false); // org member but no project grant
    expect(isReadable(row, actor({ projectIds: ["proj-x"] }))).toBe(true);
    expect(isReadable(row, actor({ projectIds: ["proj-y"] }))).toBe(false);
  });

  it("filterReadable keeps only visible rows", () => {
    const rows: ScopedRow[] = [
      { orgId: "org-1", ownerLevel: "organization" },
      { orgId: "org-2", ownerLevel: "organization" },
      { orgId: "org-1", ownerLevel: "user", ownerId: "user-2" },
    ];
    expect(filterReadable(rows, actor())).toHaveLength(1);
  });
});

describe("resource ref + project gate", () => {
  it("builds a resource ref from a row", () => {
    expect(
      buildWorkflowResourceRef({
        orgId: "org-1",
        ownerLevel: "team",
        ownerId: "team-a",
        projectId: "proj-1",
      }),
    ).toEqual({ level: "team", ownerId: "team-a", organizationId: "org-1", projectId: "proj-1" });
  });

  it("calls the injected archive gate only when project-scoped", async () => {
    const assertProjectWritable = vi.fn();
    await assertWorkflowProjectWritable({ assertProjectWritable }, { orgId: "o", projectId: "proj-1" });
    expect(assertProjectWritable).toHaveBeenCalledWith("proj-1");
    assertProjectWritable.mockClear();
    await assertWorkflowProjectWritable({ assertProjectWritable }, { orgId: "o", projectId: null });
    expect(assertProjectWritable).not.toHaveBeenCalled();
  });
});

describe("execution actor (provenance, never anonymous)", () => {
  it("derives the delegated actor + child run provenance from the workflow", () => {
    const wf = { id: "wf-1", orgId: "org-1", projectId: "proj-1", createdBy: "user-7" };
    const ea = buildExecutionActor(wf);
    expect(ea).toEqual({
      orgId: "org-1",
      projectId: "proj-1",
      runBy: "user-7",
      source: "workflow-reconciler",
      workflowId: "wf-1",
    });
    expect(buildChildRunProvenance(ea, "task-3")).toMatchObject({
      orgId: "org-1",
      runBy: "user-7",
      workflowId: "wf-1",
      workflowTaskId: "task-3",
      source: "workflow-reconciler",
    });
  });
});

describe("trigger-bundling lint", () => {
  const clean: WorkflowSpec = {
    name: "R",
    tasks: [{ key: "a", type: "agent_task", title: "A", agentRef: { package: "@cinatra-ai/asset-blog" } }],
  } as WorkflowSpec;

  it("passes a clean spec", () => {
    expect(lintWorkflowSpecForTriggerBundling(clean)).toEqual([]);
  });

  it("flags an agent_task dispatching the trigger-agent", () => {
    const spec = {
      name: "R",
      tasks: [{ key: "a", type: "agent_task", title: "A", agentRef: { package: "@cinatra-ai/trigger" } }],
    } as WorkflowSpec;
    expect(lintWorkflowSpecForTriggerBundling(spec).map((f) => f.code)).toContain("TRIGGER_BUNDLING");
  });

  it("flags trigger config passed via agent input", () => {
    const spec = {
      name: "R",
      tasks: [
        {
          key: "a",
          type: "agent_task",
          title: "A",
          agentRef: { package: "p" },
          input: { triggerConfig: { cron: "* * * * *" } },
        },
      ],
    } as WorkflowSpec;
    expect(lintWorkflowSpecForTriggerBundling(spec).map((f) => f.path)).toContain("tasks[0].input.triggerConfig");
  });

  it("flags a manifest that bundles the trigger-agent dependency", () => {
    const findings = lintManifestForTriggerBundling({
      name: "@x/some-agent",
      dependencies: { "@cinatra-ai/trigger": "workspace:*", "date-fns": "^4" },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBe("dependencies.@cinatra-ai/trigger");
  });
});

describe("manage-authorization (canManage)", () => {
  const cases: Array<{ name: string; row: ScopedRow; actor: WorkflowActor; expected: boolean }> = [
    {
      name: "platform_admin bypasses tenant scoping (cross-org org-owned row)",
      row: { orgId: "org-9", ownerLevel: "organization" },
      actor: actor({ organizationId: null, platformRole: "platform_admin" }),
      expected: true,
    },
    {
      name: "cross-org row is never manageable, even by an org_admin of another org",
      row: { orgId: "org-2", ownerLevel: "organization" },
      actor: actor({ orgRole: "org_admin" }),
      expected: false,
    },
    {
      name: "org-owned row: org_admin can manage",
      row: { orgId: "org-1", ownerLevel: "organization" },
      actor: actor({ orgRole: "org_admin" }),
      expected: true,
    },
    {
      name: "org-owned row: org_owner can manage",
      row: { orgId: "org-1", ownerLevel: "organization" },
      actor: actor({ orgRole: "org_owner" }),
      expected: true,
    },
    {
      name: "org-owned row: a same-org non-admin member cannot manage",
      row: { orgId: "org-1", ownerLevel: "organization" },
      actor: actor(),
      expected: false,
    },
    {
      name: "workspace-owned row follows the same org_admin/org_owner rule",
      row: { orgId: "org-1", ownerLevel: "workspace" },
      actor: actor({ orgRole: "org_owner" }),
      expected: true,
    },
    {
      name: "user-owned row: only the owner can manage",
      row: { orgId: "org-1", ownerLevel: "user", ownerId: "user-1" },
      actor: actor(),
      expected: true,
    },
    {
      name: "user-owned row: a different same-org user cannot manage",
      row: { orgId: "org-1", ownerLevel: "user", ownerId: "user-2" },
      actor: actor(),
      expected: false,
    },
    {
      name: "team-owned row: a team member can manage",
      row: { orgId: "org-1", ownerLevel: "team", ownerId: "team-a" },
      actor: actor(),
      expected: true,
    },
    {
      name: "team-owned row: a non-member cannot manage (org_admin does not grant team rows)",
      row: { orgId: "org-1", ownerLevel: "team", ownerId: "team-z" },
      actor: actor({ orgRole: "org_admin" }),
      expected: false,
    },
    {
      name: "project-scoped row requires a project grant to manage",
      row: { orgId: "org-1", ownerLevel: "organization", projectId: "proj-x" },
      actor: actor({ orgRole: "org_admin" }),
      expected: false,
    },
    {
      name: "project-scoped row is manageable with the grant + org_admin",
      row: { orgId: "org-1", ownerLevel: "organization", projectId: "proj-x" },
      actor: actor({ orgRole: "org_admin", projectIds: ["proj-x"] }),
      expected: true,
    },
    {
      name: "unset ownership level fails closed unless org_admin",
      row: { orgId: "org-1" },
      actor: actor(),
      expected: false,
    },
  ];

  it.each(cases)("$name", ({ row, actor: a, expected }) => {
    expect(canManage(row, a)).toBe(expected);
  });
});
