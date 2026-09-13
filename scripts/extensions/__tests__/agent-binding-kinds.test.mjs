// Shared agent-binding validator (cinatra#151 Stage 5) — fail-closed pins.
//
// The validator is the SINGLE gatekeeper for the `cinatra.fieldRenderers` /
// `cinatra.roles` manifest metadata on BOTH consumption paths (build-time
// generation -> byte-pinned exempt data; runtime collector -> skip-warn).
// These tests pin that nothing malformed can pass it.

import { describe, it, expect } from "vitest";
import {
  AGENT_HITL_RULE_ISSUE,
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

  it("accepts an optional migrated-component declaration and normalizes it (cinatra#1625 S8)", () => {
    const { entries, errors } = validateFieldRendererDeclarations(PKG, [
      { ...VALID, component: { entry: "./field-renderer", propsApiVersion: 2 } },
    ]);
    expect(errors).toEqual([]);
    expect(entries[0]).toMatchObject({
      component: { entry: "./field-renderer", propsApiVersion: 2 },
    });
  });

  it("accepts a component with no propsApiVersion (defaulted downstream by the generator)", () => {
    const { entries, errors } = validateFieldRendererDeclarations(PKG, [
      { ...VALID, component: { entry: "src/renderers/thing" } },
    ]);
    expect(errors).toEqual([]);
    expect(entries[0].component).toEqual({ entry: "src/renderers/thing" });
  });

  it("omits component from the normalized entry when not declared", () => {
    const { entries } = validateFieldRendererDeclarations(PKG, [VALID]);
    expect("component" in entries[0]).toBe(false);
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
    [{ ...VALID, component: "./field-renderer" }, /component must be a plain object/],
    [{ ...VALID, component: { entry: "/abs/path" } }, /component\.entry must be a package-relative subpath/],
    [{ ...VALID, component: { entry: "../escape" } }, /component\.entry must be a package-relative subpath/],
    [{ ...VALID, component: { entry: 42 } }, /component\.entry must be a package-relative subpath/],
    [{ ...VALID, component: { entry: "./ok", propsApiVersion: 0 } }, /component\.propsApiVersion must be a positive integer/],
    [{ ...VALID, component: { entry: "./ok", nope: 1 } }, /component has unknown key/],
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

  it("component divergence is a conflict too (fail-closed, cinatra#1625 S8)", () => {
    const a = { ...VALID, component: { entry: "./a" }, declaredBy: "a" };
    const b = { ...VALID, component: { entry: "./b" }, declaredBy: "b" };
    const { errors } = mergeFieldRendererBindings([a, b]);
    expect(errors).toHaveLength(1);
    // one declaring a component and the other not is ALSO a conflict
    const { errors: e2 } = mergeFieldRendererBindings([
      { ...VALID, component: { entry: "./a" }, declaredBy: "a" },
      { ...VALID, declaredBy: "b" },
    ]);
    expect(e2).toHaveLength(1);
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

// THE THREE-KIND RULE (cinatra#3470, epic cinatra#2926): "Connectors render the
// setup page themselves. Artifacts render the artifact view themselves. Agents
// do NOT render the HITL view themselves." The `component` channel
// (cinatra#1625, epic #1620 S8/M3) was opened for kind:"artifact" claimants; the
// validator accepted it from ANY kind, so a kind:"agent" package could start
// drawing its own pause screen with nothing to stop it. The declarations that
// exist today are grandfathered by the shrink-only ratchet baseline
// (scripts/extensions/agent-hitl-renders-nothing.baseline.json), which the
// CALLER reads and hands in — this validator stays fs-free because the runtime
// collector runs it too.
describe("validateFieldRendererDeclarations — the agent clause of THE THREE-KIND RULE", () => {
  const WITH_COMPONENT = {
    id: `${PKG}:review`,
    kind: "cta",
    priority: 90,
    component: { entry: "./src/renderers/review.tsx" },
  };

  it("refuses a component on a kind:agent binding that is NOT baselined", () => {
    const { entries, errors } = validateFieldRendererDeclarations(PKG, [WITH_COMPONENT], {
      kind: "agent",
    });
    expect(entries).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(AGENT_HITL_RULE_ISSUE);
    expect(errors[0]).toContain("Agents do NOT render the HITL view themselves");
    expect(errors[0]).toContain(`${PKG}:review`);
    expect(errors[0]).toContain("agent-hitl-renders-nothing.baseline.json");
  });

  it("accepts the SAME declaration once the binding id is baselined", () => {
    const { entries, errors } = validateFieldRendererDeclarations(PKG, [WITH_COMPONENT], {
      kind: "agent",
      baselinedComponentBindingIds: [`${PKG}:review`],
    });
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].component).toEqual({ entry: "./src/renderers/review.tsx" });
  });

  it("refuses a SECOND, un-baselined binding on an otherwise baselined agent package", () => {
    const { entries, errors } = validateFieldRendererDeclarations(
      PKG,
      [WITH_COMPONENT, { ...WITH_COMPONENT, id: `${PKG}:second` }],
      { kind: "agent", baselinedComponentBindingIds: [`${PKG}:review`] },
    );
    expect(entries).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${PKG}:second`);
  });

  it("accepts a component on kind:connector and kind:artifact (the rule is agent-only)", () => {
    for (const kind of ["connector", "artifact"]) {
      const { entries, errors } = validateFieldRendererDeclarations(PKG, [WITH_COMPONENT], { kind });
      expect(errors, kind).toEqual([]);
      expect(entries, kind).toHaveLength(1);
    }
  });

  it("leaves a kind:agent binding WITHOUT a component alone (the host renders it)", () => {
    const { entries, errors } = validateFieldRendererDeclarations(PKG, [VALID], { kind: "agent" });
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
  });

  it("with no options (the runtime collector's two-argument call) behaves exactly as before", () => {
    const { entries, errors } = validateFieldRendererDeclarations(PKG, [WITH_COMPONENT]);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
  });
});
