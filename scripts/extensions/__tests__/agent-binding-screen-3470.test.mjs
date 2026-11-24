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
  decisionLabel: "Fixture decision",
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

  it("refuses a screen on a binding that is not mid-run: a setup gate takes no declared screen", () => {
    const { midRunHitl: _m, ...setupBinding } = BINDING;
    void _m;
    for (const binding of [setupBinding, { ...setupBinding, midRunHitl: false }]) {
      for (const screen of [CARD, { layout: "kind" }]) {
        const { entries, errors } = validateFieldRendererDeclarations(PKG, [{ ...binding, screen }]);
        expect(entries).toEqual([]);
        expect(errors.join("\n")).toMatch(
          /cinatra\.fieldRenderers\[0\]\.screen: a declared screen is drawn only at a mid-run gate: the binding must declare midRunHitl: true/,
        );
      }
    }
  });

  it("refuses a 'kind' screen on cta: its bare-text answer cannot be sent at a mid-run step", () => {
    const { entries, errors } = validateFieldRendererDeclarations(PKG, [
      { ...BINDING, kind: "cta", screen: { layout: "kind" } },
    ]);
    expect(entries).toEqual([]);
    expect(errors.join("\n")).toMatch(
      /cinatra\.fieldRenderers\[0\]\.screen: a "kind" screen cannot use kind "cta".*declare the step as a card with a field section/,
    );
  });

  it("refuses a 'kind' screen on a kind the host draws no component for: linkedin-draft-review", () => {
    const { entries, errors, refusedScreenIds } = validateFieldRendererDeclarations(PKG, [
      { ...BINDING, kind: "linkedin-draft-review", screen: { layout: "kind" } },
    ]);
    // red-first-expect: to deeply equal []
    expect(entries).toEqual([]);
    expect(errors.join("\n")).toMatch(
      /cinatra\.fieldRenderers\[0\]\.screen: a "kind" screen cannot use kind "linkedin-draft-review": the host draws no component of its own for it/,
    );
    expect(refusedScreenIds).toEqual([`${PKG}:confirm`]);
  });

  it("names every refused entry that declared a screen, and no other", () => {
    const { entries, refusedScreenIds } = validateFieldRendererDeclarations(PKG, [
      { ...BINDING, id: `${PKG}:no-title`, screen: { layout: "card" } },
      { ...BINDING, id: `${PKG}:bad-kind`, kind: "no-such-kind", screen: CARD },
      { ...BINDING, id: `${PKG}:bad-flag`, screen: { ...CARD, decisions: [{ label: "x", answer: { approved: "false" } }] } },
      { ...BINDING, id: `${PKG}:no-screen`, kind: "no-such-kind" },
      { ...BINDING, id: `${PKG}:fine`, screen: CARD },
    ]);
    expect(entries.map((e) => e.id)).toEqual([`${PKG}:fine`]);
    expect(refusedScreenIds).toEqual([`${PKG}:no-title`, `${PKG}:bad-kind`, `${PKG}:bad-flag`]);
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
    const { entries } = validateFieldRendererDeclarations(PKG, [
      { ...BINDING, kind: "context-selector", screen: { layout: "kind" } },
    ]);
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
