// @vitest-environment jsdom
/**
 * cinatra#3452 — the Setup step's OPTIONAL numeric field, left empty.
 *
 * The drawing (specs/app-setup.html): "If a step offered an optional field and
 * the operator left it blank, the step is still done and still carries its
 * check," and "submitting Continue is what persists the step's input, validates
 * it, and moves the wizard forward ... reports failure inline on the field".
 *
 * Measured before this fix: leaving the optional idea-count box empty and
 * pressing Continue drew the refusal
 * `Setup approval rejected: fieldName "ideaCount" is not present in the
 * submitted values` inline on the field, and the wizard did not advance. The
 * client half of that chain is here: the empty box emits `undefined`, and an
 * undefined-valued key does not survive the Server Action boundary — so the
 * submission that reached the approval road did not name the field at all, and
 * the road could not tell an optional box left blank from a field nobody was
 * ever offered.
 *
 * This test renders the step's field and drives the REAL submit road the
 * per-field Setup panels run (`wrapPrimitiveSetupPayload`, then serialization),
 * with the approval road's own rule as the far side: a submission carrying no
 * value for the gate's field is refused only when the agent declared that field
 * required.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/schema-field-renderer-optional-number-empty.test.tsx
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  ArrowRight: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "arrow-right", className }),
  ChevronDown: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "chevron-down", className }),
  ChevronUp: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "chevron-up", className }),
  Check: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "check", className }),
  X: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "x", className }),
  Loader2: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "loader2", className }),
}));

import { SchemaFieldRenderer } from "../schema-field-renderer";
import { wrapPrimitiveSetupPayload } from "../hitl-gate-submit";

const BASE_CONTEXT = { connectedApps: [] as string[] };

/**
 * The Server Action boundary. A payload handed to a "use server" action is
 * serialized on the way over; an undefined-valued key does not arrive at all.
 */
function acrossTheServerActionBoundary(payload: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload ?? null)) as Record<string, unknown>;
}

/**
 * The approval road's rule, as the server states it in
 * `review-task-actions.ts` (approveReviewTaskInternal, the single-field setup
 * path): a submission that carries no value for the gate's field is refused
 * ONLY when the template declares that field required AND declares no default
 * for it. A field that declares a default is satisfied by that default; a
 * field declared optional is taken as absent. Either way the step continues.
 */
function approveSetupField(
  fieldName: string,
  values: Record<string, unknown>,
  declaredRequired: string[],
  declaredDefaults: Record<string, unknown> = {},
): Record<string, unknown> {
  const noValueGiven =
    !(fieldName in values) ||
    values[fieldName] === null ||
    values[fieldName] === undefined;
  if (!noValueGiven) return { [fieldName]: values[fieldName] };
  if (fieldName in declaredDefaults) {
    // "absent (or its declared default)" — the default is what the run carries.
    return { [fieldName]: declaredDefaults[fieldName] };
  }
  if (declaredRequired.includes(fieldName)) {
    throw new Error(
      `Setup approval rejected: fieldName "${fieldName}" is not present in the submitted values`,
    );
  }
  return {};
}

/** The Setup step: one field, and what the wizard draws after Continue. */
function SetupStep({
  fieldName,
  required,
  declaredRequired,
  declaredDefaults,
  onSubmitted,
  onMerged,
}: {
  fieldName: string;
  required: boolean;
  declaredRequired: string[];
  declaredDefaults?: Record<string, unknown>;
  onSubmitted?: (submitted: Record<string, unknown>) => void;
  onMerged?: (merged: Record<string, unknown>) => void;
}) {
  const [advanced, setAdvanced] = React.useState(false);
  if (advanced) return <p>Schedule this run</p>;
  // cinatra#3582 — the field's own schema states what the agent declared,
  // including the DEFAULT: both input-schema roads copy `default` onto the
  // property, and the renderer now reads it (a required field that declares a
  // default is answered by that default, so the empty box still submits —
  // exactly what the second test below is about).
  const declaredDefault = declaredDefaults?.[fieldName];
  return (
    <SchemaFieldRenderer
      fieldName={fieldName}
      schema={
        declaredDefault === undefined
          ? { type: "integer", title: "Idea count" }
          : { type: "integer", title: "Idea count", default: declaredDefault }
      }
      value=""
      required={required}
      onChange={async (next: unknown) => {
        // The submit road the per-field Setup panels run
        // (orchestrator-stepper-panel.tsx / agent-hitl-screen-card.tsx).
        const { payload, payloadFieldName } = wrapPrimitiveSetupPayload(fieldName, next);
        const submitted = acrossTheServerActionBoundary(payload);
        onSubmitted?.(submitted);
        // Called, never as the argument of an optional call: `f?.(g())` does
        // not evaluate `g()` when `f` is undefined, which would skip the
        // approval road entirely in a test that passes no onMerged.
        const merged = approveSetupField(
          payloadFieldName as string,
          submitted,
          declaredRequired,
          declaredDefaults,
        );
        onMerged?.(merged);
        setAdvanced(true);
      }}
      context={BASE_CONTEXT}
    />
  );
}

describe("SchemaFieldRenderer — an optional numeric Setup field left empty (cinatra#3452)", () => {
  afterEach(() => {
    cleanup();
  });

  it("submits the empty OPTIONAL idea count as an explicit empty and continues to the next step", async () => {
    const submissions: Array<Record<string, unknown>> = [];
    render(
      <SetupStep
        fieldName="ideaCount"
        required={false}
        declaredRequired={["brief"]}
        onSubmitted={(s) => submissions.push(s)}
      />,
    );

    // The box is empty and the field is drawn as optional.
    const input = screen.getByLabelText(/Idea count/i) as HTMLInputElement;
    expect(input.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));

    // The step is done: the wizard draws the next step and no refusal appears.
    await waitFor(() => {
      expect(screen.queryByText(/Schedule this run/i)).not.toBeNull();
    });
    expect(screen.queryByText(/is not present in the submitted values/i)).toBeNull();

    // ...and the submission that crossed the boundary still NAMES the field,
    // carrying no value — the empty box is an answer the approval road can read
    // as such, not a field that never reached it.
    expect(submissions).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(submissions[0], "ideaCount")).toBe(true);
    expect(submissions[0].ideaCount).toBeNull();
  });

  it("THE REPORTED CASE: the idea count declares a default, is left empty, and the step continues carrying that default", async () => {
    // The shape the Blog Pipeline Agent actually declares: `ideaCount` is in
    // the StartNode `required` list AND carries `default: 5`.
    const merges: Array<Record<string, unknown>> = [];
    const submissions: Array<Record<string, unknown>> = [];
    render(
      <SetupStep
        fieldName="ideaCount"
        required={true}
        declaredRequired={["brief", "ideaCount"]}
        declaredDefaults={{ ideaCount: 5 }}
        onSubmitted={(s) => submissions.push(s)}
        onMerged={(m) => merges.push(m)}
      />,
    );

    const input = screen.getByLabelText(/Idea count/i) as HTMLInputElement;
    expect(input.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));

    await waitFor(() => {
      expect(screen.queryByText(/Schedule this run/i)).not.toBeNull();
    });
    expect(screen.queryByText(/is not present in the submitted values/i)).toBeNull();
    expect(merges).toEqual([{ ideaCount: 5 }]);
    // The submission that crossed the boundary still NAMES the field, carrying
    // no value: "the person answered this field, with nothing" is what the
    // approval road reads to reach for the declared default.
    expect(submissions).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(submissions[0], "ideaCount")).toBe(true);
    expect(submissions[0].ideaCount).toBeNull();
  });

  it("still refuses Continue for a REQUIRED field with NO declared default left empty, naming that field", async () => {
    render(
      <SetupStep
        fieldName="ideaCount"
        required={true}
        declaredRequired={["brief", "ideaCount"]}
      />,
    );

    // cinatra#3582 — the refusal now stands ONE DOOR EARLIER. A field the agent
    // declares required and for which it declares no default cannot be
    // continued blank at all: the Continue is unavailable while the box is
    // empty, so the submission never reaches the approval road, and the field
    // is not drawn as "(optional)". The SERVER's own refusal, naming the field
    // whatever a client sends, is pinned in approve-setup-field.test.ts and in
    // setup-required-start-field-is-gated-for-every-kind.test.tsx.
    const continueButton = screen.getByRole("button", {
      name: /Continue/i,
    }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
    fireEvent.click(continueButton);
    await waitFor(() => {
      expect(screen.getByLabelText(/Idea count/i)).not.toBeNull();
    });

    expect(screen.queryByText(/Schedule this run/i)).toBeNull();
    const label = screen.getByText(/Idea count/i);
    expect(label.textContent ?? "").not.toMatch(/\(optional\)/);
  });
});
