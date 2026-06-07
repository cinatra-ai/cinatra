import { afterAll, describe, expect, it } from "vitest";
import { AgUiAdapter, __disconnectSharedAgUiPublisher } from "../ag-ui-adapter";
import type { AgUiEvent } from "../events";

afterAll(async () => { await __disconnectSharedAgUiPublisher(); });

describe("AgUiAdapter", () => {
  function makeAdapter(events: AgUiEvent[]) {
    const publish = async (e: AgUiEvent) => { events.push(e); };
    return new AgUiAdapter("run-123", "thread-456", publish);
  }

  it("P80-01: onRunStarted emits RUN_STARTED with runId and threadId", async () => {
    const events: AgUiEvent[] = [];
    const adapter = makeAdapter(events);
    adapter.onRunStarted();
    await new Promise(r => setTimeout(r, 0)); // drain microtasks
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("RUN_STARTED");
    const e = events[0] as { type: "RUN_STARTED"; runId: string; threadId: string };
    expect(e.runId).toBe("run-123");
    expect(e.threadId).toBe("thread-456");
  });

  it("P80-02: onStateSnapshot emits STATE_SNAPSHOT with snapshot payload", async () => {
    const events: AgUiEvent[] = [];
    const adapter = makeAdapter(events);
    const hint = { type: "card_list", items: [] };
    adapter.onStateSnapshot(hint);
    await new Promise(r => setTimeout(r, 0));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("STATE_SNAPSHOT");
    const e = events[0] as { type: "STATE_SNAPSHOT"; snapshot: unknown };
    expect(e.snapshot).toEqual(hint);
  });

  it("P80-03a: onRunFinished('completed') emits RUN_FINISHED", async () => {
    const events: AgUiEvent[] = [];
    makeAdapter(events).onRunFinished("completed");
    await new Promise(r => setTimeout(r, 0));
    expect(events[0].type).toBe("RUN_FINISHED");
  });

  it("P80-03b: onRunFinished('failed', msg) emits RUN_ERROR with message, runId, threadId", async () => {
    const events: AgUiEvent[] = [];
    makeAdapter(events).onRunFinished("failed", "oops");
    await new Promise(r => setTimeout(r, 0));
    expect(events[0].type).toBe("RUN_ERROR");
    const e = events[0] as { type: "RUN_ERROR"; message: string; runId: string; threadId: string };
    expect(e.message).toBe("oops");
    expect(e.runId).toBe("run-123");
    expect(e.threadId).toBe("thread-456");
  });

  it("WR-01/WR-03: onRunFinished('stopped') emits RUN_FINISHED with status 'stopped'", async () => {
    const events: AgUiEvent[] = [];
    makeAdapter(events).onRunFinished("stopped");
    await new Promise(r => setTimeout(r, 0));
    expect(events[0].type).toBe("RUN_FINISHED");
    const e = events[0] as { type: "RUN_FINISHED"; status?: string; runId: string; threadId: string };
    expect(e.status).toBe("stopped");
    expect(e.runId).toBe("run-123");
    expect(e.threadId).toBe("thread-456");
  });
});
