// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// §I INPUT HIERARCHY — the decision bar's note field is SUBORDINATE (#2865).
// ---------------------------------------------------------------------------
// Design: `specs/app-lifecycle-cards.html` §I at
// 60b27dfbb8a2a1594e6e88333cc5c048c244e640 (the `.notefield` / `.nf-input`
// rules).
//
// The drawing's rule is that exactly ONE primary input is drawn per
// conversation and it is the chat box; every field a card carries is drawn
// subordinate to it. What makes an input read as somewhere to type is a closed
// list of three things — the enclosing box, the raised ground and the send
// affordance — so this file pins BOTH directions: the dashed baseline is there,
// and none of the three came back. The negative matters more than the positive:
// a later "tidy" that restored the stock bordered `Textarea` would still show a
// dashed bottom edge under a naive positive-only check, because the stock box
// draws all four edges.
//
// Label and placeholder are asserted BYTE-IDENTICAL: this slice moves weight,
// it does not reword the field.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The shipped bar calls `router.refresh()` after a landed decision; jsdom has
// no router mounted, so the seam is stubbed and the bar never navigates.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import type { ReviewSubmitOutcome } from "@/lib/artifacts/review-surface-model";
import { ReviewDecisionBar } from "../review-decision-bar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOTE_FIELD = '[data-conformance-id="review-note-field-subordinate"]';

function renderBar(
  outcome: ReviewSubmitOutcome = { kind: "annotated" },
  permissions = { canDecide: true, canComment: true },
) {
  const submitAction = vi.fn(async () => outcome);
  const result = render(
    <ReviewDecisionBar permissions={permissions} submitAction={submitAction} />,
  );
  return { ...result, submitAction };
}

/** The field's classes as the browser sees them, after `cn` has merged them. */
function classesOf(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

function noteField(): HTMLElement {
  return screen.getByTestId("review-rationale");
}

describe("§I — the note field carries the subordinate treatment (#2865)", () => {
  it("names itself with the §I conformance id", () => {
    const { container } = renderBar();
    const wrapper = container.querySelector(NOTE_FIELD);
    expect(wrapper, "the §I subordinate note-field wrapper").not.toBeNull();
    // The field itself lives inside the region that claims the id.
    expect(wrapper!.contains(noteField())).toBe(true);
  });

  it("draws the dashed baseline on transparent ground, flush left, muted 12px", () => {
    renderBar();
    const classes = classesOf(noteField());
    for (const cls of [
      // the drawing's `.nf-input`: border:0; border-bottom:1px dashed var(--line)
      "border-0",
      "border-b",
      "border-dashed",
      "border-line",
      // border-radius: 0; background: transparent; flush-left
      "rounded-none",
      "bg-transparent",
      "dark:bg-transparent",
      "px-0",
      // font-size: 12px; color: var(--muted)
      "text-xs",
      "md:text-xs",
      "text-muted-foreground",
      // the raised ground the chat box keeps and this field gives up
      "shadow-none",
    ]) {
      expect(classes, `expected the note field to carry \`${cls}\``).toContain(cls);
    }
  });

  it("NEGATIVE — renders no bordered box: no all-sides border, no radius, no fill, no elevation, no ring, no send control", () => {
    const { container } = renderBar();
    const field = noteField();
    const classes = classesOf(field);

    // The stock `Textarea` box, class by class — every one of these must have
    // been merged away rather than merely overdrawn.
    expect(classes, "the all-sides border").not.toContain("border");
    expect(
      classes.filter((c) => /^rounded-(?!none$)/.test(c)),
      "a corner radius (the box's silhouette)",
    ).toEqual([]);
    expect(
      classes.filter((c) => /^(dark:)?bg-(?!transparent$)/.test(c)),
      "a raised/filled ground",
    ).toEqual([]);
    expect(
      classes.filter((c) => /^shadow-(?!none$)/.test(c)),
      "an elevation shadow",
    ).toEqual([]);
    // A focus ring is a box drawn on focus, so the WIDTH goes to zero. The
    // inert `ring-ring/50` colour the base keeps paints nothing at width 0, and
    // focus stays visible: the base's `focus-visible:border-ring` recolours the
    // dashed rule itself.
    expect(
      classes.filter((c) => /^focus-visible:ring-\d/.test(c)),
      "a focus ring (a box drawn on focus is still a box)",
    ).toEqual(["focus-visible:ring-0"]);

    // The third thing an input-to-type carries: something to press to send.
    // The note field's region has none — the decision floor's buttons sit
    // OUTSIDE it, which is what this scoping check proves.
    const wrapper = container.querySelector(NOTE_FIELD)!;
    expect(wrapper.querySelector("button"), "a send affordance").toBeNull();
    expect(wrapper.querySelectorAll("textarea, input")).toHaveLength(1);
  });

  it("keeps the label and the placeholder byte-identical", () => {
    const { container } = renderBar();
    const label = container.querySelector("label[for='review-rationale']")!;
    expect(label.textContent).toBe(
      "Decision rationale (optional on approve, expected on reject)",
    );
    // The drawing's mono, 9px, wide-tracked, uppercase label — unchanged.
    const labelClasses = classesOf(label);
    for (const cls of ["font-mono", "uppercase", "tracking-widest", "text-muted-foreground"]) {
      expect(labelClasses).toContain(cls);
    }
    expect(noteField().getAttribute("placeholder")).toBe(
      "Add a note for the run and the audit trail…",
    );
  });

  it("DISABLED/SETTLED — keeps the same dashed rule at the platform's standard disabled opacity", async () => {
    renderBar({ kind: "decided", disposition: "approve", idempotent: false });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect((noteField() as HTMLTextAreaElement).disabled).toBe(true),
    );

    const classes = classesOf(noteField());
    // Same rule …
    expect(classes).toContain("border-b");
    expect(classes).toContain("border-dashed");
    // … the platform's standard disabled opacity, and nothing else …
    expect(classes).toContain("disabled:opacity-50");
    // … in particular the stock filled disabled ground never comes back,
    // which would put the box back exactly where §I took it out.
    expect(classes).toContain("disabled:bg-transparent");
    expect(classes).toContain("dark:disabled:bg-transparent");
    expect(
      classes.filter((c) => /^(dark:)?disabled:bg-(?!transparent$)/.test(c)),
    ).toEqual([]);
  });
});

describe("§I — the rationale plumbing is untouched (#2865 acceptance 4)", () => {
  it("still carries the typed note into the decision it rides", async () => {
    const { submitAction } = renderBar();
    fireEvent.change(noteField(), { target: { value: "  reads fine  " } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    expect(submitAction).toHaveBeenCalledWith({
      disposition: "comment",
      comment: "reads fine",
    });
  });

  it("still sends `null` for an empty note", async () => {
    const { submitAction } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    expect(submitAction).toHaveBeenCalledWith({ disposition: "comment", comment: null });
  });
});
