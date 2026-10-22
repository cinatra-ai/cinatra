/**
 * cinatra#3745 (criterion 5b): the person-decision road is a property of the
 * tool's REGISTRATION, not a tool name the host keeps. A handler is
 * person-decision evaluating only when its registration declared it; every
 * other value reads as not declared (fail-closed).
 */
import { describe, expect, it } from "vitest";
import {
  declarePersonDecisionEvaluation,
  registrationEvaluatesPersonDecision,
} from "@/lib/authz/person-decision-declaration";

describe("a registration's person-decision declaration (cinatra#3745, 5b)", () => {
  it("reads a declared handler as declared, and returns the same handler", () => {
    const handler = async () => ({ ok: true });
    const declared = declarePersonDecisionEvaluation(handler);
    expect(declared).toBe(handler);
    expect(registrationEvaluatesPersonDecision(declared)).toBe(true);
  });

  it("reads an undeclared handler as not declared", () => {
    expect(registrationEvaluatesPersonDecision(async () => ({ ok: true }))).toBe(false);
  });

  it("does not carry the declaration to a wrapper or a copy of the handler", () => {
    const handler = declarePersonDecisionEvaluation(async (x: unknown) => x);
    const wrapper = (x: unknown) => handler(x);
    expect(registrationEvaluatesPersonDecision(wrapper)).toBe(false);
    expect(registrationEvaluatesPersonDecision(handler.bind(null))).toBe(false);
  });

  it("reads every value that is not a declared function as not declared", () => {
    for (const value of [undefined, null, true, "email_test_delivery_run_send", 1, {}, { evaluatesPersonDecision: true }]) {
      expect(registrationEvaluatesPersonDecision(value)).toBe(false);
    }
  });
});
