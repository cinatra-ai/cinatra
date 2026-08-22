/**
 * Frozen run-context minting (setup-flow S6).
 *
 * `mintSkillMatchRunContext` reads the resolved runtime's provider + ACTUAL
 * default model (the resolved-model exposure seam) exactly once; a null
 * runtime mints null (callers treat that as a clean skip). `coerceRunContext`
 * guards payload-rehydrated shapes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { resolveConfiguredLlmRuntime } = vi.hoisted(() => ({
  resolveConfiguredLlmRuntime: vi.fn(),
}));
vi.mock("@cinatra-ai/llm", () => ({
  resolveConfiguredLlmRuntime,
  probeBatchCapability: vi.fn(),
  // The real guard, not a stand-in: the skip under test is exactly the one the
  // llm package's narrowing performs.
  isScriptedLlmRuntime: (runtime?: { provider?: string } | null) =>
    runtime?.provider === "scripted",
}));

import {
  mintSkillMatchRunContext,
  coerceRunContext,
  buildSkillMatchWorkerActorContext,
} from "../run-context";
import { LLM_MATCHER_VERSION } from "../constants";

beforeEach(() => {
  resolveConfiguredLlmRuntime.mockReset();
});

describe("mintSkillMatchRunContext", () => {
  it("freezes the resolved provider + adapter default model + current evaluator version", async () => {
    resolveConfiguredLlmRuntime.mockResolvedValue({
      provider: "anthropic",
      model: "claude-test-default",
    });
    const ctx = await mintSkillMatchRunContext();
    expect(ctx).toEqual({
      provider: "anthropic",
      model: "claude-test-default",
      evaluatorVersion: LLM_MATCHER_VERSION,
    });
  });

  it("mints null when no runtime is configured", async () => {
    resolveConfiguredLlmRuntime.mockResolvedValue(null);
    expect(await mintSkillMatchRunContext()).toBeNull();
  });

  // cinatra#2910 — the widened runtime union reaches this minter. A context
  // minted from the scripted runtime would carry `provider: "scripted"` into
  // `submitSkillMatchBatch`, which casts the field to `LlmProvider` and calls
  // the real-provider batch APIs with it. The matcher has no scripted path, so
  // the scripted runtime is a CLEAN SKIP here, not a context.
  it("mints null under the scripted TEST runtime — it is not a provider to run on", async () => {
    resolveConfiguredLlmRuntime.mockResolvedValue({
      provider: "scripted",
      model: "scripted-test-model",
    });
    expect(await mintSkillMatchRunContext()).toBeNull();
  });
});

describe("coerceRunContext", () => {
  it("passes a structurally valid context through", () => {
    const ctx = { provider: "openai", model: "gpt-4o-mini", evaluatorVersion: "llm-matcher-v2" };
    expect(coerceRunContext(ctx)).toEqual(ctx);
  });

  it.each([
    null,
    undefined,
    "openai",
    {},
    { provider: "openai" },
    { provider: "", model: "m", evaluatorVersion: "v" },
    { provider: "openai", model: "", evaluatorVersion: "v" },
    { provider: "openai", model: "m", evaluatorVersion: "" },
  ])("rejects malformed shape %#", (value) => {
    expect(coerceRunContext(value)).toBeNull();
  });

  // The rehydration door, closed by the same rule as the mint door: a payload
  // naming the scripted runtime is stale or forged, and the provider-keyed
  // reads downstream would cast it to a real provider.
  it("rejects a rehydrated context on the scripted TEST runtime", () => {
    expect(
      coerceRunContext({
        provider: "scripted",
        model: "scripted-test-model",
        evaluatorVersion: "llm-matcher-v2",
      }),
    ).toBeNull();
  });
});

describe("buildSkillMatchWorkerActorContext", () => {
  it("mints a worker-sourced System identity labelled per job", () => {
    const actor = buildSkillMatchWorkerActorContext("drift-sample");
    expect(actor.principalType).toBe("System");
    expect(actor.principalId).toBe("skill-matcher:drift-sample");
    expect(actor.authSource).toBe("worker");
    expect(actor.policyVersion).toBeTruthy();
  });
});
