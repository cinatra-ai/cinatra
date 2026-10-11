/**
 * cinatra#3745 — the durable run-context binding carries the verified step of
 * the calling model step as its optional `stepId`, parsed schema-strict like
 * its neighbours, and the resolved context returns it. Exercises the real
 * module against a Map-backed fake store.
 */
import { afterAll, describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveRequestRunContext } from "../../../packages/mcp-server/src/request-context";
import { composeBearerActorContext } from "../../../packages/mcp-server/src/actor-identity";
import { runContextDeniedResponse } from "../../../packages/mcp-server/src/inbound-era";

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

// Real durable reader + request resolver + authenticated machine actor. These
// hermetic ports replace Redis/DB, not the decision functions. The full Next
// transport is not booted; its early-return placement is separately pinned.
describe("present invalid durable source cannot become a runless bearer", () => {
  const source = Object.freeze({ contextId: "run-1", stepId: "step-node-1",
    executionAttemptId: "attempt-1", sourceSha256: "a".repeat(64),
    executedSourceSha256: "b".repeat(64), declarationSourceSha256: "d".repeat(64) });

  async function authenticatedMachineRequest() {
    // Hermetic HS256 authentication, not a live OAuth endpoint. Actor
    // composition below is the real production function behind verified auth.
    const key = "hermetic-machine-signing-key-for-durable-policy";
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ azp: "client-1", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    const unsigned = `${header}.${payload}`;
    const signature = createHmac("sha256", key).update(unsigned).digest();
    const bearer = `${unsigned}.${signature.toString("base64url")}`;
    const [h, p, sig] = bearer.split(".");
    expect(timingSafeEqual(Buffer.from(sig!, "base64url"), createHmac("sha256", key).update(`${h}.${p}`).digest())).toBe(true);
    const request = new Request("https://instance.example/mcp", {
      method: "POST", headers: { authorization: `Bearer ${bearer}` },
    });
    expect(request.headers.has("x-cinatra-run-id")).toBe(false);
    const actor = await composeBearerActorContext({ currentOrgId: null,
      delegatedUserId: null, trustedDevAdminUserId: null, sessionUser: undefined,
      requestClientId: "client-1", authHeader: request.headers.get("authorization"),
      bearerSignatureVerified: true, request, a2aDevBypass: undefined, isLocalhost: false,
      readServiceAccount: async (id) => id === "client-1" ? { userId: "user-1", organizationId: "org-1" } : null,
      pool: { query: async <T,>() => ({ rows: [{ one: 1 }] as T[] }) },
    });
    expect(actor).toEqual({ resolvedUserId: "user-1", resolvedOrgId: "org-1" });
    return bearer;
  }

  it.each(["false", "throw"])("source verifier %s denies authenticated no-header request before effects", async (failure) => {
    const bearer = await authenticatedMachineRequest();
    await writeDurableRunContextBinding(bearer, { tokenHash: HASH, stepId: source.stepId,
      verifiedExecutedSource: source }, redis);
    const verifier = vi.fn(async () => { if (failure === "throw") throw new Error("authoritative source unavailable"); return false; });
    const durable = await resolveDurableRunContext(bearer, lookup, redis, verifier);
    expect(durable).toEqual({ outcome: "invalid" });
    expect(verifier).toHaveBeenCalledWith("run-1", "org-1", source);
    const resolved = resolveRequestRunContext({ durable, failClosed: true });
    const effect = vi.fn();
    // Mirrors the maintained transport's denial return before its request frame.
    const response = resolved.denied ? runContextDeniedResponse() : (effect(), new Response(null, { status: 200 }));
    expect(response.status).toBe(403);
    expect(resolved.denied).toBe(true);
    expect(resolved.runId).toBeUndefined();
    expect(effect).not.toHaveBeenCalled();
  });

  it("valid durable source retains its exact verified run and source", async () => {
    const bearer = await authenticatedMachineRequest();
    await writeDurableRunContextBinding(bearer, { tokenHash: HASH, stepId: source.stepId, verifiedExecutedSource: source }, redis);
    const durable = await resolveDurableRunContext(bearer, lookup, redis, async () => true);
    const resolved = resolveRequestRunContext({ durable, failClosed: true });
    expect(resolved).toMatchObject({ runId: "run-1", stepId: source.stepId,
      verifiedExecutedSource: source, servedBy: "durable", denied: false });
  });

  it("genuinely absent ordinary bearer still serves without granting run identity", async () => {
    const bearer = await authenticatedMachineRequest();
    const durable = await resolveDurableRunContext(bearer, lookup, redis);
    expect(durable).toEqual({ outcome: "absent" });
    const resolved = resolveRequestRunContext({ durable, failClosed: true });
    expect(resolved).toMatchObject({ servedBy: "none", suppressed: false, denied: false });
    expect(resolved.runId).toBeUndefined();
  });

  it("independently verified OBO wins over stale durable state without borrowing its proof", () => {
    const resolved = resolveRequestRunContext({ delegatedRunId: "run-obo",
      delegatedStepId: source.stepId, delegatedExecutedSource: source,
      durable: { outcome: "invalid" }, failClosed: true });
    expect(resolved).toMatchObject({ runId: "run-obo", verifiedExecutedSource: source,
      servedBy: "obo", suppressed: true, denied: false });
  });

  it("the real transport returns denial before the request frame and both era dispatches", () => {
    const transport = readFileSync(new URL("../../../packages/mcp-server/src/index.tsx", import.meta.url), "utf8");
    const denied = transport.indexOf("if (runContext.denied) {");
    const refusal = transport.indexOf("runContextDeniedResponse()", denied);
    expect(denied).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(denied);
    expect(transport.slice(denied, refusal)).toContain("return");
    expect(refusal).toBeLessThan(transport.indexOf("const requestStore: McpRequestContext"));
    expect(refusal).toBeLessThan(transport.indexOf("mcpRequestContextStorage.run("));
  });
});
