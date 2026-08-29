/**
 * THE ROW OVERRULES A MUTE STREAM, AND ONLY A MUTE ONE (cinatra#3046).
 *
 * cinatra#3007 gave a run a way to stop without announcing it: a run whose
 * produced output opens a review parks and reaches no terminal status, so it
 * emits no RUN_FINISHED and no RUN_ERROR. `resolveStreamFirst` then pins the
 * surface to the stream's last word — `running` — for the whole park, which is
 * what kept the conversation's placeholder up four minutes after the gate row
 * existed on two measured real runs.
 *
 * These pins hold the narrow rule that closes it, in both directions: the row
 * wins exactly where the stream is provably mute and the row has something the
 * stream cannot reach, and nowhere else.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/run-surface-status.produced-review-park.test.ts
 */
import { describe, expect, it } from "vitest";

import { resolveRunSurfaceStatus, resolveStreamFirst } from "../run-surface-status";

const base = {
  streamEnabled: true,
  streamedStatus: "running" as string | null,
  polledStatus: "running",
  rowStatus: null as string | null,
};

describe("resolveRunSurfaceStatus — the park the stream cannot announce", () => {
  it("a mute stream is overruled by a row that reports the park", () => {
    expect(
      resolveRunSurfaceStatus({ ...base, rowStatus: "pending_approval" }),
    ).toBe("pending_approval");
  });

  it.each(["completed", "failed", "stopped"])(
    "a mute stream is overruled by a row that reports %s — the statuses a park is released into",
    (terminal) => {
      expect(resolveRunSurfaceStatus({ ...base, rowStatus: terminal })).toBe(terminal);
    },
  );

  it("a queued stream is mute too — the run can park from either working status", () => {
    expect(
      resolveRunSurfaceStatus({
        ...base,
        streamedStatus: "queued",
        rowStatus: "pending_approval",
      }),
    ).toBe("pending_approval");
  });

  it("a stream that has SPOKEN keeps its say, even against a disagreeing row", () => {
    // The guard that keeps this from becoming "the row always wins". A stream
    // that reached a terminal state has announced it; a row lagging behind it is
    // the stale reading, not the fresh one.
    expect(
      resolveRunSurfaceStatus({
        ...base,
        streamedStatus: "completed",
        rowStatus: "running",
      }),
    ).toBe("completed");
  });

  it("a row that only disagrees about the working status changes nothing", () => {
    // `queued` versus `running` is exactly where the stream is ahead of the poll,
    // and it stays ahead: neither is a status the stream cannot leave on its own.
    expect(
      resolveRunSurfaceStatus({
        ...base,
        streamedStatus: "running",
        rowStatus: "queued",
      }),
    ).toBe("running");
  });

  it("with the stream off, or unheard, or the row unread, it IS resolveStreamFirst", () => {
    // The unchanged callers must get byte-for-byte the old answer. Asserted
    // against the old function rather than against a copy of its result.
    const cases = [
      { streamEnabled: false, streamedStatus: "running", polledStatus: "pending_approval", rowStatus: "completed" },
      { streamEnabled: true, streamedStatus: null, polledStatus: "pending_approval", rowStatus: "completed" },
      { streamEnabled: true, streamedStatus: "running", polledStatus: "queued", rowStatus: null },
    ];
    for (const c of cases) {
      expect(resolveRunSurfaceStatus(c)).toBe(
        resolveStreamFirst(c.streamEnabled, c.streamedStatus, c.polledStatus),
      );
    }
  });
});
