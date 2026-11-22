// cinatra#4150 W4 C1b: the PUBLISH-DECISION ISLAND ref, the fourth ref family.
//
// It addresses one artifacts row of one publish decision and grants nothing. What is pinned here is the family's
// separation: a publish ref never decodes as a gate ref (so the gate loader can never be handed it) and a gate ref, a
// schedule ref and a schedule-form ref never decode as a publish ref. Red first: at C1's head none of these exports
// exist, so this file fails at its import.
// red-first-expect: encodePublishDecisionIslandRef
import { describe, expect, it } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

import {
  decodeLifecycleGateRef,
  decodePublishDecisionIslandRef,
  decodeScheduleFormRef,
  decodeScheduleRunRef,
  encodeLifecycleGateRef,
  encodePublishDecisionIslandRef,
  encodeScheduleFormRef,
  encodeScheduleRunRef,
  publishDecisionIslandSubjectKey,
} from "../lifecycle-card-ref";

const ROW = { runId: "run-1", decisionId: "dec-1", input: "reviewTargets" };

describe("the publish-decision island ref", () => {
  it("round-trips the run, the decision and the input, and is opaque", () => {
    const ref = encodePublishDecisionIslandRef(ROW)!;
    expect(ref).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodePublishDecisionIslandRef(ref)).toEqual(ROW);
    for (const value of Object.values(ROW)) expect(ref).not.toContain(value);
  });

  it("is not a gate ref, and no other family is a publish ref", () => {
    const publish = encodePublishDecisionIslandRef(ROW)!;
    expect(decodeLifecycleGateRef(publish)).toBeNull();
    expect(decodeScheduleRunRef(publish)).toBeNull();
    expect(decodeScheduleFormRef(publish)).toBeNull();
    for (const other of [
      encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "dec-1" })!,
      encodeScheduleRunRef({ runId: "run-1" })!,
      encodeScheduleFormRef({ runId: "run-1" })!,
    ]) {
      expect(decodePublishDecisionIslandRef(other)).toBeNull();
    }
  });

  it("refuses to encode an empty or over-long field, and decodes nothing tampered or malformed", () => {
    expect(encodePublishDecisionIslandRef({ ...ROW, runId: "" })).toBeNull();
    expect(encodePublishDecisionIslandRef({ ...ROW, decisionId: "d".repeat(129) })).toBeNull();
    expect(encodePublishDecisionIslandRef({ ...ROW, input: "" })).toBeNull();
    const ref = encodePublishDecisionIslandRef(ROW)!;
    const flipped = `${ref.slice(0, 20)}${ref[20] === "A" ? "B" : "A"}${ref.slice(21)}`;
    expect(decodePublishDecisionIslandRef(flipped)).toBeNull();
    expect(decodePublishDecisionIslandRef("not a ref!")).toBeNull();
    expect(decodePublishDecisionIslandRef("")).toBeNull();
  });

  it("the subject key is fixed-length, binds both fields, and cannot be shifted between them", () => {
    const key = publishDecisionIslandSubjectKey(ROW);
    expect(key).toMatch(/^publish-decision:[0-9a-f]{64}$/);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(publishDecisionIslandSubjectKey({ decisionId: "dec-1", input: "other" })).not.toBe(key);
    expect(publishDecisionIslandSubjectKey({ decisionId: "dec-2", input: "reviewTargets" })).not.toBe(key);
    expect(publishDecisionIslandSubjectKey({ decisionId: "ab", input: "c" })).not.toBe(
      publishDecisionIslandSubjectKey({ decisionId: "a", input: "bc" }),
    );
  });

  // pre-1 MUST-FIX 2: the key is injective over every string the ref admits. Two lone surrogates encode to the same
  // UTF-8 replacement bytes, and a NUL inside a field could shift a NUL-joined pair; neither may collide.
  it("distinct lone-surrogate inputs and NUL-shifted fields get distinct subject keys", () => {
    const key = (decisionId: string, input: string) => publishDecisionIslandSubjectKey({ decisionId, input });
    expect(key("dec-1", "\uD800")).not.toBe(key("dec-1", "\uD801"));
    expect(key("dec-\uDC00", "x")).not.toBe(key("dec-\uDC01", "x"));
    expect(key("a\u0000b", "c")).not.toBe(key("a", "b\u0000c"));
    expect(key("dec-1", "\uD800")).toMatch(/^publish-decision:[0-9a-f]{64}$/);
    // The ref itself keeps a lone surrogate exactly, so ref and key name the same input.
    expect(decodePublishDecisionIslandRef(encodePublishDecisionIslandRef({ ...ROW, input: "\uD800" })!)?.input).toBe("\uD800");
  });
});
