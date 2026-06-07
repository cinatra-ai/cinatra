// Workflow extension archive guard — block ARCHIVE while live (draft/active)
// instances exist, mirroring the hard-delete guard.
//
// Two layers:
//  1. `workflowExtensionArchiveBlocked` — the pure decision (in-use ⇒ block).
//  2. `archiveWorkflowExtensionDashboards` — throws WORKFLOW_TEMPLATE_IN_USE
//     when in use, otherwise delegates to the dashboards archive.
//
// The store + dashboards materialization deps are mocked so the test exercises
// the guard logic only (no DB).

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted so the vi.mock factories (themselves hoisted) can close over them.
const { arePackageTemplatesInUse, archiveExtensionDashboards } = vi.hoisted(() => ({
  arePackageTemplatesInUse: vi.fn(),
  archiveExtensionDashboards: vi.fn(async () => 7),
}));

vi.mock("../store", () => ({
  arePackageTemplatesInUse,
  // Unused-by-this-test symbols imported by extension-ops; stub so the module loads.
  materializeTemplateFromManifest: vi.fn(),
  findWorkflowTemplate: vi.fn(),
  isTemplateInUse: vi.fn(),
  deleteWorkflowTemplate: vi.fn(),
}));

vi.mock("@cinatra-ai/dashboards/extension-materialization", () => ({
  materializeExtensionTemplate: vi.fn(),
  archiveExtensionDashboards,
  restoreExtensionDashboards: vi.fn(),
  validateDashboardConfigV12: vi.fn(),
}));

import {
  workflowExtensionArchiveBlocked,
  archiveWorkflowExtensionDashboards,
  WorkflowExtensionError,
} from "../extension-ops";

const ACTOR = { userId: "u-1", orgId: "org-1" };
const REF = { packageName: "@scope/wf" };

describe("workflowExtensionArchiveBlocked (pure)", () => {
  it("blocks when templates are in use", () => {
    expect(workflowExtensionArchiveBlocked(true)).toBe(true);
  });
  it("permits when no templates are in use", () => {
    expect(workflowExtensionArchiveBlocked(false)).toBe(false);
  });
});

describe("archiveWorkflowExtensionDashboards in-use guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws WORKFLOW_TEMPLATE_IN_USE and does NOT archive while a live instance exists", async () => {
    arePackageTemplatesInUse.mockResolvedValueOnce(true);
    const err = await archiveWorkflowExtensionDashboards(REF, ACTOR).catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowExtensionError);
    expect((err as WorkflowExtensionError).code).toBe("WORKFLOW_TEMPLATE_IN_USE");
    expect(archiveExtensionDashboards).not.toHaveBeenCalled();
  });

  it("archives normally when no live instance exists", async () => {
    arePackageTemplatesInUse.mockResolvedValueOnce(false);
    const result = await archiveWorkflowExtensionDashboards(REF, ACTOR);
    expect(result).toBe(7);
    expect(archiveExtensionDashboards).toHaveBeenCalledTimes(1);
  });

  it("fails closed (MISSING_ORG_CONTEXT) before any in-use check when org context is absent", async () => {
    const err = await archiveWorkflowExtensionDashboards(REF, { userId: "u-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowExtensionError);
    expect((err as WorkflowExtensionError).code).toBe("MISSING_ORG_CONTEXT");
    expect(arePackageTemplatesInUse).not.toHaveBeenCalled();
  });
});
