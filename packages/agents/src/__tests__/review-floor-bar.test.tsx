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
import { REVIEW_FLOOR_LABELS } from "@/lib/artifacts/review-surface-model";
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

describe("acceptance item 5 — a picture's prompt is its own field", () => {
  it("draws no prompt field when the reviewed revision is not a picture", () => {
    renderBar();
    expect(screen.queryByTestId("review-regenerate-prompt")).toBeNull();
  });

  it("draws the prompt PRE-FILLED beside the note, and carries the two separately", async () => {
    const { submitAction } = renderBar(
      { kind: "changes-requested", status: "requested", idempotent: false },
      { canDecide: true, canComment: true },
      { picturePrompt: "a red bicycle" },
    );
    const promptField = screen.getByTestId("review-regenerate-prompt") as HTMLTextAreaElement;
    expect(promptField.value).toBe("a red bicycle");

    fireEvent.change(screen.getByTestId("review-rationale"), { target: { value: "warmer light" } });
    fireEvent.change(promptField, { target: { value: "a red bicycle at golden hour" } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    expect(firstInput(submitAction)).toMatchObject({
      disposition: "regenerate",
      comment: "warmer light",
      regeneratePrompt: "a red bicycle at golden hour",
    });
  });

  it("sends no prompt with a Comment or a Continue — only Regenerate carries it", async () => {
    const { submitAction } = renderBar(
      { kind: "annotated" },
      { canDecide: true, canComment: true },
      { picturePrompt: "a red bicycle" },
    );
    fireEvent.change(screen.getByTestId("review-rationale"), { target: { value: "a thought" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    expect(firstInput(submitAction).regeneratePrompt ?? null).toBeNull();
  });
});
