/**
 * cinatra#3948: a failed fact read cannot remove an organization-required
 * review. Exercise the real declared-review wrapper and policy with mocked
 * reads only. This separate fix leg replaces the two defective fallback
 * expectations while preserving the template-read fallback and healthy policy.
 * Keep the default-manifest read-failure cases from the #3944 caller tests;
 * their former fail-open expectations now require the original refusal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readArtifact, readTemplate, readOrgRule } = vi.hoisted(() => ({
  readArtifact: vi.fn<() => Promise<Array<{ type: string; deletedAt: Date | null }>>>(),
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

describe("cinatra#3948: failed declared-review lookups never weaken review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readArtifact.mockResolvedValue([{ type: "blog-post", deletedAt: null }]);
    readOrgRule.mockResolvedValue({ bound: "silent" });
    templateWith(null);
  });

  it.each(["artifact", "organization"] as const)("propagates a default-manifest %s read failure without returning a review decision", async (lookup) => {
    const original = structuredClone(REQUEST);
    const failure = new Error(`${lookup} lookup unavailable without a manifest skip`);
    if (lookup === "artifact") readArtifact.mockRejectedValueOnce(failure);
    else readOrgRule.mockRejectedValueOnce(failure);
    await expect(decideDeclaredReviewForGate(REQUEST)).rejects.toBe(failure);
    expect(readArtifact).toHaveBeenCalledTimes(1);
    if (lookup === "artifact") expect(readOrgRule).not.toHaveBeenCalled();
    else expect(readOrgRule).toHaveBeenCalledTimes(1);
    expect(REQUEST).toEqual(original);
  });

  it("propagates an artifact read failure instead of bypassing the required organization bound", async () => {
    const original = structuredClone(REQUEST);
    templateWith(SKIP_REVIEW);
    readOrgRule.mockResolvedValue({ bound: "required" });
    expect(await decideDeclaredReviewForGate(REQUEST)).toMatchObject({
      review: true,
      targets: TARGETS,
    });

    readOrgRule.mockClear();
    const failure = new Error("artifact lookup unavailable");
    readArtifact.mockRejectedValueOnce(failure);
    await expect(decideDeclaredReviewForGate(REQUEST)).rejects.toBe(failure);
    expect(readOrgRule).not.toHaveBeenCalled();
    expect(REQUEST).toEqual(original);
  });

  it("propagates a required organization-rule read failure instead of letting the manifest skip win", async () => {
    const original = structuredClone(REQUEST);
    templateWith(SKIP_REVIEW);
    readOrgRule.mockResolvedValue({ bound: "required" });
    expect(await decideDeclaredReviewForGate(REQUEST)).toMatchObject({
      review: true,
      targets: TARGETS,
    });

    const failure = new Error("org rule unavailable");
    readOrgRule.mockRejectedValueOnce(failure);
    await expect(decideDeclaredReviewForGate(REQUEST)).rejects.toBe(failure);
    expect(REQUEST).toEqual(original);
  });

  it.each(["artifact", "organization"] as const)("rejects the whole target set when a later %s read fails", async (lookup) => {
    const request = {
      ...REQUEST,
      targets: [...TARGETS, { artifactId: "artifact-b", representationRevisionId: "revision-b" }],
    };
    const original = structuredClone(request);
    templateWith(SKIP_REVIEW);
    readOrgRule.mockResolvedValue({ bound: "required" });
    const failure = new Error(`${lookup} lookup unavailable for later target`);
    if (lookup === "artifact") {
      readArtifact
        .mockResolvedValueOnce([{ type: "blog-post", deletedAt: null }])
        .mockRejectedValueOnce(failure);
    } else {
      readOrgRule.mockResolvedValueOnce({ bound: "required" }).mockRejectedValueOnce(failure);
    }
    await expect(decideDeclaredReviewForGate(request)).rejects.toBe(failure);
    expect(readArtifact).toHaveBeenCalledTimes(2);
    expect(readOrgRule).toHaveBeenCalledTimes(lookup === "artifact" ? 1 : 2);
    expect(request).toEqual(original);
  });

  it("still removes a template skip on template-read failure and keeps the default review", async () => {
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

  it.each(["silent", "forbidden"] as const)("preserves a successfully read %s policy with a manifest skip", async (bound) => {
    templateWith(SKIP_REVIEW);
    readOrgRule.mockResolvedValue({ bound });
    expect(await decideDeclaredReviewForGate(REQUEST)).toMatchObject({ review: false });
  });

  it.each(["absent", "deleted"] as const)("keeps the existing %s-row behavior distinct from a rejected read", async (kind) => {
    readArtifact.mockResolvedValue(kind === "absent" ? [] : [{ type: "blog-post", deletedAt: new Date(0) }]);
    expect(await decideDeclaredReviewForGate(REQUEST)).toMatchObject({
      review: true,
      targets: TARGETS,
    });
    expect(readOrgRule).not.toHaveBeenCalled();
  });
});
