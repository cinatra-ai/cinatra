import { describe, expect, it, vi } from "vitest";
import type { ChatGateDescriptor } from "@cinatra-ai/agents/client-entry";
import type { ComposerCommentAction } from "@cinatra-ai/agents/lifecycle-card-runtime";
import {
  classifyPromptForGate,
  createChatGateRegistry,
  resolveComposerRouting,
  resolveExtractedGateValues,
  type ClassifyGate,
} from "../inline-hitl-classify";

// Pins prompt-window HITL classifier edge cases. The classifier decides whether
// a user message should submit gate values, continue chat, or fall back to LLM
// parsing, so these tests protect the high-risk routing boundaries.

const singleStringGate: ClassifyGate = {
  fields: [{ name: "comment", type: "string", required: true }],
};
const singleStringSetupGate: ClassifyGate = {
  fields: [{ name: "url", type: "string", required: true }],
  fieldName: "url",
};
const singleBoolGate: ClassifyGate = {
  fields: [{ name: "approved", type: "boolean", required: true }],
};
const singleNumberGate: ClassifyGate = {
  fields: [{ name: "count", type: "number", required: true }],
};
const pureApprovalGate: ClassifyGate = { fields: [] };
const multiFieldGate: ClassifyGate = {
  fields: [
    { name: "title", type: "string", required: true },
    { name: "url", type: "string", required: true },
  ],
};

describe("classifyPromptForGate — approval words", () => {
  it("exact approval word on a pure-approval gate → submit {}", () => {
    expect(classifyPromptForGate("approve", pureApprovalGate)).toEqual({
      kind: "submit",
      value: {},
    });
    expect(classifyPromptForGate("Looks good.", pureApprovalGate)).toEqual({
      kind: "submit",
      value: {},
    });
    expect(classifyPromptForGate("yes!", pureApprovalGate)).toEqual({
      kind: "submit",
      value: {},
    });
  });

  it("substring approval does NOT submit; approval must be exact", () => {
    // "yes, but also scrape example.com" must NOT auto-approve.
    expect(
      classifyPromptForGate("yes, but also do the other thing", pureApprovalGate),
    ).toEqual({ kind: "chat" });
  });

  it("single required boolean + 'yes' → { field: true }, not {}", () => {
    expect(classifyPromptForGate("yes", singleBoolGate)).toEqual({
      kind: "submit",
      value: { approved: true },
    });
    expect(classifyPromptForGate("no", singleBoolGate)).toEqual({
      kind: "submit",
      value: { approved: false },
    });
  });
});

describe("classifyPromptForGate — whole-message JSON", () => {
  it("whole-message JSON object → submit the object (overrides new-task guard)", () => {
    expect(
      classifyPromptForGate('{"title":"x","url":"https://e.com"}', multiFieldGate),
    ).toEqual({ kind: "submit", value: { title: "x", url: "https://e.com" } });
  });

  it("JSON snippet inside prose does NOT submit", () => {
    expect(
      classifyPromptForGate('can you explain {"url":"x"}?', singleStringGate),
    ).toEqual({ kind: "chat" });
  });

  it("bare null never submits", () => {
    expect(classifyPromptForGate("null", singleStringGate).kind).not.toBe(
      "submit",
    );
    expect(classifyPromptForGate("null", pureApprovalGate).kind).not.toBe(
      "submit",
    );
  });

  it('"null" / [] against a single string field never submit', () => {
    expect(classifyPromptForGate('"null"', singleStringGate).kind).not.toBe(
      "submit",
    );
    expect(classifyPromptForGate("[]", singleStringGate).kind).not.toBe(
      "submit",
    );
    // whole-message JSON object still wins for the single string field
    expect(
      classifyPromptForGate('{"comment":"x"}', singleStringGate),
    ).toEqual({ kind: "submit", value: { comment: "x" } });
  });
});

describe("classifyPromptForGate — single required primitive", () => {
  it("bare URL for a single string setup field → submit under fieldName", () => {
    expect(
      classifyPromptForGate("https://example.com", singleStringSetupGate),
    ).toEqual({ kind: "submit", value: { url: "https://example.com" } });
  });

  it("bare number for a single number field → coerced submit", () => {
    expect(classifyPromptForGate("42", singleNumberGate)).toEqual({
      kind: "submit",
      value: { count: 42 },
    });
  });

  it("question against a single string field → chat, not a value", () => {
    expect(
      classifyPromptForGate("what should the comment be?", singleStringGate),
    ).toEqual({ kind: "chat" });
  });

  it("mid-run single field wraps under the schema property name", () => {
    // No fieldName → use fields[0].name
    expect(
      classifyPromptForGate("a short comment", singleStringGate),
    ).toEqual({ kind: "submit", value: { comment: "a short comment" } });
  });
});

describe("classifyPromptForGate — new-task guard", () => {
  it("@cinatra-ai mention → chat", () => {
    expect(
      classifyPromptForGate(
        "use @cinatra-ai/web-scrape-agent next",
        pureApprovalGate,
      ),
    ).toEqual({ kind: "chat" });
  });

  it("continuation words → chat (multi-field gate, not a bare value)", () => {
    expect(
      classifyPromptForGate("also add a second source", multiFieldGate),
    ).toEqual({ kind: "chat" });
  });

  it("multi-field non-question short message → llm fallback", () => {
    expect(
      classifyPromptForGate("title is Hello and url is e.com", multiFieldGate),
    ).toEqual({ kind: "llm" });
  });

  it("very long non-JSON message → chat", () => {
    expect(
      classifyPromptForGate("x ".repeat(400), multiFieldGate),
    ).toEqual({ kind: "chat" });
  });

  it("empty message → chat", () => {
    expect(classifyPromptForGate("   ", singleStringGate)).toEqual({
      kind: "chat",
    });
  });
});

// ---------------------------------------------------------------------------
// resolveExtractedGateValues (cinatra#853) — the LLM-fallback required-field
// policy split out of chat-page.tsx's gate-drive block.
// ---------------------------------------------------------------------------
describe("resolveExtractedGateValues", () => {
  const fields = [
    { name: "title", required: true },
    { name: "url", required: true },
    { name: "note", required: false },
  ];

  it("submits when every required field is present", () => {
    expect(
      resolveExtractedGateValues({ title: "T", url: "https://e.com" }, fields),
    ).toEqual({ kind: "submit", value: { title: "T", url: "https://e.com" } });
  });

  it("submits any extraction when the gate has no required fields", () => {
    expect(
      resolveExtractedGateValues({ note: "hi" }, [{ name: "note", required: false }]),
    ).toEqual({ kind: "submit", value: { note: "hi" } });
  });

  it("partial when something was extracted but required fields are missing", () => {
    expect(resolveExtractedGateValues({ title: "T" }, fields)).toEqual({
      kind: "partial",
      presentKeys: ["title"],
      missing: ["url"],
    });
  });

  it("null/undefined extracted values do not count as present", () => {
    expect(
      resolveExtractedGateValues({ title: "T", url: null }, fields),
    ).toEqual({ kind: "partial", presentKeys: ["title", "url"], missing: ["url"] });
  });

  it("none when nothing was extracted (falls through to chat routing)", () => {
    expect(resolveExtractedGateValues({}, fields)).toEqual({ kind: "none" });
    // A gate with no required fields and no extraction is also none.
    expect(
      resolveExtractedGateValues({}, [{ name: "note", required: false }]),
    ).toEqual({ kind: "none" });
  });
});

// ---------------------------------------------------------------------------
// createChatGateRegistry (cinatra#853) — the runId-keyed inline-gate registry
// split out of chat-page.tsx.
// ---------------------------------------------------------------------------
describe("createChatGateRegistry", () => {
  const makeGate = (runId: string, instanceId: string) =>
    ({ runId, instanceId } as unknown as Parameters<
      ReturnType<typeof createChatGateRegistry>["handleActiveGateChange"]
    >[1] & { runId: string; instanceId: string });

  it("registers gates and returns the most-recently-registered one", () => {
    const reg = createChatGateRegistry();
    expect(reg.getLatestOpenGate()).toBeUndefined();
    reg.handleActiveGateChange("run-1", makeGate("run-1", "i1"), "i1");
    reg.handleActiveGateChange("run-2", makeGate("run-2", "i2"), "i2");
    expect(reg.getLatestOpenGate()?.runId).toBe("run-2");
  });

  it("re-registering an existing runId keeps its original insertion position", () => {
    const reg = createChatGateRegistry();
    reg.handleActiveGateChange("run-1", makeGate("run-1", "i1"), "i1");
    reg.handleActiveGateChange("run-2", makeGate("run-2", "i2"), "i2");
    // Map.set on an existing key does NOT move it to the end.
    reg.handleActiveGateChange("run-1", makeGate("run-1", "i1b"), "i1b");
    expect(reg.getLatestOpenGate()?.runId).toBe("run-2");
  });

  it("clears a gate only when the SAME instance unregisters (remount guard)", () => {
    const reg = createChatGateRegistry();
    reg.handleActiveGateChange("run-1", makeGate("run-1", "new-instance"), "new-instance");
    // An OLDER instance's unmount must not clobber the remounted card's gate.
    reg.handleActiveGateChange("run-1", null, "old-instance");
    expect(reg.getLatestOpenGate()?.runId).toBe("run-1");
    // The live instance's clear removes it.
    reg.handleActiveGateChange("run-1", null, "new-instance");
    expect(reg.getLatestOpenGate()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// COMPOSER ROUTING (cinatra#2566's composer-focus deliverable; the program
// Done-definition is cinatra#2573 — "multiple concurrent gates require explicit
// composer focus").
//
// This is the send-time decision: does a typed message go to a HITL field gate,
// to a FOCUSED review card as a comment, nowhere (because the reader has not
// said which review), or to the model. The dangerous outcome is a comment
// landing on a review nobody chose — on a single-target automatic gate a
// nonempty comment resolves as `changes_requested`, so a wrong guess sends the
// wrong run into a repair.
// ---------------------------------------------------------------------------

const reviewComment: ComposerCommentAction = async () => ({ ok: true, message: "ok" });
const commentFor =
  (...refs: string[]) =>
  (ref: string): ComposerCommentAction | undefined =>
    refs.includes(ref) ? reviewComment : undefined;
const noComments = () => undefined;

/** A field gate, as AgenticRunPanel publishes one (only the read fields). */
const fieldGate = (runId: string): ChatGateDescriptor =>
  ({ runId, instanceId: `${runId}-i`, fields: [] }) as unknown as ChatGateDescriptor;
/** A #2566 review-comment descriptor — comment-only, no resume path. */
const reviewGate = (runId: string, cardRef: string): ChatGateDescriptor =>
  ({
    runId,
    instanceId: `${runId}-i`,
    fields: [],
    kind: "review_comment",
    cardRef,
  }) as unknown as ChatGateDescriptor;

describe("resolveComposerRouting — one arm left", () => {
  // AMENDED for cinatra#2932 (lifecycle-b W5a). The review-comment and
  // ambiguity cases went with the arms they described: a sentence typed beside a
  // bound review is no longer read here, and the several-reviews refusal is no
  // longer this page's to compose. Their replacements are proved where the
  // capabilities now live —
  //   src/lib/lifecycle/__tests__/lent-action-mcp.test.ts (the card's own
  //   Comment control, operated under the person's credential with the person's
  //   own words), and
  //   src/lib/lifecycle/__tests__/bound-card-binding.test.ts (the platform's own
  //   refusal, re-counted server-side).
  // What remains here is the arm this slice deliberately did NOT remove: a run
  // blocked on a field gate keeps the composer, because the assistant cannot
  // answer that screen until cinatra#2934 builds the control it would use.

  it("an open FIELD GATE takes the message, exactly as it always has", () => {
    const gate = { kind: "setup", fields: [], runId: "r", instanceId: "i" } as never;
    expect(resolveComposerRouting({ latestOpenGate: gate })).toEqual({
      kind: "field-gate",
      gate,
    });
  });

  it("NO open gate is ordinary chat routing", () => {
    expect(resolveComposerRouting({ latestOpenGate: undefined })).toEqual({
      kind: "chat",
    });
  });

  it("a review_comment descriptor is NOT a field gate — it routes to chat now", () => {
    // It used to be read as a review by ref. Nothing on this page reads it any
    // more; the binding travels with the message and is re-checked on the
    // server.
    const reviewDescriptor = { kind: "review_comment", runId: "r", instanceId: "i" } as never;
    expect(resolveComposerRouting({ latestOpenGate: reviewDescriptor })).toEqual({
      kind: "chat",
    });
  });

  it("the removed arms cannot come back by accident", async () => {
    const mod = (await import("../inline-hitl-classify")) as Record<string, unknown>;
    expect(mod.ambiguousComposerRefusal).toBeUndefined();
  });
});
