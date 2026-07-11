/**
 * Durable run-context binding store (#1195, first slice).
 *
 * Exercises the REAL module against a Map-backed fake redis. The load-bearing
 * contracts:
 *   - the binding survives a process restart (module state reset) — only the
 *     redis backing carries it (the in-process Map this slice replaces could
 *     not do this);
 *   - raw bearer material NEVER reaches redis (keys are sha256; values carry
 *     only the run-token hash);
 *   - strict absent-vs-invalid classification: transport failure / no key ⇒
 *     "absent" (transition fallback allowed); present-but-malformed /
 *     token-miss / lookup-error-after-found ⇒ "invalid" (FAIL CLOSED — the
 *     caller suppresses the legacy channels);
 *   - per-invocation-unique keys ⇒ clearing one request's keys can never
 *     delete another's binding.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

vi.mock("server-only", () => ({}));

import {
  writeDurableRunContextBinding,
  clearDurableRunContextBindings,
  resolveDurableRunContext,
  durableRunContextKey,
  DURABLE_RUN_CONTEXT_TTL_SECONDS,
  type DurableBindingRedis,
} from "@/lib/agent-run-context-durable";

class FakeRedis implements DurableBindingRedis {
  store = new Map<string, { value: string; ttlSeconds: number }>();
  failSet = false;
  failGet = false;
  failDel = false;

  async set(
    key: string,
    value: string,
    _expiryMode: "EX",
    ttlSeconds: number,
  ): Promise<unknown> {
    if (this.failSet) throw new Error("redis down");
    this.store.set(key, { value, ttlSeconds });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    if (this.failGet) throw new Error("redis down");
    return this.store.get(key)?.value ?? null;
  }

  async del(...keys: string[]): Promise<unknown> {
    if (this.failDel) throw new Error("redis down");
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n += 1;
    return n;
  }
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const BEARER_A = "machine-token-A-raw-bearer";
const BEARER_B = "machine-token-B-raw-bearer";

const lookup = (rows: Record<string, { id: string; orgId: string; runBy: string | null }>) =>
  vi.fn(async (hash: string) => rows[hash] ?? null);

let redis: FakeRedis;

beforeEach(() => {
  redis = new FakeRedis();
});

describe("durable run-context binding — write/read/clear", () => {
  it("round-trips a binding and resolves the run through the token-hash lookup", async () => {
    const key = await writeDurableRunContextBinding(
      BEARER_A,
      {
        tokenHash: HASH_A,
        agentId: "agent-1",
        packageVersion: "1.2.3",
        agentSpecVersion: "7",
      },
      redis,
    );
    expect(key).toBe(durableRunContextKey(BEARER_A));

    const lookupByHash = lookup({
      [HASH_A]: { id: "run-1", orgId: "org-1", runBy: "user-1" },
    });
    const resolution = await resolveDurableRunContext(BEARER_A, lookupByHash, redis);
    expect(resolution).toEqual({
      outcome: "resolved",
      ctx: {
        runId: "run-1",
        agentId: "agent-1",
        packageVersion: "1.2.3",
        agentSpecVersion: "7",
      },
    });
    expect(lookupByHash).toHaveBeenCalledWith(HASH_A);
  });

  it("SURVIVES A PROCESS RESTART: a fresh module instance resolves a binding written before the reset", async () => {
    await writeDurableRunContextBinding(BEARER_A, { tokenHash: HASH_A }, redis);

    // Simulate the writer process dying and a different worker serving the
    // MCP read: reset ALL module state and re-import; only `redis` survives.
    vi.resetModules();
    const freshModule = await import("@/lib/agent-run-context-durable");

    const resolution = await freshModule.resolveDurableRunContext(
      BEARER_A,
      lookup({ [HASH_A]: { id: "run-1", orgId: "org-1", runBy: "user-1" } }),
      redis,
    );
    expect(resolution.outcome).toBe("resolved");
  });

  it("NEVER persists raw bearer material: keys are prefixed sha256, values carry only the token hash", async () => {
    await writeDurableRunContextBinding(
      BEARER_A,
      { tokenHash: HASH_A, agentId: "agent-1" },
      redis,
    );
    const entries = [...redis.store.entries()];
    expect(entries).toHaveLength(1);
    const [key, { value, ttlSeconds }] = entries[0];
    const expectedDigest = createHash("sha256")
      .update(BEARER_A, "utf8")
      .digest("hex");
    expect(key).toBe(`cinatra:run-ctx:v1:${expectedDigest}`);
    expect(key).not.toContain(BEARER_A);
    expect(value).not.toContain(BEARER_A);
    expect(ttlSeconds).toBe(DURABLE_RUN_CONTEXT_TTL_SECONDS);
    expect(DURABLE_RUN_CONTEXT_TTL_SECONDS).toBe(300);
  });

  it("refuses to write a malformed token hash (nothing stored, null returned)", async () => {
    expect(
      await writeDurableRunContextBinding(BEARER_A, { tokenHash: "not-hex" }, redis),
    ).toBeNull();
    expect(
      await writeDurableRunContextBinding("", { tokenHash: HASH_A }, redis),
    ).toBeNull();
    expect(redis.store.size).toBe(0);
  });

  it("write failure is contained: returns null, caller proceeds (registry fallback covers)", async () => {
    redis.failSet = true;
    expect(
      await writeDurableRunContextBinding(BEARER_A, { tokenHash: HASH_A }, redis),
    ).toBeNull();
  });

  it("clearing one request's keys never touches another request's binding (per-invocation-unique keys)", async () => {
    const keyA = await writeDurableRunContextBinding(BEARER_A, { tokenHash: HASH_A }, redis);
    await writeDurableRunContextBinding(BEARER_B, { tokenHash: HASH_B }, redis);
    await clearDurableRunContextBindings([keyA!], redis);

    expect(
      (await resolveDurableRunContext(BEARER_A, lookup({}), redis)).outcome,
    ).toBe("absent");
    const b = await resolveDurableRunContext(
      BEARER_B,
      lookup({ [HASH_B]: { id: "run-B", orgId: "org-1", runBy: null } }),
      redis,
    );
    expect(b).toMatchObject({ outcome: "resolved", ctx: { runId: "run-B" } });
  });

  it("clear failure is contained (TTL is the backstop)", async () => {
    redis.failDel = true;
    await expect(
      clearDurableRunContextBindings(["cinatra:run-ctx:v1:x"], redis),
    ).resolves.toBeUndefined();
  });
});

describe("durable run-context binding — strict absent-vs-invalid classification", () => {
  it("no binding ⇒ absent (legacy fallback allowed)", async () => {
    const r = await resolveDurableRunContext(BEARER_A, lookup({}), redis);
    expect(r.outcome).toBe("absent");
  });

  it("empty bearer ⇒ absent", async () => {
    const r = await resolveDurableRunContext("", lookup({}), redis);
    expect(r.outcome).toBe("absent");
  });

  it("redis transport failure ⇒ absent (transitional availability policy)", async () => {
    redis.failGet = true;
    const r = await resolveDurableRunContext(BEARER_A, lookup({}), redis);
    expect(r.outcome).toBe("absent");
  });

  it("present but malformed JSON ⇒ INVALID (fail closed, never a downgrade)", async () => {
    redis.store.set(durableRunContextKey(BEARER_A), {
      value: "{corrupt",
      ttlSeconds: 300,
    });
    const r = await resolveDurableRunContext(BEARER_A, lookup({}), redis);
    expect(r.outcome).toBe("invalid");
  });

  it("present but schema-invalid (missing tokenHash) ⇒ INVALID", async () => {
    redis.store.set(durableRunContextKey(BEARER_A), {
      value: JSON.stringify({ agentId: "agent-1" }),
      ttlSeconds: 300,
    });
    const r = await resolveDurableRunContext(BEARER_A, lookup({}), redis);
    expect(r.outcome).toBe("invalid");
  });

  it("present but wrong-type provenance (agentId: 7) ⇒ INVALID — never dropped and refilled from legacy channels", async () => {
    redis.store.set(durableRunContextKey(BEARER_A), {
      value: JSON.stringify({ tokenHash: HASH_A, agentId: 7 }),
      ttlSeconds: 300,
    });
    const r = await resolveDurableRunContext(
      BEARER_A,
      lookup({ [HASH_A]: { id: "run-1", orgId: "org-1", runBy: "user-1" } }),
      redis,
    );
    expect(r.outcome).toBe("invalid");
  });

  it("present but non-64-hex tokenHash ⇒ INVALID", async () => {
    redis.store.set(durableRunContextKey(BEARER_A), {
      value: JSON.stringify({ tokenHash: "ZZ".repeat(32) }),
      ttlSeconds: 300,
    });
    const r = await resolveDurableRunContext(BEARER_A, lookup({}), redis);
    expect(r.outcome).toBe("invalid");
  });

  it("TOKEN-MISS (credential rotated/cleared or run gone) ⇒ INVALID, never absent", async () => {
    await writeDurableRunContextBinding(BEARER_A, { tokenHash: HASH_A }, redis);
    const r = await resolveDurableRunContext(BEARER_A, lookup({}), redis);
    expect(r.outcome).toBe("invalid");
  });

  it("lookup ERROR after a binding was found ⇒ INVALID, never absent", async () => {
    await writeDurableRunContextBinding(BEARER_A, { tokenHash: HASH_A }, redis);
    const failingLookup = vi.fn(async () => {
      throw new Error("db down");
    });
    const r = await resolveDurableRunContext(BEARER_A, failingLookup, redis);
    expect(r.outcome).toBe("invalid");
  });
});
