// @vitest-environment jsdom
/**
 * THE ANSWERED ASK SETTLES WHEN THE PANEL STOPS PUBLISHING IT (cinatra#3007).
 *
 * The fourth capture photographed an ALREADY-ANSWERED setup ask still drawn as
 * `asking`, with a live Continue, for the whole of a produced-review park. The
 * run-panel half of that is pinned by the park suites: once the shared review
 * slot reports the park, the panel nulls its published gate descriptor.
 *
 * This file pins the OTHER half, which those suites do not exercise: that the
 * conversation's own reader really does re-read and settle when the descriptor
 * it is wired to goes null. `useAgentHitlScreenState` re-reads on `wireRef` and
 * on nothing else, so the null publication is a TRIGGER rather than a clear —
 * and the authorized reader behind it answers `none` for a park. Without this
 * pin, "the panel published null" proves nothing about the card the person is
 * looking at.
 *
 * The failure case is pinned beside it deliberately: a read that cannot be
 * completed is not a state, and the last authorized answer stands. That is the
 * documented contract of this reader, not a defect of the park fix — a park
 * whose re-read fails keeps drawing the ask until a read succeeds.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/hitl-screen-settles-on-null-wire.test.tsx
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));

import { useAgentHitlScreenState } from "../agent-hitl-screen-card";
import type { AgentHitlScreenState } from "../agent-hitl-screen";

const RUN_ID = "run-park-settle";

const ASKING = {
  state: "asking",
  runId: RUN_ID,
  screenRef: "screen-1",
  gate: {
    taskId: "task-1",
    stepKey: "9b9c74bc",
    title: "Draft Context",
    schema: { type: "object", properties: {} },
  },
} as unknown as AgentHitlScreenState;

const NONE = { state: "none" } as AgentHitlScreenState;

afterEach(() => {
  cleanup();
  screenStateMock.mockReset();
});

describe("useAgentHitlScreenState under a produced-review park", () => {
  it("settles to none when the published descriptor goes null", async () => {
    // While the run publishes its gate the card asks, exactly as it should.
    screenStateMock.mockResolvedValue(ASKING);
    const { result, rerender } = renderHook(
      ({ wireRef }: { wireRef: string | null }) =>
        useAgentHitlScreenState({ runId: RUN_ID, wireRef, reloadToken: 0, auth: null }),
      { initialProps: { wireRef: "task-1" as string | null } },
    );
    await waitFor(() => expect(result.current?.state).toBe("asking"));

    // THE PARK LANDS. The panel stops publishing the answered gate; the
    // authorized reader answers `none` for a parked run. The card must settle —
    // this is the step the capture showed missing for 966 s.
    screenStateMock.mockResolvedValue(NONE);
    rerender({ wireRef: null });
    await waitFor(() =>
      expect(result.current?.state, "the answered ask kept asking after the park").toBe("none"),
    );
  });

  it("keeps the last authorized answer when the re-read FAILS", async () => {
    // Documented contract, pinned so the park fix cannot be read as changing it:
    // a failed read is not a state. The ask stands until a read succeeds.
    screenStateMock.mockResolvedValue(ASKING);
    const { result, rerender } = renderHook(
      ({ wireRef }: { wireRef: string | null }) =>
        useAgentHitlScreenState({ runId: RUN_ID, wireRef, reloadToken: 0, auth: null }),
      { initialProps: { wireRef: "task-1" as string | null } },
    );
    await waitFor(() => expect(result.current?.state).toBe("asking"));

    screenStateMock.mockRejectedValue(new Error("transport down"));
    rerender({ wireRef: null });
    await waitFor(() => expect(screenStateMock).toHaveBeenCalledTimes(2));
    expect(result.current?.state, "a failed read was turned into a state").toBe("asking");
  });
});
