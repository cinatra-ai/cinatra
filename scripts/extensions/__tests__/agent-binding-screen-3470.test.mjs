// A declared HITL screen on an agent binding (cinatra#3470): the binding
// validator carries it (and refuses an invalid one by name), a duplicate id
// that disagrees on it is a conflict, and the generator writes it into the
// bindings file. The allow-list itself is pinned in
// agent-hitl-screen-schema-3470.test.mjs.

import { describe, it, expect } from "vitest";
import {
  validateFieldRendererDeclarations,
  mergeFieldRendererBindings,
} from "../agent-binding-kinds.mjs";
import { emitAgentBindings } from "../generate-extension-manifest.mjs";

const CARD = {
  layout: "card",
  title: "Fixture title",
  sections: [{ type: "words", key: "content" }],
  decisions: [
    { label: "Fixture no", answer: { approved: false } },
    { label: "Fixture yes", answer: { approved: true } },
  ],
  carry: ["itemId"],
};

const PKG = "@acme-test/fixture-agent";
const BINDING = { id: `${PKG}:confirm`, kind: "linkedin-draft-review", priority: 90, midRunHitl: true };

describe("the binding validator carries a declared screen", () => {
  it("accepts a valid screen and normalizes it onto the entry", () => {
    const { entries, errors } = validateFieldRendererDeclarations(PKG, [{ ...BINDING, screen: CARD }]);
    expect(errors).toEqual([]);
    expect(entries[0].screen).toEqual(CARD);
  });

  it("refuses an invalid screen by name and keeps no entry", () => {
    const { entries, errors } = validateFieldRendererDeclarations(PKG, [{ ...BINDING, screen: { layout: "page" } }]);
    expect(entries).toEqual([]);
    expect(errors.join("\n")).toMatch(/cinatra\.fieldRenderers\[0\]\.screen: unknown layout "page"/);
  });

  it("a duplicate id that disagrees on the screen is a conflict", () => {
    const a = validateFieldRendererDeclarations(PKG, [{ ...BINDING, screen: CARD }]).entries;
    const b = validateFieldRendererDeclarations("@acme-test/other", [BINDING]).entries;
    const { errors } = mergeFieldRendererBindings([...a, ...b]);
    expect(errors.join("\n")).toMatch(/conflicting fieldRenderers declarations/);
  });
});

describe("the generator emits the declared screen", () => {
  it("writes the screen into the bindings file and its type", () => {
    const { entries } = validateFieldRendererDeclarations(PKG, [{ ...BINDING, screen: { layout: "kind" } }]);
    const out = emitAgentBindings(entries, {});
    expect(out).toContain("  readonly screen?: Readonly<Record<string, unknown>>;\n");
    expect(out).toContain(`midRunHitl: true, screen: {"layout":"kind"}, declaredBy: "${PKG}" },`);
  });

  it("emits no screen key for a binding without one", () => {
    const { entries } = validateFieldRendererDeclarations(PKG, [BINDING]);
    // Not vacuous: the binding itself is emitted, only without a screen.
    expect(entries).toHaveLength(1);
    const out = emitAgentBindings(entries, {});
    expect(out).toContain(`declaredBy: "${PKG}"`);
    expect(out).not.toMatch(/screen: \{/);
  });
});
