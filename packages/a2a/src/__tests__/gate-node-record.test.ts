/**
 * cinatra#3745 — the gate store keeps the step that paused a run.
 *
 * `rememberWayflowGateNodeClaim(runId, taskId, claim)` stores the flow
 * runtime's signed claim `{ node, attestation }` under
 * `cinatra:wayflow:gate-node:<runId>:<taskId>` with the gate sequence's
 * seven-day time to live; `resolveWayflowGateNodeClaim(runId, taskId)` reads
 * it back (null when absent or malformed). The client is a fake `ioredis`
 * class in the shape of packages/streams/src/__tests__/event-log.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const hoisted = vi.hoisted(() => {
  const store = new Map<string, { value: string; mode?: string; ttl?: number }>();
  const setCalls: unknown[][] = [];
  class FakeRedis {
    async set(key: string, value: string, mode?: string, ttl?: number): Promise<"OK"> {
      setCalls.push([key, value, mode, ttl]);
      store.set(key, { value, mode, ttl });
      return "OK";
    }
    async get(key: string): Promise<string | null> {
      return store.get(key)?.value ?? null;
    }
    async quit(): Promise<"OK"> {
      return "OK";
    }
    on(): this {
      return this;
    }
  }
  return { store, setCalls, FakeRedis };
});

vi.mock("ioredis", () => ({ Redis: hoisted.FakeRedis, default: hoisted.FakeRedis }));

import * as eventLog from "../event-log";

type Claim = { node: string; attestation: string };
const api = eventLog as unknown as {
  rememberWayflowGateNodeClaim: (runId: string, taskId: string, claim: Claim) => Promise<void>;
  resolveWayflowGateNodeClaim: (runId: string, taskId: string) => Promise<Claim | null>;
  __disconnectSharedEventLogPublisher: () => Promise<void>;
};

const CLAIM: Claim = { node: "review-step-node", attestation: "g1:" + "cd".repeat(32) };
const SEVEN_DAYS_S = 7 * 24 * 3600;

beforeEach(() => {
  hoisted.store.clear();
  hoisted.setCalls.length = 0;
});

afterAll(async () => {
  await api.__disconnectSharedEventLogPublisher();
  vi.doUnmock("ioredis");
  vi.resetModules();
});

describe("the gate store's pause step record", () => {
  // (n1)
  it("a stored claim reads back for its run and gate task", async () => {
    await api.rememberWayflowGateNodeClaim("run-1", "task-1", CLAIM);
    await expect(api.resolveWayflowGateNodeClaim("run-1", "task-1")).resolves.toEqual(CLAIM);
    await expect(api.resolveWayflowGateNodeClaim("run-1", "task-2")).resolves.toBeNull();
    // exported from the package surface beside the other gate functions
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const exportLine = index
      .split("\n")
      .find((line) => line.includes("rememberLatestWayflowGateTask") && line.includes('from "./event-log"'));
    expect(exportLine).toContain("rememberWayflowGateNodeClaim");
    expect(exportLine).toContain("resolveWayflowGateNodeClaim");
  });

  // (n2)
  it("the write is one SET of the run and task key with the seven-day time to live", async () => {
    await api.rememberWayflowGateNodeClaim("run-1", "task-1", CLAIM);
    expect(hoisted.setCalls).toHaveLength(1);
    const [key, value, mode, ttl] = hoisted.setCalls[0]!;
    expect(key).toBe("cinatra:wayflow:gate-node:run-1:task-1");
    expect(JSON.parse(value as string)).toEqual(CLAIM);
    expect(mode).toBe("EX");
    expect(ttl).toBe(SEVEN_DAYS_S);
  });

  // (n3)
  it("an absent or malformed record reads as null", async () => {
    await expect(api.resolveWayflowGateNodeClaim("run-9", "task-9")).resolves.toBeNull();
    for (const raw of [
      "not json",
      "null",
      "42",
      JSON.stringify({ node: "n" }),
      JSON.stringify({ attestation: CLAIM.attestation }),
      JSON.stringify({ node: 7, attestation: CLAIM.attestation }),
      JSON.stringify({ node: "", attestation: CLAIM.attestation }),
      JSON.stringify([CLAIM]),
    ]) {
      hoisted.store.set("cinatra:wayflow:gate-node:run-9:task-9", { value: raw });
      await expect(api.resolveWayflowGateNodeClaim("run-9", "task-9")).resolves.toBeNull();
    }
    await expect(api.resolveWayflowGateNodeClaim("", "task-9")).resolves.toBeNull();
    await expect(api.resolveWayflowGateNodeClaim("run-9", "")).resolves.toBeNull();
  });
});
