import { describe, it, expect } from "vitest";
import { releaseWorkflowsSchemaTables } from "../schema";
import * as publicSurface from "../index";

describe("release-workflows schema", () => {
  it("declares all 9 workflow tables", () => {
    const names = Object.keys(releaseWorkflowsSchemaTables).sort();
    expect(names).toEqual(
      [
        "workflow",
        "workflowApproval",
        "workflowArtifact",
        "workflowDependency",
        "workflowEvent",
        "workflowGate",
        "workflowTask",
        "workflowTaskAttempt",
        "workflowTemplate",
      ].sort(),
    );
  });

  it("re-exports each table from the package index", () => {
    expect(publicSurface.workflow).toBe(releaseWorkflowsSchemaTables.workflow);
    expect(publicSurface.workflowApproval).toBe(releaseWorkflowsSchemaTables.workflowApproval);
    expect(publicSurface.workflowTaskAttempt).toBe(
      releaseWorkflowsSchemaTables.workflowTaskAttempt,
    );
  });

  it("does not create a pg pool at import time (build-hermeticity invariant)", () => {
    // Importing schema/index must never construct the pool. The lazy proxy in
    // db.ts only builds it on first property access of `db`/`releaseWorkflowsPool`.
    expect(globalThis.__cinatraWorkflowsPool).toBeUndefined();
  });
});
