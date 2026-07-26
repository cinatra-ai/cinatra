// @vitest-environment jsdom
/**
 * cinatra#1796 — coverage for the DEDICATED, host-bundled
 * BlogIdeaSelectionRenderer (kind "blog-idea-selection", binding id
 * `@cinatra-ai/blog-pipeline-agent:idea-selection`) that the blog OAS's
 * idea_selection_gate relocates onto (off the shared reviewer-output binding).
 *
 * PAYLOAD CONTRACT (ground truth): the InputMessageNode idea_selection_gate
 * emits ONE string output `selectedIdeaJson` (blog OAS
 * components.idea_selection_gate.outputs[0].title) which becomes the WayFlow
 * resume text `userResponse`; the downstream `selected_idea` passthrough seam
 * consumes `selectedIdeaJson` + `ideas`. The chosen idea is committed as
 * JSON.stringify(idea) into BOTH keys — the #839 chooser contract, which now
 * lives solely on this dedicated renderer (the former inline chooser on the
 * shared reviewer-output binding was removed in the #1796 Stage-3 teardown).
 *
 * Asserts:
 *   - a radio-per-idea chooser renders and commits ideas[0] on mount as
 *     {selectedIdeaJson, userResponse} = JSON.stringify(idea);
 *   - changing the pick re-commits the newly chosen idea;
 *   - the no-ideas case degrades to the schema floor (no chooser, no
 *     selectedIdeaJson auto-commit) — never blank;
 *   - the binding id resolves to this renderer at the pre-relocation priority
 *     (80) and classifies as a mid-run HITL gate (parity with the `:output`
 *     suffix classification the shared reviewer binding used to provide).
 */
import React from "react";
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { BlogIdeaSelectionRenderer } from "../blog-idea-selection-renderer";
import { ReviewerAgentOutputRenderer } from "../reviewer-agent-output-renderer";
import {
  fieldRendererRegistry,
  type FieldRendererContext,
} from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import {
  classifyMidRunHitl,
  hasMidRunHitlBinding,
} from "../orchestrator-mid-run-hitl";

const CTX: FieldRendererContext = { connectedApps: [] };
const BINDING_ID = "@cinatra-ai/blog-pipeline-agent:idea-selection";
const IDEAS = [
  { title: "Idea Alpha", summary: "First angle" },
  { title: "Idea Beta", summary: "Second angle" },
];
// The compiled InputMessageNode schema the gate carries after the Stage-2
// repoint (blog OAS idea_selection_gate.inputMessageSchema).
const GATE_SCHEMA = {
  type: "object",
  "x-renderer": BINDING_ID,
  properties: { selectedIdeaJson: { type: "string" } },
  required: ["selectedIdeaJson"],
};

function renderChooser(value: unknown, schema: unknown = GATE_SCHEMA) {
  const onChange = vi.fn();
  return {
    onChange,
    ...render(
      <BlogIdeaSelectionRenderer
        fieldName="selectedIdeaJson"
        schema={schema as Record<string, unknown>}
        value={value}
        onChange={onChange}
        context={CTX}
      />,
    ),
  };
}

afterEach(cleanup);

describe("BlogIdeaSelectionRenderer — dedicated idea chooser (cinatra#1796 S2)", () => {
  it("renders a radio per idea and commits ideas[0] on mount as {selectedIdeaJson, userResponse}", () => {
    const { onChange } = renderChooser({ ideas: IDEAS });
    expect(screen.getByText("Idea Alpha")).toBeTruthy();
    expect(screen.getByText("Idea Beta")).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    // The exact payload shape the gate + its passthrough seam expect.
    expect(onChange).toHaveBeenCalledWith({
      selectedIdeaJson: JSON.stringify(IDEAS[0]),
      userResponse: JSON.stringify(IDEAS[0]),
    });
  });

  it("selecting the second idea commits ideas[1] in the same payload shape", () => {
    const { onChange } = renderChooser({ ideas: IDEAS });
    fireEvent.click(screen.getAllByRole("radio")[1]!);
    expect(onChange).toHaveBeenLastCalledWith({
      selectedIdeaJson: JSON.stringify(IDEAS[1]),
      userResponse: JSON.stringify(IDEAS[1]),
    });
  });

  it("surfaces the optional summary line above the chooser", () => {
    renderChooser({ ideas: IDEAS, summary: "Pick the angle to draft" });
    expect(screen.getByText("Pick the angle to draft")).toBeTruthy();
  });

  it("commits selectedIdeaJson === userResponse (single-string InputMessageNode contract)", () => {
    const { onChange } = renderChooser({ ideas: IDEAS });
    const call = onChange.mock.calls.at(-1)![0] as {
      selectedIdeaJson: string;
      userResponse: string;
    };
    expect(call.selectedIdeaJson).toBe(call.userResponse);
    expect(JSON.parse(call.selectedIdeaJson)).toEqual(IDEAS[0]);
  });

  it("degrades to the schema floor with no ideas — no chooser, no selectedIdeaJson auto-commit (never blank)", () => {
    const { onChange } = renderChooser({ contentType: "text" });
    expect(screen.queryByText("Select one blog idea to draft.")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    const committed = onChange.mock.calls.map(
      (c) => c[0] as { selectedIdeaJson?: unknown },
    );
    expect(committed.every((c) => c.selectedIdeaJson === undefined)).toBe(true);
  });

  it("degrades to the schema floor for an empty ideas array", () => {
    renderChooser({ ideas: [] });
    expect(screen.queryByText("Select one blog idea to draft.")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });
});

describe("BlogIdeaSelectionRenderer — binding resolution + mid-run classification", () => {
  beforeAll(() => {
    ensureDefaultFieldRenderersRegistered();
  });

  it("the dedicated binding id resolves to BlogIdeaSelectionRenderer at priority 80", () => {
    const entry = fieldRendererRegistry.resolve(
      "selectedIdeaJson",
      { "x-renderer": BINDING_ID },
      CTX as never,
    );
    expect(entry).toBeTruthy();
    expect(entry!.priority).toBe(80);
    expect(entry!.renderer).toBe(BlogIdeaSelectionRenderer);
  });

  it("classifies as a mid-run HITL gate (parity with the retired :output-suffix classification)", () => {
    expect(hasMidRunHitlBinding(BINDING_ID)).toBe(true);
    expect(classifyMidRunHitl(BINDING_ID)).toBe(true);
  });

  it("strict-id relocation: the dedicated id owns the chooser while reviewer-output keeps its OWN renderer", () => {
    const dedicated = fieldRendererRegistry.resolve(
      "selectedIdeaJson",
      { "x-renderer": BINDING_ID },
      CTX as never,
    );
    const reviewer = fieldRendererRegistry.resolve(
      "selectedIdeaJson",
      { "x-renderer": "@cinatra-ai/reviewer-agent:output" },
      CTX as never,
    );
    // The relocation is a genuine split: the dedicated binding resolves to the
    // new chooser; the shared reviewer binding still resolves to the reviewer
    // envelope (NOT the chooser). Strict-id — no cross-match.
    expect(dedicated!.renderer).toBe(BlogIdeaSelectionRenderer);
    expect(reviewer).toBeTruthy();
    expect(reviewer!.renderer).toBe(ReviewerAgentOutputRenderer);
    expect(reviewer!.renderer).not.toBe(BlogIdeaSelectionRenderer);
  });
});
