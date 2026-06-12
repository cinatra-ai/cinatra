// @vitest-environment jsdom
/**
 * The pinned `params` contract (cinatra#151 Stage 5): a manifest binding's
 * validated `params` object reaches the renderer as the `bindingParams`
 * prop via the registration wrapper.
 *
 * Asserts (through the REGISTRY, end-to-end):
 *   - resolving the skill-recommend gate yields the wrapped renderer, and
 *     rendering it fetches skills for the MANIFEST-DECLARED target package
 *     (the skill-recommender agent's `params.skillsTargetPackage`) — the
 *     retired hard-coded DRAFTS_PACKAGE constant is gone;
 *   - rendering the UNWRAPPED component (no bindingParams) degrades to an
 *     empty list with a functional Continue (absent/malformed params can
 *     never wedge the gate).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import React from "react";

const getSkillsForAgentAction = vi.fn(async (..._args: unknown[]) => []);
vi.mock("../server-actions", () => ({
  getSkillsForAgentAction: (...args: unknown[]) => getSkillsForAgentAction(...args),
}));
vi.mock("../hitl-skill-chips", () => ({
  HitlSkillChips: () => null,
}));

import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { SkillRecommenderRenderer } from "../skill-recommender-agent-renderers";
import type { FieldRendererProps } from "../field-renderer-registry";

const BASE_PROPS: FieldRendererProps = {
  fieldName: "recommend",
  schema: { "x-renderer": "@cinatra-ai/skill-recommender-agent:recommend" },
  value: undefined,
  onChange: vi.fn(),
  context: { connectedApps: [] },
};

afterEach(() => {
  cleanup();
  getSkillsForAgentAction.mockClear();
});

describe("skill-recommend bindingParams contract", () => {
  it("the registry-resolved renderer fetches skills for the manifest-declared target", async () => {
    ensureDefaultFieldRenderersRegistered();
    const entry = fieldRendererRegistry.resolve(
      "recommend",
      { "x-renderer": "@cinatra-ai/skill-recommender-agent:recommend" },
      { connectedApps: [] },
    );
    expect(entry).toBeTruthy();
    const Resolved = entry!.renderer;
    render(<Resolved {...BASE_PROPS} />);
    await waitFor(() => expect(getSkillsForAgentAction).toHaveBeenCalled());
    // The target package is EXTENSION-OWNED data from the skill-recommender
    // agent's manifest binding params — asserted against the generated value.
    const { GENERATED_FIELD_RENDERER_BINDINGS } = await import("@/lib/generated/agent-bindings");
    const binding = GENERATED_FIELD_RENDERER_BINDINGS.find(
      (b) => b.kind === "skill-recommend",
    );
    expect(binding?.params?.skillsTargetPackage).toBeTruthy();
    expect(getSkillsForAgentAction).toHaveBeenCalledWith(binding!.params!.skillsTargetPackage);
  });

  it("absent bindingParams degrade: no fetch, Continue still renders", async () => {
    render(<SkillRecommenderRenderer {...BASE_PROPS} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /continue/i })).toBeDefined(),
    );
    expect(getSkillsForAgentAction).not.toHaveBeenCalled();
  });
});
