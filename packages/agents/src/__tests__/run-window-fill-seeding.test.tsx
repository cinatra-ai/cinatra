// @vitest-environment jsdom
// A TURN APPLIES ITS OWN FILL AND NO OTHER (cinatra#2934, lifecycle-b W5c — the
// third defect the picture leg's readbacks found, and convergence round 1's
// finding on it).
//
// The window's rule is "only a fill this turn placed is applied. A screen
// re-reading the run must not re-apply a fill the person has since edited away."
// It was implemented by COUNTING how many fills the run held before and after a
// turn, and the counter began at zero on every mount while the load never
// seeded it — so after any page load the first turn read every fill the run
// already held as its own.
//
// MEASURED ON THE REAL SCREEN: a freshly loaded step-by-step screen with three
// empty fields; the turn placed NO fill; the fields afterwards held an EARLIER
// message's values.
//
// The repair is not a better count: the server selects the turn's own rows by
// the turn's identity, so this hook has nothing to keep in step. What is pinned
// here is that it applies exactly what came back, whatever the run holds and
// whatever the load did — including a load that has not returned yet, which no
// seeding could have covered.

import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const loadRunWindowConversation = vi.fn();
const sendRunWindowTurn = vi.fn();

vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: (...a: unknown[]) => loadRunWindowConversation(...a),
  sendRunWindowTurn: (...a: unknown[]) => sendRunWindowTurn(...a),
}));

import { useRunWindowConversation } from "../use-run-window-conversation";

const MINE = { ref: "ref_1", values: { subject: "what this turn asked for" } };
const ALSO_MINE = { ref: "ref_1", values: { body: "and this" } };

function mount() {
  return renderHook(() =>
    useRunWindowConversation({ runId: "run_1", surface: "step-by-step" }),
  );
}

describe("a turn applies its own fill and no other", () => {
  it("a turn that placed NOTHING applies nothing, however many the run holds", async () => {
    loadRunWindowConversation.mockResolvedValue([
      { id: 1, role: "user", content: "make it say that" },
      { id: 2, role: "assistant", content: "Placed." },
    ]);
    // The person asks a question. The run still carries the earlier message's
    // fills; none of them is this turn's, so the server returns none.
    sendRunWindowTurn.mockResolvedValue({
      ok: true,
      entries: [],
      fills: [],
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

  it("applies the NEWEST of the fills this turn placed", async () => {
    loadRunWindowConversation.mockResolvedValue([]);
    sendRunWindowTurn.mockResolvedValue({
      ok: true,
      entries: [],
      fills: [MINE, ALSO_MINE],
      acted: false,
    });

    const { result } = mount();
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let effect: { fill: unknown; acted: boolean } | undefined;
    await act(async () => {
      effect = await result.current.send("make the subject that, and the body this");
    });
    expect(effect).toEqual({ fill: ALSO_MINE, acted: false });
  });

  it("a turn sent BEFORE the stored exchange has been read still applies its own", async () => {
    // No seeding could have covered this: the load is still in flight when the
    // person sends. The turn's own fill is still the turn's own.
    let releaseLoad: (rows: unknown[]) => void = () => {};
    loadRunWindowConversation.mockReturnValue(
      new Promise((resolve) => {
        releaseLoad = resolve as (rows: unknown[]) => void;
      }),
    );
    sendRunWindowTurn.mockResolvedValue({
      ok: true,
      entries: [],
      fills: [MINE],
      acted: false,
    });

    const { result } = mount();
    expect(result.current.loaded).toBe(false);

    let effect: { fill: unknown; acted: boolean } | undefined;
    await act(async () => {
      effect = await result.current.send("make it say that");
    });
    expect(effect).toEqual({ fill: MINE, acted: false });
    await act(async () => {
      releaseLoad([]);
    });
  });
});
