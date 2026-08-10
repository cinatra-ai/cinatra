/**
 * cinatra#2653 — which drafts may the /agents picker surface?
 *
 * The predicate is the ONE policy answer: internal executor-kind drafts pass;
 * assistant-kind drafts (the seeded builtin assistants are PERMANENT drafts by
 * design) and external rows never do, and no non-draft status passes.
 */
import { describe, it, expect } from "vitest";
import { isSurfaceableDraftTemplate } from "../draft-visibility";

const base = {
  status: "draft",
  sourceType: "internal" as const,
  agentKind: "executor" as const,
};

describe("isSurfaceableDraftTemplate (cinatra#2653)", () => {
  it("surfaces an internal executor draft (the imported-agent case)", () => {
    expect(isSurfaceableDraftTemplate(base)).toBe(true);
  });

  it("surfaces a draft with an undefined agentKind (legacy rows deserialize to executor upstream)", () => {
    expect(
      isSurfaceableDraftTemplate({ ...base, agentKind: undefined }),
    ).toBe(true);
  });

  it("never surfaces an assistant-kind draft (builtin assistants are permanent drafts)", () => {
    expect(
      isSurfaceableDraftTemplate({ ...base, agentKind: "assistant" }),
    ).toBe(false);
  });

  it("never surfaces an external row", () => {
    expect(
      isSurfaceableDraftTemplate({ ...base, sourceType: "external" }),
    ).toBe(false);
  });

  it.each(["active", "published", "archived"])(
    "never surfaces status=%s",
    (status) => {
      expect(isSurfaceableDraftTemplate({ ...base, status })).toBe(false);
    },
  );
});
