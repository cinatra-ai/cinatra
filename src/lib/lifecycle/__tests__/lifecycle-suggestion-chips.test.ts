// The chips' attachment contract (cinatra#2572, epic #2564 S6c).
// Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` §VIII.
//
// Every assertion here is about what a reader may LEARN and what a failure may
// COST: the state is the authorization (a state that cannot carry chips never
// reaches the store at all), a pending gate's ledger is never read, and a
// failure costs the chips rather than the card.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

const readGateSuggestionSurface = vi.fn();

vi.mock("@cinatra-ai/agents/suggestion-decision-store", () => ({
  readGateSuggestionSurface: (...args: unknown[]) => readGateSuggestionSurface(...args),
}));

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { encodeLifecycleGateRef } from "../lifecycle-card-ref";
import { attachLifecycleSuggestions } from "../lifecycle-suggestion-chips";

const REF = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "task-1" })!;

const PRODUCED = [
  {
    id: "sug-1",
    fieldPath: "/subject",
    op: "replace",
    value: "Q3 re-engagement",
    message: "Not canonical.",
  },
  {
    id: "sug-2",
    fieldPath: "/items/0/bcc",
    op: "remove",
    message: "Every disclosed field on this list item is empty.",
  },
];

function surface(marks: Map<string, "accepted" | "dismissed"> = new Map()) {
  return { gateId: "gate-1", snapshotId: "gsug_1", suggestions: PRODUCED, marks };
}

const PENDING: LifecycleCardState = { state: "pending", canDecide: true, canComment: true };
const RESTRICTED: LifecycleCardState = {
  state: "restricted",
  canDecide: false,
  canComment: true,
  reason: "Approving or rejecting needs approve access on this run.",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the state is the authorization", () => {
  it("never reads the store for a state that cannot carry chips", async () => {
    for (const state of [
      { state: "loading" },
      { state: "advisory" },
      { state: "absent" },
    ] as LifecycleCardState[]) {
      const out = await attachLifecycleSuggestions(state, "artifact_review_gate", REF);
      expect(out).toEqual(state);
    }
    // `absent` is the ladder's collapse of EVERY denial — no access, no gate, a
    // ref that does not decode. None of them reaches the store.
    expect(readGateSuggestionSurface).not.toHaveBeenCalled();
  });

  it("never reads the store for another card kind", async () => {
    const out = await attachLifecycleSuggestions(
      { state: "advisory" },
      "verification_summary",
      REF,
    );
    expect(out).toEqual({ state: "advisory" });
    expect(readGateSuggestionSurface).not.toHaveBeenCalled();
  });

  it("a ref that does not decode attaches nothing and reads nothing", async () => {
    const out = await attachLifecycleSuggestions(PENDING, "artifact_review_gate", "not-a-ref");
    expect(out).toEqual(PENDING);
    expect(readGateSuggestionSurface).not.toHaveBeenCalled();
  });
});

describe("a PENDING gate has no recorded partition", () => {
  it("attaches the surfaced chips WITHOUT reading the ledger", async () => {
    readGateSuggestionSurface.mockResolvedValue(surface());
    const out = await attachLifecycleSuggestions(PENDING, "artifact_review_gate", REF);
    expect(readGateSuggestionSurface).toHaveBeenCalledWith("run-1", "task-1", {
      withRecordedMarks: false,
    });
    expect(out).toEqual({
      ...PENDING,
      suggestions: [
        { id: "sug-1", label: "subject", op: "replace", message: "Not canonical." },
        {
          id: "sug-2",
          label: "items · 0 · bcc",
          op: "remove",
          message: "Every disclosed field on this list item is empty.",
        },
      ],
    });
  });

  it("NEVER carries the proposed value onto the wire", async () => {
    readGateSuggestionSurface.mockResolvedValue(surface());
    const out = await attachLifecycleSuggestions(PENDING, "artifact_review_gate", REF);
    expect(JSON.stringify(out)).not.toContain("Q3 re-engagement");
  });

  it("a RESTRICTED reader gets the same chips (they may read the target these annotate)", async () => {
    readGateSuggestionSurface.mockResolvedValue(surface());
    const out = await attachLifecycleSuggestions(RESTRICTED, "artifact_review_gate", REF);
    expect(readGateSuggestionSurface).toHaveBeenCalledWith("run-1", "task-1", {
      withRecordedMarks: false,
    });
    expect((out as { suggestions?: unknown[] }).suggestions).toHaveLength(2);
    // The reader's own standing is untouched — the chips add no authority.
    expect(out).toMatchObject({ state: "restricted", canDecide: false });
  });
});

describe("a SETTLED gate shows what was recorded", () => {
  it("reads the ledger and marks each chip with the reviewer's own choice", async () => {
    readGateSuggestionSurface.mockResolvedValue(
      surface(new Map([["sug-1", "accepted"], ["sug-2", "dismissed"]])),
    );
    const out = await attachLifecycleSuggestions({ state: "settled" }, "artifact_review_gate", REF);
    expect(readGateSuggestionSurface).toHaveBeenCalledWith("run-1", "task-1", {
      withRecordedMarks: true,
    });
    expect(out).toEqual({
      state: "settled",
      suggestions: [
        { id: "sug-1", label: "subject", op: "replace", message: "Not canonical.", mark: "accepted" },
        {
          id: "sug-2",
          label: "items · 0 · bcc",
          op: "remove",
          message: "Every disclosed field on this list item is empty.",
          mark: "dismissed",
        },
      ],
    });
  });

  it("an item the reviewer decided nothing about carries NO mark", async () => {
    readGateSuggestionSurface.mockResolvedValue(surface(new Map([["sug-1", "accepted"]])));
    const out = (await attachLifecycleSuggestions(
      { state: "settled" },
      "artifact_review_gate",
      REF,
    )) as { suggestions: { id: string; mark?: string }[] };
    expect(out.suggestions[0].mark).toBe("accepted");
    expect(out.suggestions[1].mark).toBeUndefined();
  });
});

describe("a failure costs the CHIPS, never the CARD", () => {
  it("a gate with no snapshot (or one that stopped verifying) leaves the state untouched", async () => {
    readGateSuggestionSurface.mockResolvedValue(null);
    expect(await attachLifecycleSuggestions(PENDING, "artifact_review_gate", REF)).toEqual(PENDING);
  });

  it("an empty snapshot leaves the state untouched", async () => {
    readGateSuggestionSurface.mockResolvedValue({ ...surface(), suggestions: [] });
    expect(await attachLifecycleSuggestions(PENDING, "artifact_review_gate", REF)).toEqual(PENDING);
  });

  it("a THROWING store leaves the reviewer their decision floor", async () => {
    // The one place on this path where failing closed would be the wrong answer:
    // collapsing to `absent` here would take a live floor away from a reviewer
    // entitled to it, to hide a decoration.
    readGateSuggestionSurface.mockRejectedValue(new Error("db down"));
    expect(await attachLifecycleSuggestions(PENDING, "artifact_review_gate", REF)).toEqual(PENDING);
  });

  it("a snapshot of only unrenderable rows leaves the state untouched", async () => {
    readGateSuggestionSurface.mockResolvedValue({
      ...surface(),
      suggestions: [{ id: "s", fieldPath: "/a", op: "merge", message: "m" }],
    });
    expect(await attachLifecycleSuggestions(PENDING, "artifact_review_gate", REF)).toEqual(PENDING);
  });
});
