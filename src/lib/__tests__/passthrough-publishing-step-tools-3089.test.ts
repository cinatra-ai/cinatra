/**
 * cinatra#3089: the passthrough road reads, from a primitive's own metadata in its
 * owning package, whether the primitive may be served there as a declared
 * publishing step's call. Only the boolean `true` declares it; a name that no
 * source carries, or that two sources carry, is not declared; the handler is
 * loaded only for a declared name.
 */
// red-first-expect: Cannot find package '@/lib/passthrough-publishing-step-tools'
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { triggerEmailSendPrimitiveMetadata } from "@cinatra-ai/trigger-email-send";
import {
  declaresPassthroughPublishingStep,
  loadPassthroughPublishingStepHandler,
  type PassthroughPrimitiveSource,
} from "@/lib/passthrough-publishing-step-tools";

const SEND = "email_outreach_send_initial_start";

describe("the owning package's declaration", () => {
  it("the campaign send carries the declaration in its own metadata", () => {
    const entry = triggerEmailSendPrimitiveMetadata.find((m) => m.name === SEND) as
      | { passthroughPublishingStep?: unknown }
      | undefined;
    expect(entry?.passthroughPublishingStep).toBe(true);
  });

  it("no other primitive of the package carries it", () => {
    const declared = triggerEmailSendPrimitiveMetadata
      .filter((m) => (m as { passthroughPublishingStep?: unknown }).passthroughPublishingStep !== undefined)
      .map((m) => m.name);
    expect(declared).toEqual([SEND]);
  });

  it("the host reads the declaration for the send and for nothing else of the package", () => {
    expect(declaresPassthroughPublishingStep(SEND)).toBe(true);
    for (const m of triggerEmailSendPrimitiveMetadata) {
      if (m.name !== SEND) expect(declaresPassthroughPublishingStep(m.name)).toBe(false);
    }
    expect(declaresPassthroughPublishingStep("objects_save")).toBe(false);
    expect(declaresPassthroughPublishingStep("")).toBe(false);
  });
});

describe("the reader over injected sources", () => {
  const handler = vi.fn(async () => ({ ok: true }));
  const source = (metadata: PassthroughPrimitiveSource["metadata"], handlers: Record<string, unknown> = {}) => ({
    metadata,
    loadHandlers: vi.fn(async () => handlers),
  });

  it("only the boolean true declares", () => {
    for (const value of ["true", 1, {}, null, false]) {
      const sources = [source([{ name: "tool_a", passthroughPublishingStep: value as unknown as boolean }])];
      expect(declaresPassthroughPublishingStep("tool_a", sources)).toBe(false);
    }
    expect(declaresPassthroughPublishingStep("tool_a", [source([{ name: "tool_a", passthroughPublishingStep: true }])])).toBe(true);
  });

  it("a name two sources carry is not declared", () => {
    const sources = [
      source([{ name: "tool_a", passthroughPublishingStep: true }]),
      source([{ name: "tool_a" }]),
    ];
    expect(declaresPassthroughPublishingStep("tool_a", sources)).toBe(false);
  });

  it("loads the handler of a declared name from its own source", async () => {
    const declared = source([{ name: "tool_a", passthroughPublishingStep: true }], { tool_a: handler });
    const other = source([{ name: "tool_b" }], { tool_b: handler });
    expect(await loadPassthroughPublishingStepHandler("tool_a", [other, declared])).toBe(handler);
    expect(other.loadHandlers).not.toHaveBeenCalled();
  });

  it("loads nothing for an undeclared name, and nothing when the source has no function under the name", async () => {
    const undeclared = source([{ name: "tool_b" }], { tool_b: handler });
    expect(await loadPassthroughPublishingStepHandler("tool_b", [undeclared])).toBeNull();
    expect(undeclared.loadHandlers).not.toHaveBeenCalled();
    const empty = source([{ name: "tool_a", passthroughPublishingStep: true }], { tool_a: "not a function" });
    expect(await loadPassthroughPublishingStepHandler("tool_a", [empty])).toBeNull();
    const inherited = source([{ name: "toString", passthroughPublishingStep: true }], {});
    expect(await loadPassthroughPublishingStepHandler("toString", [inherited])).toBeNull();
  });
});
