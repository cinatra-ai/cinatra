/**
 * cinatra#3745 (criterion 5b): the person-decision road is a property of the
 * tool's REGISTRATION, not a tool name the host keeps. A handler is
 * person-decision evaluating only when its registration declared it; every
 * other value reads as not declared (fail-closed).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  declarePersonDecisionEvaluation,
  registrationEvaluatesPersonDecision,
} from "@/lib/extension-capabilities-registry";

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

// The route-graph ratchet (scripts/audit/route-graph-ratchet.mjs) counts every
// first-party module a tracked route reaches, and its ceilings only shrink. The
// agents primitive hub is on /api/a2a, /api/llm-bridge, /api/mcp and /chat, so
// the declaration lives in a module those routes already reach.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

describe("the person-decision declaration adds no route-reachable module (cinatra#3745)", () => {
  it("lives in the capabilities registry, and no standalone declaration module exists", () => {
    expect(existsSync(join(REPO_ROOT, "src/lib/authz/person-decision-declaration.ts"))).toBe(false);
    expect(read("src/lib/extension-capabilities-registry.ts")).toMatch(/export function declarePersonDecisionEvaluation\b/);
  });

  it("the hub and the passthrough read it from the registry", () => {
    const hub = read("packages/agents/src/mcp/handlers.ts");
    expect(hub).toContain('import { declarePersonDecisionEvaluation } from "@/lib/extension-capabilities-registry";');
    expect(hub).not.toContain("person-decision-declaration");
    expect(read("src/app/api/agents/passthrough/route.ts")).not.toContain("person-decision-declaration");
  });
});
