// @vitest-environment jsdom
/**
 * useAgentCreationProgress hook + timeline chrome.
 *
 * The chat package's vitest config does NOT alias the app `@/` path, so the
 * heavy `<InlineAgentRunCard>` (which transitively pulls AgenticRunPanel +
 * @/components/ui/card) is not import-safe here. We instead test the
 * `useAgentCreationProgress` behavior directly, plus a tiny consumer that
 * mirrors the component's `rows.length === 0 -> null` chrome guard.
 *
 * `@/lib/notifications/flyout-state` is mocked with the real filter
 * semantics (kind:info + metadata.category + metadata.progress.runId,
 * ascending createdAt) so the assertions exercise the true contract.
 *
 * Assertions:
 *  - 2 progress rows from /api/notifications -> both visible IN ORDER.
 *  - empty filtered list -> timeline chrome NOT rendered.
 *  - unmount -> window.clearInterval invoked (both intervals torn down).
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

import { useAgentCreationProgress } from "../use-agent-creation-progress";

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
  return {
    ok: true,
    json: async () => ({ notifications: rows }),
  } as unknown as Response;
}
function statusResponse(status: string) {
  return {
    ok: true,
    json: async () => ({ status }),
  } as unknown as Response;
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
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("/api/notifications")) return notifResponse([]);
    return statusResponse("running");
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useAgentCreationProgress + timeline chrome", () => {
  it("renders 2 progress rows in ascending order", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/notifications")) {
        return notifResponse([SYNCING, QUEUED]);
      }
      return statusResponse("running");
    });

    await act(async () => {
      render(<TimelineHarness runId="run-1" />);
      // flush the primed pollNotifications() promise chain
      await Promise.resolve();
      await Promise.resolve();
    });

    const list = await screen.findByTestId("timeline");
    const texts = Array.from(list.querySelectorAll("li")).map(
      (li) => li.textContent,
    );
    expect(texts).toEqual(["Queued", "Syncing skills"]);
  });

  it("empty filtered list -> timeline chrome NOT rendered", async () => {
    await act(async () => {
      render(<TimelineHarness runId="run-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("timeline")).toBeNull();
  });

  it("unmount clears both intervals (clearInterval invoked)", async () => {
    const clearSpy = vi.spyOn(window, "clearInterval");
    let unmount = () => {};
    await act(async () => {
      const r = render(<TimelineHarness runId="run-1" />);
      unmount = r.unmount;
      await Promise.resolve();
    });
    act(() => unmount());
    expect(clearSpy).toHaveBeenCalled();
  });
});
