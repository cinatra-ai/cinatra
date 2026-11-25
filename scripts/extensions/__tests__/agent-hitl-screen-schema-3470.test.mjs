// The declared HITL screen allow-list (cinatra#3470): the card of notes,
// facts, words, quotes and text fields passes; everything else is refused by
// name at generation, and the generated map carries what was checked.

import { describe, it, expect } from "vitest";
import { validateHitlScreen, RESERVED_ANSWER_KEYS } from "../agent-hitl-screen-schema.mjs";
import { validateFieldRendererDeclarations, comparableFieldRendererBinding } from "../agent-binding-kinds.mjs";
import { emitAgentBindings } from "../generate-extension-manifest.mjs";

const CARD = {
  layout: "card",
  sections: [
    { type: "note", text: "Check the brief before it is written." },
    { type: "fact", label: "Topic", key: "topic", qualifierKey: "topicSource" },
    { type: "words", key: "keywords", label: "Keywords" },
    { type: "quote", key: "excerpt" },
    { type: "field", key: "angle", label: "Angle", multiline: true, placeholder: "One sentence" },
  ],
  carry: ["topic"],
};

const PKG = "@cinatra-ai/some-agent";
const binding = (extra) => ({ id: `${PKG}:brief`, kind: "cta", priority: 90, midRunHitl: true, ...extra });

describe("validateHitlScreen", () => {
  it("accepts the card and returns a plain JSON copy", () => {
    const { screen, errors } = validateHitlScreen(CARD);
    expect(errors).toEqual([]);
    expect(screen).toEqual(CARD);
    expect(screen).not.toBe(CARD);
  });

  it("refuses the kind layout and decisions as not drawn yet", () => {
    expect(validateHitlScreen({ layout: "kind", kind: "cta" }).errors[0]).toMatch(/layout "kind" is not drawn yet/);
    expect(validateHitlScreen({ ...CARD, decisions: [] }).errors[0]).toMatch(/decisions: a decision is not drawn yet/);
    expect(validateHitlScreen({ ...CARD, decisionLabel: "Pick" }).errors[0]).toMatch(/a decision is not drawn yet/);
    const withDecision = { ...CARD, sections: [...CARD.sections, { type: "decision", key: "d" }] };
    expect(validateHitlScreen(withDecision).errors[0]).toMatch(/sections\[5\]: a decision is not drawn yet/);
  });

  it("refuses unknown layouts, keys, section types and section props by name", () => {
    expect(validateHitlScreen({ layout: "table", sections: [] }).errors[0]).toMatch(/unknown layout "table"/);
    expect(validateHitlScreen({ ...CARD, title: "T" }).errors[0]).toMatch(/unknown key "title"/);
    const rows = { ...CARD, sections: [...CARD.sections, { type: "rows", key: "r" }] };
    expect(validateHitlScreen(rows).errors[0]).toMatch(/unknown section type "rows"/);
    const extraProp = { layout: "card", sections: [{ type: "field", key: "a", label: "A", html: "<b>" }] };
    expect(validateHitlScreen(extraProp).errors[0]).toMatch(/unknown key "html"/);
  });

  it("needs a field, refuses reserved and duplicated field keys, and a carried key that is a field", () => {
    expect(validateHitlScreen({ layout: "card", sections: [{ type: "note", text: "n" }] }).errors[0]).toMatch(
      /at least one field section/,
    );
    for (const k of RESERVED_ANSWER_KEYS) {
      const s = { layout: "card", sections: [{ type: "field", key: k, label: "X" }] };
      expect(validateHitlScreen(s).errors.join()).toMatch(/is written by the host/);
    }
    const twice = { layout: "card", sections: [{ type: "field", key: "a", label: "A" }, { type: "field", key: "a", label: "B" }] };
    expect(validateHitlScreen(twice).errors[0]).toMatch(/declared twice/);
    expect(validateHitlScreen({ ...CARD, carry: ["angle"] }).errors[0]).toMatch(/also a field key/);
    expect(validateHitlScreen({ ...CARD, carry: ["approved"] }).errors[0]).toMatch(/written by the host/);
  });

  it("refuses a screen past its size cap or not plain JSON", () => {
    const big = { layout: "card", sections: [{ type: "field", key: "a", label: "A", placeholder: "x".repeat(9000) }] };
    expect(validateHitlScreen(big).errors[0]).toMatch(/<= 8192 bytes/);
    const cyclic = { layout: "card" };
    cyclic.self = cyclic;
    expect(validateHitlScreen(cyclic).errors[0]).toMatch(/plain JSON/);
  });
});

describe("a binding's screen at generation", () => {
  it("is carried in the entry and in the emitted generated map", () => {
    const { entries, errors } = validateFieldRendererDeclarations(PKG, [binding({ screen: CARD })]);
    expect(errors).toEqual([]);
    expect(entries[0].screen).toEqual(CARD);
    expect(comparableFieldRendererBinding(entries[0])).toContain('"layout":"card"');
    const emitted = emitAgentBindings(entries, []);
    expect(emitted).toContain(`screen: ${JSON.stringify(CARD)}`);
    expect(emitted).toContain("readonly screen?: Readonly<Record<string, unknown>>;");
  });

  it("is refused, and the entry skipped, when invalid, not mid-run, or beside a component", () => {
    const bad = validateFieldRendererDeclarations(PKG, [binding({ screen: { layout: "kind" } })]);
    expect(bad.entries).toEqual([]);
    expect(bad.errors.join()).toMatch(/layout "kind" is not drawn yet/);
    const notMidRun = validateFieldRendererDeclarations(PKG, [binding({ midRunHitl: undefined, screen: CARD })]);
    expect(notMidRun.entries).toEqual([]);
    expect(notMidRun.errors.join()).toMatch(/only at a mid-run step/);
    const withComponent = validateFieldRendererDeclarations(PKG, [binding({ screen: CARD, component: { entry: "src/c" } })]);
    expect(withComponent.entries).toEqual([]);
    expect(withComponent.errors.join()).toMatch(/declares no component/);
  });

  it.each([":list-picker", ":setup-form", ":scrape-schema-review", ":final-list-review", ":context-selector"])(
    "is refused on a binding id ending in %s, a step the host answers by its own rule",
    (suffix) => {
      const out = validateFieldRendererDeclarations(PKG, [binding({ id: `${PKG}${suffix}`, screen: CARD })]);
      expect(out.entries).toEqual([]);
      expect(out.errors.join()).toMatch(new RegExp(`ending in "${suffix}" names a step the host answers by its own rule`));
    },
  );
});
