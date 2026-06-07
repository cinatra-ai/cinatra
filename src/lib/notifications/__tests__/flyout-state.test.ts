import { describe, expect, it } from "vitest";

import type { AppNotification } from "@cinatra-ai/notifications/types";

import {
  applySseNotification,
  collapseByJobId,
  filterAgentCreationProgressByRunId,
  getInProgressItems,
  getUnreadItems,
  isRunningProgressNotification,
} from "@cinatra-ai/notifications/client";

// ---------------------------------------------------------------------------
// Multi-tab SSE de-duplication contract.
//
// The flyout state has two update channels: the 30-second poll (full replace
// via loadNotifications) and the SSE push (dedupe-prepend via
// applySseNotification). Two tabs subscribed to the same userId can hit a
// race where each tab sees the same notification id from poll AND from SSE,
// delivered in either order. The contract this suite codifies:
//
//   - Single-tab: dedupe by id, prepend on insert, return the same array
//     reference on duplicate-skip (React-state-stability).
//   - Multi-tab: each tab's state is independent — operations on tab-A
//     never mutate tab-B's array. Both tabs converge to length-1 regardless
//     of delivery order across the two tabs.
//   - Purity invariant: applySseNotification NEVER mutates its `current`
//     argument. This is what makes cross-tab independence possible:
//     production React roots are already separated, but the helper's
//     immutability rules out any future bug where a shared module-level
//     array could leak across.
//
// The test targets the pure helper extracted in src/lib/notifications/
// flyout-state.ts. The flyout rebuild must continue to reuse this helper
// (see app-shell.tsx); the test stays as a regression gate against any
// future re-derivation of the dedupe semantic.
// ---------------------------------------------------------------------------

function notification(
  id: string,
  overrides: Partial<AppNotification> = {},
): AppNotification {
  return {
    id,
    title: `Notification ${id}`,
    body: `Body for ${id}`,
    kind: "success",
    createdAt: "2026-05-12T00:00:00Z",
    ...overrides,
  };
}

describe("applySseNotification — single-tab dedupe contract", () => {
  it("prepends to an empty list", () => {
    const incoming = notification("n-1");
    const next = applySseNotification([], incoming);
    expect(next).toEqual([incoming]);
    expect(next).toHaveLength(1);
  });

  it("prepends in newest-first order when id is new", () => {
    const a = notification("n-1");
    const b = notification("n-2");
    const next = applySseNotification([a], b);
    expect(next).toEqual([b, a]);
  });

  it("returns the SAME array reference when id is a duplicate (React-state stability)", () => {
    const a = notification("n-1");
    const initial: AppNotification[] = [a];
    const next = applySseNotification(initial, notification("n-1"));
    // Same reference avoids a re-render in the React.useState updater.
    expect(next).toBe(initial);
  });

  it("does not mutate the input array on insert (returns a fresh array)", () => {
    const a = notification("n-1");
    const b = notification("n-2");
    const initial: AppNotification[] = [a];
    const next = applySseNotification(initial, b);
    expect(next).not.toBe(initial);
    // Input untouched.
    expect(initial).toEqual([a]);
  });
});

describe("applySseNotification — multi-tab race convergence", () => {
  it("Tab A: SSE-first, then poll snapshot — converges to length-1", () => {
    // Tab A starts empty, SSE arrives first, then poll snapshot replaces.
    const tabA0: AppNotification[] = [];
    const note = notification("race-1");
    const tabA1 = applySseNotification(tabA0, note);
    expect(tabA1).toEqual([note]);
    // Poll snapshot from /api/notifications GET. loadNotifications in
    // app-shell.tsx does `setNotifications(payload.notifications ?? [])` —
    // a full replace with the server's view, which includes the same row.
    const pollSnapshot: AppNotification[] = [note];
    const tabA2 = pollSnapshot; // simulate the full-replace
    expect(tabA2).toHaveLength(1);
    expect(tabA2[0]!.id).toBe("race-1");
  });

  it("Tab B: poll snapshot first, then SSE — dedupe no-op, length-1", () => {
    // Tab B starts empty, poll snapshot arrives first, then SSE delivers
    // the same notification.
    const tabB0: AppNotification[] = [];
    const note = notification("race-1");
    const pollSnapshot: AppNotification[] = [note];
    const tabB1 = pollSnapshot; // full-replace
    const tabB2 = applySseNotification(tabB1, note);
    // Dedupe path returns the same reference.
    expect(tabB2).toBe(tabB1);
    expect(tabB2).toHaveLength(1);
  });

  it("Two tabs, opposite-order delivery — converge to identical CONTENT in independent array references", () => {
    const note = notification("race-1");

    // Tab A: SSE-first then poll-replace.
    let tabA: AppNotification[] = [];
    tabA = applySseNotification(tabA, note);
    tabA = [note]; // poll snapshot full-replace

    // Tab B: poll-first then SSE dedupe.
    let tabB: AppNotification[] = [note]; // poll snapshot first
    tabB = applySseNotification(tabB, note);

    // CONTENT-equal: both tabs end at the same one-element list.
    expect(tabA).toEqual(tabB);
    expect(tabA).toHaveLength(1);

    // INDEPENDENT references: the two tabs' arrays are not aliased to
    // each other. (Tab A's path produced a new array via [note]; Tab B's
    // dedupe path returned its own incoming reference unchanged. The
    // contract is that nothing here is shared by accident.)
    expect(tabA).not.toBe(tabB);
  });

  it("applySseNotification never mutates a shared module-level array (cross-tab independence invariant)", () => {
    // Construct a single shared array reference (the threat model: a
    // future refactor accidentally exposes module-level state that two
    // tabs end up reading the same instance of).
    const shared: AppNotification[] = [notification("base")];
    const noteX = notification("x");
    const noteY = notification("y");
    const tabA = applySseNotification(shared, noteX);
    const tabB = applySseNotification(shared, noteY);
    // Even though both tabs started from `shared`, each produced its own
    // result array. The shared input is unchanged.
    expect(shared).toEqual([notification("base")]);
    expect(tabA).toEqual([noteX, notification("base")]);
    expect(tabB).toEqual([noteY, notification("base")]);
    expect(tabA).not.toBe(tabB);
    expect(tabA).not.toBe(shared);
    expect(tabB).not.toBe(shared);
  });

  it("Duplicate SSE delivery within a single tab still no-ops (idempotent under retry)", () => {
    // EventSource can re-deliver an event on reconnect. Hybrid client
    // already dedupes by id — this test pins that idempotence.
    const note = notification("retry-1");
    let state: AppNotification[] = [];
    state = applySseNotification(state, note);
    const afterFirst = state;
    state = applySseNotification(state, note);
    state = applySseNotification(state, note);
    expect(state).toBe(afterFirst); // unchanged reference on every retry
    expect(state).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// isRunningProgressNotification
// ---------------------------------------------------------------------------

function runningRow(
  id: string,
  jobId: string,
  overrides: Partial<AppNotification> = {},
): AppNotification {
  return notification(id, {
    kind: "info",
    sourceJobId: jobId,
    sourceJobName: "blog-post-idea-generation",
    metadata: {
      category: "background_process",
      progress: { status: "running", jobId, jobName: "blog-post-idea-generation" },
    },
    readAt: "2026-05-15T20:00:00Z",
    ...overrides,
  });
}

function terminalRow(
  id: string,
  jobId: string,
  kind: AppNotification["kind"],
  overrides: Partial<AppNotification> = {},
): AppNotification {
  return notification(id, {
    kind,
    sourceJobId: jobId,
    sourceJobName: "blog-post-idea-generation",
    ...overrides,
  });
}

describe("isRunningProgressNotification", () => {
  it("returns true for info-kind + background_process category + progress.status running", () => {
    expect(isRunningProgressNotification(runningRow("a", "j-1"))).toBe(true);
  });

  it("returns false for info-kind without background_process metadata", () => {
    expect(
      isRunningProgressNotification(
        notification("a", { kind: "info", metadata: { other: 1 } }),
      ),
    ).toBe(false);
  });

  it("returns false for terminal kinds even with progress.status running metadata", () => {
    expect(
      isRunningProgressNotification(
        notification("a", {
          kind: "success",
          metadata: { category: "background_process", progress: { status: "running" } },
        }),
      ),
    ).toBe(false);
  });

  it("returns false for info-kind background_process when status is not running", () => {
    expect(
      isRunningProgressNotification(
        notification("a", {
          kind: "info",
          metadata: { category: "background_process", progress: { status: "stale" } },
        }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collapseByJobId
// ---------------------------------------------------------------------------

describe("collapseByJobId", () => {
  it("passes through items without sourceJobId unchanged", () => {
    const a = notification("a", { createdAt: "2026-05-15T20:00:00Z" });
    const b = notification("b", { createdAt: "2026-05-15T19:00:00Z" });
    const out = collapseByJobId([a, b]);
    expect(out).toEqual([a, b]); // newest first by createdAt
  });

  it("with only a running row: keeps it (still in flight)", () => {
    const run = runningRow("a", "j-1", { createdAt: "2026-05-15T20:00:00Z" });
    expect(collapseByJobId([run])).toEqual([run]);
  });

  it("with only a terminal row: keeps it", () => {
    const term = terminalRow("a", "j-1", "success");
    expect(collapseByJobId([term])).toEqual([term]);
  });

  it("running + terminal for same job: terminal wins, running dropped", () => {
    const run = runningRow("a", "j-1", { createdAt: "2026-05-15T20:00:00Z" });
    const term = terminalRow("b", "j-1", "success", { createdAt: "2026-05-15T20:30:00Z" });
    const out = collapseByJobId([run, term]);
    expect(out).toEqual([term]);
  });

  it("TERMINAL WINS even when running row's createdAt is NEWER (clock-skew + fast-job race)", () => {
    // The terminal completes the job; even if a stale running event arrives
    // after the terminal due to clock skew or BullMQ retry weirdness, the
    // user should see the terminal state, not "still running".
    const run = runningRow("a", "j-1", { createdAt: "2026-05-15T21:00:00Z" });
    const term = terminalRow("b", "j-1", "success", { createdAt: "2026-05-15T20:30:00Z" });
    const out = collapseByJobId([run, term]);
    expect(out).toEqual([term]);
  });

  it("two terminals for same job: newest wins by createdAt", () => {
    const t1 = terminalRow("a", "j-1", "success", { createdAt: "2026-05-15T20:00:00Z" });
    const t2 = terminalRow("b", "j-1", "warning", { createdAt: "2026-05-15T20:30:00Z" });
    const out = collapseByJobId([t1, t2]);
    expect(out).toEqual([t2]);
  });

  it("two running for same job: newest wins by createdAt", () => {
    const r1 = runningRow("a", "j-1", { createdAt: "2026-05-15T20:00:00Z" });
    const r2 = runningRow("b", "j-1", { createdAt: "2026-05-15T20:30:00Z" });
    const out = collapseByJobId([r1, r2]);
    expect(out).toEqual([r2]);
  });

  it("multiple jobs + standalones: outputs sorted by selected row's createdAt desc", () => {
    const run1 = runningRow("r1", "j-1", { createdAt: "2026-05-15T21:00:00Z" });
    const term1 = terminalRow("t1", "j-1", "success", { createdAt: "2026-05-15T19:00:00Z" });
    const term2 = terminalRow("t2", "j-2", "error", { createdAt: "2026-05-15T22:00:00Z" });
    const standalone = notification("s1", { createdAt: "2026-05-15T20:00:00Z" });
    const out = collapseByJobId([run1, term1, term2, standalone]);
    // Selected: term1 for j-1 (terminal wins over newer running),
    //           term2 for j-2,
    //           standalone passes through.
    // Sorted by selected createdAt desc: term2, standalone, term1.
    expect(out).toEqual([term2, standalone, term1]);
  });

  it("does not mutate the input array (purity invariant)", () => {
    const run = runningRow("a", "j-1", { createdAt: "2026-05-15T20:00:00Z" });
    const term = terminalRow("b", "j-1", "success", { createdAt: "2026-05-15T20:30:00Z" });
    const input = [run, term];
    const out = collapseByJobId(input);
    expect(input).toEqual([run, term]); // input untouched
    expect(out).not.toBe(input);
  });
});

// ---------------------------------------------------------------------------
// getInProgressItems
// ---------------------------------------------------------------------------

describe("getInProgressItems", () => {
  it("returns running rows whose sourceJobId has no terminal counterpart", () => {
    const r1 = runningRow("a", "j-1", { createdAt: "2026-05-15T20:00:00Z" });
    const r2 = runningRow("b", "j-2", { createdAt: "2026-05-15T19:00:00Z" });
    const out = getInProgressItems([r1, r2]);
    expect(out).toEqual([r1, r2]);
  });

  it("excludes a running row when a terminal row exists for the same sourceJobId", () => {
    const run = runningRow("a", "j-1", { createdAt: "2026-05-15T20:00:00Z" });
    const term = terminalRow("b", "j-1", "success", { createdAt: "2026-05-15T20:30:00Z" });
    expect(getInProgressItems([run, term])).toEqual([]);
  });

  it("excludes plain notifications (no progress metadata)", () => {
    const plain = notification("a", { kind: "success" });
    expect(getInProgressItems([plain])).toEqual([]);
  });

  it("excludes info-kind rows without background_process metadata", () => {
    const noisy = notification("a", { kind: "info" });
    expect(getInProgressItems([noisy])).toEqual([]);
  });

  it("sorts newest first by createdAt", () => {
    const r1 = runningRow("a", "j-1", { createdAt: "2026-05-15T20:00:00Z" });
    const r2 = runningRow("b", "j-2", { createdAt: "2026-05-15T21:00:00Z" });
    expect(getInProgressItems([r1, r2])).toEqual([r2, r1]);
  });
});

// ---------------------------------------------------------------------------
// getUnreadItems
// ---------------------------------------------------------------------------

describe("getUnreadItems", () => {
  it("returns rows whose readAt is unset", () => {
    const a = notification("a");
    const b = notification("b", { readAt: "2026-05-15T20:00:00Z" });
    expect(getUnreadItems([a, b])).toEqual([a]);
  });

  it("excludes running progress rows even when they have no readAt", () => {
    const run = runningRow("a", "j-1", { readAt: undefined });
    const term = notification("b");
    expect(getUnreadItems([run, term])).toEqual([term]);
  });

  it("excludes rows whose href matches currentPathname (already on page)", () => {
    const a = notification("a", { href: "/jobs/1" });
    const b = notification("b", { href: "/other" });
    expect(getUnreadItems([a, b], "/jobs/1")).toEqual([b]);
  });

  it("excludes rows whose href is a prefix of currentPathname", () => {
    const a = notification("a", { href: "/jobs" });
    const b = notification("b", { href: "/other" });
    expect(getUnreadItems([a, b], "/jobs/123")).toEqual([b]);
  });

  it("keeps rows when currentPathname is undefined", () => {
    const a = notification("a", { href: "/jobs/1" });
    expect(getUnreadItems([a])).toEqual([a]);
  });
});

// ---------------------------------------------------------------------------
// Agent-creation progress timeline filter.
// ---------------------------------------------------------------------------

function progressRow(
  id: string,
  runId: string,
  milestone: string,
  createdAt: string,
): AppNotification {
  return {
    id,
    title: milestone,
    body: "",
    kind: "info",
    createdAt,
    metadata: {
      category: "agent_creation_progress",
      progress: {
        status: "running",
        runId,
        packageName: "@cinatra-ai/planner-agent",
        milestone,
        ts: createdAt,
      },
    },
  };
}

describe("filterAgentCreationProgressByRunId", () => {
  it("returns matching rows ASCENDING by createdAt", () => {
    const newer = progressRow("a", "r-1", "review_done", "2026-05-17T00:00:02Z");
    const oldest = progressRow("b", "r-1", "queued", "2026-05-17T00:00:00Z");
    const middle = progressRow("c", "r-1", "validating", "2026-05-17T00:00:01Z");
    const out = filterAgentCreationProgressByRunId([newer, oldest, middle], "r-1");
    expect(out.map((n) => n.id)).toEqual(["b", "c", "a"]);
  });

  it("drops rows for a different runId", () => {
    const own = progressRow("a", "r-1", "queued", "2026-05-17T00:00:00Z");
    const other = progressRow("b", "r-2", "queued", "2026-05-17T00:00:00Z");
    expect(filterAgentCreationProgressByRunId([own, other], "r-1").map((n) => n.id)).toEqual([
      "a",
    ]);
  });

  it("drops non-info rows even when metadata claims to be agent_creation_progress", () => {
    const bad = progressRow("a", "r-1", "queued", "2026-05-17T00:00:00Z");
    bad.kind = "success";
    expect(filterAgentCreationProgressByRunId([bad], "r-1")).toEqual([]);
  });

  it("drops info rows whose metadata.category is NOT agent_creation_progress", () => {
    const bgRow: AppNotification = {
      id: "a",
      title: "x",
      body: "",
      kind: "info",
      createdAt: "2026-05-17T00:00:00Z",
      metadata: {
        category: "background_process",
        progress: { status: "running", runId: "r-1" },
      },
    };
    expect(filterAgentCreationProgressByRunId([bgRow], "r-1")).toEqual([]);
  });

  it("returns [] for an empty runId (defensive)", () => {
    const row = progressRow("a", "r-1", "queued", "2026-05-17T00:00:00Z");
    expect(filterAgentCreationProgressByRunId([row], "")).toEqual([]);
  });
});
