// The workflow kind declares optional-missing as "fail-instantiate"
// (optionalMissingBehaviorForKind), enforced on the instantiate boundary via
// the host-injected assertTemplateSourceDependencyClosure dep: a source
// extension with a broken/incomplete dependency closure refuses to
// instantiate (code DEPENDENCY_CLOSURE) BEFORE any DB write. Absent dep =>
// extension-origin templates are not additionally gated (tests / non-host
// callers), same posture as assertExtensionAccess.

import { describe, it, expect, vi } from "vitest";

const extTemplate = (over: Record<string, unknown> = {}) => ({
  id: "tmpl-ext",
  key: "k",
  version: 1,
  name: "Ext Template",
  // A required placeholder makes "the gate passed" observable without any DB
  // write: the very next check after the closure gate (+ projectId gate)
  // returns code "placeholder_required".
  definition: {
    name: "Ext Template",
    tasks: [],
    placeholders: { release: { required: true } },
  },
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
    readWorkflowTemplate: vi.fn(async () => extTemplate()),
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

describe("workflow_template_instantiate dependency-closure gate", () => {
  it("refuses instantiate with DEPENDENCY_CLOSURE when the injected closure dep throws", async () => {
    const handlers = createWorkflowPrimitiveHandlers({
      assertTemplateSourceDependencyClosure: async () => {
        throw new Error(
          "Cannot instantiate: @cinatra-ai/demo-workflow has missing/archived optional dependencies",
        );
      },
    });
    const r = (await handlers.workflow_template_instantiate(
      req({ templateId: "tmpl-ext" }),
    )) as { error?: string; code?: string };
    expect(r.code).toBe("DEPENDENCY_CLOSURE");
    expect(r.error).toContain("missing/archived optional dependencies");
  });

  it("passes the actor + the template's source package to the dep", async () => {
    const seen: unknown[] = [];
    const handlers = createWorkflowPrimitiveHandlers({
      assertTemplateSourceDependencyClosure: async (a, pkg) => {
        seen.push([a, pkg]);
      },
    });
    await handlers.workflow_template_instantiate(req({ templateId: "tmpl-ext" }));
    expect(seen).toHaveLength(1);
    const [a, pkg] = seen[0] as [Record<string, unknown>, string];
    expect(pkg).toBe("@cinatra-ai/demo-workflow");
    expect(a.orgId).toBe("o");
    expect(a.userId).toBe("u");
  });

  it("proceeds past the gate when the dep resolves (next gate fires instead)", async () => {
    const handlers = createWorkflowPrimitiveHandlers({
      assertTemplateSourceDependencyClosure: async () => undefined,
    });
    const r = (await handlers.workflow_template_instantiate(
      req({ templateId: "tmpl-ext" }),
    )) as { error?: string; code?: string };
    expect(r.code).toBe("placeholder_required");
  });

  it("absent dep => extension-origin templates are NOT additionally gated", async () => {
    const handlers = createWorkflowPrimitiveHandlers({});
    const r = (await handlers.workflow_template_instantiate(
      req({ templateId: "tmpl-ext" }),
    )) as { error?: string; code?: string };
    expect(r.code).toBe("placeholder_required");
  });
});
