/**
 * App164: record the existing per-fact fallbacks without changing their policy.
 * These controls deliberately expose the required-bound/manifest-skip defect;
 * its correction belongs to a separate issue, not the #3944 caller follow-up.
 * The actual store wrapper and policy run with mocked reads, never a database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readArtifact, readTemplate, readOrgRule } = vi.hoisted(() => ({
  readArtifact: vi.fn<() => Promise<Array<{ type: string; deletedAt: null }>>>(),
  readTemplate: vi.fn<(id: string) => Promise<{
    packageVersion: string;
    lifecycleConfig: string | null;
  }>>(),
  readOrgRule: vi.fn<() => Promise<{ bound: "silent" | "required" | "forbidden" }>>(),
}));

vi.mock("../db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => readArtifact() }) }),
    }),
  },
}));
vi.mock("../store", () => ({ readAgentTemplateById: readTemplate }));
vi.mock("../lifecycle-policy-store", () => ({ resolveOrgPolicyRule: readOrgRule }));

import { decideDeclaredReviewForGate } from "../lifecycle-declared-review-store";

const TARGETS = [{ artifactId: "artifact-a", representationRevisionId: "revision-a" }];
const REQUEST = {
  orgId: "org-a",
  templateId: "template-a",
  packageVersion: "1.0.0",
  targets: TARGETS,
};
const SKIP_REVIEW = JSON.stringify({ requestedSkips: ["review"] });

function templateWith(config: string | null) {
  readTemplate.mockResolvedValue({ packageVersion: "1.0.0", lifecycleConfig: config });
}

describe("App164: unchanged declared-review fact-read fallbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readArtifact.mockResolvedValue([{ type: "blog-post", deletedAt: null }]);
    readOrgRule.mockResolvedValue({ bound: "silent" });
    templateWith(null);
  });

  it("artifact read failure keeps the default review, but bypasses a required bound when the manifest skips", async () => {
    const original = structuredClone(REQUEST);
    readArtifact.mockRejectedValueOnce(new Error("artifact lookup unavailable"));
    expect(await decideDeclaredReviewForGate(REQUEST)).toMatchObject({
      review: true,
      targets: TARGETS,
    });
    expect(readOrgRule).not.toHaveBeenCalled();

    templateWith(SKIP_REVIEW);
    readOrgRule.mockResolvedValue({ bound: "required" });
    expect(await decideDeclaredReviewForGate(REQUEST)).toMatchObject({
      review: true,
      targets: TARGETS,
    });

    readOrgRule.mockClear();
    readArtifact.mockRejectedValueOnce(new Error("artifact lookup unavailable"));
    // Known defect, observed only: null artifact type prevents reading the
    // required org bound; the substituted silent bound permits the skip.
    expect(await decideDeclaredReviewForGate(REQUEST)).toMatchObject({
      review: false,
      why: expect.stringContaining("manifest requested review skipped"),
    });
    expect(readOrgRule).not.toHaveBeenCalled();
    expect(REQUEST).toEqual(original);
  });

  it("org-rule failure keeps the default review, but substitutes silent for a required bound and permits the skip", async () => {
    const original = structuredClone(REQUEST);
    readOrgRule.mockRejectedValueOnce(new Error("org rule unavailable"));
    expect(await decideDeclaredReviewForGate(REQUEST)).toMatchObject({
      review: true,
      targets: TARGETS,
    });

    templateWith(SKIP_REVIEW);
    readOrgRule.mockResolvedValue({ bound: "required" });
    expect(await decideDeclaredReviewForGate(REQUEST)).toMatchObject({
      review: true,
      targets: TARGETS,
    });

    readOrgRule.mockRejectedValueOnce(new Error("org rule unavailable"));
    // Known defect, observed only: a failed required-bound lookup becomes
    // silent, so the otherwise overridden manifest skip removes this target.
    expect(await decideDeclaredReviewForGate(REQUEST)).toMatchObject({
      review: false,
      why: expect.stringContaining("manifest requested review skipped"),
    });
    expect(REQUEST).toEqual(original);
  });

  it("template read failure removes its skip and restores the default review", async () => {
    const original = structuredClone(REQUEST);
    templateWith(SKIP_REVIEW);
    expect(await decideDeclaredReviewForGate(REQUEST)).toMatchObject({
      review: false,
      why: expect.stringContaining("manifest requested review skipped"),
    });

    readTemplate.mockRejectedValueOnce(new Error("template lookup unavailable"));
    expect(await decideDeclaredReviewForGate(REQUEST)).toMatchObject({
      review: true,
      targets: TARGETS,
    });
    expect(readTemplate).toHaveBeenCalledWith(REQUEST.templateId);
    expect(REQUEST).toEqual(original);
  });
});
