// Extension-origin workflow templates are gated by the uniform
// extension-access model on list/get/instantiate via the host-injected
// assertExtensionAccess dep. Operator-authored templates (no origin.package)
// are NOT gated by it.

import { describe, it, expect, vi } from "vitest";

const orgTemplate = (over: Record<string, unknown> = {}) => ({
  id: "tmpl-ext",
  key: "k",
  version: 1,
  name: "Ext Template",
  definition: { name: "Ext Template", tasks: [], placeholders: {} },
  origin: { source: "marketplace", package: "@cinatra-ai/demo-workflow" },
  ownerLevel: "organization",
  ownerId: "o",
  orgId: "o",
  projectId: null,
  ...over,
});

vi.mock("../store", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    readWorkflowTemplate: vi.fn(async () => orgTemplate()),
    listWorkflowTemplates: vi.fn(async () => [
      orgTemplate(),
      orgTemplate({ id: "tmpl-op", origin: null, name: "Operator Template" }),
    ]),
  };
});

import { createWorkflowPrimitiveHandlers } from "../mcp/handlers";

const actor = { orgId: "o", userId: "u", orgRole: "member" };
const req = (input: unknown) => ({
  primitiveName: "x",
  input: input as Record<string, unknown>,
  actor,
  mode: "agentic" as const,
});

describe("workflow extension-access gate (deny)", () => {
  const denyDeps = {
    assertExtensionAccess: async () => {
      throw new Error("denied");
    },
  };
  const handlers = createWorkflowPrimitiveHandlers(denyDeps);

  it("instantiate of an extension-origin template is FORBIDDEN", async () => {
    const r = (await handlers.workflow_template_instantiate(
      req({ templateId: "tmpl-ext" }),
    )) as { error?: string; code?: string };
    expect(r.code).toBe("FORBIDDEN");
  });

  it("get of an extension-origin template is hidden NOT_FOUND", async () => {
    const r = (await handlers.workflow_template_get(
      req({ templateId: "tmpl-ext" }),
    )) as { error?: string; code?: string };
    expect(r.code).toBe("NOT_FOUND");
  });

  it("list drops the extension-origin template but keeps the operator one", async () => {
    const r = (await handlers.workflow_template_list(req({}))) as {
      templates: Array<{ id: string }>;
    };
    const ids = r.templates.map((t) => t.id);
    expect(ids).toContain("tmpl-op");
    expect(ids).not.toContain("tmpl-ext");
  });
});

describe("workflow extension-access gate (allow)", () => {
  const allowDeps = { assertExtensionAccess: async () => undefined };
  const handlers = createWorkflowPrimitiveHandlers(allowDeps);

  it("get of an extension-origin template is allowed when the dep resolves", async () => {
    const r = (await handlers.workflow_template_get(
      req({ templateId: "tmpl-ext" }),
    )) as { id?: string; code?: string };
    expect(r.id).toBe("tmpl-ext");
  });

  it("list keeps the extension-origin template when allowed", async () => {
    const r = (await handlers.workflow_template_list(req({}))) as {
      templates: Array<{ id: string }>;
    };
    expect(r.templates.map((t) => t.id)).toContain("tmpl-ext");
  });
});
