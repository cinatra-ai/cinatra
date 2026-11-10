// @vitest-environment jsdom
/**
 * cinatra#3470: an agent DECLARES its HITL screen; the host draws it.
 *
 * A binding that carries `screen` is registered by the host from that
 * declaration: a "card" is drawn by the host's declared-screen card (title,
 * note, fact, words, quote and field sections, up to three decisions), and a
 * "kind" by the host's own component for the binding's kind. Pinned here:
 *
 *   - every word on the card comes from the declaration or the run value;
 *   - a decision or a field only STAGES its answer (carry keys + the exact
 *     declared answer); the card draws no send of its own, so the host's one
 *     Continue sends it (drawings: app-artifact-review I.4 and I.5,
 *     app-lifecycle-cards V.1);
 *   - only an http(s) run value is drawn as a link; a missing value draws no line;
 *   - the declaration is validated again at registration: an invalid screen,
 *     an unknown or inherited kind name, or a kind whose host entry is only
 *     the schema floor registers NOTHING, and the package component is never
 *     the fallback;
 *   - a binding without `screen` keeps its existing road.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/declared-hitl-screen-3470.test.tsx
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen as dom } from "@testing-library/react";

import {
  fieldRendererRegistry,
  type FieldRendererEntry,
  type FieldRendererProps,
} from "../field-renderer-registry";
import { registerFieldRendererBindings } from "../register-default-renderers";
import {
  __resetFieldRendererComponentMapForTests,
  __setFieldRendererComponentMapForTests,
} from "../field-renderer-components";
import { BlogIdeaSelectionRenderer } from "../blog-idea-selection-renderer";
import { SchemaOnlyFloorRenderer } from "../schema-field-renderer";

const ID = "@acme-test/publish-agent:confirm";

// Fixture declaration: the words are the fixture's own, standing for an
// agent's declared text.
const CARD = {
  layout: "card",
  title: "Send this fixture out?",
  sections: [
    { type: "fact", label: "Account", key: "accountName" },
    { type: "fact", label: "Destination", key: "destinationName", qualifierKey: "destinationType" },
    { type: "fact", label: "Source", key: "sourceUrl" },
    { type: "words", label: "The words that go out", key: "content" },
    { type: "quote", key: "excerpt" },
    { type: "note", text: "Fixture note: go back to change the words." },
  ],
  decisions: [
    { label: "Do not send", answer: { approved: false } },
    { label: "Send it", answer: { approved: true } },
  ],
  carry: ["itemId", "revisionId"],
  requires: ["itemId", "revisionId"],
};

const VALUE = {
  itemId: "item-1",
  revisionId: "rev-1",
  accountName: "Fixture Account",
  destinationName: "Fixture Org",
  destinationType: "organization",
  sourceUrl: "https://example.test/source",
  content: "Line one.\nLine two.",
  excerpt: "A fixture excerpt.",
  unrelated: "not carried",
};

function entryOf(id = ID): FieldRendererEntry | undefined {
  return fieldRendererRegistry.list().find((e) => e.id === id);
}

function mount(value: unknown, onChange = vi.fn()) {
  const entry = entryOf();
  expect(entry).toBeDefined();
  const Renderer = entry!.renderer;
  const props: FieldRendererProps = {
    fieldName: "field",
    schema: { "x-renderer": ID },
    value,
    onChange,
    context: { connectedApps: [] },
  } as FieldRendererProps;
  render(<Renderer {...props} />);
  return onChange;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fieldRendererRegistry.clear();
  __resetFieldRendererComponentMapForTests();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  fieldRendererRegistry.clear();
  __resetFieldRendererComponentMapForTests();
  vi.restoreAllMocks();
});

describe("a declared card is drawn by the host (cinatra#3470)", () => {
  beforeEach(() => {
    registerFieldRendererBindings([
      { id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: CARD },
    ]);
  });

  it("registers the card as a mid-run renderer that draws no send of its own", () => {
    const entry = entryOf();
    expect(entry).toBeDefined();
    expect(entry!.renderer).not.toBe(SchemaOnlyFloorRenderer);
    expect(entry!.drawsOwnSubmit).toBe(false);
    // Pure host rendering with no action: drawn on a credential-only host too.
    expect(entry!.credentialSafe).toBe(true);
    expect(entry!.midRunHitl).toBe(true);
  });

  it("is credential-safe in its own source: no server action, no registry lookup", () => {
    // The same two readings hitl-screen-credential-safety.test.ts makes of
    // every kind declared safe, made of the declared card's own module.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "declared-hitl-screen-renderer.tsx"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(source).toContain("export function makeDeclaredHitlScreenRenderer");
    expect(source).not.toMatch(/from\s+"\.\/[A-Za-z0-9-]*-actions"/);
    expect(source).not.toMatch(/"use server"/);
    expect(source).not.toMatch(/fieldRendererRegistry/);
  });

  it("draws the declared title, facts, words, quote and note from the run value", () => {
    mount(VALUE);
    expect(dom.getByText("Send this fixture out?")).toBeTruthy();
    expect(dom.getByText("Account:")).toBeTruthy();
    expect(dom.getByText("Fixture Account", { exact: false })).toBeTruthy();
    expect(dom.getByText("Destination (organization):")).toBeTruthy();
    expect(dom.getByText("The words that go out")).toBeTruthy();
    expect(dom.getByText(/Line one\.\s+Line two\./)).toBeTruthy();
    expect(dom.getByText("A fixture excerpt.")).toBeTruthy();
    expect(dom.getByText("Fixture note: go back to change the words.")).toBeTruthy();
    const link = dom.getByRole("link", { name: "https://example.test/source" });
    expect(link.getAttribute("href")).toBe("https://example.test/source");
    // The card draws the declared decisions and no Continue of its own.
    expect(dom.getByRole("button", { name: "Do not send" })).toBeTruthy();
    expect(dom.getByRole("button", { name: "Send it" })).toBeTruthy();
    expect(dom.queryByRole("button", { name: /continue/i })).toBeNull();
  });

  it("a decline stages the declared answer with the carried keys only, and sends nothing itself", () => {
    const onChange = mount(VALUE);
    fireEvent.click(dom.getByRole("button", { name: "Do not send" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ itemId: "item-1", revisionId: "rev-1", approved: false });
    expect(dom.getByRole("button", { name: "Do not send" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(dom.getByRole("button", { name: "Send it" }));
    expect(onChange).toHaveBeenLastCalledWith({ itemId: "item-1", revisionId: "rev-1", approved: true });
  });

  it("holds the decisions while a required run value is blank", () => {
    const onChange = mount({ ...VALUE, revisionId: "  " });
    const decline = dom.getByRole("button", { name: "Do not send" }) as HTMLButtonElement;
    expect(decline.disabled).toBe(true);
    fireEvent.click(decline);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("draws no line for a missing value, and never links a value that is not http(s)", () => {
    mount({ ...VALUE, accountName: undefined, sourceUrl: "javascript:alert(1)" });
    expect(dom.queryByText("Account:")).toBeNull();
    expect(dom.queryByRole("link")).toBeNull();
    expect(dom.getByText("javascript:alert(1)", { exact: false })).toBeTruthy();
  });

  it("carries own keys only, never an inherited one", () => {
    const value = Object.assign(Object.create({ revisionId: "inherited" }), {
      itemId: "item-1",
    }) as Record<string, unknown>;
    // The declaration omits `requires` (an `undefined` value is not plain JSON).
    const { requires: _requires, ...withoutRequires } = CARD;
    void _requires;
    registerFieldRendererBindings([
      { id: ID, kind: "linkedin-draft-review", priority: 90, screen: withoutRequires },
    ]);
    const onChange = mount(value);
    fireEvent.click(dom.getByRole("button", { name: "Send it" }));
    expect(onChange).toHaveBeenLastCalledWith({ itemId: "item-1", approved: true });
  });
});

describe("a declared text field (app-lifecycle-cards V.1)", () => {
  it("stages what the person types under the declared key, with the carried keys", () => {
    registerFieldRendererBindings([
      {
        id: ID,
        kind: "linkedin-draft-review",
        priority: 90,
        midRunHitl: true,
        screen: {
          layout: "card",
          title: "Fixture question",
          sections: [{ type: "field", key: "answer", label: "Fixture label", multiline: true, placeholder: "Fixture hint" }],
          carry: ["itemId"],
        },
      },
    ]);
    const onChange = mount({ itemId: "item-1" });
    const box = dom.getByLabelText("Fixture label");
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.getAttribute("placeholder")).toBe("Fixture hint");
    fireEvent.change(box, { target: { value: "typed" } });
    expect(onChange).toHaveBeenLastCalledWith({ itemId: "item-1", answer: "typed" });
    expect(dom.queryByRole("button")).toBeNull();
  });
});

describe("registration validates the declaration again (cinatra#3470)", () => {
  it("a 'kind' layout registers the host's own component for that kind", () => {
    registerFieldRendererBindings([
      { id: ID, kind: "blog-idea-selection", priority: 80, midRunHitl: true, screen: { layout: "kind" } },
    ]);
    expect(entryOf()?.renderer).toBe(BlogIdeaSelectionRenderer);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a 'kind' layout whose host entry is only the schema floor registers nothing", () => {
    registerFieldRendererBindings([
      { id: ID, kind: "linkedin-draft-review", priority: 90, screen: { layout: "kind" } },
    ]);
    expect(entryOf()).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(ID));
  });

  for (const [title, screen] of [
    ["an unknown layout", { layout: "page" }],
    ["an unknown section type", { ...CARD, sections: [{ type: "html", text: "x" }] }],
    ["a null screen", null],
    ["four decisions", { ...CARD, decisions: [...CARD.decisions, ...CARD.decisions] }],
  ] as const) {
    it(`${title} registers nothing and never falls back to the package component`, () => {
      const load = vi.fn(async () => ({ default: () => null }));
      __setFieldRendererComponentMapForTests({
        [ID]: { resolution: "guardedOptional", packageName: "@acme-test/publish-agent", propsApiVersion: 1, load },
      });
      registerFieldRendererBindings([
        { id: ID, kind: "linkedin-draft-review", priority: 90, screen: screen as never },
      ]);
      expect(entryOf()).toBeUndefined();
      expect(load).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`declared screen of ${ID} refused`));
    });
  }

  for (const kind of ["constructor", "toString", "__proto__"]) {
    for (const screen of [CARD, { layout: "kind" }]) {
      it(`an inherited kind name "${kind}" registers nothing (${screen.layout})`, () => {
        registerFieldRendererBindings([{ id: ID, kind, priority: 90, screen }]);
        expect(entryOf()).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`declared screen of ${ID} refused`));
      });
    }
  }

  it("a binding without a screen keeps its existing kind road", () => {
    registerFieldRendererBindings([{ id: ID, kind: "linkedin-draft-review", priority: 90 }]);
    expect(entryOf()?.renderer).toBe(SchemaOnlyFloorRenderer);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
