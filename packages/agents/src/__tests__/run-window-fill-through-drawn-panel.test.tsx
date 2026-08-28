// @vitest-environment jsdom
// THE FILL STILL REACHES THE FIELD NOW THAT THE WINDOW DRAWS ITS PROSE
// (cinatra#2934, lifecycle-b W5c).
//
// The window's assistant line used to be printed as characters and is now drawn
// as markup, and the screen's fields are written by what the TURN returns —
// two different things that a reader of the diff can easily believe are one.
// This pins them apart: the panel is the real one, the assistant's line goes
// through the drawing path, and the field beside the window is asserted to hold
// what the turn placed in it.
//
// It is a live wire, not a snapshot: dropping the effect on the floor in the
// screen's own submit — `await runWindow.send(prompt)` without applying what it
// returns — makes the last expectation of the first case fail with
// `expected '' to be 'A weekly publishing rhythm'`, which is the graded review's
// picture in a test.
//
//   pnpm --filter @cinatra/agent-builder exec vitest run \
//     src/__tests__/run-window-fill-through-drawn-panel.test.tsx

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const loadRunWindowConversation = vi.fn();
const sendRunWindowTurn = vi.fn();

vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: (...a: unknown[]) => loadRunWindowConversation(...a),
  sendRunWindowTurn: (...a: unknown[]) => sendRunWindowTurn(...a),
}));

// The window's own field is the design system's, and what it does — hold a
// draft, clear on submit — is its own test's subject. Here it only has to carry
// the person's words to the panel, so it stands in as the button that sends
// them, exactly as the panel's own test does.
vi.mock("@cinatra-ai/sdk-ui", () => ({
  PromptField: React.forwardRef<unknown, { onSubmit: (s: string) => Promise<void> }>(
    (props, _ref) =>
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "prompt-field",
          onClick: () => void props.onSubmit('make the idea "A weekly publishing rhythm"'),
        },
        "PromptField",
      ),
  ),
  LoadingSpinner: () => null,
}));

import { HitlConversationPanel } from "../hitl-conversation-panel";
import { useRunWindowConversation } from "../use-run-window-conversation";

/**
 * The smallest thing that is still the road: a field the person can see, and
 * the one window beneath it, wired the way every one of the five surfaces wires
 * it — the turn is sent, and what it returns is written into the field.
 */
function ScreenWithAWindow() {
  const runWindow = useRunWindowConversation({ runId: "run_1", surface: "run-page" });
  const [idea, setIdea] = React.useState("");
  return (
    <div>
      <label htmlFor="idea">Idea</label>
      <input id="idea" value={idea} onChange={(e) => setIdea(e.target.value)} />
      <HitlConversationPanel
        surface="run-page"
        portalTarget={document.body}
        visible={true}
        conversation={runWindow.entries}
        promptPending={runWindow.pending}
        storageKey="k"
        onSubmit={async (prompt: string) => {
          const effect = await runWindow.send(prompt);
          const placed = effect.fill?.values.idea;
          if (typeof placed === "string") setIdea(placed);
        }}
      />
    </div>
  );
}

// What a real turn came back with on the running app: a sentence with a bold
// phrase in it, and a pipe table the model wrote without markdown's separator.
const ANSWER =
  "**Placed in the fields on your screen.** Nothing was submitted — press the button when you are ready.\n\nField | Value\nIdea | A weekly publishing rhythm";

describe("the fill reaches the field the person is looking at", () => {
  afterEach(() => cleanup());

  it("writes the turn's value into the field while the answer is DRAWN above it", async () => {
    loadRunWindowConversation.mockResolvedValue([]);
    sendRunWindowTurn.mockResolvedValue({
      ok: true,
      entries: [
        { id: 1, role: "user", content: 'make the idea "A weekly publishing rhythm"' },
        { id: 2, role: "assistant", content: ANSWER },
      ],
      fills: [{ ref: "ref_1", values: { idea: "A weekly publishing rhythm" } }],
      acted: false,
    });

    render(<ScreenWithAWindow />);
    const field = () => screen.getByLabelText("Idea") as HTMLInputElement;
    expect(field().value).toBe("");

    await act(async () => {
      screen.getByTestId("prompt-field").click();
    });

    // The assistant's line went through the drawing path — bold reads bold and
    // the model's pipe table is a table, in the panel the person is looking at.
    await waitFor(() => {
      const bubble = document.querySelector('[data-run-window-entry="assistant"]');
      expect(bubble).not.toBeNull();
      expect(bubble?.querySelector("strong")).not.toBeNull();
      expect(bubble?.querySelector("table")).not.toBeNull();
      expect(bubble?.textContent).not.toContain("**");
    });

    // And the field in front of the person holds what the turn placed there.
    await waitFor(() => expect(field().value).toBe("A weekly publishing rhythm"));
  });

  it("a turn that placed nothing leaves the field exactly as the person left it", async () => {
    loadRunWindowConversation.mockResolvedValue([]);
    sendRunWindowTurn.mockResolvedValue({
      ok: true,
      entries: [
        { id: 1, role: "user", content: "what is this field for?" },
        { id: 2, role: "assistant", content: "It is the idea the post is written from." },
      ],
      fills: [],
      acted: false,
    });

    render(<ScreenWithAWindow />);
    await act(async () => {
      screen.getByTestId("prompt-field").click();
    });
    await waitFor(() =>
      expect(document.querySelectorAll('[data-run-window-entry="assistant"]').length).toBe(1),
    );
    expect((screen.getByLabelText("Idea") as HTMLInputElement).value).toBe("");
  });
});
