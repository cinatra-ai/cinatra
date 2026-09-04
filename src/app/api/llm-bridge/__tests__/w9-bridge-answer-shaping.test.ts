/**
 * cinatra#3033 (fix leg 2) — the bridge answer reaches the declared outputs.
 *
 * A bridge ApiNode that DECLARES outputs is sent an `output_schema` derived
 * from those declarations (`docker/wayflow/agent_loader.py`
 * `_derive_bridge_output_schemas`), and the host route's answer is what the
 * runtime maps back onto them. The route used to shape that answer with a bare
 * `JSON.parse`, so an answer that carried the declared object inside a fenced
 * block — or behind a one-line preface — parsed to nothing and was handed back
 * as `{ output: <the whole text> }`. Every declared output then resolved to its
 * EndNode default, the call still reported success, and the run died one frame
 * later at materialization with a message about the wrong thing:
 *
 *   titleFrom output "ideaBatchTitle" did not resolve to a non-empty string
 *
 * The repository already owns the provider-neutral extractor for exactly this
 * (`parseStructuredJson`), and this is the one caller that knows a SHAPE was
 * asked for. So the shaping is tolerant where a shape was declared, byte-for-
 * byte unchanged where none was, and it names the declared outputs the answer
 * does not carry so the failure can be reported at the call that went wrong.
 */
import { describe, it, expect } from "vitest";
import { shapeBridgeAnswer } from "../_llm-dispatch";

/** The idea generator's derived schema, as the runtime sends it. */
const IDEA_SCHEMA = {
  type: "object",
  properties: {
    ideas: { type: "array", title: "ideas" },
    ideaBatchTitle: { type: "string", title: "ideaBatchTitle" },
    ideaBatchDocument: { type: "string", title: "ideaBatchDocument" },
    notes: { type: "string", title: "notes" },
  },
  required: ["ideas", "ideaBatchTitle", "ideaBatchDocument", "notes"],
  additionalProperties: false,
} as const;

const ENVELOPE = {
  ideas: [{ title: "One" }],
  ideaBatchTitle: "Blog ideas: upgrade paths (1 idea)",
  ideaBatchDocument: "## One\n\nA summary.\n",
  notes: "One cluster.",
};

describe("shapeBridgeAnswer — a declared shape reaches the declared outputs", () => {
  it("carries a FENCED answer's declared outputs instead of dropping them into output", () => {
    const text = "```json\n" + JSON.stringify(ENVELOPE) + "\n```";
    const shaped = shapeBridgeAnswer({ text, outputSchema: IDEA_SCHEMA });
    expect(shaped.body).toMatchObject({
      ideaBatchTitle: "Blog ideas: upgrade paths (1 idea)",
      ideaBatchDocument: "## One\n\nA summary.\n",
    });
    expect(shaped.missingDeclaredOutputs).toEqual([]);
  });

  it("carries a PREFACED answer's declared outputs", () => {
    const text = "Here is the batch:\n\n" + JSON.stringify(ENVELOPE);
    const shaped = shapeBridgeAnswer({ text, outputSchema: IDEA_SCHEMA });
    expect(shaped.body).toMatchObject({ ideaBatchTitle: ENVELOPE.ideaBatchTitle });
    expect(shaped.missingDeclaredOutputs).toEqual([]);
  });

  it("leaves a clean answer exactly as it is, and spreads skillSelection beside it", () => {
    const shaped = shapeBridgeAnswer({
      text: JSON.stringify(ENVELOPE),
      outputSchema: IDEA_SCHEMA,
      skillSelection: { droppedSkillIds: [], selectionReason: "none" },
    });
    expect(shaped.body).toMatchObject({
      ideaBatchTitle: ENVELOPE.ideaBatchTitle,
      skillSelection: { selectionReason: "none" },
    });
  });

  it("names the declared outputs an unshapeable answer does not carry", () => {
    const shaped = shapeBridgeAnswer({
      text: "I could not produce the batch.",
      outputSchema: IDEA_SCHEMA,
    });
    expect(shaped.body).toEqual({ output: "I could not produce the batch." });
    expect(shaped.missingDeclaredOutputs).toEqual([
      "ideas",
      "ideaBatchTitle",
      "ideaBatchDocument",
      "notes",
    ]);
  });

  it("counts an EMPTY declared string as missing — the exact refusal the run reported", () => {
    const shaped = shapeBridgeAnswer({
      text: JSON.stringify({ ...ENVELOPE, ideaBatchTitle: "   " }),
      outputSchema: IDEA_SCHEMA,
    });
    expect(shaped.missingDeclaredOutputs).toEqual(["ideaBatchTitle"]);
  });
});

describe("shapeBridgeAnswer — no declared shape, no behaviour change", () => {
  it("keeps a fenced answer as output when the caller declared no schema", () => {
    const text = "```json\n" + JSON.stringify(ENVELOPE) + "\n```";
    const shaped = shapeBridgeAnswer({ text });
    expect(shaped.body).toEqual({ output: text });
    expect(shaped.missingDeclaredOutputs).toEqual([]);
  });

  it("keeps a clean object answer, and a non-object answer, exactly as before", () => {
    expect(shapeBridgeAnswer({ text: '{"a":1}' }).body).toEqual({ a: 1 });
    expect(shapeBridgeAnswer({ text: "42" }).body).toEqual(42);
    expect(
      shapeBridgeAnswer({ text: "42", skillSelection: { droppedSkillIds: [] } }).body,
    ).toEqual({ output: 42, skillSelection: { droppedSkillIds: [] } });
  });

  it("treats a schema with no properties map as no declaration", () => {
    const text = "```json\n{\"a\":1}\n```";
    expect(shapeBridgeAnswer({ text, outputSchema: { type: "object" } }).body).toEqual({
      output: text,
    });
  });
});

describe("shapeBridgeAnswer — a declared shape never RE-shapes what parsed cleanly", () => {
  it("keeps a literal null exactly as the strict parse made it", () => {
    const shaped = shapeBridgeAnswer({ text: "null", outputSchema: IDEA_SCHEMA });
    expect(shaped.body).toBeNull();
    expect(shaped.missingDeclaredOutputs).toEqual([
      "ideas",
      "ideaBatchTitle",
      "ideaBatchDocument",
      "notes",
    ]);
  });

  it("keeps a clean scalar answer as the scalar it parsed to", () => {
    expect(shapeBridgeAnswer({ text: "42", outputSchema: IDEA_SCHEMA }).body).toEqual(42);
  });

  it("leaves a FENCED array as output, exactly as it was before the tolerance", () => {
    const text = "```json\n[1, 2]\n```";
    const shaped = shapeBridgeAnswer({ text, outputSchema: IDEA_SCHEMA });
    expect(shaped.body).toEqual({ output: text });
  });

  it("does not invent an object out of prose that merely contains braces", () => {
    const text = 'I could not produce it. Config was {"unrelated": 1} at the time.';
    const shaped = shapeBridgeAnswer({ text, outputSchema: IDEA_SCHEMA });
    expect(shaped.body).toEqual({ output: text });
    expect(shaped.missingDeclaredOutputs).toEqual([
      "ideas",
      "ideaBatchTitle",
      "ideaBatchDocument",
      "notes",
    ]);
  });

  it("still recovers a fenced object that carries a declared key", () => {
    const text = "Here you go:\n```json\n" + JSON.stringify(ENVELOPE) + "\n```";
    expect(shapeBridgeAnswer({ text, outputSchema: IDEA_SCHEMA }).body).toMatchObject({
      ideaBatchTitle: ENVELOPE.ideaBatchTitle,
    });
  });
});
