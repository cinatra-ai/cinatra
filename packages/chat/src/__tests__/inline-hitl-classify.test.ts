import { describe, expect, it, vi } from "vitest";
import type { ChatGateDescriptor } from "@cinatra-ai/agents/client-entry";
import type { ComposerCommentAction } from "@cinatra-ai/agents/lifecycle-card-runtime";
import {
  ambiguousComposerRefusal,
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

describe("resolveComposerRouting", () => {
  it("no review, no gate → normal chat routing", () => {
    expect(
      resolveComposerRouting({
        target: { kind: "none" },
        latestOpenGate: undefined,
        commentActionFor: noComments,
      }),
    ).toEqual({ kind: "chat" });
  });

  it("no review, an open field gate → the field gate, exactly as before #2566", () => {
    const gate = fieldGate("run-1");
    expect(
      resolveComposerRouting({
        target: { kind: "none" },
        latestOpenGate: gate,
        commentActionFor: noComments,
      }),
    ).toEqual({ kind: "field-gate", gate });
  });

  it("ONE review open and nothing else → the message is that review's comment", () => {
    const routing = resolveComposerRouting({
      target: { kind: "target", ref: "ref-a", explicit: false },
      latestOpenGate: reviewGate("run-1", "ref-a"),
      commentActionFor: commentFor("ref-a"),
    });
    expect(routing).toMatchObject({ kind: "review-comment", ref: "ref-a" });
  });

  it("TWO reviews and no focus → REFUSED, and nothing is routed", () => {
    const routing = resolveComposerRouting({
      target: { kind: "ambiguous", count: 2 },
      latestOpenGate: reviewGate("run-2", "ref-b"),
      commentActionFor: commentFor("ref-a", "ref-b"),
    });
    expect(routing).toEqual({ kind: "refuse-ambiguous", count: 2 });
    // The message is NOT quietly turned into an LLM turn either: with reviews
    // waiting, silently sending it to the model loses what the reader wrote.
    expect(routing.kind).not.toBe("chat");
  });

  it("the refusal names how many and how to fix it, with no identifiers", () => {
    const line = ambiguousComposerRefusal(2);
    expect(line).toContain("2 reviews");
    expect(line).toContain("Reply from the chat box");
    // Identifier-free: this line is persisted into an LLM-visible transcript.
    expect(line).not.toMatch(/ref-|run-|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("an EXPLICIT focus outranks an open field gate — the reader said so", () => {
    const routing = resolveComposerRouting({
      target: { kind: "target", ref: "ref-a", explicit: true },
      latestOpenGate: fieldGate("run-9"),
      commentActionFor: commentFor("ref-a"),
    });
    expect(routing).toMatchObject({ kind: "review-comment", ref: "ref-a" });
  });

  it("an IMPLICIT single review does NOT outrank an open field gate", () => {
    // The reader has not spoken, so the composer keeps the binding it has always
    // had: a run blocked on a field.
    const gate = fieldGate("run-9");
    expect(
      resolveComposerRouting({
        target: { kind: "target", ref: "ref-a", explicit: false },
        latestOpenGate: gate,
        commentActionFor: commentFor("ref-a"),
      }),
    ).toEqual({ kind: "field-gate", gate });
  });

  it("a review_comment descriptor is NEVER fed to the field-gate ladder", () => {
    // It carries no fields and its submit is comment-only; classifying it would
    // read an approval word as a bare-gate submit.
    const routing = resolveComposerRouting({
      target: { kind: "none" },
      latestOpenGate: reviewGate("run-1", "ref-a"),
      commentActionFor: commentFor("ref-a"),
    });
    expect(routing).toEqual({ kind: "chat" });
  });

  it("a target whose card is GONE falls back rather than inventing a transport", () => {
    const gate = fieldGate("run-9");
    expect(
      resolveComposerRouting({
        target: { kind: "target", ref: "ref-a", explicit: true },
        latestOpenGate: gate,
        commentActionFor: noComments,
      }),
    ).toEqual({ kind: "field-gate", gate });
    expect(
      resolveComposerRouting({
        target: { kind: "target", ref: "ref-a", explicit: true },
        latestOpenGate: undefined,
        commentActionFor: noComments,
      }),
    ).toEqual({ kind: "chat" });
  });

  it("the comment carried out is the CARD's own action, not a rebuilt one", async () => {
    const action = vi.fn(async (text: string) => ({ ok: true, message: `said: ${text}` }));
    const routing = resolveComposerRouting({
      target: { kind: "target", ref: "ref-a", explicit: true },
      latestOpenGate: undefined,
      commentActionFor: (ref) => (ref === "ref-a" ? action : undefined),
    });
    if (routing.kind !== "review-comment") throw new Error("expected a review comment");
    expect(await routing.comment("shorten the intro")).toEqual({
      ok: true,
      message: "said: shorten the intro",
    });
    expect(action).toHaveBeenCalledTimes(1);
  });
});
