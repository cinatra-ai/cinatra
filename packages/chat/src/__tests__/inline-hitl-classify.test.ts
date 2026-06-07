import { describe, expect, it } from "vitest";
import {
  classifyPromptForGate,
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
