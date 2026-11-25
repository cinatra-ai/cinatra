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
import type { PassthroughPrimitiveSource } from "@/lib/passthrough-publishing-step-tools";

// The module is loaded inside each test, so that every test reports its own failure.
const reader = () => import("@/lib/passthrough-publishing-step-tools");
const declaresPassthroughPublishingStep = async (...args: Parameters<Awaited<ReturnType<typeof reader>>["declaresPassthroughPublishingStep"]>) =>
  (await reader()).declaresPassthroughPublishingStep(...args);
const loadPassthroughPublishingStepHandler = async (...args: Parameters<Awaited<ReturnType<typeof reader>>["loadPassthroughPublishingStepHandler"]>) =>
  (await reader()).loadPassthroughPublishingStepHandler(...args);

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

  it("the host reads the declaration for the send and for nothing else of the package", async () => {
    expect(await declaresPassthroughPublishingStep(SEND)).toBe(true);
    for (const m of triggerEmailSendPrimitiveMetadata) {
      if (m.name !== SEND) expect(await declaresPassthroughPublishingStep(m.name)).toBe(false);
    }
    expect(await declaresPassthroughPublishingStep("objects_save")).toBe(false);
    expect(await declaresPassthroughPublishingStep("")).toBe(false);
  });
});

describe("the reader over injected sources", () => {
  const handler = vi.fn(async () => ({ ok: true }));
  const source = (metadata: PassthroughPrimitiveSource["metadata"], handlers: Record<string, unknown> = {}) => ({
    metadata,
    loadHandlers: vi.fn(async () => handlers),
  });

  it("only the boolean true declares", async () => {
    for (const value of ["true", 1, {}, null, false]) {
      const sources = [source([{ name: "tool_a", passthroughPublishingStep: value as unknown as boolean }])];
      expect(await declaresPassthroughPublishingStep("tool_a", sources)).toBe(false);
    }
    expect(await declaresPassthroughPublishingStep("tool_a", [source([{ name: "tool_a", passthroughPublishingStep: true }])])).toBe(true);
  });

  it("a name two sources carry is not declared", async () => {
    const sources = [
      source([{ name: "tool_a", passthroughPublishingStep: true }]),
      source([{ name: "tool_a" }]),
    ];
    expect(await declaresPassthroughPublishingStep("tool_a", sources)).toBe(false);
  });

  it("loads the handler of a declared name from its own source", async () => {
    const declared = source([{ name: "tool_a", passthroughPublishingStep: true }], { tool_a: handler });
    const other = source([{ name: "tool_b" }], { tool_b: handler });
    expect(await loadPassthroughPublishingStepHandler("tool_a", { sources: [other, declared] })).toBe(handler);
    expect(other.loadHandlers).not.toHaveBeenCalled();
  });

  it("loads nothing for an undeclared name, and nothing when the source has no function under the name", async () => {
    const undeclared = source([{ name: "tool_b" }], { tool_b: handler });
    expect(await loadPassthroughPublishingStepHandler("tool_b", { sources: [undeclared] })).toBeNull();
    expect(undeclared.loadHandlers).not.toHaveBeenCalled();
    const empty = source([{ name: "tool_a", passthroughPublishingStep: true }], { tool_a: "not a function" });
    expect(await loadPassthroughPublishingStepHandler("tool_a", { sources: [empty] })).toBeNull();
    const inherited = source([{ name: "toString", passthroughPublishingStep: true }], {});
    expect(await loadPassthroughPublishingStepHandler("toString", { sources: [inherited] })).toBeNull();
  });
});

describe("the step before a declared primitive's effect", () => {
  it("is handed to the declared source's handler factory", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const loadHandlers = vi.fn(async () => ({ tool_a: handler }));
    const beforeEffect = vi.fn(async () => {});
    const sources = [{ metadata: [{ name: "tool_a", passthroughPublishingStep: true }], loadHandlers }];
    expect(await loadPassthroughPublishingStepHandler("tool_a", { beforeEffect, sources })).toBe(handler);
    expect(loadHandlers).toHaveBeenCalledWith(beforeEffect);
  });

  it("runs before each use case, and a step that throws stops the use case", async () => {
    const { withBeforeEffect } = await reader();
    const order: string[] = [];
    const useCases = {
      label: "kept",
      async send(n: number) {
        order.push(`send ${n}`);
        return n * 2;
      },
    };
    const guarded = withBeforeEffect(useCases, async () => {
      order.push("step");
    });
    expect(await guarded.send(2)).toBe(4);
    expect(guarded.label).toBe("kept");
    expect(order).toEqual(["step", "send 2"]);
    const refused = withBeforeEffect(useCases, async () => {
      throw new Error("already used");
    });
    await expect(refused.send(3)).rejects.toThrow("already used");
    expect(order).toEqual(["step", "send 2"]);
  });
});

describe("the answer of a call that did not complete", () => {
  it("is a failure for status failed, ok false or an error message, keeps the handler's fields and adds the fixed code", async () => {
    const { publishingStepFailureAnswer } = await reader();
    expect(publishingStepFailureAnswer({ status: "failed", sentCount: 1, errorMessage: "the provider refused two" })).toEqual({
      status: "failed", sentCount: 1, errorMessage: "the provider refused two", error: "the provider refused two",
      code: "publishing_step_call_failed",
    });
    expect(publishingStepFailureAnswer({ ok: false, error: "no" })).toMatchObject({ error: "no", code: "publishing_step_call_failed" });
    expect(publishingStepFailureAnswer({ status: "completed", errorMessage: "1 message is in doubt" })).toMatchObject({
      error: "1 message is in doubt", code: "publishing_step_call_failed",
    });
    expect(publishingStepFailureAnswer({ status: "failed" })).toMatchObject({ error: "The publishing step's call did not complete." });
  });

  it("is none for a call that completed and for an answer that is not an object", async () => {
    const { publishingStepFailureAnswer } = await reader();
    expect(publishingStepFailureAnswer({ status: "completed", sentCount: 3 })).toBeNull();
    expect(publishingStepFailureAnswer({ ok: true })).toBeNull();
    for (const value of [null, undefined, "failed", 7, ["failed"]]) expect(publishingStepFailureAnswer(value)).toBeNull();
  });
});
