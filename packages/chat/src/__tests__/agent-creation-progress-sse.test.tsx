// @vitest-environment jsdom
/**
 * Live SSE creation-progress subscription.
 *
 * jsdom + a controllable mock `window.EventSource` (NO live server — we never
 * fabricate a real SSE round-trip). `fetch` is mocked for the initial
 * replay + safety-net + status polls. `@/lib/notifications/flyout-state` is
 * mocked with the REAL run-id filter semantics so the assertions exercise the
 * true contract.
 *
 * Assertions:
 *  1. SSE `notification` event appends to the timeline (ascending order).
 *  2. Dedupe vs initial fetch — same `id` from SSE does NOT double-render.
 *  3. Terminal status closes the EventSource + clears intervals.
 *  4. EventSource unavailable → falls back to the initial fetch (no throw).
 *  5. Unmount → EventSource.close() + clearInterval invoked.
 *  6. Race-free merge — SSE arrives BEFORE a stale fetch snapshot; the stale
 *     snapshot must NOT drop the SSE row.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/notifications", () => ({}));
vi.mock("@/lib/notifications/flyout-state", () => ({
  filterAgentCreationProgressByRunId: (
    items: Array<{
      kind: string;
      createdAt: string;
      metadata?: { category?: unknown; progress?: { runId?: unknown } };
    }>,
    runId: string,
  ) => {
    if (!runId) return [];
    return items
      .filter(
        (n) =>
          n.kind === "info" &&
          n.metadata?.category === "agent_creation_progress" &&
          n.metadata?.progress?.runId === runId,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
}));

import {
  mergeProgress,
  useAgentCreationProgress,
} from "../use-agent-creation-progress";

// --- Controllable mock EventSource ----------------------------------------
type Listener = (ev: { data: string }) => void;
let lastEventSource: MockEventSource | null = null;

class MockEventSource {
  url: string;
  closed = false;
  close = vi.fn(() => {
    this.closed = true;
  });
  private listeners = new Map<string, Set<Listener>>();
  constructor(url: string) {
    this.url = url;
    lastEventSource = this;
  }
  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  emit(type: string, data: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
}

function TimelineHarness({ runId }: { runId: string }) {
  const rows = useAgentCreationProgress(runId) as unknown as Array<{
    id: string;
    title: string;
  }>;
  if (rows.length === 0) return null;
  return (
    <ul data-testid="timeline">
      {rows.map((r) => (
        <li key={r.id}>{r.title}</li>
      ))}
    </ul>
  );
}

function notifResponse(rows: unknown[]) {
  return { ok: true, json: async () => ({ notifications: rows }) } as unknown as Response;
}
function statusResponse(status: string) {
  return { ok: true, json: async () => ({ status }) } as unknown as Response;
}

const QUEUED = {
  id: "n1",
  title: "Queued",
  body: "",
  kind: "info",
  createdAt: "2026-05-18T00:00:01.000Z",
  metadata: {
    category: "agent_creation_progress",
    progress: { runId: "run-1", milestone: "queued" },
  },
};
const SYNCING = {
  id: "n2",
  title: "Syncing skills",
  body: "",
  kind: "info",
  createdAt: "2026-05-18T00:00:02.000Z",
  metadata: {
    category: "agent_creation_progress",
    progress: { runId: "run-1", milestone: "syncing_skills" },
  },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  lastEventSource = null;
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("/api/notifications")) return notifResponse([]);
    return statusResponse("running");
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("useAgentCreationProgress live SSE", () => {
  it("SSE notification event appends to the timeline (ascending order)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/notifications")) return notifResponse([QUEUED]);
      return statusResponse("running");
    });

    await act(async () => {
      render(<TimelineHarness runId="run-1" />);
      await flush();
    });
    // initial fetch → just QUEUED
    expect(
      Array.from(
        (await screen.findByTestId("timeline")).querySelectorAll("li"),
      ).map((li) => li.textContent),
    ).toEqual(["Queued"]);

    await act(async () => {
      lastEventSource!.emit("notification", JSON.stringify(SYNCING));
      await flush();
    });
    expect(
      Array.from(
        screen.getByTestId("timeline").querySelectorAll("li"),
      ).map((li) => li.textContent),
    ).toEqual(["Queued", "Syncing skills"]);
  });

  it("dedupes an SSE event whose id already arrived via the initial fetch", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/notifications")) return notifResponse([QUEUED]);
      return statusResponse("running");
    });

    await act(async () => {
      render(<TimelineHarness runId="run-1" />);
      await flush();
    });
    await act(async () => {
      lastEventSource!.emit("notification", JSON.stringify(QUEUED));
      await flush();
    });
    expect(
      screen.getByTestId("timeline").querySelectorAll("li"),
    ).toHaveLength(1);
  });

  it("terminal status closes the EventSource and clears intervals", async () => {
    const clearSpy = vi.spyOn(window, "clearInterval");
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/notifications")) return notifResponse([QUEUED]);
      return statusResponse("completed");
    });

    await act(async () => {
      render(<TimelineHarness runId="run-1" />);
      await flush();
    });

    expect(lastEventSource!.close).toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalled();
  });

  it("EventSource unavailable → falls back to the initial fetch", async () => {
    vi.stubGlobal("EventSource", undefined);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/notifications")) {
        return notifResponse([QUEUED, SYNCING]);
      }
      return statusResponse("running");
    });

    await act(async () => {
      render(<TimelineHarness runId="run-1" />);
      await flush();
    });
    expect(
      Array.from(
        (await screen.findByTestId("timeline")).querySelectorAll("li"),
      ).map((li) => li.textContent),
    ).toEqual(["Queued", "Syncing skills"]);
  });

  it("unmount closes the EventSource and clears intervals", async () => {
    const clearSpy = vi.spyOn(window, "clearInterval");
    let unmount = () => {};
    await act(async () => {
      const r = render(<TimelineHarness runId="run-1" />);
      unmount = r.unmount;
      await flush();
    });
    const es = lastEventSource!;
    act(() => unmount());
    expect(es.close).toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalled();
  });

  // Race-free invariant: a stale fetch snapshot resolving AFTER an SSE append
  // must not drop the SSE row. The hook's single
  // `setItems(prev => mergeProgress(prev, …))` reducer is what guarantees this
  // — it is pure, commutative and idempotent (union-by-`id` +
  // ascending-`createdAt`-sort) so source arrival order is irrelevant.
  //
  // We exercise the property at the reducer level (driving real React
  // passive-effect scheduling to interleave a microtask-timed SSE emit
  // against a primed-but-unresolved fetch is jsdom-flaky and not the unit
  // under test). `mergeProgress` is exported for exactly this assertion.
  it("race-free reducer: SSE append survives a later stale snapshot (no drop, no dup, ascending)", () => {
    // SSE appended SYNCING into prev; a stale fetch snapshot then arrives
    // carrying only the OLD [QUEUED] row.
    const afterSse = mergeProgress([], [SYNCING as never]);
    const afterStaleSnapshot = mergeProgress(afterSse, [QUEUED as never]);
    expect(afterStaleSnapshot.map((n) => (n as { id: string }).id)).toEqual([
      "n1",
      "n2",
    ]); // QUEUED (older createdAt) first, SYNCING retained — not dropped
    // Idempotent: re-applying the same snapshot returns the SAME reference
    // (React bail-out) and never duplicates.
    expect(mergeProgress(afterStaleSnapshot, [QUEUED as never])).toBe(
      afterStaleSnapshot,
    );
    // Commutative (literal): the opposite arrival order (snapshot first,
    // then SSE) yields the identical ascending-by-createdAt result — proving
    // source order is genuinely irrelevant.
    const oppositeOrder = mergeProgress(
      mergeProgress([], [QUEUED as never]),
      [SYNCING as never],
    );
    expect(oppositeOrder.map((n) => (n as { id: string }).id)).toEqual([
      "n1",
      "n2",
    ]);
  });
});
