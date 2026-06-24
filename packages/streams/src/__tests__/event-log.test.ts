import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory ioredis fake — no live Redis. One shared in-process Redis-Streams
// substitute backs every fake connection so XADD on the publisher is visible to
// XRANGE on the reader and PUBLISH wakes the subscriber, exactly like a real
// broker. This proves the event-log mechanics (append→replay-from-cursor,
// live-tail wake, inactivity timeout, abort, approximate trim) infra-free.
//
// `vi.mock` factories are hoisted above all imports, so the broker the factory
// references is created via `vi.hoisted`. The test body reads the SAME instance
// back from the hoisted result.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  type Entry = { id: string; fields: string[] };

  class FakeBroker {
    streams = new Map<string, Entry[]>();
    seq = 0;
    subscribers = new Map<string, Set<(channel: string, message: string) => void>>();

    xadd(key: string, maxLen: number, payload: string): string {
      const list = this.streams.get(key) ?? [];
      const id = `${1000 + ++this.seq}-0`;
      list.push({ id, fields: ["data", payload] });
      // Approximate MAXLEN trim — evict oldest beyond maxLen.
      while (list.length > maxLen) list.shift();
      this.streams.set(key, list);
      return id;
    }

    xrange(key: string, start: string): Array<[string, string[]]> {
      const list = this.streams.get(key) ?? [];
      let exclusiveLower: string | null = null;
      let inclusiveLower: string | null = null;
      if (start === "-") {
        /* full */
      } else if (start.startsWith("(")) {
        exclusiveLower = start.slice(1);
      } else {
        inclusiveLower = start;
      }
      return list
        .filter((e) => {
          if (exclusiveLower !== null) return e.id > exclusiveLower;
          if (inclusiveLower !== null) return e.id >= inclusiveLower;
          return true;
        })
        .map((e) => [e.id, e.fields] as [string, string[]]);
    }

    xrevrange(key: string, count: number): Array<[string, string[]]> {
      const list = this.streams.get(key) ?? [];
      return [...list]
        .reverse()
        .slice(0, count)
        .map((e) => [e.id, e.fields] as [string, string[]]);
    }

    publish(channel: string, message: string): void {
      const subs = this.subscribers.get(channel);
      if (subs) for (const cb of subs) cb(channel, message);
    }

    subscribe(channel: string, cb: (channel: string, message: string) => void): void {
      const set = this.subscribers.get(channel) ?? new Set();
      set.add(cb);
      this.subscribers.set(channel, set);
    }

    unsubscribe(channel: string, cb: (channel: string, message: string) => void): void {
      this.subscribers.get(channel)?.delete(cb);
    }
  }

  const sharedBroker = new FakeBroker();

  class FakeRedis {
    private messageListeners = new Set<(channel: string, message: string) => void>();
    private subscribed = new Set<string>();
    private broker = sharedBroker;

    pipeline() {
      const ops: Array<() => unknown> = [];
      const broker = this.broker;
      const api = {
        xadd(
          key: string,
          _ml: string,
          _approx: string,
          maxLen: string,
          _star: string,
          _f: string,
          payload: string,
        ) {
          ops.push(() => broker.xadd(key, Number(maxLen), payload));
          return api;
        },
        async exec(): Promise<Array<[Error | null, unknown]>> {
          return ops.map((op) => [null, op()]);
        },
      };
      return api;
    }

    async publish(channel: string, message: string): Promise<number> {
      this.broker.publish(channel, message);
      return 1;
    }

    async expire(): Promise<number> {
      return 1;
    }

    async xrange(key: string, start: string): Promise<Array<[string, string[]]>> {
      return this.broker.xrange(key, start);
    }

    async xrevrange(
      key: string,
      _plus: string,
      _minus: string,
      _count: string,
      count: string,
    ): Promise<Array<[string, string[]]>> {
      return this.broker.xrevrange(key, Number(count));
    }

    on(event: string, cb: (channel: string, message: string) => void): this {
      if (event === "message") {
        this.messageListeners.add(cb);
        for (const ch of this.subscribed) this.broker.subscribe(ch, cb);
      }
      return this;
    }

    off(event: string, cb: (channel: string, message: string) => void): this {
      if (event === "message") {
        this.messageListeners.delete(cb);
        for (const ch of this.subscribed) this.broker.unsubscribe(ch, cb);
      }
      return this;
    }

    async subscribe(channel: string): Promise<void> {
      this.subscribed.add(channel);
      for (const cb of this.messageListeners) this.broker.subscribe(channel, cb);
    }

    async unsubscribe(channel: string): Promise<void> {
      for (const cb of this.messageListeners) this.broker.unsubscribe(channel, cb);
      this.subscribed.delete(channel);
    }

    async quit(): Promise<"OK"> {
      return "OK";
    }
  }

  return { sharedBroker, FakeRedis };
});

const broker = hoisted.sharedBroker;

vi.mock("ioredis", () => ({ Redis: hoisted.FakeRedis }));

import { createDurableEventLog, type DurableEventLog } from "../event-log";

function makeLog(): DurableEventLog {
  return createDurableEventLog({
    redisUrl: "redis://localhost",
    streamKey: (id) => `test:events:${id}`,
    notifyChannel: (id) => `test:notify:${id}`,
    maxLen: 5,
    inactivityMs: 200,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
  broker.streams.clear();
  broker.subscribers.clear();
  broker.seq = 0;
});

describe("durable event log", () => {
  it("append returns a monotonic SSE-safe stream id", async () => {
    const log = makeLog();
    const id1 = await log.append("run1", { type: "status", state: "working" });
    const id2 = await log.append("run1", { type: "status", state: "completed" });
    expect(id1).toMatch(/^\d+-\d+$/);
    expect(id2).toMatch(/^\d+-\d+$/);
    expect(id2 > id1).toBe(true);
    await log.disconnect();
  });

  it("read replays history from a cursor (exclusive) then stops on inactivity", async () => {
    const log = makeLog();
    const id1 = await log.append("run1", { seq: 1 });
    await log.append("run1", { seq: 2 });
    await log.append("run1", { seq: 3 });

    const seen: number[] = [];
    for await (const { event } of log.read("run1", { fromId: id1, inactivityMs: 150 })) {
      seen.push(event.seq as number);
    }
    // fromId is exclusive — seq 1 is skipped.
    expect(seen).toEqual([2, 3]);
    await log.disconnect();
  });

  it("read live-tails: a notify wakes the reader to yield a newly-appended event", async () => {
    const log = makeLog();
    const seen: number[] = [];
    const ctrl = new AbortController();
    const consume = (async () => {
      for await (const { event } of log.read("run2", {
        signal: ctrl.signal,
        inactivityMs: 2000,
      })) {
        seen.push(event.seq as number);
        if (seen.length === 2) {
          ctrl.abort();
          return;
        }
      }
    })();
    await sleep(20);
    await log.append("run2", { seq: 10 });
    await sleep(20);
    await log.append("run2", { seq: 11 });
    await consume;
    expect(seen).toEqual([10, 11]);
    await log.disconnect();
  });

  it("does not lose an event whose notify lands between iterations (pending-notify latch)", async () => {
    const log = makeLog();
    const seen: number[] = [];
    const ctrl = new AbortController();
    const consume = (async () => {
      for await (const { event } of log.read("race", {
        signal: ctrl.signal,
        inactivityMs: 1000,
      })) {
        seen.push(event.seq as number);
        // While inside the loop body (no waiter armed), append another event.
        // Its notify hits onMessage with wakeUp === null → must latch and be
        // re-read on the next pass rather than being dropped.
        if (event.seq === 1) {
          await log.append("race", { seq: 2 });
        }
        if (seen.length === 2) {
          ctrl.abort();
          return;
        }
      }
    })();
    await sleep(10);
    await log.append("race", { seq: 1 });
    await consume;
    expect(seen).toEqual([1, 2]);
    await log.disconnect();
  });

  it("read returns when the inactivity timeout fires with no events", async () => {
    const log = makeLog();
    const start = Date.now();
    const seen: unknown[] = [];
    for await (const e of log.read("empty-run", { inactivityMs: 120 })) {
      seen.push(e);
    }
    expect(seen).toEqual([]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    await log.disconnect();
  });

  it("read returns immediately when the signal is already aborted", async () => {
    const log = makeLog();
    await log.append("run3", { seq: 1 });
    const ctrl = new AbortController();
    ctrl.abort();
    const seen: unknown[] = [];
    for await (const e of log.read("run3", { signal: ctrl.signal })) {
      seen.push(e);
    }
    expect(seen).toEqual([]);
    await log.disconnect();
  });

  it("approximate MAXLEN trims the oldest entries past the threshold", async () => {
    const log = makeLog(); // maxLen 5
    for (let i = 0; i < 8; i++) await log.append("trim", { seq: i });
    const recent = await log.readRecentReverse("trim", 100);
    expect(recent).toHaveLength(5);
    // newest-first; the 3 oldest (0,1,2) were evicted.
    expect(recent.map((r) => r.event.seq)).toEqual([7, 6, 5, 4, 3]);
    await log.disconnect();
  });

  it("readRecentReverse returns most-recent N newest-first", async () => {
    const log = makeLog();
    await log.append("r", { seq: 1 });
    await log.append("r", { seq: 2 });
    const recent = await log.readRecentReverse("r", 1);
    expect(recent.map((x) => x.event.seq)).toEqual([2]);
    await log.disconnect();
  });

  it("append surfaces an XADD failure (logged, then rethrown)", async () => {
    const log = makeLog();
    const spy = vi.spyOn(broker, "xadd").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(log.append("run", { x: 1 })).rejects.toThrow("boom");
    expect(errSpy).toHaveBeenCalled();
    spy.mockRestore();
    errSpy.mockRestore();
    await log.disconnect();
  });
});
