/**
 * workflow_template_instantiate required-placeholder enforcement. The handler
 * MUST reject with a structured `placeholder_required` code BEFORE materializing
 * the spec or creating any DB row, naming every missing key. UI gating alone is
 * insufficient — direct callers / agents can omit fields and a partial fill
 * would land tasks with literal "{{x}}" text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowSpec } from "../spec/schema";

const h = vi.hoisted(() => ({
  readTemplateSpy: vi.fn(),
  createFromSpecSpy: vi.fn(async () => ({ workflowId: "wf-new" })),
}));

vi.mock("../store", async () => {
  const actual = await vi.importActual<typeof import("../store")>("../store");
  return {
    ...actual,
    readWorkflowTemplate: h.readTemplateSpy,
    createWorkflowFromSpec: h.createFromSpecSpy,
  };
});

import { createWorkflowPrimitiveHandlers } from "../mcp/handlers";

const definition: WorkflowSpec = {
  name: "Blog publish for {{postId}}",
  target: { at: "2026-06-01T00:00:00Z", tz: "UTC" },
  placeholders: {
    projectId: { type: "string", required: true },
    postId: { type: "string", required: true },
    wordpressInstanceId: { type: "string", required: true },
    notes: { type: "string", required: false },
  },
  tasks: [{ key: "a", type: "checkpoint", title: "Review {{postId}}" }],
};

const handlers = createWorkflowPrimitiveHandlers({
  approverResolvable: () => true,
});
const req = (input: unknown) => ({
  primitiveName: "workflow_template_instantiate",
  input: input as Record<string, unknown>,
  actor: { orgId: "org-1", userId: "u-1" },
  mode: "agentic" as const,
});

beforeEach(() => {
  h.readTemplateSpy.mockReset();
  h.createFromSpecSpy.mockClear();
  h.readTemplateSpy.mockResolvedValue({
    id: "tmpl-1",
    key: "blog-content-workflow",
    version: 1,
    name: "Blog Publish",
    orgId: "org-1",
    ownerLevel: "organization",
    ownerId: "org-1",
    visibility: "organization",
    definition,
  });
});

describe("BCW-02 workflow_template_instantiate — required placeholders", () => {
  it("rejects with placeholder_required + missing[] when ALL required placeholders are absent", async () => {
    const res = (await handlers.workflow_template_instantiate(req({ templateId: "tmpl-1" }))) as Record<string, unknown>;
    expect(res.code).toBe("placeholder_required");
    expect(res.missing).toEqual(["projectId", "postId", "wordpressInstanceId"]);
    expect(h.createFromSpecSpy).not.toHaveBeenCalled();
  });

  it("rejects when SOME required placeholders are missing, naming exactly the missing ones", async () => {
    const res = (await handlers.workflow_template_instantiate(
      req({ templateId: "tmpl-1", inputs: { projectId: "p", postId: "po" } }),
    )) as Record<string, unknown>;
    expect(res.code).toBe("placeholder_required");
    expect(res.missing).toEqual(["wordpressInstanceId"]);
    expect(h.createFromSpecSpy).not.toHaveBeenCalled();
  });

  it("treats whitespace-only string values as missing", async () => {
    const res = (await handlers.workflow_template_instantiate(
      req({ templateId: "tmpl-1", inputs: { projectId: "p", postId: "po", wordpressInstanceId: "   " } }),
    )) as Record<string, unknown>;
    expect(res.code).toBe("placeholder_required");
    expect(res.missing).toEqual(["wordpressInstanceId"]);
    expect(h.createFromSpecSpy).not.toHaveBeenCalled();
  });

  it("OMITTED optional placeholder does NOT block instantiate", async () => {
    const res = (await handlers.workflow_template_instantiate(
      req({ templateId: "tmpl-1", inputs: { projectId: "p", postId: "po", wordpressInstanceId: "wp" } }),
    )) as Record<string, unknown>;
    expect(res.code).not.toBe("placeholder_required");
    expect(h.createFromSpecSpy).toHaveBeenCalledTimes(1);
  });
});
