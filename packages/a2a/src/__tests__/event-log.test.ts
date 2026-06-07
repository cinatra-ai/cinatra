/**
 * Integration tests for event-log.ts.
 *
 * Requires a running Redis at REDIS_URL (default 127.0.0.1:6379). Each
 * test is guarded by `if (!redisAvailable) return` so `pnpm test` stays
 * infra-free when Redis is not running (CI should spin Redis up for full
 * coverage; local `pnpm test` auto-skips).
 *
 * Coverage includes appending events, historical reads, live tailing,
 * approximate trimming, expiry, and cursor race protection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

import {
  xaddRunEvent,
  readRunEvents,
  expireRunStream,
  __disconnectSharedEventLogPublisher,
} from "../event-log";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

async function isRedisReachable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 500,
    enableOfflineQueue: false,
  });
  try {
    await probe.connect();
    const pong = await probe.ping();
    return pong === "PONG";
  } catch {
    return false;
  } finally {
    try {
      await probe.quit();
    } catch {
      /* ignore */
    }
  }
}

let redisAvailable = false;
beforeAll(async () => {
  redisAvailable = await isRedisReachable();
});
afterAll(async () => {
  await __disconnectSharedEventLogPublisher();
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("event-log (Redis Streams)", () => {
  it("xaddRunEvent appends and returns a monotonic Redis Streams ID", async () => {
    if (!redisAvailable) {
      console.warn("[event-log] Redis unreachable — skipping");
      return;
    }
    const runId = randomUUID();
    const id1 = await xaddRunEvent(runId, { type: "status", state: "working" });
    const id2 = await xaddRunEvent(runId, {
      type: "status",
      state: "completed",
    });
    expect(id1).toMatch(/^\d+-\d+$/);
    expect(id2).toMatch(/^\d+-\d+$/);
    expect(id2 > id1).toBe(true); // lexicographic comparison works for this format
  });

  it("readRunEvents yields historical entries starting from fromId (exclusive)", async () => {
    if (!redisAvailable) {
      console.warn("[event-log] Redis unreachable — skipping");
      return;
    }
    const runId = randomUUID();
    const id1 = await xaddRunEvent(runId, { seq: 1 });
    await xaddRunEvent(runId, { seq: 2 });
    await xaddRunEvent(runId, { seq: 3 });
    const ctrl = new AbortController();
    const gen = readRunEvents(runId, {
      fromId: id1,
      signal: ctrl.signal,
      inactivityMs: 500,
    });
    const collected: Array<{ id: string; event: Record<string, unknown> }> = [];
    for await (const entry of gen) {
      collected.push(entry);
      if (collected.length >= 2) break;
    }
    ctrl.abort();
    expect(collected).toHaveLength(2);
    expect(collected[0].event.seq).toBe(2);
    expect(collected[1].event.seq).toBe(3);
  });

  it("readRunEvents live-tails via notify channel after catch-up", async () => {
    if (!redisAvailable) {
      console.warn("[event-log] Redis unreachable — skipping");
      return;
    }
    const runId = randomUUID();
    await xaddRunEvent(runId, { phase: "historical" });
    const ctrl = new AbortController();
    const collected: Record<string, unknown>[] = [];
    const gen = readRunEvents(runId, {
      signal: ctrl.signal,
      inactivityMs: 2000,
    });
    const readerP = (async () => {
      for await (const { event } of gen) {
        collected.push(event);
        if (collected.length >= 2) break;
      }
    })();
    await sleep(100); // let reader enter live-tail
    await xaddRunEvent(runId, { phase: "live" });
    await readerP;
    ctrl.abort();
    expect(collected[0].phase).toBe("historical");
    expect(collected[1].phase).toBe("live");
  });

  it("MAXLEN ~ 1000 caps stream at approximately 1000 entries", async () => {
    if (!redisAvailable) {
      console.warn("[event-log] Redis unreachable — skipping");
      return;
    }
    const runId = randomUUID();
    for (let i = 0; i < 1100; i++) {
      await xaddRunEvent(runId, { i });
    }
    const probe = new Redis(REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
    });
    try {
      const len = await probe.xlen(`cinatra:a2a:events:${runId}`);
      // Approximate trimming — stream may carry a few tens of extras over 1000.
      expect(len).toBeGreaterThanOrEqual(1000);
      expect(len).toBeLessThanOrEqual(1500);
    } finally {
      await probe.quit().catch(() => {});
    }
  });

  it("expireRunStream sets EXPIRE on the stream key", async () => {
    if (!redisAvailable) {
      console.warn("[event-log] Redis unreachable — skipping");
      return;
    }
    const runId = randomUUID();
    await xaddRunEvent(runId, { terminal: true });
    await expireRunStream(runId, 3600);
    const probe = new Redis(REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
    });
    try {
      const ttl = await probe.ttl(`cinatra:a2a:events:${runId}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(3600);
    } finally {
      await probe.quit().catch(() => {});
    }
  });

  it("Two-phase cursor catches events published between XRANGE and SUBSCRIBE", async () => {
    if (!redisAvailable) {
      console.warn("[event-log] Redis unreachable — skipping");
      return;
    }
    // Listener-before-subscribe ordering means events in the gap window are
    // not lost.
    const runId = randomUUID();
    await xaddRunEvent(runId, { phase: "pre-subscribe-1" });
    await xaddRunEvent(runId, { phase: "pre-subscribe-2" });
    const ctrl = new AbortController();
    const collected: Record<string, unknown>[] = [];
    const gen = readRunEvents(runId, {
      signal: ctrl.signal,
      inactivityMs: 1500,
    });
    const readerP = (async () => {
      for await (const { event } of gen) {
        collected.push(event);
        if (collected.length >= 3) break;
      }
    })();
    // Race with the reader — publish a new event while catch-up is running.
    await xaddRunEvent(runId, { phase: "race-window" });
    await readerP;
    ctrl.abort();
    expect(collected.map((e) => e.phase)).toEqual([
      "pre-subscribe-1",
      "pre-subscribe-2",
      "race-window",
    ]);
  });
});
