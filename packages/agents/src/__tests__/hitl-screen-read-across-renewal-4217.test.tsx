// @vitest-environment jsdom
/**
 * THE WIDGET'S HITL SCREEN READ ACROSS THE HOST'S RENEWAL (cinatra#4217 fold 3,
 * a sibling of pre-3 MUST-FIX 2).
 *
 * The broker read of the HITL screen collapses a 401/403 to `none` and the card
 * goes away, because a revoked credential must not leave a question and its
 * current values on screen. A refusal of the pair the frame holds while its
 * renewal is on its way says nothing about the reader, though: the server has
 * already committed the renewed pair. So the read is sent once more with the
 * renewed pair before its refusal is believed, and a real refusal still
 * collapses to `none`.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/hitl-screen-read-across-renewal-4217.test.tsx
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));

import { useAgentHitlScreenState } from "../agent-hitl-screen-card";
import type { LifecycleCardAuth } from "../lifecycle-card-runtime";

const RUN_ID = "run-hitl-4217";
const ASKING = {
  state: "asking",
  runId: RUN_ID,
  screenRef: "screen-4217",
  gate: { reviewTaskId: "task-4217", xRenderer: "text", inputSchema: {}, currentValues: {} },
};

function frame() {
  const state = { n: 1, pending: false };
  let gate: { promise: Promise<void>; resolve: () => void } | null = null;
  const auth: LifecycleCardAuth = {
    headers: () => ({
      Authorization: `Bearer cit_${state.n}`,
      "X-Cinatra-Widget-User-Token": `cwu_${state.n}`,
    }),
    credentials: "omit",
    renewal: {
      pending: () => state.pending,
      settled: () => (gate ? gate.promise : Promise.resolve()),
    },
  };
  return {
    auth,
    begin() {
      state.pending = true;
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      gate = { promise, resolve };
    },
    answer(renewed = true) {
      if (renewed) state.n += 1;
      state.pending = false;
      const g = gate;
      gate = null;
      g?.resolve();
    },
  };
}

function server(spent: Set<string>) {
  const tokens: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const token = (init?.headers as Record<string, string>)["X-Cinatra-Widget-User-Token"] ?? "";
      tokens.push(token);
      if (spent.has(token)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
      return new Response(JSON.stringify(ASKING), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return tokens;
}

/** Drain every promise the test has let move: one macrotask turn each. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  screenStateMock.mockReset();
});

describe("useAgentHitlScreenState's broker read across the renewal", () => {
  const mount = (auth: LifecycleCardAuth) =>
    renderHook(() => useAgentHitlScreenState({ runId: RUN_ID, wireRef: "task-4217", reloadToken: 0, auth }));

  // RED AT 749d92f2: the refusal collapsed to `none` at once, so the open
  // question left the widget while the renewed pair was on its way.
  it("a read refused before the renewed pair is installed asks with it, and the question stays", async () => {
    const f = frame();
    f.begin();
    const tokens = server(new Set(["cwu_1"]));
    const { result } = mount(f.auth);
    await flush();
    expect(result.current, "nothing is believed while the renewal is on its way").toBeNull();
    f.answer();
    await flush();
    expect(result.current?.state).toBe("asking");
    expect(tokens).toEqual(["cwu_1", "cwu_2"]);
    expect(screenStateMock, "the broker host never takes the cookie action").not.toHaveBeenCalled();
  });

  it("an unmount while the read waits for the renewal sends nothing more", async () => {
    const f = frame();
    f.begin();
    const tokens = server(new Set(["cwu_1"]));
    const { unmount } = mount(f.auth);
    await flush();
    unmount();
    f.answer();
    await flush();
    expect(tokens).toEqual(["cwu_1"]);
  });

  it("control: a refusal of a credential that did not move still collapses to none", async () => {
    const f = frame();
    const tokens = server(new Set(["cwu_1"]));
    const { result } = mount(f.auth);
    await flush();
    expect(result.current?.state).toBe("none");
    expect(tokens).toEqual(["cwu_1"]);
  });

  it("control: a renewal that brings no new pair leaves the refusal final", async () => {
    const f = frame();
    f.begin();
    const tokens = server(new Set(["cwu_1"]));
    const { result } = mount(f.auth);
    await flush();
    f.answer(false);
    await flush();
    expect(result.current?.state).toBe("none");
    expect(tokens).toEqual(["cwu_1"]);
  });
});
