/**
 * cinatra#2653 — the admin approval (publish) path for an uploaded draft
 * agent template, served from /configuration/extensions.
 *
 * What is pinned here:
 *
 *   1. the action delegates to the ONE transactional store operation
 *      `publishAgentTemplateAndBindVersion` (status flip + version binding
 *      commit atomically — the CodeRabbit major on the previous two-step
 *      shape), and success ends in `redirect("/configuration/extensions")`;
 *   2. an already-published template is allowed through as the REPAIR path
 *      (the atomic op re-points a missing `current_version_id`), never a
 *      masked no-op;
 *   3. an assistant-kind template is refused BEFORE any write;
 *   4. refusals are RETURNED, never thrown (a thrown server-action error is
 *      masked in a production build);
 *   5. the admin gate runs before any read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdminSession = vi.fn();
const readAgentTemplateById = vi.fn();
const publishAgentTemplateAndBindVersion = vi.fn();
const logAuditEvent = vi.fn();
const redirect = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: (...a: unknown[]) => requireAdminSession(...a),
}));
vi.mock("@/lib/authz", () => ({
  logAuditEvent: (...a: unknown[]) => logAuditEvent(...a),
}));
vi.mock("@/lib/authz/actor-context", () => ({
  POLICY_VERSION: "test-policy",
}));
vi.mock("next/navigation", () => ({
  redirect: (...a: unknown[]) => {
    redirect(...a);
    // Mirror the real redirect(): it THROWS, ending the action.
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT" });
  },
}));
vi.mock("../store", () => ({
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  publishAgentTemplateAndBindVersion: (...a: unknown[]) =>
    publishAgentTemplateAndBindVersion(...a),
}));

import { publishAgentTemplateFormAction } from "../publish-template-action";

const draftTemplate = {
  id: "tpl-1",
  orgId: "org-1",
  status: "draft",
  agentKind: "executor",
  name: "Everyday AI Blog Drafter",
};

const publishedResult = {
  record: {
    ...draftTemplate,
    status: "published",
    currentVersionId: "ver-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  version: { id: "ver-1", semver: "1.0.0" },
};

async function runAction(templateId: string) {
  try {
    return await publishAgentTemplateFormAction({ templateId });
  } catch (err) {
    if ((err as { digest?: string }).digest === "NEXT_REDIRECT") return "redirected";
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminSession.mockResolvedValue({ user: { id: "admin-1" } });
  readAgentTemplateById.mockResolvedValue({ ...draftTemplate });
  publishAgentTemplateAndBindVersion.mockResolvedValue(publishedResult);
});

describe("publishAgentTemplateFormAction (cinatra#2653)", () => {
  it("publishes a draft through the ONE atomic store op, then redirects to /configuration/extensions", async () => {
    const outcome = await runAction("tpl-1");
    expect(outcome).toBe("redirected");
    expect(publishAgentTemplateAndBindVersion).toHaveBeenCalledTimes(1);
    expect(publishAgentTemplateAndBindVersion).toHaveBeenCalledWith("tpl-1", {
      createdBy: "admin-1",
    });
    expect(redirect).toHaveBeenCalledWith("/configuration/extensions");
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "agent_template",
        resourceId: "tpl-1",
        operation: "update",
        decision: "allowed",
        metadata: expect.objectContaining({ boundVersionId: "ver-1" }),
      }),
    );
  });

  it("is admin-gated before any read", async () => {
    await runAction("tpl-1");
    expect(requireAdminSession).toHaveBeenCalledTimes(1);
    expect(requireAdminSession.mock.invocationCallOrder[0]).toBeLessThan(
      readAgentTemplateById.mock.invocationCallOrder[0],
    );
  });

  it("allows an already-published template through as the repair path", async () => {
    readAgentTemplateById.mockResolvedValue({ ...draftTemplate, status: "published" });
    const outcome = await runAction("tpl-1");
    expect(outcome).toBe("redirected");
    expect(publishAgentTemplateAndBindVersion).toHaveBeenCalledTimes(1);
  });

  it("refuses an assistant-kind template before any write", async () => {
    readAgentTemplateById.mockResolvedValue({ ...draftTemplate, agentKind: "assistant" });
    const outcome = await runAction("tpl-1");
    expect(outcome).toEqual({ ok: false, error: "An assistant cannot be published." });
    expect(publishAgentTemplateAndBindVersion).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("refuses an archived template", async () => {
    readAgentTemplateById.mockResolvedValue({ ...draftTemplate, status: "archived" });
    const outcome = await runAction("tpl-1");
    expect(outcome).toEqual({
      ok: false,
      error: "Only a draft can be published (current status: archived).",
    });
    expect(publishAgentTemplateAndBindVersion).not.toHaveBeenCalled();
  });

  it("returns (never throws) the refusal when the atomic op refuses", async () => {
    publishAgentTemplateAndBindVersion.mockResolvedValue(null);
    const outcome = await runAction("tpl-1");
    expect(outcome).toEqual({ ok: false, error: "Publish was refused for this template." });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("errors on a missing template", async () => {
    readAgentTemplateById.mockResolvedValue(null);
    const outcome = await runAction("tpl-1");
    expect(outcome).toEqual({ ok: false, error: "Agent template not found." });
  });
});
