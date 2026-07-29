// The #2188 merge-safe assertion (assistant-skills S3 fold, cinatra#2090):
// the Cinatra assistant's required injectable bundle is EXACTLY the five
// successor router slugs. The typed injection contract caps a resolved skill
// set at 8 INCLUDING the personal delta, so the required bundle must stay ≤ 7
// (5 today + the delta = 6 ≤ 8) — otherwise the cap would silently truncate
// the assistant's own bundle, which is exactly the interim defect the fold
// discharges. Pinned as data (not derived) on purpose: growing this bundle is
// a contract decision, not a refactor.
import { describe, expect, it } from "vitest";
import { CINATRA_ASSISTANT_SKILL_BUNDLE } from "../cinatra-assistant-config";

describe("CINATRA_ASSISTANT_SKILL_BUNDLE (the 5-router successor bundle)", () => {
  it("is exactly the five successor router slugs, in order", () => {
    expect([...CINATRA_ASSISTANT_SKILL_BUNDLE]).toEqual([
      "chat-assistant-core",
      "chat-extension-authoring",
      "chat-automation-authoring",
      "company-research",
      "blog-content",
    ]);
  });

  it("keeps the system skill at index 0 (order is load-bearing)", () => {
    expect(CINATRA_ASSISTANT_SKILL_BUNDLE[0]).toBe("chat-assistant-core");
  });

  it("stays within the injection contract's headroom: 5 slugs, hard ceiling 7 (cap 8 incl. the personal delta)", () => {
    expect(CINATRA_ASSISTANT_SKILL_BUNDLE).toHaveLength(5);
    expect(CINATRA_ASSISTANT_SKILL_BUNDLE.length).toBeLessThanOrEqual(7);
  });
});
