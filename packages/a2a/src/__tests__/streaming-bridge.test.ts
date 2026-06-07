/**
 * Streaming bridge tests.
 *
 * Verifies Redis pub/sub round-trip semantics for the prototype streaming
 * bridge:
 *   - pub/sub round-trip (N events in publish order)
 *   - abort-signal cleanup
 *   - inactivity timeout
 *   - no leaked Redis subscriber connections after generator cleanup
 *
 * Requires a running Redis at REDIS_URL or 127.0.0.1:6379. The suite
 * auto-skips when Redis is unreachable so `pnpm test` stays infra-free.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

import {
  publishRunEvent,
  subscribeToRunEvents,
  type RunStreamEvent,
  __disconnectSharedPublisher,
} from "../streaming-bridge";

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
  await __disconnectSharedPublisher();
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// describe.skipIf cannot read async beforeAll state (redisAvailable is set
// in beforeAll, which runs after Vitest collects describe blocks). Each test
// guards individually via `if (!redisAvailable) return` — that is the
// authoritative skip mechanism. The outer describe has no skipIf predicate.
describe(
  "streaming-bridge (Redis pub/sub prototype)",
  () => {
    // Gate each test on runtime probe result — the describe-level skipIf
    // can't read async beforeAll state.
    it("pub/sub round-trip delivers 5 events in publish order", async () => {
      if (!redisAvailable) {
        console.warn("[streaming-bridge] Redis unreachable — skipping test");
        return;
      }

      const runId = randomUUID();
      const received: RunStreamEvent[] = [];

      // Start subscriber first so we don't lose events (pub/sub is ephemeral).
      const sub = subscribeToRunEvents(runId, {
        inactivityTimeoutMs: 10_000,
      });

      // Pump subscriber into array concurrently.
      const consumer = (async () => {
        for await (const evt of sub) {
          received.push(evt);
          if (evt.type === "done") break;
        }
      })();

      // Give subscriber a tick to attach.
      await sleep(100);

      // Publish 5 events + terminal done.
      const events: RunStreamEvent[] = [
        { type: "status", state: "working" },
        { type: "status", state: "working.step1" },
        {
          type: "artifact",
          artifact: {
            name: "r1",
            parts: [{ kind: "text", text: "hello" }],
          },
        },
        { type: "status", state: "working.step2" },
        { type: "status", state: "completing" },
      ];
      for (const evt of events) {
        await publishRunEvent(runId, evt);
      }
      await publishRunEvent(runId, { type: "done" });

      await consumer;

      expect(received).toHaveLength(6);
      expect(received[0]).toEqual({ type: "status", state: "working" });
      expect(received[1]).toEqual({ type: "status", state: "working.step1" });
      expect(received[2]).toMatchObject({
        type: "artifact",
        artifact: { name: "r1" },
      });
      expect(received[5]).toEqual({ type: "done" });
    }, 15_000);

    it("abort signal closes the generator cleanly", async () => {
      if (!redisAvailable) {
        console.warn("[streaming-bridge] Redis unreachable — skipping test");
        return;
      }

      const runId = randomUUID();
      const controller = new AbortController();
      const received: RunStreamEvent[] = [];

      const sub = subscribeToRunEvents(runId, {
        signal: controller.signal,
        inactivityTimeoutMs: 30_000,
      });

      const consumer = (async () => {
        try {
          for await (const evt of sub) {
            received.push(evt);
            if (received.length === 2) {
              controller.abort();
            }
          }
        } catch (err) {
          // Should NOT throw — abort is a clean close.
          throw new Error(
            `subscribeToRunEvents threw after abort: ${String(err)}`,
          );
        }
      })();

      await sleep(100);
      await publishRunEvent(runId, { type: "status", state: "working" });
      await publishRunEvent(runId, { type: "status", state: "step2" });

      // Consumer should resolve without throwing after abort.
      await consumer;

      expect(received.length).toBeGreaterThanOrEqual(2);
    }, 10_000);

    it("inactivity timeout yields done and closes", async () => {
      if (!redisAvailable) {
        console.warn("[streaming-bridge] Redis unreachable — skipping test");
        return;
      }

      const runId = randomUUID();
      const received: RunStreamEvent[] = [];

      const sub = subscribeToRunEvents(runId, {
        inactivityTimeoutMs: 1_500,
      });

      const start = Date.now();
      for await (const evt of sub) {
        received.push(evt);
        if (evt.type === "done") break;
      }
      const elapsed = Date.now() - start;

      expect(received).toEqual([{ type: "done" }]);
      // Should have waited at least ~1s (allow scheduler slack).
      expect(elapsed).toBeGreaterThanOrEqual(1_000);
      // And not blocked indefinitely.
      expect(elapsed).toBeLessThan(5_000);
    }, 10_000);

    it("subscriber connection is closed after generator return", async () => {
      if (!redisAvailable) {
        console.warn("[streaming-bridge] Redis unreachable — skipping test");
        return;
      }

      // We can't directly introspect the subscriber handle from outside the
      // module, so verify no leak indirectly:
      //   (a) open N subscribers back-to-back,
      //   (b) each subscribes then immediately receives `done`,
      //   (c) after the loop, Redis's client_list should not show a
      //       monotonically-growing count attributable to our subscribers.
      const monitor = new Redis(REDIS_URL);
      try {
        const before = (await monitor.client("LIST")) as string;
        const beforeCount = before.split("\n").length;

        for (let i = 0; i < 5; i++) {
          const runId = randomUUID();
          const sub = subscribeToRunEvents(runId, {
            inactivityTimeoutMs: 300,
          });
          for await (const evt of sub) {
            if (evt.type === "done") break;
          }
        }

        // Give Redis a moment to garbage-collect QUIT'd connections.
        await sleep(500);

        const after = (await monitor.client("LIST")) as string;
        const afterCount = after.split("\n").length;

        // Tolerate some slack — other test code/connections may come and go.
        // The key assertion is we didn't accumulate 5 leaked subscribers.
        expect(afterCount - beforeCount).toBeLessThan(5);
      } finally {
        await monitor.quit();
      }
    }, 15_000);
  },
);
