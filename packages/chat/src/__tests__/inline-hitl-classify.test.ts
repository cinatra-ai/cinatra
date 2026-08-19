import { describe, expect, it, vi } from "vitest";
import type { ChatGateDescriptor } from "@cinatra-ai/agents/client-entry";
import type {
  ComposerCardActions,
  ComposerCommentAction,
  ComposerDecideAction,
  ComposerEligibleCard,
} from "@cinatra-ai/agents/lifecycle-card-runtime";
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
const reviewDecide: ComposerDecideAction = async () => ({ ok: true, message: "ok" });
const cardActions: ComposerCardActions = { comment: reviewComment, decide: reviewDecide };
const actionsFor =
  (...refs: string[]) =>
  (ref: string): ComposerCardActions | undefined =>
    refs.includes(ref) ? cardActions : undefined;
const noActions = () => undefined;

/** A review card, and the non-review kind the binding also covers (#2853). */
const review = (ref: string): ComposerEligibleCard => ({ ref, kind: "artifact_review_gate" });
const schedule = (ref: string): ComposerEligibleCard => ({
  ref,
  kind: "trigger_schedule_proposal",
});

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
        actionsFor: noActions,
      }),
    ).toEqual({ kind: "chat" });
  });

  it("no review, an open field gate → the field gate, exactly as before #2566", () => {
    const gate = fieldGate("run-1");
    expect(
      resolveComposerRouting({
        target: { kind: "none" },
        latestOpenGate: gate,
        actionsFor: noActions,
      }),
    ).toEqual({ kind: "field-gate", gate });
  });

  it("ONE review open and nothing else → the message is that review's comment", () => {
    const routing = resolveComposerRouting({
      target: { kind: "target", ref: "ref-a", cardKind: "artifact_review_gate", explicit: false },
      latestOpenGate: reviewGate("run-1", "ref-a"),
      actionsFor: actionsFor("ref-a"),
    });
    expect(routing).toMatchObject({ kind: "card-action", ref: "ref-a", cardKind: "artifact_review_gate" });
  });

  it("TWO reviews and no focus → REFUSED, and nothing is routed", () => {
    const routing = resolveComposerRouting({
      target: { kind: "ambiguous", count: 2, cards: [review("ref-a"), review("ref-b")] },
      latestOpenGate: reviewGate("run-2", "ref-b"),
      actionsFor: actionsFor("ref-a", "ref-b"),
    });
    expect(routing).toEqual({
      kind: "refuse-ambiguous",
      count: 2,
      cards: [review("ref-a"), review("ref-b")],
    });
    // The message is NOT quietly turned into an LLM turn either: with reviews
    // waiting, silently sending it to the model loses what the reader wrote.
    expect(routing.kind).not.toBe("chat");
  });

  it("the refusal names how many and how to fix it, with no identifiers", () => {
    const line = ambiguousComposerRefusal([review("ref-a"), review("ref-b")]);
    expect(line).toContain("2 reviews");
    expect(line).toContain("Reply from the chat box");
    // Identifier-free: this line is persisted into an LLM-visible transcript.
    expect(line).not.toMatch(/ref-|run-|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("an EXPLICIT focus outranks an open field gate — the reader said so", () => {
    const routing = resolveComposerRouting({
      target: { kind: "target", ref: "ref-a", cardKind: "artifact_review_gate", explicit: true },
      latestOpenGate: fieldGate("run-9"),
      actionsFor: actionsFor("ref-a"),
    });
    expect(routing).toMatchObject({ kind: "card-action", ref: "ref-a", cardKind: "artifact_review_gate" });
  });

  it("an IMPLICIT single review does NOT outrank an open field gate", () => {
    // The reader has not spoken, so the composer keeps the binding it has always
    // had: a run blocked on a field.
    const gate = fieldGate("run-9");
    expect(
      resolveComposerRouting({
        target: { kind: "target", ref: "ref-a", cardKind: "artifact_review_gate", explicit: false },
        latestOpenGate: gate,
        actionsFor: actionsFor("ref-a"),
      }),
    ).toEqual({ kind: "field-gate", gate });
  });

  it("a review_comment descriptor is NEVER fed to the field-gate ladder", () => {
    // It carries no fields and its submit is comment-only; classifying it would
    // read an approval word as a bare-gate submit.
    const routing = resolveComposerRouting({
      target: { kind: "none" },
      latestOpenGate: reviewGate("run-1", "ref-a"),
      actionsFor: actionsFor("ref-a"),
    });
    expect(routing).toEqual({ kind: "chat" });
  });

  it("a target whose card is GONE falls back rather than inventing a transport", () => {
    const gate = fieldGate("run-9");
    expect(
      resolveComposerRouting({
        target: { kind: "target", ref: "ref-a", cardKind: "artifact_review_gate", explicit: true },
        latestOpenGate: gate,
        actionsFor: noActions,
      }),
    ).toEqual({ kind: "field-gate", gate });
    expect(
      resolveComposerRouting({
        target: { kind: "target", ref: "ref-a", cardKind: "artifact_review_gate", explicit: true },
        latestOpenGate: undefined,
        actionsFor: noActions,
      }),
    ).toEqual({ kind: "chat" });
  });

  it("the actions carried out are the CARD's own, not rebuilt ones", async () => {
    const comment = vi.fn(async (text: string) => ({ ok: true, message: `said: ${text}` }));
    const decide = vi.fn<ComposerDecideAction>(async (decision) => ({
      ok: true,
      message: `did: ${decision}`,
    }));
    const routing = resolveComposerRouting({
      target: { kind: "target", ref: "ref-a", cardKind: "artifact_review_gate", explicit: true },
      latestOpenGate: undefined,
      actionsFor: (ref) => (ref === "ref-a" ? { comment, decide } : undefined),
    });
    if (routing.kind !== "card-action") throw new Error("expected a card action");
    expect(await routing.actions.comment("shorten the intro")).toEqual({
      ok: true,
      message: "said: shorten the intro",
    });
    expect(await routing.actions.decide("approve", null)).toEqual({
      ok: true,
      message: "did: approve",
    });
    expect(comment).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // KIND-GENERIC ROUTING (cinatra#2853, plan §2.1 acceptance 3)
  // -------------------------------------------------------------------------

  it("a NON-review lifecycle card is routed to exactly as a review is", () => {
    const routing = resolveComposerRouting({
      target: {
        kind: "target",
        ref: "sched-1",
        cardKind: "trigger_schedule_proposal",
        explicit: false,
      },
      latestOpenGate: undefined,
      actionsFor: actionsFor("sched-1"),
    });
    expect(routing).toMatchObject({
      kind: "card-action",
      ref: "sched-1",
      cardKind: "trigger_schedule_proposal",
    });
  });

  it("a MIXED ambiguous set routes NOWHERE, and the refusal says cards, not reviews", () => {
    const cards = [review("ref-a"), schedule("sched-1")];
    const routing = resolveComposerRouting({
      target: { kind: "ambiguous", count: 2, cards },
      latestOpenGate: undefined,
      actionsFor: actionsFor("ref-a", "sched-1"),
    });
    expect(routing).toEqual({ kind: "refuse-ambiguous", count: 2, cards });

    const line = ambiguousComposerRefusal(cards);
    // It cannot claim two REVIEWS are waiting when one of them is a schedule.
    expect(line).toContain("2 cards are waiting for you");
    expect(line).not.toContain("reviews");
    // The control it names is the shipped one, and it stays identifier-free.
    expect(line).toContain("Reply from the chat box");
    expect(line).not.toMatch(/ref-|run-|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("an ALL-REVIEW refusal is plan §2.1's sentence, word for word", () => {
    expect(ambiguousComposerRefusal([review("ref-a"), review("ref-b")])).toBe(
      "2 reviews are waiting for you, so this message was not sent anywhere. " +
        "Choose the review you want to reply to — press \u201CReply from the chat box\u201D on its " +
        "card — and send it again. To keep chatting normally, press that control twice " +
        "on any one of them.",
    );
  });
});
