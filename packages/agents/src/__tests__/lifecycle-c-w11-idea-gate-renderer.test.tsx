// @vitest-environment jsdom
/**
 * THE IDEA GATE'S RENDERER AFTER W11 (cinatra#3035, epic #3023 W11; plan (C)
 * §5.1, §8.4 "the gate renderer").
 *
 * "The renderer's silent first-idea default goes… it commits an artifact id and
 * revision, never a title." Two changes, both here: nothing is chosen for a
 * person who only presses continue, and what a pick commits is the reference the
 * reservation row is written from.
 *
 *   pnpm exec vitest run packages/agents/src/__tests__/lifecycle-c-w11-idea-gate-renderer.test.tsx
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { BlogIdeaSelectionRenderer } from "../blog-idea-selection-renderer";
import type { FieldRendererContext } from "../field-renderer-registry";

const CTX: FieldRendererContext = { connectedApps: [] };
const BINDING_ID = "@cinatra-ai/blog-pipeline-agent:idea-selection";
const GATE_SCHEMA = {
  type: "object",
  "x-renderer": BINDING_ID,
  properties: { selectedIdeaJson: { type: "string" } },
  required: ["selectedIdeaJson"],
};
const IDEAS = [
  {
    artifactId: "idea-a",
    representationRevisionId: "rev-a",
    title: "Shipping on Fridays",
    text: "Title: Shipping on Fridays\n\nWhy a Friday deploy is a habit.",
  },
  {
    artifactId: "idea-b",
    representationRevisionId: "rev-b",
    title: "Reading a run's own page",
    text: "Reading a run's own page\n\nWhat a run should show.",
  },
];

function renderChooser(value: unknown) {
  const onChange = vi.fn();
  render(
    <BlogIdeaSelectionRenderer
      fieldName="selectedIdeaJson"
      schema={GATE_SCHEMA as Record<string, unknown>}
      value={value}
      onChange={onChange}
      context={CTX}
    />,
  );
  return onChange;
}

afterEach(cleanup);

describe("W11 — nothing is picked for a person", () => {
  it("commits nothing on mount", () => {
    const onChange = renderChooser({ ideas: IDEAS });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows no idea as chosen until a person chooses one", () => {
    renderChooser({ ideas: IDEAS });
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio.getAttribute("aria-checked")).not.toBe("true");
    }
  });
});

describe("W11 — a pick commits the idea's reference, never its title", () => {
  it("commits the artifact id and the revision of the chosen idea", () => {
    const onChange = renderChooser({ ideas: IDEAS });
    fireEvent.click(screen.getAllByRole("radio")[1]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const committed = onChange.mock.calls[0][0] as {
      selectedIdeaJson: string;
      userResponse: string;
    };
    expect(committed.selectedIdeaJson).toBe(committed.userResponse);
    expect(JSON.parse(committed.selectedIdeaJson)).toEqual({
      artifactId: "idea-b",
      representationRevisionId: "rev-b",
    });
  });

  it("carries no title into what it commits", () => {
    const onChange = renderChooser({ ideas: IDEAS });
    fireEvent.click(screen.getAllByRole("radio")[0]);
    const committed = onChange.mock.calls[0][0] as { selectedIdeaJson: string };
    expect(committed.selectedIdeaJson).not.toMatch(/Shipping on Fridays/);
  });

  it("re-commits the new reference when the pick changes", () => {
    const onChange = renderChooser({ ideas: IDEAS });
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getAllByRole("radio")[1]);
    const last = onChange.mock.calls.at(-1)?.[0] as { selectedIdeaJson: string };
    expect(JSON.parse(last.selectedIdeaJson).artifactId).toBe("idea-b");
  });

  it("offers no pick at all for an idea with no reference", () => {
    const onChange = renderChooser({
      ideas: [{ title: "no reference" }],
      reason: "There is no blog idea left to draft.",
    });
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("W11 — an empty list ends the run with a reason", () => {
  it("states the reason instead of drawing a chooser", () => {
    renderChooser({
      ideas: [],
      reason: "There is no blog idea left to draft: every stored idea already has a draft.",
    });
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByText(/no blog idea left to draft/i)).toBeTruthy();
  });
});

/**
 * THE REAL EMITTED SPEC — the pause the runtime actually parked this pack on.
 *
 * Both constants below are copied VERBATIM out of the durable gate row the host
 * wrote for the parked Blog Pipeline Agent run (`cinatra.agent_run_hitl_gates`,
 * review_task_id `wayflow-92b67227-5457-47a0-b557-d87eaa6077ea`, x_renderer
 * `@cinatra-ai/blog-pipeline-agent:idea-selection`): `input_schema` and
 * `gate_values` exactly as stored. The envelope carries NO `ideas` key and NO
 * `reason` — the runtime delivered neither — so this is the reading a person
 * really got on that page.
 *
 * The ratified drawing gives that reading (the stored-ideas step): "An empty
 * list draws no rows and no Continue: it states that no idea is left to draft
 * and that the run ends here, because there is nothing to pick." A generic
 * response field with a Continue over it is the one shape this step may not
 * draw, because it is a way to settle the run's subject without a row being
 * picked.
 */
const REAL_EMITTED_SCHEMA = {
  type: "object",
  properties: {
    selectedIdeaJson: {
      type: "string",
      title: "Selected idea (JSON)",
    },
  },
  "x-renderer": "@cinatra-ai/blog-pipeline-agent:idea-selection",
};
const REAL_EMITTED_VALUES = {
  brief: "Practical ways small teams keep their internal notes tidy.",
  ideaCount: 3,
  stepNumber: 1,
};

describe("W11 — the runtime's real emitted spec draws no field and no Continue", () => {
  function renderRealPause() {
    const onChange = vi.fn();
    render(
      <BlogIdeaSelectionRenderer
        fieldName="selectedIdeaJson"
        schema={REAL_EMITTED_SCHEMA as Record<string, unknown>}
        value={REAL_EMITTED_VALUES}
        onChange={onChange}
        context={CTX}
      />,
    );
    return onChange;
  }

  it("draws no rows", () => {
    renderRealPause();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("draws no Continue of its own", () => {
    renderRealPause();
    expect(
      screen.queryAllByRole("button", { name: /continue|submit/i }),
    ).toHaveLength(0);
  });

  it("offers no free-text way to settle the run's subject without a pick", () => {
    renderRealPause();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("spinbutton")).toHaveLength(0);
  });

  it("says there is nothing to pick rather than leaving the page blank", () => {
    renderRealPause();
    expect(screen.getByRole("status").textContent ?? "").toMatch(/nothing to pick/i);
  });

  it("commits nothing at all", () => {
    const onChange = renderRealPause();
    expect(onChange).not.toHaveBeenCalled();
  });
});
