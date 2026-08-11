/**
 * cinatra#2653 (owner ruling on PR #2658, revised) — an admin UPLOAD goes
 * LIVE: the archive import is followed by the ONE transactional
 * publish-and-bind (`publishAgentTemplateAndBindVersion`), so the agent
 * surfaces on /agents immediately in the scope assigned at upload.
 *
 * What is pinned here:
 *
 *   1. `publishAndBind: true` (the UI upload form's contract) publishes
 *      through the ONE atomic store op, AFTER the scope policy is saved —
 *      the agent goes live already scoped;
 *   2. the flag is an UPLOAD-PATH contract: without it (the MCP ZIP import
 *      handler, programmatic callers) nothing publishes — those paths keep
 *      today's explicit-status behavior;
 *   3. the flag never reaches `importAgentTemplateCore` — the core's own
 *      status contract stays untouched;
 *   4. a refusal (null — the assistant guard's zero-row outcome) and a
 *      thrown publish failure both surface as a WARNING and leave the
 *      import result intact (the template stays a draft; re-upload is the
 *      retry, and the atomic op's dedup path is the repair);
 *   5. the success audit record carries the draft→published transition and
 *      the bound version id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdminSession = vi.fn();
const importAgentTemplateCore = vi.fn();
const publishAgentTemplateAndBindVersion = vi.fn();
const logAuditEvent = vi.fn();
const setExtensionInstaller = vi.fn();
const saveExtensionAccessPolicy = vi.fn();
const addExtensionCoOwner = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: (...a: unknown[]) => requireAdminSession(...a),
}));
vi.mock("@/lib/authz", () => ({
  logAuditEvent: (...a: unknown[]) => logAuditEvent(...a),
}));
vi.mock("@/lib/authz/actor-context", () => ({
  POLICY_VERSION: "test-policy",
}));
vi.mock("../store", () => ({
  createAgentTemplate: vi.fn(),
  createAgentVersion: vi.fn(),
}));
vi.mock("../import-agent-core", () => ({
  importAgentTemplateCore: (...a: unknown[]) => importAgentTemplateCore(...a),
}));
vi.mock("../publish-template", () => ({
  publishAgentTemplateAndBindVersion: (...a: unknown[]) =>
    publishAgentTemplateAndBindVersion(...a),
}));
vi.mock("@cinatra-ai/extensions/permissions-actions", () => ({
  setExtensionInstaller: (...a: unknown[]) => setExtensionInstaller(...a),
  saveExtensionAccessPolicy: (...a: unknown[]) => saveExtensionAccessPolicy(...a),
  addExtensionCoOwner: (...a: unknown[]) => addExtensionCoOwner(...a),
}));

import { importAgentTemplate } from "../import-export-actions";
import type { AgentAuthPolicy } from "../auth-policy-types";

const importResult = { templateId: "tpl-1", upserted: false };

const publishedResult = {
  record: {
    id: "tpl-1",
    orgId: "org-1",
    creatorId: "admin-1",
    status: "published",
    currentVersionId: "ver-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  version: { id: "ver-1", semver: "1.0.0" },
};

const uploadPolicy: AgentAuthPolicy = {
  runListVisibility: ["org"],
  runDataVisibility: ["org"],
  runExecuteVisibility: ["org"],
  allowRunSharing: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminSession.mockResolvedValue({
    user: { id: "admin-1" },
    session: { activeOrganizationId: "org-1" },
  });
  importAgentTemplateCore.mockResolvedValue({ ...importResult });
  publishAgentTemplateAndBindVersion.mockResolvedValue(publishedResult);
  logAuditEvent.mockResolvedValue(undefined);
  setExtensionInstaller.mockResolvedValue({ ok: true });
  saveExtensionAccessPolicy.mockResolvedValue({ ok: true });
  addExtensionCoOwner.mockResolvedValue({ ok: true });
});

describe("importAgentTemplate upload path goes live (cinatra#2653)", () => {
  it("publishes through the ONE atomic op, AFTER the scope policy is saved", async () => {
    const result = await importAgentTemplate("emlwLXBheWxvYWQ=", undefined, {
      redirect: false,
      permissions: { policy: uploadPolicy },
      publishAndBind: true,
    });
    expect(publishAgentTemplateAndBindVersion).toHaveBeenCalledTimes(1);
    expect(publishAgentTemplateAndBindVersion).toHaveBeenCalledWith("tpl-1", {
      createdBy: "admin-1",
    });
    // The scope is saved BEFORE go-live, so the agent surfaces already scoped.
    expect(saveExtensionAccessPolicy.mock.invocationCallOrder[0]).toBeLessThan(
      publishAgentTemplateAndBindVersion.mock.invocationCallOrder[0],
    );
    expect(result.warnings).toEqual([]);
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "agent_template",
        resourceId: "tpl-1",
        operation: "update",
        decision: "allowed",
        metadata: expect.objectContaining({
          statusTransition: { from: "draft", to: "published" },
          boundVersionId: "ver-1",
          via: "upload-import",
        }),
      }),
    );
  });

  it("does NOT publish without the flag (the MCP ZIP import path keeps landing drafts)", async () => {
    await importAgentTemplate("emlwLXBheWxvYWQ=", undefined, { redirect: false });
    expect(publishAgentTemplateAndBindVersion).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("never forwards the flag into importAgentTemplateCore (the core's status contract is untouched)", async () => {
    await importAgentTemplate("emlwLXBheWxvYWQ=", undefined, {
      redirect: false,
      publishAndBind: true,
    });
    const coreOptions = importAgentTemplateCore.mock.calls[0][2] as Record<string, unknown>;
    expect(coreOptions).not.toHaveProperty("publishAndBind");
    expect(coreOptions).not.toHaveProperty("status");
  });

  it("surfaces a refusal (assistant guard / concurrent delete) as a warning, keeping the import", async () => {
    publishAgentTemplateAndBindVersion.mockResolvedValue(null);
    const result = await importAgentTemplate("emlwLXBheWxvYWQ=", undefined, {
      redirect: false,
      publishAndBind: true,
    });
    expect(result.templateId).toBe("tpl-1");
    expect(result.warnings).toEqual([
      expect.stringContaining("could not go live (publish refused)"),
    ]);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("surfaces a thrown publish failure as a warning, keeping the import (re-upload is the retry)", async () => {
    publishAgentTemplateAndBindVersion.mockRejectedValue(new Error("db down"));
    const result = await importAgentTemplate("emlwLXBheWxvYWQ=", undefined, {
      redirect: false,
      publishAndBind: true,
    });
    expect(result.templateId).toBe("tpl-1");
    expect(result.warnings).toEqual([expect.stringContaining("could not go live")]);
  });
});
