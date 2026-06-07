// Covers the chat empty-state badge-array + caption selection extracted to
// `chat-badges.ts`. The three-way badge selection and the mode-driven
// caption are otherwise only exercised at owner visual review; an order
// flip (e.g. agent/workflow swapped) or a caption regression would slip
// through silently.

import { describe, expect, it } from "vitest";

import {
  BUILD_AGENT_BADGE,
  BUILD_WORKFLOW_BADGE,
  selectChatBadges,
  chatEmptyStateCaption,
} from "../chat-badges";

describe("selectChatBadges", () => {
  it("default chat mode: only the two pinned build badges, agent then workflow (order load-bearing)", () => {
    const result = selectChatBadges(undefined);
    expect(result.map((b) => b.id)).toEqual([
      BUILD_AGENT_BADGE.id,
      BUILD_WORKFLOW_BADGE.id,
    ]);
  });

  it("create-agent mode: only the agent badge", () => {
    expect(selectChatBadges("create-agent")).toEqual([BUILD_AGENT_BADGE]);
  });

  it("create-workflow mode: only the workflow badge", () => {
    expect(selectChatBadges("create-workflow")).toEqual([BUILD_WORKFLOW_BADGE]);
  });
});

describe("chatEmptyStateCaption", () => {
  it("returns the rotating greeting in default chat mode", () => {
    expect(chatEmptyStateCaption(undefined, "Good evening")).toBe("Good evening");
  });

  it("returns 'Create a new agent' in create-agent mode", () => {
    expect(chatEmptyStateCaption("create-agent", "Good evening")).toBe("Create a new agent");
  });

  it("returns 'Create a new workflow' in create-workflow mode", () => {
    expect(chatEmptyStateCaption("create-workflow", "Good evening")).toBe("Create a new workflow");
  });
});

describe("pinned build badges", () => {
  it("carry the stable pinned ids + workflow-authoring prefill wording", () => {
    expect(BUILD_AGENT_BADGE.id).toBe("__pinned_build_agent__");
    expect(BUILD_AGENT_BADGE.pinned).toBe(true);
    expect(BUILD_WORKFLOW_BADGE.id).toBe("__pinned_build_workflow__");
    expect(BUILD_WORKFLOW_BADGE.pinned).toBe(true);
    expect(BUILD_WORKFLOW_BADGE.prefillText).toContain("build a workflow");
  });
});
