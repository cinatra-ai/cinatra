import { describe, it, expect } from "vitest";

import {
  pickerValueToTarget,
  canSubmitApprovalScope,
} from "@cinatra-ai/agents/auth-policy-types";

const ORG = "org-1";

// cinatra#1327 required-ness (criterion a): the approval/install scope step is
// REQUIRED, so the submit predicate must return false for no selection and for
// the non-target rows (owner / admin / workspace), and true only for a resolved
// org/team/project target. This is the pure single-source-of-truth the approval
// dialog's submit `disabled` binds to.

describe("pickerValueToTarget", () => {
  it("maps org: / team: / project: tokens to {level, id}", () => {
    expect(pickerValueToTarget("org:o9", ORG)).toEqual({ level: "organization", id: "o9" });
    expect(pickerValueToTarget("team:t1", ORG)).toEqual({ level: "team", id: "t1" });
    expect(pickerValueToTarget("project:p1", ORG)).toEqual({ level: "project", id: "p1" });
  });

  it("backs the legacy bare 'org' token with activeOrgId", () => {
    expect(pickerValueToTarget("org", ORG)).toEqual({ level: "organization", id: ORG });
  });

  it("returns null for the non-target rows and for no selection (defensive guard)", () => {
    for (const v of ["", "owner", "admin", "workspace"]) {
      expect(pickerValueToTarget(v, ORG)).toBeNull();
    }
  });

  it("returns null for a prefix with an EMPTY id (e.g. 'team:' / 'project:' / 'org:')", () => {
    expect(pickerValueToTarget("team:", ORG)).toBeNull();
    expect(pickerValueToTarget("project:", ORG)).toBeNull();
    expect(pickerValueToTarget("org:", ORG)).toBeNull();
  });
});

describe("canSubmitApprovalScope — the required-ness predicate", () => {
  it("is FALSE with no selection (submit stays disabled)", () => {
    expect(canSubmitApprovalScope("", ORG)).toBe(false);
  });

  it("is FALSE for owner / admin / workspace (not selectable targets)", () => {
    expect(canSubmitApprovalScope("owner", ORG)).toBe(false);
    expect(canSubmitApprovalScope("admin", ORG)).toBe(false);
    expect(canSubmitApprovalScope("workspace", ORG)).toBe(false);
  });

  it("is FALSE for a prefix with an empty id (submit stays disabled)", () => {
    expect(canSubmitApprovalScope("team:", ORG)).toBe(false);
    expect(canSubmitApprovalScope("project:", ORG)).toBe(false);
  });

  it("is TRUE only for a resolved org / team / project selection", () => {
    expect(canSubmitApprovalScope("org:o1", ORG)).toBe(true);
    expect(canSubmitApprovalScope("team:t1", ORG)).toBe(true);
    expect(canSubmitApprovalScope("project:p1", ORG)).toBe(true);
  });
});
