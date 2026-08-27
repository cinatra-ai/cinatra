// @vitest-environment jsdom
// THE FILL COUNTER IS SEEDED FROM WHAT THE RUN ALREADY HOLDS (cinatra#2934,
// lifecycle-b W5c — the third defect the picture leg's readbacks found).
//
// The window's rule is "only a fill this turn ADDED is applied. A screen
// re-reading the run must not re-apply a fill the person has since edited away."
// It is implemented by counting, and the counter started at zero on every mount
// while the load effect never seeded it — so after ANY page load the first turn
// read every fill the run already held as its own.
//
// MEASURED ON THE REAL SCREEN: a freshly loaded step-by-step screen with three
// empty fields; the turn placed NO fill; the fields afterwards held an EARLIER
// message's values.

import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const loadRunWindowConversation = vi.fn();
const sendRunWindowTurn = vi.fn();

vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: (...a: unknown[]) => loadRunWindowConversation(...a),
  sendRunWindowTurn: (...a: unknown[]) => sendRunWindowTurn(...a),
}));

import { useRunWindowConversation } from "../use-run-window-conversation";

const FILL_A = { ref: "ref_1", values: { subject: "an earlier message's subject" } };
const FILL_B = { ref: "ref_1", values: { subject: "what this turn asked for" } };

function mount() {
  return renderHook(() => useRunWindowConversation({ runId: "run_1", surface: "step-by-step" }));
}

describe("a turn after a page load applies only the fill it added", () => {
  it("a turn that placed NOTHING applies nothing, with prior fills on the run", async () => {
    loadRunWindowConversation.mockResolvedValue({
      entries: [
        { id: 1, role: "user", content: "make it say that" },
        { id: 2, role: "assistant", content: "Placed." },
      ],
      // TWO fills already on the run — the ones the person has since edited away.
      fillCount: 2,
    });
    // The turn answers a question: the run still holds exactly those two fills.
    sendRunWindowTurn.mockResolvedValue({
      ok: true,
      entries: [],
      fills: [FILL_A, FILL_B],
      acted: false,
    });

    const { result } = mount();
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let effect: { fill: unknown; acted: boolean } | undefined;
    await act(async () => {
      effect = await result.current.send("what is this field for?");
    });
    expect(effect).toEqual({ fill: null, acted: false });
  });

  it("a turn that DID add one applies exactly that one", async () => {
    loadRunWindowConversation.mockResolvedValue({ entries: [], fillCount: 1 });
    sendRunWindowTurn.mockResolvedValue({
      ok: true,
      entries: [],
      fills: [FILL_A, FILL_B],
      acted: false,
    });

    const { result } = mount();
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let effect: { fill: unknown; acted: boolean } | undefined;
    await act(async () => {
      effect = await result.current.send('make the subject "what this turn asked for"');
    });
    expect(effect).toEqual({ fill: FILL_B, acted: false });
  });

  it("a screen with no stored conversation still applies its own first fill", async () => {
    loadRunWindowConversation.mockResolvedValue({ entries: [], fillCount: 0 });
    sendRunWindowTurn.mockResolvedValue({
      ok: true,
      entries: [],
      fills: [FILL_A],
      acted: false,
    });

    const { result } = mount();
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let effect: { fill: unknown; acted: boolean } | undefined;
    await act(async () => {
      effect = await result.current.send("make it say that");
    });
    expect(effect).toEqual({ fill: FILL_A, acted: false });
  });
});
