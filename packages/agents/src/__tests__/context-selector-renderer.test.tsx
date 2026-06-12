// @vitest-environment jsdom
/**
 * ContextSelector HITL renderer tests.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/context-selector-renderer.test.tsx
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";
import {
  ContextSelectorRenderer,
  groupCandidatesByScope,
  type ContextSelectorCandidate,
  type ContextSelectorValue,
} from "../context-selector-renderer";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

afterEach(cleanup);

const CANDIDATE_USER: ContextSelectorCandidate = {
  artifactId: "art-user",
  representationRevisionId: "rep-user",
  semanticAssertionId: "sa-user",
  extension: "@cinatra-ai/marketing-icp-artifact",
  sourceScope: "user",
  ownerId: "user-1",
  displayName: "My ICP",
};

const CANDIDATE_ORG: ContextSelectorCandidate = {
  artifactId: "art-org",
  representationRevisionId: "rep-org",
  semanticAssertionId: "sa-org",
  extension: "@cinatra-ai/marketing-icp-artifact",
  sourceScope: "organization",
  ownerId: "org-a",
  displayName: "Default ICP",
};

const CANDIDATE_PROJECT: ContextSelectorCandidate = {
  artifactId: "art-proj",
  representationRevisionId: "rep-proj",
  semanticAssertionId: "sa-proj",
  extension: "@cinatra-ai/marketing-icp-artifact",
  sourceScope: "project",
  ownerId: "user-1",
  displayName: "Project ICP",
};

describe("context-selector registry resolution (condition)", () => {
  // The condition is registry-driven (cinatra#151 Stage 5): the canonical id
  // comes from the context-selection-agent's manifest binding; the bare alias
  // from the host kind table.
  const resolveFor = (xRenderer: string) =>
    fieldRendererRegistry.resolve(
      "field",
      { "x-renderer": xRenderer },
      { connectedApps: [] },
    );
  it("matches the canonical x-renderer id", () => {
    ensureDefaultFieldRenderersRegistered();
    expect(
      resolveFor("@cinatra-ai/context-selection-agent:context-selector")?.renderer,
    ).toBe(ContextSelectorRenderer);
  });
  it("matches the bare alias", () => {
    ensureDefaultFieldRenderersRegistered();
    expect(resolveFor("context-selector")?.renderer).toBe(ContextSelectorRenderer);
  });
  it("does NOT match unrelated renderers", () => {
    ensureDefaultFieldRenderersRegistered();
    expect(resolveFor("list-picker")?.renderer ?? null).not.toBe(ContextSelectorRenderer);
  });
});

describe("groupCandidatesByScope", () => {
  it("orders groups project→user→team→org→workspace", () => {
    const groups = groupCandidatesByScope([
      CANDIDATE_ORG,
      CANDIDATE_USER,
      CANDIDATE_PROJECT,
    ]);
    expect(groups.map((g) => g.scope)).toEqual([
      "project",
      "user",
      "organization",
    ]);
  });
  it("preserves order within a single group", () => {
    const a = { ...CANDIDATE_USER, artifactId: "art-a" };
    const b = { ...CANDIDATE_USER, artifactId: "art-b" };
    const groups = groupCandidatesByScope([a, b]);
    expect(groups[0].refs.map((r) => r.artifactId)).toEqual(["art-a", "art-b"]);
  });
});

describe("ContextSelectorRenderer — empty state", () => {
  it("renders an empty-state message when no candidates", () => {
    render(
      <ContextSelectorRenderer
        fieldName="offeringContext"
        schema={{} as never}
        value={{ candidates: [], selectedRefs: [] } satisfies ContextSelectorValue}
        onChange={vi.fn()}
        context={{ connectedApps: [] }}
      />,
    );
    expect(
      screen.getByText(/No eligible context artifacts available/i),
    ).toBeTruthy();
  });
});

describe("ContextSelectorRenderer — accumulate mode (multi-pick)", () => {
  it("renders one row per candidate grouped by scope", () => {
    render(
      <ContextSelectorRenderer
        fieldName="offeringContext"
        schema={{} as never}
        value={{
          candidates: [CANDIDATE_USER, CANDIDATE_ORG],
          selectedRefs: [],
          slotMeta: {
            slotId: "offeringContext",
            resolutionMode: "accumulate",
            selectionMode: "interactive",
            acceptedArtifactExtensions: [
              "@cinatra-ai/marketing-icp-artifact",
            ],
          },
        }}
        onChange={vi.fn()}
        context={{ connectedApps: [] }}
      />,
    );
    expect(screen.getByText("My ICP")).toBeTruthy();
    expect(screen.getByText("Default ICP")).toBeTruthy();
    expect(screen.getByText(/Combine \(accumulate\)/)).toBeTruthy();
  });

  it("toggles selection — multi-pick adds and removes", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ContextSelectorRenderer
        fieldName="offeringContext"
        schema={{} as never}
        value={{
          candidates: [CANDIDATE_USER, CANDIDATE_ORG],
          selectedRefs: [],
          slotMeta: {
            slotId: "offeringContext",
            resolutionMode: "accumulate",
            selectionMode: "interactive",
            acceptedArtifactExtensions: [
              "@cinatra-ai/marketing-icp-artifact",
            ],
          },
        }}
        onChange={onChange}
        context={{ connectedApps: [] }}
      />,
    );
    // Click "My ICP" checkbox.
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].selectedRefs).toHaveLength(1);
    expect(onChange.mock.calls[0][0].selectedRefs[0].artifactId).toBe("art-user");

    // Now rerender with my-icp selected; click again to deselect.
    rerender(
      <ContextSelectorRenderer
        fieldName="offeringContext"
        schema={{} as never}
        value={{
          candidates: [CANDIDATE_USER, CANDIDATE_ORG],
          selectedRefs: [CANDIDATE_USER],
          slotMeta: {
            slotId: "offeringContext",
            resolutionMode: "accumulate",
            selectionMode: "interactive",
            acceptedArtifactExtensions: [
              "@cinatra-ai/marketing-icp-artifact",
            ],
          },
        }}
        onChange={onChange}
        context={{ connectedApps: [] }}
      />,
    );
    const checkboxesAfter = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxesAfter[0]);
    expect(onChange.mock.calls[1][0].selectedRefs).toHaveLength(0);
  });

  it("respects maxItems — refuses to add beyond the cap", () => {
    const onChange = vi.fn();
    render(
      <ContextSelectorRenderer
        fieldName="offeringContext"
        schema={{} as never}
        value={{
          candidates: [CANDIDATE_USER, CANDIDATE_ORG, CANDIDATE_PROJECT],
          selectedRefs: [CANDIDATE_USER, CANDIDATE_ORG],
          slotMeta: {
            slotId: "offeringContext",
            resolutionMode: "accumulate",
            selectionMode: "interactive",
            maxItems: 2,
            acceptedArtifactExtensions: [
              "@cinatra-ai/marketing-icp-artifact",
            ],
          },
        }}
        onChange={onChange}
        context={{ connectedApps: [] }}
      />,
    );
    const checkboxes = screen.getAllByRole("checkbox");
    // Project candidate is the 3rd in order project→user→org grouping.
    // But the project group renders FIRST (narrow→broad ordering).
    const checkBoxByLabel = (name: string) =>
      within(screen.getByLabelText(`Select ${name}`).closest("label")!).getByRole(
        "checkbox",
      );
    fireEvent.click(checkBoxByLabel("Project ICP"));
    // Add-beyond-cap → onChange should NOT fire.
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ContextSelectorRenderer — override mode (single-pick)", () => {
  it("clicking a second candidate REPLACES the first selection", () => {
    const onChange = vi.fn();
    render(
      <ContextSelectorRenderer
        fieldName="offeringContext"
        schema={{} as never}
        value={{
          candidates: [CANDIDATE_USER, CANDIDATE_ORG],
          selectedRefs: [CANDIDATE_USER],
          slotMeta: {
            slotId: "offeringContext",
            resolutionMode: "override",
            selectionMode: "interactive",
            acceptedArtifactExtensions: [
              "@cinatra-ai/marketing-icp-artifact",
            ],
          },
        }}
        onChange={onChange}
        context={{ connectedApps: [] }}
      />,
    );
    const checkboxes = screen.getAllByRole("checkbox");
    // Click the second (org) — should replace, not add.
    fireEvent.click(checkboxes[1]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].selectedRefs).toHaveLength(1);
    expect(onChange.mock.calls[0][0].selectedRefs[0].artifactId).toBe("art-org");
  });

  it("header shows 'Pick one (override)'", () => {
    render(
      <ContextSelectorRenderer
        fieldName="offeringContext"
        schema={{} as never}
        value={{
          candidates: [CANDIDATE_USER],
          selectedRefs: [],
          slotMeta: {
            slotId: "offeringContext",
            resolutionMode: "override",
            selectionMode: "interactive",
            acceptedArtifactExtensions: [
              "@cinatra-ai/marketing-icp-artifact",
            ],
          },
        }}
        onChange={vi.fn()}
        context={{ connectedApps: [] }}
      />,
    );
    expect(screen.getByText(/Pick one \(override\)/)).toBeTruthy();
  });
});

describe("ContextSelectorRenderer — readableOnly badge", () => {
  it("shows the readable-only badge when slot.readableOnly = true", () => {
    render(
      <ContextSelectorRenderer
        fieldName="offeringContext"
        schema={{} as never}
        value={{
          candidates: [CANDIDATE_USER],
          selectedRefs: [],
          slotMeta: {
            slotId: "offeringContext",
            resolutionMode: "accumulate",
            selectionMode: "interactive",
            readableOnly: true,
            acceptedArtifactExtensions: [
              "@cinatra-ai/marketing-icp-artifact",
            ],
          },
        }}
        onChange={vi.fn()}
        context={{ connectedApps: [] }}
      />,
    );
    expect(screen.getByText(/readable-only/i)).toBeTruthy();
  });
});

describe("ContextSelectorRenderer — payload and validation invariants", () => {
  it("onChange payload includes userResponse with JSON-encoded selectedRefs", () => {
    const onChange = vi.fn();
    render(
      <ContextSelectorRenderer
        fieldName="offeringContext"
        schema={{} as never}
        value={{
          candidates: [CANDIDATE_USER, CANDIDATE_ORG],
          selectedRefs: [],
          slotMeta: {
            slotId: "offeringContext",
            resolutionMode: "accumulate",
            selectionMode: "interactive",
            acceptedArtifactExtensions: [
              "@cinatra-ai/marketing-icp-artifact",
            ],
          },
        }}
        onChange={onChange}
        context={{ connectedApps: [] }}
      />,
    );
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const payload = onChange.mock.calls[0][0];
    expect(typeof payload.userResponse).toBe("string");
    const decoded = JSON.parse(payload.userResponse);
    expect(decoded.slotId).toBe("offeringContext");
    expect(decoded.resolutionMode).toBe("accumulate");
    expect(decoded.selectedRefs).toHaveLength(1);
    expect(decoded.selectedRefs[0].artifactId).toBe("art-user");
  });

  it("selection identity uses (artifactId, representationRevisionId, semanticAssertionId) triple", () => {
    // Two candidates share the same artifactId but DIFFERENT
    // representationRevisionId + semanticAssertionId — they MUST remain
    // distinct selections, not collapse to one.
    const sameArtifactA: ContextSelectorCandidate = {
      ...CANDIDATE_USER,
      semanticAssertionId: "sa-alt-1",
      representationRevisionId: "rep-alt-1",
    };
    const sameArtifactB: ContextSelectorCandidate = {
      ...CANDIDATE_USER,
      semanticAssertionId: "sa-alt-2",
      representationRevisionId: "rep-alt-2",
    };
    const onChange = vi.fn();
    render(
      <ContextSelectorRenderer
        fieldName="offeringContext"
        schema={{} as never}
        value={{
          candidates: [sameArtifactA, sameArtifactB],
          selectedRefs: [sameArtifactA],
          slotMeta: {
            slotId: "offeringContext",
            resolutionMode: "accumulate",
            selectionMode: "interactive",
            acceptedArtifactExtensions: [
              "@cinatra-ai/marketing-icp-artifact",
            ],
          },
        }}
        onChange={onChange}
        context={{ connectedApps: [] }}
      />,
    );
    // Two checkboxes — A is checked, B is unchecked (they share
    // artifactId but the composite key differs).
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    // shadcn / Radix Checkbox is a <button role=checkbox> — use
    // aria-checked / data-state instead of `.checked` (which is
    // undefined on a non-<input> element).
    expect(checkboxes[0].getAttribute("aria-checked")).toBe("true");
    expect(checkboxes[1].getAttribute("aria-checked")).toBe("false");
    // Click B — should ADD (not toggle A off).
    fireEvent.click(checkboxes[1]);
    const next = onChange.mock.calls[0][0];
    expect(next.selectedRefs).toHaveLength(2);
  });

  it("required slot with empty candidates shows destructive 'cannot proceed' copy", () => {
    render(
      <ContextSelectorRenderer
        fieldName="offeringContext"
        schema={{} as never}
        value={{
          candidates: [],
          selectedRefs: [],
          slotMeta: {
            slotId: "offeringContext",
            resolutionMode: "accumulate",
            selectionMode: "interactive",
            minItems: 1,
            acceptedArtifactExtensions: [
              "@cinatra-ai/marketing-icp-artifact",
            ],
          },
        }}
        onChange={vi.fn()}
        context={{ connectedApps: [] }}
      />,
    );
    expect(screen.getByText(/requires at least 1 context/i)).toBeTruthy();
    expect(screen.getByText(/agent cannot proceed/i)).toBeTruthy();
  });

  it("unchecked checkboxes are DISABLED when at maxItems cap (accumulate mode)", () => {
    render(
      <ContextSelectorRenderer
        fieldName="offeringContext"
        schema={{} as never}
        value={{
          candidates: [CANDIDATE_USER, CANDIDATE_ORG, CANDIDATE_PROJECT],
          selectedRefs: [CANDIDATE_USER, CANDIDATE_ORG],
          slotMeta: {
            slotId: "offeringContext",
            resolutionMode: "accumulate",
            selectionMode: "interactive",
            maxItems: 2,
            acceptedArtifactExtensions: [
              "@cinatra-ai/marketing-icp-artifact",
            ],
          },
        }}
        onChange={vi.fn()}
        context={{ connectedApps: [] }}
      />,
    );
    // Project candidate is unchecked + at cap → must be disabled.
    const projectCheckbox = within(
      screen.getByLabelText("Select Project ICP").closest("label")!,
    ).getByRole("checkbox") as HTMLButtonElement;
    expect(projectCheckbox.hasAttribute("disabled")).toBe(true);
    // The "maximum selected" hint appears.
    expect(screen.getByText(/maximum selected/i)).toBeTruthy();
  });

  it("minItems unmet hint appears when below the floor", () => {
    render(
      <ContextSelectorRenderer
        fieldName="offeringContext"
        schema={{} as never}
        value={{
          candidates: [CANDIDATE_USER, CANDIDATE_ORG],
          selectedRefs: [],
          slotMeta: {
            slotId: "offeringContext",
            resolutionMode: "accumulate",
            selectionMode: "interactive",
            minItems: 1,
            acceptedArtifactExtensions: [
              "@cinatra-ai/marketing-icp-artifact",
            ],
          },
        }}
        onChange={vi.fn()}
        context={{ connectedApps: [] }}
      />,
    );
    expect(screen.getByText(/need at least 1/i)).toBeTruthy();
  });
});

describe("ContextSelectorRenderer — clear selection", () => {
  it("Clear button emits a FRESH userResponse JSON envelope (no stale payload)", () => {
    const onChange = vi.fn();
    render(
      <ContextSelectorRenderer
        fieldName="offeringContext"
        schema={{} as never}
        value={{
          candidates: [CANDIDATE_USER, CANDIDATE_ORG],
          selectedRefs: [CANDIDATE_USER, CANDIDATE_ORG],
          slotMeta: {
            slotId: "offeringContext",
            resolutionMode: "accumulate",
            selectionMode: "interactive",
            acceptedArtifactExtensions: [
              "@cinatra-ai/marketing-icp-artifact",
            ],
          },
        }}
        onChange={onChange}
        context={{ connectedApps: [] }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const payload = onChange.mock.calls[0][0];
    expect(payload.selectedRefs).toHaveLength(0);
    // Critical: userResponse MUST be re-emitted with the empty
    // selectedRefs encoded — NOT left stale at the previous JSON.
    expect(typeof payload.userResponse).toBe("string");
    const decoded = JSON.parse(payload.userResponse);
    expect(decoded.selectedRefs).toEqual([]);
    expect(decoded.slotId).toBe("offeringContext");
    expect(decoded.resolutionMode).toBe("accumulate");
  });
});

describe("ContextSelectorRenderer — disabled state", () => {
  it("clicks are no-op when disabled=true", () => {
    const onChange = vi.fn();
    render(
      <ContextSelectorRenderer
        fieldName="offeringContext"
        schema={{} as never}
        value={{
          candidates: [CANDIDATE_USER],
          selectedRefs: [],
          slotMeta: {
            slotId: "offeringContext",
            resolutionMode: "accumulate",
            selectionMode: "interactive",
            acceptedArtifactExtensions: [
              "@cinatra-ai/marketing-icp-artifact",
            ],
          },
        }}
        onChange={onChange}
        disabled={true}
        context={{ connectedApps: [] }}
      />,
    );
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(onChange).not.toHaveBeenCalled();
  });
});
