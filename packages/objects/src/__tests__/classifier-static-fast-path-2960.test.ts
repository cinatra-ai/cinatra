/**
 * cinatra#2960 — the CREDENTIAL-FREE half of the resolution rule on the
 * passthrough save path, pinned at the classifier boundary.
 *
 * ACCEPTANCE ITEM 2, VERBATIM: "A test pins the resolution rule for
 * `@dynamic/types:*` on the passthrough save path so the refusal class cannot
 * silently return."
 *
 * The sibling tests pin the shaper, its declaration and the ownership rule.
 * They cannot see the mechanism that actually makes the save survive a
 * development runtime with NO LLM provider configured: `classifyObject` short-
 * circuits on a typeHint that resolves in the static registry and never
 * reaches `resolveConfiguredLlmRuntime`. A change that moved provider
 * resolution ahead of that short-circuit would put cinatra#2960's refusal back
 * with every other test still green — so it is pinned here, from both sides,
 * with the runtime resolver mocked to the credential-free answer (`null`).
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The credential-free development runtime, verbatim: the resolver answers
// `null` because no provider is configured.
vi.mock("@cinatra-ai/llm", () => ({
  resolveConfiguredLlmRuntime: vi.fn(async () => null),
  runResolvedDeterministicLlmTask: vi.fn(async () => {
    throw new Error("the classifier must not reach an LLM on a registered typeHint");
  }),
  parseStructuredJson: vi.fn(),
}));

import { resolveConfiguredLlmRuntime } from "@cinatra-ai/llm";
import { classifyObject } from "../classifier";
import { objectTypeRegistry } from "../registry";
import { registerAllObjectTypes } from "../integration/register-types";

const OWNED_SELECTED_IDEA_TYPE = "@cinatra-ai/blog-pipeline:selected-idea";
const TOMBSTONED_SELECTED_IDEA_TYPE = "@dynamic/types:blog-pipeline-selected-idea";

const RAW = { cinatra_agent_run_id: "run-2960", idea: { title: "A" } };

const resolveRuntime = resolveConfiguredLlmRuntime as unknown as ReturnType<typeof vi.fn>;

describe("cinatra#2960 — the selected-idea typeHint classifies with no LLM configured", () => {
  beforeEach(() => {
    resolveRuntime.mockClear();
    objectTypeRegistry._clearForTests();
    registerAllObjectTypes();
  });

  it("takes the static fast path: confidence 1.0, not a new type, no provider resolution", async () => {
    const out = await classifyObject(RAW, OWNED_SELECTED_IDEA_TYPE);
    expect(out.type).toBe(OWNED_SELECTED_IDEA_TYPE);
    expect(out.confidence).toBe(1);
    expect(out.isNewType).toBe(false);
    expect(out.normalizedData).toEqual(RAW);
    // The whole point: no provider was consulted, so a runtime with no
    // credentials configured classifies this save all the same.
    expect(resolveRuntime).not.toHaveBeenCalled();
  });

  it("the classification the fast path returns passes every arm of the save guard", async () => {
    const out = await classifyObject(RAW, OWNED_SELECTED_IDEA_TYPE);
    // The arms of the fail-closed guard in packages/objects/src/mcp/handlers.ts,
    // read back one by one against this classification.
    expect(out).not.toBeNull();
    expect(out.isNewType).toBe(false);
    expect(out.type.startsWith("@dynamic/types:")).toBe(false);
    expect(out.type.startsWith("@cinatra-ai/dynamic:")).toBe(false);
    expect(out.type).not.toBe("@cinatra-ai/objects:object");
    expect(out.confidence).toBeGreaterThanOrEqual(0.4);
    expect(objectTypeRegistry.resolve(out.type)).toBeTruthy();
  });

  it("the tombstoned id still falls through to provider resolution and fails closed", async () => {
    // The refusal cinatra#2960 recorded, reproduced: an id that resolves
    // nowhere reaches the runtime resolver, which answers null on a
    // credential-free runtime, and classification never happens.
    await expect(classifyObject(RAW, TOMBSTONED_SELECTED_IDEA_TYPE)).rejects.toThrow(
      /No LLM provider configured/,
    );
    expect(resolveRuntime).toHaveBeenCalled();
  });
});
