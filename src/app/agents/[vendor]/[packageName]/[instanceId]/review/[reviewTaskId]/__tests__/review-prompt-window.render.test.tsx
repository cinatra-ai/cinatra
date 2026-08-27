// @vitest-environment jsdom
/**
 * THE REVIEW PAGE'S WINDOW, PROVEN BY RENDER (cinatra#2933, lifecycle-b W5b).
 *
 * The fifth of the five windows outside the chat. Its four siblings are
 * rendered by `packages/agents/src/__tests__/run-window-surfaces.render.test.tsx`
 * and the run page's production mount by `run-page-window-render.test.tsx`
 * beside it; this one lives here because the review window is a host-app
 * component and the root suite is the project that resolves it.
 *
 * Same two readings as its siblings:
 *
 *   AC1  the window is drawn, offering the ratified placeholder;
 *   AC3  a reader the gate would refuse is shown no box.
 *
 * On this surface the access answer is `canComment` — the review's own reading
 * of what this person may do with this gate.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * §X's OWN SENTENCE FOR THIS READING (design `458fb7ffce6c`,
 * `app-artifact-review.html`, "X. One window, five readings" — "The review page
 * — under the decision bar"). Character for character, ellipsis included.
 */
const REVIEW_SENTENCE =
  "Ask Cinatra about this review, or ask for changes to the work…";
/** Is a box drawn at all, whichever reading it is. */
const ANY_WINDOW_SENTENCE = /^Ask Cinatra /;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  // The real PromptField pulls browser-only deps jsdom cannot load. The stub
  // surfaces the placeholder as text. A <div>, not a raw <input>: the
  // design-system lint gate forbids the bare element.
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="run-window-prompt">{placeholder}</div>
  ),
}));

// The window's server bridge — the store has its own unit and real-database
// tiers. The shared panel and the one controller run for real.
vi.mock("@cinatra-ai/agents/run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ ok: true, entries: [] })),
}));

beforeEach(() => {
  cleanup();
  document.body.innerHTML = "";
  // The shared panel portals into <main>.
  document.body.appendChild(document.createElement("main"));
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function mount(canComment: boolean) {
  const { ReviewPromptWindow } = await import("../review-prompt-window");
  return render(
    <ReviewPromptWindow
      submitAction={vi.fn(async () => ({ ok: true }) as never)}
      storageKey="cinatra_review_window_run-2933"
      canComment={canComment}
      runId="run-2933"
      boundCardRef="gate-ref-2933"
    />,
  );
}

/** Give the portal effect and the controller's mount read a turn to settle. */
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('the review page ("review") is the fifth window (cinatra#2933)', () => {
  it("AC1 — draws the window, with the ratified placeholder", async () => {
    await mount(true);
    await settle();
    expect(screen.queryByText(ANY_WINDOW_SENTENCE)).not.toBeNull();
  });

  it('§X — the review page\'s reading is "Ask Cinatra about this review, or ask for changes to the work…"', async () => {
    // §X: "On the review page, the sentence names the review." There is no form
    // here, so the sentence names the review and the change request rather than
    // filling fields — which is what this window actually does (§VI).
    await mount(true);
    await settle();
    expect(screen.queryByText(REVIEW_SENTENCE)).not.toBeNull();
    // Not any other reading's sentence, and not the one string all five mounts
    // used to show.
    expect(
      screen.queryByText("Ask Cinatra to fill the fields above, or ask about this step…"),
    ).toBeNull();
    expect(
      screen.queryByText(/Ask Cinatra to suggest edits to the fields above/),
    ).toBeNull();
  });

  it("AC3 — draws NO window for a reader the gate would refuse", async () => {
    await mount(false);
    await settle();
    expect(screen.queryByText(ANY_WINDOW_SENTENCE)).toBeNull();
  });

  it("the refusal is the gate's answer, not an accident of the mount", async () => {
    // A surface that never drew the box at all would pass AC3 for the wrong
    // reason — the run page's own defect. So both readings are taken and the
    // two outcomes must differ.
    const withAccess = await mount(true);
    await settle();
    const drawn = screen.queryByText(ANY_WINDOW_SENTENCE) !== null;
    withAccess.unmount();
    cleanup();
    document.body.innerHTML = "";
    document.body.appendChild(document.createElement("main"));

    await mount(false);
    await settle();
    const refused = screen.queryByText(ANY_WINDOW_SENTENCE) !== null;

    expect(drawn).toBe(true);
    expect(refused).toBe(false);
  });
});
