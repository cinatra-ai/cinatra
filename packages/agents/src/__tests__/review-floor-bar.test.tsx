// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// THE FLOOR AS DRAWN — Comment · Regenerate · Continue (cinatra#3080).
// ---------------------------------------------------------------------------
// `ReviewDecisionBar` is the ONE floor every review surface mounts — the card in
// the chat thread, the review page's gate region, the run page's review step and
// the card inside a third-party application — so pinning it here pins all four
// (the per-surface proof that each really mounts THIS component is the source
// conformance suite, `review-floor-surfaces.test.ts`).
//
// The negative half is the load-bearing half: a pending review must draw NEITHER
// Reject NOR Approve. A relabel that left the old buttons behind under new names,
// or a "tidy" that restored the destructive button, would still satisfy a
// positive-only check.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import type { ReviewSubmitOutcome } from "@/lib/artifacts/review-surface-model";
import type { ReviewFloorSubmission } from "@/lib/artifacts/review-surface-model";
import { REGENERATE_NEEDS_A_NOTE, REVIEW_FLOOR_LABELS } from "@/lib/artifacts/review-surface-model";
import { ReviewDecisionBar } from "../review-decision-bar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderBar(
  outcome: ReviewSubmitOutcome = { kind: "annotated" },
  permissions = { canDecide: true, canComment: true },
  extra: Record<string, unknown> = {},
) {
  /** The floor's payload, as the ONE server entry receives it. */
  type FloorInput = {
    disposition: ReviewFloorSubmission;
    comment: string | null;
    regeneratePrompt?: string | null;
  };
  const submitAction = vi.fn(async (_input: FloorInput) => outcome);
  const result = render(
    <ReviewDecisionBar permissions={permissions} submitAction={submitAction} {...extra} />,
  );
  return { ...result, submitAction };
}

/** The first payload the bar submitted — narrowed, so the assertions below read
 *  as statements about the press rather than about the mock's tuple type. */
function firstInput(fn: { mock: { calls: unknown[][] } }): {
  disposition: string;
  comment: string | null;
  regeneratePrompt?: string | null;
  suggestionDecisions?: unknown;
} {
  const call = fn.mock.calls[0];
  if (!call) throw new Error("the bar submitted nothing");
  return call[0] as ReturnType<typeof firstInput>;
}

function buttonNames(): string[] {
  return screen.getAllByRole("button").map((b) => (b.textContent ?? "").trim());
}

describe("acceptance item 1 — a pending review draws exactly three actions", () => {
  it("draws Comment, Regenerate and Continue", () => {
    renderBar();
    for (const label of Object.values(REVIEW_FLOOR_LABELS)) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("draws NEITHER Reject NOR Approve", () => {
    renderBar();
    const names = buttonNames();
    expect(names).not.toContain("Reject");
    expect(names).not.toContain("Approve");
  });

  it("draws no fourth review action", () => {
    renderBar();
    expect(buttonNames().sort()).toEqual(["Comment", "Continue", "Regenerate"]);
  });
});

describe("acceptance item 2 — Continue submits the former approve", () => {
  it("submits `continue`, and the settled reading says Continued", async () => {
    const { submitAction } = renderBar({
      kind: "decided",
      disposition: "approve",
      idempotent: false,
    });
    fireEvent.change(screen.getByTestId("review-rationale"), { target: { value: "looks right" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    expect(firstInput(submitAction).disposition).toBe("continue");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Continued"),
    );
  });
});

describe("acceptance item 3 — Comment decides nothing", () => {
  it("submits `comment` and says the gate stays open", async () => {
    const { submitAction } = renderBar({ kind: "annotated" });
    fireEvent.change(screen.getByTestId("review-rationale"), { target: { value: "a thought" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    expect(firstInput(submitAction).disposition).toBe("comment");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("The gate stays open"),
    );
  });
});

describe("acceptance item 4 — Regenerate is a terminal act", () => {
  it("submits `regenerate` carrying the note", async () => {
    const { submitAction } = renderBar({
      kind: "changes-requested",
      status: "requested",
      idempotent: false,
    });
    fireEvent.change(screen.getByTestId("review-rationale"), { target: { value: "warmer light" } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    expect(firstInput(submitAction)).toMatchObject({
      disposition: "regenerate",
      comment: "warmer light",
    });
  });

  it("is disabled for a reader who may comment but not decide — like Continue, unlike Comment", () => {
    renderBar({ kind: "annotated" }, { canDecide: false, canComment: true });
    expect(screen.getByRole("button", { name: "Regenerate" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Comment" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("§VI — one note field; a picture's prompt opens in it (item 5, as drawn)", () => {
  // The drawing's paragraph "One note field, and it reads for both roads": the
  // floor carries ONE Note field whatever the decision. Where the producer holds
  // the words that made the reviewed revision — a picture's prompt — the field
  // opens carrying them; words the reader never touched are not filed as the
  // reader's on a Continue or a Comment; Regenerate sends the field's words both
  // as the note and, on a picture's review, as the picture's prompt.
  const CAN = { canDecide: true, canComment: true };
  const PICTURE = { picturePrompt: "a red bicycle" };
  const noteField = () => screen.getByTestId("review-rationale") as HTMLTextAreaElement;

  it("draws exactly ONE text field on a picture's review, opening with the picture's prompt", () => {
    renderBar({ kind: "annotated" }, CAN, PICTURE);
    const fields = screen.getAllByRole("textbox");
    expect(fields).toHaveLength(1);
    expect(fields[0]).toBe(noteField());
    expect(noteField().value).toBe("a red bicycle");
    expect(screen.queryByTestId("review-regenerate-prompt")).toBeNull();
    expect(
      document.querySelector('[data-conformance-id="review-regenerate-prompt-field"]'),
    ).toBeNull();
  });

  it("draws the one field EMPTY on a review that is not a picture", () => {
    renderBar();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(noteField().value).toBe("");
  });

  it("Regenerate after the words are edited sends them as the note AND as the picture's prompt", async () => {
    const { submitAction } = renderBar(
      { kind: "changes-requested", status: "requested", idempotent: false },
      CAN,
      PICTURE,
    );
    fireEvent.change(noteField(), { target: { value: "a red bicycle at golden hour" } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    expect(firstInput(submitAction)).toEqual({
      disposition: "regenerate",
      comment: "a red bicycle at golden hour",
      regeneratePrompt: "a red bicycle at golden hour",
    });
  });

  it("Regenerate over the untouched pre-filled field sends the prompt itself in both", async () => {
    const { submitAction } = renderBar(
      { kind: "changes-requested", status: "requested", idempotent: false },
      CAN,
      PICTURE,
    );
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    expect(firstInput(submitAction)).toEqual({
      disposition: "regenerate",
      comment: "a red bicycle",
      regeneratePrompt: "a red bicycle",
    });
  });

  it("Continue over the untouched pre-filled field records no note at all", async () => {
    const { submitAction } = renderBar(
      { kind: "decided", disposition: "approve", idempotent: false },
      CAN,
      PICTURE,
    );
    expect(noteField().value).toBe("a red bicycle");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    const input = firstInput(submitAction);
    expect(input.disposition).toBe("continue");
    expect(input.comment).toBeNull();
    expect(Object.keys(input)).not.toContain("regeneratePrompt");
  });

  it("Comment over the untouched pre-filled field records no note at all", async () => {
    const { submitAction } = renderBar({ kind: "annotated" }, CAN, PICTURE);
    expect(noteField().value).toBe("a red bicycle");
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    const input = firstInput(submitAction);
    expect(input.disposition).toBe("comment");
    expect(input.comment).toBeNull();
    expect(Object.keys(input)).not.toContain("regeneratePrompt");
  });

  it("Continue after the pre-filled field is edited carries the reader's words, and no prompt", async () => {
    const { submitAction } = renderBar(
      { kind: "decided", disposition: "approve", idempotent: false },
      CAN,
      PICTURE,
    );
    expect(noteField().value).toBe("a red bicycle");
    fireEvent.change(noteField(), { target: { value: "warmer light" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    const input = firstInput(submitAction);
    expect(input.disposition).toBe("continue");
    expect(input.comment).toBe("warmer light");
    expect(Object.keys(input)).not.toContain("regeneratePrompt");
  });

  it("Regenerate after the pre-filled field is emptied sends no words, and the refusal is shown", async () => {
    const { submitAction } = renderBar(
      { kind: "error", message: REGENERATE_NEEDS_A_NOTE },
      CAN,
      PICTURE,
    );
    expect(noteField().value).toBe("a red bicycle");
    fireEvent.change(noteField(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    const input = firstInput(submitAction);
    expect(input.disposition).toBe("regenerate");
    expect(input.comment).toBeNull();
    expect(Object.keys(input)).not.toContain("regeneratePrompt");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(REGENERATE_NEEDS_A_NOTE),
    );
  });

  it("Regenerate on a review that is not a picture sends the note alone, and no prompt", async () => {
    const { submitAction } = renderBar({
      kind: "changes-requested",
      status: "requested",
      idempotent: false,
    });
    fireEvent.change(noteField(), { target: { value: "warmer light" } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    const input = firstInput(submitAction);
    expect(input.disposition).toBe("regenerate");
    expect(input.comment).toBe("warmer light");
    expect(Object.keys(input)).not.toContain("regeneratePrompt");
  });
});

// ---------------------------------------------------------------------------
// THE NOTE FIELD'S OWN WORDS (cinatra#3080, the ratified drawing's §VI floor).
// ---------------------------------------------------------------------------
// The field had been labelled "Decision rationale (optional on Continue, expected
// on Regenerate)" over the placeholder "Add a note for the run and the audit
// trail…" — a paraphrase of the drawing rather than the drawing. The drawing's
// own words name the field for what it IS on this floor: one note, optional when
// the run simply goes on, and the material a Regenerate works from.
describe("the note field is labelled in the drawing's words", () => {
  it("carries the label and the placeholder exactly", () => {
    renderBar();
    const label = document.querySelector('label[for="review-rationale"]');
    expect(label).not.toBeNull();
    expect(label!.textContent!.replace(/\s+/g, " ").trim()).toBe(
      "Note (optional on Continue · the words a Regenerate works from)",
    );
    expect(screen.getByTestId("review-rationale").getAttribute("placeholder")).toBe(
      "Add a note, or say what to change before Regenerate…",
    );
  });

  it("keeps none of the paraphrase it replaced", () => {
    renderBar();
    const label = document.querySelector('label[for="review-rationale"]');
    expect(label!.textContent).not.toMatch(/rationale/i);
    expect(label!.textContent).not.toMatch(/expected on Regenerate/i);
    expect(screen.getByTestId("review-rationale").getAttribute("placeholder")).not.toMatch(
      /audit trail/i,
    );
  });
});
