import { describe, it, expect } from "vitest";
import { createWorkflowPrimitiveHandlers } from "../mcp/handlers";

const handlers = createWorkflowPrimitiveHandlers();
const req = (input: unknown, actor: Record<string, unknown> = {}) => ({
  primitiveName: "x",
  input: input as Record<string, unknown>,
  actor,
  mode: "agentic",
});
const emptySpec = { name: "x", tasks: [] };

describe("proposal-only tool surface", () => {
  it("exposes only proposal/read tools — never start/approve/reject", () => {
    const names = Object.keys(handlers);
    expect(names).not.toContain("workflow_start");
    expect(names).not.toContain("workflow_approve");
    expect(names).not.toContain("workflow_reject");
    expect(names).toContain("workflow_draft_create");
    expect(names).toContain("workflow_draft_update");
    expect(names).toContain("workflow_preview");
    expect(names).toContain("workflow_template_instantiate");
  });
});

describe("handler guards (no DB hit on the error paths)", () => {
  it("draft_create requires an active org", async () => {
    const r = (await handlers.workflow_draft_create(req({ spec: emptySpec }, {}))) as { error?: string };
    expect(r.error).toMatch(/organization/i);
  });

  it("draft_create fails closed on an invalid spec", async () => {
    const r = (await handlers.workflow_draft_create(
      req({ spec: emptySpec }, { orgId: "o", userId: "u" }),
    )) as { error?: string; validation?: { errors?: unknown[] } };
    expect(r.error).toBeTruthy();
    expect(r.validation?.errors?.length).toBeGreaterThan(0);
  });

  it("draft_create rejects a trigger-bundling spec (D14, fail-closed)", async () => {
    const spec = {
      name: "R",
      target: { at: "2026-06-01T00:00:00Z", tz: "UTC" },
      tasks: [{ key: "a", type: "agent_task", title: "A", agentRef: { package: "@cinatra-ai/trigger" } }],
    };
    const r = (await handlers.workflow_draft_create(
      req({ spec }, { orgId: "o", userId: "u" }),
    )) as { error?: string; validation?: { errors?: { code?: string }[] } };
    expect(r.error).toBeTruthy();
    expect(r.validation?.errors?.some((e) => e.code === "TRIGGER_BUNDLING")).toBe(true);
  });

  it("draft_update requires workflowId + expectedLockVersion", async () => {
    const r = (await handlers.workflow_draft_update(req({}, { orgId: "o" }))) as { error?: string };
    expect(r.error).toMatch(/required/i);
  });

  it("validate returns tiered results without persistence", async () => {
    const r = (await handlers.workflow_validate(req({ spec: emptySpec }, {}))) as {
      template: { ok: boolean };
    };
    expect(r.template.ok).toBe(false);
  });

  it("preview fails closed on an invalid spec", async () => {
    const r = (await handlers.workflow_preview(req({ spec: emptySpec }, {}))) as { error?: string };
    expect(r.error).toBeTruthy();
  });
});
