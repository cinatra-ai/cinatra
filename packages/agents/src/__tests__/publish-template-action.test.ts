/**
 * cinatra#2653 — the UI publish path for a draft agent template.
 *
 * What is pinned here is the HONESTY of the new Publish action:
 *
 *   1. a draft publishes via `updateAgentTemplate({ status: "published" })`
 *      AND then binds a current version via
 *      `createAgentTemplateVersionIfChanged` — the import path compiles a
 *      version snapshot but never binds `current_version_id`, so a publish
 *      that skipped this step would ship a non-runnable "published" agent
 *      (the second defect confirmed on the issue);
 *   2. an assistant-kind template is refused BEFORE any write;
 *   3. an already-published template is an idempotent success (no writes);
 *   4. a zero-row update outcome (the store's atomic assistant guard, or a
 *      concurrent delete) surfaces as a refusal, not a fake success.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdminSession = vi.fn();
const readAgentTemplateById = vi.fn();
const updateAgentTemplate = vi.fn();
const createAgentTemplateVersionIfChanged = vi.fn();
const logAuditEvent = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: (...a: unknown[]) => requireAdminSession(...a),
}));
vi.mock("@/lib/authz", () => ({
  logAuditEvent: (...a: unknown[]) => logAuditEvent(...a),
}));
vi.mock("@/lib/authz/actor-context", () => ({
  POLICY_VERSION: "test-policy",
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...a: unknown[]) => revalidatePath(...a),
}));
vi.mock("../store", () => ({
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  updateAgentTemplate: (...a: unknown[]) => updateAgentTemplate(...a),
  createAgentTemplateVersionIfChanged: (...a: unknown[]) =>
    createAgentTemplateVersionIfChanged(...a),
}));

import { publishAgentTemplateAction } from "../publish-template-action";

const draftTemplate = {
  id: "tpl-1",
  orgId: "org-1",
  status: "draft",
  agentKind: "executor",
  name: "Everyday AI Blog Drafter",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminSession.mockResolvedValue({ user: { id: "admin-1" } });
  readAgentTemplateById.mockResolvedValue({ ...draftTemplate });
  updateAgentTemplate.mockResolvedValue({
    ...draftTemplate,
    status: "published",
  });
  createAgentTemplateVersionIfChanged.mockResolvedValue({
    version: { id: "ver-1" },
    created: true,
  });
});

describe("publishAgentTemplateAction (cinatra#2653)", () => {
  it("publishes a draft AND binds a current version", async () => {
    const result = await publishAgentTemplateAction("tpl-1");
    expect(result).toEqual({ ok: true, templateId: "tpl-1" });
    expect(updateAgentTemplate).toHaveBeenCalledWith("tpl-1", {
      status: "published",
    });
    // The honesty core: the version pointer is bound on publish, with the
    // acting admin recorded as creator.
    expect(createAgentTemplateVersionIfChanged).toHaveBeenCalledTimes(1);
    expect(createAgentTemplateVersionIfChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tpl-1", status: "published" }),
      { createdBy: "admin-1" },
    );
    // Version binding runs on the UPDATED record, after the status flip.
    const updateOrder = updateAgentTemplate.mock.invocationCallOrder[0];
    const bindOrder =
      createAgentTemplateVersionIfChanged.mock.invocationCallOrder[0];
    expect(bindOrder).toBeGreaterThan(updateOrder);
    expect(revalidatePath).toHaveBeenCalledWith("/agents");
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "agent_template",
        resourceId: "tpl-1",
        operation: "update",
        decision: "allowed",
      }),
    );
  });

  it("is admin-gated (requireAdminSession runs before any read)", async () => {
    await publishAgentTemplateAction("tpl-1");
    expect(requireAdminSession).toHaveBeenCalledTimes(1);
    const gateOrder = requireAdminSession.mock.invocationCallOrder[0];
    const readOrder = readAgentTemplateById.mock.invocationCallOrder[0];
    expect(gateOrder).toBeLessThan(readOrder);
  });

  it("refuses an assistant-kind template before any write", async () => {
    readAgentTemplateById.mockResolvedValue({
      ...draftTemplate,
      agentKind: "assistant",
    });
    const result = await publishAgentTemplateAction("tpl-1");
    expect(result).toEqual({
      ok: false,
      error: "An assistant cannot be published.",
    });
    expect(updateAgentTemplate).not.toHaveBeenCalled();
    expect(createAgentTemplateVersionIfChanged).not.toHaveBeenCalled();
  });

  it("treats an already-published template as an idempotent success without writes", async () => {
    readAgentTemplateById.mockResolvedValue({
      ...draftTemplate,
      status: "published",
    });
    const result = await publishAgentTemplateAction("tpl-1");
    expect(result).toEqual({ ok: true, templateId: "tpl-1" });
    expect(updateAgentTemplate).not.toHaveBeenCalled();
    expect(createAgentTemplateVersionIfChanged).not.toHaveBeenCalled();
  });

  it("refuses a non-draft, non-published status", async () => {
    readAgentTemplateById.mockResolvedValue({
      ...draftTemplate,
      status: "archived",
    });
    const result = await publishAgentTemplateAction("tpl-1");
    expect(result).toEqual({
      ok: false,
      error: "Only a draft can be published (current status: archived).",
    });
    expect(updateAgentTemplate).not.toHaveBeenCalled();
  });

  it("surfaces a zero-row update outcome as a refusal, not a success", async () => {
    updateAgentTemplate.mockResolvedValue(null);
    const result = await publishAgentTemplateAction("tpl-1");
    expect(result).toEqual({
      ok: false,
      error: "Publish was refused for this template.",
    });
    expect(createAgentTemplateVersionIfChanged).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("errors on a missing template", async () => {
    readAgentTemplateById.mockResolvedValue(null);
    const result = await publishAgentTemplateAction("tpl-1");
    expect(result).toEqual({ ok: false, error: "Agent template not found." });
  });
});
