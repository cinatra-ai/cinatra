/**
 * Regression test for the Redis reconnect-backoff strategy.
 *
 * The original `retryStrategy: () => null` returned null on the FIRST
 * reconnect attempt, telling IORedis to give up forever. Symptom in dev:
 * jobs piled up in BullMQ `wait` while `active` stayed at 0 after any
 * Redis blip (network hiccup, container restart, transient partition).
 *
 * This pins the new strategy:
 *  - first attempt returns a positive delay (not null),
 *  - early retries are short (≤ 200ms),
 *  - the curve plateaus at the 2000ms ceiling,
 *  - and NEVER returns null (a 50-attempt cap returning null after a
 *    sustained outage reintroduced the silent-drop pattern this fix
 *    exists to prevent).
 *
 * If a future change accidentally re-introduces the silent-drop, these
 * assertions fail and the agent-worker reliability regression caught.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/notifications-host", () => ({}));

import { redisReconnectBackoff } from "../background-jobs";

describe("redisReconnectBackoff", () => {
  it("returns a positive delay on the first attempt (no silent give-up)", () => {
    const d = redisReconnectBackoff(1);
    expect(typeof d).toBe("number");
    expect(d).toBeGreaterThan(0);
  });

  it("starts under 200ms so transient blips self-heal fast", () => {
    expect(redisReconnectBackoff(1)).toBeLessThanOrEqual(200);
    expect(redisReconnectBackoff(2)).toBeLessThanOrEqual(200);
  });

  it("caps at the 2000ms ceiling once the exponential climbs past it", () => {
    for (let n = 10; n <= 50; n++) {
      expect(redisReconnectBackoff(n)).toBeLessThanOrEqual(2000);
    }
  });

  it("NEVER returns null — retries forever (capping reintroduced silent-drop)", () => {
    // Beyond the prior 50-attempt cap, beyond any realistic outage window,
    // and at an absurd retry count — backoff must remain a positive number.
    // Returning null would tell IORedis to stop reconnecting, which is the
    // exact silent-drop pattern this fix exists to prevent.
    expect(redisReconnectBackoff(51)).toBeGreaterThan(0);
    expect(redisReconnectBackoff(100)).toBeGreaterThan(0);
    expect(redisReconnectBackoff(1000)).toBeGreaterThan(0);
    expect(redisReconnectBackoff(Number.MAX_SAFE_INTEGER)).toBeGreaterThan(0);
  });
});
