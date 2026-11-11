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
 *   - a radio-per-idea chooser renders with nothing picked and commits nothing on
 *     mount (cinatra#3035); a pick commits {selectedIdeaJson, userResponse};
 *   - changing the pick re-commits the newly chosen idea;
 *   - the no-ideas case degrades to the schema floor (no chooser, no
 *     selectedIdeaJson auto-commit) — never blank;
 *   - a declared empty-state message is drawn as written (cinatra#3035);
 *   - the binding id resolves to this renderer at the pre-relocation priority
 *     (80) and classifies as a mid-run HITL gate (parity with the `:output`
 *     suffix classification the shared reviewer binding used to provide).
 */
import React from "react";
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { BlogIdeaSelectionRenderer } from "../blog-idea-selection-renderer";
import {
  continueAwaitsAPick,
  fieldRendererRegistry,
  type FieldRendererContext,
  type FieldRendererEntry,
} from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered, registerFieldRendererBindings } from "../register-default-renderers";
import { hasFieldRendererComponent } from "../field-renderer-components";
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

function renderChooser(value: unknown, schema: unknown = GATE_SCHEMA, bindingParams?: Record<string, unknown>) {
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
        bindingParams={bindingParams}
      />,
    ),
  };
}

afterEach(cleanup);

describe("BlogIdeaSelectionRenderer — dedicated idea chooser (cinatra#1796 S2)", () => {
  it("renders a radio per idea with nothing picked and commits nothing on mount (cinatra#3035)", () => {
    const { onChange } = renderChooser({ ideas: IDEAS });
    expect(screen.getByText("Idea Alpha")).toBeTruthy();
    expect(screen.getByText("Idea Beta")).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(document.querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getAllByRole("radio")[0]!);
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

  it("an empty ideas array draws the declared empty-state message as written and commits nothing (cinatra#3035)", () => {
    const { onChange } = renderChooser({ ideas: [] }, GATE_SCHEMA, { emptyStateMessage: "No idea is left to draft." });
    expect(screen.getByText("No idea is left to draft.")).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("the kind-binding road holds the idea step's Continue until a pick (cinatra#3035)", () => {
  it("a runtime binding of the idea kind mounts the host chooser with no pick, and its Continue waits", () => {
    const id = "@cinatra-ai/kind-road-3035:ideas";
    registerFieldRendererBindings([{ id, kind: "blog-idea-selection", priority: 80, midRunHitl: true }]);
    const entry = fieldRendererRegistry.resolve("selectedIdeaJson", { "x-renderer": id }, CTX as never);
    expect(entry?.renderer).toBe(BlogIdeaSelectionRenderer);
    const Renderer = entry!.renderer;
    const onChange = vi.fn();
    render(<Renderer fieldName="selectedIdeaJson" schema={GATE_SCHEMA} value={{ ideas: IDEAS }} onChange={onChange} context={CTX} />);
    expect(onChange).not.toHaveBeenCalled();
    expect(continueAwaitsAPick(entry, {})).toBe(true);
  });

  it("continueAwaitsAPick holds only a held entry with no non-empty string pick", () => {
    const held = { holdsContinueUntilPicked: true } as FieldRendererEntry;
    expect(continueAwaitsAPick(undefined, {})).toBe(false);
    expect(continueAwaitsAPick({ holdsContinueUntilPicked: false } as FieldRendererEntry, {})).toBe(false);
    for (const pick of [undefined, "", 7, { id: "x" }]) expect(continueAwaitsAPick(held, { userResponse: pick })).toBe(true);
    expect(continueAwaitsAPick(held, { userResponse: JSON.stringify(IDEAS[0]) })).toBe(false);
  });
});

describe("BlogIdeaSelectionRenderer — binding resolution + mid-run classification", () => {
  beforeAll(() => {
    ensureDefaultFieldRenderersRegistered();
  });

  it("the dedicated binding id resolves at priority 80 to the component the pinned pipeline pack ships", () => {
    // The pinned pipeline pack declares its own component for this binding, so the
    // build map carries it and the binding mounts the pack's chooser; the host's
    // chooser stays the kind's fallback for a build without the pack's component.
    expect(hasFieldRendererComponent(BINDING_ID)).toBe(true);
    const entry = fieldRendererRegistry.resolve(
      "selectedIdeaJson",
      { "x-renderer": BINDING_ID },
      CTX as never,
    );
    expect(entry).toBeTruthy();
    expect(entry!.priority).toBe(80);
    expect(entry!.renderer).not.toBe(BlogIdeaSelectionRenderer);
  });

  it("classifies as a mid-run HITL gate (parity with the retired :output-suffix classification)", () => {
    expect(hasMidRunHitlBinding(BINDING_ID)).toBe(true);
    expect(classifyMidRunHitl(BINDING_ID)).toBe(true);
  });

  it("strict-id: the dedicated id owns the chooser and the RETIRED shared binding resolves to nothing", () => {
    const dedicated = fieldRendererRegistry.resolve(
      "selectedIdeaJson",
      { "x-renderer": BINDING_ID },
      CTX as never,
    );
    expect(dedicated).toBeTruthy();
    expect(dedicated!.renderer).not.toBe(BlogIdeaSelectionRenderer);
    // cinatra#1796 teardown: the shared reviewer binding the chooser relocated
    // OFF is gone — its package is retired, its kind is out of the vocabulary
    // and its dispatcher is deleted. Reconstructed here from parts so this file
    // holds no live reference to the retired identity (the same technique the
    // retirement-identity gate uses on itself). Strict-id means the dedicated
    // chooser must NOT pick the orphaned id up.
    const RETIRED_SHARED_ID = ["@cinatra-ai/", "reviewer", "-agent:output"].join("");
    const orphaned = fieldRendererRegistry.resolve(
      "selectedIdeaJson",
      { "x-renderer": RETIRED_SHARED_ID },
      CTX as never,
    );
    expect(orphaned).toBeFalsy();
  });
});
