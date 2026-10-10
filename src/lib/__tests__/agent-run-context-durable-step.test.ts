/**
 * cinatra#3745 — the durable run-context binding carries the verified step of
 * the calling model step as its optional `stepId`, parsed schema-strict like
 * its neighbours, and the resolved context returns it. Exercises the real
 * module against a Map-backed fake store.
 */
import { createHash } from "node:crypto";
import { afterAll, describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

import {
  writeDurableRunContextBinding,
  resolveDurableRunContext,
  durableRunContextKey,
  type DurableBindingRedis,
  type DurableRunContextBinding,
} from "@/lib/agent-run-context-durable";

class FakeRedis implements DurableBindingRedis {
  store = new Map<string, { value: string; ttlSeconds: number }>();

  async set(key: string, value: string, _mode: "EX", ttlSeconds: number): Promise<unknown> {
    this.store.set(key, { value, ttlSeconds });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }

  async del(...keys: string[]): Promise<unknown> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n += 1;
    return n;
  }
}

const HASH = "c".repeat(64);
const BEARER = "machine-token-step-raw-bearer";
const lookup = vi.fn(async (hash: string) =>
  hash === HASH ? { id: "run-1", orgId: "org-1", runBy: "user-1" } : null,
);

let redis: FakeRedis;

beforeEach(() => {
  redis = new FakeRedis();
  lookup.mockClear();
});

describe("durable binding step field", () => {
  // (d1)
  it("a binding written with a step resolves with that step on the context", async () => {
    const key = await writeDurableRunContextBinding(
      BEARER,
      { tokenHash: HASH, agentId: "agent-1", stepId: "step-node-1" } as DurableRunContextBinding,
      redis,
    );
    expect(key).toBe(durableRunContextKey(BEARER));
    const resolution = await resolveDurableRunContext(BEARER, lookup, redis);
    expect(resolution.outcome).toBe("resolved");
    expect(resolution.outcome === "resolved" ? resolution.ctx : null).toEqual({
      runId: "run-1",
      agentId: "agent-1",
      stepId: "step-node-1",
    });
  });

  // (d2)
  it("a binding without a step resolves as before, with no step", async () => {
    await writeDurableRunContextBinding(BEARER, { tokenHash: HASH, agentId: "agent-1" }, redis);
    const resolution = await resolveDurableRunContext(BEARER, lookup, redis);
    expect(resolution).toEqual({
      outcome: "resolved",
      ctx: { runId: "run-1", agentId: "agent-1" },
    });
    const ctx = resolution.outcome === "resolved" ? (resolution.ctx as { stepId?: unknown }) : null;
    expect(ctx?.stepId).toBeUndefined();
  });

  // (d3)
  it("a present non-string step makes the binding invalid", async () => {
    redis.store.set(durableRunContextKey(BEARER), {
      value: JSON.stringify({ tokenHash: HASH, stepId: 42 }),
      ttlSeconds: 300,
    });
    const resolution = await resolveDurableRunContext(BEARER, lookup, redis);
    expect(resolution).toEqual({ outcome: "invalid" });
    expect(lookup).not.toHaveBeenCalled();
  });
});

// Leave the module registry as this file found it.
afterAll(() => {
  vi.doUnmock("server-only");
  vi.resetModules();
});

const producerInputsJson = '{"note":"draft the reviewed story","topic":"Launch"}';
const producerHash = (s: string) => createHash("sha256").update(s).digest("hex");
const productionBinding = { version: 2 as const, producerKind: "llm" as const, producerStepId: "step-node-1", noteInputPath: "note", sourceSha256: "a".repeat(64), graphSha256: "b".repeat(64), effectiveInputsJson: producerInputsJson, effectiveInputsSha256: producerHash(producerInputsJson), inputParams: JSON.parse(producerInputsJson), inputParamsSha256: producerHash(producerInputsJson) };

describe("authenticated durable production binding v2", () => {
  it("preserves the equivalent verified claim through the actual durable resolver", async () => {
    expect(await writeDurableRunContextBinding(BEARER,{tokenHash:HASH,stepId:"step-node-1",verifiedProducerBinding:productionBinding},redis)).not.toBeNull();
    const result=await resolveDurableRunContext(BEARER,lookup,redis);
    expect(result.outcome==="resolved" ? result.ctx.verifiedProducerBinding : null).toEqual(productionBinding);
  });
  it("v1, tampered digest and mismatched step are corrupt, never a fallback", async () => {
    for(const verifiedProducerBinding of [{...productionBinding,version:1},{...productionBinding,effectiveInputsSha256:"c".repeat(64)},{...productionBinding,producerStepId:"other"},null]) {
      redis.store.set(durableRunContextKey(BEARER),{value:JSON.stringify({tokenHash:HASH,stepId:"step-node-1",verifiedProducerBinding}),ttlSeconds:300});
      expect(await resolveDurableRunContext(BEARER,lookup,redis)).toEqual({outcome:"invalid"});
    }
  });
  it("the write refuses invalid claims without a Redis effect", async () => {
    expect(await writeDurableRunContextBinding(BEARER,{tokenHash:HASH,stepId:"other",verifiedProducerBinding:productionBinding},redis)).toBeNull();
    expect(redis.store.size).toBe(0);
  });
});
