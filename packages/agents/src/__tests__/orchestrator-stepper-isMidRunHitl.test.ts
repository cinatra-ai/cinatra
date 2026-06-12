/**
 * classifyMidRunHitl uses strict Set matching for namespaced renderer IDs.
 *
 * The mid-run HITL classifier must not use suffix matching for draft review
 * and draft confirm renderer IDs, because that would false-match any future
 * agent whose renderer ID happens to share the same suffix. Those renderer IDs
 * are matched only by strict equality against the full namespaced renderer ID.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { classifyMidRunHitl } from "../orchestrator-mid-run-hitl";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

// The strict slice is registry-driven (cinatra#151 Stage 5): the flagged IDs
// come from each agent's manifest `midRunHitl: true` declaration via the
// generated bindings — register them exactly as the app shell does.
beforeAll(() => {
  ensureDefaultFieldRenderersRegistered();
});

describe("classifyMidRunHitl — strict-equality renderer IDs", () => {
  it.each([
    "@cinatra-ai/blog-linkedin-publish-agent:draft-review",
    "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm",
    // The context-selector renderer needs strict-set classification so the
    // stepper buffers selections instead of firing approveReviewTask per click.
    "@cinatra-ai/context-selection-agent:context-selector",
  ])("returns true for exact renderer id %s", (id) => {
    expect(classifyMidRunHitl(id)).toBe(true);
  });

  it.each([
    "@cinatra/some-other-agent:draft-review", // namespace collision attempt
    "@cinatra/some-other-agent:draft-confirm",
    "@cinatra/evil-agent:fake:draft-review",
    "draft-review",
    ":draft-review",
    "@cinatra-ai/blog-linkedin-publish-agent:something-else",
  ])("returns false for non-exact renderer id %s", (id) => {
    expect(classifyMidRunHitl(id)).toBe(false);
  });

  it("preserved pre-existing suffix classifiers still match", () => {
    // Pre-existing suffix matchers are retained for now; narrowing those
    // is a separate audit. Spot-check a representative set so a refactor
    // accidentally dropping them gets caught.
    expect(classifyMidRunHitl("@cinatra/whatever:output")).toBe(true);
    expect(classifyMidRunHitl("@cinatra/whatever:contacts-output")).toBe(true);
    // :contact-source-selector retired with the lists_* / segment surface.
    expect(classifyMidRunHitl("@cinatra/whatever:list-picker")).toBe(true);
    expect(classifyMidRunHitl("@cinatra/whatever:scrape-schema-review")).toBe(true);
    expect(classifyMidRunHitl("@cinatra/whatever:final-list-review")).toBe(true);
    expect(classifyMidRunHitl("@cinatra/whatever:setup-form")).toBe(true);
  });

  it("non-HITL renderer ids return false", () => {
    expect(classifyMidRunHitl("@cinatra-ai/agent-builder:schema-field-fallback")).toBe(false);
    expect(classifyMidRunHitl("")).toBe(false);
    expect(classifyMidRunHitl("random-string")).toBe(false);
  });
});
