/**
 * cinatra#2960 — the CREDENTIAL-FREE half of the resolution rule on the
 * passthrough save path, pinned at the classifier boundary.
 *
 * ACCEPTANCE ITEM 2, VERBATIM: "A test pins the resolution rule for
 * `@dynamic/types:*` on the passthrough save path so the refusal class cannot
 * silently return."
 *
 * The host no longer registers the blog pipeline's selected-idea type: the
 * save that named it is retired (cinatra#3035), and a pack's type id does not
 * live in the host. Pinned here at the classifier boundary, with the runtime
 * resolver mocked to the credential-free answer (`null`): after
 * `registerAllObjectTypes` the registry resolves no
 * `@cinatra-ai/blog-pipeline:selected-idea` and lists no type under
 * `@cinatra-ai/blog-pipeline`, and the tombstoned id still falls through to
 * provider resolution and fails closed — the refusal cinatra#2960 recorded.
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

  it("registers no type for the blog pipeline's package: the retired selected-idea type resolves nowhere", () => {
    expect(objectTypeRegistry.resolve(OWNED_SELECTED_IDEA_TYPE)).toBeNull();
    expect(
      objectTypeRegistry
        .list()
        .map((d) => d.type)
        .filter((t) => t.startsWith("@cinatra-ai/blog-pipeline:")),
    ).toEqual([]);
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
