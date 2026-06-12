// Shared agent-binding validator (cinatra#151 Stage 5) — fail-closed pins.
//
// The validator is the SINGLE gatekeeper for the `cinatra.fieldRenderers` /
// `cinatra.roles` manifest metadata on BOTH consumption paths (build-time
// generation -> byte-pinned exempt data; runtime collector -> skip-warn).
// These tests pin that nothing malformed can pass it.

import { describe, it, expect } from "vitest";
import {
  KNOWN_FIELD_RENDERER_KINDS,
  KNOWN_A2UI_TRANSLATOR_KINDS,
  BINDING_ID_RE,
  MAX_PARAMS_JSON_BYTES,
  validateFieldRendererDeclarations,
  mergeFieldRendererBindings,
  mergeRoleDeclarations,
} from "../agent-binding-kinds.mjs";

const PKG = "@cinatra-ai/some-agent";
const VALID = { id: `${PKG}:thing`, kind: "cta", priority: 90 };

describe("validateFieldRendererDeclarations", () => {
  it("accepts a minimal valid entry and normalizes it", () => {
    const { entries, errors } = validateFieldRendererDeclarations(PKG, [VALID]);
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      { id: `${PKG}:thing`, kind: "cta", priority: 90, declaredBy: PKG },
    ]);
  });

  it("accepts optional midRunHitl / a2uiTranslator / params", () => {
    const { entries, errors } = validateFieldRendererDeclarations(PKG, [
      {
        ...VALID,
        midRunHitl: true,
        a2uiTranslator: "send-output",
        params: { target: "@cinatra-ai/other-agent" },
      },
    ]);
    expect(errors).toEqual([]);
    expect(entries[0]).toMatchObject({
      midRunHitl: true,
      a2uiTranslator: "send-output",
      params: { target: "@cinatra-ai/other-agent" },
    });
  });

  it("rejects non-array declarations", () => {
    const { entries, errors } = validateFieldRendererDeclarations(PKG, {});
    expect(entries).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it.each([
    [{ ...VALID, id: "not-a-namespaced-id" }, /id must match/],
    [{ ...VALID, id: "@scope/pkg" }, /id must match/],
    [{ ...VALID, kind: "no-such-kind" }, /unknown kind/],
    [{ ...VALID, kind: undefined }, /unknown kind/],
    [{ ...VALID, priority: 0 }, /priority must be an integer/],
    [{ ...VALID, priority: 101 }, /priority must be an integer/],
    [{ ...VALID, priority: 9.5 }, /priority must be an integer/],
    [{ ...VALID, priority: undefined }, /priority must be an integer/],
    [{ ...VALID, midRunHitl: "yes" }, /midRunHitl must be a boolean/],
    [{ ...VALID, a2uiTranslator: "bogus-translator" }, /unknown a2uiTranslator/],
    [{ ...VALID, params: [1, 2] }, /params must be a plain object/],
    [{ ...VALID, params: { big: "x".repeat(MAX_PARAMS_JSON_BYTES + 1) } }, /params must serialize/],
    [{ ...VALID, somethingElse: 1 }, /unknown key/],
    ["not-an-object", /entry must be an object/],
  ])("rejects invalid entry %#", (entry, message) => {
    const { entries, errors } = validateFieldRendererDeclarations(PKG, [entry]);
    expect(entries).toEqual([]);
    expect(errors.join("\n")).toMatch(message);
  });

  it("validates entries independently (one bad entry does not drop the good one)", () => {
    const { entries, errors } = validateFieldRendererDeclarations(PKG, [
      VALID,
      { ...VALID, kind: "nope" },
    ]);
    expect(entries).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("the kind vocabulary is sorted and non-empty (deterministic emission)", () => {
    expect(KNOWN_FIELD_RENDERER_KINDS.length).toBeGreaterThan(0);
    expect([...KNOWN_FIELD_RENDERER_KINDS]).toEqual([...KNOWN_FIELD_RENDERER_KINDS].sort());
    expect(KNOWN_A2UI_TRANSLATOR_KINDS.length).toBeGreaterThan(0);
  });

  it("BINDING_ID_RE accepts canonical ids and rejects path-ish strings", () => {
    expect(BINDING_ID_RE.test("@cinatra-ai/email-outreach-agent:cta")).toBe(true);
    expect(BINDING_ID_RE.test("extensions/cinatra-ai/x")).toBe(false);
    expect(BINDING_ID_RE.test("@scope/pkg:sub:extra")).toBe(false);
  });
});

describe("mergeFieldRendererBindings (cross-declaration rules)", () => {
  const entryA = { ...VALID, declaredBy: "@cinatra-ai/a-agent" };

  it("dedupes DEEP-EQUAL duplicate ids, keeping the first declarer", () => {
    const dup = { ...VALID, declaredBy: "@cinatra-ai/b-agent" };
    const { merged, errors } = mergeFieldRendererBindings([entryA, dup]);
    expect(errors).toEqual([]);
    expect(merged).toHaveLength(1);
    expect(merged[0].declaredBy).toBe("@cinatra-ai/a-agent");
  });

  it("FAILS on divergent duplicate ids, naming both declarers", () => {
    const conflicting = { ...VALID, priority: 50, declaredBy: "@cinatra-ai/b-agent" };
    const { errors } = mergeFieldRendererBindings([entryA, conflicting]);
    expect(errors.join("\n")).toMatch(/conflicting fieldRenderers declarations/);
    expect(errors.join("\n")).toMatch(/@cinatra-ai\/a-agent/);
    expect(errors.join("\n")).toMatch(/@cinatra-ai\/b-agent/);
  });

  it("params divergence is a conflict too", () => {
    const a = { ...VALID, params: { t: "x" }, declaredBy: "a" };
    const b = { ...VALID, params: { t: "y" }, declaredBy: "b" };
    const { errors } = mergeFieldRendererBindings([a, b]);
    expect(errors).toHaveLength(1);
  });

  it("sorts the merged output by id (deterministic emission)", () => {
    const z = { ...VALID, id: "@cinatra-ai/z-agent:thing", declaredBy: "z" };
    const a = { ...VALID, id: "@cinatra-ai/a-agent:thing", declaredBy: "a" };
    const { merged } = mergeFieldRendererBindings([z, a]);
    expect(merged.map((e) => e.id)).toEqual([
      "@cinatra-ai/a-agent:thing",
      "@cinatra-ai/z-agent:thing",
    ]);
  });
});

describe("mergeRoleDeclarations", () => {
  it("merges unique role claims into a sorted map", () => {
    const { roles, errors } = mergeRoleDeclarations([
      { packageName: "@cinatra-ai/planner-agent", roles: ["agent-planner"] },
      { packageName: "@cinatra-ai/author-agent", roles: ["agent-author"] },
    ]);
    expect(errors).toEqual([]);
    expect(Object.keys(roles)).toEqual(["agent-author", "agent-planner"]);
    expect(roles["agent-planner"]).toBe("@cinatra-ai/planner-agent");
  });

  it("FAILS when two packages claim the same role (global uniqueness)", () => {
    const { errors } = mergeRoleDeclarations([
      { packageName: "@cinatra-ai/a-agent", roles: ["agent-author"] },
      { packageName: "@cinatra-ai/b-agent", roles: ["agent-author"] },
    ]);
    expect(errors.join("\n")).toMatch(/claimed by BOTH/);
  });

  it("tolerates the same package claiming a role twice (idempotent)", () => {
    const { roles, errors } = mergeRoleDeclarations([
      { packageName: "@cinatra-ai/a-agent", roles: ["agent-author", "agent-author"] },
    ]);
    expect(errors).toEqual([]);
    expect(roles["agent-author"]).toBe("@cinatra-ai/a-agent");
  });

  it("rejects malformed role names and non-array declarations", () => {
    const { errors } = mergeRoleDeclarations([
      { packageName: "p1", roles: "agent-author" },
      { packageName: "p2", roles: ["Bad Role!"] },
    ]);
    expect(errors).toHaveLength(2);
  });
});
